import type { Database } from '@app/db';
import { parseManifest, parseManifestYaml, type Manifest } from '@app/specs';
import { SERVICE_LABEL, WELL_KNOWN_METRICS, storedLabelName, storedMetricName } from './names.js';
import { removeUndeclared, upsertEndpoint, upsertMetric } from './store.js';

export interface RegistrationResult {
  service: string;
  metrics: number;
  endpoints: number;
}

/** The labels a declared metric is expected to carry, before the store has been checked. */
export function expectedLabels(metric: Manifest['metrics'][number]): string[] {
  const attributes = metric.attributes ?? WELL_KNOWN_METRICS[metric.name]?.attributes ?? [];
  const labels = [SERVICE_LABEL, ...attributes.map(storedLabelName)];
  if (metric.type === 'histogram') labels.push('le');
  return labels;
}

/**
 * Register a service manifest: fill the catalog with the endpoints and
 * metrics the service declares. Accepts the manifest file's YAML text or the
 * parsed object. Throws `SpecValidationError` when it is not a valid manifest.
 */
export async function registerManifest(
  db: Database,
  workspaceId: string,
  input: unknown,
): Promise<RegistrationResult> {
  const manifest = typeof input === 'string' ? parseManifestYaml(input) : parseManifest(input);

  await db.transaction(async (tx) => {
    for (const metric of manifest.metrics) {
      await upsertMetric(
        tx,
        workspaceId,
        {
          service: manifest.service,
          metricName: metric.name,
          storedName: storedMetricName(metric.name, metric.type, metric.unit),
          type: metric.type,
          unit: metric.unit,
          labels: expectedLabels(metric),
          description: metric.description,
        },
        'declared',
      );
    }
    for (const endpoint of manifest.endpoints) {
      await upsertEndpoint(
        tx,
        workspaceId,
        {
          service: manifest.service,
          method: endpoint.method,
          route: endpoint.route,
          description: endpoint.description ?? '',
        },
        'declared',
      );
    }
    await removeUndeclared(tx, workspaceId, manifest.service, {
      metricNames: manifest.metrics.map((metric) => metric.name),
      endpoints: manifest.endpoints,
    });
  });

  return {
    service: manifest.service,
    metrics: manifest.metrics.length,
    endpoints: manifest.endpoints.length,
  };
}
