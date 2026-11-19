/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import { PRODUCT_NAME } from '@app/config';
import { Layout, TopBar } from './layout.js';

export interface SettingsView {
  userName: string;
  isAdmin: boolean;
  alertChannel: string;
  tokens: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  shares: { id: string; dashboardTitle: string; createdAt: Date }[];
  store: { type: string; url: string } | null;
  github: string[];
  webUrl: string;
  /** Shown once, right after it is made. */
  newSecret?: { label: string; value: string; note: string };
  notice?: string;
  error?: string;
}

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : 'never');

export function SettingsPage(props: SettingsView) {
  const disabled = props.isAdmin ? undefined : true;
  return (
    <Layout title="Settings">
      <TopBar title="Settings" current="settings" userName={props.userName} />
      <main class="page">
        {!props.isAdmin ? <p class="notice">Only an admin can change these settings.</p> : null}
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
        {props.newSecret ? (
          <section class="panel" aria-labelledby="secret-title" style="border-color:var(--accent)">
            <h2 id="secret-title">{props.newSecret.label}</h2>
            <code class="query">{props.newSecret.value}</code>
            <p class="reading">{props.newSecret.note}</p>
          </section>
        ) : null}

        <section class="panel" aria-labelledby="channel-title">
          <h2 id="channel-title">Alerts</h2>
          <form
            method="post"
            action="/settings/alert-channel"
            class="field"
            style="max-width:560px"
          >
            <label for="channel">Default Slack channel for alerts made outside Slack</label>
            <input
              id="channel"
              name="channel"
              type="text"
              required
              value={props.alertChannel}
              disabled={disabled}
            />
            <p class="reading">
              A channel id such as #C0123ABC, or #name. Alerts asked for in Slack go to the channel
              they were asked in.
            </p>
            <div class="choices">
              <button class="btn" type="submit" disabled={disabled}>
                Save
              </button>
            </div>
          </form>
        </section>

        <section class="panel" aria-labelledby="tokens-title">
          <h2 id="tokens-title">API tokens</h2>
          <p class="reading">
            Read-only. Use one for the {PRODUCT_NAME} connector in Claude Code, or as a Grafana data
            source: Prometheus type, URL <code>{props.webUrl}/api/prom</code>, header{' '}
            <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
          {props.tokens.length > 0 ? (
            <table>
              <caption class="visually-hidden">API tokens</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Made</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Revoke</th>
                </tr>
              </thead>
              <tbody>
                {props.tokens.map((token) => (
                  <tr>
                    <td>{token.name}</td>
                    <td>{day(token.createdAt)}</td>
                    <td>{day(token.lastUsedAt)}</td>
                    <td>
                      <form method="post" action={`/settings/tokens/${token.id}/revoke`}>
                        <button
                          class="btn"
                          type="submit"
                          disabled={disabled}
                          aria-label={`Revoke ${token.name}`}
                        >
                          Revoke
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <form method="post" action="/settings/tokens" class="field" style="max-width:560px">
            <label for="token-name">Name of a new token</label>
            <input
              id="token-name"
              name="name"
              type="text"
              required
              placeholder="Claude Code on my laptop"
              disabled={disabled}
            />
            <div class="choices">
              <button class="btn" type="submit" disabled={disabled}>
                Make a token
              </button>
            </div>
          </form>
        </section>

        <section class="panel" aria-labelledby="shares-title">
          <h2 id="shares-title">Shared links</h2>
          {props.shares.length === 0 ? (
            <p class="empty">
              No dashboard is shared. Use Share on a dashboard to make a read-only link.
            </p>
          ) : (
            <ul style="margin:0;padding-left:20px">
              {props.shares.map((share) => (
                <li style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                  <span>
                    {share.dashboardTitle}, made {day(share.createdAt)}
                  </span>
                  <form method="post" action={`/settings/shares/${share.id}/revoke`}>
                    <button
                      class="btn"
                      type="submit"
                      aria-label={`Stop sharing ${share.dashboardTitle}`}
                    >
                      Stop sharing
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="panel" aria-labelledby="github-title">
          <h2 id="github-title">GitHub, for Review</h2>
          <p class="reading">
            {props.github.length > 0
              ? `Connected: ${props.github.join(', ')}. Review can read code and pull requests and leave comments. It never pushes commits.`
              : 'Not connected. Review needs read access to your repositories and pull requests, and permission to comment.'}
          </p>
          <form method="post" action="/github/connect">
            <button class="btn" type="submit" disabled={disabled}>
              {props.github.length > 0 ? 'Connect another account' : 'Connect GitHub'}
            </button>
          </form>
        </section>

        <section class="panel" aria-labelledby="store-title">
          <h2 id="store-title">Metrics store</h2>
          <p class="reading">
            {props.store
              ? `Reading from your own ${props.store.type} at ${props.store.url}. It is only read, never written.`
              : `Using the hosted store. You can connect a Prometheus or VictoriaMetrics you already run, read-only.`}
          </p>
          <form method="post" action="/settings/store" class="field" style="max-width:560px">
            <label for="store-type">Type</label>
            <select id="store-type" name="type" disabled={disabled}>
              <option
                value="prometheus"
                selected={props.store?.type === 'prometheus' ? true : undefined}
              >
                Prometheus
              </option>
              <option
                value="victoriametrics"
                selected={props.store?.type === 'victoriametrics' ? true : undefined}
              >
                VictoriaMetrics
              </option>
            </select>
            <label for="store-url">Query URL</label>
            <input
              id="store-url"
              name="url"
              type="text"
              placeholder="https://prometheus.example.com"
              required
              value={props.store?.url ?? ''}
              disabled={disabled}
            />
            <label for="store-token">Bearer token (optional)</label>
            <input
              id="store-token"
              name="token"
              type="password"
              autocomplete="off"
              disabled={disabled}
            />
            <div class="choices">
              <button class="btn" type="submit" disabled={disabled}>
                Test and connect
              </button>
            </div>
          </form>
          {props.store ? (
            <form method="post" action="/settings/store/remove">
              <button class="btn" type="submit" disabled={disabled}>
                Go back to the hosted store
              </button>
            </form>
          ) : null}
        </section>
      </main>
    </Layout>
  );
}
