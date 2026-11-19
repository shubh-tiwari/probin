import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ReadApi } from './api.js';
import { createConnector } from './server.js';

const api: ReadApi = {
  services: async () => ({ services: ['checkout', 'inventory'] }),
  search: async (text) => ({
    metrics: [{ name: 'http.server.request.duration', text }],
    endpoints: [],
  }),
  endpoints: async () => ({ endpoints: [{ method: 'POST', route: '/checkout/pay', p95: 0.8 }] }),
  query: async () => ({
    series: [
      {
        labels: { http_route: '/pay' },
        points: [
          [1, 0.5],
          [2, 0.9],
        ],
      },
    ],
    lineCount: 1,
    step: 60,
  }),
};

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createConnector(api).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}

describe('the connector for Claude Code', () => {
  it('offers four read-only tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'list_services',
      'search_metrics',
      'endpoint_stats',
      'query_metrics',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('summarises a query per line', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'query_metrics',
      arguments: { query: 'up', range: '1h' },
    });
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(body).toEqual({
      lines: 1,
      step_seconds: 60,
      series: [
        { labels: { http_route: '/pay' }, points: 2, first: 0.5, last: 0.9, min: 0.5, max: 0.9 },
      ],
    });
  });

  it('refuses a range that is not a duration', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'query_metrics',
      arguments: { query: 'up', range: 'forever' },
    });
    expect(result.isError).toBe(true);
  });
});
