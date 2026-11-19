import { readFileSync } from 'node:fs';
import { MANIFEST_FILENAME } from '@app/config';
import type { QueryApiClient } from '@app/query-api/client';
import type { AlertRuleSpec } from '@app/specs';
import { describe, expect, it } from 'vitest';
import { productionContext } from './context.js';

const demo = (path: string) =>
  readFileSync(new URL(`../../../infra/demo/${path}`, import.meta.url), 'utf8');

const SERVER = { path: 'checkout/server.cjs', content: demo('checkout-node/server.cjs') };
const MANIFEST = {
  path: `checkout/${MANIFEST_FILENAME}`,
  content: demo(`checkout-node/${MANIFEST_FILENAME}`),
};

const row = (method: string, route: string, value: number) => ({
  labels: { service_name: 'checkout', http_request_method: method, http_route: route },
  value,
});

/** A Query API that answers the three endpoint-stats queries with fixed numbers. */
const query = {
  instant: async (q: string) => {
    if (q.startsWith('histogram_quantile')) {
      return [
        row('POST', '/checkout/pay', 0.846),
        row('GET', '/checkout/summary', 0.032),
        row('GET', '/checkout/orders/:id', 0.015),
      ];
    }
    if (q.includes('5..')) return [row('POST', '/checkout/pay', 0.004)];
    return [
      row('POST', '/checkout/pay', 0.79),
      row('GET', '/checkout/summary', 2.1),
      row('GET', '/checkout/orders/:id', 0.4),
    ];
  },
} as unknown as QueryApiClient;

const RULE: { spec: AlertRuleSpec } = {
  spec: {
    name: 'POST /checkout/pay · p95 latency above 800 ms',
    expr: 'x > 0.8',
    for: '5m',
    severity: 'warning',
    channel: '#ops',
    status: 'pending',
    query:
      'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))',
    comparison: { op: '>', threshold: 0.8 },
    service: 'checkout',
  },
};

describe('production context for a coding agent', () => {
  it('finds the endpoints a file handles and what production says about each', async () => {
    const context = await productionContext({
      files: [SERVER],
      manifests: [MANIFEST],
      query,
      rules: [RULE],
    });
    const [file] = context.files;
    expect(file!.service).toBe('checkout');
    const pay = file!.endpoints.find((e) => e.route === '/checkout/pay')!;
    expect(pay).toMatchObject({
      method: 'POST',
      line: 30,
      p95: 0.846,
      slowRank: 1,
      endpointsInService: 3,
      alerts: [{ status: 'pending' }],
    });
    expect(pay.calls.length).toBeGreaterThan(0);
    expect(pay.hint).toBeTruthy();
    const summary = file!.endpoints.find((e) => e.route === '/checkout/summary')!;
    expect(summary).toMatchObject({ busiest: true, hint: null });
  });

  it('writes a short brief with the numbers first', async () => {
    const { summary } = await productionContext({
      files: [SERVER],
      manifests: [MANIFEST],
      query,
      rules: [RULE],
    });
    expect(summary).toContain('checkout/server.cjs (service checkout)');
    expect(summary).toContain(
      '- POST /checkout/pay (line 30): p95 846 ms, 0.79 req/s, 0.506% failed. It is the slowest of 3 endpoints in checkout.',
    );
    expect(summary).toContain(
      'Alert rule (pending): POST /checkout/pay · p95 latency above 800 ms.',
    );
    expect(summary).toContain('It is the busiest in checkout.');
  });

  it('says plainly when a file defines no handler, or has no manifest above it', async () => {
    const { summary } = await productionContext({
      files: [
        { path: 'checkout/util.cjs', content: 'module.exports = (a, b) => a + b;\n' },
        { path: 'elsewhere/x.js', content: 'app.get("/x", () => 1);\n' },
      ],
      manifests: [MANIFEST],
      query,
      rules: [],
    });
    expect(summary).toContain(
      'checkout/util.cjs (service checkout)\n- Defines no request handler.',
    );
    expect(summary).toContain('elsewhere/x.js\n- No service manifest above this file');
  });

  it('leaves out disabled rules, and lists a rule once', async () => {
    const context = await productionContext({
      files: [SERVER],
      manifests: [MANIFEST],
      query,
      rules: [RULE, RULE, { spec: { ...RULE.spec, name: 'old', status: 'disabled' } }],
    });
    const pay = context.files[0]!.endpoints.find((e) => e.route === '/checkout/pay')!;
    expect(pay.alerts.map((a) => a.name)).toEqual([RULE.spec.name]);
  });
});
