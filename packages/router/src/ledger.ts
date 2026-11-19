import { findPlan, type PlansConfig } from '@app/config';
import { schema, type Database } from '@app/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { CallOutcome, CallRecord, Ledger } from './types.js';

const { modelCalls, workspaces } = schema;

/** The ledger in Postgres: `model_calls` for spend, the workspace and its plan for the limit. */
export function createDatabaseLedger(
  db: Database,
  plans: PlansConfig,
  now: () => Date = () => new Date(),
): Ledger {
  return {
    async budget(workspaceId) {
      const [workspace] = await db
        .select({ plan: workspaces.plan, override: workspaces.monthlyModelBudget })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace) throw new Error(`No workspace ${workspaceId}.`);
      const limit =
        workspace.override !== null
          ? Number(workspace.override)
          : (findPlan(plans, workspace.plan)?.limits.model_budget_monthly ?? null);

      const today = now();
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const [row] = await db
        .select({ spent: sql<string>`coalesce(sum(${modelCalls.cost}), 0)` })
        .from(modelCalls)
        .where(and(eq(modelCalls.workspaceId, workspaceId), gte(modelCalls.createdAt, monthStart)));
      return { limit, spent: Number(row?.spent ?? 0) };
    },

    async record(call: CallRecord) {
      const [row] = await db
        .insert(modelCalls)
        .values({
          workspaceId: call.workspaceId,
          requestId: call.requestId,
          taskType: call.task,
          model: call.model,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          cost: call.cost.toFixed(6),
          outcome: call.outcome,
          escalatedFrom: call.escalatedFrom ?? null,
        })
        .returning({ id: modelCalls.id });
      return row!.id;
    },

    async setOutcome(callId: string, outcome: CallOutcome) {
      await db.update(modelCalls).set({ outcome }).where(eq(modelCalls.id, callId));
    },
  };
}

/** A ledger in memory, for tests and for runs with no database. */
export function createMemoryLedger(options: { limit?: number | null } = {}) {
  const calls: (CallRecord & { id: string })[] = [];
  const ledger: Ledger = {
    async budget() {
      return {
        limit: options.limit ?? null,
        spent: calls.reduce((sum, call) => sum + call.cost, 0),
      };
    },
    async record(call) {
      const id = `call-${calls.length + 1}`;
      calls.push({ ...call, id });
      return id;
    },
    async setOutcome(callId, outcome) {
      const call = calls.find((one) => one.id === callId);
      if (call) call.outcome = outcome;
    },
  };
  return { ledger, calls };
}
