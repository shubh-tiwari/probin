import { randomUUID } from 'node:crypto';
import {
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  STATUS_LABEL,
  type CatalogEndpoint,
  type CatalogMetric,
} from '@app/catalog';
import {
  BudgetExceededError,
  ModelCallError,
  NoEligibleModelError,
  type Router,
  type RouterResponse,
} from '@app/router';
import { analyze, extractNames } from '@app/promql';
import { durationToSeconds, parsePanelSpec, type AlertRuleSpec, type PanelSpec } from '@app/specs';
import {
  extractJson,
  parseMessages,
  writeContext,
  writeQueryMessages,
  type WriteContext,
} from './prompts.js';
import { MAX_QUESTIONS, createToolbox, type ToolBackends, type Toolbox } from './tools.js';
import {
  parsedRequestSchema,
  writtenQuerySchema,
  type AgentEvent,
  type AgentOutput,
  type AgentState,
  type Attempt,
  type EndpointChoice,
  type ParsedRequest,
  type Question,
  type QuestionId,
} from './types.js';

/** How many times the agent may try to write a working query for one request. */
export const MAX_ATTEMPTS = 3;
/** How many times it may ask the model to parse a request before giving up. */
const MAX_PARSE_TRIES = 2;

/** Product defaults: used when the request did not say and no question was asked. */
export const DEFAULT_PERCENTILE = 95;
export const DEFAULT_REQUESTS = 'all' as const;

export interface LoopDependencies {
  router: Router;
  backends: ToolBackends;
  /** The dashboard's range, used to test a query when the request gave no range. */
  defaultRange: string;
}

/** The request was sent an event it cannot take in its current state. */
export class InvalidEventError extends Error {
  override name = 'InvalidEventError';
}

export function newRequest(input: {
  workspaceId: string;
  userId: string;
  text: string;
  requestId?: string;
  userDefaults?: AgentState['userDefaults'];
  channel?: string;
}): AgentState {
  return {
    requestId: input.requestId ?? randomUUID(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    text: input.text.trim(),
    status: 'new',
    allowed: { metrics: [], labels: [] },
    decisions: {},
    defaulted: [],
    userDefaults: input.userDefaults ?? {},
    ...(input.channel ? { channel: input.channel } : {}),
    fromUserDefaults: [],
    questionsAsked: [],
    attempts: [],
    testedQueries: [],
    cost: 0,
  };
}

// ---------------------------------------------------------------------------
// Matching what the person wrote to what the catalog has
// ---------------------------------------------------------------------------

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "Checkout", "checkout service" and "order api" match `checkout` and `order-api`. */
export function matchService(named: string, known: string[]): string | undefined {
  const wanted = normalise(named.replace(/\b(service|api|app)\b/gi, ''));
  if (wanted === '') return undefined;
  return (
    known.find((service) => normalise(service) === wanted) ??
    known.find((service) => normalise(service) === normalise(named))
  );
}

/** Endpoints a person could mean by a route (and maybe a method) they wrote. */
export function matchEndpoints(
  named: { method: string | null; route: string },
  endpoints: CatalogEndpoint[],
): CatalogEndpoint[] {
  const method = named.method?.toUpperCase();
  const byMethod = endpoints.filter((endpoint) => !method || endpoint.method === method);
  const exact = byMethod.filter((endpoint) => endpoint.route === named.route);
  if (exact.length > 0) return exact;
  const wanted = normalise(named.route);
  return byMethod.filter((endpoint) => normalise(endpoint.route).endsWith(wanted));
}

const endpointValue = (endpoint: { method: string; route: string }) =>
  `${endpoint.method} ${endpoint.route}`;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function serviceQuestion(services: string[]): Question {
  return {
    id: 'service',
    kind: 'choice',
    text: 'Which service?',
    options: [
      ...services.slice(0, 5).map((service) => ({ value: service, label: service })),
      { value: '*', label: 'All services combined' },
    ],
  };
}

/** The endpoint picker: real endpoints from the catalog, tagged, with "all combined" last. */
export function endpointQuestion(endpoints: CatalogEndpoint[]): Question {
  const slowest = [...endpoints].sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1))[0];
  const busiest = [...endpoints].sort((a, b) => (b.requestRate ?? -1) - (a.requestRate ?? -1))[0];
  return {
    id: 'endpoint',
    kind: 'endpoint',
    text: 'Which endpoint?',
    options: [
      ...endpoints.map((endpoint) => {
        const tags = [
          ...(endpoint === slowest && endpoint.p95 !== null ? ['Slowest'] : []),
          ...(endpoint === busiest && endpoint.requestRate !== null ? ['Busiest'] : []),
        ];
        return {
          value: endpointValue(endpoint),
          label: endpointValue(endpoint),
          ...(tags.length > 0 ? { tags } : {}),
        };
      }),
      { value: 'all', label: 'All endpoints combined' },
    ],
  };
}

