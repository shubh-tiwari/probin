import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { displayUnit, formatValue, seriesName } from './format.js';

/**
 * The shared formatting cases in testdata/format.json. The Python agent runs
 * the same file, so both languages write a value the same way.
 */
const cases = JSON.parse(
  readFileSync(new URL('../../../testdata/format.json', import.meta.url), 'utf8'),
) as {
  format: { unit: string; wanted: string | null; value: number | string; text: string }[];
  seriesNames: { labels: Record<string, string>; name: string }[];
};

describe('shared formatting cases', () => {
  it.each(cases.format)(
    '$value in $unit (as $wanted) is "$text"',
    ({ unit, wanted, value, text }) => {
      const v = typeof value === 'string' ? Number(value) : value;
      expect(formatValue(v, displayUnit(unit, wanted ?? undefined))).toBe(text);
    },
  );
  it.each(cases.seriesNames)('series name of $labels is "$name"', ({ labels, name }) => {
    expect(seriesName(labels)).toBe(name);
  });
});
