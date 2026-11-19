import { Hono } from 'hono';
import { bearerKey, hashIngestionKey } from './keys.js';

/** The header the collector reads the workspace from. Set here and nowhere else. */
export const WORKSPACE_HEADER = 'x-workspace-id';

export interface IngestDependencies {
  /** Find the workspace an ingestion key hash belongs to. */
  findWorkspaceId(keyHash: string): Promise<string | undefined>;
  /** Base URL of the collector. Private to this service. */
  collectorUrl: string;
  maxBodyBytes: number;
  /** Store a service manifest in the catalog. Returns what changed. */
  registerManifest(workspaceId: string, manifest: unknown): Promise<unknown>;
  fetch?: typeof fetch;
}

type Variables = { workspaceId: string };

/**
 * The ingestion endpoint. Everything a customer's service sends arrives here.
 *
 * Its one job for metrics is to turn "who holds this key" into "which
 * workspace", and pass that to the collector in a header the sender cannot
 * set. The collector stamps the label from that header, so a service can only
 * ever write into its own workspace.
 */
export function createIngestApp(deps: IngestDependencies) {
  const doFetch = deps.fetch ?? fetch;
  const app = new Hono<{ Variables: Variables }>();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/v1/*', async (c, next) => {
    const key = bearerKey(c.req.header('authorization'));
    if (!key) {
      return c.json({ error: 'Send the ingestion key as "Authorization: Bearer <key>".' }, 401);
    }
    const workspaceId = await deps.findWorkspaceId(hashIngestionKey(key));
    if (!workspaceId) {
      return c.json({ error: 'Unknown ingestion key.' }, 401);
    }
    c.set('workspaceId', workspaceId);
    await next();
  });

  // OTLP over HTTP. The body is forwarded untouched; only the headers change.
  app.post('/v1/metrics', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > deps.maxBodyBytes) {
      return c.json({ error: `Request body is larger than ${deps.maxBodyBytes} bytes.` }, 413);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength > deps.maxBodyBytes) {
      return c.json({ error: `Request body is larger than ${deps.maxBodyBytes} bytes.` }, 413);
    }

    // Build the outgoing headers from scratch. Nothing the sender set is
    // passed on except the two that describe the body.
    const headers = new Headers({ [WORKSPACE_HEADER]: c.get('workspaceId') });
    for (const name of ['content-type', 'content-encoding']) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }

    let upstream: Response;
    try {
      upstream = await doFetch(`${deps.collectorUrl}/v1/metrics`, {
        method: 'POST',
        headers,
        body,
      });
    } catch {
      return c.json({ error: 'The metrics pipeline is unavailable. Retry shortly.' }, 503);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  });

  // Manifest registration: JSON, or the manifest file's YAML as text.
  app.post('/v1/manifests', async (c) => {
    const text = await c.req.text();
    let manifest: unknown;
    if ((c.req.header('content-type') ?? '').includes('json')) {
      try {
        manifest = JSON.parse(text);
      } catch {
        return c.json({ error: 'The body is not valid JSON.' }, 400);
      }
    } else {
      manifest = text;
    }
    try {
      const result = await deps.registerManifest(c.get('workspaceId'), manifest);
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof Error && error.name === 'SpecValidationError') {
        return c.json(
          { error: error.message, issues: (error as { issues?: unknown }).issues },
          422,
        );
      }
      throw error;
    }
  });

  return app;
}
