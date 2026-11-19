import { parseAlertRuleSpec, type AlertRuleSpec } from '@app/specs';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { alertRules, alertStates } from './schema.js';
import type { Actor } from './spec-store.js';

export interface StoredRule {
  id: string;
  version: number;
  workspaceId: string;
  spec: AlertRuleSpec;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdBy: Actor;
  createdAt: Date;
}

const fromRow = (row: typeof alertRules.$inferSelect): StoredRule => ({
  id: row.id,
  version: row.version,
  workspaceId: row.workspaceId,
  spec: parseAlertRuleSpec({
    name: row.name,
    expr: row.expression,
    for: row.duration,
    severity: row.severity,
    channel: row.channel,
    status: row.status,
    ...(row.query ? { query: row.query } : {}),
    ...(row.comparison ? { comparison: row.comparison } : {}),
    ...(row.unit !== null ? { unit: row.unit } : {}),
    ...(row.displayUnit ? { display_unit: row.displayUnit } : {}),
    ...(row.service ? { service: row.service } : {}),
    ...(row.request ? { request: row.request } : {}),
    assumptions: row.assumptions as string[],
  }),
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
  createdBy: { kind: row.createdByKind, id: row.createdById },
  createdAt: row.createdAt,
});

const columns = (spec: AlertRuleSpec) => ({
  name: spec.name,
  expression: spec.expr,
  duration: spec.for,
  severity: spec.severity,
  channel: spec.channel,
  query: spec.query ?? null,
  comparison: spec.comparison ?? null,
  unit: spec.unit ?? null,
  displayUnit: spec.display_unit ?? null,
  service: spec.service ?? null,
  request: spec.request ?? null,
  assumptions: spec.assumptions ?? [],
});

/** Latest version of each rule, as a SQL condition. */
const latest = sql`${alertRules.version} = (select max(r.version) from alert_rules r where r.id = ${alertRules.id})`;

/**
 * Alert rules, append-only. Every change is a new version. A rule does
 * nothing until a person approves it, and an edit sends it back to pending:
 * approval covers exactly the version that was approved.
 */
export function createAlertStore(db: Database, workspaceId: string) {
  async function current(ruleId: string): Promise<StoredRule | undefined> {
    const [row] = await db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.workspaceId, workspaceId), eq(alertRules.id, ruleId)))
      .orderBy(desc(alertRules.version))
      .limit(1);
    return row ? fromRow(row) : undefined;
  }

  async function next(
    previous: StoredRule,
    spec: AlertRuleSpec,
    actor: Actor,
    approval?: { by: string; at: Date },
  ): Promise<StoredRule> {
    const [row] = await db
      .insert(alertRules)
      .values({
        id: previous.id,
        version: previous.version + 1,
        workspaceId,
        ...columns(spec),
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

    /** draft_alert: write a new rule, always pending. */
    async draft(spec: AlertRuleSpec, actor: Actor): Promise<StoredRule> {
      const valid = parseAlertRuleSpec({ ...spec, status: 'pending' });
      const [row] = await db
        .insert(alertRules)
        .values({
          workspaceId,
          ...columns(valid),
          status: 'pending',
          createdByKind: actor.kind,
          createdById: actor.id,
        })
        .returning();
      return fromRow(row!);
    },

    /** Approve the current version. Anyone in the workspace may; their user id is recorded. */
    async approve(ruleId: string, userId: string): Promise<StoredRule | undefined> {
      const rule = await current(ruleId);
      if (!rule || rule.spec.status !== 'pending') return rule;
      return next(
        rule,
        { ...rule.spec, status: 'active' },
        { kind: 'user', id: userId },
        { by: userId, at: new Date() },
      );
    },

    /** Discard a pending rule, or switch off an active one. */
    async disable(ruleId: string, userId: string): Promise<StoredRule | undefined> {
      const rule = await current(ruleId);
      if (!rule || rule.spec.status === 'disabled') return rule;
      const changed = await next(
        rule,
        { ...rule.spec, status: 'disabled' },
        { kind: 'user', id: userId },
      );
      await db.delete(alertStates).where(eq(alertStates.ruleId, ruleId));
      return changed;
    },

    /** Change a rule. The result is pending again and needs a fresh approval. */
    async edit(
      ruleId: string,
      change: Partial<AlertRuleSpec>,
      actor: Actor,
    ): Promise<StoredRule | undefined> {
      const rule = await current(ruleId);
      if (!rule) return undefined;
      const spec = parseAlertRuleSpec({ ...rule.spec, ...change, status: 'pending' });
      const changed = await next(rule, spec, actor);
      await db.delete(alertStates).where(eq(alertStates.ruleId, ruleId));
      return changed;
    },

    /** The latest version of every rule in the workspace, newest first. */
    async list(): Promise<StoredRule[]> {
      const rows = await db
        .select()
        .from(alertRules)
        .where(and(eq(alertRules.workspaceId, workspaceId), latest))
        .orderBy(desc(alertRules.createdAt));
      return rows.map(fromRow);
    },
  };
}

/** The alert engine's view: the latest version of every rule whose latest version is active, in every workspace. */
export async function listActiveRules(db: Database): Promise<StoredRule[]> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.status, 'active'), latest));
  return rows.map(fromRow);
}

export type AlertStore = ReturnType<typeof createAlertStore>;
