import {
  HTTP_SERVER_DURATION,
  ROUTE_LABEL,
  SERVICE_LABEL,
  STATUS_LABEL,
  listMetrics,
} from '@app/catalog';
import { createAlertStore, createSpecStore, getWorkspace, schema, type Database } from '@app/db';
import type { QueryApiClient } from '@app/query-api/client';
import type { PanelSpec } from '@app/specs';
import { and, eq } from 'drizzle-orm';

const STARTER: { kind: 'system'; id: string } = { kind: 'system', id: 'starter' };
const q = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * K5: the first time a service's request data arrives, make a starter
 * dashboard for it and suggest two alerts. Every panel's query passes a dry
 * run first. The alerts are pending: nothing is watched until a person
 * approves them.
 */
export async function makeStarterContent(db: Database, workspaceId: string, service: string, query: QueryApiClient): Promise<boolean> {
  const [done] = await db
    .select()
    .from(schema.starterDashboards)
    .where(and(eq(schema.starterDashboards.workspaceId, workspaceId), eq(schema.starterDashboards.service, service)))
    .limit(1);
  if (done) return false;
  const metrics = await listMetrics(db, workspaceId, service);
  if (!metrics.some((m) => m.storedName === HTTP_SERVER_DURATION && m.lastSeen)) return false;

  const s = `${SERVICE_LABEL}=${q(service)}`;
  const request = 'starter dashboard, made when the service first sent data';
  const errorQuery = `(sum(rate(${HTTP_SERVER_DURATION}_count{${s}, ${STATUS_LABEL}=~"5.."}[5m])) or vector(0)) / sum(rate(${HTTP_SERVER_DURATION}_count{${s}}[5m]))`;
  const latencyQuery = `histogram_quantile(0.95, sum by (le) (rate(${HTTP_SERVER_DURATION}_bucket{${s}}[5m])))`;
  const candidates: PanelSpec[] = [
    { title: `${service} · p95 latency by endpoint`, type: 'timeseries', query: `histogram_quantile(0.95, sum by (le, ${ROUTE_LABEL}) (rate(${HTTP_SERVER_DURATION}_bucket{${s}}[5m])))`, unit: 's', display_unit: 'ms', thresholds: [], request, assumptions: ['p95', 'all requests including failures'] },
    { title: `${service} · requests per second by endpoint`, type: 'timeseries', query: `sum by (${ROUTE_LABEL}) (rate(${HTTP_SERVER_DURATION}_count{${s}}[5m]))`, unit: 'req/s', thresholds: [], request, assumptions: ['all requests including failures'] },
    { title: `${service} · error rate`, type: 'timeseries', query: errorQuery, unit: '1', display_unit: '%', thresholds: [], request, assumptions: ['errors are responses with status 5xx', 'all endpoints combined'] },
  ]; // prettier-ignore

  const passed: PanelSpec[] = [];
  for (const panel of candidates) {
    const dry = await query.dryRun({ query: panel.query, range: '1h' }).catch(() => undefined);
    if (dry?.ok && dry.lineCount > 0) passed.push(panel);
  }
  if (passed.length === 0) return false;

  const specs = createSpecStore(db, workspaceId);
  const dashboard = await specs.createDashboard({ title: service, panel_ids: [], layout: [], default_range: '6h' }, STARTER);
  for (const panel of passed) await specs.savePanel(panel, STARTER, { dashboardId: dashboard.id });

  const workspace = await getWorkspace(db, workspaceId);
  const configured = (workspace?.settings as { alertChannel?: unknown } | undefined)?.alertChannel;
  const channel = typeof configured === 'string' && /^#\S+$/.test(configured) ? configured : '#alerts';
  const rules = createAlertStore(db, workspaceId);
  const suggestion = ['suggested when the service first sent data; adjust before approving'];
  await rules.draft(
    { name: `${service} · error rate above 5%`, expr: `(${errorQuery}) > 0.05`, for: '10m', severity: 'warning', channel, status: 'pending', query: errorQuery, comparison: { op: '>', threshold: 0.05 }, unit: '1', display_unit: '%', service, request, assumptions: suggestion },
    STARTER,
  );
  await rules.draft(
    { name: `${service} · p95 latency above 1000 ms`, expr: `(${latencyQuery}) > 1`, for: '10m', severity: 'warning', channel, status: 'pending', query: latencyQuery, comparison: { op: '>', threshold: 1 }, unit: 's', display_unit: 'ms', service, request, assumptions: suggestion },
    STARTER,
  );
  await db.insert(schema.starterDashboards).values({ workspaceId, service, dashboardId: dashboard.id }).onConflictDoNothing();
  return true;
} // prettier-ignore
