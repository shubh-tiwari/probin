import { displayUnit, formatValue } from '@app/charts';
import type { AlertRuleSpec } from '@app/specs';
import type { QueryApiClient } from '@app/query-api/client';
import { suggestFix } from './analyses.js';
import { buildIndex, type IndexedRoute } from './indexer.js';
import { endpointStats, type EndpointStats } from './metrics.js';

/**
 * Production context for code a coding agent is about to change.
 *
 * Given the files (as they are on the developer's machine, edits included) and
 * the service manifests above them, it finds the endpoints those files handle
 * and adds what production says about each: latency, traffic, failures, how it
 * ranks in its service, the alert rules watching it, and the calls it makes.
 * Nothing about the code is stored.
 */

/** How far back the numbers look. */
export const CONTEXT_WINDOW = '1h';
/** Limits on what one request may send. */
export const CONTEXT_LIMITS = { files: 20, bytesPerFile: 300_000 };

export interface SourceFile {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

export interface EndpointContext {
  service: string | null;
  method: string;
  route: string;
  line: number;
  handler: string | null;
  /** Null: no traffic in the window, or the service sends no metrics yet. */
  p95: number | null;
  rate: number | null;
  errorRatio: number | null;
  /** 1 is the slowest endpoint of its service by p95. */
  slowRank: number | null;
  busiest: boolean;
  endpointsInService: number;
  alerts: { name: string; status: string; threshold: number | null; op: string | null }[];
  calls: string[];
  /** A rule-based hint about where time goes, for the endpoints that matter most. */
  hint: string | null;
}

export interface FileContext {
  path: string;
  service: string | null;
  endpoints: EndpointContext[];
}

export interface ProductionContext {
  window: string;
  files: FileContext[];
  /** The whole context as a short brief for the agent. */
  summary: string;
}

const ms = displayUnit('s', 'ms');
const percent = (ratio: number) => formatValue(ratio, displayUnit('1', '%'));
const perSecond = (rate: number) => `${formatValue(rate, displayUnit('1'))} req/s`;

const same = (a: { service: string | null; method: string; route: string }, b: EndpointStats) =>
  a.service === b.service && a.method === b.method && a.route === b.route;

/** Alert rules that watch this endpoint: same service, and the route in the query. */
function rulesFor(route: IndexedRoute, rules: { spec: AlertRuleSpec }[]) {
  const seen = new Set<string>();
  return rules
    .filter(({ spec }) => {
      // A disabled rule watches nothing; the same rule listed twice is said once.
      if (spec.status === 'disabled' || seen.has(spec.name)) return false;
      seen.add(spec.name);
      if (spec.service && route.service && spec.service !== route.service) return false;
      const query = spec.query ?? spec.expr;
      return query.includes(`http_route="${route.route}"`);
    })
    .map(({ spec }) => ({
      name: spec.name,
      status: spec.status,
      threshold: spec.comparison?.threshold ?? null,
      op: spec.comparison?.op ?? null,
    }));
}

export async function productionContext(input: {
  files: SourceFile[];
  manifests: SourceFile[];
  query: QueryApiClient;
  rules: { spec: AlertRuleSpec }[];
}): Promise<ProductionContext> {
  const all = new Map<string, string>();
  for (const file of [...input.manifests, ...input.files]) all.set(file.path, file.content);
  const index = buildIndex('working-copy', all);
  const wanted = new Set(input.files.map((file) => file.path));
  const routes = index.routes.filter((route) => wanted.has(route.file));

  const services = [
    ...new Set([
      ...routes.map((route) => route.service).filter((s): s is string => s !== null),
      ...index.manifests.map((m) => m.manifest?.service).filter((s): s is string => Boolean(s)),
    ]),
  ];
  const stats =
    services.length > 0 ? await endpointStats(input.query, services, CONTEXT_WINDOW) : [];

  const endpoints = routes.map((route): EndpointContext => {
    const mine = stats.find((s) => same(route, s));
    const siblings = stats.filter((s) => s.service === route.service);
    const bySpeed = siblings
      .filter((s) => s.p95 !== null)
      .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
    const rank = mine ? bySpeed.findIndex((s) => same(route, s)) : -1;
    const busiest = mine !== undefined && siblings.every((s) => s.rate <= mine.rate);
    const alerts = rulesFor(route, input.rules);
    const matters = rank === 0 || alerts.length > 0;
    return {
      service: route.service,
      method: route.method,
      route: route.route,
      line: route.line,
      handler: route.handler,
      p95: mine?.p95 ?? null,
      rate: mine?.rate ?? null,
      errorRatio: mine?.errorRatio ?? null,
      slowRank: rank >= 0 ? rank + 1 : null,
      busiest,
      endpointsInService: siblings.length,
      alerts,
      calls: route.calls,
      hint: matters && mine ? suggestFix(route).replace(/^Suggested fix: /, '') : null,
    };
  });

  const manifestFor = (path: string) => {
    const dirs = path.split('/').slice(0, -1);
    for (let i = dirs.length; i >= 0; i -= 1) {
      const found = index.manifests.find(
        (m) => m.path.split('/').slice(0, -1).join('/') === dirs.slice(0, i).join('/'),
      );
      if (found) return found.manifest?.service ?? null;
    }
    return null;
  };

  const files = input.files.map((file) => ({
    path: file.path,
    service: manifestFor(file.path),
    endpoints: endpoints.filter((e) =>
      routes.some((r) => r.file === file.path && r.line === e.line && r.route === e.route),
    ),
  }));

  return { window: CONTEXT_WINDOW, files, summary: summarise(files) };
}

/** The brief an agent reads. Short, specific, numbers first. */
export function summarise(files: FileContext[]): string {
  const lines: string[] = [`Production context from the last hour of metrics.`];
  for (const file of files) {
    lines.push('', `${file.path}${file.service ? ` (service ${file.service})` : ''}`);
    if (!file.service) {
      lines.push('- No service manifest above this file, so it cannot be matched to metrics.');
      continue;
    }
    if (file.endpoints.length === 0) {
      lines.push(
        '- Defines no request handler. Changes here reach production through the code that calls it.',
      );
      continue;
    }
    for (const e of file.endpoints) {
      const where = `line ${e.line}${e.handler ? `, ${e.handler}` : ''}`;
      if (e.rate === null) {
        lines.push(`- ${e.method} ${e.route} (${where}): no traffic in the last hour.`);
        continue;
      }
      const numbers = [
        e.p95 !== null ? `p95 ${formatValue(e.p95, ms)}` : null,
        perSecond(e.rate),
        `${percent(e.errorRatio ?? 0)} failed`,
      ].filter(Boolean);
      const standing = [
        e.slowRank === 1 && e.endpointsInService > 1
          ? `the slowest of ${e.endpointsInService} endpoints in ${e.service}`
          : null,
        e.busiest && e.endpointsInService > 1 ? `the busiest in ${e.service}` : null,
      ].filter(Boolean);
      lines.push(
        `- ${e.method} ${e.route} (${where}): ${numbers.join(', ')}.${standing.length ? ` It is ${standing.join(' and ')}.` : ''}`,
      );
      for (const alert of e.alerts) lines.push(`  Alert rule (${alert.status}): ${alert.name}.`);
      for (const call of e.calls) lines.push(`  Calls ${call}.`);
      if (e.hint) lines.push(`  Where time goes: ${e.hint}`);
    }
  }
  return lines.join('\n');
}
