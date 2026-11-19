/** Fixtures and fakes shared by the agent's tests. Not used in production. */
import {
  rankCatalog,
  storedSeriesNames,
  type CatalogContents,
  type CatalogMetric,
  type MetricType,
} from '@app/catalog';
import {
  createMemoryLedger,
  createRouter,
  parseModels,
  type CompletionRequest,
  type ModelTransport,
} from '@app/router';
import type { DryRunResult } from '@app/query-api/client';
import type { AlertRuleSpec, CollectorSpec } from '@app/specs';
import type { LoopDependencies } from './loop.js';
import { createStandInTransport } from './standin.js';
import type { ToolBackends } from './tools.js';

const metric = (
  service: string,
  metricName: string,
  storedName: string,
  type: MetricType,
  unit: string,
  description: string,
  labels: string[],
): CatalogMetric => ({
  service,
  metricName,
  storedName,
  series: storedSeriesNames(storedName, type),
  type,
  unit,
  labels: ['service_name', ...labels],
  description,
  lastSeen: null,
});

const HTTP_LABELS = ['http_request_method', 'http_route', 'http_response_status_code', 'le'];
const http = (service: string) =>
  metric(
    service,
    'http.server.request.duration',
    'http_server_request_duration_seconds',
    'histogram',
    's',
    'Duration of requests this service handles',
    HTTP_LABELS,
  );

export const CATALOG: CatalogContents = {
  services: ['checkout', 'inventory'],
  metrics: [
    http('checkout'),
    metric('checkout', 'orders.completed', 'orders_completed_total', 'counter', '{order}', 'Orders paid successfully', ['payment_method']),
    http('inventory'),
    metric('inventory', 'stock.level', 'stock_level', 'gauge', '{item}', 'Units in stock per warehouse', ['warehouse']),
  ],
  endpoints: [
    { service: 'checkout', method: 'POST', route: '/checkout/pay', description: '', lastSeen: null, requestRate: 1.2, p95: 0.8 },
    { service: 'checkout', method: 'GET', route: '/checkout/summary', description: '', lastSeen: null, requestRate: 3.8, p95: 0.05 },
    { service: 'inventory', method: 'GET', route: '/items/{id}', description: '', lastSeen: null, requestRate: 2, p95: 0.02 },
  ],
}; // prettier-ignore

/** One fast tier, one strong tier, no eligibility file: enough to see escalation. */
export const TEST_MODELS = parseModels(`
tiers:
  - { id: fast, models: [{ id: test-fast, input_per_mtok: 1, output_per_mtok: 1 }] }
  - { id: strong, models: [{ id: test-strong, input_per_mtok: 10, output_per_mtok: 10 }] }
tasks: { parse: fast, ask: fast, write_query: fast, explain: strong, review: strong }
budget: { near_cap_ratio: 0.8 }
`);

export interface Harness {
  deps: LoopDependencies;
  /** Every completion request the model received. */
  modelCalls: CompletionRequest[];
  /** Every query that reached the dry run. */
  dryRuns: { query: string; range: string }[];
  saved: Parameters<ToolBackends['savePanel']>[];
  alerts: AlertRuleSpec[];
  collectors: CollectorSpec[];
  ledger: ReturnType<typeof createMemoryLedger>;
}

/**
 * A loop wired to fakes. By default the model is the stand-in and every dry
 * run returns one line. `writeQuery` replaces the model's query-writing with
 * a scripted sequence of replies, one per attempt.
 */
export function createHarness(
  options: {
    catalog?: CatalogContents;
    dryRun?: (query: string, range: string) => Partial<DryRunResult>;
    writeQuery?: (attempt: number, request: CompletionRequest) => string;
    budgetLimit?: number | null;
  } = {},
): Harness {
  const modelCalls: CompletionRequest[] = [];
  const dryRuns: Harness['dryRuns'] = [];
  const saved: Harness['saved'] = [];
  const alerts: AlertRuleSpec[] = [];
  const collectors: CollectorSpec[] = [];
  const standIn = createStandInTransport();
  let writes = 0;

  const transport: ModelTransport = {
    async complete(request) {
      modelCalls.push(request);
      if (request.task === 'write_query' && options.writeQuery) {
        writes += 1;
        return { content: options.writeQuery(writes, request), inputTokens: 100, outputTokens: 50 };
      }
      return standIn.complete(request);
    },
  };

  const ledger = createMemoryLedger({ limit: options.budgetLimit ?? null });
  const backends: ToolBackends = {
    searchCatalog: async (search) => rankCatalog(options.catalog ?? CATALOG, search),
    dryRun: async (query, range) => {
      dryRuns.push({ query, range });
      return {
        ok: true,
        lineCount: 1,
        durationMs: 5,
        sample: [],
        ...options.dryRun?.(query, range),
      };
    },
    draftAlert: async (spec) => {
      alerts.push(spec);
      return { ruleId: `rule-${alerts.length}` };
    },
    draftCollector: async (spec) => {
      collectors.push(spec);
      return {
        collectorId: `collector-${collectors.length}`,
        test: { ok: true, status: 200, duration: 0.05 },
      };
    },
    savePanel: async (...args) => {
      saved.push(args);
      return { panelId: 'panel-1', version: 1, dashboardId: args[2] ?? 'dashboard-1' };
    },
  };

  return {
    deps: {
      router: createRouter({
        config: TEST_MODELS,
        eligibility: null,
        transport,
        ledger: ledger.ledger,
      }),
      backends,
      defaultRange: '6h',
    },
    modelCalls,
    dryRuns,
    saved,
    alerts,
    collectors,
    ledger,
  };
}
