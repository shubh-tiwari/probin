import type { CompletionRequest, CompletionResponse, ModelTransport } from '@app/router';
import { standInHypothesis } from './explain.js';
import { readBlock, type WriteContext } from './prompts.js';
import type { MeasureKind, ParsedRequest, WrittenQuery } from './types.js';

/**
 * A stand-in for the model, used when no model key is configured.
 *
 * It is NOT the product's model and makes no network calls. It answers the
 * two prompts the agent sends with fixed rules: a keyword parser, and a few
 * query templates. That is enough to run the whole loop, its guards and the
 * test set end to end without spending anything. It handles plain requests
 * only, so its pass rate says nothing about the real gate.
 */
export const STAND_IN_MODEL = 'stand-in';

const WORDS: Record<Exclude<MeasureKind, 'other'>, RegExp> = {
  errors: /\b(errors?|error rate|failures?|failure rate|fails?|failing|5xx|500s?)\b/i,
  latency: /\b(latenc(y|ies)|slow(est|er)?|response times?|durations?|how long|speed|p\d{2})\b/i,
  traffic: /\b(traffic|requests?|rps|throughput|hits|calls|load|busy|busiest)\b/i,
};

const RANGE_UNITS: Record<string, string> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', week: 'w', weeks: 'w',
}; // prettier-ignore

const RANGE = new RegExp(
  `\\b(?:(?:in|over|for|during)\\s+)?(?:the\\s+)?(?:last|past|previous)\\s+(\\d+)?\\s*(${Object.keys(RANGE_UNITS).join('|')})\\b`,
  'i',
);

