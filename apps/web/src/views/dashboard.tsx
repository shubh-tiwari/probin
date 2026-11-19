/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import type { AgentReply } from '@app/agent/client';
import { PRODUCT_NAME } from '@app/config';
import type { PanelSpec } from '@app/specs';
import { raw } from 'hono/html';
import { Layout, TopBar } from './layout.js';

export interface ChartView {
  /** The chart as SVG, or why there is none. */
  svg?: string;
  reading: string;
  error?: string;
}

export interface PanelView {
  id: string;
  version: number;
  spec: PanelSpec;
  chart: ChartView;
  layout: { x: number; w: number };
  /** Set when the last hand edit of the query failed. */
  editError?: string;
}

export interface AskView {
  reply: AgentReply;
  /** The draft's chart, once there is a draft. */
  chart?: ChartView;
}

export const RANGES = [
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
] as const;

export const REFRESH_SECONDS = 30;

/** A chart and its one-line reading. The reading is the image's text for screen readers. */
export function Chart(props: { chart: ChartView }) {
  if (!props.chart.svg) {
    return <p class="error">{props.chart.error ?? 'No chart.'}</p>;
  }
  return (
    <figure style="margin:0;display:flex;flex-direction:column;gap:6px">
      <div class="chart" role="img" aria-label={props.chart.reading}>
        {raw(props.chart.svg)}
      </div>
      <figcaption class="reading">{props.chart.reading}</figcaption>
    </figure>
  );
}

function Panel(props: { panel: PanelView; dashboardId: string; range: string; isNew: boolean }) {
  const { panel } = props;
  const column = `grid-column:${panel.layout.x + 1} / span ${panel.layout.w}`;
  return (
    <section
      id={`panel-${panel.id}`}
      class={`panel${props.isNew ? ' new' : ''}`}
      style={column}
      data-panel={panel.id}
      aria-labelledby={`title-${panel.id}`}
    >
      <header>
        <h2 id={`title-${panel.id}`}>{panel.spec.title}</h2>
        {props.isNew ? <span class="badge">Just added</span> : null}
      </header>
      <div data-chart>
        <Chart chart={panel.chart} />
      </div>
      <code class="query">{panel.spec.query}</code>
      {panel.spec.assumptions.length > 0 ? (
        <p class="reading">Assumed: {panel.spec.assumptions.join(' · ')}</p>
      ) : null}
      <form
        method="post"
        action={`/dashboards/${props.dashboardId}/panels/${panel.id}/refine`}
        class="field"
      >
        <label for={`change-${panel.id}`}>Change this panel</label>
        <div class="prompt">
          <input
            id={`change-${panel.id}`}
            name="text"
            type="text"
            placeholder="Split by endpoint, last 24 hours"
            required
            autocomplete="off"
          />
          <button class="btn" type="submit">
            Change
          </button>
        </div>
      </form>
      <details open={panel.editError ? true : undefined}>
        <summary>Edit the query</summary>
        <form
          method="post"
          action={`/dashboards/${props.dashboardId}/panels/${panel.id}/query`}
          class="field"
        >
          <label for={`q-${panel.id}`}>Query</label>
          <textarea id={`q-${panel.id}`} name="query" spellcheck={false}>
            {panel.spec.query}
          </textarea>
          <input type="hidden" name="range" value={props.range} />
          {panel.editError ? (
            <p class="error" role="alert">
              {panel.editError}
            </p>
          ) : null}
          <div class="choices">
            <button class="btn" type="submit">
              Test and save
            </button>
          </div>
        </form>
      </details>
    </section>
  );
}

const DECISION_LABELS = (reply: AgentReply, defaultRange: string) => {
  const { decisions, parsed } = reply.trace;
  const facts: [string, string][] = [];
  if (decisions.service)
    facts.push(['Service', decisions.service === '*' ? 'All combined' : decisions.service]);
  if (decisions.endpoint) {
    facts.push([
      'Endpoint',
      decisions.endpoint === 'all'
        ? 'All combined'
        : `${decisions.endpoint.method} ${decisions.endpoint.route}`,
    ]);
  }
  if (decisions.percentile !== undefined) facts.push(['Latency', `p${decisions.percentile}`]);
  if (decisions.requests) {
    facts.push([
      'Requests',
      {
        all: 'All, including failures',
        failed_only: 'Failed only',
        successful_only: 'Successful only',
      }[decisions.requests],
    ]);
  }
  facts.push([
    'Time range',
    parsed?.range ? `${parsed.range}, from your prompt` : `${defaultRange}, the dashboard’s range`,
  ]);
  facts.push(['Regions', 'All combined']);
  return facts;
};

