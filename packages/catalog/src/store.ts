import { schema, type Database } from '@app/db';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { storedSeriesNames, type MetricType } from './names.js';
import type { CatalogEndpoint, CatalogMetric } from './types.js';

const { catalogEndpoints, catalogMetrics } = schema;

/**
 * Catalog rows in Postgres. Every function takes the workspace id and filters
 * on it; there is no way to read or write across workspaces through this file.
 */

const toMetric = (row: typeof catalogMetrics.$inferSelect): CatalogMetric => ({
  service: row.service,
  metricName: row.metricName,
  storedName: row.storedName,
  series: storedSeriesNames(row.storedName, row.type as MetricType),
  type: row.type as MetricType,
  unit: row.unit,
  labels: row.labels as string[],
  description: row.description,
  lastSeen: row.lastSeen,
});

const toEndpoint = (row: typeof catalogEndpoints.$inferSelect): CatalogEndpoint => ({
  service: row.service,
  method: row.method,
  route: row.route,
  description: row.description,
  lastSeen: row.lastSeen,
  requestRate: row.requestRate,
  p95: row.p95,
});

export async function listMetrics(
  db: Database,
  workspaceId: string,
  service?: string,
): Promise<CatalogMetric[]> {
  const rows = await db
    .select()
    .from(catalogMetrics)
    .where(
      and(
        eq(catalogMetrics.workspaceId, workspaceId),
        service ? eq(catalogMetrics.service, service) : undefined,
      ),
    )
    .orderBy(catalogMetrics.service, catalogMetrics.metricName);
  return rows.map(toMetric);
}

export async function listEndpoints(
  db: Database,
  workspaceId: string,
  service?: string,
): Promise<CatalogEndpoint[]> {
  const rows = await db
    .select()
    .from(catalogEndpoints)
    .where(
      and(
        eq(catalogEndpoints.workspaceId, workspaceId),
        service ? eq(catalogEndpoints.service, service) : undefined,
      ),
    )
    .orderBy(catalogEndpoints.service, catalogEndpoints.route, catalogEndpoints.method);
  return rows.map(toEndpoint);
}

export interface MetricUpsert {
  service: string;
  metricName: string;
  storedName: string;
  type: MetricType;
  unit: string;
  labels: string[];
  description: string;
  /** Set when the metric was just seen in the store. */
  seenAt?: Date;
}

/**
 * Insert a metric or update it. `declared` rows come from a manifest and
 * replace the description, type and unit. `seen` rows come from the store and
 * only fill gaps, so a manifest's description is never overwritten by a guess.
 */
export async function upsertMetric(
  db: Database,
  workspaceId: string,
  metric: MetricUpsert,
  origin: 'declared' | 'seen',
): Promise<void> {
  const labels = [...new Set(metric.labels)].sort();
  const mergedLabels = sql`(
    select coalesce(jsonb_agg(distinct label order by label), '[]'::jsonb)
    from jsonb_array_elements_text(${catalogMetrics.labels} || excluded.labels) as label
  )`;
  await db
    .insert(catalogMetrics)
    .values({
      workspaceId,
      service: metric.service,
      metricName: metric.metricName,
      storedName: metric.storedName,
      type: metric.type,
      unit: metric.unit,
      labels,
      description: metric.description,
      lastSeen: metric.seenAt ?? null,
    })
    .onConflictDoUpdate({
      target: [catalogMetrics.workspaceId, catalogMetrics.service, catalogMetrics.metricName],
      set:
        origin === 'declared'
          ? {
              storedName: sql`excluded.stored_name`,
              type: sql`excluded.type`,
              unit: sql`excluded.unit`,
              description: sql`excluded.description`,
              labels: mergedLabels,
            }
          : {
              labels: mergedLabels,
              lastSeen: sql`excluded.last_seen`,
              description: sql`case when ${catalogMetrics.description} = '' then excluded.description else ${catalogMetrics.description} end`,
            },
    });
}

export interface EndpointUpsert {
  service: string;
  method: string;
  route: string;
  description?: string;
  seenAt?: Date;
  requestRate?: number | null;
  p95?: number | null;
}

export async function upsertEndpoint(
  db: Database,
  workspaceId: string,
  endpoint: EndpointUpsert,
  origin: 'declared' | 'seen',
): Promise<void> {
  const hasStats = endpoint.requestRate !== undefined || endpoint.p95 !== undefined;
  await db
    .insert(catalogEndpoints)
    .values({
      workspaceId,
      service: endpoint.service,
      method: endpoint.method,
      route: endpoint.route,
      description: endpoint.description ?? '',
      lastSeen: endpoint.seenAt ?? null,
      requestRate: endpoint.requestRate ?? null,
      p95: endpoint.p95 ?? null,
      statsRefreshedAt: hasStats ? (endpoint.seenAt ?? new Date()) : null,
    })
    .onConflictDoUpdate({
      target: [
        catalogEndpoints.workspaceId,
        catalogEndpoints.service,
        catalogEndpoints.method,
        catalogEndpoints.route,
      ],
      set:
        origin === 'declared'
          ? { description: sql`excluded.description` }
          : {
              lastSeen: sql`excluded.last_seen`,
              requestRate: sql`excluded.request_rate`,
              p95: sql`excluded.p95`,
              statsRefreshedAt: sql`excluded.stats_refreshed_at`,
            },
    });
}

/**
 * After a manifest is registered, drop what it no longer declares, but only
 * rows that were never seen in the store. Anything the store has seen is real
 * and stays until the data ages out.
 */
export async function removeUndeclared(
  db: Database,
  workspaceId: string,
  service: string,
  declared: { metricNames: string[]; endpoints: { method: string; route: string }[] },
): Promise<void> {
  await db
    .delete(catalogMetrics)
    .where(
      and(
        eq(catalogMetrics.workspaceId, workspaceId),
        eq(catalogMetrics.service, service),
        isNull(catalogMetrics.lastSeen),
        declared.metricNames.length > 0
          ? notInArray(catalogMetrics.metricName, declared.metricNames)
          : undefined,
      ),
    );
  const keys = declared.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.route}`);
  await db
    .delete(catalogEndpoints)
    .where(
      and(
        eq(catalogEndpoints.workspaceId, workspaceId),
        eq(catalogEndpoints.service, service),
        isNull(catalogEndpoints.lastSeen),
        keys.length > 0
          ? notInArray(sql`${catalogEndpoints.method} || ' ' || ${catalogEndpoints.route}`, keys)
          : undefined,
      ),
    );
}

/** Every service the catalog knows in a workspace. */
export async function listServices(db: Database, workspaceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ service: catalogMetrics.service })
    .from(catalogMetrics)
    .where(eq(catalogMetrics.workspaceId, workspaceId));
  const more = await db
    .selectDistinct({ service: catalogEndpoints.service })
    .from(catalogEndpoints)
    .where(eq(catalogEndpoints.workspaceId, workspaceId));
  return [...new Set([...rows, ...more].map((row) => row.service))].sort();
}
