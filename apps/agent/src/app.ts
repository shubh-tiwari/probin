import type { PanelSpec } from '@app/specs';
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import {
  InvalidEventError,
  advance,
  newRequest,
  rememberableAnswers,
  seedRefinement,
  type LoopDependencies,
} from './loop.js';
import type { RequestStore, Surface } from './requests.js';
import type { AgentEvent, AgentOutput, AgentState } from './types.js';

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a caller gets back: what to show, and the request's record. */
export interface AgentReply {
  requestId: string;
  output: AgentOutput;
  /** Answers this request asked for that the person may save as defaults. Empty: nothing to offer. */
  rememberable: AgentState['userDefaults'];
  surface: Surface;
  trace: Pick<
    AgentState,
    | 'status'
    | 'text'
    | 'parsed'
    | 'decisions'
    | 'defaulted'
    | 'fromUserDefaults'
    | 'questionsAsked'
    | 'attempts'
    | 'allowed'
    | 'cost'
  >;
}

const reply = (state: AgentState, output: AgentOutput, surface: Surface): AgentReply => ({
  requestId: state.requestId,
  output,
  rememberable:
    state.status === 'draft' || state.status === 'saved' ? rememberableAnswers(state) : {},
  surface,
  trace: {
    status: state.status,
    text: state.text,
    ...(state.parsed ? { parsed: state.parsed } : {}),
    decisions: state.decisions,
    defaulted: state.defaulted,
    fromUserDefaults: state.fromUserDefaults,
    questionsAsked: state.questionsAsked,
    attempts: state.attempts,
    allowed: state.allowed,
    cost: state.cost,
  },
});

/** The output a stored request would show now, without moving it on. */
function currentOutput(state: AgentState): AgentOutput {
  switch (state.status) {
    case 'question':
      return {
        kind: 'question',
        question: state.question!,
        questionsLeft: 2 - state.questionsAsked.length,
      };
    case 'draft':
      return { kind: 'draft', panel: state.draft!, attempts: state.attempts };
    case 'saved':
      return { kind: 'saved', ...state.saved! };
    case 'no_match':
      return { kind: 'no_match', message: state.message ?? '' };
    case 'alert':
      return { kind: 'alert', ruleId: state.alertDraft!.ruleId, rule: state.alertDraft!.spec };
    case 'collector':
      return { kind: 'collector', ...state.collectorDraft! };
    default:
      return { kind: 'failed', message: state.message ?? 'Not started.', attempts: state.attempts };
  }
}

export interface AgentAppDependencies {
  internalToken: string;
  /** The loop's dependencies for one workspace. */
  forWorkspace(workspaceId: string): LoopDependencies;
  requests: RequestStore;
  /** The person's saved answers. */
  readUserDefaults(workspaceId: string, userId: string): Promise<AgentState['userDefaults']>;
  saveUserDefaults(
    workspaceId: string,
    userId: string,
    answers: AgentState['userDefaults'],
    source: string,
  ): Promise<number>;
  /** Where alerts go when the request did not come from a Slack channel. */
  defaultAlertChannel?(workspaceId: string): Promise<string>;
  /** "Why did this happen?" for an alert rule. */
  explainAlert?(workspaceId: string, ruleId: string): Promise<unknown>;
  /** Whether the workspace may build (trial not over, or subscribed). Viewing never asks this. */
  canBuild?(workspaceId: string): Promise<{ ok: boolean; reason?: string }>;
  /** A saved panel, for changing it by prompt. */
  loadPanel?(
    workspaceId: string,
    panelId: string,
  ): Promise<{ spec: PanelSpec; dashboardId?: string } | undefined>;
}

/** A Slack channel id as an alert channel: `#C0123ABC`. */
const slackChannel = (surface: Surface) => {
  const channel = (surface as { slack?: { channel?: string } }).slack?.channel;
  return channel ? `#${channel}` : undefined;
};

type Variables = { workspaceId: string; userId: string };

/**
 * The agent service. Slack, the web tool and Review all reach the one agent
 * through this API. Callers are our own services: they prove it with the
 * internal token and say which workspace and person they act for.
 */
