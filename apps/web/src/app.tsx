/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { AgentApiError, createAgentClient, type AgentReply } from '@app/agent-client';
import { readChart, renderSvg } from '@app/charts';
import { listEndpoints, listMetrics, listServices, searchCatalog } from '@app/catalog';
import type { PlansConfig, SecretBox } from '@app/config';
import { usage, type Billing } from './billing.js';
import { BillingPage, type BillingView } from './views/billing.js';
import {
  createAlertStore,
  createCollectorStore,
  createSpecStore,
  getWorkspace,
  schema,
  type Database,
  type StoredDashboard,
  type StoredPanel,
} from '@app/db';
import { createMetricsStore, parseStoreConfig } from '@app/query-api';
import { toGrafana } from './grafana.js';
import {
  createApiToken,
  createShare,
  revokeApiToken,
  revokeShare,
  sharedDashboard,
  workspaceForApiToken,
} from './tokens.js';
import { SettingsPage, type SettingsView } from './views/settings.js';
import { ShareMadePage, SharedPage } from './views/shared.js';
import { assertSafeUrl } from '@app/ingest';
import { durationToSeconds } from '@app/specs';
import { AlertEditPage, AlertsPage, CollectorEditPage, CollectorsPage } from './views/alerts.js';
import { createMemory } from '@app/memory';
import { createQueryApiClient, QueryApiError } from '@app/query-api/client';
import type { SlackStore } from '@app/slack';
import type { PanelSpec } from '@app/specs';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { CONTEXT_LIMITS, productionContext, recordDecision, type SourceFile } from '@app/review';
import { ReviewListPage, ReviewReportPage, type FindingView } from './views/review.js';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { mountAuth } from './auth.js';
import { CLIENT_SCRIPT } from './client-script.js';
import { SESSION_COOKIE, openSession, type Session } from './session.js';
import { CHART_THEME, DARK_CHART_THEME } from './theme.js';
import { Chart, DashboardPage, RANGES, type ChartView, type PanelView } from './views/dashboard.js';
import { MessagePage } from './views/layout.js';
import { MemoryPage } from './views/memory.js';

export interface WebOptions {
  db: Database;
  store: SlackStore;
  sessionKey: Buffer;
  webUrl: string;
  agentUrl: string;
  queryApiUrl: string;
  internalToken: string;
  defaultRange: string;
  allowPrivateCollectors?: boolean;
  secrets: SecretBox;
  billing: Billing;
  plans: PlansConfig;
  /** Review: where people install the GitHub App, and the Review service. */
  github?: { installUrl: string; reviewUrl: string };
  slack: { clientId: string; clientSecret: string; apiUrl: string; openidAuthorizeUrl: string };
}

type Variables = { session: Session };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RANGE_VALUES = new Set<string>(RANGES.map(([value]) => value));

/**
 * The web tool. Reading a dashboard, changing its range and refreshing it run
 * saved queries through the Query API and never call a model. Only asking
 * (the Ask panel) reaches the agent.
 */
