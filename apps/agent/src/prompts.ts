import {
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  STATUS_LABEL,
  type CatalogMetric,
} from '@app/catalog';
import type { ChatMessage } from '@app/router';
import type { AgentState } from './types.js';

/** The window used inside rate(): long enough to be smooth at the default scrape interval. */
export const RATE_WINDOW = '5m';

const block = (tag: string, body: string) => `<${tag}>\n${body}\n</${tag}>`;

/** Read a tagged block back out of a prompt. Used by the stand-in model and by tests. */
export function readBlock(messages: ChatMessage[], tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`);
  for (const message of [...messages].reverse()) {
    const match = pattern.exec(message.content);
    if (match) return match[1];
  }
  return undefined;
}

const PARSE_SYSTEM = `You turn one monitoring request into a small JSON object. You do not write queries and you do not know which metrics exist.

Reply with one JSON object and nothing else, with exactly these keys:
- "measure": what to measure, in the person's own words, without the service, endpoint or time range. Example: "latency", "orders completed", "error rate".
- "kind": "latency" (how long requests take), "traffic" (how many requests), "errors" (failed requests or error rate), or "other" (anything else, such as a business metric or a queue).
- "service": the service the person named, in their words, or null.
- "endpoint": {"method": "POST" or null, "route": "/path/as/written"} if the person named an endpoint, else null.
- "all_endpoints": true only if the person asked for all endpoints together.
- "percentile": a number such as 50, 95 or 99 if the person named one ("median" is 50), else null. Never choose one for them.
- "requests": "failed_only" or "successful_only" if the person restricted the requests counted, "all" if they said to include failures, else null.
- "range": the time range as a duration such as "30m", "5h" or "7d" if the person gave one, else null.
- "chart": "timeseries", "bar" or "stat" if the person asked for a line chart, a bar chart or a single number, else null.
- "split_by": a list of at most three things to split by, in the person's words ("region", "endpoint"), else [].
- "intent": "alert" if the person asks to be alerted or notified when something happens, "collector" if they ask to monitor, poll or check a URL, else "chart".
- "alert": for an alert, {"op": ">" or "<", "threshold": a number, "unit": the threshold's unit as written ("ms", "s", "%") or null, "for": how long it must hold as a duration such as "5m", or null}; else null. "above", "over" and "more than" are ">"; "below" and "under" are "<". For an alert, "measure", "service" and "endpoint" describe what is watched.
- "collector": for a URL to monitor, {"url": the URL exactly as written, "interval": how often as a duration such as "1m", or null}; else null.

Use null when the person did not say. Do not guess.`;

export function parseMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: block('request', text) },
  ];
}

const WRITE_SYSTEM = `You write one PromQL query for a chart. Reply with one JSON object and nothing else:
{"query": "...", "title": "...", "unit": "...", "display_unit": "..." or null}

Rules:
1. Use ONLY the series names and label names listed in the context under "metrics". Never invent or guess a name. If the context cannot answer the request, still use only listed names.
2. Standard PromQL only. No time range for the chart inside the query; the only durations allowed are rate windows such as [${RATE_WINDOW}].
3. Never mention a "workspace" label.
4. Apply every decision in the context: service, endpoint, percentile, which requests to count, and what to split by.
5. Keep the number of lines small. Aggregate with sum by (...) and keep only the labels the request splits by.
6. Histograms are stored as three series: <name>_bucket, <name>_sum and <name>_count.
   - A percentile: histogram_quantile(0.95, sum by (le) (rate(<name>_bucket{...}[${RATE_WINDOW}])))
   - Request rate: sum(rate(<name>_count{...}[${RATE_WINDOW}]))
   - Error rate: failed requests (status 5xx) divided by all requests, both from <name>_count, using the status label. When the result is not split by any label, write the failed part as (sum(rate(...)) or vector(0)) so that a period with no failures shows as 0 instead of no data.
   There is no separate request counter.
7. "title" is short: the target, then what is measured, e.g. "POST /checkout/pay · p95 latency".
8. "unit" is what the query returns ("s", "By", "req/s", "%", "1" or a plain word). "display_unit" is a friendlier unit to show ("ms" for a query in seconds), or null.
9. If "previous_attempt" is set, that query failed for the stated reason. Fix that problem.
10. If "change" is set, start from "change.base_query" and make only the change asked for, applying every decision in the context.`;

export interface WriteContext {
  request: string;
  measure: string;
  kind: string;
  /** Null: all services combined. */
  service: string | null;
  /** Null: all endpoints combined, or endpoints do not apply. */
  endpoint: { method: string; route: string } | null;
  percentile: number | null;
  /** Null: does not apply to this metric. */
  requests: string | null;
  split_by: string[];
  rate_window: string;
  /** The label names for common filters, when the primary metric has them. */
  labels: { service: string; method?: string; route?: string; status?: string };
  /** The metric to use comes first. */
  metrics: {
    name: string;
    series: string[];
    type: string;
    unit: string;
    labels: string[];
    description: string;
  }[];
  previous_attempt: { query: string | null; problem: string } | null;
  /** When changing an existing chart: its query, and the change asked for. */
  change?: { base_query: string; asked: string } | null;
}

export function writeContext(
  state: AgentState,
  metrics: CatalogMetric[],
  previous: WriteContext['previous_attempt'],
): WriteContext {
  const parsed = state.parsed!;
  const primary = metrics[0]!;
  const has = (label: string) => primary.labels.includes(label);
  const { service, endpoint, percentile, requests } = state.decisions;
  return {
    request: state.text,
    measure: parsed.measure,
    kind: parsed.kind,
    service: service === undefined || service === '*' ? null : service,
    endpoint: endpoint === undefined || endpoint === 'all' ? null : endpoint,
    percentile: percentile ?? null,
    requests: requests ?? null,
    split_by: parsed.split_by,
    rate_window: RATE_WINDOW,
    labels: {
      service: SERVICE_LABEL,
      ...(has(METHOD_LABEL) ? { method: METHOD_LABEL } : {}),
      ...(has(ROUTE_LABEL) ? { route: ROUTE_LABEL } : {}),
      ...(has(STATUS_LABEL) ? { status: STATUS_LABEL } : {}),
    },
    metrics: metrics.map((metric) => ({
      name: metric.metricName,
      series: metric.series,
      type: metric.type,
      unit: metric.unit,
      labels: metric.labels,
      description: metric.description,
    })),
    previous_attempt: previous,
    change: state.revises
      ? { base_query: state.revises.query, asked: state.refinement ?? '' }
      : null,
  };
}

export function writeQueryMessages(context: WriteContext): ChatMessage[] {
  return [
    { role: 'system', content: WRITE_SYSTEM },
    { role: 'user', content: block('context', JSON.stringify(context, null, 2)) },
  ];
}

/** Pull the JSON object out of a model reply, tolerating code fences and stray text around it. */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The reply contains no JSON object.');
  return JSON.parse(reply.slice(start, end + 1));
}
