import { PromqlError, analyze, injectLabel } from '@app/promql';
import { durationToSeconds } from '@app/specs';
import { createResultCache, type ResultCache } from './cache.js';
import { StoreError, type MetricsStore, type RawSeries } from './store.js';
import type {
  DryRunResult,
  InstantRow,
  QueryErrorBody,
  QueryErrorCode,
  QueryRequest,
  QueryResult,
  Series,
  SeriesSummary,
} from './types.js';

/** The label that scopes every sample to a workspace. Set at ingestion, required on every query. */
export const WORKSPACE_LABEL = 'workspace';

export class QueryError extends Error {
  override name = 'QueryError';
  constructor(
    readonly code: QueryErrorCode,
    message: string,
    readonly lineCount?: number,
  ) {
    super(message);
  }
  toBody(): QueryErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.lineCount === undefined ? {} : { lineCount: this.lineCount }),
    };
  }
}

/** Which store serves a workspace, and its plan's retention. */
export interface WorkspaceStore {
  store: MetricsStore;
  /** A customer's own store: their data only, so no workspace label to add. Read-only. */
  external: boolean;
  /** How many days of data the plan keeps. Longer ranges are refused. */
  retentionDays?: number;
}

export interface QueryServiceOptions {
  /** The store for a workspace. Unset, or undefined for a workspace: the hosted store, no retention limit. */
  workspaceStore?: (workspaceId: string) => Promise<WorkspaceStore | undefined>;
  store: MetricsStore;
  /** Line cap: the most series one query may return. */
  maxLines: number;
  cacheTtlMs: number;
  /** Series lookups (catalog sync) look this far back. */
  seriesLookbackSeconds?: number;
  now?: () => number;
  cache?: ResultCache<QueryResult>;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** About 240 points across the range, on a round step, never finer than 15 seconds. */
export function chooseStep(rangeSeconds: number): number {
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400];
  const ideal = rangeSeconds / 240;
  return steps.find((step) => step >= ideal) ?? 86_400;
}

const toSeries = (raw: RawSeries): Series => {
  const labels = { ...raw.metric };
  delete labels[WORKSPACE_LABEL];
  const points: [number, number][] = [];
  for (const [time, value] of raw.values) {
    const number = Number(value);
    if (Number.isFinite(number)) points.push([time, number]);
  }
  return { labels, points };
};

const summarise = (series: Series): SeriesSummary => {
  const values = series.points.map((point) => point[1]);
  return {
    labels: series.labels,
    points: values.length,
    first: values[0] ?? null,
    last: values.at(-1) ?? null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
  };
};

/**
 * Runs queries for one workspace at a time. Every path through this class
 * scopes the query to the workspace before the store sees it; there is no
 * method that takes a query and runs it unscoped.
 */
