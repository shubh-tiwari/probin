import { timingSafeEqual } from 'node:crypto';
import type { Actor } from '@app/db';
import { UnsafeUrlError } from '@app/ingest';
import { MemoryError } from '@app/memory';
import { PromqlError, analyze, extractNames } from '@app/promql';
import {
  SpecValidationError,
  parseDraftAlertRuleSpec,
  parseDraftCollectorSpec,
  parsePanelSpec,
} from '@app/specs';
import { Hono, type Context } from 'hono';
import type { PlatformBackend } from './backend.js';

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR_KINDS = new Set(['user', 'agent', 'system']);

/** A request the platform refuses, with the status to answer it with. */
class Refused extends Error {
  constructor(
    readonly status: 400 | 404 | 422,
    message: string,
  ) {
    super(message);
  }
}

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const SPEC_PARSERS = {
  panel: parsePanelSpec,
  alert: parseDraftAlertRuleSpec,
  collector: parseDraftCollectorSpec,
} as const;

type Variables = { backend: PlatformBackend };

/**
 * The platform service: catalog search, PromQL analysis, spec validation and
 * the spec, alert, collector and memory stores, over HTTP for the agent.
 *
 * It is internal. Callers prove it with the shared token and name the
 * workspace they act for; every call is scoped to that workspace.
 */
export function createPlatformApp(deps: {
  internalToken: string;
  forWorkspace(workspaceId: string): PlatformBackend;
}) {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/v1/*', async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token || !sameToken(token, deps.internalToken)) {
      return c.json({ error: 'Not an internal caller.' }, 401);
    }
    const workspaceId = c.req.header('x-workspace-id') ?? '';
    if (!WORKSPACE_ID.test(workspaceId)) return c.json({ error: 'A workspace is required.' }, 400);
    c.set('backend', deps.forWorkspace(workspaceId));
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof Refused) return c.json({ error: error.message }, error.status);
    if (error instanceof SpecValidationError || error instanceof MemoryError) {
      return c.json({ error: error.message }, 422);
    }
    if (error instanceof UnsafeUrlError) {
      return c.json({ error: error.message, reason: 'unsafe_url' }, 422);
    }
    console.error(error);
    return c.json({ error: 'Internal error.' }, 500);
  });

  const json = async (c: Context): Promise<Record<string, unknown>> => {
    const body: unknown = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Refused(400, 'The request body must be a JSON object.');
    }
    return body as Record<string, unknown>;
  };
  const text = (value: unknown, name: string) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Refused(400, `"${name}" is required.`);
    }
    return value;
  };
  const actor = (value: unknown): Actor => {
    const a = value as Partial<Actor> | undefined;
    if (!a || !ACTOR_KINDS.has(String(a.kind)) || typeof a.id !== 'string' || a.id === '') {
      throw new Refused(400, '"actor" must be {kind: user|agent|system, id}.');
    }
    return { kind: a.kind!, id: a.id };
  };
  const services = (value: unknown) => {
    if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
      throw new Refused(400, '"services" must be a list of service names.');
    }
    return value as string[];
  };

  app.get('/v1/workspace', async (c) => {
    const workspace = await c.get('backend').workspace();
    if (!workspace) throw new Refused(404, 'No such workspace.');
    return c.json(workspace);
  });

  app.post('/v1/catalog/search', async (c) => {
    const body = await json(c);
    return c.json(
      await c.get('backend').searchCatalog({
        text: typeof body.text === 'string' ? body.text : '',
        ...(typeof body.service === 'string' ? { service: body.service } : {}),
      }),
    );
  });

  app.post('/v1/catalog/resolved', async (c) =>
    c.json(await c.get('backend').resolved(services((await json(c)).services))),
  );

  app.get('/v1/catalog/metrics', async (c) =>
    c.json({ metrics: await c.get('backend').listMetrics(c.req.query('service') || undefined) }),
  );

  /** The names a query uses and its selectors, from the same parser that scopes queries. */
  app.post('/v1/promql/analyze', async (c) => {
    const query = text((await json(c)).query, 'query');
    try {
      return c.json({ ok: true, ...analyze(query), names: extractNames(query) });
    } catch (error) {
      if (error instanceof PromqlError) {
        return c.json({ ok: false, reason: error.reason, error: error.message });
      }
      throw error;
    }
  });

  app.post('/v1/specs/:kind/validate', async (c) => {
    const kind = c.req.param('kind') as keyof typeof SPEC_PARSERS;
    const parse = SPEC_PARSERS[kind];
    if (!parse) throw new Refused(404, 'Specs are panel, alert or collector.');
    return c.json({ spec: parse((await json(c)).spec) });
  });

  app.post('/v1/panels', async (c) => {
    const body = await json(c);
    return c.json(
      await c.get('backend').savePanel(parsePanelSpec(body.spec), actor(body.actor), {
        ...(typeof body.dashboardId === 'string' ? { dashboardId: body.dashboardId } : {}),
        ...(typeof body.panelId === 'string' ? { panelId: body.panelId } : {}),
      }),
    );
  });

  app.get('/v1/panels/:id', async (c) => {
    const panel = await c.get('backend').loadPanel(c.req.param('id'));
    if (!panel) throw new Refused(404, 'No such panel.');
    return c.json(panel);
  });

  app.post('/v1/alerts/draft', async (c) => {
    const body = await json(c);
    return c.json(
      await c.get('backend').draftAlert(parseDraftAlertRuleSpec(body.spec), actor(body.actor)),
    );
  });

  app.get('/v1/alerts/:id', async (c) => {
    const rule = await c.get('backend').alert(c.req.param('id'));
    if (!rule) throw new Refused(404, 'No such alert rule.');
    return c.json(rule);
  });

  app.post('/v1/collectors/draft', async (c) => {
    const body = await json(c);
    return c.json(
      await c.get('backend').draftCollector(parseDraftCollectorSpec(body.spec), actor(body.actor)),
    );
  });

  app.get('/v1/memory/defaults', async (c) =>
    c.json(await c.get('backend').readDefaults(text(c.req.query('user'), 'user'))),
  );

  app.put('/v1/memory/defaults', async (c) => {
    const body = await json(c);
    const defaults = (body.defaults ?? {}) as Record<string, unknown>;
    const saved = await c.get('backend').saveDefaults(
      text(body.user, 'user'),
      {
        ...(typeof defaults.percentile === 'number' ? { percentile: defaults.percentile } : {}),
        ...(defaults.requests === 'all' ||
        defaults.requests === 'failed_only' ||
        defaults.requests === 'successful_only'
          ? { requests: defaults.requests }
          : {}),
      },
      text(body.source, 'source'),
    );
    return c.json({ saved });
  });

  app.post('/v1/memory/incident', async (c) => {
    const body = await json(c);
    await c.get('backend').writeIncident({
      subject: text(body.subject, 'subject'),
      text: text(body.text, 'text'),
      source: text(body.source, 'source'),
      value: body.value ?? null,
    });
    return c.json({ written: true });
  });

  return app;
}
