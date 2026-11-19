import {
  HTTP_CLIENT_DURATION,
  HTTP_SERVER_DURATION,
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  STATUS_LABEL,
  type CatalogMetric,
} from '@app/catalog';
import type { QueryResult } from '@app/query-api/client';
import type { Router } from '@app/router';
import { extractJson, readBlock } from './prompts.js';
import type { ChatMessage } from '@app/router';

/** A series considered as a cause, and how much it moved. */
export interface SeriesChange {
  title: string;
  query: string;
  unit: string;
  display_unit?: string;
  /** Mean before and after the change point, in the query's unit. */
  before: number;
  after: number;
  /** after / before; Infinity when it started from zero. */
  ratio: number;
  labels: Record<string, string>;
}

export interface Explanation {
  /** Always starts with "Hypothesis:". */
  hypothesis: string;
  /** The charts behind it, most changed first. */
  charts: { title: string; query: string; unit: string; display_unit?: string; range: string }[];
  changes: SeriesChange[];
}

const q = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The related series worth looking at for a service: traffic, errors, latency, and its own calls out. */
export function relatedQueries(service: string, metrics: CatalogMetric[]) {
  const s = `${SERVICE_LABEL}=${q(service)}`;
  const has = (stored: string) =>
    metrics.some((m) => m.service === service && m.storedName === stored);
  const out: { title: string; query: string; unit: string; display_unit?: string }[] = [];
  if (has(HTTP_SERVER_DURATION)) {
    const by = `${METHOD_LABEL}, ${ROUTE_LABEL}`;
    out.push(
      {
        title: `${service} · p95 latency by endpoint`,
        query: `histogram_quantile(0.95, sum by (le, ${by}) (rate(${HTTP_SERVER_DURATION}_bucket{${s}}[5m])))`,
        unit: 's',
        display_unit: 'ms',
      },
      {
        title: `${service} · requests per second by endpoint`,
        query: `sum by (${by}) (rate(${HTTP_SERVER_DURATION}_count{${s}}[5m]))`,
        unit: 'req/s',
      },
      {
        title: `${service} · failed requests per second by endpoint`,
        query: `sum by (${by}) (rate(${HTTP_SERVER_DURATION}_count{${s}, ${STATUS_LABEL}=~"5.."}[5m]))`,
        unit: 'req/s',
      },
    );
  }
  if (has(HTTP_CLIENT_DURATION)) {
    out.push({
      title: `${service} · p95 latency of calls to other services`,
      query: `histogram_quantile(0.95, sum by (le, server_address) (rate(${HTTP_CLIENT_DURATION}_bucket{${s}}[5m])))`,
      unit: 's',
      display_unit: 'ms',
    });
  }
  return out;
}

const mean = (values: number[]) =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

/** Split each line of a result at `pivot` and measure how much it moved. */
export function measureChanges(
  source: { title: string; query: string; unit: string; display_unit?: string },
  result: QueryResult,
  pivot: number,
): SeriesChange[] {
  return result.series.flatMap((series) => {
    const before = mean(series.points.filter((p) => p[0] < pivot).map((p) => p[1]));
    const after = mean(series.points.filter((p) => p[0] >= pivot).map((p) => p[1]));
    if (!Number.isFinite(before) || !Number.isFinite(after)) return [];
    const ratio = before === 0 ? (after === 0 ? 1 : Number.POSITIVE_INFINITY) : after / before;
    return [{ ...source, before, after, ratio, labels: series.labels }];
  });
}

/** How big a change is, either way: 2x up and 2x down score the same. */
const size = (change: SeriesChange) =>
  change.ratio === Number.POSITIVE_INFINITY
    ? 10
    : change.ratio <= 0
      ? 10
      : Math.abs(Math.log(change.ratio));

export function rankChanges(changes: SeriesChange[], minimum = 0.15): SeriesChange[] {
  return changes.filter((c) => size(c) >= minimum).sort((a, b) => size(b) - size(a));
}

const EXPLAIN_SYSTEM = `An alert fired. You are given the alert and how related series changed around the time it started. Write a short hypothesis about why, for an engineer on call.

Rules:
1. It is a hypothesis, not a finding. Start with "Hypothesis:" and use words such as "likely" or "may". Never claim a cause is certain.
2. Use only the series listed. Name the series and the numbers that support the hypothesis.
3. If nothing changed much, say that the related series do not explain it and suggest what to check.
4. At most three sentences.

Reply with one JSON object: {"hypothesis": "..."}`;

export function explainMessages(context: unknown): ChatMessage[] {
  return [
    { role: 'system', content: EXPLAIN_SYSTEM },
    { role: 'user', content: `<explain>\n${JSON.stringify(context, null, 2)}\n</explain>` },
  ];
}

/** The stand-in's hypothesis: names the biggest change. Used when no model key is set. */
export function standInHypothesis(messages: ChatMessage[]): string {
  const context = JSON.parse(readBlock(messages, 'explain') ?? '{}') as {
    alert?: { name?: string };
    changes?: { series: string; before: string; after: string }[];
  };
  const top = context.changes?.[0];
  if (!top)
    return 'Hypothesis: the related series did not change much, so they do not explain this. Check recent deploys and the services this one depends on.';
  const second = context.changes?.[1];
  return (
    `Hypothesis: this is likely related to ${top.series}, which moved from ${top.before} to ${top.after} around the time the alert started.` +
    (second ? ` ${second.series} also changed, from ${second.before} to ${second.after}.` : '')
  );
}

/** Ask the router for a hypothesis about the ranked changes. Enforces the "Hypothesis:" label. */
export async function writeHypothesis(
  router: Router,
  input: {
    workspaceId: string;
    requestId: string;
    alertName: string;
    changes: { series: string; before: string; after: string }[];
  },
): Promise<{ text: string; cost: number }> {
  const reply = await router.call({
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    task: 'explain',
    messages: explainMessages({ alert: { name: input.alertName }, changes: input.changes }),
    json: true,
    maxTokens: 400,
  });
  let text: string;
  try {
    text = String((extractJson(reply.content) as { hypothesis?: unknown }).hypothesis ?? '').trim();
  } catch {
    text = '';
  }
  if (!text) {
    await router.report(reply.callId, 'invalid_output');
    text = 'the related series could not be summarised.';
  }
  if (!/^hypothesis:/i.test(text)) text = `Hypothesis: ${text}`;
  return { text, cost: reply.cost };
}