export function standInParse(text: string): ParsedRequest {
  const lower = text.toLowerCase();

  let range: string | null = null;
  const rangeMatch = RANGE.exec(text);
  if (rangeMatch) range = `${rangeMatch[1] ?? '1'}${RANGE_UNITS[rangeMatch[2]!.toLowerCase()]}`;
  else if (/\btoday\b/.test(lower)) range = '24h';
  else if (/\bthis week\b/.test(lower)) range = '7d';

  let percentile: number | null = null;
  const p =
    /\bp(\d{2}(?:\.\d)?)\b/i.exec(text) ?? /\b(\d{2})(?:th|st|nd|rd)\s+percentile\b/i.exec(text);
  if (p) percentile = Number(p[1]);
  else if (/\b(median|typical)\b/.test(lower)) percentile = 50;

  // Latency wins over errors, which win over traffic: "latency of failed
  // requests" is about latency. "Including failures" says which requests to
  // count, not what to measure, so it is set aside first.
  const subject = text.replace(/\b(including|excluding|counting) (failures|errors)\b/gi, ' ');
  let kind: MeasureKind = 'other';
  if (WORDS.latency.test(subject)) kind = 'latency';
  else if (WORDS.errors.test(subject)) kind = 'errors';
  else if (WORDS.traffic.test(subject)) kind = 'traffic';

  let requests: ParsedRequest['requests'] = null;
  if (kind !== 'errors') {
    if (/\b(failed|failing|error) requests?\b|\bfailed only\b/.test(lower))
      requests = 'failed_only';
    else if (/\bsuccessful\b|\bexcluding (failures|errors)\b/.test(lower))
      requests = 'successful_only';
    else if (/\bincluding (failures|errors)\b/.test(lower)) requests = 'all';
  }

  const route = /(?:^|\s)(\/[A-Za-z0-9_\-/{}:.]+)/.exec(text)?.[1] ?? null;
  const method = /\b(GET|POST|PUT|PATCH|DELETE)\b/.exec(text)?.[1] ?? null;
  const allEndpoints = /\ball (endpoints|routes)\b|\bacross endpoints\b/.test(lower);

  const service =
    /\b([a-z][a-z0-9-]*)\s+(?:service|api|app)\b/i.exec(text)?.[1] ??
    /\b(?:service|api|app)\s+([a-z][a-z0-9-]*)\b/i.exec(text)?.[1] ??
    null;

  let chart: ParsedRequest['chart'] = null;
  if (/\bbar( chart| graph)?\b/.test(lower)) chart = 'bar';
  else if (/\b(single number|stat|right now|current(ly)?|how many .* now)\b/.test(lower))
    chart = 'stat';
  else if (/\b(line|graph|chart|over time|trend|timeseries)\b/.test(lower)) chart = 'timeseries';

  const split: string[] = [];
  const splitMatch =
    /\b(?:split by|broken down by|grouped by|group by|per|by|for each)\s+([a-z ]+?)(?=\s+(?:in|over|for|during|last|past|of|on|and)\b|[,.]|$)/i.exec(
      text,
    );
  if (splitMatch && !/^(the|a|an)$/.test(splitMatch[1]!.trim())) {
    const words = splitMatch[1]!.trim();
    // "per second" and the like are units, not splits.
    if (!/^(second|minute|hour|day|sec|min)s?$/.test(words)) split.push(words);
  }

  const measure =
    text
      .replace(RANGE, ' ')
      .replace(
        /\b(show|give|get|plot|graph|chart|me|the|a|an|of|for|in|please|i want to see)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim() || text;

  // Alerts: "alert me if <thing> goes above 800 ms for 5 min".
  const alertMatch =
    /\b(alert|notify|tell|page|ping)\b.*?\b(above|over|more than|exceeds?|greater than|below|under|less than)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|%|percent)?/i.exec(
      text,
    );
  let alert: ParsedRequest['alert'] = null;
  if (alertMatch) {
    const forMatch =
      /\bfor\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(text);
    const unitWord = alertMatch[4]?.toLowerCase();
    alert = {
      op: /above|over|more|exceed|greater/i.test(alertMatch[2]!) ? '>' : '<',
      threshold: Number(alertMatch[3]),
      unit: !unitWord
        ? null
        : unitWord.startsWith('ms') || unitWord.startsWith('milli')
          ? 'ms'
          : unitWord.startsWith('s')
            ? 's'
            : '%',
      for: forMatch ? `${forMatch[1]}${RANGE_UNITS[forMatch[2]!.toLowerCase()] ?? 'm'}` : null,
    };
  }

  // Data sources: "monitor https://example.com/health every minute".
  const urlMatch = /\b(monitor|check|poll|watch)\b.*?(https?:\/\/\S+)/i.exec(text);
  let collector: ParsedRequest['collector'] = null;
  if (urlMatch) {
    const every =
      /\bevery\s+(\d+)?\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hours?)\b/i.exec(text);
    collector = {
      url: urlMatch[2]!.replace(/[.,)]+$/, ''),
      interval: every ? `${every[1] ?? '1'}${RANGE_UNITS[every[2]!.toLowerCase()] ?? 'm'}` : null,
    };
  }
  const intent: ParsedRequest['intent'] = collector ? 'collector' : alert ? 'alert' : 'chart';

  // In "alert me if X goes above 800 ms", the measure is X and the threshold is not a range.
  const watched = alert
    ? text.replace(
        alertMatch![0].slice(
          alertMatch![0].search(
            /\b(above|over|more than|exceeds?|greater than|below|under|less than)\b/i,
          ),
        ),
        ' ',
      )
    : text;

  return {
    intent,
    alert,
    collector,
    measure: alert
      ? watched
          .replace(/\b(alert|notify|tell|page|ping) me( if| when)?\b/gi, ' ')
          .replace(/\b(goes|is|gets)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim() || measure
      : measure,
    kind,
    service:
      service && !['the', 'my', 'our', 'this', 'that'].includes(service.toLowerCase())
        ? service
        : null,
    endpoint: route ? { method, route } : null,
    all_endpoints: allEndpoints,
    percentile,
    requests,
    range,
    chart,
    split_by: split,
  };
}

const SPLIT_SYNONYMS: Record<string, string[]> = {
  endpoint: ['route'],
  endpoints: ['route'],
  path: ['route'],
  url: ['route'],
  verb: ['method'],
  code: ['status'],
  type: ['method'],
};

