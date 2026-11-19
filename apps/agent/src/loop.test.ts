import { parsePanelSpec } from '@app/specs';
import { describe, expect, it } from 'vitest';
import { checkGrounding } from './grounding.js';
import { InvalidEventError, advance, newRequest } from './loop.js';
import { CATALOG, createHarness } from './testing.js';
import { ToolRefusal, createToolbox, type ResolvedRequest } from './tools.js';
import type { AgentOutput, AgentState } from './types.js';

const request = (text: string) => newRequest({ workspaceId: 'w', userId: 'u1', text });

/** Start a request and answer every question with the given values, in order. */
async function run(text: string, answers: string[] = [], harness = createHarness()) {
  const state = request(text);
  const outputs: AgentOutput[] = [await advance(state, { type: 'start' }, harness.deps)];
  for (const value of answers) {
    outputs.push(await advance(state, { type: 'answer', value }, harness.deps));
  }
  return { state, outputs, last: outputs.at(-1)!, harness };
}

const EXAMPLE = 'latency graph of checkout service in last 5 hr';

describe('the build plan example', () => {
  it('asks which endpoint, with real endpoints, tags and "all combined" last', async () => {
    const { last } = await run(EXAMPLE);
    expect(last).toMatchObject({ kind: 'question', questionsLeft: 1 });
    if (last.kind !== 'question') return;
    expect(last.question).toEqual({
      id: 'endpoint',
      kind: 'endpoint',
      text: 'Which endpoint?',
      options: [
        { value: 'POST /checkout/pay', label: 'POST /checkout/pay', tags: ['Slowest'] },
        { value: 'GET /checkout/summary', label: 'GET /checkout/summary', tags: ['Busiest'] },
        { value: 'all', label: 'All endpoints combined' },
      ],
    });
  });

  it('then asks one more question, and defaults the rest', async () => {
    const { outputs, last, state } = await run(EXAMPLE, ['POST /checkout/pay', '95']);
    expect(outputs.map((o) => o.kind)).toEqual(['question', 'question', 'draft']);
    expect(outputs[1]).toMatchObject({ question: { id: 'percentile' }, questionsLeft: 0 });
    expect(state.questionsAsked).toEqual(['endpoint', 'percentile']);
    expect(state.defaulted).toEqual(['requests']);
    expect(last.kind).toBe('draft');
  });

  it('produces the panel spec from the plan', async () => {
    const { last } = await run(EXAMPLE, ['POST /checkout/pay', '95']);
    if (last.kind !== 'draft') throw new Error('expected a draft');
    expect(last.panel).toEqual({
      title: 'POST /checkout/pay · p95 latency',
      type: 'timeseries',
      query:
        'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))',
      unit: 's',
      display_unit: 'ms',
      range: '5h',
      thresholds: [],
      request: EXAMPLE,
      assumptions: ['p95', 'all requests including failures', 'all regions combined'],
    });
    expect(() => parsePanelSpec(last.panel)).not.toThrow();
  });
});

