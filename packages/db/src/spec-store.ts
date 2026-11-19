import { parseDashboardSpec, parsePanelSpec, type DashboardSpec, type PanelSpec } from '@app/specs';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { dashboards, panels } from './schema.js';

/** Who or what wrote a spec version. */
export interface Actor {
  kind: 'user' | 'agent' | 'system';
  /** A user id, or a name for the agent and system jobs. */
  id: string;
}

export interface StoredPanel {
  id: string;
  version: number;
  spec: PanelSpec;
  createdBy: Actor;
  createdAt: Date;
}

export interface StoredDashboard {
  id: string;
  version: number;
  spec: DashboardSpec;
  createdBy: Actor;
  createdAt: Date;
}

const panelFromRow = (row: typeof panels.$inferSelect): StoredPanel => ({
  id: row.id,
  version: row.version,
  spec: parsePanelSpec({
    title: row.title,
    type: row.type,
    query: row.query,
    unit: row.unit,
    ...(row.displayUnit === null ? {} : { display_unit: row.displayUnit }),
    ...(row.range === null ? {} : { range: row.range }),
    thresholds: row.thresholds,
    request: row.request,
    assumptions: row.assumptions,
  }),
  createdBy: { kind: row.createdByKind, id: row.createdById },
  createdAt: row.createdAt,
});

const dashboardFromRow = (row: typeof dashboards.$inferSelect): StoredDashboard => ({
  id: row.id,
  version: row.version,
  spec: parseDashboardSpec({
    title: row.title,
    panel_ids: row.panelIds,
    layout: row.layout,
    default_range: row.defaultRange,
  }),
  createdBy: { kind: row.createdByKind, id: row.createdById },
  createdAt: row.createdAt,
});

/** Grid a dashboard is laid out on, and the size a new panel gets. */
const GRID_COLUMNS = 12;
const PANEL_SIZE = { w: 6, h: 4 };

/**
 * The spec store for one workspace. Specs are append-only: a change is a new
 * version of the same id. Every read and write here is filtered by the
 * workspace the store was created for.
 */
export function createSpecStore(db: Database, workspaceId: string) {
  async function latestPanel(panelId: string): Promise<StoredPanel | undefined> {
    const [row] = await db
      .select()
      .from(panels)
      .where(and(eq(panels.workspaceId, workspaceId), eq(panels.id, panelId)))
      .orderBy(desc(panels.version))
      .limit(1);
    return row ? panelFromRow(row) : undefined;
  }

  async function latestDashboard(dashboardId: string): Promise<StoredDashboard | undefined> {
    const [row] = await db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.workspaceId, workspaceId), eq(dashboards.id, dashboardId)))
      .orderBy(desc(dashboards.version))
      .limit(1);
    return row ? dashboardFromRow(row) : undefined;
  }

  async function writeDashboard(
    spec: DashboardSpec,
    actor: Actor,
    existing?: { id: string; version: number },
  ): Promise<StoredDashboard> {
    const valid = parseDashboardSpec(spec);
    const [row] = await db
      .insert(dashboards)
      .values({
        ...(existing ? { id: existing.id, version: existing.version + 1 } : {}),
        workspaceId,
        title: valid.title,
        layout: valid.layout,
        panelIds: valid.panel_ids,
        defaultRange: valid.default_range,
        createdByKind: actor.kind,
        createdById: actor.id,
      })
      .returning();
    return dashboardFromRow(row!);
  }

  return {
    latestPanel,
    latestDashboard,

    createDashboard(spec: DashboardSpec, actor: Actor): Promise<StoredDashboard> {
      return writeDashboard(spec, actor);
    },

    /** The dashboards of the workspace, newest version of each. */
    async listDashboards(): Promise<StoredDashboard[]> {
      const rows = await db
        .select()
        .from(dashboards)
        .where(
          and(
            eq(dashboards.workspaceId, workspaceId),
            sql`${dashboards.version} = (
              select max(d.version) from dashboards d
              where d.id = ${dashboards.id} and d.workspace_id = ${workspaceId}
            )`,
          ),
        )
        // In the order they were first made, not last changed.
        .orderBy(
          sql`(select min(d.created_at) from dashboards d where d.id = ${dashboards.id} and d.workspace_id = ${workspaceId})`,
        );
      return rows.map(dashboardFromRow);
    },

    /**
     * Save a panel. With `panelId` it is a new version of that panel;
     * without, a new panel. When a dashboard is given, a new panel is also
     * placed on it, which is a new version of the dashboard.
     */
    async savePanel(
      spec: PanelSpec,
      actor: Actor,
      target: { dashboardId?: string; panelId?: string } = {},
    ): Promise<{ panel: StoredPanel; dashboard?: StoredDashboard }> {
      const valid = parsePanelSpec(spec);
      return db.transaction(async (tx) => {
        const store = createSpecStore(tx, workspaceId);
        const previous = target.panelId ? await store.latestPanel(target.panelId) : undefined;
        if (target.panelId && !previous) throw new Error(`No panel ${target.panelId}.`);
        const dashboard = target.dashboardId
          ? await store.latestDashboard(target.dashboardId)
          : undefined;
        if (target.dashboardId && !dashboard)
          throw new Error(`No dashboard ${target.dashboardId}.`);

        const [row] = await tx
          .insert(panels)
          .values({
            ...(previous ? { id: previous.id, version: previous.version + 1 } : {}),
            workspaceId,
            title: valid.title,
            type: valid.type,
            query: valid.query,
            unit: valid.unit,
            displayUnit: valid.display_unit ?? null,
            range: valid.range ?? null,
            thresholds: valid.thresholds,
            request: valid.request,
            assumptions: valid.assumptions,
            createdByKind: actor.kind,
            createdById: actor.id,
          })
          .returning();
        const panel = panelFromRow(row!);

        if (!dashboard || dashboard.spec.panel_ids.includes(panel.id)) {
          return { panel, ...(dashboard ? { dashboard } : {}) };
        }
        // Next free slot: fill rows left to right.
        const count = dashboard.spec.layout.length;
        const perRow = GRID_COLUMNS / PANEL_SIZE.w;
        const updated = await store.addDashboardVersion(
          {
            ...dashboard.spec,
            panel_ids: [...dashboard.spec.panel_ids, panel.id],
            layout: [
              ...dashboard.spec.layout,
              {
                panel_id: panel.id,
                x: (count % perRow) * PANEL_SIZE.w,
                y: Math.floor(count / perRow) * PANEL_SIZE.h,
                ...PANEL_SIZE,
              },
            ],
          },
          actor,
          dashboard,
        );
        return { panel, dashboard: updated };
      });
    },

    addDashboardVersion(
      spec: DashboardSpec,
      actor: Actor,
      existing: { id: string; version: number },
    ): Promise<StoredDashboard> {
      return writeDashboard(spec, actor, existing);
    },
  };
}

export type SpecStore = ReturnType<typeof createSpecStore>;
