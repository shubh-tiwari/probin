import type {
  DryRunResult,
  InstantRow,
  QueryErrorBody,
  QueryRequest,
  QueryResult,
} from './types.js';

export type * from './types.js';

/** A query the Query API refused or could not run. */
export class QueryApiError extends Error {
  override name = 'QueryApiError';
  constructor(readonly body: QueryErrorBody) {
    super(body.message);
  }
}

export interface QueryApiClient {
  query(request: QueryRequest): Promise<QueryResult>;
  dryRun(request: QueryRequest): Promise<DryRunResult>;
  instant(query: string): Promise<InstantRow[]>;
  series(selector: string): Promise<Record<string, string>[]>;
  /** The Prometheus API, scoped. Answers with Prometheus's `data`. */
  prom(
    endpoint: 'query' | 'query_range' | 'series' | 'labels' | 'label_values',
    params: [string, string][],
    label?: string,
  ): Promise<unknown>;
  clearCache(): Promise<void>;
  deleteWorkspaceData(): Promise<{ deleted: boolean }>;
  exportWorkspaceData(): Promise<ReadableStream<Uint8Array>>;
}

/**
 * A client for the Query API, bound to one workspace. Other services use this
 * and never hold the metrics store's address.
 */
export function createQueryApiClient(options: {
  url: string;
  internalToken: string;
  workspaceId: string;
  fetch?: typeof fetch;
}): QueryApiClient {
  const doFetch = options.fetch ?? fetch;

  async function post<T>(path: string, payload: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${options.url}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.internalToken}`,
          'content-type': 'application/json',
          'x-workspace-id': options.workspaceId,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new QueryApiError({ code: 'unavailable', message: 'The Query API is unreachable.' });
    }
    const parsed = (await response.json().catch(() => undefined)) as
      { error?: QueryErrorBody } | undefined;
    if (!response.ok) {
      throw new QueryApiError(
        parsed?.error ?? { code: 'unavailable', message: `Query API HTTP ${response.status}` },
      );
    }
    return parsed as T;
  }

  return {
    query: (request) => post<QueryResult>('/v1/query', request),
    dryRun: (request) => post<DryRunResult>('/v1/dry-run', request),
    instant: async (query) =>
      (await post<{ result: InstantRow[] }>('/v1/instant', { query })).result,
    prom: async (endpoint, params, label) =>
      (
        await post<{ data: unknown }>(`/v1/prom/${endpoint}`, {
          params,
          ...(label ? { label } : {}),
        })
      ).data,
    clearCache: async () => {
      await post('/v1/admin/clear-cache', {});
    },
    deleteWorkspaceData: (): Promise<{ deleted: boolean }> =>
      post('/v1/admin/delete-workspace-data', {}),
    async exportWorkspaceData() {
      const response = await doFetch(`${options.url}/v1/admin/export-workspace-data`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.internalToken}`,
          'x-workspace-id': options.workspaceId,
        },
      });
      if (!response.ok || !response.body)
        throw new QueryApiError({ code: 'unavailable', message: 'The export failed.' });
      return response.body;
    },
    series: async (selector) =>
      (await post<{ result: Record<string, string>[] }>('/v1/series', { selector })).result,
  };
}
