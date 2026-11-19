import { MANIFEST_FILENAME } from '@app/config';
import type { QueryApiClient, QueryResult } from '@app/query-api/client';
import { describe, expect, it } from 'vitest';
import { conventionFindings, deployFindings, serviceForAddress, suggestFix } from './analyses.js';
import type { PullFile } from './github.js';
import { buildIndex } from './indexer.js';

const MANIFEST = `service: checkout
description: Checkout
endpoints:
  - method: POST
    route: /checkout/pay
metrics:
  - name: http.server.request.duration
    type: histogram
    unit: s
    description: Requests
  - name: orders.completed
    type: counter
    unit: "{order}"
    description: Orders
    attributes: [payment.method]
`;
const SERVER = `const app = express();
app.post('/checkout/pay', async (req, res) => {
  ordersCompleted.add(1, { 'payment.method': method });
  res.json({});
});
`;

const patchAdding = (start: number, lines: string[]) =>
  `@@ -${start},0 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;

function review(
  changes: { file: string; at: number; lines: string[] }[],
  extraFiles: Record<string, string> = {},
) {
  const files = new Map<string, string>([
    [`checkout/${MANIFEST_FILENAME}`, MANIFEST],
    ['checkout/server.cjs', SERVER],
    ...Object.entries(extraFiles),
  ]);
  for (const change of changes) {
    const content = (files.get(change.file) ?? '').split('\n');
    content.splice(change.at - 1, 0, ...change.lines);
    files.set(change.file, content.join('\n'));
  }
  const index = buildIndex('head', files);
  const pullFiles: PullFile[] = changes.map((c) => ({
    filename: c.file,
    status: 'modified',
    patch: patchAdding(c.at, c.lines),
  }));
  return conventionFindings(index, pullFiles).map((f) => [f.evidence.rule, f.path, f.line]);
}

describe('the convention check on a pull request', () => {
  it('passes a change that follows the convention', () => {
    expect(
      review([{ file: 'checkout/server.cjs', at: 1, lines: ['// Checkout service.'] }]),
    ).toEqual([]);
  });

  it('flags a new endpoint missing from the manifest, on its line', () => {
    expect(
      review([
        {
          file: 'checkout/server.cjs',
          at: 6,
          lines: ["app.get('/checkout/health/deep', (req, res) => res.json({}));"],
        },
      ]),
    ).toEqual([['endpoint-in-manifest', 'checkout/server.cjs', 6]]);
  });

  it('flags personal and unbounded attributes', () => {
    expect(
      review([
        {
          file: 'checkout/server.cjs',
          at: 4,
          lines: [
            "  ordersCompleted.add(1, { 'payment.method': method, 'user.id': id, 'order.id': order });",
          ],
        },
      ]),
    ).toEqual([
      ['no-personal-or-secret-attributes', 'checkout/server.cjs', 4],
      ['bounded-attributes', 'checkout/server.cjs', 4],
    ]);
  });

  it('flags a separate request counter, a millisecond unit, and undeclared metrics', () => {
    expect(
      review([
        {
          file: 'checkout/server.cjs',
          at: 1,
          lines: [
            "const requests = meter.createCounter('http.server.requests', { unit: '{request}' });",
            "const lookup = meter.createHistogram('cart.lookup.time', { unit: 'ms' });",
          ],
        },
      ]),
    ).toEqual([
      ['no-request-counter', 'checkout/server.cjs', 1],
      ['metric-in-manifest', 'checkout/server.cjs', 1],
      ['base-units', 'checkout/server.cjs', 2],
      ['metric-in-manifest', 'checkout/server.cjs', 2],
    ]);
  });

  it('flags a metric named after its own service', () => {
    expect(
      review([
        {
          file: 'checkout/server.cjs',
          at: 1,
          lines: ["const size = meter.createHistogram('checkout.cart.size', { unit: '{item}' });"],
        },
      ]),
    ).toEqual([
      ['no-service-in-metric-name', 'checkout/server.cjs', 1],
      ['metric-in-manifest', 'checkout/server.cjs', 1],
    ]);
  });
});

describe('suggested fixes', () => {
  it('points at a loop that awaits each step', () => {
    const index = buildIndex(
      'x',
      new Map([
        [
          'main.py',
          '@app.get("/h")\nasync def h():\n    for d in range(30):\n        await asyncio.sleep(0.01)\n    return 1\n',
        ],
      ]),
    );
    expect(suggestFix(index.routes[0]!)).toMatch(
      /^Suggested fix: the handler waits for each step of the loop at line 3/,
    );
  });
});

describe('the service map', () => {
  it('reads service names out of the addresses services call', () => {
    expect(serviceForAddress('demo-inventory', ['checkout', 'inventory'])).toBe('inventory');
    expect(serviceForAddress('inventory.internal:8080', ['checkout', 'inventory'])).toBe(
      'inventory',
    );
    expect(serviceForAddress('api.stripe.com', ['checkout', 'inventory'])).toBeUndefined();
  });
});

describe('after a deploy', () => {
  const index = buildIndex(
    'sha',
    new Map([
      [`checkout/${MANIFEST_FILENAME}`, MANIFEST],
      ['checkout/server.cjs', SERVER],
    ]),
  );
  const touchingPay: PullFile[] = [
    { filename: 'checkout/server.cjs', status: 'modified', patch: '@@ -3,1 +3,1 @@\n-x\n+y' },
  ];
  /** A Query API whose answers depend on whether the window ends at the deploy. */
  const query = (before: [number, number], after: [number, number], deployedAt: number) =>
    ({
      query: async (request: { query: string; end?: number }) => {
        const [latency, errors] = request.end === deployedAt ? before : after;
        const value = request.query.startsWith('histogram_quantile') ? latency : errors;
        return {
          series: [
            {
              labels: {},
              points: [
                [1, value],
                [2, value],
              ],
            },
          ],
        } as unknown as QueryResult;
      },
    }) as unknown as QueryApiClient;

  it('notes an endpoint that got slower', async () => {
    const findings = await deployFindings({
      index,
      files: touchingPay,
      query: query([0.4, 0], [0.9, 0], 1000),
      deployedAt: 1000,
      window: '30m',
      now: 5000,
    });
    expect(findings).toMatchObject([
      {
        kind: 'post_deploy_regression',
        title: 'After the deploy, POST /checkout/pay got worse',
        body: expect.stringContaining('p95 went from 400 ms to 900 ms'),
        evidence: { window: '30m before and after the deploy' },
      },
    ]);
  });

  it('notes more errors', async () => {
    const findings = await deployFindings({
      index,
      files: touchingPay,
      query: query([0.4, 0.001], [0.41, 0.05], 1000),
      deployedAt: 1000,
      window: '30m',
      now: 5000,
    });
    expect(findings[0]!.body).toContain('failed requests went from 0.1% to 5.0%');
  });

  it('says nothing when nothing moved', async () => {
    expect(
      await deployFindings({
        index,
        files: touchingPay,
        query: query([0.4, 0.01], [0.42, 0.012], 1000),
        deployedAt: 1000,
        window: '30m',
        now: 5000,
      }),
    ).toEqual([]);
  });

  it('only looks at endpoints the deploy changed', async () => {
    const elsewhere: PullFile[] = [
      { filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
    ];
    expect(
      await deployFindings({
        index,
        files: elsewhere,
        query: query([0.4, 0], [0.9, 0], 1000),
        deployedAt: 1000,
        window: '30m',
        now: 5000,
      }),
    ).toEqual([]);
  });
});
