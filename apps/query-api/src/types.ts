/** Shared by the service and its client. No runtime code. */

export type QueryErrorCode =
  /** Not valid PromQL. */
  | 'invalid_query'
  /** Valid, but it tries to step outside its workspace or uses a forbidden function. */
  | 'forbidden'
  /** More series than the line cap allows. Aggregate or filter. */
  | 'too_many_lines'
  /** Ran past the time limit. */
  | 'timeout'
  /** The store refused the query, e.g. a type error PromQL only finds when it runs. */
  | 'rejected'
  /** The store could not be reached or failed. */
  | 'unavailable';

export interface QueryErrorBody {
  code: QueryErrorCode;
  message: string;
  /** For `too_many_lines`: how many series the query produced. */
  lineCount?: number;
}

export interface Series {
  /** Without the workspace label. */
  labels: Record<string, string>;
  /** `[unix seconds, value]`, oldest first. */
  points: [number, number][];
}

export interface QueryRequest {
  query: string;
  /** How far back to look, e.g. `5h`. */
  range: string;
  /** Seconds between points. Chosen automatically when omitted. */
  step?: number;
  /** Unix seconds the window ends at. Now, when omitted. */
  end?: number;
}

export interface QueryResult {
  series: Series[];
  /** Unix seconds. */
  start: number;
  end: number;
  step: number;
  lineCount: number;
  durationMs: number;
  /** True when served from the result cache. */
  cached: boolean;
}

export interface SeriesSummary {
  labels: Record<string, string>;
  points: number;
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
}

/** What `run_query` hands the agent: enough to judge a query, not the whole result. */
export interface DryRunResult {
  ok: boolean;
  lineCount: number;
  durationMs: number;
  /** A few series, summarised. */
  sample: SeriesSummary[];
  error?: QueryErrorBody;
}

export interface InstantRow {
  labels: Record<string, string>;
  value: number;
}
