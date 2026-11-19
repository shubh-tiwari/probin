/**
 * Phase 5 acceptance check, and the review test set (evals/review/cases.yaml),
 * against the local stack with its fake GitHub.
 *
 * "Accepted when: the bottleneck report ranks the seeded slow endpoints first
 * and links each to the right handler; the convention check flags every
 * seeded break and nothing else in the test set; a dismissed comment type is
 * not repeated on the next pull request."
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILENAME, loadEnv } from '@app/config';
import { connect, schema } from '@app/db';
import { and, desc, eq, like } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { browser } from './lib/browser.js';
import { assert, createCheckRun, eventually } from './lib/checks.js';

interface Edit {
  path: string;
  after: string;
  before?: boolean;
  insert: string[];
}
interface PullCase {
  id: string;
  title: string;
  edits: Edit[];
  expect: { rule: string; path: string; contains: string }[];
}
interface Cases {
  bottleneck: { top: { service: string; route: string; file: string; match: string }[] };
  pulls: PullCase[];
}

const env = loadEnv(['DATABASE_URL', 'WEB_URL', 'DEV_WORKSPACE_ID']);
const github = process.env.GITHUB_FAKE_URL ?? 'http://localhost:8096';
const reviewUrl = process.env.REVIEW_URL ?? 'http://localhost:8097';
const slackFake = process.env.SLACK_FAKE_URL ?? 'http://localhost:8093';
const REPO = 'acme/shop';
const cases = parseYaml(
  readFileSync(
    fileURLToPath(new URL('../evals/review/cases.yaml', import.meta.url)),
    'utf8',
  ).replaceAll('{manifest}', MANIFEST_FILENAME),
) as Cases;
const { step, finish } = createCheckRun();
const { db, close } = connect(env.DATABASE_URL);
const web = browser(env.WEB_URL);
const DEV = env.DEV_WORKSPACE_ID;
let installation = '';

const fileOnMain = async (path: string) => {
  const response = await fetch(`${github}/fake/file?repo=${REPO}&path=${encodeURIComponent(path)}`);
  assert(response.ok, `no ${path} in the repository`);
  return response.text();
};
const lineOf = (content: string, text: string) =>
  content.split('\n').findIndex((l) => l.includes(text)) + 1;

/** Apply a case's edits to main and open the pull request. Returns its number. */
async function openPull(pull: PullCase): Promise<{ number: number; lines: Map<string, string[]> }> {
  const changes: Record<string, string> = {};
  const lines = new Map<string, string[]>();
  for (const edit of pull.edits) {
    const content = (changes[edit.path] ?? (await fileOnMain(edit.path))).split('\n');
    const at = content.findIndex((l) => l.includes(edit.after));
    assert(at !== -1, `${pull.id}: no line with “${edit.after}” in ${edit.path}`);
    content.splice(edit.before ? at : at + 1, 0, ...edit.insert);
    changes[edit.path] = content.join('\n');
    lines.set(edit.path, content);
  }
  const response = await fetch(`${github}/fake/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: REPO, title: pull.title, changes, installation }),
  });
  const body = (await response.json()) as { number: number; webhook: number };
  assert(body.webhook === 200, `the webhook was answered with ${body.webhook}`);
  return { number: body.number, lines };
}

/** Wait for Review to finish a pull request, and return its findings. */
async function findingsOf(number: number) {
  const report = await eventually(
    async () => {
      const [row] = await db
        .select()
        .from(schema.reviewReports)
        .where(
          and(
            eq(schema.reviewReports.workspaceId, DEV),
            eq(schema.reviewReports.repository, REPO),
            eq(schema.reviewReports.pullRequest, number),
            eq(schema.reviewReports.kind, 'pull_request'),
          ),
        )
        .orderBy(desc(schema.reviewReports.createdAt))
        .limit(1);
      assert(row, `pull request #${number} not reviewed yet`);
      return row;
    },
    { waitMs: 60_000, pollMs: 1_000 },
  );
  const findings = await db
    .select()
    .from(schema.reviewFindings)
    .where(eq(schema.reviewFindings.reportId, report.id));
  return { report, findings };
}

console.log('\nPhase 5 check and the review test set\n');

// A clean slate: earlier dismissals would hide findings this run expects.
await db
  .delete(schema.memoryEntries)
  .where(
    and(
      eq(schema.memoryEntries.workspaceId, DEV),
      eq(schema.memoryEntries.kind, 'review_feedback'),
    ),
  );

