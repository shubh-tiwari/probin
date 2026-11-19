/**
 * Phase 4 acceptance check, against the local stack with its fake Slack and fake Stripe.
 *
 * "Accepted when: a pending rule never notifies; an approved rule fires on the
 * demo service within its duration; cancelling a workspace deletes its
 * metrics, specs, memory and caches; a trial workspace can subscribe and be
 * billed in the provider's test mode."
 *
 * It also checks the rest of phase 4: collectors, starter dashboards, refining
 * in a thread and by prompt, sharing, Grafana export, the read-only APIs and
 * the connector, a customer's own store, and the trial limit.
 */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentClient } from '@app/agent/client';
import { createConnector, createReadApi } from '@app/connector';
import { loadEnv } from '@app/config';
import { connect, schema } from '@app/db';
import { createQueryApiClient } from '@app/query-api/client';
import { and, eq, sql } from 'drizzle-orm';
import { browser } from './lib/browser.js';
import {
  assert,
  createCheckRun,
  eventually,
  otlpGauge,
  sendOtlp,
  storeQuery,
} from './lib/checks.js';
import { fakeSlack, hasFile, type ThreadMessage } from './lib/fake-slack.js';

const env = loadEnv([
  'DATABASE_URL',
  'WEB_URL',
  'SLACK_PUBLIC_URL',
  'INGEST_URL',
  'QUERY_API_URL',
  'AGENT_URL',
  'INTERNAL_API_TOKEN',
  'METRICS_STORE_URL',
  'DEV_WORKSPACE_ID',
]);
const slackFake = process.env.SLACK_FAKE_URL ?? 'http://localhost:8093';
const stripeFake = process.env.STRIPE_FAKE_URL ?? 'http://localhost:8095';
const slack = fakeSlack(slackFake);
const { step, finish } = createCheckRun();
const { db, close } = connect(env.DATABASE_URL);
const run = Date.now().toString(36).toUpperCase();
const ALERT_CHANNEL = `C0V4${run}`;
const DEV = env.DEV_WORKSPACE_ID;

const actions = (m: ThreadMessage) =>
  (m.blocks ?? []).filter((b) => b.type === 'actions').flatMap((b) => b.elements ?? []);
const buttonOn = (label: string) => (m: ThreadMessage) =>
  actions(m).some((e) => e.text?.text === label);
