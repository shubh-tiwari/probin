import { serve } from '@hono/node-server';
import { createSecretBox, loadEnv, loadPlans } from '@app/config';
import { createBilling } from './billing.js';
import { connect } from '@app/db';
import { createSlackStore } from '@app/slack';
import { createWebApp } from './app.js';
import { sessionKey } from './session.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'SECRETS_KEY',
  'WEB_URL',
  'AGENT_URL',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'DEFAULT_DASHBOARD_RANGE',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_API_URL',
  'SLACK_OPENID_AUTHORIZE_URL',
  'COLLECTOR_ALLOW_PRIVATE_NETWORKS',
  'PLANS_FILE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_API_URL',
  'DELETION_GRACE_SECONDS',
  'GITHUB_APP_INSTALL_URL',
  'REVIEW_URL',
]);
const plans = loadPlans(env.PLANS_FILE);

const { db } = connect(env.DATABASE_URL);
const app = createWebApp({
  db,
  store: createSlackStore(db, createSecretBox(env.SECRETS_KEY)),
  sessionKey: sessionKey(env.SECRETS_KEY),
  secrets: createSecretBox(env.SECRETS_KEY),
  plans,
  github: { installUrl: env.GITHUB_APP_INSTALL_URL, reviewUrl: env.REVIEW_URL },
  billing: createBilling({
    db,
    plans,
    apiUrl: env.STRIPE_API_URL,
    webUrl: env.WEB_URL,
    ...(env.STRIPE_SECRET_KEY ? { secretKey: env.STRIPE_SECRET_KEY } : {}),
    ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
    ...(env.DELETION_GRACE_SECONDS !== undefined
      ? { graceSeconds: env.DELETION_GRACE_SECONDS }
      : {}),
  }),
  allowPrivateCollectors: env.COLLECTOR_ALLOW_PRIVATE_NETWORKS,
  webUrl: env.WEB_URL,
  agentUrl: env.AGENT_URL,
  queryApiUrl: env.QUERY_API_URL,
  internalToken: env.INTERNAL_API_TOKEN,
  defaultRange: env.DEFAULT_DASHBOARD_RANGE,
  slack: {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    apiUrl: env.SLACK_API_URL,
    openidAuthorizeUrl: env.SLACK_OPENID_AUTHORIZE_URL,
  },
});

serve({ fetch: app.fetch, port: env.PORT });
console.log(`web listening on :${env.PORT}`);
