import { catalogFingerprint, catalogNames, searchCatalog } from '@app/catalog';
import {
  createAlertStore,
  createCollectorStore,
  createSpecStore,
  schema,
  type Database,
} from '@app/db';
import { runHttpCheck } from '@app/ingest';
import { and, eq, sql } from 'drizzle-orm';
import { createQueryApiClient } from '@app/query-api/client';
import type { ResolvedRequest, ToolBackends } from './tools.js';

/**
 * The real backends behind the tools, for one workspace. The catalog and the
 * spec store are read and written in Postgres, filtered by the workspace;
 * queries go through the Query API. The agent never holds the metrics store's
 * address.
 */
export function createBackends(options: {
  db: Database;
  workspaceId: string;
  queryApiUrl: string;
  internalToken: string;
  /** The range a dashboard created here starts with. */
  defaultRange: string;
  /** Let collectors reach private addresses. Local development only. */
  allowPrivateCollectors?: boolean;
}): ToolBackends {
  const { db, workspaceId } = options;
  const queryApi = createQueryApiClient({
    url: options.queryApiUrl,
    internalToken: options.internalToken,
    workspaceId,
  });
  const specs = createSpecStore(db, workspaceId);

  const { resolvedRequests } = schema;
  return {
    resolved: {
      async get(key) {
        const [row] = await db
          .select()
          .from(resolvedRequests)
          .where(and(eq(resolvedRequests.workspaceId, workspaceId), eq(resolvedRequests.key, key)))
          .limit(1);
        if (!row) return undefined;
        await db
          .update(resolvedRequests)
          .set({ hits: sql`${resolvedRequests.hits} + 1` })
          .where(and(eq(resolvedRequests.workspaceId, workspaceId), eq(resolvedRequests.key, key)));
        return {
          ...(row.value as Omit<ResolvedRequest, 'fingerprint'>),
          fingerprint: row.catalogFingerprint,
        };
      },
      async put(key, entry) {
        const { fingerprint, ...value } = entry;
        await db
          .insert(resolvedRequests)
          .values({ workspaceId, key, value, catalogFingerprint: fingerprint })
          .onConflictDoUpdate({
            target: [resolvedRequests.workspaceId, resolvedRequests.key],
            set: { value, catalogFingerprint: fingerprint, hits: 0, createdAt: new Date() },
          });
      },
      fingerprint: (services) => catalogFingerprint(db, workspaceId, services),
      names: (services) => catalogNames(db, workspaceId, services),
    },
    searchCatalog: (search) => searchCatalog(db, workspaceId, search),
    async draftAlert(spec, actor) {
      const rule = await createAlertStore(db, workspaceId).draft(spec, actor);
      return { ruleId: rule.id };
    },
    async draftCollector(spec, actor) {
      // One test fetch before anything is written. It also refuses unsafe URLs.
      const test = await runHttpCheck(String(spec.config.url), {
        allowPrivate: options.allowPrivateCollectors ?? false,
      });
      const collector = await createCollectorStore(db, workspaceId).draft(spec, actor);
      return { collectorId: collector.id, test };
    },
    dryRun: (query, range) => queryApi.dryRun({ query, range }),
    async savePanel(spec, actor, dashboardId, panelId) {
      if (panelId) {
        // A change to an existing panel: a new version of it, on whichever dashboard holds it.
        const { panel } = await specs.savePanel(spec, actor, { panelId });
        const holder = (await specs.listDashboards()).find((d) =>
          d.spec.panel_ids.includes(panelId),
        );
        return {
          panelId: panel.id,
          version: panel.version,
          dashboardId: holder?.id ?? dashboardId ?? '',
        };
      }
      // With no dashboard named, use the workspace's first one, creating it if there is none.
      let target = dashboardId;
      if (!target) {
        const existing = await specs.listDashboards();
        target =
          existing[0]?.id ??
          (
            await specs.createDashboard(
              {
                title: 'Dashboard',
                panel_ids: [],
                layout: [],
                default_range: options.defaultRange,
              },
              actor,
            )
          ).id;
      }
      const { panel } = await specs.savePanel(spec, actor, { dashboardId: target });
      return { panelId: panel.id, version: panel.version, dashboardId: target };
    },
  };
}