const PERCENTILE_QUESTION: Question = {
  id: 'percentile',
  kind: 'choice',
  text: 'Which latency: typical (p50), slow tail (p95) or worst 1% (p99)?',
  options: [
    { value: '50', label: 'Typical (p50)' },
    { value: '95', label: 'Slow tail (p95)' },
    { value: '99', label: 'Worst 1% (p99)' },
  ],
};

const REQUESTS_QUESTION: Question = {
  id: 'requests',
  kind: 'choice',
  text: 'Count failed requests too?',
  options: [
    { value: 'all', label: 'Yes, all requests' },
    { value: 'successful_only', label: 'No, successful requests only' },
  ],
};

// ---------------------------------------------------------------------------
// Deciding what is still open
// ---------------------------------------------------------------------------

/** The metrics the query will be written from: the chosen service's, best match first. */
function candidateMetrics(state: AgentState): CatalogMetric[] {
  const { service } = state.decisions;
  const metrics = state.catalog?.metrics ?? [];
  return service && service !== '*' ? metrics.filter((m) => m.service === service) : metrics;
}

type Next =
  { type: 'ask'; question: Question } | { type: 'stop'; message: string } | { type: 'write' };

/**
 * Work out what is still ambiguous, in the order the plan gives: endpoint,
 * then percentile, then failed requests. A question is asked only while fewer
 * than two have been asked; after that the product default applies and is
 * stated as an assumption. The endpoint has no default: the person must choose.
 */
function decide(state: AgentState): Next {
  const parsed = state.parsed!;
  const catalog = state.catalog!;
  const canAsk = () => state.questionsAsked.length < MAX_QUESTIONS;

  if (state.decisions.service === undefined) {
    const top = catalog.metrics[0]!;
    const services = [
      ...new Set(
        catalog.metrics.filter((m) => m.storedName === top.storedName).map((m) => m.service),
      ),
    ];
    if (services.length === 1) state.decisions.service = services[0]!;
    else return { type: 'ask', question: serviceQuestion(services) };
  }

  const primary = candidateMetrics(state)[0];
  if (!primary) {
    return {
      type: 'stop',
      message: `Nothing in the catalog matches “${parsed.measure}” for the ${state.decisions.service} service.`,
    };
  }

  const endpointsApply = primary.labels.includes(ROUTE_LABEL) && state.decisions.service !== '*';
  if (endpointsApply && state.decisions.endpoint === undefined) {
    const endpoints = catalog.endpoints.filter((e) => e.service === state.decisions.service);
    // Splitting by endpoint shows every endpoint, so there is nothing to pick.
    const splitByEndpoint = parsed.split_by.some((split) => /endpoint|route|path/i.test(split));
    if (parsed.all_endpoints || splitByEndpoint || endpoints.length === 0) {
      state.decisions.endpoint = 'all';
    } else if (parsed.endpoint) {
      const matches = matchEndpoints(parsed.endpoint, endpoints);
      if (matches.length === 0) {
        return {
          type: 'stop',
          message:
            `The ${state.decisions.service} service has no endpoint matching “${parsed.endpoint.route}”. ` +
            `Its endpoints are: ${endpoints.map(endpointValue).join(', ')}.`,
        };
      }
      if (matches.length === 1) {
        state.decisions.endpoint = { method: matches[0]!.method, route: matches[0]!.route };
      } else {
        return { type: 'ask', question: endpointQuestion(matches) };
      }
    } else if (endpoints.length === 1) {
      state.decisions.endpoint = { method: endpoints[0]!.method, route: endpoints[0]!.route };
    } else {
      return { type: 'ask', question: endpointQuestion(endpoints) };
    }
  }

  const percentileApplies = parsed.kind === 'latency' && primary.type === 'histogram';
  if (percentileApplies && state.decisions.percentile === undefined) {
    if (parsed.percentile !== null) state.decisions.percentile = parsed.percentile;
    else if (state.userDefaults.percentile !== undefined) {
      state.decisions.percentile = state.userDefaults.percentile;
      state.fromUserDefaults.push('percentile');
    } else if (canAsk()) return { type: 'ask', question: PERCENTILE_QUESTION };
    else {
      state.decisions.percentile = DEFAULT_PERCENTILE;
      state.defaulted.push('percentile');
    }
  }

  const requestsApply =
    (parsed.kind === 'latency' || parsed.kind === 'traffic') &&
    primary.labels.includes(STATUS_LABEL);
  if (requestsApply && state.decisions.requests === undefined) {
    if (parsed.requests !== null) state.decisions.requests = parsed.requests;
    else if (state.userDefaults.requests !== undefined) {
      state.decisions.requests = state.userDefaults.requests;
      state.fromUserDefaults.push('requests');
    } else if (canAsk()) return { type: 'ask', question: REQUESTS_QUESTION };
    else {
      state.decisions.requests = DEFAULT_REQUESTS;
      state.defaulted.push('requests');
    }
  }

  return { type: 'write' };
}

