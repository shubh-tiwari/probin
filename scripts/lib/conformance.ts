import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_LABEL, checkEmitted, checkManifest, type ConventionFinding } from '@app/catalog';
import { MANIFEST_FILENAME } from '@app/config';
import type { QueryApiClient } from '@app/query-api/client';
import { parseManifestYaml, type Manifest } from '@app/specs';

export const DEMO_ROOT = fileURLToPath(new URL('../../infra/demo', import.meta.url));

/** The manifests of the instrumented demo services. */
export function demoManifests(): { path: string; manifest: Manifest }[] {
  const found: { path: string; manifest: Manifest }[] = [];
  for (const entry of readdirSync(DEMO_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(DEMO_ROOT, entry.name, MANIFEST_FILENAME);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    found.push({ path, manifest: parseManifestYaml(text) });
  }
  return found;
}

export interface ConformanceReport {
  manifest: Manifest;
  seriesSeen: number;
  findings: ConventionFinding[];
}

/** Check one service: its manifest, and what it has recently sent. */
export async function checkConformance(
  manifest: Manifest,
  queryApi: QueryApiClient,
  ingestUrl: string,
): Promise<ConformanceReport> {
  const series = await queryApi.series(`{${SERVICE_LABEL}="${manifest.service}"}`);
  return {
    manifest,
    seriesSeen: series.length,
    findings: [
      ...checkManifest(manifest),
      ...checkEmitted(manifest, series, {
        // The ingestion endpoint as services reach it: its public host, and its name inside compose.
        ingestHosts: [new URL(ingestUrl).hostname, 'ingest'],
      }),
    ],
  };
}
