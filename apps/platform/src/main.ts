import { serve } from '@hono/node-server';
import { loadEnv, loadPlans } from '@app/config';
import { connect } from '@app/db';
import { createPlatformApp } from './app.js';
import { createPlatformBackend } from './backend.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'INTERNAL_API_TOKEN',
  'PLANS_FILE',
  'DEFAULT_DASHBOARD_RANGE',
  'COLLECTOR_ALLOW_PRIVATE_NETWORKS',
]);

const { db } = connect(env.DATABASE_URL);
const plans = loadPlans(env.PLANS_FILE);
const app = createPlatformApp({
  internalToken: env.INTERNAL_API_TOKEN,
  forWorkspace: (workspaceId) =>
    createPlatformBackend({
      db,
      workspaceId,
      plans,
      defaultRange: env.DEFAULT_DASHBOARD_RANGE,
      allowPrivateCollectors: env.COLLECTOR_ALLOW_PRIVATE_NETWORKS,
    }),
});

const server = serve({ fetch: app.fetch, port: env.PORT });
console.log(`platform listening on :${env.PORT}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
