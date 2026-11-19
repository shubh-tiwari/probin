/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { raw } from 'hono/html';
import { Layout, TopBar } from './layout.js';

export interface ReportSummary {
  id: string;
  kind: string;
  title: string;
  repository: string;
  createdAt: Date;
  findings: number;
  open: number;
}

export interface FindingView {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  evidence: {
    metric: string;
    window: string;
    query?: string;
    values?: Record<string, unknown>;
    rule?: string;
  };
  path: string | null;
  line: number | null;
  externalUrl: string | null;
  comments: { author: string; text: string; at: Date }[];
}

const KIND: Record<string, string> = {
  bottleneck: 'Bottleneck report',
  architecture: 'Architecture review',
  pull_request: 'Pull request review',
  deploy: 'After a deploy',
};
const day = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16);

export function ReviewListPage(props: {
  userName: string;
  reports: ReportSummary[];
  connected: string[];
  notice?: string;
  error?: string;
}) {
  return (
    <Layout title="Review">
      <TopBar title="Review" current="review" userName={props.userName} />
      <main class="page">
        <p style="margin:0;color:var(--secondary)">
          Review reads your code and live metrics. It finds bottlenecks, comments on pull requests,
          follows up after deploys and reviews your architecture. It never pushes commits.
        </p>
        {props.notice ? (
          <p class="notice" role="status">
            {props.notice}
          </p>
        ) : null}
        {props.error ? (
          <p class="error" role="alert">
            {props.error}
          </p>
        ) : null}
        {props.connected.length === 0 ? (
          <p class="notice">
            GitHub is not connected. Connect it in <a href="/settings">Settings</a>.
          </p>
        ) : (
          <div class="choices">
            <form method="post" action="/review/run">
              <input type="hidden" name="kind" value="bottleneck" />
              <button class="btn primary" type="submit">
                Run the bottleneck report
              </button>
            </form>
            <form method="post" action="/review/run">
              <input type="hidden" name="kind" value="architecture" />
              <button class="btn" type="submit">
                Review the architecture
              </button>
            </form>
            <span class="status">Connected: {props.connected.join(', ')}</span>
          </div>
        )}
        {props.reports.length === 0 ? (
          <p class="empty">No reviews yet.</p>
        ) : (
          <table>
            <caption class="visually-hidden">Reviews</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Review</th>
                <th scope="col">Findings</th>
              </tr>
            </thead>
            <tbody>
              {props.reports.map((r) => (
                <tr>
                  <td>{day(r.createdAt)} UTC</td>
                  <td>
                    <a href={`/review/${r.id}`}>{r.title}</a>
                    <br />
                    <span class="status">{KIND[r.kind] ?? r.kind}</span>
                  </td>
                  <td>
                    {r.findings} ({r.open} open)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </Layout>
  );
}

/** The service map as a simple left-to-right diagram, with every edge also listed in text. */
function ServiceMap(props: {
  map: { services: string[]; edges: { from: string; to: string; rate: number }[] };
}) {
  const { services, edges } = props.map;
  const callers = new Set(edges.map((e) => e.from));
  const order = [...services].sort((a, b) => Number(callers.has(b)) - Number(callers.has(a)));
  const width = 160;
  const gap = 120;
  const x = (s: string) => 20 + order.indexOf(s) * (width + gap);
  const svgWidth = 40 + order.length * width + (order.length - 1) * gap;
  const svg = `<svg viewBox="0 0 ${svgWidth} 120" width="100%" style="max-width:${svgWidth}px" aria-hidden="true" font-family="Inter, system-ui, sans-serif">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#3B4252"/></marker></defs>
    ${order.map((s) => `<rect x="${x(s)}" y="40" width="${width}" height="44" rx="8" fill="#FFFFFF" stroke="#1F5FD0" stroke-width="1.5"/><text x="${x(s) + width / 2}" y="67" text-anchor="middle" font-size="14" fill="#1B1F27">${s}</text>`).join('')}
    ${edges.map((e) => `<line x1="${x(e.from) + width}" y1="62" x2="${x(e.to) - 4}" y2="62" stroke="#3B4252" stroke-width="1.5" marker-end="url(#arrow)"/><text x="${(x(e.from) + width + x(e.to)) / 2}" y="54" text-anchor="middle" font-size="12" fill="#3B4252">${e.rate.toFixed(2)}/s</text>`).join('')}
  </svg>`;
  return (
    <figure style="margin:0;display:flex;flex-direction:column;gap:8px">
      {raw(svg)}
      <figcaption>
        <ul style="margin:0;padding-left:20px;font-size:14px">
          {edges.length === 0 ? (
            <li>No calls between services were seen.</li>
          ) : (
            edges.map((e) => (
              <li>
                {e.from} calls {e.to}, {e.rate.toFixed(2)} calls per second
              </li>
            ))
          )}
        </ul>
      </figcaption>
    </figure>
  );
}

export function ReviewReportPage(props: {
  userName: string;
  report: {
    id: string;
    kind: string;
    title: string;
    repository: string;
    createdAt: Date;
    body: Record<string, unknown>;
  };
  findings: FindingView[];
  reportComments: { author: string; text: string; at: Date }[];
}) {
  const { report } = props;
  const map = report.body.map as
    { services: string[]; edges: { from: string; to: string; rate: number }[] } | undefined;
  const suppressed = Number(report.body.suppressed ?? 0);
  return (
    <Layout title={report.title}>
      <TopBar title="Review" current="review" userName={props.userName} />
      <main class="page">
        <p class="status" style="margin:0">
          <a href="/review">All reviews</a> · {KIND[report.kind] ?? report.kind} ·{' '}
          {day(report.createdAt)} UTC
        </p>
        <h1 style="font-size:20px">{report.title}</h1>
        {map ? (
          <section class="panel" aria-labelledby="map-title">
            <h2 id="map-title">Service map</h2>
            <ServiceMap map={map} />
          </section>
        ) : null}
        {suppressed > 0 ? (
          <p class="reading">
            {suppressed} finding{suppressed === 1 ? ' was' : 's were'} not posted, because people
            dismissed that kind of comment on this repository before.
          </p>
        ) : null}
        {props.findings.length === 0 ? <p class="empty">Nothing to report.</p> : null}
        {props.findings.map((f) => (
          <article id={`f-${f.id}`} class="panel" aria-labelledby={`ft-${f.id}`}>
            <header>
              <h2 id={`ft-${f.id}`}>{f.title}</h2>
              <span class={`badge${f.status === 'open' ? '' : ' ok'}`}>
                {f.status === 'open' ? 'Open' : f.status === 'accepted' ? 'Accepted' : 'Dismissed'}
              </span>
            </header>
            {f.body.split('\n\n').map((paragraph) => (
              <p style="margin:0">{paragraph.replace(/`/g, '')}</p>
            ))}
            <dl class="facts">
              <dt>Based on</dt>
              <dd>
                {f.evidence.metric},{' '}
                {/^\d/.test(f.evidence.window)
                  ? `the last ${f.evidence.window}`
                  : f.evidence.window}
              </dd>
              {f.path ? (
                <>
                  <dt>Code</dt>
                  <dd>
                    <code>
                      {f.path}
                      {f.line ? `:${f.line}` : ''}
                    </code>
                  </dd>
                </>
              ) : null}
              {f.externalUrl ? (
                <>
                  <dt>On GitHub</dt>
                  <dd>
                    <a href={f.externalUrl}>The comment</a>
                  </dd>
                </>
              ) : null}
            </dl>
            {f.evidence.query ? <code class="query">{f.evidence.query}</code> : null}
            {f.status === 'open' ? (
              <div class="choices">
                <form method="post" action={`/review/findings/${f.id}/accept`}>
                  <button class="btn" type="submit">
                    Accept
                  </button>
                </form>
                <form method="post" action={`/review/findings/${f.id}/dismiss`}>
                  <button class="btn" type="submit">
                    Dismiss: not useful
                  </button>
                </form>
              </div>
            ) : null}
            {f.comments.map((c) => (
              <p class="reading" style="border-left:3px solid var(--border);padding-left:10px">
                <strong>{c.author}</strong>: {c.text}
              </p>
            ))}
            <form method="post" action={`/review/${report.id}/comments`} class="field">
              <input type="hidden" name="findingId" value={f.id} />
              <label for={`c-${f.id}`}>Comment on this finding</label>
              <div class="prompt">
                <input id={`c-${f.id}`} name="text" type="text" required />
                <button class="btn" type="submit">
                  Comment
                </button>
              </div>
            </form>
          </article>
        ))}
        <section class="panel" aria-labelledby="discussion-title">
          <h2 id="discussion-title">Discussion</h2>
          {props.reportComments.length === 0 ? (
            <p class="empty">No comments yet.</p>
          ) : (
            props.reportComments.map((c) => (
              <p style="margin:0">
                <strong>{c.author}</strong>: {c.text}
              </p>
            ))
          )}
          <form method="post" action={`/review/${report.id}/comments`} class="field">
            <label for="report-comment">Comment on this review</label>
            <div class="prompt">
              <input id="report-comment" name="text" type="text" required />
              <button class="btn" type="submit">
                Comment
              </button>
            </div>
          </form>
        </section>
      </main>
    </Layout>
  );
}
