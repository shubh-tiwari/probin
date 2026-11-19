import {
  HTTP_CLIENT_DURATION,
  HTTP_SERVER_DURATION,
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  STATUS_LABEL,
} from '@app/catalog';
import type { QueryApiClient } from '@app/query-api/client';

/** One endpoint's numbers over a window. */
export interface EndpointStats {
  service: string;
  method: string;
  route: string;
  /** Seconds. */
  p95: number | null;
  /** Requests per second. */
  rate: number;
  /** Failed share of requests, 0–1. */
  errorRatio: number;
}

const q = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const key = (labels: Record<string, string>) =>
  `${labels[SERVICE_LABEL]} ${labels[METHOD_LABEL]} ${labels[ROUTE_LABEL]}`;

export const statsQueries = (window: string, services: string[]) => {
  const scope =
    services.length > 0
      ? `{${SERVICE_LABEL}=~${q(services.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))}}`
      : '';
  const by = `${SERVICE_LABEL}, ${METHOD_LABEL}, ${ROUTE_LABEL}`;
  const failed = scope
    ? scope.replace('}', `, ${STATUS_LABEL}=~"5.."}`)
    : `{${STATUS_LABEL}=~"5.."}`;
  return {
    p95: `histogram_quantile(0.95, sum by (le, ${by}) (rate(${HTTP_SERVER_DURATION}_bucket${scope}[${window}])))`,
    rate: `sum by (${by}) (rate(${HTTP_SERVER_DURATION}_count${scope}[${window}]))`,
    errors: `sum by (${by}) (rate(${HTTP_SERVER_DURATION}_count${failed}[${window}]))`,
  };
};

/** p95, request rate and error ratio of every endpoint of some services over a window, read now. */
export async function endpointStats(
  query: QueryApiClient,
  services: string[],
  window: string,
): Promise<EndpointStats[]> {
  const queries = statsQueries(window, services);
  const [p95, rate, errors] = await Promise.all([
    query.instant(queries.p95),
    query.instant(queries.rate),
    query.instant(queries.errors),
  ]);
  const p95By = new Map(p95.map((row) => [key(row.labels), row.value]));
  const errorBy = new Map(errors.map((row) => [key(row.labels), row.value]));
  return rate
    .filter((row) => row.labels[ROUTE_LABEL])
    .map((row) => {
      const k = key(row.labels);
      const p = p95By.get(k);
      return {
        service: row.labels[SERVICE_LABEL]!,
        method: row.labels[METHOD_LABEL]!,
        route: row.labels[ROUTE_LABEL]!,
        p95: p !== undefined && Number.isFinite(p) ? p : null,
        rate: row.value,
        errorRatio: row.value > 0 ? (errorBy.get(k) ?? 0) / row.value : 0,
      };
    });
}

/** The mean of an endpoint's p95 and error ratio over [end - window, end], from 1-minute samples. */
export async function windowStats(
  query: QueryApiClient,
  endpoint: { service: string; method: string; route: string },
  range: string,
  end: number,
): Promise<{ p95: number | null; errorRatio: number | null }> {
  const s = `${SERVICE_LABEL}=${q(endpoint.service)}, ${METHOD_LABEL}=${q(endpoint.method)}, ${ROUTE_LABEL}=${q(endpoint.route)}`;
  const mean = (points: [number, number][]) =>
    points.length ? points.reduce((sum, p) => sum + p[1], 0) / points.length : null;
  const [latency, failed] = await Promise.all([
    query.query({
      query: `histogram_quantile(0.95, sum by (le) (rate(${HTTP_SERVER_DURATION}_bucket{${s}}[1m])))`,
      range,
      end,
      step: 30,
    }),
    query.query({
      query: `(sum(rate(${HTTP_SERVER_DURATION}_count{${s}, ${STATUS_LABEL}=~"5.."}[1m])) or vector(0)) / sum(rate(${HTTP_SERVER_DURATION}_count{${s}}[1m]))`,
      range,
      end,
      step: 30,
    }),
  ]);
  return {
    p95: mean(latency.series[0]?.points ?? []),
    errorRatio: mean(failed.series[0]?.points ?? []),
  };
}

/** Calls each service makes to others, per second over a window: caller, address called, rate. */
export async function outboundCalls(query: QueryApiClient, window: string) {
  const rows = await query.instant(
    `sum by (${SERVICE_LABEL}, server_address) (rate(${HTTP_CLIENT_DURATION}_count[${window}]))`,
  );
  return rows
    .filter((row) => row.labels[SERVICE_LABEL] && row.labels.server_address)
    .map((row) => ({
      caller: row.labels[SERVICE_LABEL]!,
      address: row.labels.server_address!,
      rate: row.value,
    }));
}

/** Requests per second each service handles over a window. */
export async function inboundRates(query: QueryApiClient, window: string) {
  const rows = await query.instant(
    `sum by (${SERVICE_LABEL}) (rate(${HTTP_SERVER_DURATION}_count[${window}]))`,
  );
  return new Map(rows.map((row) => [row.labels[SERVICE_LABEL]!, row.value]));
}