export function createWebApp(options: WebOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const origin = new URL(options.webUrl).origin;

  const message = (
    c: Context,
    title: string,
    text: string,
    status: 400 | 403 | 404 = 400,
    action?: { href: string; label: string },
  ) => c.html(<MessagePage title={title} text={text} {...(action ? { action } : {})} />, status);

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/app.js', (c) =>
    c.body(CLIENT_SCRIPT, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    }),
  );
  app.get('/login', (c) =>
    c.html(
      <MessagePage
        title="Sign in"
        text="Sign in with the Slack workspace that installed the app."
        action={{ href: '/auth/slack', label: 'Sign in with Slack' }}
      />,
    ),
  );

  mountAuth(
    app as unknown as Hono,
    {
      store: options.store,
      clientId: options.slack.clientId,
      clientSecret: options.slack.clientSecret,
      apiUrl: options.slack.apiUrl,
      authorizeUrl: options.slack.openidAuthorizeUrl,
      webUrl: options.webUrl,
      sessionKey: options.sessionKey,
    },
    (c, title, text, status) => message(c, title, text, status) as unknown as Response,
  );

  /** Panels of a dashboard with their charts. Reads specs and runs saved queries; never calls a model. */
  async function panelViews(
    workspaceId: string,
    dashboard: StoredDashboard,
    range: string,
  ): Promise<PanelView[]> {
    const specs = createSpecStore(options.db, workspaceId);
    const stored = (
      await Promise.all(dashboard.spec.panel_ids.map((id) => specs.latestPanel(id)))
    ).filter((p): p is StoredPanel => p !== undefined);
    const as = { workspaceId } as Session;
    return Promise.all(
      stored.map(async (panel) => {
        const place = dashboard.spec.layout.find((item) => item.panel_id === panel.id);
        return {
          id: panel.id,
          version: panel.version,
          spec: panel.spec,
          chart: await chart(as, panel.spec, range),
          layout: { x: place?.x ?? 0, w: place?.w ?? 6 },
        };
      }),
    );
  }

  // Stripe calls this; it is verified by its signature, not a session.
  app.post('/billing/webhook', async (c) => {
    const ok = await options.billing.webhook(await c.req.text(), c.req.header('stripe-signature'));
    return ok ? c.json({ received: true }) : c.json({ error: 'Bad signature.' }, 400);
  });

  // W9: a read-only dashboard behind a share link. No sign-in, no model.
  app.get('/share/:token', async (c) => {
    const shared = await sharedDashboard(options.db, c.req.param('token'));
    const dashboard = shared
      ? await createSpecStore(options.db, shared.workspaceId).latestDashboard(shared.dashboardId)
      : undefined;
    if (!shared || !dashboard)
      return message(c, 'Link not valid', 'This link has expired or was revoked.', 404);
    const range = rangeOf(c, dashboard.spec.default_range);
    const panels = await panelViews(shared.workspaceId, dashboard, range);
    return c.html(
      <SharedPage
        title={dashboard.spec.title}
        token={c.req.param('token')}
        panels={panels}
        range={range}
      />,
    );
  });

  app.get('/share/:token/panels/:panel/chart', async (c) => {
    const shared = await sharedDashboard(options.db, c.req.param('token'));
    if (!shared) return c.text('Not found', 404);
    const specs = createSpecStore(options.db, shared.workspaceId);
    const dashboard = await specs.latestDashboard(shared.dashboardId);
    const panelId = c.req.param('panel');
    if (!dashboard?.spec.panel_ids.includes(panelId)) return c.text('Not found', 404);
    const panel = await specs.latestPanel(panelId);
    if (!panel) return c.text('Not found', 404);
    return c.html(
      <Chart
        chart={await chart(
          { workspaceId: shared.workspaceId } as Session,
          panel.spec,
          rangeOf(c, dashboard.spec.default_range),
        )}
      />,
    );
  });

  // Read-only APIs for Grafana (Prometheus-compatible) and the connector for Claude Code.
  const api = new Hono<{ Variables: { workspaceId: string } }>();
  api.use('*', async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const workspaceId = token ? await workspaceForApiToken(options.db, token) : undefined;
    if (!workspaceId)
      return c.json(
        { status: 'error', errorType: 'unauthorized', error: 'A valid API token is required.' },
        401,
      );
    c.set('workspaceId', workspaceId);
    await next();
  });
  api.onError((error, c) => {
    if (error instanceof QueryApiError) {
      return c.json(
        {
          status: 'error',
          errorType: error.body.code === 'forbidden' ? 'bad_data' : 'execution',
          error: error.body.message,
        },
        422,
      );
    }
    console.error(error);
    return c.json({ status: 'error', errorType: 'internal', error: 'Internal error.' }, 500);
  });
  const promParams = async (c: Context) => {
    const params: [string, string][] = [];
    for (const [k, v] of new URL(c.req.url).searchParams) params.push([k, v]);
    if (c.req.method === 'POST') {
      const form = new URLSearchParams(await c.req.text());
      for (const [k, v] of form) params.push([k, v]);
    }
    return params;
  };
  for (const endpoint of ['query', 'query_range', 'series', 'labels'] as const) {
    api.on(['GET', 'POST'], `/prom/api/v1/${endpoint}`, async (c) => {
      const data = await queryFor({ workspaceId: c.get('workspaceId') } as Session).prom(
        endpoint,
        await promParams(c),
      );
      return c.json({ status: 'success', data });
    });
  }
  api.get('/prom/api/v1/label/:name/values', async (c) => {
    const data = await queryFor({ workspaceId: c.get('workspaceId') } as Session).prom(
      'label_values',
      await promParams(c),
      c.req.param('name'),
    );
    return c.json({ status: 'success', data });
  });
  api.get('/prom/api/v1/status/buildinfo', (c) =>
    c.json({ status: 'success', data: { version: '2.50.0' } }),
  );
  api.get('/v1/services', async (c) =>
    c.json({ services: await listServices(options.db, c.get('workspaceId')) }),
  );
  api.get('/v1/catalog/search', async (c) => {
    const service = c.req.query('service');
    const result = await searchCatalog(options.db, c.get('workspaceId'), {
      text: c.req.query('text') ?? '',
      ...(service ? { service } : {}),
    });
    return c.json({
      metrics: result.metrics.map((m) => ({
        service: m.service,
        name: m.metricName,
        series: m.series,
        type: m.type,
        unit: m.unit,
        labels: m.labels,
        description: m.description,
      })),
      endpoints: result.endpoints,
    });
  });
  api.get('/v1/endpoints', async (c) =>
    c.json({
      endpoints: await listEndpoints(options.db, c.get('workspaceId'), c.req.query('service')),
    }),
  );
  api.post('/v1/query', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; range?: unknown };
    if (typeof body.query !== 'string') return c.json({ error: '"query" is required.' }, 400);
    const result = await queryFor({ workspaceId: c.get('workspaceId') } as Session).query({
      query: body.query,
      range: typeof body.range === 'string' ? body.range : '1h',
    });
    return c.json(result);
  });
  /**
   * Production context for files a coding agent is about to change: the
   * endpoints they handle and what production says about each. The files are
   * read, never stored.
   */
  api.post('/v1/context', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { files?: unknown; manifests?: unknown };
    const sources = (value: unknown) =>
      Array.isArray(value)
        ? value.filter(
            (f): f is SourceFile =>
              typeof f === 'object' &&
              f !== null &&
              typeof (f as SourceFile).path === 'string' &&
              typeof (f as SourceFile).content === 'string',
          )
        : [];
    const files = sources(body.files);
    const manifests = sources(body.manifests);
    if (files.length === 0) return c.json({ error: '"files" is required.' }, 400);
    if (files.length > CONTEXT_LIMITS.files) {
      return c.json({ error: `At most ${CONTEXT_LIMITS.files} files at a time.` }, 400);
    }
    if ([...files, ...manifests].some((f) => f.content.length > CONTEXT_LIMITS.bytesPerFile)) {
      return c.json({ error: 'A file is too large.' }, 413);
    }
    const workspaceId = c.get('workspaceId');
    return c.json(
      await productionContext({
        files,
        manifests,
        query: queryFor({ workspaceId } as Session),
        rules: await createAlertStore(options.db, workspaceId).list(),
      }),
    );
  });
  app.route('/api', api as unknown as Hono<{ Variables: Variables }>);

  // Everything below needs a signed-in person, and forms must come from this site.
  app.use('*', async (c, next) => {
    const session = openSession(getCookie(c, SESSION_COOKIE), options.sessionKey);
    if (!session) {
      if (c.req.method === 'GET' && !c.req.path.includes('/chart'))
        return c.redirect('/login', 302);
      return c.text('Sign in first.', 401);
    }
    if (c.req.method === 'POST') {
      const from = c.req.header('origin');
      if (from && from !== origin) return c.text('Cross-site request refused.', 403);
    }
    c.set('session', session);
    await next();
  });

  const agentFor = (session: Session) =>
    createAgentClient({
      url: options.agentUrl,
      internalToken: options.internalToken,
      workspaceId: session.workspaceId,
      userId: session.userId,
    });
  const queryFor = (session: Session) =>
    createQueryApiClient({
      url: options.queryApiUrl,
      internalToken: options.internalToken,
      workspaceId: session.workspaceId,
    });

  /** Draw a panel from its saved query. No model is involved. */
  async function chart(
    session: Session,
    spec: PanelSpec,
    range: string,
    size = { width: 480, height: 220 },
  ): Promise<ChartView> {
    const effective = spec.range && !RANGE_VALUES.has(range) ? spec.range : range;
    try {
      const result = await queryFor(session).query({ query: spec.query, range: effective });
      return {
        svg: renderSvg(spec, result.series, {
          ...size,
          theme: CHART_THEME,
          range: effective,
          title: false,
        }),
        svgDark: renderSvg(spec, result.series, {
          ...size,
          theme: DARK_CHART_THEME,
          range: effective,
          title: false,
        }),
        reading: readChart({ ...spec, range: effective }, result.series, effective),
      };
    } catch (error) {
      const text = error instanceof QueryApiError ? error.message : 'The data could not be loaded.';
      return { reading: text, error: text };
    }
  }

  async function firstDashboard(session: Session): Promise<string> {
    const specs = createSpecStore(options.db, session.workspaceId);
    const existing = await specs.listDashboards();
    if (existing[0]) return existing[0].id;
    const created = await specs.createDashboard(
      { title: 'Dashboard', panel_ids: [], layout: [], default_range: options.defaultRange },
      { kind: 'user', id: session.userId },
    );
    return created.id;
  }

  const rangeOf = (c: Context, fallback: string) => {
    const asked = c.req.query('range');
    return asked && RANGE_VALUES.has(asked) ? asked : fallback;
  };
  const backTo = (dashboardId: string, params: Record<string, string | undefined>, hash = '') => {
    const query = new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
    );
    return `/dashboards/${dashboardId}${query.size ? `?${query}` : ''}${hash}`;
  };

  app.get('/', async (c) =>
    c.redirect(`/dashboards/${await firstDashboard(c.get('session'))}`, 302),
  );

  /** The dashboard switcher's form lands here. */
  app.get('/dashboards/go', (c) => {
    const id = c.req.query('id');
    return c.redirect(id && UUID.test(id) ? `/dashboards/${id}` : '/', 302);
  });

  app.get('/dashboards/:id', async (c) => {
    const session = c.get('session');
    const id = c.req.param('id');
    if (!UUID.test(id)) return message(c, 'Not found', 'There is no such dashboard.', 404);
    const specs = createSpecStore(options.db, session.workspaceId);
    const dashboard = await specs.latestDashboard(id);
    if (!dashboard)
      return message(c, 'Not found', 'There is no such dashboard.', 404, {
        href: '/',
        label: 'Go to your dashboard',
      });
    const range = rangeOf(c, dashboard.spec.default_range);

    const stored = (
      await Promise.all(dashboard.spec.panel_ids.map((panelId) => specs.latestPanel(panelId)))
    ).filter((p): p is StoredPanel => p !== undefined);
    const editing = c.req.query('panel');
    const panels: PanelView[] = await Promise.all(
      stored.map(async (panel) => {
        const place = dashboard.spec.layout.find((item) => item.panel_id === panel.id);
        return {
          id: panel.id,
          version: panel.version,
          spec: panel.spec,
          chart: await chart(session, panel.spec, range),
          layout: { x: place?.x ?? 0, w: place?.w ?? 6 },
          ...(editing === panel.id && c.req.query('edit_error')
            ? { editError: c.req.query('edit_error')! }
            : {}),
        };
      }),
    );

    let ask;
    const requestId = c.req.query('request');
    if (requestId && UUID.test(requestId)) {
      try {
        const reply = await agentFor(session).get(requestId);
        ask = {
          reply,
          ...(reply.output.kind === 'draft'
            ? {
                chart: await chart(session, reply.output.panel, reply.output.panel.range ?? range, {
                  width: 880,
                  height: 280,
                }),
              }
            : {}),
        };
      } catch {
        ask = undefined;
      }
    }

    const all = (await specs.listDashboards()).map((d) => ({ id: d.id, title: d.spec.title }));
    return c.html(
      <DashboardPage
        dashboards={all}
        userName={session.name}
        dashboard={{ id, title: dashboard.spec.title }}
        panels={panels}
        range={range}
        defaultRange={dashboard.spec.default_range}
        {...(ask ? { ask } : {})}
        {...(c.req.query('added') ? { newPanelId: c.req.query('added')! } : {})}
      />,
    );
  });

  /** One panel's chart, for auto-refresh. Runs the saved query; never calls a model. */
  app.get('/dashboards/:id/panels/:panel/chart', async (c) => {
    const session = c.get('session');
    const specs = createSpecStore(options.db, session.workspaceId);
    const dashboard = UUID.test(c.req.param('id'))
      ? await specs.latestDashboard(c.req.param('id'))
      : undefined;
    const panelId = c.req.param('panel');
    if (!dashboard || !dashboard.spec.panel_ids.includes(panelId)) return c.text('Not found', 404);
    const panel = await specs.latestPanel(panelId);
    if (!panel) return c.text('Not found', 404);
    const view = await chart(session, panel.spec, rangeOf(c, dashboard.spec.default_range));
    return c.html(<Chart chart={view} />);
  });

  /** W5: edit a panel's query by hand. The query must pass a dry run before it is saved. */
  app.post('/dashboards/:id/panels/:panel/query', async (c) => {
    const session = c.get('session');
    const dashboardId = c.req.param('id');
    const panelId = c.req.param('panel');
    const body = await c.req.parseBody();
    const range =
      typeof body.range === 'string' && RANGE_VALUES.has(body.range) ? body.range : undefined;
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const specs = createSpecStore(options.db, session.workspaceId);
    const dashboard = UUID.test(dashboardId) ? await specs.latestDashboard(dashboardId) : undefined;
    const panel = dashboard?.spec.panel_ids.includes(panelId)
      ? await specs.latestPanel(panelId)
      : undefined;
    if (!dashboard || !panel) return message(c, 'Not found', 'There is no such panel.', 404);
    const fail = (error: string) =>
      c.redirect(
        backTo(dashboardId, { range, panel: panelId, edit_error: error }, `#panel-${panelId}`),
        303,
      );
    if (query === '') return fail('The query is empty.');
    if (query === panel.spec.query)
      return c.redirect(backTo(dashboardId, { range }, `#panel-${panelId}`), 303);
    const dry = await queryFor(session).dryRun({
      query,
      range: panel.spec.range ?? dashboard.spec.default_range,
    });
    if (!dry.ok) return fail(dry.error?.message ?? 'The query failed.');
    if (dry.lineCount === 0) return fail('The query ran but returned no data.');
    await specs.savePanel(
      {
        ...panel.spec,
        query,
        assumptions: [
          ...panel.spec.assumptions.filter((a) => a !== 'query edited by hand'),
          'query edited by hand',
        ],
      },
      { kind: 'user', id: session.userId },
      { panelId },
    );
    return c.redirect(backTo(dashboardId, { range }, `#panel-${panelId}`), 303);
  });

  /** W6: change a panel by prompt. The new version is a draft until "Looks right". */
  app.post('/dashboards/:id/panels/:panel/refine', async (c) => {
    const session = c.get('session');
    const dashboardId = c.req.param('id');
    const body = await c.req.parseBody();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.redirect(backTo(dashboardId, {}), 303);
    try {
      const reply = await agentFor(session).refine({ panelId: c.req.param('panel') }, text, {
        web: { dashboardId },
      });
      return c.redirect(backTo(dashboardId, { request: reply.requestId }), 303);
    } catch (error) {
      if (error instanceof AgentApiError)
        return message(c, 'Could not change the panel', error.message, 400, {
          href: backTo(dashboardId, {}),
          label: 'Back to the dashboard',
        });
      throw error;
    }
  });

  app.post('/dashboards/:id/ask', async (c) => {
    const session = c.get('session');
    const dashboardId = c.req.param('id');
    const body = await c.req.parseBody();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '') return c.redirect(backTo(dashboardId, {}), 303);
    const reply = await agentFor(session).ask(text, { web: { dashboardId } });
    return c.redirect(backTo(dashboardId, { request: reply.requestId }), 303);
  });

  /** "Open in web" from Slack lands here. */
  app.get('/requests/:id', async (c) => {
    const session = c.get('session');
    let reply: AgentReply;
    try {
      reply = await agentFor(session).get(c.req.param('id'));
    } catch {
      return message(
        c,
        'Not found',
        'This request has expired or belongs to another workspace.',
        404,
        { href: '/', label: 'Go to your dashboard' },
      );
    }
    const dashboardId =
      (reply.surface as { web?: { dashboardId?: string } }).web?.dashboardId ??
      (await firstDashboard(session));
    if (reply.output.kind === 'saved') {
      return c.redirect(
        backTo(
          reply.output.dashboardId,
          { added: reply.output.panelId },
          `#panel-${reply.output.panelId}`,
        ),
        302,
      );
    }
    return c.redirect(backTo(dashboardId, { request: reply.requestId }), 302);
  });

  const formDashboard = async (c: Context<{ Variables: Variables }>) => {
    const body = await c.req.parseBody();
    const id =
      typeof body.dashboardId === 'string' && UUID.test(body.dashboardId)
        ? body.dashboardId
        : await firstDashboard(c.get('session'));
    return { body, dashboardId: id };
  };

  app.post('/requests/:id/answer', async (c) => {
    const { body, dashboardId } = await formDashboard(c);
    const requestId = c.req.param('id');
    try {
      await agentFor(c.get('session')).answer(requestId, String(body.value ?? ''));
    } catch (error) {
      if (!(error instanceof AgentApiError)) throw error;
    }
    return c.redirect(backTo(dashboardId, { request: requestId }), 303);
  });

  app.post('/requests/:id/confirm', async (c) => {
    const { dashboardId } = await formDashboard(c);
    const requestId = c.req.param('id');
    const reply = await agentFor(c.get('session')).confirm(requestId, dashboardId);
    if (reply.output.kind !== 'saved')
      return c.redirect(backTo(dashboardId, { request: requestId }), 303);
    return c.redirect(
      backTo(
        reply.output.dashboardId,
        { request: requestId, added: reply.output.panelId },
        `#panel-${reply.output.panelId}`,
      ),
      303,
    );
  });

  app.post('/requests/:id/remember', async (c) => {
    const { dashboardId } = await formDashboard(c);
    const requestId = c.req.param('id');
    await agentFor(c.get('session'))
      .remember(requestId)
      .catch(() => undefined);
    return c.redirect(backTo(dashboardId, { request: requestId }), 303);
  });

  // W9 and W12: share a dashboard by link; export it to Grafana.
  app.post('/dashboards/:id/share', async (c) => {
    const session = c.get('session');
    const dashboard = UUID.test(c.req.param('id'))
      ? await createSpecStore(options.db, session.workspaceId).latestDashboard(c.req.param('id'))
      : undefined;
    if (!dashboard) return message(c, 'Not found', 'There is no such dashboard.', 404);
    const token = await createShare(options.db, session.workspaceId, dashboard.id, session.userId);
    return c.html(
      <ShareMadePage link={`${options.webUrl}/share/${token}`} dashboardId={dashboard.id} />,
    );
  });

  app.get('/dashboards/:id/export/grafana', async (c) => {
    const session = c.get('session');
    const specs = createSpecStore(options.db, session.workspaceId);
    const dashboard = UUID.test(c.req.param('id'))
      ? await specs.latestDashboard(c.req.param('id'))
      : undefined;
    if (!dashboard) return message(c, 'Not found', 'There is no such dashboard.', 404);
    const panels = (
      await Promise.all(dashboard.spec.panel_ids.map((id) => specs.latestPanel(id)))
    ).filter((p): p is StoredPanel => p !== undefined);
    const json = toGrafana({ title: dashboard.spec.title, spec: dashboard.spec }, panels);
    const name =
      dashboard.spec.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'dashboard';
    return c.body(JSON.stringify(json, null, 2), 200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${name}.grafana.json"`,
    });
  });

  // Settings: admins change them; everyone can see them.
  const isAdmin = async (session: Session) => {
    const [row] = await options.db
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .limit(1);
    return row?.role === 'admin';
  };

  async function settingsView(
    session: Session,
    extra: Partial<SettingsView> = {},
  ): Promise<SettingsView> {
    const workspace = await getWorkspace(options.db, session.workspaceId);
    const settings = (workspace?.settings ?? {}) as { alertChannel?: string };
    const tokens = await options.db
      .select()
      .from(schema.apiTokens)
      .where(
        and(
          eq(schema.apiTokens.workspaceId, session.workspaceId),
          isNull(schema.apiTokens.revokedAt),
        ),
      );
    const shares = await options.db
      .select()
      .from(schema.dashboardShares)
      .where(
        and(
          eq(schema.dashboardShares.workspaceId, session.workspaceId),
          isNull(schema.dashboardShares.revokedAt),
        ),
      );
    const specs = createSpecStore(options.db, session.workspaceId);
    const titles = new Map((await specs.listDashboards()).map((d) => [d.id, d.spec.title]));
    const store = parseStoreConfig(workspace?.metricsStoreConfig);
    return {
      userName: session.name,
      isAdmin: await isAdmin(session),
      alertChannel: settings.alertChannel ?? '#alerts',
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      })),
      shares: shares.map((s) => ({
        id: s.id,
        dashboardTitle: titles.get(s.dashboardId) ?? 'A dashboard',
        createdAt: s.createdAt,
      })),
      store: store ? { type: store.type, url: store.url } : null,
      github: (
        await options.db
          .select()
          .from(schema.githubInstallations)
          .where(eq(schema.githubInstallations.workspaceId, session.workspaceId))
      ).map((i) => i.account),
      webUrl: options.webUrl,
      ...extra,
    };
  }

  app.get('/settings', async (c) => {
    const notice = c.req.query('notice');
    const error = c.req.query('error');
    return c.html(
      <SettingsPage
        {...await settingsView(c.get('session'), {
          ...(notice ? { notice } : {}),
          ...(error ? { error } : {}),
        })}
      />,
    );
  });

  const adminOnly = async (c: Context<{ Variables: Variables }>) =>
    (await isAdmin(c.get('session')))
      ? undefined
      : c.redirect('/settings?error=Only%20an%20admin%20can%20change%20settings.', 303);

  app.post('/settings/alert-channel', async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    const channel = String((await c.req.parseBody()).channel ?? '').trim();
    if (!/^#\S+$/.test(channel))
      return c.redirect('/settings?error=The%20channel%20must%20start%20with%20%23.', 303);
    const session = c.get('session');
    const workspace = await getWorkspace(options.db, session.workspaceId);
    await options.db
      .update(schema.workspaces)
      .set({ settings: { ...((workspace?.settings ?? {}) as object), alertChannel: channel } })
      .where(eq(schema.workspaces.id, session.workspaceId));
    return c.redirect('/settings?notice=Saved.', 303);
  });

  app.post('/settings/tokens', async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    const session = c.get('session');
    const name =
      String((await c.req.parseBody()).name ?? '')
        .trim()
        .slice(0, 80) || 'Token';
    const { token } = await createApiToken(options.db, session.workspaceId, name, session.userId);
    return c.html(
      <SettingsPage
        {...await settingsView(session, {
          newSecret: {
            label: `New token: ${name}`,
            value: token,
            note: 'Shown once. Store it in a secret store or your environment, never in a repository.',
          },
        })}
      />,
    );
  });

  app.post('/settings/tokens/:id/revoke', async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    if (UUID.test(c.req.param('id')))
      await revokeApiToken(options.db, c.get('session').workspaceId, c.req.param('id'));
    return c.redirect('/settings?notice=Revoked.', 303);
  });

  app.post('/settings/shares/:id/revoke', async (c) => {
    if (UUID.test(c.req.param('id')))
      await revokeShare(options.db, c.get('session').workspaceId, c.req.param('id'));
    return c.redirect('/settings?notice=The%20link%20no%20longer%20works.', 303);
  });

  // H8: read from a store the customer already runs.
  app.post('/settings/store', async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    const session = c.get('session');
    const body = await c.req.parseBody();
    const type = body.type === 'victoriametrics' ? 'victoriametrics' : 'prometheus';
    const url = String(body.url ?? '')
      .trim()
      .replace(/\/+$/, '');
    const token = String(body.token ?? '').trim();
    const fail = (error: string) => c.redirect(`/settings?error=${encodeURIComponent(error)}`, 303);
    try {
      await assertSafeUrl(url, options.allowPrivateCollectors ?? false);
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'That URL cannot be used.');
    }
    // Test it: a store that answers a label listing is a Prometheus-compatible store.
    const probe = createMetricsStore({
      url,
      type,
      timeoutMs: 5000,
      ...(token ? { bearerToken: token } : {}),
    });
    let names: string[];
    try {
      names = (await probe.raw('/api/v1/label/__name__/values', [], null)) as string[];
    } catch (error) {
      return fail(
        `The store did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await options.db
      .update(schema.workspaces)
      .set({
        metricsStoreConfig: {
          type,
          url,
          ...(token ? { tokenSealed: options.secrets.seal(token) } : {}),
        },
      })
      .where(eq(schema.workspaces.id, session.workspaceId));
    return c.redirect(
      `/settings?notice=${encodeURIComponent(`Connected. The store has ${names.length} metric names; the catalog fills within a minute.`)}`,
      303,
    );
  });

  app.post('/settings/store/remove', async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    await options.db
      .update(schema.workspaces)
      .set({ metricsStoreConfig: {} })
      .where(eq(schema.workspaces.id, c.get('session').workspaceId));
    return c.redirect('/settings?notice=Back%20on%20the%20hosted%20store.', 303);
  });

  // Billing (H5), usage (H6), export (H7).
  app.get('/billing', async (c) => {
    const session = c.get('session');
    const workspace = await getWorkspace(options.db, session.workspaceId);
    const admin = await isAdmin(session);
    const query = queryFor(session);
    const view: BillingView = {
      userName: session.name,
      isAdmin: admin,
      enabled: options.billing.enabled,
      status: workspace?.billingStatus ?? 'trialing',
      trialEndsAt: workspace?.trialEndsAt ?? null,
      currentPeriodEnd: workspace?.currentPeriodEnd ?? null,
      deletionScheduledAt: workspace?.deletionScheduledAt ?? null,
      usage: await usage(options.db, options.plans, session.workspaceId, async () => {
        const rows = await query.instant('count({__name__=~".+"})');
        return rows[0]?.value ?? 0;
      }),
      invoices: admin ? await options.billing.invoices(session.workspaceId).catch(() => []) : [],
      ...(c.req.query('notice') ? { notice: c.req.query('notice')! } : {}),
      ...(c.req.query('error') ? { error: c.req.query('error')! } : {}),
    };
    return c.html(<BillingPage {...view} />);
  });

  app.post('/billing/checkout', async (c) => {
    if (!(await isAdmin(c.get('session'))))
      return c.redirect('/billing?error=Only%20an%20admin%20can%20subscribe.', 303);
    try {
      return c.redirect(
        await options.billing.checkout(c.get('session').workspaceId, undefined),
        303,
      );
    } catch (error) {
      return c.redirect(
        `/billing?error=${encodeURIComponent(error instanceof Error ? error.message : 'Checkout failed.')}`,
        303,
      );
    }
  });

  app.post('/billing/cancel', async (c) => {
    if (!(await isAdmin(c.get('session'))))
      return c.redirect('/billing?error=Only%20an%20admin%20can%20cancel.', 303);
    try {
      await options.billing.cancel(c.get('session').workspaceId);
    } catch (error) {
      return c.redirect(
        `/billing?error=${encodeURIComponent(error instanceof Error ? error.message : 'Cancelling failed.')}`,
        303,
      );
    }
    return c.redirect(
      '/billing?notice=Cancelled.%20Download%20an%20export%20before%20the%20data%20is%20deleted.',
      303,
    );
  });

  /** Everything the workspace made, as one JSON file: dashboards, panels, alerts, data sources, memory, catalog. */
  app.get('/billing/export', async (c) => {
    const session = c.get('session');
    const ws = session.workspaceId;
    const specs = createSpecStore(options.db, ws);
    const dashboards = await specs.listDashboards();
    const panelIds = [...new Set(dashboards.flatMap((d) => d.spec.panel_ids))];
    const panels = (await Promise.all(panelIds.map((id) => specs.latestPanel(id)))).filter(Boolean);
    const workspace = await getWorkspace(options.db, ws);
    const body = {
      exported_at: new Date().toISOString(),
      workspace: { id: ws, name: workspace?.name, plan: workspace?.plan },
      dashboards: dashboards.map((d) => ({ id: d.id, version: d.version, ...d.spec })),
      panels: panels.map((p) => ({ id: p!.id, version: p!.version, ...p!.spec })),
      alert_rules: (await createAlertStore(options.db, ws).list()).map((r) => ({
        id: r.id,
        version: r.version,
        ...r.spec,
      })),
      collectors: (await createCollectorStore(options.db, ws).list()).map((x) => ({
        id: x.id,
        version: x.version,
        ...x.spec,
      })),
      memory: (await createMemory(options.db, ws).list()).map((m) => ({
        kind: m.kind,
        subject: m.subject,
        text: m.text,
        source: m.source,
        created_at: m.createdAt,
      })),
      catalog: {
        metrics: await listMetrics(options.db, ws),
        endpoints: await listEndpoints(options.db, ws),
      },
    };
    return c.body(JSON.stringify(body, null, 2), 200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="workspace-export.json"',
    });
  });

  /** The workspace's metric samples, as JSON lines. */
  app.get('/billing/export/metrics', async (c) => {
    try {
      const stream = await queryFor(c.get('session')).exportWorkspaceData();
      return new Response(stream, {
        headers: {
          'content-type': 'application/x-ndjson',
          'content-disposition': 'attachment; filename="metrics.jsonl"',
        },
      });
    } catch {
      return c.redirect(
        '/billing?error=Metrics%20in%20your%20own%20store%20are%20not%20exported.',
        303,
      );
    }
  });

  // Review (phase 5): connect GitHub, run reports, read and decide on findings, comment.
  const githubState = (session: Session) => {
    const body = Buffer.from(
      JSON.stringify({ w: session.workspaceId, u: session.userId, e: Date.now() + 600_000 }),
    ).toString('base64url');
    return `${body}.${createHmac('sha256', options.sessionKey).update(`github:${body}`).digest('base64url')}`;
  };
  const readGithubState = (state: string) => {
    const [body, signature] = state.split('.');
    if (!body || !signature) return undefined;
    const expected = createHmac('sha256', options.sessionKey)
      .update(`github:${body}`)
      .digest('base64url');
    if (signature !== expected) return undefined;
    const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      w: string;
      u: string;
      e: number;
    };
    return value.e > Date.now() ? value : undefined;
  };

  app.post('/github/connect', async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    if (!options.github) return c.redirect('/settings?error=GitHub%20is%20not%20set%20up.', 303);
    const url = new URL(options.github.installUrl);
    url.searchParams.set('state', githubState(c.get('session')));
    return c.redirect(url.toString(), 303);
  });

  app.get('/github/setup', async (c) => {
    const session = c.get('session');
    const state = readGithubState(c.req.query('state') ?? '');
    const installation = c.req.query('installation_id');
    if (!state || state.w !== session.workspaceId || !installation || !/^\d+$/.test(installation)) {
      return message(
        c,
        'Connecting GitHub failed',
        'The link has expired. Start again from Settings.',
        400,
      );
    }
    await options.db
      .insert(schema.githubInstallations)
      .values({
        installationId: installation,
        workspaceId: session.workspaceId,
        account: c.req.query('account') ?? 'GitHub',
      })
      .onConflictDoUpdate({
        target: schema.githubInstallations.installationId,
        set: { workspaceId: session.workspaceId },
      });
    return c.redirect('/review?notice=GitHub%20is%20connected.', 302);
  });

  app.get('/review', async (c) => {
    const session = c.get('session');
    const reports = await options.db
      .select()
      .from(schema.reviewReports)
      .where(eq(schema.reviewReports.workspaceId, session.workspaceId))
      .orderBy(desc(schema.reviewReports.createdAt))
      .limit(100);
    const counts = await options.db
      .select({
        reportId: schema.reviewFindings.reportId,
        status: schema.reviewFindings.status,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.reviewFindings)
      .where(eq(schema.reviewFindings.workspaceId, session.workspaceId))
      .groupBy(schema.reviewFindings.reportId, schema.reviewFindings.status);
    const connected = await options.db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, session.workspaceId));
    const summary = reports.map((r) => {
      const mine = counts.filter((x) => x.reportId === r.id);
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        repository: r.repository,
        createdAt: r.createdAt,
        findings: mine.reduce((sum, x) => sum + x.n, 0),
        open: mine.filter((x) => x.status === 'open').reduce((sum, x) => sum + x.n, 0),
      };
    });
    return c.html(
      <ReviewListPage
        userName={session.name}
        reports={summary}
        connected={connected.map((i) => i.account)}
        {...(c.req.query('notice') ? { notice: c.req.query('notice')! } : {})}
        {...(c.req.query('error') ? { error: c.req.query('error')! } : {})}
      />,
    );
  });

  app.post('/review/run', async (c) => {
    if (!options.github) return c.redirect('/review?error=Review%20is%20not%20set%20up.', 303);
    const session = c.get('session');
    const kind =
      String((await c.req.parseBody()).kind) === 'architecture' ? 'architecture' : 'bottleneck';
    const response = await fetch(`${options.github.reviewUrl}/v1/reports`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.internalToken}`,
        'x-workspace-id': session.workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind }),
    }).catch(() => undefined);
    if (!response?.ok)
      return c.redirect('/review?error=The%20review%20could%20not%20run.%20Try%20again.', 303);
    const { reports } = (await response.json()) as { reports: { reportId: string }[] };
    return c.redirect(
      reports[0]
        ? `/review/${reports[0].reportId}`
        : '/review?notice=No%20repository%20with%20a%20manifest%20was%20found.',
      303,
    );
  });

  app.get('/review/:id', async (c) => {
    const session = c.get('session');
    const id = c.req.param('id');
    if (!UUID.test(id)) return message(c, 'Not found', 'There is no such review.', 404);
    const [report] = await options.db
      .select()
      .from(schema.reviewReports)
      .where(
        and(
          eq(schema.reviewReports.id, id),
          eq(schema.reviewReports.workspaceId, session.workspaceId),
        ),
      )
      .limit(1);
    if (!report)
      return message(c, 'Not found', 'There is no such review.', 404, {
        href: '/review',
        label: 'All reviews',
      });
    const findings = await options.db
      .select()
      .from(schema.reviewFindings)
      .where(
        and(
          eq(schema.reviewFindings.reportId, id),
          eq(schema.reviewFindings.workspaceId, session.workspaceId),
        ),
      )
      .orderBy(schema.reviewFindings.createdAt);
    const comments = await options.db
      .select()
      .from(schema.reviewComments)
      .where(
        and(
          eq(schema.reviewComments.reportId, id),
          eq(schema.reviewComments.workspaceId, session.workspaceId),
        ),
      )
      .orderBy(schema.reviewComments.createdAt);
    const names = await people(session.workspaceId);
    const view = (list: typeof comments) =>
      list.map((x) => ({ author: names[x.userId] ?? 'A member', text: x.text, at: x.createdAt }));
    return c.html(
      <ReviewReportPage
        userName={session.name}
        report={{
          id: report.id,
          kind: report.kind,
          title: report.title,
          repository: report.repository,
          createdAt: report.createdAt,
          body: report.body as Record<string, unknown>,
        }}
        findings={findings.map((f) => ({
          id: f.id,
          kind: f.kind,
          title: f.title,
          body: f.body,
          status: f.status,
          evidence: f.evidence as FindingView['evidence'],
          path: f.path,
          line: f.line,
          externalUrl: (f.externalRef as { url?: string } | null)?.url ?? null,
          comments: view(comments.filter((x) => x.findingId === f.id)),
        }))}
        reportComments={view(comments.filter((x) => !x.findingId))}
      />,
    );
  });

  for (const decision of ['accept', 'dismiss'] as const) {
    app.post(`/review/findings/:id/${decision}`, async (c) => {
      const session = c.get('session');
      const finding = UUID.test(c.req.param('id'))
        ? await recordDecision(
            options.db,
            session.workspaceId,
            c.req.param('id'),
            session.userId,
            decision === 'accept' ? 'accepted' : 'dismissed',
          )
        : undefined;
      if (!finding?.reportId) return message(c, 'Not found', 'There is no such finding.', 404);
      return c.redirect(`/review/${finding.reportId}#f-${finding.id}`, 303);
    });
  }

  app.post('/review/:id/comments', async (c) => {
    const session = c.get('session');
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const text = String(body.text ?? '')
      .trim()
      .slice(0, 2000);
    const findingId =
      typeof body.findingId === 'string' && UUID.test(body.findingId) ? body.findingId : null;
    const [report] = UUID.test(id)
      ? await options.db
          .select({ id: schema.reviewReports.id })
          .from(schema.reviewReports)
          .where(
            and(
              eq(schema.reviewReports.id, id),
              eq(schema.reviewReports.workspaceId, session.workspaceId),
            ),
          )
          .limit(1)
      : [];
    if (!report || !text) return c.redirect(`/review/${id}`, 303);
    await options.db.insert(schema.reviewComments).values({
      workspaceId: session.workspaceId,
      reportId: id,
      findingId,
      userId: session.userId,
      text,
    });
    return c.redirect(`/review/${id}${findingId ? `#f-${findingId}` : ''}`, 303);
  });

  // Alerts (W7) and data sources (W8).
  const people = async (workspaceId: string) =>
    Object.fromEntries(
      (
        await options.db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.workspaceId, workspaceId))
      ).map((p) => [p.id, p.name]),
    );

  app.get('/alerts', async (c) => {
    const session = c.get('session');
    const rules = await createAlertStore(options.db, session.workspaceId).list();
    const states = new Map(
      (
        await options.db
          .select()
          .from(schema.alertStates)
          .where(eq(schema.alertStates.workspaceId, session.workspaceId))
      ).map((s) => [s.ruleId, s]),
    );
    const names = await people(session.workspaceId);
    const rows = rules.map((rule) => {
      const state = states.get(rule.id);
      return {
        rule,
        firing: rule.spec.status === 'active' && state?.state === 'firing',
        value: state?.value ?? null,
        ...(rule.approvedBy && names[rule.approvedBy]
          ? { approverName: names[rule.approvedBy]! }
          : {}),
      };
    });
    const notice = c.req.query('notice');
    return c.html(
      <AlertsPage userName={session.name} rows={rows} {...(notice ? { notice } : {})} />,
    );
  });

  app.get('/alerts/:id', async (c) => {
    const session = c.get('session');
    const rule = UUID.test(c.req.param('id'))
      ? await createAlertStore(options.db, session.workspaceId).current(c.req.param('id'))
      : undefined;
    if (!rule)
      return message(c, 'Not found', 'There is no such alert rule.', 404, {
        href: '/alerts',
        label: 'All alerts',
      });
    const error = c.req.query('error');
    return c.html(
      <AlertEditPage userName={session.name} rule={rule} {...(error ? { error } : {})} />,
    );
  });

  app.post('/alerts/:id/approve', async (c) => {
    const session = c.get('session');
    const rule = await createAlertStore(options.db, session.workspaceId).approve(
      c.req.param('id'),
      session.userId,
    );
    return c.redirect(
      `/alerts?notice=${encodeURIComponent(rule ? 'Approved. It is now watched.' : 'No such rule.')}`,
      303,
    );
  });

  app.post('/alerts/:id/discard', async (c) => {
    const session = c.get('session');
    await createAlertStore(options.db, session.workspaceId).disable(
      c.req.param('id'),
      session.userId,
    );
    return c.redirect('/alerts?notice=Switched%20off.', 303);
  });

  app.post('/alerts/:id/edit', async (c) => {
    const session = c.get('session');
    const id = c.req.param('id');
    const store = createAlertStore(options.db, session.workspaceId);
    const rule = UUID.test(id) ? await store.current(id) : undefined;
    if (!rule) return message(c, 'Not found', 'There is no such alert rule.', 404);
    const body = await c.req.parseBody();
    const fail = (error: string) =>
      c.redirect(`/alerts/${id}?error=${encodeURIComponent(error)}`, 303);
    const duration = String(body.for ?? '').trim();
    const channel = String(body.channel ?? '').trim();
    if (!/^[1-9][0-9]*(s|m|h)$/.test(duration))
      return fail('“For” must be a duration such as 30s, 5m or 1h.');
    if (!/^#\S+$/.test(channel)) return fail('The channel must start with #.');
    const change: Parameters<typeof store.edit>[1] = { for: duration, channel };
    if (rule.spec.comparison && rule.spec.query) {
      const shown = Number(String(body.threshold ?? '').replace(',', '.'));
      const scale = Number(body.scale ?? 1) || 1;
      const op = body.op === '<' ? '<' : '>';
      if (!Number.isFinite(shown)) return fail('The threshold must be a number.');
      const threshold = shown / scale;
      change.comparison = { op, threshold };
      change.expr = `(${rule.spec.query}) ${op} ${threshold}`;
      change.name = rule.spec.name.replace(
        / (above|below) .*$/,
        ` ${op === '>' ? 'above' : 'below'} ${shown}${rule.spec.display_unit ? ` ${rule.spec.display_unit}` : ''}`,
      );
    }
    await store.edit(id, change, { kind: 'user', id: session.userId });
    return c.redirect('/alerts?notice=Saved.%20It%20needs%20approving%20again.', 303);
  });

  app.get('/collectors', async (c) => {
    const session = c.get('session');
    const list = await createCollectorStore(options.db, session.workspaceId).list();
    const states = new Map(
      (
        await options.db
          .select()
          .from(schema.collectorStates)
          .where(eq(schema.collectorStates.workspaceId, session.workspaceId))
      ).map((s) => [s.collectorId, s]),
    );
    const rows = list.map((collector) => {
      const state = states.get(collector.id);
      return {
        collector,
        lastRunAt: state?.lastRunAt ?? null,
        lastStatus: state?.lastStatus ?? null,
        lastError: state?.lastError ?? null,
      };
    });
    const notice = c.req.query('notice');
    return c.html(
      <CollectorsPage userName={session.name} rows={rows} {...(notice ? { notice } : {})} />,
    );
  });

  app.get('/collectors/:id', async (c) => {
    const session = c.get('session');
    const collector = UUID.test(c.req.param('id'))
      ? await createCollectorStore(options.db, session.workspaceId).current(c.req.param('id'))
      : undefined;
    if (!collector)
      return message(c, 'Not found', 'There is no such data source.', 404, {
        href: '/collectors',
        label: 'All data sources',
      });
    const error = c.req.query('error');
    return c.html(
      <CollectorEditPage
        userName={session.name}
        collector={collector}
        {...(error ? { error } : {})}
      />,
    );
  });

  app.post('/collectors/:id/approve', async (c) => {
    const session = c.get('session');
    await createCollectorStore(options.db, session.workspaceId).approve(
      c.req.param('id'),
      session.userId,
    );
    return c.redirect('/collectors?notice=Approved.', 303);
  });

  app.post('/collectors/:id/discard', async (c) => {
    const session = c.get('session');
    await createCollectorStore(options.db, session.workspaceId).disable(
      c.req.param('id'),
      session.userId,
    );
    return c.redirect('/collectors?notice=Switched%20off.', 303);
  });

  app.post('/collectors/:id/edit', async (c) => {
    const session = c.get('session');
    const id = c.req.param('id');
    const store = createCollectorStore(options.db, session.workspaceId);
    const collector = UUID.test(id) ? await store.current(id) : undefined;
    if (!collector) return message(c, 'Not found', 'There is no such data source.', 404);
    const body = await c.req.parseBody();
    const url = String(body.url ?? '').trim();
    const interval = String(body.interval ?? '').trim();
    const fail = (error: string) =>
      c.redirect(`/collectors/${id}?error=${encodeURIComponent(error)}`, 303);
    try {
      await assertSafeUrl(url, options.allowPrivateCollectors ?? false);
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'That URL cannot be monitored.');
    }
    if (!/^[1-9][0-9]*(s|m|h)$/.test(interval) || durationToSeconds(interval) < 30) {
      return fail('The interval must be at least 30s, such as 30s, 1m or 5m.');
    }
    await store.edit(
      id,
      { config: { ...collector.spec.config, url }, interval },
      { kind: 'user', id: session.userId },
    );
    return c.redirect('/collectors?notice=Saved.%20It%20needs%20approving%20again.', 303);
  });

  // Memory.
  app.get('/memory', async (c) => {
    const session = c.get('session');
    const entries = await createMemory(options.db, session.workspaceId).list();
    const people = await options.db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.workspaceId, session.workspaceId));
    const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
    const notice = c.req.query('notice');
    return c.html(
      <MemoryPage
        userName={session.name}
        entries={entries}
        names={names}
        {...(notice ? { notice } : {})}
      />,
    );
  });

  app.post('/memory', async (c) => {
    const session = c.get('session');
    const body = await c.req.parseBody();
    const subject = String(body.subject ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (subject && text) {
      await createMemory(options.db, session.workspaceId).write(
        { kind: 'team_decision', subject, text, source: 'memory page' },
        { kind: 'user', id: session.userId },
      );
    }
    return c.redirect('/memory?notice=Added.', 303);
  });

  app.post('/memory/:id', async (c) => {
    const session = c.get('session');
    const body = await c.req.parseBody();
    const text = String(body.text ?? '').trim();
    if (text && UUID.test(c.req.param('id'))) {
      await createMemory(options.db, session.workspaceId).update(c.req.param('id'), { text });
    }
    return c.redirect('/memory?notice=Saved.', 303);
  });

  app.post('/memory/:id/delete', async (c) => {
    const session = c.get('session');
    if (UUID.test(c.req.param('id')))
      await createMemory(options.db, session.workspaceId).remove(c.req.param('id'));
    return c.redirect('/memory?notice=Deleted.', 303);
  });

  return app;
}