describe('questions', () => {
  it('never asks more than two, whatever is ambiguous', async () => {
    // No service named, so: service, endpoint, then defaults for the rest.
    const { state, outputs } = await run('latency', ['checkout', 'all']);
    expect(outputs.map((o) => o.kind)).toEqual(['question', 'question', 'draft']);
    expect(state.questionsAsked).toEqual(['service', 'endpoint']);
    expect(state.defaulted).toEqual(['percentile', 'requests']);
    expect(state.decisions).toMatchObject({ percentile: 95, requests: 'all' });
  });

  it('asks nothing when the request already says everything', async () => {
    const { outputs, state } = await run(
      'p99 latency of POST /checkout/pay on checkout service including failures in last 30 min',
    );
    expect(outputs.map((o) => o.kind)).toEqual(['draft']);
    expect(state.questionsAsked).toEqual([]);
    expect(state.decisions).toEqual({
      service: 'checkout',
      endpoint: { method: 'POST', route: '/checkout/pay' },
      percentile: 99,
      requests: 'all',
    });
  });

  it('does not ask about endpoints when the service has only one', async () => {
    const { state, last } = await run('p95 latency of inventory service including failures');
    expect(last.kind).toBe('draft');
    expect(state.decisions.endpoint).toEqual({ method: 'GET', route: '/items/{id}' });
  });

  it('does not ask about endpoints or percentiles for a business metric', async () => {
    const { outputs, state } = await run('orders completed on checkout service in last 24 hours');
    expect(outputs.map((o) => o.kind)).toEqual(['draft']);
    expect(state.decisions).toEqual({ service: 'checkout' });
    if (outputs[0]!.kind === 'draft') {
      expect(outputs[0]!.panel.query).toBe(
        'sum (rate(orders_completed_total{service_name="checkout"}[5m]))',
      );
    }
  });

  it('does not ask which endpoint when the chart is split by endpoint', async () => {
    const { state, last } = await run(
      'p95 latency of checkout service by endpoint including failures in last 6 hours',
    );
    expect(state.questionsAsked).toEqual([]);
    expect(last).toMatchObject({
      kind: 'draft',
      panel: {
        query:
          'histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[5m])))',
        assumptions: ['p95', 'all requests including failures', 'all regions combined'],
      },
    });
  });

  it('refuses an answer that is not one of the options, and keeps waiting', async () => {
    const { state, harness } = await run(EXAMPLE);
    await expect(
      advance(state, { type: 'answer', value: 'DELETE /everything' }, harness.deps),
    ).rejects.toThrow(InvalidEventError);
    expect(state.status).toBe('question');
    expect(state.questionsAsked).toEqual(['endpoint']);
  });

  it('the tool itself refuses a third question', () => {
    const state: AgentState = { ...request('x'), questionsAsked: ['endpoint', 'percentile'] };
    const tools = createToolbox(state, createHarness().deps.backends);
    expect(() =>
      tools.askUser({ id: 'requests', kind: 'choice', text: '?', options: [
        { value: 'a', label: 'a' }, { value: 'b', label: 'b' },
      ] }),
    ).toThrow(ToolRefusal);
  }); // prettier-ignore
});

describe('saved answers', () => {
  it('uses the person’s saved answers instead of asking, and says what it assumed', async () => {
    const harness = createHarness();
    const state = newRequest({
      workspaceId: 'w',
      userId: 'u1',
      text: 'latency of POST /checkout/pay on checkout service',
      userDefaults: { percentile: 99, requests: 'successful_only' },
    });
    const out = await advance(state, { type: 'start' }, harness.deps);
    expect(state.questionsAsked).toEqual([]);
    expect(state.fromUserDefaults).toEqual(['percentile', 'requests']);
    expect(out).toMatchObject({
      kind: 'draft',
      panel: { assumptions: expect.arrayContaining(['p99', 'successful requests only']) },
    });
  });

  it('offers to save only the percentile and request answers, never the endpoint', async () => {
    const { rememberableAnswers } = await import('./loop.js');
    const { state } = await run(EXAMPLE, ['POST /checkout/pay', '50']);
    expect(rememberableAnswers(state)).toEqual({ percentile: 50 });
  });
});