const asText = (m: ThreadMessage) => `${m.text} ${JSON.stringify(m.blocks ?? [])}`;
const queryAs = (workspaceId: string) =>
  createQueryApiClient({
    url: env.QUERY_API_URL,
    internalToken: env.INTERNAL_API_TOKEN,
    workspaceId,
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sign a browser in as a fake Slack person. */
async function signIn(web: ReturnType<typeof browser>, user: string, team?: string) {
  const start = await web.get('/auth/slack', false);
  const authorize = new URL(start.location!);
  authorize.searchParams.set('user', user);
  if (team) authorize.searchParams.set('team', team);
  const approved = await fetch(authorize.toString().replace(/^http:\/\/[^/]+/, slackFake), {
    redirect: 'manual',
  });
  return web.get(approved.headers.get('location')!);
}

/** Install the app for a new fake Slack team: a new workspace. Returns its id and ingestion key. */
async function installTeam(team: string, admin: string) {
  const start = await fetch(`${env.SLACK_PUBLIC_URL}/slack/install`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  authorize.searchParams.set('team', team);
  authorize.searchParams.set('team_name', `Verify ${team}`);
  authorize.searchParams.set('user', admin);
  const approved = await fetch(authorize.toString().replace(/^http:\/\/[^/]+/, slackFake), {
    redirect: 'manual',
  });
  const page = await (await fetch(approved.headers.get('location')!)).text();
  const key = /([a-z0-9-]+_ik_[A-Za-z0-9_-]{43})/.exec(page)?.[1];
  const [row] = await db
    .select()
    .from(schema.slackInstallations)
    .where(eq(schema.slackInstallations.teamId, team));
  assert(row && key, 'the install did not create a workspace and key');
  return { workspaceId: row.workspaceId, key };
}

console.log('\nPhase 4 check\n');
await db.delete(schema.resolvedRequests).where(eq(schema.resolvedRequests.workspaceId, DEV));
const created: string[] = [];

try {
  // ---------------------------------------------------------------- alerts
  let pendingCard: ThreadMessage | undefined;
  let pendingThread = '';
  await step('a pending rule never notifies, even when its condition is true', async () => {
    const { ts } = await slack.mention(
      'alert me if p95 latency of POST /checkout/pay on checkout service including failures goes above 1 ms for 15 seconds',
      { channel: ALERT_CHANNEL },
    );
    pendingThread = ts;
    pendingCard = await slack.waitFor(ALERT_CHANNEL, ts, buttonOn('Approve'));
    assert(/Pending approval/.test(asText(pendingCard)), 'the card does not say it is pending');
    assert(
      /Nothing is watched/.test(asText(pendingCard)),
      'the card does not say nothing is watched',
    );
    // Its condition (p95 above 1 ms) is true all the time. Wait well past its duration.
    await sleep(45_000);
    const firing = (await slack.thread(ALERT_CHANNEL, ts))
      .concat(await channelMessages(ALERT_CHANNEL))
      .filter((m) => /^Firing/.test(m.text));
    assert(firing.length === 0, 'a pending rule sent a firing message');
    const states = await db.execute(
      sql`select count(*)::int as n from alert_states s join alert_rules r on r.id = s.rule_id where r.channel = ${'#' + ALERT_CHANNEL}`,
    );
    assert((states.rows[0] as { n: number }).n === 0, 'the engine evaluated a pending rule');
    return 'condition true for 45 s, not evaluated, no message';
  });

  let firingMessage: ThreadMessage | undefined;
  await step('an approved rule fires on the demo service after its duration', async () => {
    assert(pendingCard, 'no pending card from the previous step');
    const approvedAt = Date.now();
    await slack.click({
      channel: ALERT_CHANNEL,
      message_ts: pendingCard.ts,
      label: 'Approve',
      user: 'U0BOB',
    });
    const updated = await slack.waitFor(
      ALERT_CHANNEL,
      pendingThread,
      (m) => m.ts === pendingCard!.ts && /Approved by <@U0BOB>/.test(asText(m)),
    );
    assert(updated, 'the card was not marked approved');
    firingMessage = await eventually(
      async () => {
        const found = (await channelMessages(ALERT_CHANNEL)).find((m) => /^Firing/.test(m.text));
        assert(found, 'not fired yet');
        return found;
      },
      { waitMs: 90_000, pollMs: 2_000 },
    );
    const seconds = (firingMessage.postedAt - approvedAt) / 1000;
    assert(seconds >= 15, `it fired after ${seconds.toFixed(0)} s, before its 15 s duration`);
    const [approved] = await db
      .select()
      .from(schema.alertRules)
      .where(
        and(
          eq(schema.alertRules.channel, `#${ALERT_CHANNEL}`),
          eq(schema.alertRules.status, 'active'),
        ),
      );
    assert(approved?.approvedBy, 'the approver was not recorded');
    for (const label of ['Why did this happen?', 'Snooze 1 hour', 'Acknowledge']) {
      assert(buttonOn(label)(firingMessage), `the firing message has no “${label}”`);
    }
    return `fired ${seconds.toFixed(0)} s after approval (duration 15 s, evaluated every 15 s): “${firingMessage.text}”`;
  });

  await step(
    '“Why did this happen?” answers with a labelled hypothesis and its charts; snooze and acknowledge work',
    async () => {
      assert(firingMessage, 'no firing message');
      await slack.click({
        channel: ALERT_CHANNEL,
        message_ts: firingMessage.ts,
        label: 'Why did this happen?',
      });
      const hypothesis = await slack.waitFor(
        ALERT_CHANNEL,
        firingMessage.ts,
        (m) => /^Hypothesis:/.test(m.text),
        60_000,
      );
      const charts = await eventually(
        async () => {
          const files = (await slack.thread(ALERT_CHANNEL, firingMessage!.ts)).filter(hasFile);
          assert(files.length > 0, 'no chart behind the hypothesis');
          return files;
        },
        { waitMs: 30_000, pollMs: 1_000 },
      );
      await slack.click({
        channel: ALERT_CHANNEL,
        message_ts: firingMessage.ts,
        label: 'Acknowledge',
        user: 'U0CAROL',
      });
      await slack.click({
        channel: ALERT_CHANNEL,
        message_ts: firingMessage.ts,
        label: 'Snooze 1 hour',
        user: 'U0CAROL',
      });
      await slack.waitFor(ALERT_CHANNEL, firingMessage.ts, (m) =>
        /snoozed this alert for 1 hour/.test(m.text),
      );
      await slack.waitFor(ALERT_CHANNEL, firingMessage.ts, (m) =>
        /acknowledged this alert/.test(m.text),
      );
      const incidents = await db
        .select()
        .from(schema.memoryEntries)
        .where(
          and(eq(schema.memoryEntries.workspaceId, DEV), eq(schema.memoryEntries.kind, 'incident')),
        );
      assert(
        incidents.some((m) => /^Hypothesis:/.test(m.text)),
        'the explanation was not added to the incident in memory',
      );
      // Switch the rule off so it does not keep firing.
      const [rule] = await db
        .select()
        .from(schema.alertRules)
        .where(eq(schema.alertRules.channel, `#${ALERT_CHANNEL}`))
        .limit(1);
      if (rule) {
        await db.execute(sql`insert into alert_rules (id, version, workspace_id, name, expression, duration, severity, channel, status, created_by_kind, created_by_id)
        select id, version + 1, workspace_id, name, expression, duration, severity, channel, 'disabled', 'system', 'verify' from alert_rules
        where id = ${rule.id} and version = (select max(version) from alert_rules where id = ${rule.id})`);
      }
      return `${charts.length} chart(s); “${hypothesis.text.slice(0, 90)}…”`;
    },
  );

  // ---------------------------------------------------------------- collectors and starters
  await step('a data source: test fetch, pending card, then collected after approval', async () => {
    const { ts } = await slack.mention(
      'monitor http://demo-checkout:8080/checkout/summary every 30 seconds',
      { channel: ALERT_CHANNEL },
    );
    const card = await slack.waitFor(ALERT_CHANNEL, ts, buttonOn('Approve'));
    assert(/Succeeded, 200/.test(asText(card)), 'the test fetch did not succeed');
    const before = await storeQuery(
      env.METRICS_STORE_URL,
      `http_check_up_ratio{workspace="${DEV}", check_name="demo-checkout/checkout/summary"}`,
    );
    assert(before.length === 0 || before.every((r) => r.value === 1), 'unexpected earlier data');
    await slack.click({
      channel: ALERT_CHANNEL,
      message_ts: card.ts,
      label: 'Approve',
      user: 'U0BOB',
    });
    const rows = await eventually(
      async () => {
        // Unitless gauges are stored with a _ratio suffix, as the catalog's name mapping predicts.
        const found = await queryAs(DEV).instant(
          'http_check_up_ratio{check_name="demo-checkout/checkout/summary"}',
        );
        assert(found.length > 0, 'no check result yet');
        return found;
      },
      { waitMs: 60_000, pollMs: 3_000 },
    );
    assert(rows[0]!.value === 1, 'the check reports the URL down');
    const unsafe = await slack.mention(
      'monitor http://169.254.169.254/latest/meta-data every minute',
      { channel: ALERT_CHANNEL },
    );
    const refusal = await slack.waitFor(
      ALERT_CHANNEL,
      unsafe.ts,
      (m) => m.ts !== unsafe.ts && m.user === 'U0BOT',
    );
    assert(
      /private network/.test(refusal.text),
      `an internal address was not refused: ${refusal.text}`,
    );
    return `http_check_up = ${rows[0]!.value} for the approved collector; 169.254.169.254 refused`;
  });

  await step(
    'starter dashboards and suggested (pending) alerts for each demo service',
    async () => {
      const starters = await db
        .select()
        .from(schema.starterDashboards)
        .where(eq(schema.starterDashboards.workspaceId, DEV));
      const services = starters.map((s) => s.service).sort();
      assert(
        services.includes('checkout') && services.includes('inventory'),
        `starters for ${services.join(', ')}`,
      );
      const suggested =
        await db.execute(sql`select status from alert_rules r where workspace_id = ${DEV} and created_by_id = 'starter'
      and version = (select max(version) from alert_rules x where x.id = r.id)`);
      assert(suggested.rows.length >= 4, `${suggested.rows.length} suggested rules`);
      return `${starters.length} starter dashboards; ${suggested.rows.length} suggested rules`;
    },
  );

  // ---------------------------------------------------------------- refining
  await step('a follow-up in the same Slack thread changes the chart (S7)', async () => {
    const { ts, channel } = await slack.mention(
      'p95 latency of POST /checkout/pay on checkout service including failures in last 1 hour',
    );
    await slack.waitFor(channel, ts, hasFile);
    await slack.mention('make it the last 24 hours, split by method', { thread_ts: ts });
    const second = await eventually(
      async () => {
        const files = (await slack.thread(channel, ts)).filter(hasFile);
        assert(files.length >= 2, 'no second chart yet');
        return (await slack.thread(channel, ts)).filter(buttonOn('Save to dashboard')).at(-1)!;
      },
      { waitMs: 30_000, pollMs: 1_000 },
    );
    const query = asText(second);
    assert(
      /http_request_method\) \(rate/.test(query) || /by \(le, http_request_method\)/.test(query),
      `not split by method: ${query.slice(0, 200)}`,
    );
    return 'second chart in the thread, split by method, last 24 hours';
  });

  const web = browser(env.WEB_URL);
  const page = await signIn(web, 'U0ALICE');
  const dashboardUrl = page.url.split('?')[0]!;
  const dashboardHtml = (await web.get(dashboardUrl)).html;
  const firstPanel = /data-panel="([^"]+)"/.exec(dashboardHtml)?.[1];

  await step('a panel changed by prompt becomes a new version of the same panel (W6)', async () => {
    assert(firstPanel, 'no panel on the dashboard');
    const versions = async () =>
      (await db.select().from(schema.panels).where(eq(schema.panels.id, firstPanel))).length;
    const before = await versions();
    const draft = await web.post(`${dashboardUrl}/panels/${firstPanel}/refine`, {
      text: 'show the last 24 hours',
    });
    assert(draft.html.includes('Looks right, add to dashboard'), 'no draft for the change');
    const request = new URL(draft.url).searchParams.get('request')!;
    await web.post(`/requests/${request}/confirm`, { dashboardId: dashboardUrl.split('/').pop()! });
    assert((await versions()) === before + 1, 'no new version of the panel');
    return `panel ${firstPanel.slice(0, 8)}… version ${before} → ${before + 1}`;
  });

  // ---------------------------------------------------------------- sharing, export, APIs
  await step('share by link: read-only, no sign-in, and it can be revoked (W9)', async () => {
    const made = await web.post(`${dashboardUrl}/share`, {});
    const link = /(http:\/\/[^<\s]+\/share\/[a-z0-9-]+_sh_[A-Za-z0-9_-]+)/.exec(made.html)?.[1];
    assert(link, 'no link shown');
    const anonymous = await fetch(link);
    const html = await anonymous.text();
    assert(
      anonymous.status === 200 && html.includes('Read-only link') && html.includes('<svg'),
      'the shared page did not render',
    );
    assert(
      !html.includes('What do you want to see?') && !html.includes('Edit the query'),
      'the shared page offers editing',
    );
    const settings = (await web.get('/settings')).html;
    const shareId = [...settings.matchAll(/action="\/settings\/shares\/([^/]+)\/revoke"/g)].at(
      -1,
    )?.[1];
    await web.post(`/settings/shares/${shareId}/revoke`, {});
    assert((await fetch(link)).status === 404, 'a revoked link still works');
    return 'anonymous view works; revoked link answers 404';
  });

  await step('one-time export to Grafana (W12)', async () => {
    const exported = await web.get(`${dashboardUrl}/export/grafana`);
    const json = JSON.parse(exported.html) as {
      panels: { targets: { expr: string }[]; type: string }[];
      __inputs: unknown[];
    };
    assert(
      json.panels.length > 0 && json.panels.every((p) => p.targets[0]?.expr),
      'panels without queries',
    );
    assert(json.__inputs.length === 1, 'no data source input');
    return `${json.panels.length} panels, types ${[...new Set(json.panels.map((p) => p.type))].join(', ')}`;
  });

  let apiToken = '';
  await step('read-only API tokens: Prometheus API for Grafana, scoped and revocable', async () => {
    const made = await web.post('/settings/tokens', { name: `verify ${run}` });
    apiToken = /([a-z0-9-]+_rt_[A-Za-z0-9_-]{43})/.exec(made.html)?.[1] ?? '';
    assert(apiToken, 'no token shown');
    const prom = (path: string, token = apiToken) =>
      fetch(`${env.WEB_URL}/api/prom/api/v1/${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    const ok = (await (
      await prom(
        'query?query=' +
          encodeURIComponent(
            'sum by (service_name) (rate(http_server_request_duration_seconds_count[5m]))',
          ),
      )
    ).json()) as { status: string; data: { result: { metric: Record<string, string> }[] } };
    assert(ok.status === 'success' && ok.data.result.length > 0, 'no result');
    assert(
      ok.data.result.every((r) => !('workspace' in r.metric)),
      'the workspace label leaked',
    );
    const labels = (await (await prom('labels')).json()) as { data: string[] };
    assert(!labels.data.includes('workspace'), 'the workspace label is listed');
    assert(
      (await prom('query?query=' + encodeURIComponent(`up{workspace="other"}`))).status === 422,
      'a hostile query was answered',
    );
    assert((await prom('query?query=up', '')).status === 401, 'no token was accepted');
    return `${ok.data.result.length} services answered; hostile query 422; no token 401`;
  });

  await step('the connector for Claude Code reads metrics with an API token (K6)', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createConnector(createReadApi({ url: env.WEB_URL, token: apiToken })).connect(a);
    const client = new Client({ name: 'verify', version: '1' });
    await client.connect(b);
    const services = JSON.parse(
      (
        (await client.callTool({ name: 'list_services', arguments: {} })).content as {
          text: string;
        }[]
      )[0]!.text,
    ) as { services: string[] };
    assert(services.services.includes('checkout'), 'no services');
    const stats = (
      (await client.callTool({ name: 'endpoint_stats', arguments: { service: 'checkout' } }))
        .content as { text: string }[]
    )[0]!.text;
    assert(stats.includes('/checkout/pay'), 'no endpoint stats');
    const result = await client.callTool({
      name: 'query_metrics',
      arguments: {
        query: 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout"}[5m]))',
        range: '1h',
      },
    });
    assert(!result.isError, 'the query failed');
    return `services: ${services.services.join(', ')}`;
  });

  // ---------------------------------------------------------------- billing, deletion, own store
  const teamC = `T0B${run}`;
  const browserC = browser(env.WEB_URL);
  let workspaceC = '';
  await step('a trial workspace subscribes and is billed in the provider’s test mode', async () => {
    const installed = await installTeam(teamC, 'U0CAROL');
    workspaceC = installed.workspaceId;
    created.push(workspaceC);
    await signIn(browserC, 'U0CAROL', teamC);
    const billing = await browserC.get('/billing');
    assert(/Free trial, ends/.test(billing.html), 'the new workspace is not on a trial');
    const checkout = await browserC.post('/billing/checkout', {}, false);
    assert(checkout.location?.startsWith(stripeFake), `checkout went to ${checkout.location}`);
    const paid = await fetch(checkout.location!, { redirect: 'manual' });
    assert(paid.status === 302, 'the fake checkout did not complete');
    const [row] = await eventually(
      async () => {
        const rows = await db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceC));
        assert(rows[0]?.billingStatus === 'active', `status ${rows[0]?.billingStatus}`);
        return rows;
      },
      { waitMs: 20_000, pollMs: 500 },
    );
    const after = await browserC.get('/billing');
    assert(
      /Subscribed/.test(after.html) && /FAKE-\d{4}/.test(after.html),
      'no subscription or invoice shown',
    );
    return `status ${row!.billingStatus}, subscription ${row!.billingSubscriptionId}, invoice listed`;
  });

  await step('cancelling deletes the workspace’s metrics, specs, memory and caches', async () => {
    const ws = workspaceC;
    const key = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws)))[0];
    assert(key, 'no workspace');
    // Give it something in each place: metrics, a spec, memory, a cached result, a cached request.
    const metric = `verify.delete.${run.toLowerCase()}`;
    const { key: ingestionKey } = { key: await rotateKey(ws) };
    assert(
      (await sendOtlp(
        env.INGEST_URL,
        ingestionKey,
        otlpGauge({ service: 'verify-delete', metric, value: 1 }),
      )) === 200,
      'could not send',
    );
    const stored = metric.replaceAll('.', '_');
    await eventually(async () =>
      assert(
        (await storeQuery(env.METRICS_STORE_URL, `${stored}{workspace="${ws}"}`)).length === 1,
        'not stored yet',
      ),
    );
    await browserC.post('/memory', { subject: 'x', text: 'a team decision' });
    await browserC.get('/');
    await queryAs(ws).query({ query: stored, range: '1h' });
    await db
      .insert(schema.resolvedRequests)
      .values({ workspaceId: ws, key: 'x', value: {}, catalogFingerprint: 'x' });
    const count = async (
      table:
        'memory_entries' | 'dashboards' | 'resolved_requests' | 'users' | 'slack_installations',
    ) =>
      Number(
        (
          (
            await db.execute(
              sql`select count(*)::int as n from ${sql.identifier(table)} where workspace_id = ${ws}`,
            )
          ).rows[0] as { n: number }
        ).n,
      );
    assert(
      (await count('memory_entries')) > 0 && (await count('dashboards')) > 0,
      'nothing to delete',
    );

    const cancelled = await browserC.post('/billing/cancel', {});
    assert(/Cancelled/.test(cancelled.html), 'cancel did not take');
    await eventually(
      async () => {
        const rows = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws));
        assert(rows.length === 0, 'the workspace still exists');
      },
      { waitMs: 90_000, pollMs: 3_000 },
    );
    const left = await Promise.all(
      (
        [
          'memory_entries',
          'dashboards',
          'resolved_requests',
          'users',
          'slack_installations',
        ] as const
      ).map(count),
    );
    assert(
      left.every((n) => n === 0),
      `rows left: ${left.join(', ')}`,
    );
    const series = await storeQuery(env.METRICS_STORE_URL, `{workspace="${ws}"}`);
    assert(series.length === 0, `${series.length} series left in the store`);
    const cached = await queryAs(ws).query({ query: stored, range: '1h' });
    assert(!cached.cached && cached.lineCount === 0, 'a cached result survived');
    created.splice(created.indexOf(ws), 1);
    return 'workspace, specs, memory, caches and every series gone after the grace period';
  });

  await step('after a trial ends unpaid, building pauses and viewing continues', async () => {
    const ended = randomUUID();
    await db.insert(schema.workspaces).values({
      id: ended,
      name: `verify-ended-${run}`,
      plan: 'example',
      billingStatus: 'trialing',
      trialEndsAt: new Date(Date.now() - 60_000),
    });
    created.push(ended);
    const agent = createAgentClient({
      url: env.AGENT_URL,
      internalToken: env.INTERNAL_API_TOKEN,
      workspaceId: ended,
      userId: 'verify',
    });
    const reply = await agent.ask('latency of checkout');
    assert(
      reply.output.kind === 'failed' && /trial has ended/.test(reply.output.message),
      `got ${reply.output.kind}`,
    );
    const calls = await db
      .select()
      .from(schema.modelCalls)
      .where(eq(schema.modelCalls.workspaceId, ended));
    assert(calls.length === 0, 'a model was called');
    await queryAs(ended).query({ query: 'up', range: '1h' });
    return `“${reply.output.message.slice(0, 60)}…”; queries still answer`;
  });

  await step(
    'a workspace can read from its own store, which is never written to (H8)',
    async () => {
      const own = randomUUID();
      await db.insert(schema.workspaces).values({
        id: own,
        name: `verify-own-${run}`,
        plan: 'example',
        metricsStoreConfig: { type: 'victoriametrics', url: 'http://metrics-store:8428' },
      });
      created.push(own);
      const rows = await queryAs(own).instant('count(http_server_request_duration_seconds_count)');
      assert((rows[0]?.value ?? 0) > 0, 'nothing read from the workspace’s own store');
      const deleted = await queryAs(own).deleteWorkspaceData();
      assert(!deleted.deleted, 'the workspace’s own store was written to');
      return `read ${rows[0]!.value} series from its own store; deletion refused`;
    },
  );
} finally {
  for (const id of created) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
  await close();
}

/** Every message the bot posted in a channel, top level and in threads. */
async function channelMessages(channel: string): Promise<ThreadMessage[]> {
  const response = await fetch(`${slackFake}/fake/channel?channel=${encodeURIComponent(channel)}`);
  return ((await response.json()) as { messages: ThreadMessage[] }).messages;
}

/** A fresh ingestion key for a workspace (the install page showed one; this avoids keeping it). */
async function rotateKey(workspaceId: string): Promise<string> {
  const { generateIngestionKey, hashIngestionKey } = await import('@app/ingest');
  const key = generateIngestionKey();
  await db
    .update(schema.workspaces)
    .set({ ingestionKeyHash: hashIngestionKey(key) })
    .where(eq(schema.workspaces.id, workspaceId));
  return key;
}

process.exit(finish('Phase 4'));
