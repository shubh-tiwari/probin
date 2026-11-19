import { displayUnit, formatValue } from '@app/charts';
import { listActiveRules, schema, type Database, type StoredRule } from '@app/db';
import { createMemory } from '@app/memory';
import type { QueryApiClient } from '@app/query-api/client';
import { eq } from 'drizzle-orm';
import { INACTIVE, isSnoozed, step, type RuleState } from './engine.js';

export interface Notifier {
  /** Announce a firing rule. Returns where the message went, for later updates. */
  firing(rule: StoredRule, value: number): Promise<{ channel: string; ts: string } | null>;
  resolved(rule: StoredRule, where: { channel: string; ts: string } | null): Promise<void>;
}

export interface RunnerDependencies {
  db: Database;
  queryFor(workspaceId: string): QueryApiClient;
  notifier: Notifier;
  now?: () => Date;
  log?: (message: string) => void;
}

const { alertStates } = schema;

async function loadState(db: Database, ruleId: string): Promise<RuleState> {
  const [row] = await db.select().from(alertStates).where(eq(alertStates.ruleId, ruleId)).limit(1);
  if (!row) return { ...INACTIVE };
  return {
    state: row.state as RuleState['state'],
    since: row.since,
    value: row.value,
    snoozedUntil: row.snoozedUntil,
    acknowledgedAt: row.acknowledgedAt,
    notification: row.notification as RuleState['notification'],
  };
}

async function saveState(
  db: Database,
  rule: StoredRule,
  state: RuleState,
  now: Date,
  incidentId?: string,
) {
  const values = {
    workspaceId: rule.workspaceId,
    state: state.state,
    since: state.since,
    value: state.value !== null && Number.isFinite(state.value) ? state.value : null,
    evaluatedAt: now,
    snoozedUntil: state.snoozedUntil,
    acknowledgedAt: state.acknowledgedAt,
    ...(state.acknowledgedAt === null ? { acknowledgedBy: null } : {}),
    notification: state.notification,
    ...(incidentId !== undefined ? { incidentId } : {}),
  };
  await db
    .insert(alertStates)
    .values({ ruleId: rule.id, ...values })
    .onConflictDoUpdate({ target: alertStates.ruleId, set: values });
}

/**
 * One pass over every active rule in every workspace. Only rules whose latest
 * version is active are loaded: a pending rule is never evaluated, so it can
 * never notify. Each query goes through the Query API, scoped to the rule's
 * own workspace. No model is called.
 */
export async function evaluateOnce(
  deps: RunnerDependencies,
): Promise<{ evaluated: number; fired: number; resolved: number }> {
  const now = deps.now?.() ?? new Date();
  const rules = await listActiveRules(deps.db);
  let fired = 0;
  let resolved = 0;
  for (const rule of rules) {
    let observed: { holds: boolean; value: number | null };
    try {
      const rows = await deps.queryFor(rule.workspaceId).instant(rule.spec.expr);
      const values = rows.map((row) => row.value).filter(Number.isFinite);
      const pick = rule.spec.comparison?.op === '<' ? Math.min : Math.max;
      observed = { holds: rows.length > 0, value: values.length > 0 ? pick(...values) : null };
    } catch (error) {
      // A failing query changes nothing: no false resolve, no false fire.
      deps.log?.(`rule ${rule.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const previous = await loadState(deps.db, rule.id);
    const { next, transition } = step(rule, previous, observed, now);
    let incidentId: string | undefined;
    if (transition.kind === 'fire') {
      fired += 1;
      const unit = displayUnit(rule.spec.unit ?? '', rule.spec.display_unit);
      const incident = await createMemory(deps.db, rule.workspaceId).write(
        {
          kind: 'incident',
          subject: rule.spec.name,
          text: `Fired at ${now.toISOString()} with ${formatValue(transition.value, unit)}.`,
          source: `alert rule ${rule.id}`,
          value: { ruleId: rule.id, firedAt: now.toISOString(), value: transition.value },
        },
        { kind: 'system', id: 'alert-engine' },
      );
      incidentId = incident.id;
      if (!isSnoozed(previous, now)) {
        next.notification = await deps.notifier.firing(rule, transition.value).catch((error) => {
          deps.log?.(
            `notify ${rule.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
      }
    } else if (transition.kind === 'resolve') {
      resolved += 1;
      if (!isSnoozed(previous, now))
        await deps.notifier.resolved(rule, previous.notification).catch(() => undefined);
    }
    await saveState(deps.db, rule, next, now, incidentId);
  }
  return { evaluated: rules.length, fired, resolved };
}
