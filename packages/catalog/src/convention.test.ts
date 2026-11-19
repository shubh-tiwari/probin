import { parseManifest, type Manifest } from '@app/specs';
import { describe, expect, it } from 'vitest';
import { checkEmitted, checkManifest } from './convention.js';
import type { SeriesLabels } from './types.js';

const manifest = (overrides: Partial<Manifest> = {}): Manifest =>
  parseManifest({
    service: 'checkout',
    description: 'Handles cart, payment and order confirmation',
    endpoints: [
      { method: 'POST', route: '/checkout/pay' },
      { method: 'GET', route: '/orders/{id}' },
    ],
    metrics: [
      {
        name: 'http.server.request.duration',
        type: 'histogram',
        unit: 's',
        description: 'Duration of requests this service handles',
      },
      {
        name: 'orders.completed',
        type: 'counter',
        unit: '{order}',
        description: 'Orders paid successfully',
        attributes: ['payment.method'],
      },
    ],
    ...overrides,
  });

const rules = (findings: { rule: string }[]) => findings.map((finding) => finding.rule);

const http = (method: string, route: string, extra: SeriesLabels = {}): SeriesLabels[] =>
  ['bucket', 'sum', 'count'].map((part) => ({
    __name__: `http_server_request_duration_seconds_${part}`,
    service_name: 'checkout',
    http_request_method: method,
    http_route: route,
    http_response_status_code: '200',
    ...extra,
  }));

const good: SeriesLabels[] = [
  ...http('POST', '/checkout/pay'),
  ...http('GET', '/orders/{id}'),
  { __name__: 'orders_completed_total', service_name: 'checkout', payment_method: 'card' },
];

describe('manifest checks', () => {
  it('pass for a manifest that follows the convention', () => {
    expect(checkManifest(manifest())).toEqual([]);
  });

  it('flag endpoints with no request metric', () => {
    const only = manifest().metrics.filter((m) => m.name !== 'http.server.request.duration');
    expect(rules(checkManifest(manifest({ metrics: only })))).toEqual(['http-duration-declared']);
  });

  it('flag a separate request counter', () => {
    const metrics = [
      ...manifest().metrics,
      {
        name: 'http.server.requests',
        type: 'counter' as const,
        unit: '{request}',
        description: 'Requests',
      },
    ];
    expect(rules(checkManifest(manifest({ metrics })))).toEqual(['no-request-counter']);
  });

  it('flag a metric named after its own service', () => {
    const metrics = [
      ...manifest().metrics,
      { name: 'checkout.cart.size', type: 'gauge' as const, unit: '{item}', description: 'Items' },
    ];
    expect(checkManifest(manifest({ metrics }))).toMatchObject([
      { rule: 'no-service-in-metric-name', message: expect.stringContaining('cart.size') },
    ]);
  });

  it('flag a route with a value where a parameter belongs', () => {
    const endpoints = [{ method: 'GET' as const, route: '/orders/1234' }];
    expect(rules(checkManifest(manifest({ endpoints })))).toEqual(['route-is-template']);
  });

  it.each([
    ['user.id', 'no-personal-or-secret-attributes'],
    ['customer.email', 'no-personal-or-secret-attributes'],
    ['auth.token', 'no-personal-or-secret-attributes'],
    ['order.id', 'bounded-attributes'],
    ['url.path', 'bounded-attributes'],
  ])('flag the attribute %s', (attribute, rule) => {
    const metrics = [
      { ...manifest().metrics[1]!, attributes: [attribute] },
      manifest().metrics[0]!,
    ];
    expect(rules(checkManifest(manifest({ metrics })))).toEqual([rule]);
  });

  it('accept the attributes the convention itself uses', () => {
    const metrics = [
      ...manifest().metrics,
      {
        name: 'http.client.request.duration',
        type: 'histogram' as const,
        unit: 's',
        description: 'Outbound calls',
        attributes: ['http.request.method', 'server.address', 'http.response.status_code'],
      },
      {
        name: 'jobs.run.duration',
        type: 'histogram' as const,
        unit: 's',
        description: 'Background jobs',
        attributes: ['job.name', 'job.result'],
      },
    ];
    expect(checkManifest(manifest({ metrics }))).toEqual([]);
  });
});

describe('emitted checks', () => {
  it('pass when the service emits what it declares', () => {
    expect(checkEmitted(manifest(), good)).toEqual([]);
  });

  it('ignore series from other services', () => {
    const other = http('GET', '/somewhere/else').map((l) => ({ ...l, service_name: 'inventory' }));
    expect(checkEmitted(manifest(), [...good, ...other])).toEqual([]);
  });

  it('flag a declared metric that is not emitted', () => {
    const series = good.filter((labels) => labels.__name__ !== 'orders_completed_total');
    expect(checkEmitted(manifest(), series)).toMatchObject([
      {
        rule: 'declared-metric-emitted',
        message: expect.stringContaining('orders_completed_total'),
      },
    ]);
  });

  it('flag a declared attribute no sample carries', () => {
    const series = good.map((labels) =>
      labels.__name__ === 'orders_completed_total'
        ? { __name__: 'orders_completed_total', service_name: 'checkout' }
        : labels,
    );
    expect(checkEmitted(manifest(), series)).toMatchObject([
      { rule: 'declared-metric-emitted', message: expect.stringContaining('payment.method') },
    ]);
  });

  it('flag an endpoint that is measured but not in the manifest', () => {
    expect(rules(checkEmitted(manifest(), [...good, ...http('DELETE', '/cart')]))).toEqual([
      'endpoint-in-manifest',
    ]);
  });

  it('flag a declared endpoint that was never measured', () => {
    const series = good.filter((labels) => labels.http_route !== '/orders/{id}');
    expect(rules(checkEmitted(manifest(), series))).toEqual(['declared-endpoint-seen']);
  });

  it('flag a measured route that is a full path with a value in it', () => {
    const series = [...good, ...http('GET', '/orders/8841')];
    expect(rules(checkEmitted(manifest(), series))).toEqual(['route-is-template']);
  });

  it('flag requests measured with no route at all', () => {
    const series = good.map((labels) => {
      const copy = { ...labels };
      delete copy.http_route;
      return copy;
    });
    expect(rules(checkEmitted(manifest(), series))).toContain('route-is-template');
  });

  it('flag the old millisecond HTTP metric and separate request counters', () => {
    const series = [
      ...good,
      { __name__: 'http_server_duration_milliseconds_bucket', service_name: 'checkout' },
      { __name__: 'http_requests_total', service_name: 'checkout' },
    ];
    expect(rules(checkEmitted(manifest(), series))).toEqual([
      'stable-http-names',
      'no-request-counter',
    ]);
  });

  it('flag a label with too many values', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      __name__: 'orders_completed_total',
      service_name: 'checkout',
      payment_method: `method-${i}`,
    }));
    expect(rules(checkEmitted(manifest(), [...good, ...many]))).toEqual(['bounded-attributes']);
  });

  it('flag telemetry export counted as an outbound call', () => {
    const exported = {
      __name__: 'http_client_request_duration_seconds_count',
      service_name: 'checkout',
      server_address: 'ingest.example.com',
    };
    expect(
      rules(checkEmitted(manifest(), [...good, exported], { ingestHosts: ['ingest.example.com'] })),
    ).toEqual(['telemetry-not-an-outbound-call']);
  });
});
