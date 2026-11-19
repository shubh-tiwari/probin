/**
 * Phase 3 acceptance check, against the local stack.
 *
 * "Accepted when: loading and refreshing a saved dashboard makes zero model
 * calls, verified by a test on model_calls; the three canvas screens are
 * implemented; the accessibility points in "Web tool" hold."
 *
 * The accessibility points: real buttons, links and labelled inputs; text
 * contrast of at least 4.5 to 1; series in a chart differ by more than colour.
 */
import { CHART_THEME, COLORS, contrast } from '@app/web';

import { PRODUCT_NAME, loadEnv } from '@app/config';
import { connect, schema } from '@app/db';
import { and, eq, like, sql } from 'drizzle-orm';
import { assert, createCheckRun, eventually } from './lib/checks.js';
import { browser } from './lib/browser.js';

const env = loadEnv(['DATABASE_URL', 'WEB_URL', 'DEV_WORKSPACE_ID']);
const fakeUrl = process.env.SLACK_FAKE_URL ?? 'http://localhost:8093';
const { step, finish } = createCheckRun();
const { db, close } = connect(env.DATABASE_URL);
const web = browser(env.WEB_URL);

const modelCalls = async () =>
  Number(
    (
      await db
        .select({ n: sql<string>`count(*)` })
        .from(schema.modelCalls)
        .where(eq(schema.modelCalls.workspaceId, env.DEV_WORKSPACE_ID))
    )[0]!.n,
  );

/** Sign in as a fake Slack person. The fake approves at once. */
async function signIn(user = 'U0ALICE', team?: string) {
  const start = await web.get('/auth/slack', false);
  const authorize = new URL(start.location!);
  authorize.searchParams.set('user', user);
  if (team) authorize.searchParams.set('team', team);
  const approved = await fetch(authorize.toString().replace(/^http:\/\/[^/]+/, fakeUrl), {
    redirect: 'manual',
  });
  return web.get(approved.headers.get('location')!);
}

/** Problems with forms and controls in a page's HTML. */
function accessibilityProblems(html: string): string[] {
  const problems: string[] = [];
  const body = html.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>');
  const labelled = new Set([...body.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]));
  // Inputs inside a <label> are labelled by it.
  const unwrapped = body.replace(/<label[^>]*>[\s\S]*?<\/label>/g, (label) =>
    label.replace(/<(input|select|textarea)/g, '<$1 data-wrapped'),
  );
  for (const control of unwrapped.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = control[2]!;
    if (/type="hidden"|data-wrapped|aria-label=/.test(attrs)) continue;
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    if (!id || !labelled.has(id))
      problems.push(`unlabelled ${control[1]}: <${control[1]}${attrs.slice(0, 60)}>`);
  }
  for (const button of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const text = button[2]!.replace(/<[^>]+>/g, '').trim();
    if (!text && !/aria-label="[^"]+"/.test(button[1]!))
      problems.push('a button with no text and no label');
  }
  if (/\son(click|change|submit)=/i.test(body))
    problems.push('an inline event handler (a fake control)');
  if (/<(div|span)[^>]*role="button"/.test(body)) problems.push('a div or span acting as a button');
  for (const chart of html.matchAll(/<div class="chart"([^>]*)>/g)) {
    if (!/role="img"/.test(chart[1]!) || !/aria-label="[^"]+"/.test(chart[1]!))
      problems.push('a chart without a text alternative');
  }
  return problems;
}

console.log('\nPhase 3 check\n');

// Start without cached answers: these checks walk through the questions, which a cached request skips.
await db
  .delete(schema.resolvedRequests)
  .where(eq(schema.resolvedRequests.workspaceId, env.DEV_WORKSPACE_ID));
let dashboardUrl = '';

