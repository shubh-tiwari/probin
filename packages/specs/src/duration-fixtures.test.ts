import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { durationToSeconds } from './common.js';

/** The shared duration cases in testdata/durations.json, which the Python agent runs too. */
const cases = JSON.parse(
  readFileSync(new URL('../../../testdata/durations.json', import.meta.url), 'utf8'),
) as { input: string; seconds: number | null }[];

describe('shared duration cases', () => {
  it.each(cases)('"$input" is $seconds seconds', ({ input, seconds }) => {
    if (seconds === null) expect(() => durationToSeconds(input)).toThrow();
    else expect(durationToSeconds(input)).toBe(seconds);
  });
});
