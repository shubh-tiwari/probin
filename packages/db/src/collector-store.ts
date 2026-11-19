import { parseCollectorSpec, type CollectorSpec } from '@app/specs';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { collectors } from './schema.js';
import type { Actor } from './spec-store.js';

export interface StoredCollector {
  id: string;
  version: number;
  workspaceId: string;
  spec: CollectorSpec;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdBy: Actor;
}

const fromRow = (row: typeof collectors.$inferSelect): StoredCollector => ({
  id: row.id,
  version: row.version,
  workspaceId: row.workspaceId,
  spec: parseCollectorSpec({
    name: row.name,
    source_type: row.sourceType,
    config: row.config,
    interval: row.interval,
    metric_names: row.metricNames,
    status: row.status,
  }),
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
  createdBy: { kind: row.createdByKind, id: row.createdById },
});

const latest = sql`${collectors.version} = (select max(c.version) from collectors c where c.id = ${collectors.id})`;

/** Collectors, append-only like alert rules: pending until a person approves; an edit needs approving again. */
export function createCollectorStore(db: Database, workspaceId: string) {
  async function current(id: string) {
    const [row] = await db
      .select()
      .from(collectors)
      .where(and(eq(collectors.workspaceId, workspaceId), eq(collectors.id, id)))
      .orderBy(desc(collectors.version))
      .limit(1);
    return row ? fromRow(row) : undefined;
  }
  async function next(
    previous: StoredCollector,
    spec: CollectorSpec,
    actor: Actor,
    approval?: { by: string; at: Date },
  ) {
    const [row] = await db
      .insert(collectors)
      .values({
        id: previous.id,
        version: previous.version + 1,
        workspaceId,
        name: spec.name,
        sourceType: spec.source_type,
        config: spec.config,
        interval: spec.interval,
        metricNames: spec.metric_names,
        status: spec.status,
        approvedBy: approval?.by ?? null,
        approvedAt: approval?.at ?? null,
        createdByKind: actor.kind,
        createdById: actor.id,
      })
      .returning();
    return fromRow(row!);
  }
  return {
    current,
    async draft(spec: CollectorSpec, actor: Actor): Promise<StoredCollector> {
      const valid = parseCollectorSpec({ ...spec, status: 'pending' });
      const [row] = await db
        .insert(collectors)
        .values({
          workspaceId,
          name: valid.name,
          sourceType: valid.source_type,
          config: valid.config,
          interval: valid.interval,
          metricNames: valid.metric_names,
          status: 'pending',
          createdByKind: actor.kind,
          createdById: actor.id,
        })
        .returning();
      return fromRow(row!);
    },
    async approve(id: string, userId: string) {
      const c = await current(id);
      if (!c || c.spec.status !== 'pending') return c;
      return next(
        c,
        { ...c.spec, status: 'active' },
        { kind: 'user', id: userId },
        { by: userId, at: new Date() },
      );
    },
    async disable(id: string, userId: string) {
      const c = await current(id);
      if (!c || c.spec.status === 'disabled') return c;
      return next(c, { ...c.spec, status: 'disabled' }, { kind: 'user', id: userId });
    },
    async edit(id: string, change: Partial<CollectorSpec>, actor: Actor) {
      const c = await current(id);
      if (!c) return undefined;
      return next(c, parseCollectorSpec({ ...c.spec, ...change, status: 'pending' }), actor);
    },
    async list(): Promise<StoredCollector[]> {
      const rows = await db
        .select()
        .from(collectors)
        .where(and(eq(collectors.workspaceId, workspaceId), latest))
        .orderBy(desc(collectors.createdAt));
      return rows.map(fromRow);
    },
  };
}

/** Every collector whose latest version is active, in every workspace. */
export async function listActiveCollectors(db: Database): Promise<StoredCollector[]> {
  const rows = await db
    .select()
    .from(collectors)
    .where(and(eq(collectors.status, 'active'), latest));
  return rows.map(fromRow);
}

export type CollectorStore = ReturnType<typeof createCollectorStore>;
