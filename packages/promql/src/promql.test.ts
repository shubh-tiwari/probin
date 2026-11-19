import { describe, expect, it } from 'vitest';
import { PromqlError, analyze, extractNames, injectLabel } from './index.js';

const W = 'workspace';
const ID = '0b3f1d5e-6a57-4c1b-9d0a-2f8f3f1c9a10';
const scoped = `${W}="${ID}"`;

describe('extractNames', () => {
  it('reads the build plan example', () => {
    const query =
      'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))';
    expect(extractNames(query)).toEqual({
      metrics: ['http_server_request_duration_seconds_bucket'],
      labels: ['http_request_method', 'http_route', 'le', 'service_name'],
      unnamedSelectors: [],
    });
  });

  it('finds every metric in a binary expression', () => {
    const names = extractNames(
      'sum(rate(errors_total{job="a"}[5m])) / ignoring(code) group_left(team) sum(rate(requests_total[5m]))',
    );
    expect(names.metrics).toEqual(['errors_total', 'requests_total']);
    expect(names.labels).toEqual(['code', 'job', 'team']);
  });

  it('reads metric names written as __name__ or as a quoted name', () => {
    expect(extractNames('{__name__="up", job="a"}').metrics).toEqual(['up']);
    expect(extractNames('{"http.server.duration", job="a"}').metrics).toEqual([
      'http.server.duration',
    ]);
  });

  it('reports selectors that do not name one exact metric', () => {
    expect(extractNames('{job="a"}').unnamedSelectors).toEqual(['{job="a"}']);
    expect(extractNames('{__name__=~"http_.*"}').unnamedSelectors).toEqual([
      '{__name__=~"http_.*"}',
    ]);
    expect(extractNames('up{__name__!="x"}').unnamedSelectors).toHaveLength(1);
  });

  it('counts label arguments of relabelling functions as labels', () => {
    expect(extractNames('label_replace(up, "dst", "$1", "src", "(.*)")').labels).toEqual([
      'dst',
      'src',
    ]);
    expect(extractNames('label_join(up, "dst", "-", "a", "b")').labels).toEqual(['a', 'b', 'dst']);
  });

  it('reads quoted label names', () => {
    expect(extractNames('up{"service.name"="a"}').labels).toEqual(['service.name']);
  });

  it('has no names for a query that reads no series', () => {
    expect(extractNames('vector(1) + 2')).toEqual({
      metrics: [],
      labels: [],
      unnamedSelectors: [],
    });
  });
});

describe('analyze', () => {
  it.each(['', '   ', 'foo{', 'sum(', 'foo bar', 'rate(foo[5m]', 'foo{a=}', 'foo{a="b"', '1 +'])(
    'refuses invalid PromQL: %j',
    (query) => {
      expect(() => analyze(query)).toThrow(PromqlError);
    },
  );

  it('refuses functions that read series the query does not name', () => {
    expect(() => analyze('info(up)')).toThrow(/info\(\) is not allowed/);
  });

  it('lists the functions a query calls', () => {
    expect(analyze('histogram_quantile(0.9, rate(a_bucket[5m]))').functions).toEqual([
      'histogram_quantile',
      'rate',
    ]);
  });
});

describe('injectLabel', () => {
  const cases: [string, string][] = [
    ['up', `up{${scoped}}`],
    ['up{}', `up{${scoped}}`],
    ['up{job="a"}', `up{${scoped},job="a"}`],
    ['{job="a"}', `{${scoped},job="a"}`],
    ['{__name__=~".+"}', `{${scoped},__name__=~".+"}`],
    ['{"http.server.duration"}', `{${scoped},"http.server.duration"}`],
    ['rate(up[5m])', `rate(up{${scoped}}[5m])`],
    ['up offset 5m', `up{${scoped}} offset 5m`],
    ['up @ 1700000000', `up{${scoped}} @ 1700000000`],
    ['max_over_time(up[1h:5m])', `max_over_time(up{${scoped}}[1h:5m])`],
    ['a + b', `a{${scoped}} + b{${scoped}}`],
    ['a or b or c', `a{${scoped}} or b{${scoped}} or c{${scoped}}`],
    ['a / on(job) group_left(team) b', `a{${scoped}} / on(job) group_left(team) b{${scoped}}`],
    ['sum by (job) (rate(a[5m]))', `sum by (job) (rate(a{${scoped}}[5m]))`],
    ['topk(5, a) unless b{x="y"}', `topk(5, a{${scoped}}) unless b{${scoped},x="y"}`],
    [
      'label_replace(a, "dst", "$1", "src", "(.*)")',
      `label_replace(a{${scoped}}, "dst", "$1", "src", "(.*)")`,
    ],
    ['a{job="x} y"}', `a{${scoped},job="x} y"}`],
    ['absent(a{job="x"})', `absent(a{${scoped},job="x"})`],
    ['vector(1)', 'vector(1)'],
    ['time() - 60', 'time() - 60'],
  ];

  it.each(cases)('scopes %s', (query, expected) => {
    expect(injectLabel(query, W, ID)).toBe(expected);
  });

  it('scopes every selector in a deeply nested query', () => {
    const query =
      'sum(rate(a{x="1"}[5m])) by (job) / (sum(rate(b[5m])) by (job) + count(c{y=~"z.*"}[10m:1m]))';
    const rewritten = injectLabel(query, W, ID);
    const selectors = analyze(rewritten).selectors;
    expect(selectors).toHaveLength(3);
    for (const selector of selectors) {
      expect(selector.matchers).toContainEqual({ label: W, op: '=', value: ID });
    }
  });

  // Each of these tries to read, widen or disguise the workspace label.
  const hostile = [
    `up{${W}="other"}`,
    `up{${W}=~".*"}`,
    `up{${W}!="${ID}"}`,
    `up{"${W}"="other"}`,
    `up{job="a", ${W}=~".+"}`,
    `up or up{${W}="other"}`,
    `sum by (${W}) (up)`,
    `sum without (${W}) (up)`,
    `count by (${W}) ({__name__=~".+"})`,
    `a / on(${W}) b`,
    `a / ignoring(${W}) b`,
    `a * on(job) group_left(${W}) b`,
    `label_replace(up, "${W}", "other", "job", ".*")`,
    `label_replace(up, "x", "$1", "${W}", "(.*)")`,
    `label_join(up, "${W}", "-", "job")`,
    `label_join(up, "x", "-", "job", "${W}")`,
  ];

  it.each(hostile)('refuses %s', (query) => {
    expect(() => injectLabel(query, W, ID)).toThrow(PromqlError);
  });

  it('refuses a query that does not parse', () => {
    expect(() => injectLabel(`up{job="a"} or up{`, W, ID)).toThrow(PromqlError);
  });

  it('refuses an unsafe value rather than write it into the query', () => {
    expect(() => injectLabel('up', W, 'a"} or up{x="')).toThrow(/unsafe characters/);
    expect(() => injectLabel('up', 'bad label', ID)).toThrow(/not a valid label name/);
  });

  it('a label value that looks like a matcher is still only a value', () => {
    const rewritten = injectLabel(`up{job="${W}=\\"other\\""}`, W, ID);
    expect(analyze(rewritten).selectors[0]?.matchers).toEqual([
      { label: W, op: '=', value: ID },
      { label: 'job', op: '=', value: `${W}="other"` },
    ]);
  });
});
