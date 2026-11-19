import type { Database } from '@app/db';
import {
  HTTP_SERVER_DURATION,
  INTERNAL_LABELS,
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  describeStoredSeries,
  storedSeriesNames,
  unitFromStoredName,
  type MetricType,
} from './names.js';
import { listMetrics, upsertEndpoint, upsertMetric } from './store.js';
import type { SeriesLabels, StoreReader } from './types.js';

export interface SyncResult {
  services: string[];
  /** Metrics seen in the store on this run. */
  metricsSeen: number;
  /** Metrics found in the store that no manifest declared. */
  metricsDiscovered: string[];
  endpointsSeen: number;
  /** Declared metrics whose predicted stored name is not in the store. Check the name mapping. */
  notInStore: { service: string; metricName: string; storedName: string }[];
}

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const finite = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : null;

/**
 * Bring one workspace's catalog in line with what its metrics store holds.
 *
 *   - marks declared metrics as seen and records the labels they really have;
 *   - adds metrics the store has that no manifest declared (auto-instrumented
 *     services with no manifest are supported this way);
 *   - reads endpoints from the request-duration histogram's route labels and
 *     refreshes each endpoint's request rate and p95;
 *   - reports declared metrics that are missing, which is how a wrong entry
 *     in the name mapping shows up.
 *
 * `store` must already be scoped to the workspace.
 */
export async function syncCatalog(
  db: Database,
  workspaceId: string,
  store: StoreReader,
  now: Date = new Date(),
): Promise<SyncResult> {
  const all = await store.series(`{${SERVICE_LABEL}!=""}`);
  const byService = new Map<string, SeriesLabels[]>();
  for (const labels of all) {
    const service = labels[SERVICE_LABEL];
    if (!service) continue;
    byService.set(service, [...(byService.get(service) ?? []), labels]);
  }

  const declared = await listMetrics(db, workspaceId);
  const result: SyncResult = {
    services: [...byService.keys()].sort(),
    metricsSeen: 0,
    metricsDiscovered: [],
    endpointsSeen: 0,
    notInStore: [],
  };

  for (const [service, seriesList] of byService) {
    // Group the service's series by stored base name.
    const found = new Map<string, { labels: Set<string>; type: MetricType | undefined }>();
    for (const labels of seriesList) {
      const seriesName = labels.__name__;
      if (!seriesName || seriesName === 'target_info') continue;
      const declaredMatch = declared.find(
        (metric) => metric.service === service && metric.series.includes(seriesName),
      );
      const described = describeStoredSeries(seriesName);
      const storedName = declaredMatch?.storedName ?? described.storedName;
      const entry = found.get(storedName) ?? { labels: new Set<string>(), type: undefined };
      entry.type = declaredMatch?.type ?? entry.type ?? described.type;
      for (const label of Object.keys(labels)) {
        if (!INTERNAL_LABELS.has(label)) entry.labels.add(label);
      }
      found.set(storedName, entry);
    }

    for (const [storedName, entry] of found) {
      const known = declared.find((m) => m.service === service && m.storedName === storedName);
      // `_sum` and `_count` with no `_bucket` and no declaration: not enough to call it a histogram.
      const type: MetricType = known?.type ?? entry.type ?? 'gauge';
      await upsertMetric(
        db,
        workspaceId,
        {
          service,
          metricName: known?.metricName ?? storedName,
          storedName,
          type,
          unit: known?.unit ?? unitFromStoredName(storedName),
          labels: [...entry.labels],
          description: known?.description ?? '',
          seenAt: now,
        },
        'seen',
      );
      result.metricsSeen += 1;
      if (!known) result.metricsDiscovered.push(`${service}: ${storedName}`);
    }

    for (const metric of declared.filter((m) => m.service === service)) {
      if (!found.has(metric.storedName)) {
        result.notInStore.push({
          service,
          metricName: metric.metricName,
          storedName: metric.storedName,
        });
      }
    }

    result.endpointsSeen += await syncEndpoints(db, workspaceId, store, service, seriesList, now);
  }

  return result;
}

async function syncEndpoints(
  db: Database,
  workspaceId: string,
  store: StoreReader,
  service: string,
  seriesList: SeriesLabels[],
  now: Date,
): Promise<number> {
  const [, , countSeries] = storedSeriesNames(HTTP_SERVER_DURATION, 'histogram');
  const endpoints = new Map<string, { method: string; route: string }>();
  for (const labels of seriesList) {
    if (labels.__name__ !== countSeries) continue;
    const method = labels[METHOD_LABEL];
    const route = labels[ROUTE_LABEL];
    if (method && route) endpoints.set(`${method} ${route}`, { method, route });
  }
  if (endpoints.size === 0) return 0;

  const selector = `{${SERVICE_LABEL}=${quote(service)}}`;
  const by = `${METHOD_LABEL}, ${ROUTE_LABEL}`;
  const [rates, p95s] = await Promise.all([
    store.instant(`sum by (${by}) (rate(${HTTP_SERVER_DURATION}_count${selector}[5m]))`),
    store.instant(
      `histogram_quantile(0.95, sum by (le, ${by}) (rate(${HTTP_SERVER_DURATION}_bucket${selector}[5m])))`,
    ),
  ]);
  const lookup = (rows: { labels: SeriesLabels; value: number }[], key: string) =>
    rows.find((row) => `${row.labels[METHOD_LABEL]} ${row.labels[ROUTE_LABEL]}` === key)?.value;

  for (const [key, endpoint] of endpoints) {
    await upsertEndpoint(
      db,
      workspaceId,
      {
        service,
        ...endpoint,
        seenAt: now,
        requestRate: finite(lookup(rates, key)),
        p95: finite(lookup(p95s, key)),
      },
      'seen',
    );
  }
  return endpoints.size;
}