/** The left column: the conversation with the agent. */
function AskPanel(props: { ask?: AskView; dashboardId: string; serviceEndpoints?: number }) {
  const reply = props.ask?.reply;
  const output = reply?.output;
  const step = reply?.trace.questionsAsked.length ?? 0;
  return (
    <aside class="ask" aria-labelledby="ask-title">
      <h2 id="ask-title">Ask {PRODUCT_NAME}</h2>
      {reply ? <p class="bubble">{reply.trace.text}</p> : null}

      {output?.kind === 'question' && output.question.kind === 'endpoint' ? (
        <form class="card" method="post" action={`/requests/${reply!.requestId}/answer`}>
          <div>
            <span class="step">Step {step}</span>
            <h3 style="display:inline">
              {reply!.trace.decisions.service ?? 'This service'} has{' '}
              {output.question.options.length - 1} endpoints. Which one?
            </h3>
          </div>
          <div class="field">
            <label for="ep-filter">Filter endpoints</label>
            <input
              id="ep-filter"
              type="text"
              placeholder="Type part of a path"
              autocomplete="off"
            />
          </div>
          <fieldset class="endpoints" data-endpoints>
            <legend class="visually-hidden">Endpoint</legend>
            {output.question.options.map((option) => (
              <label>
                <input type="radio" name="value" value={option.value} required />
                <span class="path">{option.label}</span>
                {option.tags?.map((tag) => (
                  <span class="tag">{tag}</span>
                ))}
              </label>
            ))}
          </fieldset>
          <input type="hidden" name="dashboardId" value={props.dashboardId} />
          <div class="choices">
            <button class="btn primary" type="submit">
              Continue
            </button>
          </div>
        </form>
      ) : null}

      {output?.kind === 'question' && output.question.kind === 'choice' ? (
        <form class="card" method="post" action={`/requests/${reply!.requestId}/answer`}>
          <div>
            <span class="step">Step {step}</span>
            <h3 style="display:inline">Check I’ve understood before I build it</h3>
          </div>
          <div class="field">
            <span class="label" id="q-text">
              {output.question.text}
            </span>
            <div class="choices" role="group" aria-labelledby="q-text">
              {output.question.options.map((option) => (
                <button class="btn" type="submit" name="value" value={option.value}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <input type="hidden" name="dashboardId" value={props.dashboardId} />
          <p class="reading">
            {output.questionsLeft === 0
              ? 'Last question. Anything else is a stated assumption you can change.'
              : 'At most one more question after this.'}
          </p>
        </form>
      ) : null}

      {output?.kind === 'draft' ? (
        <div class="card">
          <h3>Looks right?</h3>
          <p class="reading">The draft is on the right. Nothing is saved until you add it.</p>
          <div class="choices">
            <form method="post" action={`/requests/${reply!.requestId}/confirm`}>
              <input type="hidden" name="dashboardId" value={props.dashboardId} />
              <button class="btn primary" type="submit">
                Looks right, add to dashboard
              </button>
            </form>
            {Object.keys(reply!.rememberable).length > 0 ? (
              <form method="post" action={`/requests/${reply!.requestId}/remember`}>
                <input type="hidden" name="dashboardId" value={props.dashboardId} />
                <button class="btn" type="submit">
                  Skip questions next time
                </button>
              </form>
            ) : null}
          </div>
        </div>
      ) : null}

      {output?.kind === 'saved' ? (
        <p class="notice" role="status">
          Added to the dashboard. <a href={`#panel-${output.panelId}`}>View panel and query</a>
        </p>
      ) : null}

      {output?.kind === 'no_match' || output?.kind === 'failed' ? (
        <p class="card" role="status" style="margin:0">
          {output.message}
        </p>
      ) : null}

      <form
        method="post"
        action={`/dashboards/${props.dashboardId}/ask`}
        class="field"
        style="margin-top:auto"
      >
        <label for="prompt">What do you want to see?</label>
        <div class="prompt">
          <input
            id="prompt"
            name="text"
            type="text"
            placeholder="Signups per hour, split by plan"
            required
            autocomplete="off"
          />
          <button class="btn primary icon" type="submit" aria-label="Send prompt">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12h14"></path>
              <path d="M13 6l6 6-6 6"></path>
            </svg>
          </button>
        </div>
      </form>
    </aside>
  );
}

/** The draft preview: fills in as questions are answered, with the chart once the query is tested. */
function DraftPreview(props: { ask: AskView; defaultRange: string }) {
  const { reply } = props.ask;
  const draft = reply.output.kind === 'draft' ? reply.output.panel : undefined;
  const attempt = reply.trace.attempts.find((a) => !a.failure);
  return (
    <>
      <section class="panel draft" aria-labelledby="draft-title">
        <header>
          <h2 id="draft-title">{draft?.title ?? 'Waiting for your answers'}</h2>
          <span class="badge">Draft, updates as you answer</span>
        </header>
        {props.ask.chart ? <Chart chart={props.ask.chart} /> : null}
        <dl class="facts">
          {DECISION_LABELS(reply, props.defaultRange).map(([term, value]) => (
            <>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </>
          ))}
        </dl>
        {draft ? <code class="query">{draft.query}</code> : null}
        {draft && draft.assumptions.length > 0 ? (
          <p class="reading">Assumed: {draft.assumptions.join(' · ')}</p>
        ) : null}
      </section>
      {draft ? (
        <section class="panel" aria-labelledby="checked-title">
          <h2 id="checked-title">What I checked for you</h2>
          <ul style="margin:0;padding-left:20px;font-size:14px;color:var(--secondary)">
            <li>Every metric and label in the query is in the catalog.</li>
            <li>
              The query ran and returned {attempt?.lineCount ?? 1}{' '}
              {attempt?.lineCount === 1 ? 'line' : 'lines'}, not hundreds.
            </li>
            {draft.display_unit && draft.display_unit !== draft.unit ? (
              <li>
                The unit is {draft.unit} in the source, shown here as {draft.display_unit}.
              </li>
            ) : null}
            {reply.trace.fromUserDefaults.length > 0 ? (
              <li>Used your saved answers instead of asking.</li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function DashboardPage(props: {
  /** Every dashboard in the workspace, for the switcher. */
  dashboards?: { id: string; title: string }[];
  userName: string;
  dashboard: { id: string; title: string };
  panels: PanelView[];
  range: string;
  ask?: AskView;
  newPanelId?: string;
  defaultRange: string;
}) {
  const showPreview =
    props.ask &&
    (props.ask.reply.output.kind === 'question' || props.ask.reply.output.kind === 'draft');
  return (
    <Layout title={props.dashboard.title} scripts>
      <TopBar
        title={props.dashboard.title}
        current="dashboard"
        userName={props.userName}
        extra={
          <>
            {props.dashboards && props.dashboards.length > 1 ? (
              <form
                method="get"
                action="/dashboards/go"
                style="display:flex;gap:8px;align-items:center"
                data-switch-form
              >
                <label for="switch" class="visually-hidden">
                  Dashboard
                </label>
                <select id="switch" name="id">
                  {props.dashboards.map((d) => (
                    <option value={d.id} selected={d.id === props.dashboard.id ? true : undefined}>
                      {d.title}
                    </option>
                  ))}
                </select>
                <noscript>
                  <button class="btn" type="submit">
                    Open
                  </button>
                </noscript>
              </form>
            ) : null}
            <span class="status" data-refresh-status aria-live="polite">
              Refreshes every {REFRESH_SECONDS} s
            </span>
            <label
              class="status"
              style="display:inline-flex;align-items:center;gap:6px;min-height:44px"
            >
              <input type="checkbox" data-auto-refresh checked style="width:18px;height:18px" />{' '}
              Auto-refresh
            </label>
            <form method="post" action={`/dashboards/${props.dashboard.id}/share`}>
              <button class="btn" type="submit">
                Share
              </button>
            </form>
            <a class="btn" href={`/dashboards/${props.dashboard.id}/export/grafana`} download>
              Export to Grafana
            </a>
            <form
              method="get"
              action={`/dashboards/${props.dashboard.id}`}
              style="display:flex;gap:8px;align-items:center"
              data-range-form
            >
              <label for="range" class="visually-hidden">
                Time range
              </label>
              <select id="range" name="range">
                {RANGES.map(([value, label]) => (
                  <option value={value} selected={value === props.range ? true : undefined}>
                    {label}
                  </option>
                ))}
              </select>
              <noscript>
                <button class="btn" type="submit">
                  Show
                </button>
              </noscript>
            </form>
          </>
        }
      />
      <div class="cols">
        <AskPanel ask={props.ask} dashboardId={props.dashboard.id} />
        <main
          class="main"
          data-dashboard={props.dashboard.id}
          data-range={props.range}
          data-refresh-seconds={REFRESH_SECONDS}
        >
          {showPreview ? <DraftPreview ask={props.ask!} defaultRange={props.defaultRange} /> : null}
          {props.panels.length === 0 ? (
            <p class="empty">
              No panels yet. Ask for a chart on the left, for example “latency of checkout in the
              last 5 hours”.
            </p>
          ) : (
            <div class="grid">
              {props.panels.map((panel) => (
                <Panel
                  panel={panel}
                  dashboardId={props.dashboard.id}
                  range={props.range}
                  isNew={panel.id === props.newPanelId}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </Layout>
  );
}