function applyAnswer(state: AgentState, value: string): void {
  const question = state.question!;
  const option = question.options.find((one) => one.value === value);
  if (!option) {
    throw new InvalidEventError(
      `“${value}” is not one of the options: ${question.options.map((o) => o.value).join(', ')}.`,
    );
  }
  const set: Record<QuestionId, () => void> = {
    service: () => (state.decisions.service = value),
    endpoint: () => {
      if (value === 'all') {
        state.decisions.endpoint = 'all';
        return;
      }
      const [method, ...route] = value.split(' ');
      state.decisions.endpoint = {
        method: method!,
        route: route.join(' '),
      } satisfies EndpointChoice;
    },
    percentile: () => (state.decisions.percentile = Number(value)),
    requests: () =>
      (state.decisions.requests = value as NonNullable<typeof state.decisions.requests>),
  };
  set[question.id]();
  delete state.question;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

const REQUESTS_TEXT = {
  all: 'all requests including failures',
  failed_only: 'failed requests only',
  successful_only: 'successful requests only',
} as const;

/**
 * The answers worth saving as the person's defaults: the percentile and
 * request-filter questions this request asked. The endpoint is particular to
 * one service and is never saved.
 */
export function rememberableAnswers(state: AgentState): AgentState['userDefaults'] {
  const answers: AgentState['userDefaults'] = {};
  if (state.questionsAsked.includes('percentile') && state.decisions.percentile !== undefined) {
    answers.percentile = state.decisions.percentile;
  }
  if (state.questionsAsked.includes('requests') && state.decisions.requests !== undefined) {
    answers.requests = state.decisions.requests;
  }
  return answers;
}

/** Every choice behind the panel that the person did not spell out, in plain words. */
export function assumptions(state: AgentState): string[] {
  const parsed = state.parsed!;
  const { decisions } = state;
  const list: string[] = [];
  if (decisions.percentile !== undefined) list.push(`p${decisions.percentile}`);
  if (parsed.kind === 'errors') list.push('errors are responses with status 5xx');
  if (decisions.requests !== undefined) list.push(REQUESTS_TEXT[decisions.requests]);
  if (decisions.service === '*') list.push('all services combined');
  const splitByEndpoint = parsed.split_by.some((split) => /endpoint|route|path/i.test(split));
  if (decisions.endpoint === 'all' && !splitByEndpoint) list.push('all endpoints combined');
  // Region is never asked. Unless the request split by it, say that it is combined.
  if (!parsed.split_by.some((split) => /region/i.test(split))) list.push('all regions combined');
  if (parsed.range === null) list.push('dashboard time range');
  return list;
}

function buildDraft(
  state: AgentState,
  written: { query: string; title: string; unit: string; display_unit?: string | null | undefined },
): PanelSpec {
  const parsed = state.parsed!;
  return parsePanelSpec({
    title: written.title,
    type: parsed.chart ?? 'timeseries',
    query: written.query,
    unit: written.unit,
    ...(written.display_unit ? { display_unit: written.display_unit } : {}),
    // The range stays outside the query. Left out, the panel follows its dashboard.
    ...(parsed.range ? { range: parsed.range } : {}),
    thresholds: [],
    request: state.text,
    assumptions: assumptions(state),
  });
}

// ---------------------------------------------------------------------------
// Model steps
// ---------------------------------------------------------------------------

async function parseRequest(state: AgentState, deps: LoopDependencies): Promise<ParsedRequest> {
  let previous: RouterResponse | undefined;
  for (let attempt = 0; attempt < MAX_PARSE_TRIES; attempt += 1) {
    const reply = await deps.router.call({
      workspaceId: state.workspaceId,
      requestId: state.requestId,
      task: 'parse',
      messages: parseMessages(state.text),
      json: true,
      maxTokens: 400,
      failures: attempt,
      previousCallId: previous?.callId,
    });
    state.cost += reply.cost;
    previous = reply;
    try {
      return parsedRequestSchema.parse(extractJson(reply.content));
    } catch {
      await deps.router.report(reply.callId, 'invalid_output');
    }
  }
  throw new ModelCallError('The request could not be understood.');
}

async function writeAndTest(
  state: AgentState,
  tools: Toolbox,
  deps: LoopDependencies,
): Promise<AgentOutput> {
  const metrics = candidateMetrics(state);
  const range = state.parsed!.range ?? deps.defaultRange;
  let previous: WriteContext['previous_attempt'] = null;
  let lastProblem = '';

  while (state.attempts.length < MAX_ATTEMPTS) {
    const failures = state.attempts.length;
    const reply = await deps.router.call({
      workspaceId: state.workspaceId,
      requestId: state.requestId,
      task: 'write_query',
      messages: writeQueryMessages(writeContext(state, metrics, previous)),
      json: true,
      maxTokens: 600,
      // After two failures the router moves to a stronger model.
      failures,
      previousCallId: state.attempts.at(-1)?.callId,
    });
    state.cost += reply.cost;
    const attempt: Attempt = {
      number: failures + 1,
      model: reply.model,
      tier: reply.tier,
      escalated: reply.escalated,
      callId: reply.callId,
      cost: reply.cost,
    };
    state.attempts.push(attempt);

    let written;
    try {
      written = writtenQuerySchema.parse(extractJson(reply.content));
    } catch {
      attempt.failure = 'The reply was not the JSON that was asked for.';
      await deps.router.report(reply.callId, 'invalid_output');
      previous = { query: null, problem: attempt.failure };
      lastProblem = attempt.failure;
      continue;
    }
    attempt.query = written.query;

    const run = await tools.runQuery(written.query, range);
    if (run.ok) {
      attempt.lineCount = run.lineCount;
      state.draft = buildDraft(state, written);
      state.status = 'draft';
      await remember(state, deps).catch(() => undefined);
      if (state.parsed!.intent === 'alert') return draftAlertFromDraft(state, tools, deps, {});
      return { kind: 'draft', panel: state.draft, attempts: state.attempts };
    }
    attempt.failure = run.reason;
    if (run.ungrounded) attempt.ungrounded = run.ungrounded;
    if (run.lineCount !== undefined) attempt.lineCount = run.lineCount;
    await deps.router.report(reply.callId, run.ungrounded ? 'ungrounded' : 'dry_run_failed');
    previous = { query: written.query, problem: run.reason };
    lastProblem = run.reason;
  }

  return fail(
    state,
    `I could not build a working query for this after ${MAX_ATTEMPTS} attempts. The last problem: ${lastProblem}`,
  );
}

// ---------------------------------------------------------------------------
// Alerts and data sources
// ---------------------------------------------------------------------------

/** The default time a condition must hold, when the person did not say. */
export const DEFAULT_ALERT_FOR = '5m';

/** A threshold as written ("800 ms", "2%") in the query's own unit (seconds, a ratio). */
export function thresholdInQueryUnit(
  threshold: number,
  written: string | null,
  queryUnit: string,
): number {
  const unit = written?.toLowerCase() ?? null;
  if (queryUnit === 's') {
    if (unit === 'ms') return threshold / 1000;
    if (unit === 'm' || unit === 'min') return threshold * 60;
    return threshold;
  }
  if (queryUnit === '1' && (unit === '%' || unit === 'percent')) return threshold / 100;
  return threshold;
}

/** A round number just above `value`, for a suggested threshold. */
export function niceAbove(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * power).find((s) => s > value);
  return Number((step ?? 10 * power).toPrecision(6));
}

