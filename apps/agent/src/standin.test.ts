import { describe, expect, it } from 'vitest';
import { standInParse } from './standin.js';
import { parsedRequestSchema } from './types.js';

describe('the stand-in parser', () => {
  it('always returns a valid parsed request', () => {
    for (const text of ['', 'x', 'latency', 'p95 of /a/b last 5 hr by region', '???']) {
      expect(() => parsedRequestSchema.parse(standInParse(text || 'anything'))).not.toThrow();
    }
  });

  it('reads the build plan example', () => {
    expect(standInParse('latency graph of checkout service in last 5 hr')).toMatchObject({
      kind: 'latency',
      service: 'checkout',
      endpoint: null,
      percentile: null,
      requests: null,
      range: '5h',
      chart: 'timeseries',
      split_by: [],
    });
  });

  it.each([
    ['in the last 30 minutes', '30m'],
    ['over the past 2 hours', '2h'],
    ['last hour', '1h'],
    ['for the last 7 days', '7d'],
    ['today', '24h'],
  ])('reads the range in “%s”', (phrase, range) => {
    expect(standInParse(`traffic ${phrase}`).range).toBe(range);
  });

  it.each([
    ['p99 latency', 99],
    ['median latency', 50],
    ['90th percentile latency', 90],
    ['latency', null],
  ])('reads the percentile in “%s”', (text, percentile) => {
    expect(standInParse(text).percentile).toBe(percentile);
  });

  it('tells what is measured from which requests are counted', () => {
    expect(standInParse('throughput of POST /pay including failures')).toMatchObject({
      kind: 'traffic',
      requests: 'all',
      endpoint: { method: 'POST', route: '/pay' },
    });
    expect(standInParse('p95 latency of failed requests')).toMatchObject({
      kind: 'latency',
      requests: 'failed_only',
    });
    expect(standInParse('error rate')).toMatchObject({ kind: 'errors', requests: null });
  });

  it('reads a split, and does not mistake a unit for one', () => {
    expect(standInParse('orders completed by payment method in the last 6 hours').split_by).toEqual(
      ['payment method'],
    );
    expect(standInParse('requests per second for checkout').split_by).toEqual([]);
  });
});
