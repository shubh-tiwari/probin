/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { PRODUCT_NAME } from '@app/config';
import { Chart, RANGES, REFRESH_SECONDS, type PanelView } from './dashboard.js';
import { Layout } from './layout.js';

/** A dashboard behind a share link: read-only, no Ask panel, no editing. */
export function SharedPage(props: {
  title: string;
  token: string;
  panels: PanelView[];
  range: string;
}) {
  return (
    <Layout title={props.title} scripts>
      <header class="top">
        <span class="brand">{PRODUCT_NAME}</span>
        <h1>{props.title}</h1>
        <span class="status" data-refresh-status aria-live="polite">
          Read-only link · refreshes every {REFRESH_SECONDS} s
        </span>
        <form
          method="get"
          action={`/share/${props.token}`}
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
      </header>
      <main
        class="main"
        data-share={props.token}
        data-range={props.range}
        data-refresh-seconds={REFRESH_SECONDS}
      >
        <div class="grid">
          {props.panels.map((panel) => (
            <section
              class="panel"
              style={`grid-column:${panel.layout.x + 1} / span ${panel.layout.w}`}
              data-panel={panel.id}
              aria-labelledby={`t-${panel.id}`}
            >
              <header>
                <h2 id={`t-${panel.id}`}>{panel.spec.title}</h2>
              </header>
              <div data-chart>
                <Chart chart={panel.chart} />
              </div>
              <code class="query">{panel.spec.query}</code>
            </section>
          ))}
        </div>
      </main>
    </Layout>
  );
}

/** Shown once, right after a share link is made. */
export function ShareMadePage(props: { link: string; dashboardId: string }) {
  return (
    <Layout title="Shared">
      <main class="page">
        <span class="brand">{PRODUCT_NAME}</span>
        <h1>Read-only link</h1>
        <p>
          Anyone with this link can see this dashboard, but not change it or ask anything. It is
          shown once. You can stop sharing in Settings.
        </p>
        <code class="query">{props.link}</code>
        <p>
          <a class="btn primary" href={`/dashboards/${props.dashboardId}`}>
            Back to the dashboard
          </a>
        </p>
      </main>
    </Layout>
  );
}