export function createAgentApp(deps: AgentAppDependencies) {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/v1/*', async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(deps.internalToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: 'Not an internal caller.' }, 401);
    }
    const workspaceId = c.req.header('x-workspace-id') ?? '';
    if (!WORKSPACE_ID.test(workspaceId)) return c.json({ error: 'A workspace is required.' }, 400);
    c.set('workspaceId', workspaceId);
    c.set('userId', c.req.header('x-user-id') ?? 'unknown');
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof InvalidEventError) return c.json({ error: error.message }, 409);
    console.error(error);
    return c.json({ error: 'Internal error.' }, 500);
  });

  const json = async (c: { req: { json(): Promise<unknown> } }) => {
    const body = await c.req.json().catch(() => undefined);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  };

  const step = async (state: AgentState, event: AgentEvent, surface?: Surface) => {
    if (event.type !== 'answer' && event.type !== 'confirm') {
      const allowed = (await deps.canBuild?.(state.workspaceId)) ?? { ok: true };
      if (!allowed.ok) {
        state.status = 'failed';
        state.message = allowed.reason ?? 'Building is paused for this workspace.';
        await deps.requests.put(state, surface);
        return reply(
          state,
          { kind: 'failed', message: state.message, attempts: [] },
          surface ?? {},
        );
      }
    }
    const output = await advance(state, event, deps.forWorkspace(state.workspaceId));
    await deps.requests.put(state, surface);
    const stored = await deps.requests.get(state.requestId, state.workspaceId);
    return reply(state, output, stored?.surface ?? surface ?? {});
  };

  app.post('/v1/requests', async (c) => {
    const body = await json(c);
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return c.json({ error: '"text" is required.' }, 400);
    }
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    const surface =
      body.surface && typeof body.surface === 'object' ? (body.surface as Surface) : {};
    const channel =
      slackChannel(surface) ?? (await deps.defaultAlertChannel?.(workspaceId)) ?? '#alerts';
    const state = newRequest({
      workspaceId,
      userId,
      text: body.text,
      userDefaults: await deps.readUserDefaults(workspaceId, userId),
      channel,
    });
    return c.json(await step(state, { type: 'start' }, surface));
  });

  app.get('/v1/requests/:id', async (c) => {
    const entry = await deps.requests.get(c.req.param('id'), c.get('workspaceId'));
    if (!entry) return c.json({ error: 'No such request.' }, 404);
    return c.json(reply(entry.state, currentOutput(entry.state), entry.surface));
  });

  app.post('/v1/requests/:id/answer', async (c) => {
    const entry = await deps.requests.get(c.req.param('id'), c.get('workspaceId'));
    if (!entry) return c.json({ error: 'No such request.' }, 404);
    const body = await json(c);
    if (typeof body.value !== 'string') return c.json({ error: '"value" is required.' }, 400);
    return c.json(await step(entry.state, { type: 'answer', value: body.value }));
  });

  app.post('/v1/requests/:id/confirm', async (c) => {
    const entry = await deps.requests.get(c.req.param('id'), c.get('workspaceId'));
    if (!entry) return c.json({ error: 'No such request.' }, 404);
    const body = await json(c);
    return c.json(
      await step(entry.state, {
        type: 'confirm',
        ...(typeof body.dashboardId === 'string' ? { dashboardId: body.dashboardId } : {}),
      }),
    );
  });

  /** "Alert me on this": a pending alert rule from this request's chart. */
  app.post('/v1/requests/:id/alert', async (c) => {
    const entry = await deps.requests.get(c.req.param('id'), c.get('workspaceId'));
    if (!entry) return c.json({ error: 'No such request.' }, 404);
    const body = await json(c);
    const event: AgentEvent = { type: 'alert' };
    if (body.op === '>' || body.op === '<') event.op = body.op;
    if (typeof body.threshold === 'number') event.threshold = body.threshold;
    if (typeof body.for === 'string') event.for = body.for;
    if (typeof body.channel === 'string' && /^#\S+$/.test(body.channel))
      entry.state.channel = body.channel;
    return c.json(await step(entry.state, event));
  });

  /**
   * Change an existing chart. Either `requestId` (a chart from a conversation)
   * or `panelId` (a saved panel), and `text`: what to change.
   */
  app.post('/v1/refine', async (c) => {
    const body = await json(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: '"text" is required.' }, 400);
    const workspaceId = c.get('workspaceId');
    const surface =
      body.surface && typeof body.surface === 'object' ? (body.surface as Surface) : {};
    let state: AgentState;
    if (typeof body.requestId === 'string') {
      const base = await deps.requests.get(body.requestId, workspaceId);
      if (!base?.state.draft) return c.json({ error: 'That request has no chart to change.' }, 404);
      state = seedRefinement({
        workspaceId,
        userId: c.get('userId'),
        text,
        base: { kind: 'request', state: base.state },
      });
    } else if (typeof body.panelId === 'string' && deps.loadPanel) {
      const panel = await deps.loadPanel(workspaceId, body.panelId);
      if (!panel) return c.json({ error: 'No such panel.' }, 404);
      state = seedRefinement({
        workspaceId,
        userId: c.get('userId'),
        text,
        base: {
          kind: 'panel',
          panel: panel.spec,
          panelId: body.panelId,
          ...(panel.dashboardId ? { dashboardId: panel.dashboardId } : {}),
        },
      });
    } else {
      return c.json({ error: '"requestId" or "panelId" is required.' }, 400);
    }
    return c.json(await step(state, { type: 'refine', text }, surface));
  });

  /** The latest chart in a Slack thread, so a follow-up there can change it. */
  app.get('/v1/threads/:channel/:ts', async (c) => {
    const state = await deps.requests.latestInThread(
      c.get('workspaceId'),
      c.req.param('channel'),
      c.req.param('ts'),
    );
    if (!state) return c.json({ error: 'No chart in this thread.' }, 404);
    return c.json(reply(state, currentOutput(state), {}));
  });

  /** "Why did this happen?": a labelled hypothesis with the charts behind it. */
  app.post('/v1/explain', async (c) => {
    const body = await json(c);
    if (typeof body.ruleId !== 'string' || !WORKSPACE_ID.test(body.ruleId)) {
      return c.json({ error: '"ruleId" is required.' }, 400);
    }
    if (!deps.explainAlert) return c.json({ error: 'Explanations are not available.' }, 501);
    const result = await deps.explainAlert(c.get('workspaceId'), body.ruleId);
    if (!result) return c.json({ error: 'No such alert rule.' }, 404);
    return c.json(result);
  });

  /** "Skip questions next time": save this request's answers as the asker's defaults. */
  app.post('/v1/requests/:id/remember', async (c) => {
    const entry = await deps.requests.get(c.req.param('id'), c.get('workspaceId'));
    if (!entry) return c.json({ error: 'No such request.' }, 404);
    if (entry.state.userId !== c.get('userId')) {
      return c.json({ error: 'Only the person who asked can save these answers.' }, 403);
    }
    const answers = rememberableAnswers(entry.state);
    const saved = await deps.saveUserDefaults(
      entry.state.workspaceId,
      entry.state.userId,
      answers,
      `request ${entry.state.requestId}`,
    );
    return c.json({ saved, answers });
  });

  return app;
}