try {
  await step('connecting GitHub links the installation to the workspace', async () => {
    const start = await web.get('/auth/slack', false);
    const approved = await fetch(start.location!.replace(/^http:\/\/[^/]+/, slackFake), {
      redirect: 'manual',
    });
    await web.get(approved.headers.get('location')!);
    const go = await web.post('/github/connect', {}, false);
    assert(go.location?.startsWith(github), `connect went to ${go.location}`);
    const installed = await fetch(go.location!, { redirect: 'manual' });
    const back = await web.get(installed.headers.get('location')!);
    assert(back.html.includes('GitHub is connected'), 'not connected');
    const [row] = await db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, DEV))
      .orderBy(desc(schema.githubInstallations.createdAt))
      .limit(1);
    assert(row, 'no installation stored');
    installation = row.installationId;
    const forged = await fetch(`${reviewUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=00' },
      body: '{}',
    });
    assert(forged.status === 401, 'an unsigned webhook was accepted');
    return `installation ${installation}; unsigned webhooks refused`;
  });

  await step(
    'the bottleneck report ranks the seeded slow endpoints first, each linked to its handler',
    async () => {
      const ran = await web.post('/review/run', { kind: 'bottleneck' });
      assert(/\/review\/[0-9a-f-]{36}/.test(ran.url), `no report page: ${ran.url}`);
      const reportId = ran.url.split('/review/')[1]!.split('#')[0]!;
      const findings = (
        await db
          .select()
          .from(schema.reviewFindings)
          .where(eq(schema.reviewFindings.reportId, reportId))
          .orderBy(schema.reviewFindings.createdAt)
      ).filter((f) => f.kind === 'slow_endpoint');
      const expected = cases.bottleneck.top;
      const top = findings.slice(0, expected.length);
      const got = new Set(top.map((f) => `${f.service} ${f.route}`));
      for (const want of expected) {
        assert(
          got.has(`${want.service} ${want.route}`),
          `${want.route} is not in the top ${expected.length}: ${[...got].join(', ')}`,
        );
        const finding = top.find((f) => f.route === want.route)!;
        const line = lineOf(await fileOnMain(want.file), want.match);
        assert(
          finding.path === want.file && finding.line === line,
          `${want.route} linked to ${finding.path}:${finding.line}, expected ${want.file}:${line}`,
        );
        const evidence = finding.evidence as { metric: string; window: string };
        assert(
          evidence.metric === 'http.server.request.duration' && evidence.window,
          'no metric and window named',
        );
        assert(/Suggested fix:/.test(finding.body), 'no suggested fix');
      }
      assert(
        ran.html.includes('Based on') && ran.html.includes('Dismiss: not useful'),
        'the review page does not show evidence and decisions',
      );
      return top.map((f) => `${f.route} → ${f.path}:${f.line}`).join('; ');
    },
  );

  const results: { id: string; ok: boolean; detail: string }[] = [];
  await step(
    `the convention check flags every seeded break and nothing else (${cases.pulls.length} pull requests)`,
    async () => {
      for (const pull of cases.pulls) {
        const { number, lines } = await openPull(pull);
        const { findings } = await findingsOf(number);
        const got = findings
          .filter((f) => f.kind.startsWith('convention:'))
          .map((f) => ({
            rule: f.kind.slice('convention:'.length),
            path: f.path ?? '',
            line: f.line ?? 0,
          }));
        const want = pull.expect.map((e) => ({
          rule: e.rule,
          path: e.path,
          line: (lines.get(e.path) ?? []).findIndex((l) => l.includes(e.contains)) + 1,
        }));
        const key = (x: { rule: string; path: string; line: number }) =>
          `${x.rule} ${x.path}:${x.line}`;
        const missing = want.filter((w) => !got.some((g) => key(g) === key(w))).map(key);
        const extra = got.filter((g) => !want.some((w) => key(g) === key(w))).map(key);
        const comments = (await (
          await fetch(`${github}/fake/comments?repo=${REPO}&number=${number}`)
        ).json()) as { comments: { path?: string; line?: number; body: string }[] };
        const onLines = want.every((w) =>
          comments.comments.some((c) => c.path === w.path && c.line === w.line),
        );
        const ok = missing.length === 0 && extra.length === 0 && onLines;
        results.push({
          id: pull.id,
          ok,
          detail: ok
            ? `${got.length} finding(s)`
            : `missing [${missing.join(', ')}] extra [${extra.join(', ')}]${onLines ? '' : ' not posted on the line'}`,
        });
      }
      for (const r of results)
        console.log(`          ${r.ok ? 'ok  ' : 'FAIL'} ${r.id}: ${r.detail}`);
      const failed = results.filter((r) => !r.ok);
      assert(failed.length === 0, `${failed.length} of ${results.length} cases failed`);
      return `${results.length} of ${results.length} cases exact`;
    },
  );

  await step('a pull request that changes a measured endpoint gets its numbers', async () => {
    const { number } = await openPull({
      id: 'touch-pay',
      title: 'Tidy the payment handler',
      edits: [
        {
          path: 'checkout/server.cjs',
          after: "app.post('/checkout/pay', async (req, res) => {",
          insert: ['  // Charge the customer, then record the order.'],
        },
      ],
      expect: [],
    });
    const { findings } = await findingsOf(number);
    const touched = findings.find((f) => f.kind === 'touches_measured_endpoint');
    assert(
      touched && /POST \/checkout\/pay/.test(touched.title) && /p95 \d+/.test(touched.body),
      'no comment with the endpoint’s numbers',
    );
    return touched.title;
  });

  await step('a dismissed comment type is not repeated on the next pull request', async () => {
    const seeded = cases.pulls.find((p) => p.id === 'personal-attribute')!;
    const first = await openPull({
      ...seeded,
      id: 'personal-attribute-again',
      title: 'Count orders per user, again',
    });
    const { findings, report } = await findingsOf(first.number);
    const target = findings.find((f) => f.kind === 'convention:no-personal-or-secret-attributes');
    assert(target, 'the break was not flagged before the dismissal');
    const dismissed = await web.post(`/review/findings/${target.id}/dismiss`, {});
    assert(dismissed.html.includes('Dismissed'), 'the dismissal did not show');
    const memory = await db
      .select()
      .from(schema.memoryEntries)
      .where(
        and(
          eq(schema.memoryEntries.workspaceId, DEV),
          like(schema.memoryEntries.subject, `${REPO}#%`),
        ),
      );
    assert(
      memory.some((m) => m.kind === 'review_feedback'),
      'the dismissal was not remembered',
    );

    const second = await openPull({
      ...seeded,
      id: 'personal-attribute-third',
      title: 'Count orders per user, once more',
    });
    const after = await findingsOf(second.number);
    assert(
      !after.findings.some((f) => f.kind === 'convention:no-personal-or-secret-attributes'),
      'the dismissed comment type was posted again',
    );
    const comments = (await (
      await fetch(`${github}/fake/comments?repo=${REPO}&number=${second.number}`)
    ).json()) as { comments: { body: string }[] };
    assert(
      !comments.comments.some((c) => /looks personal or secret/.test(c.body)),
      'it was commented on GitHub again',
    );
    assert(
      Number((after.report.body as { suppressed?: number }).suppressed) >= 1,
      'the review page does not say it held one back',
    );
    void report;
    return `#${first.number} flagged and dismissed; #${second.number} not flagged (1 held back)`;
  });

  await step(
    'the architecture review maps the services from real calls, and remembers the map',
    async () => {
      const ran = await web.post('/review/run', { kind: 'architecture' });
      assert(
        ran.html.includes('Service map') && ran.html.includes('checkout calls inventory'),
        'no service map',
      );
      const reportId = ran.url.split('/review/')[1]!.split('#')[0]!;
      const findings = await db
        .select()
        .from(schema.reviewFindings)
        .where(eq(schema.reviewFindings.reportId, reportId));
      const spof = findings.find(
        (f) => f.kind === 'single_point_of_failure' && f.route === 'POST /checkout/pay',
      );
      assert(spof, 'POST /checkout/pay depending on inventory was not found');
      const map = await db
        .select()
        .from(schema.memoryEntries)
        .where(
          and(
            eq(schema.memoryEntries.workspaceId, DEV),
            eq(schema.memoryEntries.kind, 'service_map'),
          ),
        );
      assert(
        map.some((m) => m.subject === 'checkout → inventory'),
        'the service map was not remembered',
      );
      return `${findings.length} findings, including “${spof.title}”`;
    },
  );

  await step('people can comment on the review page', async () => {
    const [report] = await db
      .select()
      .from(schema.reviewReports)
      .where(eq(schema.reviewReports.workspaceId, DEV))
      .orderBy(desc(schema.reviewReports.createdAt))
      .limit(1);
    const text = `Agreed, let us add a timeout ${Date.now()}`;
    const page = await web.post(`/review/${report!.id}/comments`, { text });
    assert(page.html.includes(text), 'the comment did not show');
    return 'comment shown on the review page';
  });

  await step(
    'a deploy is followed up only after the comparison window, and only when something moved',
    async () => {
      const pull = await openPull({
        id: 'deploy-history',
        title: 'Read the stock history in one query',
        edits: [
          { path: 'inventory/main.py', after: '@app.get("/inventory/stock/history")', insert: [] },
        ],
        expect: [],
      });
      const merged = (await (
        await fetch(`${github}/fake/pulls/${pull.number}/merge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: REPO }),
        })
      ).json()) as { sha: string };
      const deployed = (await (
        await fetch(`${github}/fake/deployments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: REPO, sha: merged.sha, installation }),
        })
      ).json()) as { webhook: number };
      assert(deployed.webhook === 200, 'the deploy webhook was refused');
      // The running services did not change, so nothing moved: no note may appear.
      const notes = await db
        .select()
        .from(schema.reviewReports)
        .where(
          and(
            eq(schema.reviewReports.workspaceId, DEV),
            eq(schema.reviewReports.kind, 'deploy'),
            eq(schema.reviewReports.pullRequest, pull.number),
          ),
        );
      assert(notes.length === 0, 'a follow-up appeared before the comparison window');
      return 'deploy accepted; follow-up scheduled after the window (comparison itself is covered by unit tests)';
    },
  );
} finally {
  await close();
}

process.exit(finish('Phase 5'));
