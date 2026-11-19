import { displayUnit, formatNumber, formatValue } from '@app/charts';
import type { Call, EndpointFlow, Health, Overview } from './data.js';

/**
 * SVG for the overview page. Colours come from CSS classes (`ov-*`), so the
 * page's light or dark theme decides them.
 */

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ms = displayUnit('s', 'ms');
const pct = displayUnit('1', '%');

export const HEALTH_CLASS: Record<Health, string> = {
  ok: 'ov-good',
  slow: 'ov-warn',
  very_slow: 'ov-bad',
  failing: 'ov-bad',
};
export const HEALTH_WORD: Record<Health, string> = {
  ok: 'OK',
  slow: 'Slow',
  very_slow: 'Very slow',
  failing: 'Failing',
};

/** A band between two vertical spans, curving from left to right. */
function band(x1: number, y1: number, x2: number, y2: number, w1: number, w2: number) {
  const mx = (x1 + x2) / 2;
  return (
    `M ${x1} ${y1 - w1 / 2} C ${mx} ${y1 - w1 / 2}, ${mx} ${y2 - w2 / 2}, ${x2} ${y2 - w2 / 2} ` +
    `L ${x2} ${y2 + w2 / 2} C ${mx} ${y2 + w2 / 2}, ${mx} ${y1 + w1 / 2}, ${x1} ${y1 + w1 / 2} Z`
  );
}

export interface FlowLayout {
  width: number;
  height: number;
  svg: string;
}

/**
 * The request flow: traffic into each service, through its endpoints, and the
 * calls it makes to other services. Band width is requests per second; colour
 * is the endpoint's health.
 */
export function flowMap(overview: Pick<Overview, 'endpoints' | 'calls'>, width = 960): FlowLayout {
  const { endpoints, calls } = overview;
  if (endpoints.length === 0) {
    return {
      width,
      height: 120,
      svg: `<svg viewBox="0 0 ${width} 120" width="100%" role="img" aria-label="No requests in this range"><text x="${width / 2}" y="64" text-anchor="middle" class="ov-muted" font-size="15">No requests in this range.</text></svg>`,
    };
  }
  const ROW = 64;
  const GAP = 22;
  const services = [...new Set(endpoints.map((e) => e.service))];
  const max = Math.max(...endpoints.map((e) => e.rate), ...calls.map((c) => c.rate), 0.0001);
  const thick = (rate: number) => Math.max(3, Math.min(34, (rate / max) * 34));
  const ax = 16,
    aw = 150; // traffic in
  const bx = 320,
    bw = 300; // endpoints
  const cx = width - 190,
    cw = 174; // calls out

  // Rows: endpoints grouped by service, with a gap between services.
  const rows = new Map<EndpointFlow, number>();
  const spans = new Map<string, [number, number]>();
  let y = 24;
  for (const service of services) {
    const start = y;
    for (const e of endpoints.filter((x) => x.service === service)) {
      rows.set(e, y + ROW / 2);
      y += ROW;
    }
    spans.set(service, [start, y]);
    y += GAP;
  }
  const height = Math.max(y, 24 + calls.length * (ROW + GAP)) + 8;

  const parts: string[] = [];
  // Service nodes (traffic in), and bands to each endpoint.
  for (const service of services) {
    const [top, bottom] = spans.get(service)!;
    const mine = endpoints.filter((e) => e.service === service);
    const total = mine.reduce((sum, e) => sum + e.rate, 0);
    parts.push(
      `<rect x="${ax}" y="${top + 4}" width="${aw}" height="${bottom - top - 8}" rx="12" class="ov-node"/>`,
      `<text x="${ax + 14}" y="${top + 28}" class="ov-strong" font-size="14">${esc(service)}</text>`,
      `<text x="${ax + 14}" y="${top + 46}" class="ov-muted" font-size="12">${formatNumber(total)} req/s in</text>`,
    );
    let cursor = (top + bottom) / 2 - mine.reduce((s, e) => s + thick(e.rate), 0) / 2;
    for (const e of mine) {
      const w = thick(e.rate);
      const from = cursor + w / 2;
      cursor += w;
      parts.push(
        `<path d="${band(ax + aw, from, bx, rows.get(e)!, w, w)}" class="ov-band ${HEALTH_CLASS[e.health]}"/>`,
      );
    }
  }
  // Endpoint nodes.
  for (const e of endpoints) {
    const cy = rows.get(e)!;
    const facts = [
      e.p95 !== null ? `p95 ${formatValue(e.p95, ms)}` : 'no latency yet',
      `${formatNumber(e.rate)}/s`,
      `${formatValue(e.errorRatio, pct)} failed`,
    ].join(' · ');
    parts.push(
      `<rect x="${bx}" y="${cy - ROW / 2 + 5}" width="${bw}" height="${ROW - 10}" rx="10" class="ov-node"/>`,
      `<rect x="${bx}" y="${cy - ROW / 2 + 5}" width="4" height="${ROW - 10}" rx="2" class="${HEALTH_CLASS[e.health]}"/>`,
      `<text x="${bx + 16}" y="${cy - 4}" class="ov-strong" font-size="13">${esc(`${e.method} ${e.route}`)}</text>`,
      `<text x="${bx + 16}" y="${cy + 14}" class="ov-muted" font-size="11.5">${esc(facts)}</text>`,
    );
    if (e.health !== 'ok') {
      parts.push(
        `<text x="${bx + bw - 12}" y="${cy - 4}" text-anchor="end" font-size="11.5" font-weight="600" class="ov-text-${HEALTH_CLASS[e.health].slice(3)}">${HEALTH_WORD[e.health]}</text>`,
      );
    }
  }
  // Calls out: from the caller's block of endpoints to the service called.
  calls.forEach((call: Call, i) => {
    const span = spans.get(call.from);
    if (!span) return;
    const w = thick(call.rate);
    const cy = 24 + i * (ROW + GAP) + ROW / 2;
    parts.push(
      `<path d="${band(bx + bw, (span[0] + span[1]) / 2, cx, cy, w, w)}" class="ov-band ov-call"/>`,
      `<rect x="${cx}" y="${cy - ROW / 2 + 5}" width="${cw}" height="${ROW - 10}" rx="10" class="ov-node"/>`,
      `<text x="${cx + 14}" y="${cy - 4}" class="ov-strong" font-size="13">${esc(call.to)}</text>`,
      `<text x="${cx + 14}" y="${cy + 14}" class="ov-muted" font-size="11.5">${formatNumber(call.rate)} calls/s from ${esc(call.from)}</text>`,
    );
  });
  const heads = [
    [ax, 'Traffic in'],
    [bx, 'Endpoints'],
    ...(calls.length ? [[cx, 'Calls out'] as const] : []),
  ] as const;
  const labels = heads
    .map(
      ([x, text]) =>
        `<text x="${x}" y="12" class="ov-muted" font-size="11.5" letter-spacing="0.04em">${text}</text>`,
    )
    .join('');
  const summary = endpoints
    .map((e) => `${e.method} ${e.route} ${HEALTH_WORD[e.health]}`)
    .join('; ');
  return {
    width,
    height,
    svg: `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(`Request flow: ${summary}`)}" font-family="inherit">${labels}${parts.join('')}</svg>`,
  };
}

