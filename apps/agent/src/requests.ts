import { schema, type Database } from '@app/db';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AgentState } from './types.js';

/** Where open requests live between a question and its answer. */
export interface RequestStore {
  get(
    requestId: string,
    workspaceId: string,
  ): Promise<{ state: AgentState; surface: Surface } | undefined>;
  put(state: AgentState, surface?: Surface): Promise<void>;
  /** The latest request with a chart in a Slack thread. */
  latestInThread(
    workspaceId: string,
    channel: string,
    threadTs: string,
  ): Promise<AgentState | undefined>;
}

/** Where the conversation happens, so a reply goes back to the same place. */
export type Surface = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Requests in Postgres, so a Slack thread can be answered hours later and after a restart. */
export function createDatabaseRequestStore(db: Database): RequestStore {
  const { agentRequests } = schema;
  return {
    async get(requestId, workspaceId) {
      if (!UUID.test(requestId)) return undefined;
      const [row] = await db
        .select()
        .from(agentRequests)
        .where(and(eq(agentRequests.id, requestId), eq(agentRequests.workspaceId, workspaceId)))
        .limit(1);
      return row ? { state: row.state as AgentState, surface: row.surface as Surface } : undefined;
    },
    async put(state, surface) {
      await db
        .insert(agentRequests)
        .values({
          id: state.requestId,
          workspaceId: state.workspaceId,
          userId: state.userId,
          status: state.status,
          state,
          surface: surface ?? {},
        })
        .onConflictDoUpdate({
          target: agentRequests.id,
          set: {
            status: state.status,
            state,
            updatedAt: new Date(),
            ...(surface ? { surface } : {}),
          },
        });
    },
    async latestInThread(workspaceId, channel, threadTs) {
      const [row] = await db
        .select()
        .from(agentRequests)
        .where(
          and(
            eq(agentRequests.workspaceId, workspaceId),
            inArray(agentRequests.status, ['draft', 'saved', 'alert']),
            sql`${agentRequests.surface}->'slack'->>'channel' = ${channel}`,
            sql`${agentRequests.surface}->'slack'->>'thread_ts' = ${threadTs}`,
          ),
        )
        .orderBy(desc(agentRequests.updatedAt))
        .limit(1);
      return row ? (row.state as AgentState) : undefined;
    },
  };
}

/** Delete requests nobody has touched for `days`. */
export async function pruneRequests(db: Database, days: number): Promise<void> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  await db.delete(schema.agentRequests).where(lt(schema.agentRequests.updatedAt, cutoff));
}

/** Requests in memory: for tests and the command line. */
export function createMemoryRequestStore(): RequestStore {
  const entries = new Map<string, { state: AgentState; surface: Surface }>();
  return {
    async get(requestId, workspaceId) {
      const entry = entries.get(requestId);
      if (!entry || entry.state.workspaceId !== workspaceId) return undefined;
      return structuredClone(entry);
    },
    async put(state, surface) {
      const previous = entries.get(state.requestId);
      entries.set(
        state.requestId,
        structuredClone({ state, surface: surface ?? previous?.surface ?? {} }),
      );
    },
    async latestInThread(workspaceId, channel, threadTs) {
      const found = [...entries.values()]
        .filter((e) => {
          const slack = (e.surface as { slack?: { channel?: string; thread_ts?: string } }).slack;
          return (
            e.state.workspaceId === workspaceId &&
            slack?.channel === channel &&
            slack.thread_ts === threadTs &&
            ['draft', 'saved', 'alert'].includes(e.state.status)
          );
        })
        .at(-1);
      return found ? structuredClone(found.state) : undefined;
    },
  };
}
