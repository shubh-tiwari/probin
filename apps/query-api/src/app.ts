import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { QueryError, type PromEndpoint, type QueryService } from './service.js';
import type { QueryErrorCode } from './types.js';

export const WORKSPACE_HEADER = 'x-workspace-id';

const STATUS: Record<QueryErrorCode, 400 | 403 | 422 | 502 | 504> = {
  invalid_query: 400,
  forbidden: 403,
  too_many_lines: 422,
  rejected: 422,
  timeout: 504,
  unavailable: 502,
};

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

type Variables = { workspaceId: string };

/**
 * The Query API's HTTP surface. It is internal: callers are our own services,
 * which prove it with a shared token and say which workspace they act for.
 * People sign in at the Slack app and web tool, not here.
 */
export function createQueryApp(deps: { service: QueryService; internalToken: string }) {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/v1/*', async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token || !sameToken(token, deps.internalToken)) {
      return c.json({ error: { code: 'forbidden', message: 'Not an internal caller.' } }, 401);
    }
    const workspaceId = c.req.header(WORKSPACE_HEADER);
    if (!workspaceId) {
      return c.json({ error: { code: 'forbidden', message: 'A workspace is required.' } }, 400);
    }
    c.set('workspaceId', workspaceId);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof QueryError) {
      return c.json({ error: error.toBody() }, STATUS[error.code]);
    }
    console.error(error);
    return c.json({ error: { code: 'unavailable', message: 'Internal error.' } }, 500);
  });

  const body = async (c: { req: { json(): Promise<unknown> } }) => {
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new QueryError('invalid_query', 'The request body must be a JSON object.');
  };
  const text = (value: unknown, name: string) => {
    if (typeof value !== 'string' || value === '') {
      throw new QueryError('invalid_query', `"${name}" is required.`);
    }
    return value;
  };

  app.post('/v1/query', async (c) => {
    const input = await body(c);
    const result = await deps.service.run(c.get('workspaceId'), {
      query: text(input.query, 'query'),
      range: text(input.range, 'range'),
      ...(typeof input.step === 'number' ? { step: input.step } : {}),
      ...(typeof input.end === 'number' ? { end: input.end } : {}),
    });
    return c.json(result);
  });

  app.post('/v1/dry-run', async (c) => {
    const input = await body(c);
    const result = await deps.service.dryRun(c.get('workspaceId'), {
      query: text(input.query, 'query'),
      range: text(input.range, 'range'),
    });
    return c.json(result);
  });

  app.post('/v1/instant', async (c) => {
    const input = await body(c);
    return c.json({
      result: await deps.service.instant(c.get('workspaceId'), text(input.query, 'query')),
    });
  });

  app.post('/v1/prom/:endpoint', async (c) => {
    const endpoint = c.req.param('endpoint');
    if (!['query', 'query_range', 'series', 'labels', 'label_values'].includes(endpoint)) {
      throw new QueryError('invalid_query', 'Unknown endpoint.');
    }
    const input = await body(c);
    const params = Array.isArray(input.params)
      ? (input.params as unknown[]).filter(
          (p): p is [string, string] =>
            Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string'),
        )
      : [];
    const data = await deps.service.prom(
      c.get('workspaceId'),
      endpoint as PromEndpoint,
      params,
      typeof input.label === 'string' ? input.label : undefined,
    );
    return c.json({ status: 'success', data });
  });

  app.post('/v1/admin/export-workspace-data', async (c) => {
    const stream = await deps.service.exportWorkspaceData(c.get('workspaceId'));
    if (!stream)
      return c.json(
        { error: { code: 'forbidden', message: 'Metrics in your own store are not exported.' } },
        400,
      );
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
  });

  app.post('/v1/admin/clear-cache', (c) => {
    deps.service.clearCache(c.get('workspaceId'));
    return c.json({ cleared: true });
  });

  app.post('/v1/admin/delete-workspace-data', async (c) =>
    c.json(await deps.service.deleteWorkspaceData(c.get('workspaceId'))),
  );

  app.post('/v1/series', async (c) => {
    const input = await body(c);
    return c.json({
      result: await deps.service.series(c.get('workspaceId'), text(input.selector, 'selector')),
    });
  });

  return app;
}
