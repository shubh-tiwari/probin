import { describe, expect, it } from 'vitest';
import { healthOf, scorecardFrom, type EndpointFlow } from './data.js';
import { dotPlot, flowMap, gauge } from './draw.js';

const endpoint = (over: Partial<EndpointFlow>): EndpointFlow => ({
  service: 'checkout',
  method: 'GET',
  route: '/x',
  rate: 1,
  p95: 0.05,
  errorRatio: 0,
  health: 'ok',
  ...over,
});

describe('endpoint health', () => {
  it.each([
    [{ p95: 0.05, errorRatio: 0 }, 'ok'],
    [{ p95: 1.2, errorRatio: 0 }, 'slow'],
    [{ p95: 0.05, errorRatio: 0.02 }, 'slow'],
    [{ p95: 2.4, errorRatio: 0 }, 'very_slow'],
    [{ p95: 0.05, errorRatio: 0.06 }, 'failing'],
    [{ p95: null, errorRatio: 0 }, 'ok'],
  ] as const)('%o is %s', (stats, health) => {
    expect(healthOf(stats)).toBe(health);
  });
});

describe('the request scorecard', () => {
  it('splits cumulative buckets into latency bands, with errors apart', () => {
    const buckets = new Map([
      [0.25, 900],
      [0.5, 950],
      [1, 980],
      [2.5, 995],
      [Infinity, 1000],
    ]);
    expect(scorecardFrom(buckets, 12)).toEqual({
      normal: 950,
      slow: 30,
      verySlow: 15,
      stalled: 5,
      errors: 12,
    });
  });

  it('is all zero with no requests', () => {
    expect(scorecardFrom(new Map(), 0)).toEqual({
      normal: 0,
      slow: 0,
      verySlow: 0,
      stalled: 0,
      errors: 0,
    });
  });
});

describe('the flow map', () => {
  it('draws each endpoint with its numbers and marks the unhealthy ones', () => {
    const { svg } = flowMap({
      endpoints: [
        endpoint({ route: '/fast', rate: 2 }),
        endpoint({ route: '/slow', p95: 2.4, health: 'very_slow' }),
      ],
      calls: [{ from: 'checkout', to: 'inventory', known: true, rate: 0.8 }],
    });
    expect(svg).toContain('GET /fast');
    expect(svg).toContain('p95 2400 ms');
    expect(svg).toContain('Very slow');
    expect(svg).toContain('0.8 calls/s from checkout');
    expect(svg).toContain('aria-label="Request flow: GET /fast OK; GET /slow Very slow"');
  });

  it('says so when nothing was requested', () => {
    expect(flowMap({ endpoints: [], calls: [] }).svg).toContain('No requests in this range.');
  });

  it('escapes names from the metrics', () => {
    const { svg } = flowMap({ endpoints: [endpoint({ route: '/<script>' })], calls: [] });
    expect(svg).not.toContain('<script>');
  });
});

describe('small charts', () => {
  it('marks points over the threshold in the bad colour', () => {
    const svg = dotPlot(
      [
        [1, 0.4],
        [2, 1.3],
      ],
      { label: String, threshold: 1 },
    );
    expect(svg.match(/class="ov-bad"/g)).toHaveLength(1);
    expect(svg).toContain('ov-threshold');
  });

  it('labels the gauge with the failed share', () => {
    expect(gauge(0.0123)).toContain('1.23% of requests failed');
  });
});