/** The stored label a split phrase means, if the metric has one. */
function resolveSplit(phrase: string, labels: string[]): string | undefined {
  const wanted = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((word) => [word, word.replace(/s$/, ''), ...(SPLIT_SYNONYMS[word] ?? [])]);
  let best: { label: string; score: number } | undefined;
  for (const label of labels) {
    if (label === 'le') continue;
    const parts = label.split('_');
    const score = wanted.filter((word) => parts.includes(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { label, score };
  }
  return best?.label;
}

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function standInWriteQuery(context: WriteContext): WrittenQuery {
  const metric = context.metrics[0]!;
  const stored = metric.series[0]!.replace(/_bucket$/, '');
  const { labels } = context;

  const matchers: string[] = [];
  if (context.service) matchers.push(`${labels.service}=${quote(context.service)}`);
  if (context.endpoint && labels.route) {
    matchers.push(`${labels.route}=${quote(context.endpoint.route)}`);
    if (labels.method) matchers.push(`${labels.method}=${quote(context.endpoint.method)}`);
  }
  const statusMatcher =
    labels.status && context.requests === 'failed_only'
      ? `${labels.status}=~"5.."`
      : labels.status && context.requests === 'successful_only'
        ? `${labels.status}!~"5.."`
        : undefined;
  const selector = (extra?: string) => {
    const all = [...matchers, ...(statusMatcher ? [statusMatcher] : []), ...(extra ? [extra] : [])];
    return all.length > 0 ? `{${all.join(', ')}}` : '';
  };

  const splits = context.split_by
    .map((phrase) => resolveSplit(phrase, metric.labels))
    .filter((label): label is string => label !== undefined);
  const by = (extra: string[] = []) => {
    const all = [...extra, ...splits];
    return all.length > 0 ? ` by (${all.join(', ')})` : '';
  };
  const window = `[${context.rate_window}]`;

  const target = context.endpoint
    ? `${context.endpoint.method} ${context.endpoint.route}`
    : (context.service ?? 'All services');
  const histogram = metric.type === 'histogram';

  if (histogram && (context.kind === 'latency' || context.kind === 'other')) {
    const percentile = context.percentile ?? 95;
    return {
      query: `histogram_quantile(${percentile / 100}, sum${by(['le'])} (rate(${stored}_bucket${selector()}${window})))`,
      title: `${target} · p${percentile} ${context.kind === 'latency' ? 'latency' : metric.name}`,
      unit: metric.unit,
      display_unit: metric.unit === 's' ? 'ms' : null,
    };
  }
  if (histogram && context.kind === 'errors' && labels.status) {
    const failed = `sum${by()} (rate(${stored}_count${selector(`${labels.status}=~"5.."`)}${window}))`;
    const all = `sum${by()} (rate(${stored}_count${selector()}${window}))`;
    // With no failures in the window there are no failed series at all, and the
    // division would return nothing. `or vector(0)` makes that a plain zero.
    const numerator = splits.length === 0 ? `(${failed} or vector(0))` : failed;
    return {
      query: `${numerator} / ${all}`,
      title: `${target} · error rate`,
      unit: '1',
      display_unit: '%',
    };
  }
  if (histogram) {
    return {
      query: `sum${by()} (rate(${stored}_count${selector()}${window}))`,
      title: `${target} · requests per second`,
      unit: 'req/s',
      display_unit: null,
    };
  }
  if (metric.type === 'counter') {
    return {
      query: `sum${by()} (rate(${stored}${selector()}${window}))`,
      title: `${target} · ${metric.name} per second`,
      unit: `${metric.unit || '1'}/s`,
      display_unit: null,
    };
  }
  return {
    query: `sum${by()} (${stored}${selector()})`,
    title: `${target} · ${metric.name}`,
    unit: metric.unit || '1',
    display_unit: null,
  };
}

/** The stand-in as a transport, so it goes through the router like any model. */
export function createStandInTransport(): ModelTransport {
  return {
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      let reply: unknown;
      if (request.task === 'parse') {
        reply = standInParse(readBlock(request.messages, 'request') ?? '');
      } else if (request.task === 'write_query') {
        reply = standInWriteQuery(
          JSON.parse(readBlock(request.messages, 'context') ?? '{}') as WriteContext,
        );
      } else if (request.task === 'explain') {
        reply = { hypothesis: standInHypothesis(request.messages) };
      } else {
        throw new Error(`The stand-in model cannot do "${request.task}" tasks.`);
      }
      return {
        content: JSON.stringify(reply),
        model: STAND_IN_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
    },
  };
}