const describeThreshold = (value: number, unit: string, display?: string) => {
  if (unit === 's' && display === 'ms') return `${Number((value * 1000).toPrecision(6))} ms`;
  if (unit === '1' && display === '%') return `${Number((value * 100).toPrecision(6))}%`;
  if (unit === 's') return `${value} s`;
  return `${value}${unit && unit !== '1' ? ` ${unit}` : ''}`;
};

/**
 * Turn the tested draft into a pending alert rule. The threshold comes from
 * the request, the event, or (for "Alert me on this") a round number just
 * above the highest value in the range, which is stated as an assumption.
 */
async function draftAlertFromDraft(
  state: AgentState,
  tools: Toolbox,
  deps: LoopDependencies,
  given: { op?: '>' | '<'; threshold?: number; for?: string },
): Promise<AgentOutput> {
  const panel = state.draft!;
  const parsed = state.parsed!;
  const assumptions = [...panel.assumptions];
  const op = given.op ?? parsed.alert?.op ?? '>';
  let threshold: number;
  if (given.threshold !== undefined) {
    threshold = given.threshold;
  } else if (parsed.alert) {
    threshold = thresholdInQueryUnit(parsed.alert.threshold, parsed.alert.unit, panel.unit);
  } else {
    const dry = await deps.backends.dryRun(panel.query, panel.range ?? deps.defaultRange);
    const highest = Math.max(...dry.sample.map((s) => s.max ?? Number.NEGATIVE_INFINITY));
    threshold = niceAbove(Number.isFinite(highest) ? highest * 1.1 : 1);
    assumptions.push(
      `threshold suggested from the data: just above the highest value in ${panel.range ?? deps.defaultRange}`,
    );
  }
  const duration = given.for ?? parsed.alert?.for ?? DEFAULT_ALERT_FOR;
  if (!given.for && !parsed.alert?.for)
    assumptions.push(`must hold for ${DEFAULT_ALERT_FOR} (default)`);
  try {
    durationToSeconds(duration);
  } catch {
    return fail(state, `“${duration}” is not a duration such as 5m.`);
  }
  const shown = describeThreshold(threshold, panel.unit, panel.display_unit);
  const subject = panel.title;
  const spec: AlertRuleSpec = {
    name: `${subject} ${op === '>' ? 'above' : 'below'} ${shown}`,
    expr: `(${panel.query}) ${op} ${threshold}`,
    for: duration,
    severity: 'warning',
    channel: state.channel ?? '#alerts',
    status: 'pending',
    query: panel.query,
    comparison: { op, threshold },
    unit: panel.unit,
    ...(panel.display_unit ? { display_unit: panel.display_unit } : {}),
    ...(state.decisions.service && state.decisions.service !== '*'
      ? { service: state.decisions.service }
      : {}),
    request: state.text,
    assumptions,
  };
  const { ruleId } = await tools.draftAlert(spec);
  state.alertDraft = { ruleId, spec };
  state.status = 'alert';
  return { kind: 'alert', ruleId, rule: spec };
}

