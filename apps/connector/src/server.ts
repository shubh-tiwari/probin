import { PRODUCT_NAME, PRODUCT_SLUG } from '@app/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReadApi } from './api.js';

const text = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
});

/** Summarise a query result so it fits in a conversation: per line, the first, last, lowest and highest value. */
export function summarise(result: {
  series: { labels: Record<string, string>; points: [number, number][] }[];
  lineCount: number;
  step: number;
}) {
  return {
    lines: result.lineCount,
    step_seconds: result.step,
    series: result.series.slice(0, 20).map((series) => {
      const values = series.points.map((p) => p[1]);
      return {
        labels: series.labels,
        points: values.length,
        first: values[0] ?? null,
        last: values.at(-1) ?? null,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
      };
    }),
  };
}

/**
 * K6: lets Claude Code look at the workspace's live metrics while it works.
 * Read-only: it can list and search the catalog, see endpoints with their
 * request rate and p95, and run queries. It cannot change anything.
 */
export function createConnector(api: ReadApi): McpServer {
  const server = new McpServer({ name: `${PRODUCT_SLUG}-metrics`, version: '1.0.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'list_services',
    {
      title: 'List services',
      description: `Services that send metrics to ${PRODUCT_NAME} in this workspace.`,
      annotations: readOnly,
    },
    async () => text(await api.services()),
  );

  server.registerTool(
    'search_metrics',
    {
      title: 'Search metrics',
      description:
        'Find metrics by what they measure, e.g. "checkout latency" or "orders completed". Returns stored series names, labels and units to use in queries.',
      inputSchema: { text: z.string().min(1), service: z.string().optional() },
      annotations: readOnly,
    },
    async ({ text: words, service }) => text(await api.search(words, service)),
  );

  server.registerTool(
    'endpoint_stats',
    {
      title: 'Endpoint stats',
      description:
        'The endpoints of a service with their current request rate (per second) and p95 latency (seconds).',
      inputSchema: { service: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ service }) => text(await api.endpoints(service)),
  );

  server.registerTool(
    'query_metrics',
    {
      title: 'Query metrics',
      description:
        'Run a PromQL query over a recent range (e.g. "1h", "6h"). Use names from search_metrics. Returns a summary per line.',
      inputSchema: {
        query: z.string().min(1),
        range: z
          .string()
          .regex(/^[1-9][0-9]*(m|h|d)$/)
          .default('1h'),
      },
      annotations: readOnly,
    },
    async ({ query, range }) => {
      try {
        return text(summarise(await api.query(query, range)));
      } catch (error) {
        return {
          ...text(`The query failed: ${error instanceof Error ? error.message : String(error)}`),
          isError: true,
        };
      }
    },
  );

  return server;
}
