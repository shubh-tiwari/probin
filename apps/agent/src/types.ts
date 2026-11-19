import type { CatalogEndpoint, CatalogMetric } from '@app/catalog';
import type { AlertRuleSpec, CollectorSpec, PanelSpec, PanelType } from '@app/specs';
import { durationSchema } from '@app/specs';
import { z } from 'zod';

/** What kind of thing the person wants to see. It decides which questions apply. */
export const MEASURE_KINDS = ['latency', 'traffic', 'errors', 'other'] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];

export const REQUEST_FILTERS = ['all', 'failed_only', 'successful_only'] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];

/**
 * A request, parsed into measure, target, range and chart type. This is the
 * model's `parse` output; the schema is what makes it safe to act on.
 */
export const parsedRequestSchema = z.strictObject({
  /** What to measure, in the person's words: "latency", "orders completed". */
  measure: z.string().min(1),
  kind: z.enum(MEASURE_KINDS),
  /** The service as the person named it, or null. */
  service: z.string().min(1).nullable(),
  /** The endpoint as the person named it, or null. */
  endpoint: z
    .strictObject({ method: z.string().min(1).nullable(), route: z.string().min(1) })
    .nullable(),
  /** True when the person asked for all endpoints together. */
  all_endpoints: z.boolean(),
  /** A percentile between 0 and 100, or null when none was named. */
  percentile: z.number().gt(0).lt(100).nullable(),
  /** Which requests to count, or null when the person did not say. */
  requests: z.enum(REQUEST_FILTERS).nullable(),
  range: durationSchema.nullable(),
  chart: z.enum(['timeseries', 'bar', 'stat']).nullable(),
  /** Things to split the chart by, in the person's words: "region", "endpoint". */
  split_by: z.array(z.string().min(1)).max(3),
  /** What the person wants made: a chart (default), an alert rule, or a data source to collect. */
  intent: z.enum(['chart', 'alert', 'collector']).default('chart'),
  /** For an alert: the condition, as the person said it. */
  alert: z
    .strictObject({
      op: z.enum(['>', '<']),
      threshold: z.number(),
      /** The threshold's unit as written: "ms", "s", "%", or null. */
      unit: z.string().min(1).nullable(),
      for: durationSchema.nullable(),
    })
    .nullable()
    .default(null),
  /** For a data source: what to fetch and how often. */
  collector: z
    .strictObject({ url: z.string().min(1), interval: durationSchema.nullable() })
    .nullable()
    .default(null),
});
export type ParsedRequest = z.infer<typeof parsedRequestSchema>;

/** The model's `write_query` output. */
export const writtenQuerySchema = z.strictObject({
  query: z.string().min(1),
  title: z.string().min(1),
  /** The unit the query returns. */
  unit: z.string(),
  display_unit: z.string().min(1).nullable().optional(),
});
export type WrittenQuery = z.infer<typeof writtenQuerySchema>;

export type QuestionId = 'service' | 'endpoint' | 'percentile' | 'requests';

export interface QuestionOption {
  value: string;
  label: string;
  /** For the endpoint picker: "Slowest", "Busiest". */
  tags?: string[];
}

export interface Question {
  id: QuestionId;
  text: string;
  /**
   * `choice`: 2 to 6 options, shown as buttons.
   * `endpoint`: the endpoint picker; any number of real endpoints with a
   * filter box, and "All endpoints combined" last.
   */
  kind: 'choice' | 'endpoint';
  options: QuestionOption[];
}

export interface EndpointChoice {
  method: string;
  route: string;
}

/** What has been settled, by the request itself, by an answer, or by a default. */
export interface Decisions {
  /** A service name, or `*` for all services combined. */
  service?: string;
  endpoint?: EndpointChoice | 'all';
  percentile?: number;
  requests?: RequestFilter;
}

/** One try at writing the query. Kept so the work can be shown and measured. */
export interface Attempt {
  number: number;
  model: string;
  tier: string;
  escalated: boolean;
  callId: string;
  cost: number;
  /** The query the model wrote, when its output could be read at all. */
  query?: string;
  /** Names it used that the catalog search did not return. */
  ungrounded?: string[];
  lineCount?: number;
  /** Why the attempt failed. Absent on the attempt that succeeded. */
  failure?: string;
}

