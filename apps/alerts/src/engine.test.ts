import type { StoredRule } from '@app/db';
import { describe, expect, it } from 'vitest';
import { INACTIVE, step } from './engine.js';

const rule = (forDuration = '5m'): StoredRule => ({
  id: 'r1',
  version: 2,
  workspaceId: 'w',
  spec: {
    name: 'p95 above 800 ms',
    expr: '(q) > 0.8',
    for: forDuration,
    severity: 'warning',
    channel: '#C0OPS',
    status: 'active',
  },
  approvedBy: 'u',
  approvedAt: new Date(0),
  createdBy: { kind: 'user', id: 'u' },
  createdAt: new Date(0),
});
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

describe('the alert state machine', () => {
  it('fires only after the condition has held for the whole duration', () => {
    let state = { ...INACTIVE };
    const kinds: string[] = [];
    for (const minute of [0, 2, 4, 5, 6]) {
      const { next, transition } = step(rule('5m'), state, { holds: true, value: 0.9 }, at(minute));
      kinds.push(`${minute}:${next.state}:${transition.kind}`);
      state = next;
    }
    expect(kinds).toEqual([
      '0:pending:none',
      '2:pending:none',
      '4:pending:none',
      '5:firing:fire',
      '6:firing:none',
    ]);
  });

  it('never announces a condition that stops before the duration', () => {
    let state = step(rule('5m'), { ...INACTIVE }, { holds: true, value: 0.9 }, at(0)).next;
    const result = step(rule('5m'), state, { holds: false, value: null }, at(3));
    expect(result).toMatchObject({ next: { state: 'inactive' }, transition: { kind: 'none' } });
    state = result.next;
    // Starting again counts from the new start.
    expect(step(rule('5m'), state, { holds: true, value: 0.9 }, at(4)).next.since).toEqual(at(4));
  });

  it('resolves a firing rule when the condition stops', () => {
    const firing = { ...INACTIVE, state: 'firing' as const, since: at(0), value: 0.9 };
    expect(step(rule(), firing, { holds: false, value: null }, at(10)).transition).toEqual({
      kind: 'resolve',
    });
  });
});