describe('resolved-request cache', () => {
  function cachedHarness() {
    const store = new Map<string, ResolvedRequest>();
    let fingerprint = 'v1';
    const harness = createHarness();
    harness.deps.backends.resolved = {
      get: async (key) => store.get(key),
      put: async (key, entry) => void store.set(key, entry),
      fingerprint: async () => fingerprint,
      names: async () => ({
        metrics: CATALOG.metrics.flatMap((m) => m.series),
        labels: [...new Set(CATALOG.metrics.flatMap((m) => m.labels))],
      }),
    };
    return { harness, store, changeCatalog: () => (fingerprint = 'v2') };
  }
  const TEXT =
    'p95 latency of POST /checkout/pay on checkout service including failures in last 1 hour';

  it('reuses the query for the same words: no model call, still dry-run', async () => {
    const { harness, store } = cachedHarness();
    await run(TEXT, [], harness);
    expect(store.size).toBe(1);
    const calls = harness.modelCalls.length;
    const runs = harness.dryRuns.length;
    const { last, state } = await run(`  ${TEXT.toUpperCase()}? `, [], harness);
    expect(harness.modelCalls.length).toBe(calls);
    expect(harness.dryRuns.length).toBe(runs + 1);
    expect(state.fromCache).toBe(true);
    expect(last).toMatchObject({
      kind: 'draft',
      panel: {
        assumptions: expect.arrayContaining(['the same choices as the last time this was asked']),
      },
    });
  });

  it('does not reuse it once the catalog of its service has changed', async () => {
    const { harness, changeCatalog } = cachedHarness();
    await run(TEXT, [], harness);
    changeCatalog();
    const calls = harness.modelCalls.length;
    const { state } = await run(TEXT, [], harness);
    expect(state.fromCache).toBeUndefined();
    expect(harness.modelCalls.length).toBeGreaterThan(calls);
  });

  it('does not reuse a query that no longer passes the dry run', async () => {
    const { harness } = cachedHarness();
    await run(TEXT, [], harness);
    let empty = true;
    const dryRun = harness.deps.backends.dryRun;
    harness.deps.backends.dryRun = async (q, r) =>
      empty
        ? ((empty = false), { ok: true, lineCount: 0, durationMs: 1, sample: [] })
        : dryRun(q, r);
    const { state } = await run(TEXT, [], harness);
    expect(state.fromCache).toBeUndefined();
    expect(state.status).toBe('draft');
  });
});

describe('alerts', () => {
  it('turns “alert me if … above 800 ms for 5 min” into a pending rule on a tested query', async () => {
    const harness = createHarness();
    const state = newRequest({
      workspaceId: 'w',
      userId: 'u1',
      text: 'alert me if p95 latency of POST /checkout/pay on checkout service including failures goes above 800 ms for 5 min',
      channel: '#C0OPS',
    });
    const out = await advance(state, { type: 'start' }, harness.deps);
    expect(out).toMatchObject({ kind: 'alert', ruleId: 'rule-1' });
    const [rule] = harness.alerts;
    expect(rule).toMatchObject({
      status: 'pending',
      for: '5m',
      channel: '#C0OPS',
      comparison: { op: '>', threshold: 0.8 },
      expr: `(${rule!.query}) > 0.8`,
      service: 'checkout',
    });
    expect(rule!.name).toBe('POST /checkout/pay · p95 latency above 800 ms');
    expect(state.testedQueries).toContain(rule!.query);
  });

  it('suggests a threshold from the data for “Alert me on this”, and says so', async () => {
    const harness = createHarness({
      dryRun: () => ({
        sample: [{ labels: {}, points: 3, first: 0.4, last: 0.6, min: 0.4, max: 0.72 }],
      }),
    });
    const { state } = await run(
      'p95 latency of POST /checkout/pay on checkout service including failures in last 1 hour',
      [],
      harness,
    );
    const out = await advance(state, { type: 'alert' }, harness.deps);
    expect(out).toMatchObject({
      kind: 'alert',
      rule: { comparison: { op: '>', threshold: 0.8 }, status: 'pending' },
    });
    expect(harness.alerts[0]!.assumptions).toEqual(
      expect.arrayContaining([
        'threshold suggested from the data: just above the highest value in 1h',
        'must hold for 5m (default)',
      ]),
    );
  });

  it('refuses an alert from a request with no chart', async () => {
    const harness = createHarness();
    const { state } = await run('latency graph of checkout service in last 5 hr', [], harness);
    await expect(advance(state, { type: 'alert' }, harness.deps)).rejects.toThrow(
      InvalidEventError,
    );
  });

  it('the draft_alert tool refuses a rule whose query skipped the dry run', async () => {
    const state = request('x');
    const tools = createToolbox(state, createHarness().deps.backends);
    await expect(
      tools.draftAlert({
        name: 'x',
        expr: '(up) > 1',
        for: '5m',
        severity: 'warning',
        channel: '#a',
        status: 'pending',
        query: 'up',
      }),
    ).rejects.toMatchObject({ rule: 'dry_run_before_display' });
  });
});

