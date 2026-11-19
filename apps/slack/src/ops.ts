import { createAlertStore, createCollectorStore, schema, type Database } from '@app/db';
import { and, eq } from 'drizzle-orm';
import type { AlertOps } from './conversation.js';

/** Alert and collector actions for one person in one workspace. */
export function alertOps(db: Database, workspaceId: string, userId: string): AlertOps {
  const rules = createAlertStore(db, workspaceId);
  const collectors = createCollectorStore(db, workspaceId);
  const { alertStates } = schema;
  return {
    approveRule: async (ruleId) => (await rules.approve(ruleId, userId))?.spec,
    discardRule: async (ruleId) => (await rules.disable(ruleId, userId))?.spec,
    approveCollector: async (id) => {
      const c = await collectors.approve(id, userId);
      return c ? { spec: c.spec } : undefined;
    },
    discardCollector: async (id) => {
      const c = await collectors.disable(id, userId);
      return c ? { spec: c.spec } : undefined;
    },
    async snooze(ruleId, hours) {
      const updated = await db
        .update(alertStates)
        .set({ snoozedUntil: new Date(Date.now() + hours * 3_600_000) })
        .where(and(eq(alertStates.ruleId, ruleId), eq(alertStates.workspaceId, workspaceId)))
        .returning({ ruleId: alertStates.ruleId });
      return updated.length > 0;
    },
    async acknowledge(ruleId) {
      const updated = await db
        .update(alertStates)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: userId })
        .where(
          and(
            eq(alertStates.ruleId, ruleId),
            eq(alertStates.workspaceId, workspaceId),
            eq(alertStates.state, 'firing'),
          ),
        )
        .returning({ ruleId: alertStates.ruleId });
      return updated.length > 0;
    },
  };
}
