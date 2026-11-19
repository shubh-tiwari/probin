import {
  catalogFingerprint,
  catalogNames,
  listMetrics,
  searchCatalog,
  type CatalogMetric,
  type CatalogSearch,
  type CatalogSearchResult,
} from '@app/catalog';
import { findPlan, type PlansConfig } from '@app/config';
import {
  createAlertStore,
  createCollectorStore,
  createSpecStore,
  getWorkspace,
  schema,
  type Actor,
  type Database,
} from '@app/db';
import { runHttpCheck, type CheckResult } from '@app/ingest';
import { createMemory, readUserDefaults, saveUserDefaults, type UserDefaults } from '@app/memory';
import type { AlertRuleSpec, CollectorSpec, PanelSpec } from '@app/specs';
import { eq } from 'drizzle-orm';

/** What the agent needs to know about a workspace to decide whether, and how much, it may build. */
export interface WorkspaceInfo {
  billingStatus: string;
  trialEndsAt: string | null;
  /** The Slack channel alerts go to when a request did not come from Slack, if one is set. */
  alertChannel: string | null;
  /** The month's model budget in dollars: the workspace's override, else its plan's. Null: no cap. */
  modelBudget: number | null;
}

export interface SavedPanel {
  panelId: string;
  version: number;
  dashboardId: string;
}

/**
 * Everything the agent reaches through the platform service, for one
 * workspace. Each method wraps a function the TypeScript services already
 * use, so the rules (catalog ranking, spec versions, memory, unsafe URLs) have
 * one implementation in one language.
 */
export interface PlatformBackend {
  workspace(): Promise<WorkspaceInfo | undefined>;
  searchCatalog(search: CatalogSearch): Promise<CatalogSearchResult>;
  /** The catalog fingerprint of some services, and every name it has for them. */
  resolved(
    services: string[],
  ): Promise<{ fingerprint: string; names: { metrics: string[]; labels: string[] } }>;
  listMetrics(service?: string): Promise<CatalogMetric[]>;
  /** Save a panel; with `panelId`, as a new version of it. Creates the first dashboard if needed. */
  savePanel(
    spec: PanelSpec,
    actor: Actor,
    target: { dashboardId?: string; panelId?: string },
  ): Promise<SavedPanel>;
  loadPanel(panelId: string): Promise<{ spec: PanelSpec; dashboardId?: string } | undefined>;
  draftAlert(spec: AlertRuleSpec, actor: Actor): Promise<{ ruleId: string }>;
  /** The current version of an alert rule, and when it last changed state. */
  alert(
    ruleId: string,
  ): Promise<{ id: string; spec: AlertRuleSpec; since: string | null } | undefined>;
  /** One test fetch of the collector's URL, then a pending collector. Unsafe URLs throw. */
  draftCollector(
    spec: CollectorSpec,
    actor: Actor,
  ): Promise<{ collectorId: string; test: CheckResult }>;
  readDefaults(userId: string): Promise<UserDefaults>;
  saveDefaults(userId: string, defaults: UserDefaults, source: string): Promise<number>;
  writeIncident(entry: {
    subject: string;
    text: string;
    source: string;
    value: unknown;
  }): Promise<void>;
}

export function createPlatformBackend(options: {
  db: Database;
  workspaceId: string;
  plans: PlansConfig;
  /** The range a dashboard created here starts with. */
  defaultRange: string;
  /** Let collectors reach private addresses. Local development only. */
  allowPrivateCollectors: boolean;
}): PlatformBackend {
  const { db, workspaceId } = options;
  const specs = createSpecStore(db, workspaceId);
  const holderOf = async (panelId: string) =>
    (await specs.listDashboards()).find((d) => d.spec.panel_ids.includes(panelId));

  return {
    async workspace() {
      const workspace = await getWorkspace(db, workspaceId);
      if (!workspace) return undefined;
      const channel = (workspace.settings as { alertChannel?: unknown } | null)?.alertChannel;
      return {
        billingStatus: workspace.billingStatus,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
        alertChannel: typeof channel === 'string' && /^#\S+$/.test(channel) ? channel : null,
        modelBudget:
          workspace.monthlyModelBudget !== null
            ? Number(workspace.monthlyModelBudget)
            : (findPlan(options.plans, workspace.plan)?.limits.model_budget_monthly ?? null),
      };
    },

    searchCatalog: (search) => searchCatalog(db, workspaceId, search),

    async resolved(services) {
      const [fingerprint, names] = await Promise.all([
        catalogFingerprint(db, workspaceId, services),
        catalogNames(db, workspaceId, services),
      ]);
      return { fingerprint, names };
    },

    listMetrics: (service) => listMetrics(db, workspaceId, service),

    async savePanel(spec, actor, target) {
      if (target.panelId) {
        // A change to an existing panel: a new version of it, on whichever dashboard holds it.
        const { panel } = await specs.savePanel(spec, actor, { panelId: target.panelId });
        const holder = await holderOf(target.panelId);
        return {
          panelId: panel.id,
          version: panel.version,
          dashboardId: holder?.id ?? target.dashboardId ?? '',
        };
      }
      // With no dashboard named, use the workspace's first one, creating it if there is none.
      let dashboardId = target.dashboardId;
      if (!dashboardId) {
        const existing = await specs.listDashboards();
        dashboardId =
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
      const { panel } = await specs.savePanel(spec, actor, { dashboardId });
      return { panelId: panel.id, version: panel.version, dashboardId };
    },

    async loadPanel(panelId) {
      const panel = await specs.latestPanel(panelId).catch(() => undefined);
      if (!panel) return undefined;
      const holder = await holderOf(panelId);
      return { spec: panel.spec, ...(holder ? { dashboardId: holder.id } : {}) };
    },

    async draftAlert(spec, actor) {
      const rule = await createAlertStore(db, workspaceId).draft(spec, actor);
      return { ruleId: rule.id };
    },

    async alert(ruleId) {
      const rule = await createAlertStore(db, workspaceId).current(ruleId);
      if (!rule) return undefined;
      const [state] = await db
        .select()
        .from(schema.alertStates)
        .where(eq(schema.alertStates.ruleId, rule.id))
        .limit(1);
      return { id: rule.id, spec: rule.spec, since: state?.since?.toISOString() ?? null };
    },

    async draftCollector(spec, actor) {
      // One test fetch before anything is written. It also refuses unsafe URLs.
      const test = await runHttpCheck(String(spec.config.url), {
        allowPrivate: options.allowPrivateCollectors,
      });
      const collector = await createCollectorStore(db, workspaceId).draft(spec, actor);
      return { collectorId: collector.id, test };
    },

    readDefaults: (userId) => readUserDefaults(createMemory(db, workspaceId), userId),
    saveDefaults: (userId, defaults, source) =>
      saveUserDefaults(createMemory(db, workspaceId), userId, defaults, source),

    async writeIncident(entry) {
      await createMemory(db, workspaceId).write(
        { kind: 'incident', ...entry },
        { kind: 'agent', id: 'agent' },
      );
    },
  };
}