describe('data sources', () => {
  it('turns “monitor <url> every minute” into a pending collector after a test fetch', async () => {
    const harness = createHarness();
    const { last } = await run(
      'monitor https://status.example.com/health every minute',
      [],
      harness,
    );
    expect(last).toMatchObject({
      kind: 'collector',
      collectorId: 'collector-1',
      spec: {
        name: 'status.example.com/health',
        interval: '1m',
        status: 'pending',
        config: { url: 'https://status.example.com/health' },
      },
      test: { ok: true, status: 200 },
    });
    expect(harness.modelCalls.filter((c) => c.task === 'write_query')).toEqual([]);
  });

  it('refuses an interval under 30 seconds', async () => {
    const { last } = await run('monitor https://example.com/health every 5 seconds');
    expect(last).toMatchObject({
      kind: 'no_match',
      message: expect.stringContaining('30 seconds'),
    });
  });
});

describe('refining a chart', () => {
  it('changes the range and adds a split, keeping the earlier answers, with no questions', async () => {
    const { state: base, harness } = await run(EXAMPLE, ['POST /checkout/pay', '99']);
    const { seedRefinement } = await import('./loop.js');
    const state = seedRefinement({
      workspaceId: 'w',
      userId: 'u1',
      text: 'split by method in last 24 hours',
      base: { kind: 'request', state: base },
    });
    const out = await advance(
      state,
      { type: 'refine', text: 'split by method in last 24 hours' },
      harness.deps,
    );
    expect(state.questionsAsked).toEqual([]);
    expect(out).toMatchObject({
      kind: 'draft',
      panel: {
        range: '24h',
        query:
          'histogram_quantile(0.99, sum by (le, http_request_method) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))',
      },
    });
    const writes = harness.modelCalls.filter((c) => c.task === 'write_query');
    expect(writes.at(-1)!.messages.at(-1)!.content).toContain('"base_query"');
  });

  it('reads a saved panel’s decisions back from its query, and saves a new version of it', async () => {
    const { decisionsFromQuery, seedRefinement } = await import('./loop.js');
    const query =
      'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))';
    expect(decisionsFromQuery(query)).toEqual({
      service: 'checkout',
      endpoint: { method: 'POST', route: '/checkout/pay' },
      percentile: 95,
      requests: 'all',
    });
    const harness = createHarness();
    const panel = {
      title: 't',
      type: 'timeseries' as const,
      query,
      unit: 's',
      thresholds: [],
      request: 'latency of pay',
      assumptions: [],
    };
    const state = seedRefinement({
      workspaceId: 'w',
      userId: 'u1',
      text: 'p50 instead',
      base: { kind: 'panel', panel, panelId: 'panel-7' },
    });
    const out = await advance(state, { type: 'refine', text: 'median instead' }, harness.deps);
    expect(out).toMatchObject({
      kind: 'draft',
      panel: { query: expect.stringContaining('histogram_quantile(0.5,') },
    });
    await advance(state, { type: 'confirm' }, harness.deps);
    expect(harness.saved[0]![3]).toBe('panel-7');
  });
});

