/**
 * Checks a running service against the metric convention.
 *
 *   pnpm conformance                       every demo service
 *   pnpm conformance <service>             one demo service
 *   pnpm conformance --manifest <path>     any service, by its manifest
 *
 * It reads the service's manifest and the series the service has recently
 * sent (through the Query API, for the dev workspace), and reports every
 * break of the convention. Exit code 1 if there is any.
 *
 * This is how the skill is tested: a service the skill instrumented must pass.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from '@app/config';
import { createQueryApiClient } from '@app/query-api/client';
import { parseManifestYaml } from '@app/specs';
import { checkConformance, demoManifests } from './lib/conformance.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { manifest: { type: 'string' } },
});

const env = loadEnv(['QUERY_API_URL', 'INTERNAL_API_TOKEN', 'DEV_WORKSPACE_ID', 'INGEST_URL']);
const queryApi = createQueryApiClient({
  url: env.QUERY_API_URL,
  internalToken: env.INTERNAL_API_TOKEN,
  workspaceId: env.DEV_WORKSPACE_ID,
});

const targets = values.manifest
  ? [{ path: values.manifest, manifest: parseManifestYaml(readFileSync(values.manifest, 'utf8')) }]
  : demoManifests().filter((one) => !positionals[0] || one.manifest.service === positionals[0]);
if (targets.length === 0) {
  console.error(
    `No manifest found${positionals[0] ? ` for "${positionals[0]}"` : ''}. Pass --manifest <path>.`,
  );
  process.exit(2);
}

let failed = false;
for (const { path, manifest } of targets) {
  const report = await checkConformance(manifest, queryApi, env.INGEST_URL);
  console.log(`${manifest.service}: ${path}`);
  console.log(
    `  ${manifest.endpoints.length} endpoints and ${manifest.metrics.length} metrics declared; ` +
      `${report.seriesSeen} series seen in the last 15 minutes`,
  );
  if (report.seriesSeen === 0) {
    console.log('  FAIL  the service has sent no metrics. Is it running and connected?');
    failed = true;
    continue;
  }
  for (const finding of report.findings)
    console.log(`  FAIL  [${finding.rule}] ${finding.message}`);
  if (report.findings.length === 0) console.log('  ok    follows the convention');
  else failed = true;
}
process.exit(failed ? 1 : 0);
