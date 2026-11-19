import { describe, expect, it, vi } from 'vitest';
import { createQueryApp } from './app.js';
import { createResultCache } from './cache.js';
import { QueryError, chooseStep, createQueryService } from './service.js';
import { StoreError, createMetricsStore, type MetricsStore, type RawSeries } from './store.js';

const A = '0b3f1d5e-6a57-4c1b-9d0a-2f8f3f1c9a10';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function fakeStore(
  series: RawSeries[] = [{ metric: { job: 'x', workspace: A }, values: [[100, '1.5']] }],
) {
  const store = {
    queryRange: vi.fn<MetricsStore['queryRange']>(async () => series),
    queryInstant: vi.fn<MetricsStore['queryInstant']>(async () => series),
    series: vi.fn<MetricsStore['series']>(async () => series.map((one) => one.metric)),
    raw: vi.fn<MetricsStore['raw']>(async (path) =>
      path === '/api/v1/labels'
        ? ['__name__', 'job', 'workspace']
        : {
            resultType: 'vector',
            result: series.map((s) => ({ metric: s.metric, value: s.values[0] })),
          },
    ),
    deleteSeries: vi.fn<MetricsStore['deleteSeries']>(async () => undefined),
    exportSeries: vi.fn<MetricsStore['exportSeries']>(async () => new Blob(['{}\n']).stream()),
  } satisfies MetricsStore;
  return store;
}

function setup(options: { series?: RawSeries[]; maxLines?: number; cacheTtlMs?: number } = {}) {
  let time = 1_700_000_000_000;
  const store = fakeStore(options.series);
  const service = createQueryService({
    store,
    maxLines: options.maxLines ?? 50,
    cacheTtlMs: options.cacheTtlMs ?? 15_000,
    now: () => time,
  });
  return { store, service, advance: (ms: number) => (time += ms) };
}

