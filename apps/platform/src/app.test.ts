import { UnsafeUrlError } from '@app/ingest';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformApp } from './app.js';
import type { PlatformBackend } from './backend.js';

const TOKEN = 'test-internal-token';
const WS = '00000000-0000-4000-8000-000000000001';

const PANEL = {
  title: 'checkout · p95 latency',
  type: 'timeseries',
  query: 'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))',
  unit: 's',
  thresholds: [],
  request: 'latency of checkout',
  assumptions: ['p95'],
};

function fakeBackend(overrides: Partial<PlatformBackend> = {}): PlatformBackend {
  const fail = () => Promise.reject(new Error('not faked'));
  return {
    workspace: async () => ({
      billingStatus: 'trialing',
      trialEndsAt: null,
      alertChannel: '#ops',
      modelBudget: 10,
    }),
    searchCatalog: async (search) => ({
      knownServices: ['checkout'],
      services: search.service ? [search.service] : [],
      metrics: [],
      endpoints: [],
    }),
    resolved: async () => ({ fingerprint: 'abc', names: { metrics: ['m'], labels: ['l'] } }),
    listMetrics: async () => [],
    savePanel: async () => ({ panelId: 'p1', version: 1, dashboardId: 'd1' }),
    loadPanel: async () => undefined,
    draftAlert: fail,
    alert: async () => undefined,
    draftCollector: fail,
    readDefaults: async () => ({ percentile: 99 }),
    saveDefaults: async () => 1,
    writeIncident: async () => undefined,
    ...overrides,
  };
}

/** A response body, for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response): Promise<any> => response.json();

function client(backend: PlatformBackend = fakeBackend()) {
  const forWorkspace = vi.fn(() => backend);
  const app = createPlatformApp({ internalToken: TOKEN, forWorkspace });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-workspace-id': WS,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { call, forWorkspace };
}

describe('platform service', () => {
  it('refuses callers without the internal token, and requests without a workspace', async () => {
    const { call } = client();
    expect(
      (await call('GET', '/v1/workspace', undefined, { authorization: 'Bearer nope' })).status,
    ).toBe(401);
    expect((await call('GET', '/v1/workspace', undefined, { 'x-workspace-id': 'x' })).status).toBe(
      400,
    );
    expect((await call('GET', '/healthz')).status).toBe(200);
  });

  it('scopes every call to the named workspace', async () => {
    const { call, forWorkspace } = client();
    const response = await call('GET', '/v1/workspace');
    expect(await read(response)).toMatchObject({ billingStatus: 'trialing', modelBudget: 10 });
    expect(forWorkspace).toHaveBeenCalledWith(WS);
  });

  it('analyses a query with the parser that scopes queries, and fails closed', async () => {
    const { call } = client();
    const ok = await read(
      await call('POST', '/v1/promql/analyze', {
        query:
          'sum by (http_route) (rate(http_server_request_duration_seconds_count{service_name="checkout"}[5m]))',
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.names.metrics).toEqual(['http_server_request_duration_seconds_count']);
    expect(ok.names.labels).toEqual(['http_route', 'service_name']);
    expect(ok.selectors[0].matchers).toContainEqual(
      expect.objectContaining({ label: 'service_name', value: 'checkout' }),
    );

    const bad = await read(await call('POST', '/v1/promql/analyze', { query: 'sum(' }));
    expect(bad).toMatchObject({ ok: false, reason: 'syntax' });
    const forbidden = await read(await call('POST', '/v1/promql/analyze', { query: 'info(up)' }));
    expect(forbidden).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('validates specs with the shared schemas and their messages', async () => {
    const { call } = client();
    const ok = await call('POST', '/v1/specs/panel/validate', { spec: PANEL });
    expect(ok.status).toBe(200);
    expect((await read(ok)).spec.title).toBe(PANEL.title);

    const bad = await call('POST', '/v1/specs/panel/validate', { spec: { ...PANEL, type: 'pie' } });
    expect(bad.status).toBe(422);
    expect((await read(bad)).error).toMatch(/^Invalid panel spec: type: /);

    expect((await call('POST', '/v1/specs/nope/validate', { spec: {} })).status).toBe(404);
  });

  it('saves a panel only when it is a valid spec, for a named actor', async () => {
    const savePanel = vi.fn(async () => ({ panelId: 'p1', version: 2, dashboardId: 'd1' }));
    const { call } = client(fakeBackend({ savePanel }));
    const saved = await call('POST', '/v1/panels', {
      spec: PANEL,
      actor: { kind: 'user', id: 'U1' },
      panelId: 'p1',
    });
    expect(await read(saved)).toEqual({ panelId: 'p1', version: 2, dashboardId: 'd1' });
    expect(savePanel).toHaveBeenCalledWith(
      expect.objectContaining({ title: PANEL.title }),
      {
        kind: 'user',
        id: 'U1',
      },
      { panelId: 'p1' },
    );

    expect(
      (await call('POST', '/v1/panels', { spec: PANEL, actor: { kind: 'robot', id: 'x' } })).status,
    ).toBe(400);
    expect(
      (await call('POST', '/v1/panels', { spec: {}, actor: { kind: 'user', id: 'U1' } })).status,
    ).toBe(422);
  });

  it('answers 404 for a missing panel or alert rule', async () => {
    const { call } = client();
    expect((await call('GET', '/v1/panels/x')).status).toBe(404);
    expect((await call('GET', '/v1/alerts/x')).status).toBe(404);
  });

  it('reports an unsafe collector URL as such, without writing anything', async () => {
    const draftCollector = vi.fn(async () => {
      throw new UnsafeUrlError('That address is on a private network.');
    });
    const { call } = client(fakeBackend({ draftCollector }));
    const response = await call('POST', '/v1/collectors/draft', {
      spec: {
        name: 'uptime',
        source_type: 'http_check',
        config: { url: 'http://169.254.169.254/' },
        interval: '1m',
        metric_names: ['http_check_up'],
        status: 'pending',
      },
      actor: { kind: 'user', id: 'U1' },
    });
    expect(response.status).toBe(422);
    expect(await read(response)).toMatchObject({ reason: 'unsafe_url' });
  });

  it('reads and saves a person’s default answers', async () => {
    const saveDefaults = vi.fn(async () => 1);
    const { call } = client(fakeBackend({ saveDefaults }));
    expect(await read(await call('GET', '/v1/memory/defaults?user=U1'))).toEqual({
      percentile: 99,
    });
    const saved = await call('PUT', '/v1/memory/defaults', {
      user: 'U1',
      defaults: { percentile: 95, requests: 'bogus' },
      source: 'request r1',
    });
    expect(await read(saved)).toEqual({ saved: 1 });
    expect(saveDefaults).toHaveBeenCalledWith('U1', { percentile: 95 }, 'request r1');
  });
});
