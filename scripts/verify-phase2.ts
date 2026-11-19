/**
 * Phase 2 acceptance check, against the local stack and its fake Slack.
 *
 * "Accepted when: a person with no query knowledge gets a correct chart for
 * the example request in one Slack thread; in a one-channel pilot, 70% of
 * charts are saved or kept without editing the query; median time from
 * request to chart is under 10 seconds."
 *
 * The first and third are checked here, through the real Slack app talking to
 * a fake Slack. The pilot needs people and a real Slack, and cannot be checked
 * by a script.
 */
import { createHmac } from 'node:crypto';
import { loadEnv } from '@app/config';
import { connect, schema } from '@app/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { assert, createCheckRun } from './lib/checks.js';
import { fakeSlack, hasActions, hasFile, type ThreadMessage } from './lib/fake-slack.js';

const env = loadEnv([
  'DATABASE_URL',
  'SLACK_PUBLIC_URL',
  'SLACK_SIGNING_SECRET',
  'DEV_WORKSPACE_ID',
]);
const fakeUrl = process.env.SLACK_FAKE_URL ?? 'http://localhost:8093';
const slack = fakeSlack(fakeUrl);
const { step, finish } = createCheckRun();
const { db, close } = connect(env.DATABASE_URL);
const createdWorkspaces: string[] = [];
const newTeam = `T0V${Date.now().toString(36).toUpperCase()}`;

const actions = (m: ThreadMessage) =>
  (m.blocks ?? []).filter((b) => b.type === 'actions').flatMap((b) => b.elements ?? []);

/**
 * Run the plan's example in one thread, as a person would. Different wording
 * gives a request the cache has not seen, so the questions are asked.
 */
async function example(user: string, text = 'latency graph of checkout service in last 5 hr') {
  const started = Date.now();
  const { ts, channel } = await slack.mention(text, { user });
  const picker = await slack.waitFor(channel, ts, (m) => m.ts !== ts && hasActions(m));
  return { ts, channel, picker, started };
}

console.log('\nPhase 2 check\n');

// Start without cached answers: these checks walk through the questions, which a cached request skips.
await db
  .delete(schema.resolvedRequests)
  .where(eq(schema.resolvedRequests.workspaceId, env.DEV_WORKSPACE_ID));

// Start from a clean slate: the test people's saved answers from earlier runs would skip questions.
const testPeople = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(
    and(
      eq(schema.users.workspaceId, env.DEV_WORKSPACE_ID),
      inArray(schema.users.slackUserId, ['U0ALICE', 'U0BOB']),
    ),
  );
for (const person of testPeople) {
  await db
    .delete(schema.memoryEntries)
    .where(
      and(
        eq(schema.memoryEntries.workspaceId, env.DEV_WORKSPACE_ID),
        like(schema.memoryEntries.subject, `user:${person.id}:%`),
      ),
    );
}

