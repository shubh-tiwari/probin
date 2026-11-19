import { createSecretBox, loadEnv, loadPlans } from '@app/config';
import { connect } from '@app/db';
import { createSlackApp } from './app.js';
import { createSlackStore } from './store.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'SLACK_SIGNING_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_API_URL',
  'SLACK_AUTHORIZE_URL',
  'SLACK_PUBLIC_URL',
  'WEB_URL',
  'INGEST_URL',
  'SECRETS_KEY',
  'AGENT_URL',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'PLANS_FILE',
  'DEFAULT_DASHBOARD_RANGE',
]);

const { db } = connect(env.DATABASE_URL);
const store = createSlackStore(db, createSecretBox(env.SECRETS_KEY));

const app = createSlackApp({
  db,
  store,
  plans: loadPlans(env.PLANS_FILE),
  signingSecret: env.SLACK_SIGNING_SECRET,
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
  apiUrl: env.SLACK_API_URL,
  authorizeUrl: env.SLACK_AUTHORIZE_URL,
  publicUrl: env.SLACK_PUBLIC_URL,
  ingestUrl: env.INGEST_URL,
  webUrl: env.WEB_URL,
  agentUrl: env.AGENT_URL,
  queryApiUrl: env.QUERY_API_URL,
  internalToken: env.INTERNAL_API_TOKEN,
  defaultRange: env.DEFAULT_DASHBOARD_RANGE,
});

await app.start(env.PORT);
console.log(`slack listening on :${env.PORT} (Slack API ${env.SLACK_API_URL})`);