/** Collector names are what the check is about: the host and path. */
function collectorName(url: URL): string {
  return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 80);
}

async function draftCollector(state: AgentState, tools: Toolbox): Promise<AgentOutput> {
  const wanted = state.parsed!.collector!;
  let url: URL;
  try {
    url = new URL(wanted.url);
  } catch {
    return noMatch(state, `“${wanted.url}” is not a URL I can monitor.`);
  }
  const interval = wanted.interval ?? '1m';
  if (durationToSeconds(interval) < 30)
    return noMatch(state, 'The shortest interval is 30 seconds.');
  const spec = {
    name: collectorName(url),
    source_type: 'http',
    config: { url: url.toString(), method: 'GET', timeout_seconds: 5 },
    interval,
    metric_names: ['http.check.up', 'http.check.duration'],
    status: 'pending' as const,
  };
  try {
    const result = await tools.draftCollector(spec);
    state.collectorDraft = { ...result, spec };
    state.status = 'collector';
    return { kind: 'collector', ...state.collectorDraft };
  } catch (error) {
    return noMatch(state, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Refining an existing chart
// ---------------------------------------------------------------------------

/** What a chart's query says about its decisions: service, endpoint, percentile, failures. */
export function decisionsFromQuery(query: string): AgentState['decisions'] {
  const decisions: AgentState['decisions'] = {};
  let analysis;
  try {
    analysis = analyze(query);
  } catch {
    return decisions;
  }
  const matchers = analysis.selectors.flatMap((s) => s.matchers);
  const exact = (label: string) => matchers.find((m) => m.label === label && m.op === '=')?.value;
  const service = exact(SERVICE_LABEL);
  if (service) decisions.service = service;
  const route = exact(ROUTE_LABEL);
  const method = exact(METHOD_LABEL);
  if (route && method) decisions.endpoint = { method, route };
  else if (service) decisions.endpoint = 'all';
  const quantile = /histogram_quantile\(\s*([0-9.]+)/.exec(query);
  if (quantile) decisions.percentile = Math.round(Number(quantile[1]) * 1000) / 10;
  const status = matchers.find((m) => m.label === STATUS_LABEL);
  if (!/ \/ /.test(query)) {
    decisions.requests = !status ? 'all' : status.op === '=~' ? 'failed_only' : 'successful_only';
  }
  return decisions;
}

/** Combine the original request with the change asked for. The change wins where it says something. */
export function mergeRefinement(base: ParsedRequest, change: ParsedRequest): ParsedRequest {
  return {
    ...base,
    intent: 'chart',
    alert: null,
    collector: null,
    percentile: change.percentile ?? base.percentile,
    requests: change.requests ?? base.requests,
    range: change.range ?? base.range,
    chart: change.chart ?? base.chart,
    endpoint: change.endpoint ?? (change.all_endpoints ? null : base.endpoint),
    all_endpoints: change.all_endpoints || (change.endpoint ? false : base.all_endpoints),
    split_by: [...new Set([...base.split_by, ...change.split_by])].slice(0, 3),
  };
}

/**
 * A new request that changes an existing chart. `base` is a request (with its
 * decisions), or a saved panel (decisions read back from its query). Nothing
 * is asked: the original answers stand, and anything new is an assumption.
 */
export function seedRefinement(input: {
  workspaceId: string;
  userId: string;
  text: string;
  base:
    | { kind: 'request'; state: AgentState }
    | { kind: 'panel'; panel: PanelSpec; panelId: string; dashboardId?: string };
  channel?: string;
}): AgentState {
  const original = input.base.kind === 'request' ? input.base.state.text : input.base.panel.request;
  const state = newRequest({
    workspaceId: input.workspaceId,
    userId: input.userId,
    text: `${original} (then: ${input.text.trim()})`,
    ...(input.channel ? { channel: input.channel } : {}),
  });
  state.refinement = input.text.trim();
  if (input.base.kind === 'request') {
    const base = input.base.state;
    state.decisions = { ...base.decisions };
    if (base.parsed) state.parsed = base.parsed;
    if (base.catalog) state.catalog = base.catalog;
    state.allowed = base.allowed;
    const query = base.draft?.query ?? '';
    state.revises = {
      query,
      ...(base.saved ? { panelId: base.saved.panelId, dashboardId: base.saved.dashboardId } : {}),
    };
  } else {
    state.decisions = decisionsFromQuery(input.base.panel.query);
    state.revises = {
      query: input.base.panel.query,
      panelId: input.base.panelId,
      ...(input.base.dashboardId ? { dashboardId: input.base.dashboardId } : {}),
    };
  }
  return state;
}

async function refine(
  state: AgentState,
  tools: Toolbox,
  deps: LoopDependencies,
  text: string,
): Promise<AgentOutput> {
  const change = await parseText(state, deps, text);
  const base =
    state.parsed ?? (await parseText(state, deps, state.text.replace(/ \(then: .*\)$/, '')));
  const merged = mergeRefinement(base, change);
  state.parsed = merged;
  // A refinement keeps every earlier answer; what the change says replaces them.
  if (change.percentile !== null) state.decisions.percentile = change.percentile;
  if (change.requests !== null) state.decisions.requests = change.requests;
  if (change.all_endpoints) state.decisions.endpoint = 'all';
  if (merged.split_by.some((s) => /endpoint|route|path/i.test(s))) state.decisions.endpoint = 'all';

  // The names the chart may use: the catalog of its service.
  const service =
    state.decisions.service && state.decisions.service !== '*'
      ? state.decisions.service
      : undefined;
  // The chart's own query names its metric; search with those names too, since
  // a panel's request text may not describe it (a starter panel, a hand edit).
  let namesInQuery: string[];
  try {
    namesInQuery = extractNames(state.revises?.query ?? '').metrics.map((name) =>
      name.replace(/_(bucket|sum|count)$/, ''),
    );
  } catch {
    namesInQuery = [];
  }
  const result = await tools.searchCatalog({
    text: `${state.text} ${merged.measure} ${namesInQuery.join(' ')}`,
    ...(service ? { service } : {}),
  });
  if (!state.catalog || state.catalog.metrics.length === 0) {
    state.catalog = {
      knownServices: result.knownServices,
      metrics: result.metrics,
      endpoints: result.endpoints,
    };
  }
  if (state.catalog.metrics.length === 0)
    return noMatch(state, 'I could not find the metric behind this chart in the catalog.');
  if (state.decisions.service === undefined && result.services.length === 1)
    state.decisions.service = result.services[0]!;
  if (merged.kind === 'latency' && state.decisions.percentile === undefined) {
    state.decisions.percentile = DEFAULT_PERCENTILE;
    state.defaulted.push('percentile');
  }
  if (state.decisions.requests === undefined && merged.kind !== 'errors') {
    state.decisions.requests = DEFAULT_REQUESTS;
    state.defaulted.push('requests');
  }
  return writeAndTest(state, tools, deps);
}

/** Parse some words with the model, outside the main request text. */
async function parseText(
  state: AgentState,
  deps: LoopDependencies,
  text: string,
): Promise<ParsedRequest> {
  const original = state.text;
  state.text = text;
  try {
    return await parseRequest(state, deps);
  } finally {
    state.text = original;
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function fail(state: AgentState, message: string): AgentOutput {
  state.status = 'failed';
  state.message = message;
  return { kind: 'failed', message, attempts: state.attempts };
}

function noMatch(state: AgentState, message: string): AgentOutput {
  state.status = 'no_match';
  state.message = message;
  return { kind: 'no_match', message };
}

async function proceed(state: AgentState, tools: Toolbox, deps: LoopDependencies) {
  const next = decide(state);
  if (next.type === 'stop') return noMatch(state, next.message);
  if (next.type === 'ask') {
    tools.askUser(next.question);
    return {
      kind: 'question' as const,
      question: next.question,
      questionsLeft: MAX_QUESTIONS - state.questionsAsked.length,
    };
  }
  return writeAndTest(state, tools, deps);
}

/** The cache key for a request: its words, lower case, without spacing or end punctuation. */
export function resolvedKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.?!]+$/, '')
    .trim();
}

/**
 * Reuse an identical earlier request, if the catalog of its services has not
 * changed since. No model is called; the query is still dry-run before it is
 * shown, and the names it uses are still checked against the catalog.
 */
async function fromCache(
  state: AgentState,
  tools: Toolbox,
  deps: LoopDependencies,
): Promise<AgentOutput | undefined> {
  const cache = deps.backends.resolved;
  if (!cache) return undefined;
  const entry = await cache.get(resolvedKey(state.text));
  if (!entry) return undefined;
  if ((await cache.fingerprint(entry.services)) !== entry.fingerprint) return undefined;

  state.allowed = await cache.names(entry.services);
  const parsed = parsedRequestSchema.safeParse(entry.parsed);
  if (!parsed.success) return undefined;
  const run = await tools.runQuery(entry.panel.query, parsed.data.range ?? deps.defaultRange);
  if (!run.ok) return undefined;

  state.parsed = parsed.data;
  state.decisions = entry.decisions as AgentState['decisions'];
  state.fromCache = true;
  state.draft = parsePanelSpec({
    ...entry.panel,
    request: state.text,
    assumptions: [...entry.panel.assumptions, 'the same choices as the last time this was asked'],
  });
  state.status = 'draft';
  return { kind: 'draft', panel: state.draft, attempts: state.attempts };
}

/** Remember a fresh draft for the next identical request. */
async function remember(state: AgentState, deps: LoopDependencies): Promise<void> {
  const cache = deps.backends.resolved;
  if (!cache || !state.draft || state.fromCache) return;
  const services =
    state.decisions.service && state.decisions.service !== '*'
      ? [state.decisions.service]
      : (state.catalog?.knownServices ?? []);
  if (services.length === 0) return;
  await cache.put(resolvedKey(state.text), {
    panel: state.draft,
    parsed: state.parsed,
    decisions: state.decisions,
    services,
    fingerprint: await cache.fingerprint(services),
  });
}

async function start(state: AgentState, tools: Toolbox, deps: LoopDependencies) {
  const cached = await fromCache(state, tools, deps);
  if (cached) return cached;
  const parsed = await parseRequest(state, deps);
  state.parsed = parsed;
  if (parsed.intent === 'collector' && parsed.collector) return draftCollector(state, tools);

  // Search with the person's own words, the parsed measure, and the kind of
  // measure as a plain word ("how long do payments take" is about latency).
  // A service named in the text narrows the search to that service.
  const text = [state.text, parsed.measure, parsed.kind === 'other' ? '' : parsed.kind].join(' ');
  let result = await tools.searchCatalog({ text });
  if (parsed.service !== null) {
    const service = matchService(parsed.service, result.knownServices);
    if (!service) {
      const known = result.knownServices;
      return noMatch(
        state,
        `There is no service called “${parsed.service}” in the catalog. ` +
          (known.length > 0
            ? `The services I know are: ${known.join(', ')}.`
            : 'It has no services yet.'),
      );
    }
    state.decisions.service = service;
    result = await tools.searchCatalog({ text, service });
  } else if (result.services.length === 1) {
    state.decisions.service = result.services[0]!;
  }

  state.catalog = {
    knownServices: result.knownServices,
    metrics: result.metrics,
    endpoints: result.endpoints,
  };
  if (result.metrics.length === 0) {
    const where = state.decisions.service ? ` for the ${state.decisions.service} service` : '';
    return noMatch(
      state,
      `Nothing in the catalog matches “${parsed.measure}”${where}. I can only chart metrics that exist; I will not guess a name.`,
    );
  }
  return proceed(state, tools, deps);
}

/**
 * Move a request forward by one event and say what the person should see.
 *
 * `start` runs the request until it needs an answer or has a tested draft.
 * `answer` supplies the answer to the open question. `confirm` saves the
 * draft. `state` is updated in place; it is plain data and can be stored
 * between events.
 */
export async function advance(
  state: AgentState,
  event: AgentEvent,
  deps: LoopDependencies,
): Promise<AgentOutput> {
  const tools = createToolbox(state, deps.backends);
  try {
    switch (event.type) {
      case 'start':
        if (state.status !== 'new')
          throw new InvalidEventError('This request has already started.');
        return await start(state, tools, deps);
      case 'answer':
        if (state.status !== 'question' || !state.question) {
          throw new InvalidEventError('This request is not waiting for an answer.');
        }
        applyAnswer(state, event.value);
        return await proceed(state, tools, deps);
      case 'refine':
        if (state.status !== 'new' || !state.revises)
          throw new InvalidEventError('Start a refinement with seedRefinement.');
        return await refine(state, tools, deps, event.text);
      case 'alert': {
        if (state.status !== 'draft' && state.status !== 'saved') {
          throw new InvalidEventError('Only a tested chart can become an alert.');
        }
        if (!state.draft) throw new InvalidEventError('There is no chart to alert on.');
        return await draftAlertFromDraft(state, tools, deps, event);
      }
      case 'confirm': {
        if (state.status !== 'draft' || !state.draft) {
          throw new InvalidEventError('There is no draft to save.');
        }
        const saved = await tools.savePanel(state.draft, event.dashboardId);
        state.saved = saved;
        state.status = 'saved';
        return { kind: 'saved', ...saved };
      }
    }
  } catch (error) {
    if (
      error instanceof BudgetExceededError ||
      error instanceof NoEligibleModelError ||
      error instanceof ModelCallError
    ) {
      return fail(state, error.message);
    }
    throw error;
  }
}