/**
 * A dot plot over time: one dot per step on a faint stem. Dots at or above
 * `threshold` are drawn in the bad colour, and the highest point is labelled.
 */
export function dotPlot(
  points: [number, number][],
  options: { label: (v: number) => string; threshold?: number; width?: number; height?: number },
): string {
  const width = options.width ?? 320;
  const height = options.height ?? 140;
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" aria-hidden="true"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="ov-muted" font-size="12">No data</text></svg>`;
  }
  const values = points.map((p) => p[1]);
  const high = Math.max(...values);
  const low = Math.min(...values);
  // Show the threshold only when the values come near it; otherwise it flattens the data.
  const showThreshold = options.threshold !== undefined && high >= options.threshold * 0.6;
  const top = Math.max(high, showThreshold ? options.threshold! : 0) * 1.08 || 1;
  const spread = Math.max(top - low, top * 0.15);
  const bottom = Math.max(0, top - spread * 1.6);
  const x = (i: number) => 8 + (i / Math.max(1, points.length - 1)) * (width - 16);
  const y = (v: number) => height - 8 - ((v - bottom) / (top - bottom || 1)) * (height - 30);
  const peak = values.indexOf(Math.max(...values));
  const dots = points
    .map(([, v], i) => {
      const bad = options.threshold !== undefined && v >= options.threshold;
      return (
        `<line x1="${x(i)}" x2="${x(i)}" y1="${height - 6}" y2="${y(v)}" class="ov-stem"/>` +
        `<circle cx="${x(i)}" cy="${y(v)}" r="3.2" class="${bad ? 'ov-bad' : 'ov-good'}"/>`
      );
    })
    .join('');
  const line = showThreshold
    ? `<line x1="0" x2="${width}" y1="${y(options.threshold!)}" y2="${y(options.threshold!)}" class="ov-threshold"/>`
    : '';
  const tagX = Math.min(Math.max(x(peak), 30), width - 30);
  const tag = `<rect x="${tagX - 26}" y="${y(values[peak]!) - 24}" width="52" height="16" rx="8" class="ov-tag"/><text x="${tagX}" y="${y(values[peak]!) - 12}" text-anchor="middle" font-size="10" class="ov-strong">${esc(options.label(values[peak]!))}</text>`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" aria-hidden="true">${line}${dots}${tag}</svg>`;
}

/** A half-dial for the failed share of requests, 0 to `max`. */
export function gauge(ratio: number, max = 0.05, width = 260): string {
  const cx = width / 2;
  const cy = 118;
  const r = 96;
  const ticks: string[] = [];
  const N = 44;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = Math.PI * (1 - t);
    const cls = t < 0.4 ? 'ov-good' : t < 0.7 ? 'ov-warn' : 'ov-bad';
    ticks.push(
      `<line x1="${cx + Math.cos(a) * (r - 18)}" y1="${cy - Math.sin(a) * (r - 18)}" x2="${cx + Math.cos(a) * r}" y2="${cy - Math.sin(a) * r}" class="${cls}-stroke" stroke-width="3" stroke-linecap="round"/>`,
    );
  }
  const t = Math.max(0, Math.min(1, ratio / max));
  const a = Math.PI * (1 - t);
  const needle = `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * (r - 6)}" y2="${cy - Math.sin(a) * (r - 6)}" class="ov-needle" stroke-width="4" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="6" class="ov-needle-dot"/>`;
  const scale = `<text x="${cx - r}" y="${cy + 18}" text-anchor="middle" font-size="10" class="ov-muted">0%</text><text x="${cx + r}" y="${cy + 18}" text-anchor="middle" font-size="10" class="ov-muted">${formatValue(max, pct)}</text>`;
  return `<svg viewBox="0 0 ${width} 140" width="100%" role="img" aria-label="${esc(`${formatValue(ratio, pct)} of requests failed`)}">${ticks.join('')}${needle}${scale}</svg>`;
}
