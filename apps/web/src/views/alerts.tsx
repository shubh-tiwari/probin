/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { displayUnit, formatValue } from '@app/charts';
import type { StoredCollector, StoredRule } from '@app/db';
import { Layout, TopBar } from './layout.js';

export interface RuleRow {
  rule: StoredRule;
  /** From the alert engine: firing, or not. */
  firing: boolean;
  value: number | null;
  approverName?: string;
}

const channelText = (channel: string) =>
  /^#[CGD][A-Z0-9]{2,}$/.test(channel) ? `Slack channel ${channel.slice(1)}` : channel;

function status(row: RuleRow) {
  if (row.rule.spec.status === 'pending')
    return <span class="badge pending">Pending approval</span>;
  if (row.rule.spec.status === 'disabled') return <span class="badge ok">Off</span>;
  return row.firing ? <span class="badge firing">Firing</span> : <span class="badge ok">OK</span>;
}

export function AlertsPage(props: { userName: string; rows: RuleRow[]; notice?: string }) {
  const order = (r: RuleRow) =>
    r.firing ? 0 : r.rule.spec.status === 'pending' ? 1 : r.rule.spec.status === 'active' ? 2 : 3;
  const rows = [...props.rows].sort((a, b) => order(a) - order(b));
  return (
    <Layout title="Alerts">
      <TopBar title="Alerts" current="alerts" userName={props.userName} />
      <main class="page">
        <p style="margin:0;color:var(--secondary)">
          A rule does nothing until someone approves it. Editing a rule sends it back for approval.
        </p>
        {props.notice ? (
          <p class="notice" role="status">
            {props.notice}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p class="empty">
            No alert rules yet. Ask for one: “alert me if checkout p95 goes above 800 ms for 5 min”.
          </p>
        ) : (
          <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px">
            {rows.map((row) => {
              const { spec } = row.rule;
              const unit = displayUnit(spec.unit ?? '', spec.display_unit);
              return (
                <li class="panel">
                  <header>
                    <h2>{spec.name}</h2>
                    {status(row)}
                  </header>
                  <dl class="facts">
                    <dt>For</dt>
                    <dd>{spec.for}</dd>
                    <dt>Notify</dt>
                    <dd>{channelText(spec.channel)}</dd>
                    {row.firing && row.value !== null ? (
                      <>
                        <dt>Now</dt>
                        <dd>{formatValue(row.value, unit)}</dd>
                      </>
                    ) : null}
                    {row.rule.approvedBy ? (
                      <>
                        <dt>Approved by</dt>
                        <dd>{row.approverName ?? 'a member'}</dd>
                      </>
                    ) : null}
                  </dl>
                  <code class="query">{spec.expr}</code>
                  {spec.assumptions?.length ? (
                    <p class="reading">Assumed: {spec.assumptions.join(' · ')}</p>
                  ) : null}
                  <div class="choices">
                    {spec.status === 'pending' ? (
                      <form method="post" action={`/alerts/${row.rule.id}/approve`}>
                        <button class="btn primary" type="submit">
                          Approve
                        </button>
                      </form>
                    ) : null}
                    {spec.status !== 'disabled' ? (
                      <a class="btn" href={`/alerts/${row.rule.id}`}>
                        Edit
                      </a>
                    ) : null}
                    {spec.status !== 'disabled' ? (
                      <form method="post" action={`/alerts/${row.rule.id}/discard`}>
                        <button class="btn" type="submit">
                          {spec.status === 'pending' ? 'Discard' : 'Switch off'}
                        </button>
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </Layout>
  );
}

/** Edit a rule's threshold, duration and channel. Saving makes it pending again. */
export function AlertEditPage(props: { userName: string; rule: StoredRule; error?: string }) {
  const { spec } = props.rule;
  const shown =
    spec.unit === 's' && spec.display_unit === 'ms'
      ? 1000
      : spec.unit === '1' && spec.display_unit === '%'
        ? 100
        : 1;
  const unitLabel = spec.display_unit ?? spec.unit ?? '';
  return (
    <Layout title="Edit alert">
      <TopBar title="Edit alert" current="alerts" userName={props.userName} />
      <main class="page">
        <h2 style="font-size:18px">{spec.name}</h2>
        {props.error ? (
          <p class="error" role="alert">
            {props.error}
          </p>
        ) : null}
        <form
          method="post"
          action={`/alerts/${props.rule.id}/edit`}
          class="panel field"
          style="max-width:560px"
        >
          {spec.comparison ? (
            <>
              <label for="op">Fires when the value is</label>
              <select id="op" name="op">
                <option value=">" selected={spec.comparison.op === '>' ? true : undefined}>
                  above
                </option>
                <option value="<" selected={spec.comparison.op === '<' ? true : undefined}>
                  below
                </option>
              </select>
              <label for="threshold">Threshold{unitLabel ? ` (${unitLabel})` : ''}</label>
              <input
                id="threshold"
                name="threshold"
                type="text"
                inputmode="decimal"
                required
                value={String(Number((spec.comparison.threshold * shown).toPrecision(6)))}
              />
              <input type="hidden" name="scale" value={String(shown)} />
            </>
          ) : null}
          <label for="for">For at least (e.g. 5m)</label>
          <input id="for" name="for" type="text" required value={spec.for} />
          <label for="channel">Notify (a Slack channel id such as #C0123, or #name)</label>
          <input id="channel" name="channel" type="text" required value={spec.channel} />
          <p class="reading">
            Saving sends the rule back for approval. Until it is approved again, it is not watched.
          </p>
          <div class="choices">
            <button class="btn primary" type="submit">
              Save
            </button>
            <a class="btn" href="/alerts">
              Cancel
            </a>
          </div>
        </form>
      </main>
    </Layout>
  );
}

export interface CollectorRow {
  collector: StoredCollector;
  lastRunAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
}

export function CollectorsPage(props: { userName: string; rows: CollectorRow[]; notice?: string }) {
  return (
    <Layout title="Data sources">
      <TopBar title="Data sources" current="collectors" userName={props.userName} />
      <main class="page">
        <p style="margin:0;color:var(--secondary)">
          Collectors check a URL on an interval. A collector does nothing until someone approves it.
        </p>
        {props.notice ? (
          <p class="notice" role="status">
            {props.notice}
          </p>
        ) : null}
        {props.rows.length === 0 ? (
          <p class="empty">
            No data sources yet. Ask for one: “monitor https://example.com/health every minute”.
          </p>
        ) : (
          <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px">
            {props.rows.map(({ collector, lastRunAt, lastStatus, lastError }) => (
              <li class="panel">
                <header>
                  <h2>{collector.spec.name}</h2>
                  {collector.spec.status === 'pending' ? (
                    <span class="badge pending">Pending approval</span>
                  ) : collector.spec.status === 'active' ? (
                    <span class="badge ok">Running</span>
                  ) : (
                    <span class="badge ok">Off</span>
                  )}
                </header>
                <dl class="facts">
                  <dt>URL</dt>
                  <dd style="overflow-wrap:anywhere">{String(collector.spec.config.url ?? '')}</dd>
                  <dt>Every</dt>
                  <dd>{collector.spec.interval}</dd>
                  <dt>Metrics</dt>
                  <dd>{collector.spec.metric_names.join(', ')}</dd>
                  <dt>Last check</dt>
                  <dd>
                    {lastRunAt
                      ? `${lastRunAt.toISOString().replace('T', ' ').slice(0, 19)} UTC, ${lastError ?? (lastStatus ? `HTTP ${lastStatus}` : 'no answer')}`
                      : 'Not run yet'}
                  </dd>
                </dl>
                <div class="choices">
                  {collector.spec.status === 'pending' ? (
                    <form method="post" action={`/collectors/${collector.id}/approve`}>
                      <button class="btn primary" type="submit">
                        Approve
                      </button>
                    </form>
                  ) : null}
                  {collector.spec.status !== 'disabled' ? (
                    <a class="btn" href={`/collectors/${collector.id}`}>
                      Edit
                    </a>
                  ) : null}
                  {collector.spec.status !== 'disabled' ? (
                    <form method="post" action={`/collectors/${collector.id}/discard`}>
                      <button class="btn" type="submit">
                        {collector.spec.status === 'pending' ? 'Discard' : 'Switch off'}
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </Layout>
  );
}

export function CollectorEditPage(props: {
  userName: string;
  collector: StoredCollector;
  error?: string;
}) {
  const { spec } = props.collector;
  return (
    <Layout title="Edit data source">
      <TopBar title="Edit data source" current="collectors" userName={props.userName} />
      <main class="page">
        {props.error ? (
          <p class="error" role="alert">
            {props.error}
          </p>
        ) : null}
        <form
          method="post"
          action={`/collectors/${props.collector.id}/edit`}
          class="panel field"
          style="max-width:560px"
        >
          <label for="url">URL</label>
          <input id="url" name="url" type="text" required value={String(spec.config.url ?? '')} />
          <label for="interval">Every (e.g. 1m, at least 30s)</label>
          <input id="interval" name="interval" type="text" required value={spec.interval} />
          <p class="reading">Saving sends the data source back for approval.</p>
          <div class="choices">
            <button class="btn primary" type="submit">
              Save
            </button>
            <a class="btn" href="/collectors">
              Cancel
            </a>
          </div>
        </form>
      </main>
    </Layout>
  );
}
