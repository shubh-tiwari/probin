/**
 * The one place that knows how OpenTelemetry names become stored names.
 *
 * Services emit OpenTelemetry names (`http.server.request.duration`, unit `s`).
 * The collector writes them to the store over Prometheus remote write, which
 * renames them (`http_server_request_duration_seconds_bucket`). Nothing else
 * in the code base may guess at that renaming.
 *
 * The rules were confirmed against the store on 2026-11-18 (docs/decisions.md)
 * and catalog sync re-checks them on every run: a metric whose predicted
 * stored name is not in the store is reported, not silently trusted.
 */

export type MetricType = 'histogram' | 'counter' | 'gauge';

/** Unit codes that add a suffix to the stored name. Annotations like `{order}` add nothing. */
const UNIT_SUFFIX: Record<string, string> = {
  s: 'seconds',
  By: 'bytes',
  ms: 'milliseconds',
  '%': 'percent',
};

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/_+/g, '_');

function unitSuffix(unit: string, type: MetricType): string | undefined {
  if (unit === '' || /^\{.*\}$/.test(unit)) return undefined;
  if (unit === '1') return type === 'gauge' ? 'ratio' : undefined;
  const [main, per] = unit.split('/');
  const base = UNIT_SUFFIX[main ?? ''] ?? (main && !main.startsWith('{') ? sanitize(main) : '');
  if (per === undefined) return base || undefined;
  const perName = UNIT_SUFFIX[per] ?? (per === 's' ? 'second' : sanitize(per));
  const perSingular = per === 's' ? 'second' : perName;
  return [base, 'per', perSingular].filter(Boolean).join('_');
}

/** A label name as stored: `http.route` becomes `http_route`. */
export function storedLabelName(attribute: string): string {
  return sanitize(attribute);
}

/**
 * The stored base name of a metric, without histogram series suffixes.
 * `orders.completed` (counter, `{order}`) becomes `orders_completed_total`.
 */
export function storedMetricName(name: string, type: MetricType, unit: string): string {
  let stored = sanitize(name);
  const suffix = unitSuffix(unit, type);
  if (suffix && !stored.endsWith(`_${suffix}`)) stored += `_${suffix}`;
  if (type === 'counter' && !stored.endsWith('_total')) stored += '_total';
  return stored;
}

/** The series a query can select for a metric. A histogram is stored as three. */
export function storedSeriesNames(storedName: string, type: MetricType): string[] {
  return type === 'histogram'
    ? [`${storedName}_bucket`, `${storedName}_sum`, `${storedName}_count`]
    : [storedName];
}

/**
 * Read a stored series name back into a metric, for series found in the store
 * with no manifest behind them. The original dots cannot be recovered, so the
 * base stored name is returned as it is.
 */
export function describeStoredSeries(seriesName: string): {
  storedName: string;
  /** `histogram` only for `_bucket`; `_sum` and `_count` alone prove nothing. */
  type: MetricType | undefined;
  part: 'bucket' | 'sum' | 'count' | undefined;
} {
  const histogram = /^(.*)_(bucket|sum|count)$/.exec(seriesName);
  if (histogram) {
    return {
      storedName: histogram[1]!,
      type: histogram[2] === 'bucket' ? 'histogram' : undefined,
      part: histogram[2] as 'bucket' | 'sum' | 'count',
    };
  }
  return {
    storedName: seriesName,
    type: seriesName.endsWith('_total') ? 'counter' : 'gauge',
    part: undefined,
  };
}

/** The unit implied by a stored name's suffix, for metrics discovered in the store. */
export function unitFromStoredName(storedName: string): string {
  const base = storedName.replace(/_total$/, '');
  if (base.endsWith('_seconds')) return 's';
  if (base.endsWith('_bytes')) return 'By';
  return '';
}

/** Labels added by the pipeline, not by the service. Never offered to the agent or the user. */
export const INTERNAL_LABELS = new Set([
  '__name__',
  'workspace',
  'job',
  'instance',
  'otel_scope_name',
  'otel_scope_version',
  'otel_scope_schema_url',
]);

/** The label every series carries that says which service emitted it. */
export const SERVICE_LABEL = 'service_name';

/**
 * Metrics the OpenTelemetry semantic conventions define, which a manifest may
 * list without spelling out their attributes.
 */
export const WELL_KNOWN_METRICS: Record<
  string,
  { type: MetricType; unit: string; attributes: string[]; description: string }
> = {
  'http.server.request.duration': {
    type: 'histogram',
    unit: 's',
    attributes: ['http.request.method', 'http.route', 'http.response.status_code'],
    description: 'Duration of HTTP requests the service handles',
  },
  'http.client.request.duration': {
    type: 'histogram',
    unit: 's',
    attributes: ['http.request.method', 'server.address', 'http.response.status_code'],
    description: 'Duration of HTTP calls the service makes to others',
  },
};

/** Stored name of the request duration histogram, which endpoints are read from. */
export const HTTP_SERVER_DURATION = storedMetricName(
  'http.server.request.duration',
  'histogram',
  's',
);
/** Stored name of the histogram for HTTP calls a service makes to others. */
export const HTTP_CLIENT_DURATION = storedMetricName(
  'http.client.request.duration',
  'histogram',
  's',
);
export const ROUTE_LABEL = storedLabelName('http.route');
export const METHOD_LABEL = storedLabelName('http.request.method');
export const STATUS_LABEL = storedLabelName('http.response.status_code');
