import { schema, type Database } from '@app/db';
import { createQueryApiClient } from '@app/query-api/client';
import { and, eq, isNotNull, lte } from 'drizzle-orm';

/**
 * H7: delete cancelled workspaces once their grace period is over. First the
 * metrics in the hosted store and the Query API's cached results, then the
 * workspace row, which takes every spec, catalog entry, memory entry, cached
 * request, token and installation with it.
 */
export async function deleteDueWorkspaces(options: {
  db: Database;
  queryApiUrl: string;
  internalToken: string;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const due = await options.db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.billingStatus, 'canceled'),
        isNotNull(schema.workspaces.deletionScheduledAt),
        lte(schema.workspaces.deletionScheduledAt, now),
      ),
    );
  const deleted: string[] = [];
  for (const { id } of due) {
    const query = createQueryApiClient({
      url: options.queryApiUrl,
      internalToken: options.internalToken,
      workspaceId: id,
    });
    try {
      await query.deleteWorkspaceData();
    } catch (error) {
      // Keep the workspace until its metrics are gone; try again next time.
      console.error(`deleting metrics of ${id}`, error);
      continue;
    }
    await options.db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    deleted.push(id);
    console.log(`deleted workspace ${id}`);
  }
  return deleted;
}

export function startDeletionRunner(options: {
  db: Database;
  queryApiUrl: string;
  internalToken: string;
  everyMs?: number;
}) {
  const timer = setInterval(() => {
    deleteDueWorkspaces(options).catch((error) => console.error('deletion runner', error));
  }, options.everyMs ?? 10_000);
  return { stop: () => clearInterval(timer) };
}
