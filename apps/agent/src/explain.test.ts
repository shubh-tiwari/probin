import { describe, expect, it } from 'vitest';
import {
  measureChanges,
  rankChanges,
  relatedQueries,
  standInHypothesis,
  explainMessages,
} from './explain.js';
import { CATALOG } from './testing.js';

const result = (series: { labels: Record<string, string>; values: number[] }[]) => ({
  series: series.map((s) => ({ labels: s.labels, points: s.values.map((v, i) => [i * 60, v] as [number, number]) })),
  start: 0, end: 0, step: 60, lineCount: series.length, durationMs: 1, cached: false,
}); // prettier-ignore

describe('explaining an alert', () => {
  it('looks at traffic, errors and latency of the same service', () => {
    const titles = relatedQueries('checkout', CATALOG.metrics).map((q) => q.title);
    expect(titles).toEqual([
      'checkout · p95 latency by endpoint',
      'checkout · requests per second by endpoint',
      'checkout · failed requests per second by endpoint',
    ]);
  });

  it('ranks the lines that moved most around the start of the alert', () => {
    const source = { title: 't', query: 'q', unit: 's' };
    const changes = measureChanges(
      source,
      result([
        { labels: { r: 'steady' }, values: [1, 1, 1, 1, 1, 1] },
        { labels: { r: 'doubled' }, values: [1, 1, 1, 2, 2, 2] },
        { labels: { r: 'halved' }, values: [4, 4, 4, 2, 2, 2] },
        { labels: { r: 'tripled' }, values: [1, 1, 1, 3, 3, 3] },
      ]),
      180,
    );
    expect(rankChanges(changes).map((c) => c.labels.r)).toEqual(['tripled', 'doubled', 'halved']);
  });

  it('labels the explanation as a hypothesis, even with nothing to go on', () => {
    expect(standInHypothesis(explainMessages({ alert: { name: 'x' }, changes: [] }))).toMatch(
      /^Hypothesis: /,
    );
    expect(
      standInHypothesis(
        explainMessages({
          alert: { name: 'x' },
          changes: [{ series: 'a', before: '1', after: '3' }],
        }),
      ),
    ).toBe(
      'Hypothesis: this is likely related to a, which moved from 1 to 3 around the time the alert started.',
    );
  });
});
