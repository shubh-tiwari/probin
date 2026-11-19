import type { PanelSpec } from '@app/specs';
import { describe, expect, it } from 'vitest';
import {
  displayUnit,
  formatNumber,
  formatValue,
  niceTicks,
  readChart,
  renderSvg,
  svgToPng,
  type ChartSeries,
} from './index.js';

const panel: PanelSpec = {
  title: 'POST /checkout/pay · p95 latency',
  type: 'timeseries',
  query: 'x',
  unit: 's',
  display_unit: 'ms',
  range: '5h',
  thresholds: [],
  request: 'latency graph of checkout service in last 5 hr',
  assumptions: [],
};

const line = (labels: Record<string, string>, values: number[]): ChartSeries => ({
  labels,
  points: values.map((value, i) => [1_700_000_000 + i * 60, value]),
});

describe('formatting', () => {
  it.each([
    [0.812, 's', 'ms', '812 ms'],
    [1.9, 's', 'ms', '1900 ms'],
    [0.0213, '1', '%', '2.13%'],
    [1.17, 'req/s', undefined, '1.17 req/s'],
    [3, '{order}/s', undefined, '3 order/s'],
    [12500, '', undefined, '12.5k'],
  ])('%d in %s shown as %s is %s', (value, unit, wanted, expected) => {
    expect(formatValue(value, displayUnit(unit, wanted))).toBe(expected);
  });

  it('keeps three significant digits', () => {
    expect(formatNumber(0.0012345)).toBe('0.00123');
    expect(formatNumber(123.456)).toBe('123');
  });

  it('chooses round axis ticks', () => {
    expect(niceTicks(0, 0.93)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
  });
});

describe('the one-line reading', () => {
  it('reads one line with its latest value and range', () => {
    expect(readChart(panel, [line({}, [0.64, 1.9, 0.812])], '6h')).toBe(
      'P95 latency was 812 ms most recently, between 640 ms and 1900 ms over the last 5 hours.',
    );
  });

  it('names the highest and lowest of several lines', () => {
    const reading = readChart(
      panel,
      [line({ http_route: '/a' }, [0.1, 0.2]), line({ http_route: '/b' }, [0.5, 0.9])],
      '6h',
    );
    expect(reading).toBe(
      '2 lines over the last 5 hours. Highest most recently: /b at 900 ms; lowest: /a at 200 ms.',
    );
  });

  it('says so when there is no data', () => {
    expect(readChart(panel, [], '6h')).toBe('No data in the last 5 hours.');
  });
});

describe('rendering', () => {
  const series = [
    line({ http_route: '/a' }, [0.1, 0.3, 0.2]),
    line({ http_route: '/b' }, [0.5, 0.4]),
  ];

  it('draws each line with its own dash pattern, so lines differ by more than colour', () => {
    const svg = renderSvg(panel, series);
    expect(svg).toContain('POST /checkout/pay · p95 latency');
    expect(svg.match(/<path d="M/g)).toHaveLength(2);
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('/b');
  });

  it('draws bars and a single number', () => {
    expect(renderSvg({ ...panel, type: 'bar' }, series)).toContain('<pattern id="p1"');
    expect(renderSvg({ ...panel, type: 'stat' }, [line({}, [0.25])])).toContain('250 ms');
  });

  it('escapes text from the request and labels', () => {
    const svg = renderSvg({ ...panel, title: 'a <b> & "c"' }, [
      line({ x: '<script>' }, [1, 2]),
      ...series,
    ]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
  });

  it('renders a PNG', () => {
    const png = svgToPng(renderSvg(panel, series));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(5000);
  }, 20_000);
});
