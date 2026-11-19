import { serve } from '@hono/node-server';
import { createSecretBox, loadEnv } from '@app/config';
import { connect } from '@app/db';
import { createQueryApiClient } from '@app/query-api/client';
import { createSlackNotifier, createSlackStore } from '@app/slack';
import { Hono } from 'hono';
import { evaluateOnce } from './runner.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'SLACK_API_URL',
  'SECRETS_KEY',
  'ALERT_EVAL_SECONDS',
]);

const { db } = connect(env.DATABASE_URL);
const deps = {
  db,
  queryFor: (workspaceId: string) =>
    createQueryApiClient({
      url: env.QUERY_API_URL,
      internalToken: env.INTERNAL_API_TOKEN,
      workspaceId,
    }),
  notifier: createSlackNotifier({
    store: createSlackStore(db, createSecretBox(env.SECRETS_KEY)),
    apiUrl: env.SLACK_API_URL,
  }),
  log: (message: string) => console.warn(message),
};

let running = false;
let last: { at: string; evaluated: number; fired: number; resolved: number } | undefined;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    last = { at: new Date().toISOString(), ...(await evaluateOnce(deps)) };
  } catch (error) {
    console.error('evaluation failed', error);
  } finally {
    running = false;
  }
};
setInterval(tick, env.ALERT_EVAL_SECONDS * 1000);
void tick();

const app = new Hono();
app.get('/healthz', (c) => c.json({ status: 'ok', last }));
serve({ fetch: app.fetch, port: env.PORT });
console.log(`alert engine evaluating every ${env.ALERT_EVAL_SECONDS} s`);
