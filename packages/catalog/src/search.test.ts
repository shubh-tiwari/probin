import { describe, expect, it } from 'vitest';
import { storedSeriesNames, type MetricType } from './names.js';
import { rankCatalog, type CatalogContents } from './search.js';
import type { CatalogMetric } from './types.js';

const metric = (
  service: string,
  metricName: string,
  storedName: string,
  type: MetricType,
  description: string,
  labels: string[] = ['service_name'],
): CatalogMetric => ({
  service,
  metricName,
  storedName,
  series: storedSeriesNames(storedName, type),
  type,
  unit: type === 'histogram' ? 's' : '',
  labels,
  description,
  lastSeen: null,
});

const http = (service: string) =>
  metric(
    service,
    'http.server.request.duration',
    'http_server_request_duration_seconds',
    'histogram',
    'Duration of requests this service handles',
    ['service_name', 'http_route', 'http_request_method', 'http_response_status_code', 'le'],
  );

const contents: CatalogContents = {
  services: ['checkout', 'inventory', 'order-api'],
  metrics: [
    http('checkout'),
    metric('checkout', 'orders.completed', 'orders_completed_total', 'counter', 'Orders paid successfully'),
    http('inventory'),
    metric('inventory', 'stock.level', 'stock_level', 'gauge', 'Units in stock per warehouse'),
    metric('inventory', 'restock.job.duration', 'restock_job_duration_seconds', 'histogram', 'Duration of the restock background job'),
    http('order-api'),
  ],
  endpoints: [
    { service: 'checkout', method: 'POST', route: '/checkout/pay', description: '', lastSeen: null, requestRate: 1, p95: 0.8 },
    { service: 'checkout', method: 'GET', route: '/checkout/summary', description: '', lastSeen: null, requestRate: 4, p95: 0.05 },
    { service: 'inventory', method: 'GET', route: '/items/{id}', description: '', lastSeen: null, requestRate: 2, p95: 0.02 },
  ],
}; // prettier-ignore

const names = (text: string, service?: string) =>
  rankCatalog(contents, { text, ...(service ? { service } : {}) }).metrics.map(
    (m) => `${m.service}:${m.metricName}`,
  );

describe('catalog search', () => {
  it('finds the request-duration histogram for the build plan example', () => {
    const result = rankCatalog(contents, {
      text: 'latency graph of checkout service in last 5 hr',
    });
    expect(result.services).toEqual(['checkout']);
    expect(result.metrics[0]).toMatchObject({
      service: 'checkout',
      metricName: 'http.server.request.duration',
    });
    expect(result.endpoints.map((e) => e.route)).toEqual(['/checkout/pay', '/checkout/summary']);
  });

  it.each([
    'traffic',
    'requests per second',
    'error rate',
    'failures',
    'response time',
    'how slow',
  ])(
    'answers “%s” from the request-duration histogram, since there is no separate counter',
    (text) => {
      expect(names(`${text} for checkout`)[0]).toBe('checkout:http.server.request.duration');
    },
  );

  it('finds business metrics by their name or description', () => {
    expect(names('orders completed today')[0]).toBe('checkout:orders.completed');
    expect(names('stock level by warehouse')[0]).toBe('inventory:stock.level');
    expect(names('how long does the restock job take')[0]).toBe('inventory:restock.job.duration');
  });

  it('answers questions about outbound calls from the client histogram', () => {
    const client = metric(
      'checkout',
      'http.client.request.duration',
      'http_client_request_duration_seconds',
      'histogram',
      'Duration of HTTP calls this service makes to others',
      ['service_name', 'http_request_method', 'server_address', 'http_response_status_code', 'le'],
    );
    const withClient = { ...contents, metrics: [...contents.metrics, client] };
    const top = (text: string) => rankCatalog(withClient, { text }).metrics[0]?.metricName;
    expect(top('latency of outbound calls from checkout')).toBe('http.client.request.duration');
    expect(top('downstream error rate for checkout')).toBe('http.client.request.duration');
    expect(top('latency of checkout')).toBe('http.server.request.duration');
  });

  it('prefers a metric the request names over the HTTP histogram', () => {
    expect(names('how long does the restock job take on inventory')[0]).toBe(
      'inventory:restock.job.duration',
    );
    expect(names('restock job duration for inventory in last 6 hours')[0]).toBe(
      'inventory:restock.job.duration',
    );
    expect(names('duration of requests on inventory')[0]).toBe(
      'inventory:http.server.request.duration',
    );
  });

  it('does not read the words of a route as the thing to measure', () => {
    expect(names('typical latency of GET /inventory/stock/level on inventory')[0]).toBe(
      'inventory:http.server.request.duration',
    );
  });

  it('recognises a service whose name has a separator', () => {
    expect(rankCatalog(contents, { text: 'latency of order api' }).services).toEqual(['order-api']);
  });

  it('returns every service that has the metric when none is named', () => {
    const result = rankCatalog(contents, { text: 'latency' });
    expect(result.services).toEqual([]);
    expect(new Set(result.metrics.map((m) => m.service))).toEqual(
      new Set(['checkout', 'inventory', 'order-api']),
    );
  });

  it('returns nothing rather than a near miss', () => {
    expect(names('cpu temperature')).toEqual([]);
    expect(names('kafka consumer lag for checkout')).toEqual([]);
  });

  it('returns nothing for a service that is not in the catalog', () => {
    const result = rankCatalog(contents, { text: 'latency', service: 'billing' });
    expect(result.metrics).toEqual([]);
    expect(result.knownServices).toEqual(['checkout', 'inventory', 'order-api']);
  });

  it('keeps to the service it was given', () => {
    expect(names('latency', 'inventory').every((name) => name.startsWith('inventory:'))).toBe(true);
  });
});
