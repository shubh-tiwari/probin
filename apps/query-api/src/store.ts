import type { MetricsStoreType } from '@app/config';
import type { QueryErrorCode } from './types.js';

export class StoreError extends Error {
  override name = 'StoreError';
  constructor(
    readonly code: Extract<QueryErrorCode, 'timeout' | 'rejected' | 'unavailable'>,
    message: string,
  ) {
    super(message);
  }
}

export interface StoreScope {
  /** The label every query is scoped to, already written into the query text. */
  label: string;
  value: string;
}

export interface RawSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

export interface MetricsStore {
  /** A Prometheus API call, answered as the store answers it (`data` of a success). For Grafana and the connector. */
  raw(path: string, params: [string, string][], scope: StoreScope | null): Promise<unknown>;
  /** Every sample of the series matching a selector, as JSON lines (VictoriaMetrics' export format). */
  exportSeries(selector: string): Promise<ReadableStream<Uint8Array>>;
  /** Delete every series matching a selector. Hosted store only. */
  deleteSeries(selector: string): Promise<void>;
  queryRange(
    query: string,
    window: { start: number; end: number; step: number },
    scope: StoreScope | null,
  ): Promise<RawSeries[]>;
  queryInstant(query: string, scope: StoreScope | null): Promise<RawSeries[]>;
  series(
    selector: string,
    window: { start: number; end: number },
    scope: StoreScope | null,
  ): Promise<Record<string, string>[]>;
}

interface PrometheusResponse {
  status: 'success' | 'error';
  errorType?: string;
  error?: string;
  data?: unknown;
}

/**
 * The only code that talks to the metrics store. It uses the
 * Prometheus-compatible HTTP API and nothing else, so VictoriaMetrics and
 * Prometheus are interchangeable.
 *
 * Queries arrive here already rewritten to their workspace. For
 * VictoriaMetrics the scope is sent a second time as `extra_label`, which the
 * store itself enforces on every selector: a second lock, in case the rewrite
 * ever has a gap.
 */
export function createMetricsStore(options: {
  url: string;
  type: MetricsStoreType;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Sent as `Authorization: Bearer …`, for a customer's own store. */
  bearerToken?: string;
}): MetricsStore {
  const doFetch = options.fetch ?? fetch;
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));

  async function call(path: string, params: [string, string][], scope: StoreScope | null) {
    const body = new URLSearchParams(params);
    if (scope && options.type === 'victoriametrics') {
      body.append('extra_label', `${scope.label}=${scope.value}`);
      // Without this the store rounds a range query's start and end down to
      // the step, which hides the newest data: up to an hour on a 7 day chart.
      // Results are cached in this service instead.
      body.append('nocache', '1');
    }
    let response: Response;
    try {
      response = await doFetch(`${options.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
        },
        body,
        // A little longer than the store's own limit, so its error wins when it has one.
        signal: AbortSignal.timeout(options.timeoutMs + 1000),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new StoreError('timeout', `The query ran longer than ${timeoutSeconds}s.`);
      }
      throw new StoreError('unavailable', 'The metrics store could not be reached.');
    }

    let payload: PrometheusResponse | undefined;
    try {
      payload = (await response.json()) as PrometheusResponse;
    } catch {
      payload = undefined;
    }
    if (response.ok && payload?.status === 'success') return payload.data;

    const detail = payload?.error ?? `HTTP ${response.status}`;
    if (payload?.errorType === 'timeout' || /timeout|deadline exceeded/i.test(detail)) {
      throw new StoreError('timeout', `The query ran longer than ${timeoutSeconds}s.`);
    }
    if (response.status === 400 || response.status === 422) {
      throw new StoreError('rejected', `The store rejected the query: ${detail}`);
    }
    throw new StoreError('unavailable', `The metrics store failed: ${detail}`);
  }

  const matrix = (data: unknown): RawSeries[] => {
    const result = (data as { resultType?: string; result?: unknown[] }) ?? {};
    if (result.resultType === 'matrix') return result.result as RawSeries[];
    if (result.resultType === 'vector') {
      return (result.result as { metric: Record<string, string>; value: [number, string] }[]).map(
        (row) => ({ metric: row.metric, values: [row.value] }),
      );
    }
    if (result.resultType === 'scalar') {
      return [{ metric: {}, values: [result.result as unknown as [number, string]] }];
    }
    return [];
  };

  return {
    raw: (path, params, scope) => call(path, params, scope),
    async exportSeries(selector) {
      const response = await doFetch(`${options.url}/api/v1/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['match[]', selector]]),
      });
      if (!response.ok || !response.body)
        throw new StoreError('unavailable', `Export failed: HTTP ${response.status}`);
      return response.body;
    },
    async deleteSeries(selector) {
      const path =
        options.type === 'victoriametrics'
          ? '/api/v1/admin/tsdb/delete_series'
          : '/api/v1/admin/tsdb/delete_series';
      const response = await doFetch(`${options.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['match[]', selector]]),
      });
      if (!response.ok && response.status !== 204) {
        throw new StoreError('unavailable', `Deleting series failed: HTTP ${response.status}`);
      }
    },
    async queryRange(query, window, scope) {
      const data = await call(
        '/api/v1/query_range',
        [
          ['query', query],
          ['start', String(window.start)],
          ['end', String(window.end)],
          ['step', String(window.step)],
          ['timeout', `${timeoutSeconds}s`],
        ],
        scope,
      );
      return matrix(data);
    },
    async queryInstant(query, scope) {
      const data = await call(
        '/api/v1/query',
        [
          ['query', query],
          ['timeout', `${timeoutSeconds}s`],
        ],
        scope,
      );
      return matrix(data);
    },
    async series(selector, window, scope) {
      const data = await call(
        '/api/v1/series',
        [
          ['match[]', selector],
          ['start', String(window.start)],
          ['end', String(window.end)],
        ],
        scope,
      );
      return (data as Record<string, string>[]) ?? [];
    },
  };
}
