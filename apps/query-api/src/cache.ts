/**
 * The query result cache: short-lived, in this process.
 *
 * The workspace id is a separate argument and always part of the key, so an
 * entry can never be served to another workspace by a mistake in how a caller
 * builds its key.
 */
export interface ResultCache<T> {
  get(workspaceId: string, key: string): T | undefined;
  set(workspaceId: string, key: string, value: T): void;
  /** Drop everything a workspace has cached, e.g. when it is deleted. */
  clear(workspaceId: string): void;
}

export function createResultCache<T>(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): ResultCache<T> {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1000;
  const entries = new Map<string, { value: T; expires: number }>();
  // The separator cannot occur in a workspace id, so two workspaces cannot collide.
  const full = (workspaceId: string, key: string) => `${workspaceId}\u0000${key}`;

  return {
    get(workspaceId, key) {
      if (options.ttlMs <= 0) return undefined;
      const id = full(workspaceId, key);
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        entries.delete(id);
        return undefined;
      }
      return entry.value;
    },
    set(workspaceId, key, value) {
      if (options.ttlMs <= 0) return;
      const id = full(workspaceId, key);
      entries.delete(id);
      entries.set(id, { value, expires: now() + options.ttlMs });
      // Oldest first out. A Map keeps insertion order.
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear(workspaceId) {
      const prefix = `${workspaceId}\u0000`;
      for (const id of entries.keys()) {
        if (id.startsWith(prefix)) entries.delete(id);
      }
    },
  };
}