export function createQueryService(options: QueryServiceOptions) {
  const now = options.now ?? Date.now;
  const cache = options.cache ?? createResultCache<QueryResult>({ ttlMs: options.cacheTtlMs, now });
  const lookback = options.seriesLookbackSeconds ?? 900;

  async function resolve(workspaceId: string): Promise<WorkspaceStore> {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new QueryError('forbidden', 'A query needs a valid workspace.');
    }
    return (
      (await options.workspaceStore?.(workspaceId)) ?? { store: options.store, external: false }
    );
  }

  /**
   * Returns the query rewritten to the workspace, or throws a QueryError.
   * A customer's own store holds only their data, so the query is checked but
   * not rewritten.
   */
  function scope(workspaceId: string, query: string, external = false) {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new QueryError('forbidden', 'A query needs a valid workspace.');
    }
    try {
      if (external) {
        analyze(query);
        return { query, scope: null };
      }
      return {
        query: injectLabel(query, WORKSPACE_LABEL, workspaceId),
        scope: { label: WORKSPACE_LABEL, value: workspaceId },
      };
    } catch (error) {
      if (error instanceof PromqlError) {
        throw new QueryError(
          error.reason === 'syntax' ? 'invalid_query' : 'forbidden',
          error.message,
        );
      }
      throw error;
    }
  }

  const fromStore = (error: unknown): never => {
    if (error instanceof StoreError) throw new QueryError(error.code, error.message);
    throw error;
  };

  async function run(workspaceId: string, request: QueryRequest): Promise<QueryResult> {
    const target = await resolve(workspaceId);
    const scoped = scope(workspaceId, request.query, target.external);
    let rangeSeconds: number;
    try {
      rangeSeconds = durationToSeconds(request.range);
    } catch {
      throw new QueryError('invalid_query', `"${request.range}" is not a range such as 30m or 5h.`);
    }
    if (target.retentionDays !== undefined && rangeSeconds > target.retentionDays * 86_400) {
      throw new QueryError(
        'invalid_query',
        `Your plan keeps ${target.retentionDays} days of data. Choose a shorter range.`,
      );
    }
    const step = request.step ?? chooseStep(rangeSeconds);
    if (!Number.isFinite(step) || step <= 0) {
      throw new QueryError('invalid_query', 'The step must be a positive number of seconds.');
    }

    if (request.end !== undefined && !(Number.isFinite(request.end) && request.end > 0)) {
      throw new QueryError('invalid_query', 'The end must be a time in unix seconds.');
    }
    const key = JSON.stringify([request.query, request.range, step, request.end ?? null]);
    const hit = cache.get(workspaceId, key);
    if (hit) return { ...hit, cached: true };

    // The window ends now, so the newest data is always in it. (Rounding the
    // end down to the step would hide up to a whole step: an hour on a 7 day
    // chart.) Repeat requests inside the cache lifetime share one result.
    const end = Math.floor(request.end ?? now() / 1000);
    const start = end - rangeSeconds;
    const started = now();
    const raw = await target.store
      .queryRange(scoped.query, { start, end, step }, scoped.scope)
      .catch(fromStore);
    const durationMs = now() - started;

    if (raw.length > options.maxLines) {
      throw new QueryError(
        'too_many_lines',
        `The query returns ${raw.length} lines; the limit is ${options.maxLines}. Aggregate or filter it.`,
        raw.length,
      );
    }
    const result: QueryResult = {
      series: raw.map(toSeries),
      start,
      end,
      step,
      lineCount: raw.length,
      durationMs,
      cached: false,
    };
    cache.set(workspaceId, key, result);
    return result;
  }

  return {
    run,

    /** Run a query to judge it: never throws for a bad query, reports it instead. */
    async dryRun(workspaceId: string, request: QueryRequest): Promise<DryRunResult> {
      const started = now();
      try {
        const result = await run(workspaceId, request);
        return {
          ok: true,
          lineCount: result.lineCount,
          durationMs: result.durationMs,
          sample: result.series.slice(0, 5).map(summarise),
        };
      } catch (error) {
        if (!(error instanceof QueryError)) throw error;
        return {
          ok: false,
          lineCount: error.lineCount ?? 0,
          durationMs: now() - started,
          sample: [],
          error: error.toBody(),
        };
      }
    },

    /** An instant query, for catalog sync. Scoped like every other query. */
    async instant(workspaceId: string, query: string): Promise<InstantRow[]> {
      const target = await resolve(workspaceId);
      const scoped = scope(workspaceId, query, target.external);
      const raw = await target.store.queryInstant(scoped.query, scoped.scope).catch(fromStore);
      return raw.flatMap((series) => {
        const value = Number(series.values.at(-1)?.[1]);
        return Number.isFinite(value) ? [{ labels: toSeries(series).labels, value }] : [];
      });
    },

    /** Label sets of recently active series matching a selector, for catalog sync. */
    async series(workspaceId: string, selector: string): Promise<Record<string, string>[]> {
      const target = await resolve(workspaceId);
      const scoped = scope(workspaceId, selector, target.external);
      const end = Math.ceil(now() / 1000);
      const found = await target.store
        .series(scoped.query, { start: end - lookback, end }, scoped.scope)
        .catch(fromStore);
      return found.map((labels) => {
        const copy = { ...labels };
        delete copy[WORKSPACE_LABEL];
        return copy;
      });
    },

    /**
     * The Prometheus API, scoped, for Grafana and the connector. Answers in
     * Prometheus's own shape, with the workspace label removed. `query` and
     * every `match[]` are scoped exactly like any other query.
     */
    async prom(
      workspaceId: string,
      endpoint: PromEndpoint,
      params: [string, string][],
      labelName?: string,
    ): Promise<unknown> {
      const target = await resolve(workspaceId);
      const out: [string, string][] = [];
      let matched = false;
      for (const [key, value] of params) {
        if (key === 'query') out.push([key, scope(workspaceId, value, target.external).query]);
        else if (key === 'match[]') {
          matched = true;
          out.push([key, scope(workspaceId, value, target.external).query]);
        } else if (['start', 'end', 'step', 'time', 'timeout', 'limit'].includes(key))
          out.push([key, value]);
      }
      if (!target.external && !matched && endpoint !== 'query' && endpoint !== 'query_range') {
        out.push(['match[]', `{${WORKSPACE_LABEL}="${workspaceId}"}`]);
      }
      if (
        endpoint === 'label_values' &&
        (!labelName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(labelName) || labelName === WORKSPACE_LABEL)
      ) {
        throw new QueryError('forbidden', 'That label cannot be listed.');
      }
      const path = {
        query: '/api/v1/query',
        query_range: '/api/v1/query_range',
        series: '/api/v1/series',
        labels: '/api/v1/labels',
        label_values: `/api/v1/label/${labelName}/values`,
      }[endpoint];
      const data = await target.store
        .raw(path, out, target.external ? null : { label: WORKSPACE_LABEL, value: workspaceId })
        .catch(fromStore);
      return stripWorkspace(endpoint, data, options.maxLines * 20);
    },

    /** Every sample of a workspace's own metrics, for its export. Hosted store only. */
    async exportWorkspaceData(
      workspaceId: string,
    ): Promise<ReadableStream<Uint8Array> | undefined> {
      const target = await resolve(workspaceId);
      if (target.external) return undefined;
      return options.store.exportSeries(`{${WORKSPACE_LABEL}="${workspaceId}"}`).catch(fromStore);
    },

    /** Forget a workspace's cached results. */
    clearCache(workspaceId: string) {
      cache.clear(workspaceId);
    },

    /**
     * Delete all of a workspace's metrics from the hosted store, and its cached
     * results. Used when a workspace is deleted. A customer's own store is
     * never written to.
     */
    async deleteWorkspaceData(workspaceId: string): Promise<{ deleted: boolean }> {
      const target = await resolve(workspaceId);
      cache.clear(workspaceId);
      if (target.external) return { deleted: false };
      await options.store.deleteSeries(`{${WORKSPACE_LABEL}="${workspaceId}"}`).catch(fromStore);
      return { deleted: true };
    },
  };
}

