import { durationToSeconds } from '@app/specs';
import type { StoredRule } from '@app/db';

/** What the engine remembers about one rule between evaluations. */
export interface RuleState {
  state: 'inactive' | 'pending' | 'firing';
  /** When the condition became true. */
  since: Date | null;
  value: number | null;
  snoozedUntil: Date | null;
  acknowledgedAt: Date | null;
  /** Where the firing message went. */
  notification: { channel: string; ts: string } | null;
}

export const INACTIVE: RuleState = {
  state: 'inactive',
  since: null,
  value: null,
  snoozedUntil: null,
  acknowledgedAt: null,
  notification: null,
};

export type Transition =
  | { kind: 'none' }
  /** The condition held for the rule's whole `for` duration: notify. */
  | { kind: 'fire'; value: number }
  /** The condition stopped holding while firing: say it resolved. */
  | { kind: 'resolve' };

/**
 * One step of a rule's life. Pure: given the rule, what it was, and whether
 * its condition holds now, say what it is now and what to announce.
 *
 *   inactive --true--> pending --true for `for`--> firing --false--> inactive
 *               pending --false--> inactive (never announced)
 *
 * A snoozed rule still fires and resolves, but nothing is announced while the
 * snooze lasts.
 */
export function step(
  rule: StoredRule,
  previous: RuleState,
  observed: { holds: boolean; value: number | null },
  now: Date,
): { next: RuleState; transition: Transition } {
  const holdFor = durationToSeconds(rule.spec.for) * 1000;
  if (!observed.holds) {
    if (previous.state === 'firing') {
      return { next: { ...INACTIVE }, transition: { kind: 'resolve' } };
    }
    return {
      next: { ...INACTIVE, snoozedUntil: previous.snoozedUntil },
      transition: { kind: 'none' },
    };
  }
  const since = previous.state === 'inactive' ? now : (previous.since ?? now);
  const value = observed.value;
  if (previous.state === 'firing') {
    return { next: { ...previous, value }, transition: { kind: 'none' } };
  }
  if (now.getTime() - since.getTime() >= holdFor) {
    return {
      next: { ...previous, state: 'firing', since, value },
      transition: { kind: 'fire', value: value ?? Number.NaN },
    };
  }
  return { next: { ...previous, state: 'pending', since, value }, transition: { kind: 'none' } };
}

export const isSnoozed = (state: RuleState, now: Date) =>
  state.snoozedUntil !== null && state.snoozedUntil.getTime() > now.getTime();
