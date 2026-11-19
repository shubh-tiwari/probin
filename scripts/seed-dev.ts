/**
 * Seeds local development, run by `make dev` after migrations:
 *
 *   1. the dev workspace, with the fixed dev-only ingestion key from .env, so
 *      the demo services can send metrics from their first start;
 *   2. the demo services' manifests, registered through the public endpoint
 *      exactly as a customer's service would register.
 *
 * Safe to run repeatedly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILENAME, createSecretBox, loadEnv, loadPlans } from '@app/config';
import { connect, schema } from '@app/db';
import { hashIngestionKey } from '@app/ingest';

const env = loadEnv([
  'DATABASE_URL',
  'PLANS_FILE',
  'INGEST_URL',
  'DEV_WORKSPACE_ID',
  'DEV_INGESTION_KEY',
  'SECRETS_KEY',
]);

/** The fake Slack's development team (apps/slack/src/fake). Its bot token is fake too. */
const DEV_SLACK_TEAM = 'T0DEV';

const { db, close } = connect(env.DATABASE_URL);
try {
  const keyHash = hashIngestionKey(env.DEV_INGESTION_KEY);
  await db
    .insert(schema.workspaces)
    .values({
      id: env.DEV_WORKSPACE_ID,
      name: 'dev',
      plan: loadPlans(env.PLANS_FILE).trial.plan,
      ingestionKeyHash: keyHash,
      trialEndsAt: new Date(Date.now() + loadPlans(env.PLANS_FILE).trial.days * 86_400_000),
    })
    .onConflictDoUpdate({
      target: schema.workspaces.id,
      set: { ingestionKeyHash: keyHash },
    });
  // Link the fake Slack's dev team to the dev workspace, as if it had installed the app.
  const installation = {
    workspaceId: env.DEV_WORKSPACE_ID,
    teamId: DEV_SLACK_TEAM,
    teamName: 'Dev team (fake Slack)',
    botUserId: 'U0BOT',
    botTokenEncrypted: createSecretBox(env.SECRETS_KEY).seal(`xoxb-fake-${DEV_SLACK_TEAM}`),
  };
  await db
    .insert(schema.slackInstallations)
    .values(installation)
    .onConflictDoUpdate({ target: schema.slackInstallations.workspaceId, set: installation });
  // Alice (the fake Slack's first person) is the dev workspace's admin.
  await db
    .insert(schema.users)
    .values({
      workspaceId: env.DEV_WORKSPACE_ID,
      slackUserId: 'U0ALICE',
      name: 'Alice',
      role: 'admin',
    })
    .onConflictDoUpdate({
      target: [schema.users.workspaceId, schema.users.slackUserId],
      set: { role: 'admin' },
    });
  console.log(
    `Dev workspace ${env.DEV_WORKSPACE_ID} is ready, linked to the fake Slack team ${DEV_SLACK_TEAM}.`,
  );
} finally {
  await close();
}

const demoRoot = fileURLToPath(new URL('../infra/demo', import.meta.url));
for (const entry of readdirSync(demoRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest: string;
  try {
    manifest = readFileSync(join(demoRoot, entry.name, MANIFEST_FILENAME), 'utf8');
  } catch {
    continue;
  }
  const response = await fetch(`${env.INGEST_URL}/v1/manifests`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.DEV_INGESTION_KEY}`,
      'content-type': 'application/yaml',
    },
    body: manifest,
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`Registering ${entry.name} failed: HTTP ${response.status} ${body}`);
    process.exitCode = 1;
  } else {
    console.log(`Registered ${entry.name}: ${body}`);
  }
}