export type PromEndpoint = 'query' | 'query_range' | 'series' | 'labels' | 'label_values';

/** Remove the workspace label from a raw Prometheus answer, and cap its size. */
function stripWorkspace(endpoint: PromEndpoint, data: unknown, maxLines: number): unknown {
  if (endpoint === 'labels') return (data as string[]).filter((name) => name !== WORKSPACE_LABEL);
  if (endpoint === 'label_values') return data;
  if (endpoint === 'series') {
    const list = (data as Record<string, string>[]).slice(0, maxLines);
    return list.map((labels) => {
      const rest = { ...labels };
      delete rest[WORKSPACE_LABEL];
      return rest;
    });
  }
  const result = data as { resultType: string; result: unknown };
  if (!Array.isArray(result?.result)) return data;
  if (result.result.length > maxLines) {
    throw new QueryError(
      'too_many_lines',
      `The query returns ${result.result.length} lines; the limit is ${maxLines}.`,
      result.result.length,
    );
  }
  return {
    ...result,
    result: (result.result as { metric?: Record<string, string> }[]).map((row) => {
      if (!row.metric) return row;
      const metric = { ...row.metric };
      delete metric[WORKSPACE_LABEL];
      return { ...row, metric };
    }),
  };
}

export type QueryService = ReturnType<typeof createQueryService>;
