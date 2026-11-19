import type { Database } from '@app/db';
import { HTTP_CLIENT_DURATION, HTTP_SERVER_DURATION } from './names.js';
import { listEndpoints, listMetrics, listServices } from './store.js';
import type { CatalogEndpoint, CatalogMetric } from './types.js';

export interface CatalogSearch {
  /** Free text: what the person wants to measure, and of what. */
  text: string;
  /** Restrict to one service. */
  service?: string;
}

export interface CatalogSearchResult {
  /** Every service in the workspace's catalog. */
  knownServices: string[];
  /** Services the text names. Empty when it names none the catalog knows. */
  services: string[];
  /** Best matches first. Empty means nothing in the catalog matches; never guess beyond it. */
  metrics: CatalogMetric[];
  /** Endpoints of the matched services, for the endpoint picker. */
  endpoints: CatalogEndpoint[];
}

const tokens = (text: string) =>
  text
    // A path such as /inventory/stock names an endpoint, not something to measure.
    .replace(/(^|\s)\/\S*/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);

const STOP_WORDS = new Set([
  'the', 'of', 'in', 'for', 'to', 'and', 'on', 'at', 'by', 'me', 'my', 'show', 'graph', 'chart',
  'plot', 'last', 'past', 'over', 'per', 'service', 'services', 'hr', 'hrs', 'hour', 'hours', 'min',
  'mins', 'minute', 'minutes', 'day', 'days', 'week', 'weeks', 'is', 'are', 'how', 'many', 'much',
  'what', 'with', 'from', 'all', 'each', 'split', 'want', 'see', 'get', 'give', 'please', 'endpoint',
  'endpoints', 'route', 'routes', 'metric', 'metrics', 'number', 'count', 'total', 'rate', 'average',
  'avg', 'p50', 'p90', 'p95', 'p99', 'median', 'percentile', 'time', 'line', 'bar', 'stat', 'an',
  'it', 'this', 'that', 'its', 'now', 'current', 'currently', 'today', 'yesterday', 'vs', 'versus',
]); // prettier-ignore

/**
 * Words people use for things the request-duration histogram answers.
 * By convention there is no separate request counter: traffic, errors and
 * latency all come from that one histogram.
 */
const HTTP_CONCEPTS = new Set([
  'latency', 'latencies', 'slow', 'slowest', 'fast', 'speed', 'duration', 'durations', 'response',
  'traffic', 'requests', 'request', 'rps', 'throughput', 'load', 'busy', 'busiest', 'hits', 'calls',
  'errors', 'error', 'failures', 'failed', 'failing', 'fail', '5xx', '4xx', '500', '500s', 'status',
  'success', 'availability', 'http',
]); // prettier-ignore

/** Words that mean calls the service makes to others, not requests it handles. */
const OUTBOUND_CONCEPTS = new Set([
  'outbound', 'outgoing', 'downstream', 'upstream', 'dependency', 'dependencies', 'client',
]); // prettier-ignore

/** The same word in the forms people and metric names use. */
const stem = (token: string) => token.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');

const nameTokensOf = (metric: CatalogMetric) =>
  new Set(tokens(`${metric.metricName} ${metric.storedName}`).map(stem));

const isHttpMetric = (metric: CatalogMetric) =>
  metric.storedName === HTTP_SERVER_DURATION || metric.storedName === HTTP_CLIENT_DURATION;

/**
 * Whether the request names some other metric outright: a word that is not a
 * general HTTP word ("restock", "stock", "orders") appears in the name of a
 * metric that is not one of the HTTP histograms. Then "how long does the
 * restock job take" is about the restock job, not about HTTP latency.
 */
function namesAnotherMetric(metrics: CatalogMetric[], wanted: string[]): boolean {
  const distinctive = wanted
    .filter((word) => !HTTP_CONCEPTS.has(word) && !OUTBOUND_CONCEPTS.has(word))
    .map(stem);
  return metrics.some((metric) => {
    if (isHttpMetric(metric)) return false;
    const names = nameTokensOf(metric);
    return distinctive.some((word) => names.has(word));
  });
}

function scoreMetric(metric: CatalogMetric, wanted: string[], httpWordsApply: boolean): number {
  if (wanted.length === 0) return 0;
  const nameTokens = nameTokensOf(metric);
  const descriptionTokens = new Set(tokens(metric.description).map(stem));
  // "Outbound calls" is about the client histogram; everything else HTTP is about the server one.
  const outbound = wanted.some((word) => OUTBOUND_CONCEPTS.has(word));
  const httpTarget = outbound ? HTTP_CLIENT_DURATION : HTTP_SERVER_DURATION;
  let score = 0;
  for (const word of wanted) {
    const stemmed = stem(word);
    if (OUTBOUND_CONCEPTS.has(word)) {
      if (metric.storedName === HTTP_CLIENT_DURATION) score += 4;
      continue;
    }
    if (isHttpMetric(metric) && HTTP_CONCEPTS.has(word)) {
      // General HTTP words count for the HTTP histogram they are about, and
      // only when the request is not naming some other metric.
      if (httpWordsApply && metric.storedName === httpTarget) score += 3;
      continue;
    }
    if (nameTokens.has(stemmed)) score += 3;
    else if (descriptionTokens.has(stemmed)) score += 1;
  }
  return score;
}

export interface CatalogContents {
  services: string[];
  metrics: CatalogMetric[];
  endpoints: CatalogEndpoint[];
}

/**
 * Search one workspace's catalog contents. Pure, so it can be tested without
 * a database and reused wherever the contents are already in hand.
 */
export function rankCatalog(contents: CatalogContents, search: CatalogSearch): CatalogSearchResult {
  const known = contents.services;
  const words = tokens(search.text);
  const named = search.service
    ? known.filter((service) => service === search.service)
    : known.filter((service) => {
        const parts = tokens(service);
        return parts.length > 0 && parts.every((part) => words.includes(part));
      });
  if (search.service && named.length === 0) {
    return { knownServices: known, services: [], metrics: [], endpoints: [] };
  }

  const serviceWords = new Set(named.flatMap(tokens));
  const wanted = words.filter((word) => !STOP_WORDS.has(word) && !serviceWords.has(word));

  const inScope = contents.metrics.filter(
    (metric) => named.length === 0 || named.includes(metric.service),
  );
  const httpWordsApply = !namesAnotherMetric(inScope, wanted);
  const metrics = inScope
    .map((metric) => ({ metric, score: scoreMetric(metric, wanted, httpWordsApply) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.metric.service.localeCompare(b.metric.service) ||
        a.metric.metricName.localeCompare(b.metric.metricName),
    )
    .slice(0, 8)
    .map((entry) => entry.metric);

  const endpointServices = named.length > 0 ? named : [...new Set(metrics.map((m) => m.service))];
  const endpoints = contents.endpoints.filter((endpoint) =>
    endpointServices.includes(endpoint.service),
  );

  return { knownServices: known, services: named, metrics, endpoints };
}

/**
 * Search the catalog. This is the only way the agent learns which metrics,
 * labels and endpoints exist, so its result is also the list of names a
 * generated query is allowed to use.
 */
export async function searchCatalog(
  db: Database,
  workspaceId: string,
  search: CatalogSearch,
): Promise<CatalogSearchResult> {
  const [services, metrics, endpoints] = await Promise.all([
    listServices(db, workspaceId),
    listMetrics(db, workspaceId),
    listEndpoints(db, workspaceId),
  ]);
  return rankCatalog({ services, metrics, endpoints }, search);
}
