import type { Manifest } from '@app/specs';
import {
  HTTP_SERVER_DURATION,
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  storedLabelName,
  storedMetricName,
  storedSeriesNames,
} from './names.js';
import type { SeriesLabels } from './types.js';

/**
 * The metric convention, as checks. The skill tells Claude Code what to do;
 * this says whether a service actually did it. Review's convention check
 * (phase 5) reports the same findings on pull requests.
 */

export type ConventionRule =
  | 'http-duration-declared'
  | 'no-request-counter'
  | 'no-service-in-metric-name'
  | 'route-is-template'
  | 'no-personal-or-secret-attributes'
  | 'bounded-attributes'
  | 'duration-in-seconds'
  | 'declared-metric-emitted'
  | 'declared-endpoint-seen'
  | 'endpoint-in-manifest'
  | 'stable-http-names'
  | 'telemetry-not-an-outbound-call';

export interface ConventionFinding {
  rule: ConventionRule;
  /** What is wrong and where, in one sentence. */
  message: string;
}

const PERSONAL_OR_SECRET =
  /(^|[._])(user|customer|account|member|session|email|e_mail|phone|token|password|passwd|secret|api_?key|auth|ip|address_line|ssn|card)([._]|$)/i;
/** `server.address` is a host name the semantic conventions define; it is not personal. */
const ALLOWED_DESPITE_PATTERN = new Set([
  'server.address',
  'server_address',
  'network.peer.address',
]);
const UNBOUNDED = /(^|[._])(id|uuid|guid|url|uri|path|target|query|timestamp|trace|span)$/i;

/** A path segment that is a value, not a name: a number, a UUID, or a long hex string. */
const VALUE_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,})$/i;

