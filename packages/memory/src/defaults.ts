import type { Memory } from './memory.js';

/**
 * A person's saved answers to cross-check questions ("Skip questions next
 * time"). Stored as user_default memory entries, one per question, so each
 * shows on the memory page and can be edited or deleted there.
 */
export interface UserDefaults {
  /** Percentile for latency charts, e.g. 95. */
  percentile?: number;
  /** Which requests to count. */
  requests?: 'all' | 'failed_only' | 'successful_only';
}

const subject = (userId: string, key: keyof UserDefaults) => `user:${userId}:${key}`;

const DESCRIBE: {
  [K in keyof Required<UserDefaults>]: (value: Required<UserDefaults>[K]) => string;
} = {
  percentile: (value) => `Prefers p${value} for latency charts`,
  requests: (value) =>
    value === 'all'
      ? 'Counts all requests, including failures'
      : value === 'failed_only'
        ? 'Counts failed requests only'
        : 'Counts successful requests only',
};

export async function readUserDefaults(memory: Memory, userId: string): Promise<UserDefaults> {
  const entries = await memory.list({
    kind: 'user_default',
    subjects: [subject(userId, 'percentile'), subject(userId, 'requests')],
  });
  const defaults: UserDefaults = {};
  for (const entry of entries) {
    const value = entry.value as { percentile?: unknown; requests?: unknown } | null;
    if (entry.subject.endsWith(':percentile') && typeof value?.percentile === 'number') {
      defaults.percentile ??= value.percentile;
    }
    if (
      entry.subject.endsWith(':requests') &&
      (value?.requests === 'all' ||
        value?.requests === 'failed_only' ||
        value?.requests === 'successful_only')
    ) {
      defaults.requests ??= value.requests;
    }
  }
  if (entries.length > 0) await memory.markUsed(entries.map((entry) => entry.id));
  return defaults;
}

/** Save answers as the person's defaults. Each replaces the previous one. */
export async function saveUserDefaults(
  memory: Memory,
  userId: string,
  defaults: UserDefaults,
  source: string,
): Promise<number> {
  let saved = 0;
  for (const key of ['percentile', 'requests'] as const) {
    const value = defaults[key];
    if (value === undefined) continue;
    await memory.replace(
      {
        kind: 'user_default',
        subject: subject(userId, key),
        text: (DESCRIBE[key] as (v: typeof value) => string)(value),
        source,
        value: { [key]: value },
      },
      { kind: 'user', id: userId },
    );
    saved += 1;
  }
  return saved;
}
