import { serve } from '@hono/node-server';
import { registerManifest } from '@app/catalog';
import { loadEnv } from '@app/config';
import { connect, findWorkspaceByIngestionKeyHash } from '@app/db';
import { createIngestApp } from './app.js';
import { startCollectorRunner } from './collector-runner.js';
import { startDeletionRunner } from './deletion.js';
import { startSyncWorker } from './sync-worker.js';

const env = loadEnv([
  'PORT',
  'DATABASE_URL',
  'COLLECTOR_URL',
  'INGEST_MAX_BODY_BYTES',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'COLLECTOR_ALLOW_PRIVATE_NETWORKS',
]);

const { db, close } = connect(env.DATABASE_URL);

const worker = await startSyncWorker({
  db,
  databaseUrl: env.DATABASE_URL,
  queryApiUrl: env.QUERY_API_URL,
  internalToken: env.INTERNAL_API_TOKEN,
  onResult: (workspaceId, result) => {
    for (const missing of result.notInStore) {
      console.warn(
        `catalog: ${workspaceId} ${missing.service} declares ${missing.metricName} ` +
          `but ${missing.storedName} is not in the store`,
      );
    }
  },
});

const collectors = startCollectorRunner({
  db,
  collectorUrl: env.COLLECTOR_URL,
  allowPrivate: env.COLLECTOR_ALLOW_PRIVATE_NETWORKS,
});

const deletions = startDeletionRunner({
  db,
  queryApiUrl: env.QUERY_API_URL,
  internalToken: env.INTERNAL_API_TOKEN,
});

const app = createIngestApp({
  findWorkspaceId: async (keyHash) => (await findWorkspaceByIngestionKeyHash(db, keyHash))?.id,
  collectorUrl: env.COLLECTOR_URL,
  maxBodyBytes: env.INGEST_MAX_BODY_BYTES,
  registerManifest: async (workspaceId, manifest) => {
    const result = await registerManifest(db, workspaceId, manifest);
    // Give the first samples a moment to arrive, then check them against the manifest.
    await worker.request(workspaceId, 5);
    return result;
  },
});

const server = serve({ fetch: app.fetch, port: env.PORT });
console.log(`ingest listening on :${env.PORT}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    collectors.stop();
    deletions.stop();
    server.close(() => {
      void worker
        .stop()
        .then(close)
        .finally(() => process.exit(0));
    });
  });
}
