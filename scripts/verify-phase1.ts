/**
 * Phase 1 acceptance check, run by `make verify` against the local stack.
 *
 * "Accepted when: 90% of test-set requests pass the dry run on the first
 * attempt; no generated query uses a name outside the catalog; a query from
 * workspace A cannot return workspace B's data."
 *
 * This script proves the third point end to end, and the plumbing the other
 * two rest on: keyed ingestion, the catalog, the agent loop. The first two
 * are measured by the query test set (`pnpm evals:query`).
 *
 * It creates two throwaway workspaces and deletes them at the end.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createAgentClient } from '@app/agent-client';
import { listEndpoints, listMetrics } from '@app/catalog';
import { loadEnv } from '@app/config';
import { extractNames } from '@app/promql';
import { connect, createWorkspace, schema } from '@app/db';
import { generateIngestionKey, hashIngestionKey } from '@app/ingest';
import { QueryApiError, createQueryApiClient } from '@app/query-api/client';
import { eq, inArray } from 'drizzle-orm';
import {
  assert,
  createCheckRun,
  eventually,
  otlpGauge,
  sendOtlp,
  storeQuery,
} from './lib/checks.js';
import { checkConformance, demoManifests } from './lib/conformance.js';

/** The agent's grounding rule: every metric and label name came from the catalog search. */
function grounded(query: string, allowed: { metrics: string[]; labels: string[] }): boolean {
  const names = extractNames(query);
  return (
    names.metrics.every((name) => allowed.metrics.includes(name)) &&
    names.labels.every((name) => allowed.labels.includes(name)) &&
    names.unnamedSelectors.length === 0
  );
}

const env = loadEnv([
  'DATABASE_URL',
  'METRICS_STORE_URL',
  'INGEST_URL',
  'QUERY_API_URL',
  'AGENT_URL',
  'INTERNAL_API_TOKEN',
  'DEV_WORKSPACE_ID',
]);
const exec = promisify(execFile);
const { step, finish } = createCheckRun();
const { db, close } = connect(env.DATABASE_URL);

const queryAs = (workspaceId: string) =>
  createQueryApiClient({
    url: env.QUERY_API_URL,
    internalToken: env.INTERNAL_API_TOKEN,
    workspaceId,
  });

/** A marker unique to this run, so earlier runs cannot satisfy or confuse a check. */
const run = randomUUID().slice(0, 8);
const METRIC = `verify_isolation_${run}`;
const keyA = generateIngestionKey();
const keyB = generateIngestionKey();
const a = await createWorkspace(db, {
  name: `verify-a-${run}`,
  plan: 'example',
  ingestionKeyHash: hashIngestionKey(keyA),
});
const b = await createWorkspace(db, {
  name: `verify-b-${run}`,
  plan: 'example',
  ingestionKeyHash: hashIngestionKey(keyB),
});

console.log('\nPhase 1 check\n');

// Start without cached answers: these checks walk through the questions, which a cached request skips.
await db
  .delete(schema.resolvedRequests)
  .where(eq(schema.resolvedRequests.workspaceId, env.DEV_WORKSPACE_ID));

