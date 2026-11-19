import { serve } from '@hono/node-server';
import { loadEnv, loadPlans } from '@app/config';
import { connect, createSpecStore, getWorkspace } from '@app/db';
import { createMemory, readUserDefaults, saveUserDefaults } from '@app/memory';
import { explainRule } from './explain-rule.js';
import { createDatabaseLedger, createRouter } from '@app/router';
import { createAgentApp } from './app.js';
import { createBackends } from './backends.js';
import { chooseModels } from './models.js';
import { createDatabaseRequestStore, pruneRequests } from './requests.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'PLANS_FILE',
  'MODELS_FILE',
  'OPENROUTER_API_KEY',
  'DEFAULT_DASHBOARD_RANGE',
  'COLLECTOR_ALLOW_PRIVATE_NETWORKS',
]);

const { db } = connect(env.DATABASE_URL);
const models = chooseModels({ apiKey: env.OPENROUTER_API_KEY, modelsFile: env.MODELS_FILE });
const router = createRouter({
  config: models.config,
  eligibility: models.eligibility,
  transport: models.transport,
  ledger: createDatabaseLedger(db, loadPlans(env.PLANS_FILE)),
});

const app = createAgentApp({
  internalToken: env.INTERNAL_API_TOKEN,
  requests: createDatabaseRequestStore(db),
  readUserDefaults: (workspaceId, userId) =>
    readUserDefaults(createMemory(db, workspaceId), userId),
  saveUserDefaults: (workspaceId, userId, answers, source) =>
    saveUserDefaults(createMemory(db, workspaceId), userId, answers, source),
  forWorkspace: (workspaceId) => ({
    router,
    defaultRange: env.DEFAULT_DASHBOARD_RANGE,
    backends: createBackends({
      db,
      workspaceId,
      queryApiUrl: env.QUERY_API_URL,
      internalToken: env.INTERNAL_API_TOKEN,
      defaultRange: env.DEFAULT_DASHBOARD_RANGE,
      allowPrivateCollectors: env.COLLECTOR_ALLOW_PRIVATE_NETWORKS,
    }),
  }),
  explainAlert: (workspaceId, ruleId) =>
    explainRule({
      db,
      router,
      workspaceId,
      ruleId,
      queryApiUrl: env.QUERY_API_URL,
      internalToken: env.INTERNAL_API_TOKEN,
    }),
  canBuild: async (workspaceId) => {
    const workspace = await getWorkspace(db, workspaceId);
    if (!workspace) return { ok: false, reason: 'No such workspace.' };
    if (workspace.billingStatus === 'active' || workspace.billingStatus === 'past_due')
      return { ok: true };
    if (
      workspace.billingStatus === 'trialing' &&
      (!workspace.trialEndsAt || workspace.trialEndsAt > new Date())
    )
      return { ok: true };
    return {
      ok: false,
      reason:
        workspace.billingStatus === 'canceled'
          ? 'This workspace’s subscription is cancelled. Building new charts and alerts is paused.'
          : 'The free trial has ended. An admin can subscribe on the Billing page. Dashboards and alerts keep working.',
    };
  },
  loadPanel: async (workspaceId, panelId) => {
    const specs = createSpecStore(db, workspaceId);
    const panel = await specs.latestPanel(panelId).catch(() => undefined);
    if (!panel) return undefined;
    const holder = (await specs.listDashboards()).find((d) => d.spec.panel_ids.includes(panelId));
    return { spec: panel.spec, ...(holder ? { dashboardId: holder.id } : {}) };
  },
  defaultAlertChannel: async (workspaceId) => {
    const workspace = await getWorkspace(db, workspaceId);
    const channel = (workspace?.settings as { alertChannel?: unknown } | undefined)?.alertChannel;
    return typeof channel === 'string' && /^#\S+$/.test(channel) ? channel : '#alerts';
  },
});

// Open requests nobody has touched for a week are dropped.
const prune = () => pruneRequests(db, 7).catch((error) => console.error('pruning requests', error));
void prune();
setInterval(prune, 3_600_000).unref();

const server = serve({ fetch: app.fetch, port: env.PORT });
console.log(`agent listening on :${env.PORT}; ${models.description}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