describe('nothing matches', () => {
  it('says so and never calls the model to write a query', async () => {
    const { last, harness } = await run('cpu temperature of checkout service');
    expect(last.kind).toBe('no_match');
    if (last.kind === 'no_match') expect(last.message).toMatch(/Nothing in the catalog matches/);
    expect(harness.modelCalls.filter((call) => call.task === 'write_query')).toEqual([]);
    expect(harness.dryRuns).toEqual([]);
  });

  it('names the services it knows when the service is unknown', async () => {
    const { last } = await run('latency of billing service');
    expect(last).toMatchObject({
      kind: 'no_match',
      message: expect.stringContaining('checkout, inventory'),
    });
  });

  it('names the real endpoints when the endpoint is unknown', async () => {
    const { last } = await run('latency of /checkout/refund on checkout service');
    expect(last).toMatchObject({
      kind: 'no_match',
      message: expect.stringContaining('POST /checkout/pay, GET /checkout/summary'),
    });
  });
});

const reply = (query: string) =>
  JSON.stringify({ query, title: 't', unit: 's', display_unit: null });
const GOOD = 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout"}[5m]))';
const READY = 'p95 latency of all endpoints on checkout service including failures';

describe('catalog grounding', () => {
  it('rejects an invented metric name in code; it never reaches the dry run', async () => {
    const harness = createHarness({
      writeQuery: (attempt) =>
        attempt === 1 ? reply('sum(rate(http_requests_total[5m]))') : reply(GOOD),
    });
    const { last, state } = await run(READY, [], harness);
    expect(state.attempts[0]).toMatchObject({
      number: 1,
      ungrounded: ['metric: http_requests_total'],
      failure: expect.stringContaining('not in the catalog'),
    });
    expect(harness.dryRuns.map((run) => run.query)).toEqual([GOOD]);
    expect(last).toMatchObject({ kind: 'draft', panel: { query: GOOD } });
    expect(
      harness.ledger.calls.filter((c) => c.task === 'write_query').map((c) => c.outcome),
    ).toEqual(['ungrounded', 'ok']);
  });

  it('rejects an invented label and a selector with no metric name', async () => {
    const bad = [
      'sum by (customer_id) (rate(http_server_request_duration_seconds_count[5m]))',
      'sum({service_name="checkout"})',
      'sum({__name__=~"http_.*"})',
    ];
    const harness = createHarness({ writeQuery: (attempt) => reply(bad[attempt - 1]!) });
    const { last, state } = await run(READY, [], harness);
    expect(last.kind).toBe('failed');
    expect(state.attempts.map((a) => a.ungrounded?.[0])).toEqual([
      'label: customer_id',
      'selector without one exact metric: {service_name="checkout"}',
      'selector without one exact metric: {__name__=~"http_.*"}',
    ]);
    expect(harness.dryRuns).toEqual([]);
    expect(state.draft).toBeUndefined();
  });

  it('tells the model what was wrong so it can fix it', async () => {
    const harness = createHarness({
      writeQuery: (attempt) => (attempt === 1 ? reply('made_up_metric') : reply(GOOD)),
    });
    await run(READY, [], harness);
    const second = harness.modelCalls.filter((call) => call.task === 'write_query')[1]!;
    expect(second.messages.at(-1)!.content).toContain('"query": "made_up_metric"');
    expect(second.messages.at(-1)!.content).toContain('metric: made_up_metric');
  });

  it('allows exactly the names the search returned', () => {
    const allowed = { metrics: ['a_bucket'], labels: ['le', 'job'] };
    expect(checkGrounding('sum by (le) (rate(a_bucket{job="x"}[5m]))', allowed)).toEqual({
      ok: true,
    });
    expect(checkGrounding('a_bucket{', allowed).ok).toBe(false);
    expect(checkGrounding('vector(1)', allowed)).toEqual({ ok: true });
  });
});

