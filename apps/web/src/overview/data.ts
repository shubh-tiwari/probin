import type { QueryApiClient } from '@app/query-api/client';
import { endpointStats, outboundCalls, serviceForAddress } from '@app/review';

/**
 * The overview of a workspace's production over a range: how requests flow
 * through its services and endpoints, load, response time, errors, and how
 * requests spread over latency bands. Everything comes from the metrics the
 * services send; nothing is sampled or estimated.
 */

/** When an endpoint counts as slow or failing. */
export const HEALTH = {
  /** p95 at or above this (seconds) is slow; at or above `verySlow` it is very slow. */
  slow: 1,
  verySlow: 2,
  /** A failed share at or above this is failing; at or above `erroring` it needs a look. */
  failing: 0.05,
  erroring: 0.01,
};

export type Health = 'ok' | 'slow' | 'very_slow' | 'failing';

export interface EndpointFlow {
  service: string;
  method: string;
  route: string;
  /** Requests per second over the range. */
  rate: number;
  /** Seconds; null when no request was measured. */
  p95: number | null;
  errorRatio: number;
  health: Health;
}

export interface Call {
  from: string;
  /** The service called, when the address is one of ours; else the address. */
  to: string;
  known: boolean;
  rate: number;
}

export interface Scorecard {
  normal: number;
  slow: number;
  verySlow: number;
  stalled: number;
  errors: number;
}

export interface Overview {
  range: string;
  services: string[];
  endpoints: EndpointFlow[];
  calls: Call[];
  totals: { requests: number; errors: number; perMinute: number; errorsPerMinute: number };
  /** Requests per minute over the range, one point per step. */
  load: [number, number][];
  /** p95 latency in seconds over the range, one point per step. */
  latency: [number, number][];
  scorecard: Scorecard;
}

export function healthOf(e: { p95: number | null; errorRatio: number }): Health {
  if (e.errorRatio >= HEALTH.failing) return 'failing';
  if (e.p95 !== null && e.p95 >= HEALTH.verySlow) return 'very_slow';
  if ((e.p95 !== null && e.p95 >= HEALTH.slow) || e.errorRatio >= HEALTH.erroring) return 'slow';
  return 'ok';
}

/**
 * Requests per latency band from cumulative histogram buckets (`le` → count):
 * under 0.5 s, 0.5–1 s, 1–2.5 s and over 2.5 s. Errors are counted apart.
 */
export function scorecardFrom(buckets: Map<number, number>, errors: number): Scorecard {
  const at = (le: number) => {
    const bounds = [...buckets.keys()].filter((b) => b <= le).sort((a, b) => b - a);
    return bounds.length ? buckets.get(bounds[0]!)! : 0;
  };
  const total = buckets.get(Number.POSITIVE_INFINITY) ?? Math.max(0, ...buckets.values());
  const under = (le: number) => Math.min(at(le), total);
  return {
    normal: under(0.5),
    slow: under(1) - under(0.5),
    verySlow: under(2.5) - under(1),
    stalled: total - under(2.5),
    errors,
  };
}

const SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86_400 };
const rangeSeconds = (range: string) => {
  const m = /^(\d+)([mhd])$/.exec(range);
  return m ? Number(m[1]) * SECONDS[m[2]!]! : 3600;
};

export async function gatherOverview(input: {
  query: QueryApiClient;
  services: string[];
  range: string;
}): Promise<Overview> {
  const { query, services, range } = input;
  const D = 'http_server_request_duration_seconds';
  const step = Math.max(30, Math.round(rangeSeconds(range) / 60));
  const scalar = async (q: string) => (await query.instant(q))[0]?.value ?? 0;

  const [stats, calls, requests, errors, buckets, load, latency] = await Promise.all([
    services.length ? endpointStats(query, services, range) : Promise.resolve([]),
    outboundCalls(query, range),
    scalar(`sum(increase(${D}_count[${range}]))`),
    scalar(`sum(increase(${D}_count{http_response_status_code=~"5.."}[${range}]))`),
    query.instant(`sum by (le) (increase(${D}_bucket[${range}]))`),
    query.query({ query: `sum(rate(${D}_count[5m])) * 60`, range, step }),
    query.query({
      query: `histogram_quantile(0.95, sum by (le) (rate(${D}_bucket[5m])))`,
      range,
      step,
    }),
  ]);

  const endpoints = stats
    .map((s) => ({ ...s, health: healthOf(s) }))
    .sort((a, b) => a.service.localeCompare(b.service) || b.rate - a.rate);
  const bucketMap = new Map(
    buckets.map((row) => [row.labels.le === '+Inf' ? Infinity : Number(row.labels.le), row.value]),
  );
  const minutes = rangeSeconds(range) / 60;
  const finite = (points: [number, number][]) =>
    points.filter((p): p is [number, number] => Number.isFinite(p[1]));

  return {
    range,
    services: [...new Set([...services, ...endpoints.map((e) => e.service)])].sort(),
    endpoints,
    calls: calls.map((c) => {
      const to = serviceForAddress(c.address, services);
      return { from: c.caller, to: to ?? c.address, known: to !== undefined, rate: c.rate };
    }),
    totals: {
      requests,
      errors,
      perMinute: requests / minutes,
      errorsPerMinute: errors / minutes,
    },
    load: finite(load.series[0]?.points ?? []),
    latency: finite(latency.series[0]?.points ?? []),
    scorecard: scorecardFrom(bucketMap, errors),
  };
}
