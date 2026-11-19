import { createSecretBox, findPlan, type MetricsStoreType, type PlansConfig } from '@app/config';
import { getWorkspace, type Database } from '@app/db';
import type { WorkspaceStore } from './service.js';
import { createMetricsStore, type MetricsStore } from './store.js';

/**
 * A customer's own store (H8), as kept in `workspaces.metrics_store_config`.
 * The bearer token, if any, is sealed with SECRETS_KEY.
 */
export interface ExternalStoreConfig {
  type: MetricsStoreType;
  url: string;
  tokenSealed?: string;
}

export function parseStoreConfig(value: unknown): ExternalStoreConfig | undefined {
  const config = value as Partial<ExternalStoreConfig> | null;
  if (!config?.url || (config.type !== 'victoriametrics' && config.type !== 'prometheus'))
    return undefined;
  return {
    type: config.type,
    url: config.url,
    ...(config.tokenSealed ? { tokenSealed: config.tokenSealed } : {}),
  };
}

/** Which store serves each workspace, read from Postgres and kept for 30 seconds. */
export function workspaceStores(options: {
  db: Database;
  plans: PlansConfig;
  hosted: MetricsStore;
  secretsKey: string;
  timeoutMs: number;
}) {
  const box = createSecretBox(options.secretsKey);
  const cache = new Map<string, { value: WorkspaceStore; until: number }>();
  return async (workspaceId: string): Promise<WorkspaceStore | undefined> => {
    const hit = cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return hit.value;
    const workspace = await getWorkspace(options.db, workspaceId).catch(() => undefined);
    // An unknown workspace has no data in the hosted store; scoping alone keeps it empty.
    if (!workspace) return undefined;
    const retention = findPlan(options.plans, workspace.plan)?.limits.retention_days;
    const external = parseStoreConfig(workspace.metricsStoreConfig);
    const value: WorkspaceStore = external
      ? {
          store: createMetricsStore({
            url: external.url.replace(/\/+$/, ''),
            type: external.type,
            timeoutMs: options.timeoutMs,
            ...(external.tokenSealed ? { bearerToken: box.open(external.tokenSealed) } : {}),
          }),
          external: true,
        }
      : {
          store: options.hosted,
          external: false,
          ...(retention ? { retentionDays: retention } : {}),
        };
    cache.set(workspaceId, { value, until: Date.now() + 30_000 });
    return value;
  };
}