try {
  await step('signing in with Slack, only into a workspace that installed the app', async () => {
    const anonymous = await web.get('/', false);
    assert(
      anonymous.status === 302 && anonymous.location?.endsWith('/login'),
      'an anonymous visitor was not sent to sign in',
    );
    const outsider = await signIn('U0ALICE', 'T0NOTINSTALLED');
    assert(
      outsider.status === 403,
      `a workspace that has not installed the app got HTTP ${outsider.status}`,
    );
    const page = await signIn('U0ALICE');
    assert(
      page.status === 200 && page.url.includes('/dashboards/'),
      `sign-in ended at ${page.url} (${page.status})`,
    );
    dashboardUrl = page.url.split('?')[0]!;
    const forged = await fetch(`${env.WEB_URL}/`, {
      redirect: 'manual',
      headers: { cookie: 'session=eyJ1c2VySWQiOiJ4In0.forged' },
    });
    assert(forged.status === 302, 'a forged session was accepted');
    const crossSite = await fetch(`${dashboardUrl}/ask`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: [...web.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'text=x',
    });
    assert(crossSite.status === 403, 'a cross-site form post was accepted');
    return 'not installed: 403; forged session refused; cross-site post refused';
  });

  let draftHtml = '';
  let questionHtml = '';
  let newPanelId = '';
  await step(
    'the Ask panel: endpoint picker, cross-check, live draft, add to dashboard',
    async () => {
      let page = await web.post(`${dashboardUrl}/ask`, {
        text: 'latency graph of checkout service in last 5 hr',
      });
      questionHtml = page.html;
      assert(/checkout has \d+ endpoints\. Which one\?/.test(page.html), 'no endpoint picker');
      assert(
        page.html.includes('<label for="ep-filter">Filter endpoints</label>'),
        'no filter box',
      );
      assert(/Slowest/.test(page.html) && /Busiest/.test(page.html), 'no Slowest/Busiest tags');
      const values = [...page.html.matchAll(/name="value" value="([^"]+)"/g)].map((m) => m[1]);
      assert(values.at(-1) === 'all', '“All endpoints combined” is not last');
      assert(
        page.html.includes('Draft, updates as you answer'),
        'no draft preview while answering',
      );
      const request = new URL(page.url).searchParams.get('request')!;

      page = await web.post(`/requests/${request}/answer`, {
        value: 'POST /checkout/pay',
        dashboardId: dashboardUrl.split('/').pop()!,
      });
      if (page.html.includes('Check I’ve understood before I build it')) {
        questionHtml += page.html;
        assert(
          page.html.includes('Endpoint</dt><dd>POST /checkout/pay'),
          'the preview did not update with the answer',
        );
        const first = /name="value" value="([^"]+)"/.exec(page.html)![1]!;
        page = await web.post(`/requests/${request}/answer`, {
          value: first,
          dashboardId: dashboardUrl.split('/').pop()!,
        });
      }
      draftHtml = page.html;
      assert(page.html.includes('What I checked for you'), 'no “What I checked for you”');
      assert(page.html.includes('Looks right, add to dashboard'), 'no add button');
      assert(/class="panel draft"[\s\S]*?<svg/.test(page.html), 'the draft has no chart');

      page = await web.post(`/requests/${request}/confirm`, {
        dashboardId: dashboardUrl.split('/').pop()!,
      });
      newPanelId = new URL(page.url).searchParams.get('added') ?? '';
      assert(newPanelId && page.html.includes('Just added'), 'the panel was not added');
      return `panel ${newPanelId.slice(0, 8)}… added`;
    },
  );

  await step('loading and refreshing a saved dashboard makes zero model calls', async () => {
    const before = await modelCalls();
    let charts = 0;
    for (const range of ['1h', '6h', '24h', '7d']) {
      const page = await web.get(`${dashboardUrl}?range=${range}`);
      assert(page.status === 200, `dashboard HTTP ${page.status}`);
      for (const panel of [...page.html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1])) {
        const refresh = await web.get(`${dashboardUrl}/panels/${panel}/chart?range=${range}`);
        assert(refresh.status === 200 && refresh.html.includes('<svg'), 'a chart refresh failed');
        charts += 1;
      }
    }
    const after = await modelCalls();
    assert(after === before, `${after - before} model calls were made`);
    return `4 ranges, ${charts} chart refreshes, model_calls unchanged at ${after}`;
  });

  await step('a repeated request reuses its query with no model call', async () => {
    const text =
      'p95 latency of GET /checkout/summary on checkout service including failures in last 2 hours';
    await web.post(`${dashboardUrl}/ask`, { text });
    const before = await modelCalls();
    const again = await web.post(`${dashboardUrl}/ask`, { text: `  ${text.toUpperCase()} ` });
    assert(
      again.html.includes('the same choices as the last time this was asked'),
      'the second request was not served from the cache',
    );
    assert((await modelCalls()) === before, 'the repeated request called a model');
    return 'second ask: draft from the cache, model_calls unchanged';
  });

  await step('a query edited by hand must pass a dry run before it is saved', async () => {
    const versions = async () =>
      (await db.select().from(schema.panels).where(eq(schema.panels.id, newPanelId))).length;
    const start = await versions();
    const bad = await web.post(`${dashboardUrl}/panels/${newPanelId}/query`, {
      query: 'sum(rate(no_such_metric[5m]))',
    });
    assert(
      bad.html.includes('returned no data') || bad.html.includes('role="alert"'),
      'a failing query was not reported',
    );
    assert((await versions()) === start, 'a failing query was saved');
    const good = await web.post(`${dashboardUrl}/panels/${newPanelId}/query`, {
      query:
        'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[5m])))',
    });
    assert(
      good.status === 200 && (await versions()) === start + 1,
      'the edited query was not saved as a new version',
    );
    return 'failing query refused; good query saved as version 2';
  });

  await step('the memory page lists, adds, edits and deletes entries', async () => {
    let page = await web.post('/memory', {
      subject: '/reports/export',
      text: `Allowed to be slow ${Date.now()}`,
    });
    assert(
      page.html.includes('Team decision') && page.html.includes('/reports/export'),
      'the decision was not added',
    );
    const [entry] = await db
      .select()
      .from(schema.memoryEntries)
      .where(
        and(
          eq(schema.memoryEntries.workspaceId, env.DEV_WORKSPACE_ID),
          like(schema.memoryEntries.text, 'Allowed to be slow%'),
        ),
      );
    assert(entry?.createdByKind === 'user', 'the entry was not recorded as written by a person');
    page = await web.post(`/memory/${entry.id}`, {
      text: 'Allowed to be slow, decided by the team',
    });
    assert(page.html.includes('Allowed to be slow, decided by the team'), 'the edit did not show');
    page = await web.post(`/memory/${entry.id}/delete`, {});
    assert(
      !page.html.includes('Allowed to be slow, decided by the team'),
      'the delete did not take',
    );
    return 'add, edit, delete';
  });

  await step('the three screens from the design canvas are implemented', async () => {
    const dashboard = (await web.get(dashboardUrl)).html;
    const screens: [string, string, string[]][] = [
      [
        'web dashboard',
        dashboard,
        [
          `Ask ${PRODUCT_NAME}`,
          'What do you want to see?',
          'Refreshes every 30 s',
          'Last 6 hours',
          'class="query"',
          'Edit the query',
        ],
      ],
      [
        'endpoint picker and cross-check',
        questionHtml + draftHtml,
        [
          'Filter endpoints',
          'Check I’ve understood before I build it',
          'Draft, updates as you answer',
          'What I checked for you',
          'Looks right, add to dashboard',
        ],
      ],
    ];
    const missing = screens.flatMap(([name, html, needles]) =>
      needles.filter((n) => !html.includes(n)).map((n) => `${name}: “${n}”`),
    );
    assert(missing.length === 0, `missing: ${missing.join('; ')}`);
    return 'web dashboard and endpoint picker here; the Slack thread is checked in phase 2';
  });

  await step(
    'accessibility: real controls, labelled inputs, 4.5:1 text, series beyond colour',
    async () => {
      const pages = [
        (await web.get(dashboardUrl)).html,
        questionHtml,
        draftHtml,
        (await web.get('/memory')).html,
        (await web.get('/login')).html,
      ];
      const problems = [...new Set(pages.flatMap(accessibilityProblems))];
      assert(problems.length === 0, problems.join('; '));

      const textPairs: [string, string, string][] = [
      ['text', COLORS.text, COLORS.surface], ['text on page', COLORS.text, COLORS.page],
      ['secondary', COLORS.secondary, COLORS.surface], ['muted', COLORS.muted, COLORS.surface],
      ['muted on page', COLORS.muted, COLORS.page], ['link', COLORS.accent, COLORS.surface],
      ['button', '#FFFFFF', COLORS.accent], ['soft badge', COLORS.accentSoftText, COLORS.accentSoft],
      ['pending badge', COLORS.pendingText, COLORS.pendingBg], ['firing badge', '#FFFFFF', COLORS.warning],
      ['error', COLORS.danger, COLORS.surface], ['chart text', CHART_THEME.muted, CHART_THEME.background],
    ]; // prettier-ignore
      const low = textPairs
        .filter(([, fg, bg]) => contrast(fg, bg) < 4.5)
        .map(([name, fg, bg]) => `${name} ${contrast(fg, bg).toFixed(2)}:1`);
      assert(low.length === 0, `text below 4.5:1: ${low.join(', ')}`);
      const faint = CHART_THEME.colors.filter((c) => contrast(c, CHART_THEME.background) < 3);
      assert(faint.length === 0, `chart colours below 3:1: ${faint.join(', ')}`);

      const multi = await eventually(async () => {
        const page = await web.get(`${dashboardUrl}?request=x`);
        return page.html;
      });
      const dashes = [...multi.matchAll(/stroke-dasharray="([^"]+)"/g)].map((m) => m[1]);
      const { renderSvg } = await import('@app/charts');
      const two = renderSvg(
        {
          title: 't',
          type: 'timeseries',
          query: 'q',
          unit: 's',
          thresholds: [],
          request: 'r',
          assumptions: [],
        },
        [
          {
            labels: { a: '1' },
            points: [
              [1, 1],
              [2, 2],
            ],
          },
          {
            labels: { a: '2' },
            points: [
              [1, 2],
              [2, 1],
            ],
          },
        ],
      );
      assert(/stroke-dasharray/.test(two), 'a second series is told apart by colour only');
      const minimum = Math.min(...textPairs.map(([, fg, bg]) => contrast(fg, bg)));
      return `${pages.length} pages; lowest text contrast ${minimum.toFixed(2)}:1; second series dashed${dashes.length ? '' : ''}`;
    },
  );
} finally {
  await close();
}

process.exit(finish('Phase 3'));