/** A pending alert rule this request wrote. */
export interface AlertDraft {
  ruleId: string;
  spec: AlertRuleSpec;
}

/** A pending collector this request wrote, with its test fetch. */
export interface CollectorDraft {
  collectorId: string;
  spec: CollectorSpec;
  test: { ok: boolean; status: number | null; duration: number; error?: string };
}

export type AgentStatus =
  | 'new'
  /** Waiting for the person to answer `question`. */
  | 'question'
  /** A tested draft is ready. Nothing is saved until the person confirms. */
  | 'draft'
  | 'saved'
  /** A pending alert rule was written. It does nothing until a person approves it. */
  | 'alert'
  /** A pending collector was written, after one test fetch. */
  | 'collector'
  /** Nothing in the catalog matches. Said plainly; no metric name is ever guessed. */
  | 'no_match'
  /** No working query after every attempt, or the model could not be used. */
  | 'failed';

/**
 * Everything about one request. Plain data, so it can be stored and picked up
 * later when the person answers in Slack or the web tool.
 */
export interface AgentState {
  requestId: string;
  workspaceId: string;
  /** The person asking. */
  userId: string;
  /** The original request, word for word. */
  text: string;
  status: AgentStatus;
  parsed?: ParsedRequest;
  catalog?: {
    knownServices: string[];
    metrics: CatalogMetric[];
    endpoints: CatalogEndpoint[];
  };
  /** The names `search_catalog` returned. A query may use these and no others. */
  allowed: { metrics: string[]; labels: string[] };
  decisions: Decisions;
  /** Which decisions came from a product default rather than the request or an answer. */
  defaulted: QuestionId[];
  /** True when the query was reused from an identical earlier request, with no model call. */
  fromCache?: boolean;
  /** The person's saved answers ("Skip questions next time"), read when the request started. */
  userDefaults: { percentile?: number; requests?: RequestFilter };
  /** Which decisions came from the person's saved answers. */
  fromUserDefaults: QuestionId[];
  questionsAsked: QuestionId[];
  question?: Question;
  attempts: Attempt[];
  /** Queries that passed `run_query` in this request. Only these may be saved. */
  testedQueries: string[];
  draft?: PanelSpec;
  saved?: { panelId: string; version: number; dashboardId: string };
  alertDraft?: AlertDraft;
  collectorDraft?: CollectorDraft;
  /** Where an alert from this request notifies: the Slack channel it came from, or the workspace default. */
  channel?: string;
  /** Set when this request changes an existing chart: confirming saves a new version of the panel, if saved. */
  revises?: { panelId?: string; dashboardId?: string; query: string };
  /** The change asked for, in the person's words. */
  refinement?: string;
  /** What to tell the person when there is no draft. */
  message?: string;
  /** Model spend on this request so far. */
  cost: number;
}

/** What the person sees after each step. */
export type AgentOutput =
  | { kind: 'question'; question: Question; questionsLeft: number }
  | { kind: 'draft'; panel: PanelSpec; attempts: Attempt[] }
  | { kind: 'saved'; panelId: string; version: number; dashboardId: string }
  | { kind: 'alert'; ruleId: string; rule: AlertRuleSpec }
  | ({ kind: 'collector' } & CollectorDraft)
  | { kind: 'no_match'; message: string }
  | { kind: 'failed'; message: string; attempts: Attempt[] };

export type AgentEvent =
  | { type: 'start' }
  | { type: 'answer'; value: string }
  | { type: 'confirm'; dashboardId?: string }
  /** "Alert me on this": a pending rule from the draft, threshold suggested from the data unless given. */
  | { type: 'alert'; op?: '>' | '<'; threshold?: number; for?: string }
  /** A change to an existing chart: "split by region", "last 24h". The state is seeded by `seedRefinement`. */
  | { type: 'refine'; text: string };

export type { PanelType };
