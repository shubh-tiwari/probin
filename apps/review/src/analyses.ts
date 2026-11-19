import { attributeProblem, storedMetricName, type MetricType } from '@app/catalog';
import { displayUnit, formatValue } from '@app/charts';
import type { QueryApiClient } from '@app/query-api/client';
import type { Manifest } from '@app/specs';
import { parsePatch } from './diff.js';
import type { Finding } from './findings.js';
import type { PullFile } from './github.js';
import { findHandler, type CodeIndex, type IndexedRoute } from './indexer.js';
import {
  endpointStats,
  inboundRates,
  outboundCalls,
  statsQueries,
  windowStats,
  type EndpointStats,
} from './metrics.js';

const ms = (seconds: number | null) =>
  seconds === null ? 'no data' : formatValue(seconds, displayUnit('s', 'ms'));
const pct = (ratio: number) => `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
const rps = (rate: number) => `${rate < 1 ? rate.toFixed(2) : rate.toFixed(1)} req/s`;
const HTTP_METRIC = 'http.server.request.duration';

const services = (index: CodeIndex) => [
  ...new Set(
    index.manifests.map((m) => m.manifest?.service).filter((s): s is string => Boolean(s)),
  ),
];

/**
 * A suggested fix from what the handler's code does. Plain rules, no model:
 * it names the line it is about, and it is labelled a suggestion.
 */
export function suggestFix(handler: IndexedRoute): string {
  const lines = handler.snippet.split('\n');
  const loopAt = lines.findIndex((text) => /^\s*(for|while)\b|\.forEach\(|\.map\(/.test(text));
  const awaitInLoop =
    loopAt !== -1 && lines.slice(loopAt + 1, loopAt + 8).some((text) => /\bawait\b/.test(text));
  if (awaitInLoop) {
    return `Suggested fix: the handler waits for each step of the loop at line ${handler.span[0] + loopAt} in turn. Fetch the items in one query, or run the steps concurrently, so the time does not grow with the number of items.`;
  }
  if (handler.calls.length > 0) {
    return `Suggested fix: part of the time is likely the call to ${handler.calls[0]}. Check that service's latency, add a timeout, and do the call only when it is needed.`;
  }
  return 'Suggested fix: the time is spent inside the handler, not in traffic. Profile it to find the slow step.';
}

// ---------------------------------------------------------------------------
// R2: the bottleneck report
// ---------------------------------------------------------------------------

/**
 * The slowest and most error-prone endpoints of the services in a repository,
 * each linked to its handler with a suggested fix. When the handler cannot be
 * found, the finding says so instead of guessing.
 */
export async function bottleneckReport(input: {
  index: CodeIndex;
  query: QueryApiClient;
  window: string;
  top?: number;
}): Promise<{ findings: Finding[]; stats: EndpointStats[] }> {
  const inRepo = services(input.index);
  const stats = await endpointStats(input.query, inRepo, input.window);
  const queries = statsQueries(input.window, inRepo);
  const findings: Finding[] = [];
  const slowest = stats
    .filter((s) => s.p95 !== null)
    .sort((a, b) => b.p95! - a.p95!)
    .slice(0, input.top ?? 5);
  slowest.forEach((s, rank) => {
    const handler = findHandler(input.index, s);
    const where = handler
      ? `Handler: \`${handler.file}\` line ${handler.line}${handler.handler ? ` (\`${handler.handler}\`)` : ''}.`
      : `I could not find the handler for ${s.method} ${s.route} in this repository, so this is not linked to code.`;
    findings.push({
      kind: 'slow_endpoint',
      title: `#${rank + 1} slowest: ${s.method} ${s.route} (${s.service}), p95 ${ms(s.p95)}`,
      body: [
        `Over the last ${input.window}: p95 ${ms(s.p95)}, ${rps(s.rate)}, ${pct(s.errorRatio)} failed.`,
        where,
        handler ? suggestFix(handler) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      evidence: {
        metric: HTTP_METRIC,
        window: input.window,
        query: queries.p95,
        values: { p95_seconds: s.p95, requests_per_second: s.rate, error_ratio: s.errorRatio },
      },
      service: s.service,
      route: `${s.method} ${s.route}`,
      ...(handler ? { path: handler.file, line: handler.line } : {}),
    });
  });
  const errorProne = stats
    .filter((s) => s.errorRatio >= 0.01 && s.rate > 0)
    .sort((a, b) => b.errorRatio - a.errorRatio)
    .slice(0, 3);
  for (const s of errorProne) {
    const handler = findHandler(input.index, s);
    findings.push({
      kind: 'error_prone_endpoint',
      title: `${s.method} ${s.route} (${s.service}) fails ${pct(s.errorRatio)} of requests`,
      body: [
        `Over the last ${input.window}: ${pct(s.errorRatio)} of ${rps(s.rate)} answered with a 5xx status.`,
        handler
          ? `Handler: \`${handler.file}\` line ${handler.line}.`
          : `I could not find the handler for ${s.method} ${s.route} in this repository.`,
      ].join('\n\n'),
      evidence: {
        metric: HTTP_METRIC,
        window: input.window,
        query: queries.errors,
        values: { error_ratio: s.errorRatio, requests_per_second: s.rate },
      },
      service: s.service,
      route: `${s.method} ${s.route}`,
      ...(handler ? { path: handler.file, line: handler.line } : {}),
    });
  }
  return { findings, stats };
}

