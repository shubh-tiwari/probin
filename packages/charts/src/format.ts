/**
 * Units and numbers as people read them. Shared by chart axes, the one-line
 * reading in Slack, and the web tool.
 */

export interface DisplayUnit {
  /** Multiply a value in the query's unit by this to get the display unit. */
  factor: number;
  /** Shown after the number. Empty for plain counts. */
  suffix: string;
  /** Whether the suffix needs a space before it ("12 req/s", but "12%"). */
  spaced: boolean;
}

const KNOWN: Record<string, Record<string, DisplayUnit>> = {
  s: {
    s: { factor: 1, suffix: 's', spaced: false },
    ms: { factor: 1000, suffix: 'ms', spaced: true },
  },
  '1': {
    '1': { factor: 1, suffix: '', spaced: false },
    '%': { factor: 100, suffix: '%', spaced: false },
  },
  By: {
    By: { factor: 1, suffix: 'B', spaced: true },
  },
};

/** How to show values of a query in `unit`, asked to be shown in `displayUnit`. */
export function displayUnit(unit: string, wanted?: string): DisplayUnit {
  const fromUnit = KNOWN[unit];
  if (fromUnit && wanted && fromUnit[wanted]) return fromUnit[wanted];
  if (fromUnit && fromUnit[unit]) return fromUnit[unit];
  // An annotation such as {order} or {order}/s reads as a word.
  const plain = unit.replace(/\{([^}]*)\}/g, '$1').replace(/^1$/, '');
  return { factor: 1, suffix: plain, spaced: true };
}

/** A number with three significant digits at most, without trailing zeros. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  if (abs === 0) return '0';
  if (abs >= 100) return String(Math.round(value));
  return trim(value);
}

const trim = (value: number) => String(Number(value.toPrecision(3)));

/** A value in the query's unit, shown in the display unit. */
export function formatValue(value: number, unit: DisplayUnit): string {
  const shown = formatNumber(value * unit.factor);
  if (!unit.suffix) return shown;
  return unit.spaced ? `${shown} ${unit.suffix}` : `${shown}${unit.suffix}`;
}

/** A label set as a short legend entry. `{}` reads as "all". */
export function seriesName(labels: Record<string, string>): string {
  const values = Object.entries(labels)
    .filter(([key]) => key !== '__name__')
    .map(([, value]) => value);
  return values.length > 0 ? values.join(' · ') : 'all';
}

/** "5h" as "the last 5 hours". */
export function describeRange(range: string): string {
  const match = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(range);
  if (!match) return range;
  const count = Number(match[1]);
  const words: Record<string, string> = {
    ms: 'millisecond', s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', y: 'year',
  }; // prettier-ignore
  const word = words[match[2]!]!;
  return count === 1 ? `the last ${word}` : `the last ${count} ${word}s`;
}
