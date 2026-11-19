import { serve } from '@hono/node-server';
import { loadEnv, loadPlans } from '@app/config';
import { connect } from '@app/db';
import { workspaceStores } from './workspace-stores.js';
import { createQueryApp } from './app.js';
import { createQueryService } from './service.js';
import { createMetricsStore } from './store.js';

const env = loadEnv([
  'PORT',
  'METRICS_STORE_URL',
  'METRICS_STORE_TYPE',
  'INTERNAL_API_TOKEN',
  'QUERY_TIMEOUT_MS',
  'QUERY_MAX_LINES',
  'QUERY_CACHE_TTL_SECONDS',
  'DATABASE_URL',
  'PLANS_FILE',
  'SECRETS_KEY',
]);

const hosted = createMetricsStore({
  url: env.METRICS_STORE_URL,
  type: env.METRICS_STORE_TYPE,
  timeoutMs: env.QUERY_TIMEOUT_MS,
});
const { db } = connect(env.DATABASE_URL);
const service = createQueryService({
  store: hosted,
  workspaceStore: workspaceStores({
    db,
    plans: loadPlans(env.PLANS_FILE),
    hosted,
    secretsKey: env.SECRETS_KEY,
    timeoutMs: env.QUERY_TIMEOUT_MS,
  }),
  maxLines: env.QUERY_MAX_LINES,
  cacheTtlMs: env.QUERY_CACHE_TTL_SECONDS * 1000,
});

const server = serve({
  fetch: createQueryApp({ service, internalToken: env.INTERNAL_API_TOKEN }).fetch,
  port: env.PORT,
});
console.log(`query-api listening on :${env.PORT} (${env.METRICS_STORE_TYPE})`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
