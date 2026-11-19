import { syncCatalog, type StoreReader, type SyncResult } from '@app/catalog';
import { schema, type Database } from '@app/db';
import { createQueryApiClient } from '@app/query-api/client';
import { PgBoss } from 'pg-boss';
import { CHECKS_SERVICE } from './collector-runner.js';
import { makeStarterContent } from './starter.js';

const SYNC_QUEUE = 'catalog-sync';
const SWEEP_QUEUE = 'catalog-sync-sweep';

export interface SyncWorker {
  /** Ask for one workspace's catalog to be synced soon. Repeated requests collapse into one. */
  request(workspaceId: string, delaySeconds?: number): Promise<void>;
  stop(): Promise<void>;
}

/** A store reader for one workspace. It goes through the Query API, like everything else. */
export function storeReaderFor(options: {
  queryApiUrl: string;
  internalToken: string;
  workspaceId: string;
}): StoreReader {
  const client = createQueryApiClient({
    url: options.queryApiUrl,
    internalToken: options.internalToken,
    workspaceId: options.workspaceId,
  });
  return { series: client.series, instant: client.instant };
}

/**
 * Keeps every workspace's catalog in step with its metrics store.
 *
 * Runs on the Postgres-backed job queue: once a minute for every workspace,
 * and shortly after a manifest is registered. No model is involved.
 */
export async function startSyncWorker(options: {
  db: Database;
  databaseUrl: string;
  queryApiUrl: string;
  internalToken: string;
  onResult?: (workspaceId: string, result: SyncResult) => void;
}): Promise<SyncWorker> {
  const boss = new PgBoss(options.databaseUrl);
  boss.on('error', (error) => console.error('job queue error', error));
  await boss.start();
  await boss.createQueue(SYNC_QUEUE);
  await boss.createQueue(SWEEP_QUEUE);

  const request = async (workspaceId: string, delaySeconds = 0) => {
    await boss.send(
      SYNC_QUEUE,
      { workspaceId },
      // One pending sync per workspace per ten seconds is enough.
      { singletonKey: workspaceId, singletonSeconds: 10, startAfter: delaySeconds },
    );
  };

  await boss.work<{ workspaceId: string }>(SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { workspaceId } = job.data;
      const result = await syncCatalog(
        options.db,
        workspaceId,
        storeReaderFor({ ...options, workspaceId }),
      );
      options.onResult?.(workspaceId, result);
      // K5: a starter dashboard and suggested alerts for services seen for the first time.
      const query = createQueryApiClient({
        url: options.queryApiUrl,
        internalToken: options.internalToken,
        workspaceId,
      });
      for (const service of result.services) {
        if (service === CHECKS_SERVICE || service.startsWith('verify-')) continue;
        await makeStarterContent(options.db, workspaceId, service, query).catch((error) =>
          console.error(`starter content for ${service}`, error),
        );
      }
    }
  });

  await boss.work(SWEEP_QUEUE, async () => {
    const rows = await options.db.select({ id: schema.workspaces.id }).from(schema.workspaces);
    for (const row of rows) await request(row.id);
  });
  await boss.schedule(SWEEP_QUEUE, '* * * * *');

  return { request, stop: () => boss.stop() };
}