try {
  await step('the ingestion endpoint refuses senders without a valid key', async () => {
    const body = otlpGauge({ service: 'verify-nokey', metric: `verify.nokey.${run}`, value: 1 });
    const none = await sendOtlp(env.INGEST_URL, undefined, body);
    const unknown = await sendOtlp(env.INGEST_URL, generateIngestionKey(), body);
    assert(none === 401 && unknown === 401, `expected 401 and 401, got ${none} and ${unknown}`);
    return 'no key: 401, unknown key: 401';
  });

  await step('each key writes only into its own workspace', async () => {
    const sample = (service: string, value: number, claim?: string) =>
      otlpGauge({
        service,
        metric: METRIC.replaceAll('_', '.'),
        value,
        ...(claim ? { resourceAttributes: { workspace: claim } } : {}),
      });
    // A sends honestly. B sends honestly. A also sends a sample claiming to be B's.
    assert(
      (await sendOtlp(env.INGEST_URL, keyA, sample('verify-a', 1))) === 200,
      'A could not send',
    );
    assert(
      (await sendOtlp(env.INGEST_URL, keyB, sample('verify-b', 2))) === 200,
      'B could not send',
    );
    assert(
      (await sendOtlp(env.INGEST_URL, keyA, sample('verify-a-spoof', 3, b.id))) === 200,
      'spoof not accepted',
    );

    const stored = await eventually(async () => {
      const rows = await storeQuery(env.METRICS_STORE_URL, METRIC);
      assert(rows.length === 3, `${rows.length} of 3 samples are in the store`);
      return rows;
    });
    const owner = (service: string) =>
      stored.find((row) => row.metric.service_name === service)?.metric.workspace;
    assert(owner('verify-a') === a.id, 'A’s sample is not under A');
    assert(owner('verify-b') === b.id, 'B’s sample is not under B');
    assert(
      owner('verify-a-spoof') === a.id,
      'a sample claiming another workspace was stored under it',
    );
    return 'a sample that claimed workspace B was stored under A, the key’s workspace';
  });

  await step('a query from workspace A cannot return workspace B’s data', async () => {
    const asA = await queryAs(a.id).instant(METRIC);
    const asB = await queryAs(b.id).instant(METRIC);
    const services = (rows: typeof asA) => rows.map((row) => row.labels.service_name).sort();
    assert(services(asA).join() === 'verify-a,verify-a-spoof', `A sees ${services(asA).join()}`);
    assert(services(asB).join() === 'verify-b', `B sees ${services(asB).join()}`);
    assert(
      asA.every((row) => row.labels.workspace === undefined),
      'the workspace label leaked to the caller',
    );
    return 'A sees only A’s two samples; B sees only B’s one';
  });

  await step(
    'queries that try to reach another workspace are refused or return nothing of it',
    async () => {
      const hostile = [
        `${METRIC}{workspace="${b.id}"}`,
        `${METRIC}{workspace=~".+"}`,
        `${METRIC} or ${METRIC}{workspace="${b.id}"}`,
        `count by (workspace) ({__name__=~".+"})`,
        `sum without (workspace) (${METRIC})`,
        `label_replace(${METRIC}, "workspace", "${b.id}", "service_name", ".*")`,
        `${METRIC} * on(service_name) group_left(workspace) ${METRIC}`,
        `info(${METRIC})`,
        `${METRIC}{`,
      ];
      let refused = 0;
      for (const query of hostile) {
        try {
          await queryAs(a.id).instant(query);
          throw new Error(`was not refused: ${query}`);
        } catch (error) {
          assert(error instanceof QueryApiError, (error as Error).message);
          assert(
            ['forbidden', 'invalid_query'].includes(error.body.code),
            `${query}: ${error.body.code}`,
          );
          refused += 1;
        }
      }
      // Broad but legitimate queries run, and still see only A.
      const broad = [
        `{__name__=~".+"}`,
        `{service_name=~"verify-.*"}`,
        `group by (service_name) ({__name__="${METRIC}"})`,
      ];
      for (const query of broad) {
        const rows = await queryAs(a.id).instant(query);
        const leaked = rows.filter((row) => row.labels.service_name === 'verify-b');
        assert(leaked.length === 0, `${query} returned workspace B’s data`);
        assert(rows.length > 0, `${query} returned nothing at all`);
      }
      assert(
        (await queryAs(randomUUID()).instant(METRIC)).length === 0,
        'an unknown workspace sees data',
      );
      return `${refused} hostile queries refused; ${broad.length} broad queries saw only A`;
    },
  );

  await step('the collector drops data that arrives without a workspace', async () => {
    // From inside the compose network, straight at the collector, with no workspace header.
    const body = otlpGauge({
      service: 'verify-unlabelled',
      metric: `verify.unlabelled.${run}`,
      value: 1,
      resourceAttributes: { workspace: a.id },
    });
    const script = `fetch('http://otel-collector:4318/v1/metrics',{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1]}).then(r=>console.log(r.status))`;
    await exec('docker', [
      'compose', '--env-file', '.env', '-f', 'infra/compose.yaml',
      'exec', '-T', 'demo-checkout', 'node', '-e', script, body,
    ]); // prettier-ignore
    // Give it the time a real sample needs to show up, then make sure it did not.
    await new Promise((resolve) => setTimeout(resolve, 40_000));
    const rows = await storeQuery(env.METRICS_STORE_URL, `verify_unlabelled_${run}`);
    assert(rows.length === 0, 'data with no workspace header reached the store');
    return 'sent straight to the collector with no workspace header: not stored';
  });

  await step('the catalog is filled from manifests and from the store', async () => {
    const dev = env.DEV_WORKSPACE_ID;
    const manifests = demoManifests();
    const result = await eventually(async () => {
      const metrics = await listMetrics(db, dev);
      const endpoints = await listEndpoints(db, dev);
      for (const { manifest } of manifests) {
        for (const declared of manifest.metrics) {
          const row = metrics.find(
            (m) => m.service === manifest.service && m.metricName === declared.name,
          );
          assert(row, `${manifest.service}: ${declared.name} is not in the catalog`);
          assert(
            row.lastSeen !== null,
            `${manifest.service}: ${declared.name} (${row.storedName}) not seen in the store yet`,
          );
        }
        for (const declared of manifest.endpoints) {
          const row = endpoints.find(
            (e) =>
              e.service === manifest.service &&
              e.method === declared.method &&
              e.route === declared.route,
          );
          assert(
            row?.p95 != null,
            `${manifest.service}: ${declared.method} ${declared.route} has no stats yet`,
          );
        }
      }
      return { metrics: metrics.length, endpoints: endpoints.length };
    });
    assert(
      (await listMetrics(db, a.id)).every((m) => m.service.startsWith('verify-')),
      'workspace A sees another workspace’s catalog',
    );
    return `${manifests.length} services, ${result.metrics} metrics, ${result.endpoints} endpoints with live stats; every stored name matched the mapping`;
  });

  await step('the demo services follow the convention', async () => {
    const reports = await eventually(async () => {
      const all = [];
      for (const { manifest } of demoManifests()) {
        const report = await checkConformance(
          manifest,
          queryAs(env.DEV_WORKSPACE_ID),
          env.INGEST_URL,
        );
        assert(report.seriesSeen > 0, `${manifest.service} has sent no metrics`);
        assert(
          report.findings.length === 0,
          `${manifest.service}: ${report.findings.map((f) => f.message).join(' | ')}`,
        );
        all.push(report);
      }
      return all;
    });
    return reports.map((report) => report.manifest.service).join(', ');
  });

  const agent = createAgentClient({
    url: env.AGENT_URL,
    internalToken: env.INTERNAL_API_TOKEN,
    workspaceId: env.DEV_WORKSPACE_ID,
    userId: 'verify',
  });

  await step('the agent turns the example request into a tested draft panel', async () => {
    // Retried, because a stack that has only just started may have no data for the endpoint yet.
    const reply = await eventually(async () => {
      let turn = await agent.ask('latency graph of checkout service in last 5 hr');
      assert(turn.output.kind === 'question', `expected a question, got ${turn.output.kind}`);
      assert(
        turn.output.question.id === 'endpoint',
        'the first question is not the endpoint picker',
      );
      assert(
        turn.output.question.options.at(-1)?.value === 'all',
        '“All endpoints combined” is not last',
      );
      turn = await agent.answer(turn.requestId, 'POST /checkout/pay');
      if (turn.output.kind === 'question') turn = await agent.answer(turn.requestId, '95');
      const { output } = turn;
      assert(
        output.kind === 'draft',
        `expected a draft, got ${output.kind}${'message' in output ? `: ${output.message}` : ''}`,
      );
      return { ...turn, output };
    });
    assert(reply.trace.questionsAsked.length <= 2, 'more than two questions');
    const { panel } = reply.output;
    assert(grounded(panel.query, reply.trace.allowed), 'the draft uses a name outside the catalog');
    assert(panel.range === '5h' && panel.request.includes('checkout'), 'range or request not kept');
    const calls = await db
      .select({ task: schema.modelCalls.taskType })
      .from(schema.modelCalls)
      .where(eq(schema.modelCalls.requestId, reply.requestId));
    assert(calls.length >= 2, 'the model calls for this request were not logged');
    return `${reply.trace.questionsAsked.length} questions, ${reply.trace.attempts.length} attempt(s), ${calls.length} model calls logged`;
  });

  await step('the agent says so when nothing matches, and writes no query', async () => {
    const reply = await agent.ask('kafka consumer lag of checkout service');
    assert(reply.output.kind === 'no_match', `expected no_match, got ${reply.output.kind}`);
    assert(reply.trace.attempts.length === 0, 'it tried to write a query anyway');
    return reply.output.message;
  });

  await step('a request is only visible to the workspace that made it', async () => {
    const reply = await agent.ask('latency graph of checkout service in last 5 hr');
    const other = createAgentClient({
      url: env.AGENT_URL,
      internalToken: env.INTERNAL_API_TOKEN,
      workspaceId: a.id,
      userId: 'verify',
    });
    const status = await other.answer(reply.requestId, 'all').then(
      () => 200,
      (error: { status?: number }) => error.status,
    );
    assert(status === 404, `another workspace got HTTP ${status} for the request`);
    return 'another workspace gets 404';
  });
} finally {
  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [a.id, b.id]));
  await close();
}

process.exit(
  finish('Phase 1 (built; the 90% gate is measured by the query test set with a model key)'),
);