// ---------------------------------------------------------------------------
// R3 and R4: a pull request
// ---------------------------------------------------------------------------

const ROUTE_DEFINITION = [
  /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/,
  /^\s*@(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/,
];
const INSTRUMENT =
  /\b(?:create(Counter|Histogram|UpDownCounter|ObservableGauge|Gauge)|create_(counter|histogram|up_down_counter|observable_gauge|gauge))\(\s*['"`]([^'"`]+)['"`]/;
const UNIT = /unit\s*[:=]\s*['"`]([^'"`]+)['"`]/;
const ATTRIBUTE_KEYS = /['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"]\s*:/g;
const ATTRIBUTE_CALL = /\.(add|record|set)\(|Observation\(|attributes/;

const typeOf = (kind: string): MetricType =>
  /histogram/i.test(kind)
    ? 'histogram'
    : /counter/i.test(kind) && !/updown|up_down/i.test(kind)
      ? 'counter'
      : 'gauge';

/** The manifest of the service a file belongs to, at the pull request's head. */
function manifestFor(index: CodeIndex, file: string): Manifest | undefined {
  let dir = file.split('/').slice(0, -1);
  for (;;) {
    const found = index.manifests.find(
      (m) => m.path === [...dir, m.path.split('/').pop()].join('/'),
    );
    if (found?.manifest) return found.manifest;
    if (dir.length === 0) return undefined;
    dir = dir.slice(0, -1);
  }
}

/**
 * R3: the convention check. Only lines the pull request adds are judged, so a
 * finding is always about this change.
 */
export function conventionFindings(index: CodeIndex, files: PullFile[]): Finding[] {
  const findings: Finding[] = [];
  const window = 'this pull request';
  const add = (finding: Omit<Finding, 'kind'>) => findings.push({ kind: 'convention', ...finding });

  for (const file of files) {
    if (file.status === 'removed') continue;
    const { added } = parsePatch(file.patch);
    const manifest = manifestFor(index, file.filename);
    const declared = new Map((manifest?.metrics ?? []).map((m) => [m.name, m]));

    // A manifest the pull request changes must still be valid.
    const isManifest = index.manifests.find((m) => m.path === file.filename);
    if (isManifest && !isManifest.manifest) {
      add({
        title: 'The manifest is no longer valid',
        body: `\`${file.filename}\` does not parse: ${isManifest.error}`,
        evidence: { metric: HTTP_METRIC, window, rule: 'manifest-valid' },
        path: file.filename,
        line: added[0]?.line ?? 1,
      });
    }

    for (const { line, text } of added) {
      for (const pattern of ROUTE_DEFINITION) {
        const route = pattern.exec(text);
        if (!route || !manifest) continue;
        const method = route[1]!.toUpperCase();
        const path = route[2]!;
        if (!manifest.endpoints.some((e) => e.method === method && e.route === path)) {
          add({
            title: `${method} ${path} is not in the manifest`,
            body: `This adds ${method} ${path} to ${manifest.service}, but its manifest does not list it, so it will not show in the endpoint picker or the catalog. Add it to the manifest in this pull request.`,
            evidence: { metric: HTTP_METRIC, window, rule: 'endpoint-in-manifest' },
            service: manifest.service,
            route: `${method} ${path}`,
            path: file.filename,
            line,
          });
        }
      }

      const instrument = INSTRUMENT.exec(text);
      if (instrument) {
        const name = instrument[3]!;
        const kind = instrument[1] ?? instrument[2] ?? '';
        const unit = UNIT.exec(
          added
            .filter((a) => a.line >= line && a.line < line + 5)
            .map((a) => a.text)
            .join(' '),
        )?.[1];
        const where = {
          path: file.filename,
          line,
          ...(manifest ? { service: manifest.service } : {}),
        };
        if (
          /(^|\.)(http|server)\..*requests?(\.|$)|(^|\.)requests?\.(total|count)$/.test(name) &&
          /counter/i.test(kind)
        ) {
          add({
            title: `${name} is a separate request counter`,
            body: 'Request counts and error rates come from http.server.request.duration. Remove this counter.',
            evidence: { metric: name, window, rule: 'no-request-counter' },
            ...where,
          });
        }
        if (manifest && name.split('.')[0] === manifest.service.replace(/[^a-z0-9]+/g, '_')) {
          add({
            title: `${name} starts with the service's name`,
            body: `The service is recorded on every sample already. Name it ${name.slice(name.indexOf('.') + 1)}.`,
            evidence: { metric: name, window, rule: 'no-service-in-metric-name' },
            ...where,
          });
        }
        if (unit && /^(ms|us|ns|min|h|kb|mb|gb|kby|mby|gby|mib|kib)$/i.test(unit)) {
          add({
            title: `${name} uses ${unit}`,
            body: 'Use base units: seconds (`s`) for time, bytes (`By`) for size.',
            evidence: { metric: name, window, rule: 'base-units' },
            ...where,
          });
        }
        if (manifest && !declared.has(name)) {
          add({
            title: `${name} is not in the manifest`,
            body: `Add ${name} (${typeOf(kind)}${unit ? `, ${unit}` : ''}) to the manifest of ${manifest.service}, or it will not be in the catalog. It would be stored as ${storedMetricName(name, typeOf(kind), unit ?? '')}.`,
            evidence: { metric: name, window, rule: 'metric-in-manifest' },
            ...where,
          });
        }
      }

      if (ATTRIBUTE_CALL.test(text) || /^\s*['"][a-z][a-z0-9_.]*['"]\s*:/.test(text)) {
        for (const match of text.matchAll(ATTRIBUTE_KEYS)) {
          const problem = attributeProblem(match[1]!);
          if (!problem) continue;
          add({
            title: `The attribute ${match[1]} ${problem === 'bounded-attributes' ? 'has unbounded values' : 'looks personal or secret'}`,
            body:
              problem === 'bounded-attributes'
                ? 'An attribute needs a short fixed set of values. Every distinct value makes a new series.'
                : 'No user ids, emails, tokens or other personal or secret values in metric attributes.',
            evidence: { metric: '(the metric recorded on this line)', window, rule: problem },
            path: file.filename,
            line,
            ...(manifest ? { service: manifest.service } : {}),
          });
        }
      }
    }
  }
  // One finding per rule and line.
  return findings.filter(
    (f, i) =>
      findings.findIndex(
        (o) =>
          o.line === f.line &&
          o.path === f.path &&
          o.evidence.rule === f.evidence.rule &&
          o.title === f.title,
      ) === i,
  );
}

/**
 * R4: a comment on every measured endpoint whose handler the pull request
 * changes, with its numbers and how it ranks.
 */
export async function touchedEndpointFindings(input: {
  index: CodeIndex;
  files: PullFile[];
  query: QueryApiClient;
  window: string;
}): Promise<Finding[]> {
  const changed = new Map(input.files.map((f) => [f.filename, parsePatch(f.patch).changed]));
  const touched = input.index.routes.filter((r) => {
    const lines = changed.get(r.file);
    return r.service && lines && [...lines].some((line) => line >= r.span[0] && line <= r.span[1]);
  });
  if (touched.length === 0) return [];
  const stats = await endpointStats(
    input.query,
    [...new Set(touched.map((r) => r.service!))],
    input.window,
  );
  return touched.flatMap((route) => {
    const own = stats.filter((s) => s.service === route.service);
    const s = own.find((x) => x.method === route.method && x.route === route.route);
    if (!s) return [];
    const ranked = own.filter((x) => x.p95 !== null).sort((a, b) => b.p95! - a.p95!);
    const rank = ranked.indexOf(s) + 1;
    const standing =
      rank === 1
        ? `your slowest endpoint in ${s.service}`
        : rank > 0
          ? `#${rank} slowest of ${ranked.length} in ${s.service}`
          : s.service;
    return [
      {
        kind: 'touches_measured_endpoint' as const,
        title: `This changes ${s.method} ${s.route}, ${standing}`,
        body: `Over the last ${input.window}: p95 ${ms(s.p95)}, ${rps(s.rate)}, ${pct(s.errorRatio)} failed. After this is deployed, I will compare the numbers and note here if latency or errors move.`,
        evidence: {
          metric: HTTP_METRIC,
          window: input.window,
          query: statsQueries(input.window, [s.service]).p95,
          values: { p95_seconds: s.p95, requests_per_second: s.rate, error_ratio: s.errorRatio },
        },
        service: s.service,
        route: `${s.method} ${s.route}`,
        path: route.file,
        line: route.line,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// R5: after a deploy
// ---------------------------------------------------------------------------

/** How much p95 or errors must move for a note: a fifth more latency, or one point more errors. */
export const MOVED = { p95Ratio: 1.2, errorPoints: 0.01 };

/** Compare each changed endpoint before and after a deploy. Returns findings only where something moved. */
export async function deployFindings(input: {
  index: CodeIndex;
  files: PullFile[];
  query: QueryApiClient;
  deployedAt: number;
  window: string;
  now?: number;
}): Promise<Finding[]> {
  const changed = new Map(input.files.map((f) => [f.filename, parsePatch(f.patch).changed]));
  const touched = input.index.routes.filter((r) => {
    const lines = changed.get(r.file);
    return r.service && lines && [...lines].some((line) => line >= r.span[0] && line <= r.span[1]);
  });
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const findings: Finding[] = [];
  for (const route of touched) {
    const endpoint = { service: route.service!, method: route.method, route: route.route };
    const before = await windowStats(input.query, endpoint, input.window, input.deployedAt);
    const after = await windowStats(input.query, endpoint, input.window, now);
    if (before.p95 === null || after.p95 === null) continue;
    const slower = after.p95 >= before.p95 * MOVED.p95Ratio;
    const faster = after.p95 <= before.p95 / MOVED.p95Ratio;
    const moreErrors = (after.errorRatio ?? 0) - (before.errorRatio ?? 0) >= MOVED.errorPoints;
    if (!slower && !faster && !moreErrors) continue;
    const parts = [
      slower || faster ? `p95 went from ${ms(before.p95)} to ${ms(after.p95)}` : '',
      moreErrors
        ? `failed requests went from ${pct(before.errorRatio ?? 0)} to ${pct(after.errorRatio ?? 0)}`
        : '',
    ].filter(Boolean);
    findings.push({
      kind: 'post_deploy_regression',
      title: `After the deploy, ${route.method} ${route.route} ${slower || moreErrors ? 'got worse' : 'got faster'}`,
      body: `Comparing the ${input.window} before the deploy with the ${input.window} after it: ${parts.join('; ')}.`,
      evidence: {
        metric: HTTP_METRIC,
        window: `${input.window} before and after the deploy`,
        values: {
          p95_before: before.p95,
          p95_after: after.p95,
          errors_before: before.errorRatio,
          errors_after: after.errorRatio,
        },
      },
      service: route.service!,
      route: `${route.method} ${route.route}`,
      path: route.file,
      line: route.line,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// R8: architecture
// ---------------------------------------------------------------------------

export interface ServiceMap {
  services: string[];
  /** caller → callee, with calls per second and calls per request the caller handles. */
  edges: { from: string; to: string; address: string; rate: number; perRequest: number | null }[];
}

/** Which known service an address belongs to: `demo-inventory`, `inventory.internal` and `inventory` all mean inventory. */
export function serviceForAddress(address: string, known: string[]): string | undefined {
  const host = address.toLowerCase().split(':')[0]!;
  return known.find((s) => host === s) ?? known.find((s) => host.split(/[.-]/).includes(s));
}

/** The service map from the calls services really make, and findings about it. */
export async function architectureReview(input: {
  index: CodeIndex;
  query: QueryApiClient;
  window: string;
}): Promise<{ map: ServiceMap; findings: Finding[] }> {
  const known = services(input.index);
  const [calls, inbound, stats] = await Promise.all([
    outboundCalls(input.query, input.window),
    inboundRates(input.query, input.window),
    endpointStats(input.query, known, input.window),
  ]);
  const edges = calls
    .map((c) => {
      const to = serviceForAddress(c.address, known);
      const handled = inbound.get(c.caller);
      return to
        ? {
            from: c.caller,
            to,
            address: c.address,
            rate: c.rate,
            perRequest: handled ? c.rate / handled : null,
          }
        : undefined;
    })
    .filter((e): e is NonNullable<typeof e> => e !== undefined && e.from !== e.to);
  const findings: Finding[] = [];

  for (const edge of edges) {
    if (edge.perRequest !== null && edge.perRequest > 2) {
      findings.push({
        kind: 'chatty_pair',
        title: `${edge.from} calls ${edge.to} ${edge.perRequest.toFixed(1)} times per request`,
        body: `Over the last ${input.window}, ${edge.from} made ${rps(edge.rate)} to ${edge.to} while handling ${rps(inbound.get(edge.from) ?? 0)}. Batching these calls, or caching what does not change, would cut both services' load.`,
        evidence: {
          metric: 'http.client.request.duration',
          window: input.window,
          values: { calls_per_second: edge.rate, calls_per_request: edge.perRequest },
        },
        service: edge.from,
      });
    }
  }

  // A handler that calls another service on every request cannot succeed without it.
  for (const route of input.index.routes) {
    if (!route.service || route.calls.length === 0) continue;
    const edge = edges.find((e) => e.from === route.service);
    if (!edge) continue;
    findings.push({
      kind: 'single_point_of_failure',
      title: `${route.method} ${route.route} cannot succeed without ${edge.to}`,
      body: `The handler at \`${route.file}\` line ${route.line} calls ${edge.to} on every request, and ${route.service} has no other way to serve it. If ${edge.to} is down or slow, so is this endpoint. Consider a timeout and a fallback, or doing the call asynchronously.`,
      evidence: {
        metric: 'http.client.request.duration',
        window: input.window,
        values: { calls_per_second: edge.rate },
      },
      service: route.service,
      route: `${route.method} ${route.route}`,
      path: route.file,
      line: route.line,
    });
  }

  // Endpoints in a manifest that nothing called in the window.
  for (const { manifest } of input.index.manifests) {
    if (!manifest) continue;
    for (const endpoint of manifest.endpoints) {
      const seen = stats.find(
        (s) =>
          s.service === manifest.service &&
          s.method === endpoint.method &&
          s.route === endpoint.route,
      );
      if (!seen || seen.rate === 0) {
        findings.push({
          kind: 'unused_endpoint',
          title: `Nothing called ${endpoint.method} ${endpoint.route} (${manifest.service})`,
          body: `No requests over the last ${input.window}. If it is no longer needed, removing it shrinks what has to be maintained.`,
          evidence: {
            metric: HTTP_METRIC,
            window: input.window,
            values: { requests_per_second: 0 },
          },
          service: manifest.service,
          route: `${endpoint.method} ${endpoint.route}`,
        });
      }
    }
  }
  return { map: { services: known, edges }, findings };
}