const routeProblem = (route: string): string | undefined => {
  if (!route.startsWith('/')) return 'is not a path';
  if (/[?#]/.test(route)) return 'contains a query string or fragment';
  const value = route.split('/').find((segment) => VALUE_SEGMENT.test(segment));
  return value ? `contains the value "${value}" where a parameter such as {id} belongs` : undefined;
};

/** Why an attribute name breaks the convention, if it does. Used on manifests and on code in pull requests. */
export function attributeProblem(attribute: string): ConventionRule | undefined {
  if (ALLOWED_DESPITE_PATTERN.has(attribute)) return undefined;
  if (PERSONAL_OR_SECRET.test(attribute)) return 'no-personal-or-secret-attributes';
  if (UNBOUNDED.test(attribute)) return 'bounded-attributes';
  return undefined;
}

/** Why a route breaks the convention, if it does. */
export const routeTemplateProblem = (route: string) => routeProblem(route);

/** Checks that need only the manifest. */
export function checkManifest(manifest: Manifest): ConventionFinding[] {
  const findings: ConventionFinding[] = [];
  const names = manifest.metrics.map((metric) => metric.name);

  if (manifest.endpoints.length > 0 && !names.includes('http.server.request.duration')) {
    findings.push({
      rule: 'http-duration-declared',
      message:
        'The service has endpoints but does not declare http.server.request.duration, so its requests are not measured.',
    });
  }

  const serviceWords = manifest.service
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .join('_');
  for (const metric of manifest.metrics) {
    const firstPart = metric.name.split('.')[0]!;
    if (metric.name.includes('.') && firstPart === serviceWords) {
      findings.push({
        rule: 'no-service-in-metric-name',
        message: `${metric.name} starts with the service's name. The service is recorded separately; name the metric ${metric.name.slice(firstPart.length + 1)}.`,
      });
    }
    if (
      metric.type === 'counter' &&
      /(^|\.)(http|server)\..*requests?(\.|$)|(^|\.)requests?\.(total|count)$/.test(metric.name)
    ) {
      findings.push({
        rule: 'no-request-counter',
        message: `${metric.name} is a separate request counter. Request counts and error rates come from the duration histogram.`,
      });
    }
    if (
      metric.type === 'histogram' &&
      /duration|latency|time$/.test(metric.name) &&
      metric.unit !== 's'
    ) {
      findings.push({
        rule: 'duration-in-seconds',
        message: `${metric.name} measures time but its unit is "${metric.unit}". Durations are in seconds.`,
      });
    }
    for (const attribute of metric.attributes ?? []) {
      if (ALLOWED_DESPITE_PATTERN.has(attribute)) continue;
      if (PERSONAL_OR_SECRET.test(attribute)) {
        findings.push({
          rule: 'no-personal-or-secret-attributes',
          message: `${metric.name} has the attribute ${attribute}, which looks personal or secret.`,
        });
      } else if (UNBOUNDED.test(attribute)) {
        findings.push({
          rule: 'bounded-attributes',
          message: `${metric.name} has the attribute ${attribute}, which looks unbounded. An attribute needs a short fixed set of values.`,
        });
      }
    }
  }

  for (const endpoint of manifest.endpoints) {
    const problem = routeProblem(endpoint.route);
    if (problem) {
      findings.push({
        rule: 'route-is-template',
        message: `${endpoint.method} ${endpoint.route} ${problem}. A route is the template, never the full URL.`,
      });
    }
  }
  return findings;
}

/** A label with more distinct values than this is treated as unbounded. */
const MAX_LABEL_VALUES = 50;

/**
 * Checks that compare the manifest with what the service really emits.
 * `series` is every recently active series of the service, as the store
 * returns them. `ingestHost` is the ingestion endpoint's host name, to catch
 * telemetry export being counted as an outbound call.
 */
export function checkEmitted(
  manifest: Manifest,
  series: SeriesLabels[],
  options: { ingestHosts?: string[] } = {},
): ConventionFinding[] {
  const findings: ConventionFinding[] = [];
  const own = series.filter((labels) => labels[SERVICE_LABEL] === manifest.service);
  const seriesNames = new Set(own.map((labels) => labels.__name__));

  for (const metric of manifest.metrics) {
    const stored = storedMetricName(metric.name, metric.type, metric.unit);
    const expected = storedSeriesNames(stored, metric.type);
    if (!expected.some((name) => seriesNames.has(name))) {
      findings.push({
        rule: 'declared-metric-emitted',
        message: `${metric.name} is declared but ${expected[0]} is not in the store. It is not emitted, or its name, type or unit differs.`,
      });
      continue;
    }
    for (const attribute of metric.attributes ?? []) {
      const label = storedLabelName(attribute);
      const has = own.some((labels) => expected.includes(labels.__name__ ?? '') && label in labels);
      if (!has) {
        findings.push({
          rule: 'declared-metric-emitted',
          message: `${metric.name} declares the attribute ${attribute} but no sample carries it.`,
        });
      }
    }
  }

  if ([...seriesNames].some((name) => name?.startsWith('http_server_duration_milliseconds'))) {
    findings.push({
      rule: 'stable-http-names',
      message:
        'The service emits http.server.duration in milliseconds, the old convention. Use the stable http.server.request.duration in seconds.',
    });
  }
  for (const name of seriesNames) {
    if (name && /^http_(server_)?requests?(_count)?_total$/.test(name)) {
      findings.push({
        rule: 'no-request-counter',
        message: `The service emits ${name}, a separate request counter.`,
      });
    }
  }

  const requests = own.filter((labels) => labels.__name__ === `${HTTP_SERVER_DURATION}_count`);
  const seen = new Set(requests.map((labels) => `${labels[METHOD_LABEL]} ${labels[ROUTE_LABEL]}`));
  const declared = new Set(manifest.endpoints.map((e) => `${e.method} ${e.route}`));
  for (const endpoint of declared) {
    if (!seen.has(endpoint)) {
      findings.push({
        rule: 'declared-endpoint-seen',
        message: `${endpoint} is in the manifest but no request to it has been measured. Check the route template matches the framework's.`,
      });
    }
  }
  for (const labels of requests) {
    const route = labels[ROUTE_LABEL];
    const endpoint = `${labels[METHOD_LABEL]} ${route}`;
    if (route === undefined) {
      findings.push({
        rule: 'route-is-template',
        message: `Requests are measured with no ${ROUTE_LABEL} label, so endpoints cannot be told apart.`,
      });
      break;
    }
    const problem = routeProblem(route);
    if (problem) {
      findings.push({
        rule: 'route-is-template',
        message: `The measured route ${endpoint} ${problem}.`,
      });
    } else if (!declared.has(endpoint)) {
      findings.push({
        rule: 'endpoint-in-manifest',
        message: `${endpoint} is measured but missing from the manifest. The manifest is out of step with the code.`,
      });
    }
  }

  const values = new Map<string, Set<string>>();
  for (const labels of own) {
    for (const [label, value] of Object.entries(labels)) {
      if (label === '__name__' || label === 'le') continue;
      values.set(label, (values.get(label) ?? new Set()).add(value));
    }
  }
  for (const [label, distinct] of values) {
    if (distinct.size > MAX_LABEL_VALUES) {
      findings.push({
        rule: 'bounded-attributes',
        message: `The label ${label} has ${distinct.size} distinct values. An attribute needs a short fixed set of values.`,
      });
    }
  }

  const hosts = new Set(options.ingestHosts ?? []);
  const exported = own.find(
    (labels) =>
      labels.__name__?.startsWith('http_client_request_duration_seconds') &&
      hosts.has(labels.server_address ?? ''),
  );
  if (exported) {
    findings.push({
      rule: 'telemetry-not-an-outbound-call',
      message: `Sending telemetry to ${exported.server_address} is counted in http.client.request.duration. Exclude the exporter's own requests.`,
    });
  }

  // One finding per distinct message.
  return findings.filter(
    (finding, index) => findings.findIndex((other) => other.message === finding.message) === index,
  );
}