describe('dry run before display', () => {
  it('a query that errors or returns nothing is retried, up to three attempts', async () => {
    const harness = createHarness({
      writeQuery: () => reply(GOOD),
      dryRun: () => ({ lineCount: 0 }),
    });
    const { last, state } = await run(READY, [], harness);
    expect(state.attempts).toHaveLength(3);
    expect(last).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('returned no data'),
    });
    expect(state.draft).toBeUndefined();
    expect(state.testedQueries).toEqual([]);
  });

  it('moves to a stronger model after two failures', async () => {
    let runs = 0;
    const harness = createHarness({
      writeQuery: () => reply(GOOD),
      dryRun: () => {
        runs += 1;
        return runs < 3
          ? {
              ok: false,
              lineCount: 0,
              error: { code: 'too_many_lines', message: 'Too many lines.' },
            }
          : {};
      },
    });
    const { last, state } = await run(READY, [], harness);
    expect(last.kind).toBe('draft');
    expect(state.attempts.map((a) => [a.model, a.escalated])).toEqual([
      ['test-fast', false],
      ['test-fast', false],
      ['test-strong', true],
    ]);
    const calls = harness.ledger.calls.filter((c) => c.task === 'write_query');
    expect(calls[2]!.escalatedFrom).toBe(calls[1]!.id);
  });

  it('handles a reply that is not JSON as a failed attempt', async () => {
    const harness = createHarness({
      writeQuery: (attempt) => (attempt === 1 ? 'Sure! Here is your query.' : reply(GOOD)),
    });
    const { last, state } = await run(READY, [], harness);
    expect(last.kind).toBe('draft');
    expect(state.attempts[0]!.failure).toMatch(/not the JSON/);
  });

  it('the save tool refuses a query that has not passed a dry run here', async () => {
    const { state, harness } = await run(READY);
    const tools = createToolbox(state, harness.deps.backends);
    await expect(
      tools.savePanel({ ...state.draft!, query: `${GOOD} * 2` }, undefined),
    ).rejects.toMatchObject({ rule: 'dry_run_before_display' });
    expect(harness.saved).toEqual([]);
  });
});

describe('saving', () => {
  it('saves nothing until the person confirms', async () => {
    const { state, harness } = await run(READY);
    expect(state.status).toBe('draft');
    expect(harness.saved).toEqual([]);
    const saved = await advance(state, { type: 'confirm', dashboardId: 'dash-9' }, harness.deps);
    expect(saved).toEqual({ kind: 'saved', panelId: 'panel-1', version: 1, dashboardId: 'dash-9' });
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]![1]).toEqual({ kind: 'user', id: 'u1' });
    expect(harness.saved[0]![0]).toMatchObject({ request: READY, assumptions: expect.any(Array) });
  });

  it('cannot confirm a request that has no draft', async () => {
    const { state, harness } = await run(EXAMPLE);
    await expect(advance(state, { type: 'confirm' }, harness.deps)).rejects.toThrow(
      InvalidEventError,
    );
  });
});

describe('budget', () => {
  it('pauses building at the cap and says why', async () => {
    const harness = createHarness({ budgetLimit: 0 });
    const { last } = await run(EXAMPLE, [], harness);
    expect(last).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('model budget'),
    });
    expect(harness.modelCalls).toEqual([]);
  });
});

describe('state', () => {
  it('is plain data: a request survives being stored between events', async () => {
    const harness = createHarness();
    const first = request(EXAMPLE);
    await advance(first, { type: 'start' }, harness.deps);
    const restored = JSON.parse(JSON.stringify(first)) as AgentState;
    await advance(restored, { type: 'answer', value: 'all' }, harness.deps);
    const out = await advance(restored, { type: 'answer', value: '50' }, harness.deps);
    expect(out).toMatchObject({
      kind: 'draft',
      panel: {
        assumptions: [
          'p50',
          'all requests including failures',
          'all endpoints combined',
          'all regions combined',
        ],
      },
    });
  });

  it('only allows names from the catalog fixture', async () => {
    const { state } = await run(READY);
    const known = new Set(CATALOG.metrics.flatMap((m) => m.series));
    expect(state.allowed.metrics.every((name) => known.has(name))).toBe(true);
  });
});
