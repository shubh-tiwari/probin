import { schema, type Actor, type Database } from '@app/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

const { memoryEntries } = schema;

export const MEMORY_KINDS = [
  'user_default',
  'team_decision',
  'incident',
  'service_map',
  'review_feedback',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  subject: string;
  text: string;
  source: string;
  value: unknown;
  createdBy: Actor;
  createdAt: Date;
  lastUsed: Date | null;
}

export interface NewMemoryEntry {
  kind: MemoryKind;
  subject: string;
  /** What people read on the memory page. */
  text: string;
  source: string;
  /** The same fact for code, when code needs it. */
  value?: unknown;
}

/** The agent may write these by itself. A team decision needs a person. */
const AGENT_MAY_WRITE = new Set<MemoryKind>([
  'user_default',
  'incident',
  'service_map',
  'review_feedback',
]);

export class MemoryError extends Error {
  override name = 'MemoryError';
}

const fromRow = (row: typeof memoryEntries.$inferSelect): MemoryEntry => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  text: row.text,
  source: row.source,
  value: row.value,
  createdBy: { kind: row.createdByKind, id: row.createdById },
  createdAt: row.createdAt,
  lastUsed: row.lastUsed,
});

/**
 * Per-workspace memory that Watch and Review both read. Everything here is
 * filtered by the workspace the store was created for, and deleted with it.
 */
export function createMemory(db: Database, workspaceId: string) {
  return {
    async list(filter: { kind?: MemoryKind; subjects?: string[] } = {}): Promise<MemoryEntry[]> {
      const rows = await db
        .select()
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.workspaceId, workspaceId),
            filter.kind ? eq(memoryEntries.kind, filter.kind) : undefined,
            filter.subjects?.length ? inArray(memoryEntries.subject, filter.subjects) : undefined,
          ),
        )
        .orderBy(desc(memoryEntries.createdAt));
      return rows.map(fromRow);
    },

    async get(id: string): Promise<MemoryEntry | undefined> {
      const [row] = await db
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.workspaceId, workspaceId), eq(memoryEntries.id, id)))
        .limit(1);
      return row ? fromRow(row) : undefined;
    },

    async write(entry: NewMemoryEntry, actor: Actor): Promise<MemoryEntry> {
      if (actor.kind !== 'user' && !AGENT_MAY_WRITE.has(entry.kind)) {
        throw new MemoryError(`A ${entry.kind.replace('_', ' ')} needs a person to write it.`);
      }
      const [row] = await db
        .insert(memoryEntries)
        .values({
          workspaceId,
          kind: entry.kind,
          subject: entry.subject,
          text: entry.text,
          source: entry.source,
          value: entry.value ?? null,
          createdByKind: actor.kind,
          createdById: actor.id,
        })
        .returning();
      return fromRow(row!);
    },

    /** Replace every entry of a kind and subject with one entry. */
    async replace(entry: NewMemoryEntry, actor: Actor): Promise<MemoryEntry> {
      return db.transaction(async (tx) => {
        await tx
          .delete(memoryEntries)
          .where(
            and(
              eq(memoryEntries.workspaceId, workspaceId),
              eq(memoryEntries.kind, entry.kind),
              eq(memoryEntries.subject, entry.subject),
            ),
          );
        return createMemory(tx, workspaceId).write(entry, actor);
      });
    },

    async update(
      id: string,
      change: { subject?: string; text?: string },
    ): Promise<MemoryEntry | undefined> {
      const [row] = await db
        .update(memoryEntries)
        .set(change)
        .where(and(eq(memoryEntries.workspaceId, workspaceId), eq(memoryEntries.id, id)))
        .returning();
      return row ? fromRow(row) : undefined;
    },

    async remove(id: string): Promise<boolean> {
      const deleted = await db
        .delete(memoryEntries)
        .where(and(eq(memoryEntries.workspaceId, workspaceId), eq(memoryEntries.id, id)))
        .returning({ id: memoryEntries.id });
      return deleted.length === 1;
    },

    async markUsed(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      await db
        .update(memoryEntries)
        .set({ lastUsed: sql`now()` })
        .where(and(eq(memoryEntries.workspaceId, workspaceId), inArray(memoryEntries.id, ids)));
    },
  };
}

export type Memory = ReturnType<typeof createMemory>;