try {
  await step(
    'installing the app creates a workspace, its admin and its ingestion key',
    async () => {
      const start = await fetch(`${env.SLACK_PUBLIC_URL}/slack/install`, { redirect: 'manual' });
      assert(start.status === 302, `install returned HTTP ${start.status}`);
      const authorize = new URL(start.headers.get('location')!);
      assert(
        authorize.searchParams.get('scope')?.includes('app_mentions:read'),
        'scopes are missing',
      );
      authorize.searchParams.set('team', newTeam);
      authorize.searchParams.set('team_name', 'Verify team');
      authorize.searchParams.set('user', 'U0CAROL');
      const approved = await fetch(authorize.toString().replace(/^http:\/\/[^/]+/, fakeUrl), {
        redirect: 'manual',
      });
      const callback = approved.headers.get('location')!;
      const done = await fetch(callback);
      const page = await done.text();
      assert(done.status === 200, `the callback returned HTTP ${done.status}`);
      assert(/_ik_[A-Za-z0-9_-]{43}/.test(page), 'the page does not show the ingestion key');

      const [installation] = await db
        .select()
        .from(schema.slackInstallations)
        .where(eq(schema.slackInstallations.teamId, newTeam));
      assert(installation, 'no installation stored');
      createdWorkspaces.push(installation.workspaceId);
      assert(!installation.botTokenEncrypted.includes('xoxb'), 'the bot token is stored in clear');
      const [admin] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.workspaceId, installation.workspaceId));
      assert(
        admin?.role === 'admin' && admin.slackUserId === 'U0CAROL',
        'the installer is not the admin',
      );
      const [workspace] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, installation.workspaceId));
      assert(workspace?.ingestionKeyHash, 'no ingestion key');

      // Installing again keeps the workspace.
      const again = new URL(
        (await fetch(`${env.SLACK_PUBLIC_URL}/slack/install`, { redirect: 'manual' })).headers.get(
          'location',
        )!,
      );
      again.searchParams.set('team', newTeam);
      const back = (
        await fetch(again.toString().replace(/^http:\/\/[^/]+/, fakeUrl), { redirect: 'manual' })
      ).headers.get('location')!;
      assert((await fetch(back)).status === 200, 'reinstall failed');
      const count = await db
        .select()
        .from(schema.slackInstallations)
        .where(eq(schema.slackInstallations.teamId, newTeam));
      assert(count.length === 1, 'reinstalling created a second workspace');

      const forged = await fetch(`${callback.split('?')[0]}?code=x&state=forged.123.abc`);
      assert(forged.status === 400, 'a forged state was accepted');
      return `workspace ${installation.workspaceId.slice(0, 8)}…, admin U0CAROL, key shown once; reinstall kept it; forged state refused`;
    },
  );

  await step('requests from Slack are not accepted unless Slack signed them', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T0DEV',
      event: { type: 'app_mention', user: 'U0ALICE', text: 'x', ts: '1.1', channel: 'C0OPS' },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const send = (signature: string) =>
      fetch(`${env.SLACK_PUBLIC_URL}/slack/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body,
      });
    const unsigned = await send('v0=0000');
    const wrongKey = await send(
      `v0=${createHmac('sha256', 'not-the-secret').update(`v0:${timestamp}:${body}`).digest('hex')}`,
    );
    assert(
      unsigned.status === 401 && wrongKey.status === 401,
      `got ${unsigned.status} and ${wrongKey.status}`,
    );
    return 'bad signature: 401';
  });

  await step('the example request becomes a correct chart in one thread', async () => {
    const { ts, channel, picker } = await example('U0ALICE');
    const select = actions(picker).find((e) => e.type === 'static_select');
    assert(select, 'the endpoint question is not a picker');
    const labels = select.options!.map((o) => o.text.text);
    assert(labels.at(-1) === 'All endpoints combined', '“All endpoints combined” is not last');
    assert(
      labels.some((l) => l.startsWith('POST /checkout/pay')),
      'the picker does not list real endpoints',
    );
    assert(
      labels.some((l) => /Slowest/.test(l)) && labels.some((l) => /Busiest/.test(l)),
      'Slowest/Busiest tags are missing',
    );
    await slack.click({
      message_ts: picker.ts,
      action_id: 'answer_pick',
      option: 'POST /checkout/pay',
    });

    // The second question depends on what this person saved before: answer whichever it is.
    const second = await slack.waitFor(
      channel,
      ts,
      (m) => m.ts !== picker.ts && m.ts !== ts && (hasActions(m) || hasFile(m)),
    );
    if (!hasFile(second) && !actions(second).some((e) => e.text?.text === 'Save to dashboard')) {
      const button =
        actions(second).find((e) => e.text?.text === 'Slow tail (p95)') ?? actions(second)[0]!;
      await slack.click({ message_ts: second.ts, label: button.text!.text });
    }
    const image = await slack.waitFor(channel, ts, hasFile);
    const draft = await slack.waitFor(channel, ts, (m) =>
      actions(m).some((e) => e.text?.text === 'Save to dashboard'),
    );
    const thread = await slack.thread(channel, ts);
    const questions = thread.filter((m) => m.user === 'U0BOT' && m.edited).length;
    assert(questions <= 2, `${questions} questions`);
    assert(
      thread.every((m) => m.thread_ts === ts || m.ts === ts),
      'a reply left the thread',
    );
    assert(image.files![0]!.bytes > 5000, 'the chart image is empty');
    const png = Buffer.from(
      await (await fetch(image.files![0]!.url.replace(/^http:\/\/[^/]+/, fakeUrl))).arrayBuffer(),
    );
    assert(png.subarray(1, 4).toString() === 'PNG', 'the chart is not a PNG');
    assert(
      /^P95 latency was \d+ ms most recently/.test(image.text),
      `unexpected reading: ${image.text}`,
    );
    const query = JSON.stringify(draft.blocks);
    assert(
      query.includes('http_route=\\"/checkout/pay\\"') && query.includes('histogram_quantile(0.95'),
      'the query shown is not the expected one',
    );
    assert(query.includes('Assumed: p95'), 'the assumptions are not shown');
    return `${questions} questions; chart ${Math.round(png.length / 1024)} KB; “${image.text}”`;
  });

  await step('the buttons save the chart and remember the answers', async () => {
    const bobAsks = 'latency graph of the checkout service over the last 5 hours';
    const { ts, channel, picker } = await example('U0BOB', bobAsks);
    await slack.click({
      message_ts: picker.ts,
      action_id: 'answer_pick',
      option: 'GET /checkout/summary',
      user: 'U0BOB',
    });
    const second = await slack.waitFor(
      channel,
      ts,
      (m) => m.ts !== picker.ts && m.ts !== ts && hasActions(m),
    );
    await slack.click({ message_ts: second.ts, label: 'Typical (p50)', user: 'U0BOB' });
    const draft = await slack.waitFor(channel, ts, (m) =>
      actions(m).some((e) => e.text?.text === 'Save to dashboard'),
    );
    await slack.click({ message_ts: draft.ts, label: 'Skip questions next time', user: 'U0BOB' });
    await slack.click({ message_ts: draft.ts, label: 'Save to dashboard', user: 'U0BOB' });
    await slack.waitFor(
      channel,
      ts,
      (m) => m.ts === draft.ts && /Saved to the/.test(JSON.stringify(m.blocks)),
    );
    const panels = await db
      .select()
      .from(schema.panels)
      .where(eq(schema.panels.workspaceId, env.DEV_WORKSPACE_ID));
    assert(
      panels.some((p) => p.request === bobAsks && p.query.includes('0.5,')),
      'the panel was not saved',
    );

    // Bob's next latency request uses p50 without asking.
    const next = await slack.mention(
      'latency of GET /checkout/summary on checkout service in last 1 hour',
      { user: 'U0BOB' },
    );
    const reply = await slack.waitFor(
      next.channel,
      next.ts,
      (m) => m.ts !== next.ts && (hasActions(m) || hasFile(m)),
    );
    const asked = JSON.stringify(reply.blocks ?? []);
    assert(!asked.includes('Which latency'), 'it asked for the percentile again');
    return 'saved panel stored; next request skipped the percentile question';
  });

  await step('a direct message works like a mention', async () => {
    const { ts, channel } = await slack.dm(
      'p99 latency of POST /checkout/pay on checkout service including failures in last 1 hour',
    );
    const image = await slack.waitFor(channel, ts, hasFile);
    return `chart in the DM thread: “${image.text}”`;
  });

  await step('each Slack workspace sees only its own data', async () => {
    const { ts, channel } = await slack.mention('latency graph of checkout service in last 5 hr', {
      team: newTeam,
      user: 'U0CAROL',
    });
    const reply = await slack.waitFor(channel, ts, (m) => m.ts !== ts && m.user === 'U0BOT');
    assert(
      /no service called|Nothing in the catalog/i.test(reply.text),
      `the new workspace saw something: ${reply.text}`,
    );
    return `new workspace: “${reply.text.slice(0, 70)}…”`;
  });

  await step('the median time from request to chart is under 10 seconds', async () => {
    const requests = [
      'p95 latency of POST /checkout/pay on checkout service including failures in last 1 hour',
      'p50 latency of GET /checkout/summary on checkout service including failures in last 30 minutes',
      'error rate of POST /checkout/pay on checkout service in last 6 hours',
      'orders completed by payment method in the last 6 hours',
      'stock level per warehouse for inventory service in last 12 hours',
      'p99 latency of POST /inventory/reserve on inventory service including failures in last 2 hours',
      'requests per second on GET /inventory/stock for inventory service including failures, last 3 hours',
      'checkout service error rate by endpoint over the last 12 hours',
      'median restock duration by result for inventory service in last 12 hours',
    ];
    const times: number[] = [];
    for (const text of requests) {
      const started = Date.now();
      const { ts, channel } = await slack.mention(text, { user: 'U0ALICE' });
      await slack.waitFor(channel, ts, hasFile);
      times.push(Date.now() - started);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    assert(median < 10_000, `median ${median} ms`);
    return `median ${(median / 1000).toFixed(2)} s, slowest ${(sorted.at(-1)! / 1000).toFixed(2)} s over ${times.length} requests (stand-in model)`;
  });
} finally {
  if (createdWorkspaces.length > 0) {
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, createdWorkspaces));
  }
  await close();
}

console.log(
  '  —     the one-channel pilot (70% kept without editing) needs people in a real Slack; not checked here',
);
process.exit(finish('Phase 2'));
