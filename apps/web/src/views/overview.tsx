/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { displayUnit, formatNumber, formatValue } from '@app/charts';
import { raw } from 'hono/html';
import { HEALTH, type Health, type Overview } from '../overview/data.js';
import { HEALTH_CLASS, HEALTH_WORD, dotPlot, flowMap, gauge } from '../overview/draw.js';
import { Layout, TopBar } from './layout.js';

const ms = displayUnit('s', 'ms');
const pct = displayUnit('1', '%');
const RANGES = [
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
] as const;

export interface AlertSummary {
  firing: string[];
  pending: string[];
  active: number;
}

function mean(points: [number, number][]) {
  return points.length ? points.reduce((sum, p) => sum + p[1], 0) / points.length : null;
}

function Metric(props: { value: string; label: string; tone?: 'bad' }) {
  return (
    <div class="ov-metric">
      <b class={props.tone === 'bad' ? 'ov-text-bad' : undefined}>{props.value}</b>
      <span>{props.label}</span>
    </div>
  );
}

function Card(props: { title: string; href?: string; children: unknown; class?: string }) {
  return (
    <section class={`ov-card ${props.class ?? ''}`}>
      <header>
        <h2>{props.title}</h2>
        {props.href ? (
          <a class="ov-open" href={props.href} aria-label={`Open ${props.title}`}>
            ↗
          </a>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

/** "1 very slow · 3 normal": the counts that are not zero, worst first. */
function caption(endpoints: { health: Health }[]) {
  const order: Health[] = ['failing', 'very_slow', 'slow', 'ok'];
  return order
    .map((h) => [h, endpoints.filter((e) => e.health === h).length] as const)
    .filter(([, n]) => n > 0)
    .map(([h, n]) => `${n} ${h === 'ok' ? 'normal' : HEALTH_WORD[h].toLowerCase()}`)
    .join(' · ');
}

function HealthBars(props: { overview: Overview }) {
  const byService = props.overview.services
    .map((service) => ({
      service,
      endpoints: props.overview.endpoints.filter((e) => e.service === service),
    }))
    .filter((s) => s.endpoints.length > 0);
  if (byService.length === 0) return <p class="empty">No endpoint traffic in this range.</p>;
  return (
    <div class="ov-health">
      {byService.map(({ service, endpoints }) => (
        <div>
          <div class="ov-health-head">
            <span>{service}</span>
            <span class="ov-muted-text">{endpoints.length} endpoints</span>
          </div>
          <div
            class="ov-segments"
            role="img"
            aria-label={endpoints
              .map((e) => `${e.method} ${e.route}: ${HEALTH_WORD[e.health]}`)
              .join('; ')}
          >
            {endpoints.map((e) => (
              <span
                class={HEALTH_CLASS[e.health]}
                title={`${e.method} ${e.route}: ${HEALTH_WORD[e.health]}`}
              ></span>
            ))}
          </div>
          <p class="ov-caption">{caption(endpoints)}</p>
        </div>
      ))}
    </div>
  );
}

function Scorecard(props: { overview: Overview }) {
  const s = props.overview.scorecard;
  const total = Math.max(1, s.normal + s.slow + s.verySlow + s.stalled);
  const rows: [string, number, string, string][] = [
    ['Normal', s.normal, 'under 0.5 s', 'ov-good'],
    ['Slow', s.slow, '0.5–1 s', 'ov-warn'],
    ['Very slow', s.verySlow, '1–2.5 s', 'ov-bad'],
    ['Stalled', s.stalled, 'over 2.5 s', 'ov-bad'],
    ['Errors', s.errors, 'status 5xx', 'ov-bad'],
  ];
  return (
    <ul class="ov-score">
      {rows.map(([name, value, band, cls]) => (
        <li>
          <span class="ov-score-name">
            {name}
            <small>{band}</small>
          </span>
          <span class="ov-score-track">
            <span
              class={cls}
              style={`width:${value > 0 ? Math.max(3, (value / total) * 100) : 0}%`}
            ></span>
          </span>
          <span class="ov-score-value">{value > 0 ? formatNumber(value) : '–'}</span>
        </li>
      ))}
    </ul>
  );
}

export function OverviewPage(props: {
  userName: string;
  overview: Overview;
  alerts: AlertSummary;
}) {
  const { overview, alerts } = props;
  const flow = flowMap(overview);
  const avgLatency = mean(overview.latency);
  const peakLatency = overview.latency.length
    ? Math.max(...overview.latency.map((p) => p[1]))
    : null;
  const errorRatio =
    overview.totals.requests > 0 ? overview.totals.errors / overview.totals.requests : 0;
  const rangeLabel = RANGES.find(([r]) => r === overview.range)?.[1] ?? overview.range;
  return (
    <Layout title="Overview">
      <TopBar title="Overview" current="overview" userName={props.userName} />
      <main class="ov">
        <div class="ov-head">
          <div>
            <h2 class="ov-title">Production</h2>
            <p class="ov-sub">
              {rangeLabel} · {overview.services.length} services · {overview.endpoints.length}{' '}
              endpoints, from the metrics your services send
            </p>
          </div>
          <nav class="ov-ranges" aria-label="Time range">
            {RANGES.map(([value, label]) => (
              <a
                href={`/overview?range=${value}`}
                aria-current={value === overview.range ? 'page' : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
        </div>

        <div class="ov-grid">
          <div class="ov-main">
            <Card title="Request flow" class="ov-flow">
              <ul class="ov-legend" aria-label="Colours">
                <li>
                  <i class="ov-good"></i>Normal
                </li>
                <li>
                  <i class="ov-warn"></i>Slow (p95 ≥ {formatValue(HEALTH.slow, ms)} or ≥{' '}
                  {formatValue(HEALTH.erroring, pct)} failed)
                </li>
                <li>
                  <i class="ov-bad"></i>Very slow or failing
                </li>
              </ul>
              {raw(flow.svg)}
            </Card>

            <div class="ov-kpis">
              <Card title="Load">
                <div class="ov-metrics">
                  <Metric value={formatNumber(overview.totals.requests)} label="requests" />
                  <Metric value={formatNumber(overview.totals.perMinute)} label="per minute" />
                </div>
                {raw(dotPlot(overview.load, { label: (v) => `${formatNumber(v)}/min` }))}
              </Card>
              <Card title="Response time">
                <div class="ov-metrics">
                  <Metric
                    value={avgLatency !== null ? formatValue(avgLatency, ms) : '–'}
                    label="p95, average"
                  />
                  <Metric
                    value={peakLatency !== null ? formatValue(peakLatency, ms) : '–'}
                    label="p95, highest"
                    {...(peakLatency !== null && peakLatency >= HEALTH.slow
                      ? { tone: 'bad' as const }
                      : {})}
                  />
                </div>
                {raw(
                  dotPlot(overview.latency, {
                    label: (v) => formatValue(v, ms),
                    threshold: HEALTH.slow,
                  }),
                )}
              </Card>
              <Card title="Errors" href="/alerts">
                <div class="ov-metrics">
                  <Metric value={formatValue(errorRatio, pct)} label="of requests" />
                  <Metric value={formatNumber(overview.totals.errors)} label="errors" tone="bad" />
                  <Metric
                    value={formatNumber(overview.totals.errorsPerMinute)}
                    label="per minute"
                  />
                </div>
                {raw(gauge(errorRatio))}
              </Card>
            </div>
          </div>

          <aside class="ov-side">
            <Card title="Alerts" href="/alerts">
              <div class="ov-metrics">
                <Metric
                  value={String(alerts.firing.length)}
                  label="firing"
                  {...(alerts.firing.length ? { tone: 'bad' as const } : {})}
                />
                <Metric value={String(alerts.pending.length)} label="waiting for approval" />
                <Metric value={String(alerts.active)} label="watching" />
              </div>
              <ul class="ov-list">
                {[
                  ...alerts.firing.map((n) => [n, 'ov-bad'] as const),
                  ...alerts.pending.map((n) => [n, 'ov-warn'] as const),
                ]
                  .slice(0, 4)
                  .map(([name, cls]) => (
                    <li>
                      <i class={cls}></i>
                      {name}
                    </li>
                  ))}
              </ul>
            </Card>
            <Card title="Endpoint health">
              <HealthBars overview={overview} />
            </Card>
            <Card title="Request scorecard">
              <Scorecard overview={overview} />
            </Card>
          </aside>
        </div>
      </main>
    </Layout>
  );
}
