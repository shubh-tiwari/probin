/**
 * Phase 0 acceptance check, run by `make verify` against the local stack.
 *
 * "Accepted when: one command brings up the whole stack locally, and the demo
 * service's metrics are visible in the metrics store."
 *
 * It only reads: the collector's health endpoint, the metrics store's
 * Prometheus-compatible API, and Postgres. (That a sender cannot choose its
 * own workspace is checked in phase 1, with two workspaces.) It also prints the stored metric and
 * label names it finds, because confirming those is an open item for phase 1.
 */
import { loadEnv } from '@app/config';
import { tables } from '@app/db';
import { getTableName } from 'drizzle-orm';
import pg from 'pg';
import {
  assert,
  createCheckRun,
  eventually,
  labelValues,
  storeQuery,
  type Labels,
} from './lib/checks.js';
import { demoManifests } from './lib/conformance.js';

const env = loadEnv([
  'DATABASE_URL',
  'METRICS_STORE_URL',
  'METRICS_STORE_TYPE',
  'DEV_WORKSPACE_ID',
]);
const workspace = env.DEV_WORKSPACE_ID;
const collectorHealthUrl = `http://localhost:${process.env.COLLECTOR_HEALTH_PORT ?? '13133'}`;

const SERVICE = 'checkout';
// The routes the demo service declares in its manifest.
const EXPECTED_ROUTES =
  demoManifests()
    .find((one) => one.manifest.service === SERVICE)
    ?.manifest.endpoints.map((endpoint) => endpoint.route) ?? [];

type Series = Labels;
const instantQuery = (query: string) => storeQuery(env.METRICS_STORE_URL, query);
const { step, finish } = createCheckRun();

const labelNames = (series: Series[]) =>
  [...new Set(series.flatMap((one) => Object.keys(one)))].filter((n) => n !== '__name__').sort();

console.log(`\nPhase 0 check (${env.METRICS_STORE_TYPE} at ${env.METRICS_STORE_URL})\n`);

await step('collector is healthy', async () => {
  const response = await eventually(async () => {
    const res = await fetch(collectorHealthUrl);
    assert(res.ok, `collector health endpoint returned HTTP ${res.status}`);
    return res;
  });
  return `HTTP ${response.status}`;
});

const selector = `{service_name="${SERVICE}"}`;
let durationSeries: Series[] = [];

await step('demo service request durations are in the store', async () => {
  const rows = await eventually(async () => {
    const found = await instantQuery(`http_server_request_duration_seconds_count${selector}`);
    assert(found.length > 0, 'no http_server_request_duration_seconds_count series yet');
    const routes = labelValues(
      found.map((row) => row.metric),
      'http_route',
    );
    for (const route of EXPECTED_ROUTES) {
      assert(routes.includes(route), `no series yet for route ${route}`);
    }
    return found;
  });
  durationSeries = rows.map((row) => row.metric);
  return `${rows.length} series`;
});

await step('every series carries the workspace label set at ingestion', async () => {
  const all = await instantQuery(`{service_name="${SERVICE}"}`);
  assert(all.length > 0, 'no series for the demo service');
  const wrong = all.filter((row) => row.metric.workspace !== workspace);
  assert(wrong.length === 0, `${wrong.length} series lack workspace="${workspace}"`);
  return `${all.length} series`;
});

await step('http_route is the route template, never a full URL', async () => {
  const routes = labelValues(durationSeries, 'http_route');
  const unexpected = routes.filter((route) => !EXPECTED_ROUTES.includes(route));
  assert(routes.length > 0, 'no http_route label');
  assert(unexpected.length === 0, `unexpected routes: ${unexpected.join(', ')}`);
  return routes.join(', ');
});

await step('the histogram has buckets, so percentiles can be computed', async () => {
  const p95 = await eventually(async () => {
    const rows = await instantQuery(
      `histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="${SERVICE}", http_route="/checkout/pay", http_request_method="POST"}[5m])))`,
    );
    const value = rows[0]?.value;
    assert(value !== undefined && Number.isFinite(value), 'p95 query returned no number yet');
    return value;
  });
  return `POST /checkout/pay p95 = ${(p95 * 1000).toFixed(0)} ms (the build plan's example query)`;
});

await step('the business counter is in the store', async () => {
  const rows = await eventually(async () => {
    const found = await instantQuery(`orders_completed_total${selector}`);
    assert(found.length > 0, 'no orders_completed_total series yet');
    return found;
  });
  const methods = labelValues(
    rows.map((row) => row.metric),
    'payment_method',
  );
  assert(methods.length > 0, 'orders_completed_total has no payment_method label');
  return `payment_method: ${methods.join(', ')}`;
});

await step('every table in the data model exists', async () => {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const present = new Set(result.rows.map((row) => row.table_name));
    const expected = Object.values(tables).map(getTableName);
    const missing = expected.filter((name) => !present.has(name));
    assert(missing.length === 0, `missing tables: ${missing.join(', ')} (run "make migrate")`);
    return `${expected.length} tables`;
  } finally {
    await client.end();
  }
});

// Facts for phase 1's open item "exact stored metric and label names".
try {
  const all = await instantQuery(selector);
  const names = labelValues(
    all.map((row) => row.metric),
    '__name__',
  );
  console.log('\nStored names for the demo service (for the phase 1 name mapping):');
  for (const name of names) {
    const series = all.filter((row) => row.metric.__name__ === name).map((row) => row.metric);
    console.log(`  ${name}`);
    console.log(`      labels: ${labelNames(series).join(', ')}`);
  }
} catch (error) {
  console.log(`\nCould not list stored names: ${error instanceof Error ? error.message : error}`);
}

process.exit(finish('Phase 0'));
