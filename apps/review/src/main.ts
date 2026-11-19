import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createSecretBox, loadEnv } from '@app/config';
import { connect, getWorkspace } from '@app/db';
import { createSlackStore, postableChannel } from '@app/slack';
import { WebClient } from '@slack/web-api';
import { Hono } from 'hono';
import { PgBoss } from 'pg-boss';
import { createGitHub, verifyWebhook } from './github.js';
import { createReviewService } from './service.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'WEB_URL',
  'SLACK_API_URL',
  'SECRETS_KEY',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_FILE',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_API_URL',
  'REVIEW_WINDOW',
  'REVIEW_DEPLOY_WINDOW',
]);

const { db } = connect(env.DATABASE_URL);
const slack = createSlackStore(db, createSecretBox(env.SECRETS_KEY));
const review = createReviewService({
  db,
  github: createGitHub({
    apiUrl: env.GITHUB_API_URL,
    appId: env.GITHUB_APP_ID,
    privateKey: readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8'),
  }),
  queryApiUrl: env.QUERY_API_URL,
  internalToken: env.INTERNAL_API_TOKEN,
  webUrl: env.WEB_URL,
  window: env.REVIEW_WINDOW,
  deployWindow: env.REVIEW_DEPLOY_WINDOW,
  async notify(workspaceId, text) {
    const installation = await slack.installationForWorkspace(workspaceId);
    if (!installation) return;
    const workspace = await getWorkspace(db, workspaceId);
    const channel =
      (workspace?.settings as { alertChannel?: string } | undefined)?.alertChannel ?? '#alerts';
    await new WebClient(installation.botToken, {
      slackApiUrl: `${env.SLACK_API_URL}/`,
    }).chat.postMessage({ channel: postableChannel(channel), text });
  },
});

const boss = new PgBoss(env.DATABASE_URL);
boss.on('error', (error) => console.error('job queue', error));
await boss.start();
for (const queue of ['review-pull', 'review-deploy', 'review-weekly'])
  await boss.createQueue(queue);

await boss.work<{ installation: string; repository: string; number: number }>(
  'review-pull',
  async (jobs) => {
    for (const { data } of jobs)
      await review.reviewPull(data.installation, data.repository, data.number);
  },
);
await boss.work<{ installation: string; repository: string; sha: string; deployedAt: number }>(
  'review-deploy',
  async (jobs) => {
    for (const { data } of jobs)
      await review.followUpDeploy(data.installation, data.repository, data.sha, data.deployedAt);
  },
);
// R2: the bottleneck report, weekly, Monday 07:00 UTC, for every workspace with GitHub connected.
await boss.work('review-weekly', async () => {
  const { schema } = await import('@app/db');
  const rows = await db
    .selectDistinct({ id: schema.githubInstallations.workspaceId })
    .from(schema.githubInstallations);
  for (const row of rows) await review.report(row.id, 'bottleneck');
});
await boss.schedule('review-weekly', '0 7 * * 1');

const deployDelaySeconds = (() => {
  const match = /^(\d+)(s|m|h)$/.exec(env.REVIEW_DEPLOY_WINDOW);
  return match ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'] : 1800;
})();

const app = new Hono();
app.get('/healthz', (c) => c.json({ status: 'ok' }));

/** GitHub webhooks, verified by signature. */
app.post('/github/webhook', async (c) => {
  const body = await c.req.text();
  if (!verifyWebhook(body, c.req.header('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET))
    return c.json({ error: 'Bad signature.' }, 401);
  const event = c.req.header('x-github-event');
  const payload = JSON.parse(body) as {
    action?: string;
    installation?: { id: number };
    repository?: { full_name: string };
    pull_request?: { number: number };
    deployment?: { sha: string };
    deployment_status?: { state: string; created_at: string };
  };
  const installation = String(payload.installation?.id ?? '');
  const repository = payload.repository?.full_name ?? '';
  if (
    event === 'pull_request' &&
    ['opened', 'synchronize', 'reopened'].includes(payload.action ?? '') &&
    payload.pull_request
  ) {
    await boss.send('review-pull', {
      installation,
      repository,
      number: payload.pull_request.number,
    });
  } else if (
    event === 'deployment_status' &&
    payload.deployment_status?.state === 'success' &&
    payload.deployment
  ) {
    const deployedAt = Math.floor(new Date(payload.deployment_status.created_at).getTime() / 1000);
    // Compare once there is as much data after the deploy as before it.
    await boss.send(
      'review-deploy',
      { installation, repository, sha: payload.deployment.sha, deployedAt },
      { startAfter: deployDelaySeconds },
    );
  }
  return c.json({ received: true });
});

/** On-demand reports, for the web tool. Internal callers only. */
app.post('/v1/reports', async (c) => {
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (token !== env.INTERNAL_API_TOKEN) return c.json({ error: 'Not an internal caller.' }, 401);
  const workspaceId = c.req.header('x-workspace-id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as { kind?: string };
  const kind = body.kind === 'architecture' ? 'architecture' : 'bottleneck';
  return c.json({ reports: await review.report(workspaceId, kind) });
});

serve({ fetch: app.fetch, port: env.PORT });
console.log(`review listening on :${env.PORT}`);
