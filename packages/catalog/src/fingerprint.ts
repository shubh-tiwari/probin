import { createHash } from 'node:crypto';
import type { Database } from '@app/db';
import { listEndpoints, listMetrics } from './store.js';

/**
 * A fingerprint of what the catalog says about some services: their metrics,
 * types, labels and endpoints. Request rates and p95s are left out; they
 * change all the time and do not change which queries are valid.
 */
export async function catalogFingerprint(
  db: Database,
  workspaceId: string,
  services: string[],
): Promise<string> {
  const wanted = new Set(services);
  const metrics = (await listMetrics(db, workspaceId))
    .filter((m) => wanted.has(m.service))
    .map((m) => [m.service, m.storedName, m.type, m.unit, [...m.labels].sort()]);
  const endpoints = (await listEndpoints(db, workspaceId))
    .filter((e) => wanted.has(e.service))
    .map((e) => [e.service, e.method, e.route]);
  const canonical = JSON.stringify([[...wanted].sort(), metrics, endpoints]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Every series and label name the catalog has for some services. */
export async function catalogNames(
  db: Database,
  workspaceId: string,
  services: string[],
): Promise<{ metrics: string[]; labels: string[] }> {
  const wanted = new Set(services);
  const metrics = (await listMetrics(db, workspaceId)).filter((m) => wanted.has(m.service));
  return {
    metrics: [...new Set(metrics.flatMap((m) => m.series))].sort(),
    labels: [...new Set(metrics.flatMap((m) => m.labels))].sort(),
  };
}