describe('workspace isolation', () => {
  it('scopes the query text and tells the store the scope before anything runs', async () => {
    const { service, store } = setup();
    await service.run(A, { query: 'sum(rate(up[5m])) / count(other)', range: '1h' });
    const [query, , scope] = store.queryRange.mock.calls[0]!;
    expect(query).toBe(`sum(rate(up{workspace="${A}"}[5m])) / count(other{workspace="${A}"})`);
    expect(scope).toEqual({ label: 'workspace', value: A });
  });

  it.each([
    `up{workspace="${B}"}`,
    'up{workspace=~".+"}',
    'sum by (workspace) (up)',
    `up or up{workspace="${B}"}`,
    'label_replace(up, "workspace", "x", "job", ".*")',
    'info(up)',
  ])('refuses %s without calling the store', async (query) => {
    const { service, store } = setup();
    await expect(service.run(A, { query, range: '1h' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.instant(A, query)).rejects.toMatchObject({ code: 'forbidden' });
    expect(store.queryRange).not.toHaveBeenCalled();
    expect(store.queryInstant).not.toHaveBeenCalled();
  });

  it('refuses a workspace id that is not one', async () => {
    const { service, store } = setup();
    for (const id of ['', 'dev', `${A}"} or up{x="`, '*']) {
      await expect(service.run(id, { query: 'up', range: '1h' })).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
    expect(store.queryRange).not.toHaveBeenCalled();
  });

  it('scopes series lookups and instant queries the same way', async () => {
    const { service, store } = setup();
    await service.series(A, '{service_name!=""}');
    await service.instant(A, 'up');
    expect(store.series.mock.calls[0]![0]).toBe(`{workspace="${A}",service_name!=""}`);
    expect(store.queryInstant.mock.calls[0]![0]).toBe(`up{workspace="${A}"}`);
  });

  it('never returns the workspace label to the caller', async () => {
    const { service } = setup();
    const result = await service.run(A, { query: 'up', range: '1h' });
    expect(result.series[0]!.labels).toEqual({ job: 'x' });
    expect(await service.series(A, 'up')).toEqual([{ job: 'x' }]);
  });

  it('a cached result is never served to another workspace', async () => {
    const { service, store } = setup();
    await service.run(A, { query: 'up', range: '1h' });
    const other = await service.run(B, { query: 'up', range: '1h' });
    expect(other.cached).toBe(false);
    expect(store.queryRange).toHaveBeenCalledTimes(2);
    expect(store.queryRange.mock.calls[1]![0]).toBe(`up{workspace="${B}"}`);
  });
});

describe('limits', () => {
  it('refuses a result over the line cap and says how many lines there were', async () => {
    const series = Array.from({ length: 7 }, (_, i) => ({
      metric: { n: String(i) },
      values: [[100, '1']] as [number, string][],
    }));
    const { service } = setup({ series, maxLines: 5 });
    await expect(service.run(A, { query: 'up', range: '1h' })).rejects.toMatchObject({
      code: 'too_many_lines',
      lineCount: 7,
    });
  });

  it('reports a timeout from the store as a timeout', async () => {
    const { service, store } = setup();
    store.queryRange.mockRejectedValueOnce(
      new StoreError('timeout', 'The query ran longer than 10s.'),
    );
    await expect(service.run(A, { query: 'up', range: '1h' })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('sends the time limit to the store', async () => {
    const calls: URLSearchParams[] = [];
    const store = createMetricsStore({
      url: 'http://store',
      type: 'victoriametrics',
      timeoutMs: 7000,
      fetch: (async (_url: string, init: RequestInit) => {
        calls.push(init.body as URLSearchParams);
        return Response.json({ status: 'success', data: { resultType: 'matrix', result: [] } });
      }) as unknown as typeof fetch,
    });
    await store.queryRange('up', { start: 0, end: 60, step: 15 }, { label: 'workspace', value: A });
    expect(calls[0]!.get('timeout')).toBe('7s');
    expect(calls[0]!.get('extra_label')).toBe(`workspace=${A}`);
    expect(calls[0]!.get('nocache')).toBe('1');
  });

  it('does not send the VictoriaMetrics-only scope parameter to Prometheus', async () => {
    const calls: URLSearchParams[] = [];
    const store = createMetricsStore({
      url: 'http://store',
      type: 'prometheus',
      timeoutMs: 7000,
      fetch: (async (_url: string, init: RequestInit) => {
        calls.push(init.body as URLSearchParams);
        return Response.json({ status: 'success', data: { resultType: 'vector', result: [] } });
      }) as unknown as typeof fetch,
    });
    await store.queryInstant('up', { label: 'workspace', value: A });
    expect(calls[0]!.has('extra_label')).toBe(false);
  });

  it('turns a store rejection into a readable error', async () => {
    const store = createMetricsStore({
      url: 'http://store',
      type: 'victoriametrics',
      timeoutMs: 1000,
      fetch: (async () =>
        Response.json(
          { status: 'error', errorType: 'bad_data', error: 'expected type range vector' },
          { status: 422 },
        )) as unknown as typeof fetch,
    });
    await expect(store.queryInstant('up', { label: 'workspace', value: A })).rejects.toMatchObject({
      code: 'rejected',
      message: expect.stringContaining('range vector'),
    });
  });
});

describe('result cache', () => {
  it('serves a repeat within the lifetime from the cache, then refetches', async () => {
    const { service, store, advance } = setup({ cacheTtlMs: 15_000 });
    const first = await service.run(A, { query: 'up', range: '1h' });
    const second = await service.run(A, { query: 'up', range: '1h' });
    expect([first.cached, second.cached]).toEqual([false, true]);
    expect(store.queryRange).toHaveBeenCalledTimes(1);
    advance(16_000);
    expect((await service.run(A, { query: 'up', range: '1h' })).cached).toBe(false);
    expect(store.queryRange).toHaveBeenCalledTimes(2);
  });

  it('keys on query, range and step', async () => {
    const { service, store } = setup();
    await service.run(A, { query: 'up', range: '1h' });
    await service.run(A, { query: 'up', range: '2h' });
    await service.run(A, { query: 'up', range: '1h', step: 60 });
    await service.run(A, { query: 'up{job="x"}', range: '1h' });
    expect(store.queryRange).toHaveBeenCalledTimes(4);
  });

  it('can drop one workspace without touching another', () => {
    const cache = createResultCache<number>({ ttlMs: 1000 });
    cache.set(A, 'k', 1);
    cache.set(B, 'k', 2);
    cache.clear(A);
    expect(cache.get(A, 'k')).toBeUndefined();
    expect(cache.get(B, 'k')).toBe(2);
  });

  it('evicts the oldest entry when full', () => {
    const cache = createResultCache<number>({ ttlMs: 1000, maxEntries: 2 });
    cache.set(A, '1', 1);
    cache.set(A, '2', 2);
    cache.set(A, '3', 3);
    expect(cache.get(A, '1')).toBeUndefined();
    expect(cache.get(A, '3')).toBe(3);
  });
});

describe('dry run', () => {
  it('summarises a good query', async () => {
    const { service } = setup({
      series: [
        {
          metric: { job: 'x' },
          values: [
            [100, '1'],
            [115, '3'],
            [130, '2'],
          ],
        },
      ],
    });
    expect(await service.dryRun(A, { query: 'up', range: '1h' })).toMatchObject({
      ok: true,
      lineCount: 1,
      sample: [{ labels: { job: 'x' }, points: 3, first: 1, last: 2, min: 1, max: 3 }],
    });
  });

  it('reports a bad query instead of throwing', async () => {
    const { service } = setup();
    expect(await service.dryRun(A, { query: 'up{', range: '1h' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_query' },
    });
    expect(await service.dryRun(A, { query: 'up', range: 'forever' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_query' },
    });
  });

  it('reports an empty result as zero lines', async () => {
    const { service } = setup({ series: [] });
    expect(await service.dryRun(A, { query: 'up', range: '1h' })).toMatchObject({
      ok: true,
      lineCount: 0,
    });
  });
});

describe('time window', () => {
  it('ends now, whatever the step, so the newest data is never cut off', async () => {
    const { service, store } = setup();
    await service.run(A, { query: 'up', range: '7d' });
    const window = store.queryRange.mock.calls[0]![1];
    expect(window).toEqual({ start: 1_700_000_000 - 7 * 86_400, end: 1_700_000_000, step: 3600 });
  });
});

describe('explicit end', () => {
  it('evaluates the window as of the time given, and caches it separately', async () => {
    const { service, store } = setup();
    await service.run(A, { query: 'up', range: '1h', end: 1_600_000_000 });
    await service.run(A, { query: 'up', range: '1h' });
    expect(store.queryRange.mock.calls[0]![1]).toMatchObject({
      start: 1_599_996_400,
      end: 1_600_000_000,
    });
    expect(store.queryRange).toHaveBeenCalledTimes(2);
  });
});

describe('step', () => {
  it.each([
    [300, 15],
    [3600, 15],
    [5 * 3600, 120],
    [24 * 3600, 600],
    [7 * 86_400, 3600],
  ])('a range of %i seconds uses a %i second step', (range, step) => {
    expect(chooseStep(range)).toBe(step);
  });
});

describe('HTTP', () => {
  const token = 'internal-token-for-tests';
  const app = () => createQueryApp({ service: setup().service, internalToken: token });
  const post = (headers: Record<string, string>, body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  it('refuses callers without the internal token', async () => {
    const response = await app().request(
      '/v1/query',
      post({ 'x-workspace-id': A }, { query: 'up', range: '1h' }),
    );
    expect(response.status).toBe(401);
    const wrong = await app().request(
      '/v1/query',
      post({ authorization: 'Bearer nope', 'x-workspace-id': A }, { query: 'up', range: '1h' }),
    );
    expect(wrong.status).toBe(401);
  });

  it('needs a workspace', async () => {
    const response = await app().request(
      '/v1/query',
      post({ authorization: `Bearer ${token}` }, { query: 'up', range: '1h' }),
    );
    expect(response.status).toBe(400);
  });

  it('maps errors to statuses with a code the caller can branch on', async () => {
    const headers = { authorization: `Bearer ${token}`, 'x-workspace-id': A };
    const forbidden = await app().request(
      '/v1/query',
      post(headers, { query: 'up{workspace="x"}', range: '1h' }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });
    const invalid = await app().request('/v1/query', post(headers, { query: 'up{', range: '1h' }));
    expect(invalid.status).toBe(400);
    const ok = await app().request('/v1/query', post(headers, { query: 'up', range: '1h' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ lineCount: 1, cached: false });
  });
});

it('QueryError carries its code', () => {
  expect(new QueryError('timeout', 'slow').toBody()).toEqual({ code: 'timeout', message: 'slow' });
});

describe('per-workspace stores', () => {
  it('sends a customer’s own store the query unchanged, and nothing to the hosted store', async () => {
    const hosted = fakeStore();
    const own = fakeStore([{ metric: { job: 'theirs' }, values: [[1, '2']] }]);
    const service = createQueryService({
      store: hosted,
      maxLines: 50,
      cacheTtlMs: 0,
      workspaceStore: async (id) => (id === A ? { store: own, external: true } : undefined),
    });
    await service.run(A, { query: 'up', range: '1h' });
    expect(own.queryRange.mock.calls[0]![0]).toBe('up');
    expect(own.queryRange.mock.calls[0]![2]).toBeNull();
    expect(hosted.queryRange).not.toHaveBeenCalled();
    await service.run(B, { query: 'up', range: '1h' });
    expect(hosted.queryRange.mock.calls[0]![0]).toBe(`up{workspace="${B}"}`);
  });

  it('still refuses invalid queries for a customer’s own store', async () => {
    const service = createQueryService({
      store: fakeStore(),
      maxLines: 50,
      cacheTtlMs: 0,
      workspaceStore: async () => ({ store: fakeStore(), external: true }),
    });
    await expect(service.run(A, { query: 'up{', range: '1h' })).rejects.toMatchObject({
      code: 'invalid_query',
    });
  });

  it('refuses a range longer than the plan keeps', async () => {
    const service = createQueryService({
      store: fakeStore(),
      maxLines: 50,
      cacheTtlMs: 0,
      workspaceStore: async () => ({ store: fakeStore(), external: false, retentionDays: 7 }),
    });
    await expect(service.run(A, { query: 'up', range: '30d' })).rejects.toMatchObject({
      message: expect.stringContaining('keeps 7 days'),
    });
    await expect(service.run(A, { query: 'up', range: '7d' })).resolves.toBeDefined();
  });

  it('never deletes from a customer’s own store', async () => {
    const own = fakeStore();
    const service = createQueryService({
      store: fakeStore(),
      maxLines: 50,
      cacheTtlMs: 0,
      workspaceStore: async () => ({ store: own, external: true }),
    });
    expect(await service.deleteWorkspaceData(A)).toEqual({ deleted: false });
    expect(own.deleteSeries).not.toHaveBeenCalled();
  });

  it('deletes exactly one workspace’s series from the hosted store', async () => {
    const { service, store } = setup();
    expect(await service.deleteWorkspaceData(A)).toEqual({ deleted: true });
    expect(store.deleteSeries).toHaveBeenCalledWith(`{workspace="${A}"}`);
  });
});

describe('Prometheus API for Grafana and the connector', () => {
  it('scopes query and match[], and removes the workspace label from answers', async () => {
    const { service, store } = setup();
    const data = (await service.prom(A, 'query', [
      ['query', 'up'],
      ['time', '100'],
      ['evil', 'x'],
    ])) as { result: { metric: Record<string, string> }[] };
    expect(store.raw.mock.calls[0]).toEqual([
      '/api/v1/query',
      [
        ['query', `up{workspace="${A}"}`],
        ['time', '100'],
      ],
      { label: 'workspace', value: A },
    ]);
    expect(data.result[0]!.metric).toEqual({ job: 'x' });
    expect(await service.prom(A, 'labels', [])).toEqual(['__name__', 'job']);
    expect(store.raw.mock.calls[1]![1]).toEqual([['match[]', `{workspace="${A}"}`]]);
  });

  it('refuses a hostile query and listing the workspace label', async () => {
    const { service } = setup();
    await expect(
      service.prom(A, 'query', [['query', 'up{workspace="other"}']]),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.prom(A, 'label_values', [], 'workspace')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
