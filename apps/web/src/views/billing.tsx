/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import type { Plan } from '@app/config';
import type { Invoice } from '../billing.js';
import { Layout, TopBar } from './layout.js';

export interface BillingView {
  userName: string;
  isAdmin: boolean;
  enabled: boolean;
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  deletionScheduledAt: Date | null;
  usage: {
    plan: Plan | undefined;
    currency: string;
    activeSeries: number | null;
    seriesLimit: number | null;
    modelSpend: number;
    modelBudget: number | null;
    retentionDays: number | null;
  };
  invoices: Invoice[];
  notice?: string;
  error?: string;
}

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : '—');
const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

/** A bar with its numbers written out, so it reads without the bar. */
function Meter(props: {
  label: string;
  used: number | null;
  limit: number | null;
  format: (n: number) => string;
}) {
  const share = props.used !== null && props.limit ? Math.min(1, props.used / props.limit) : 0;
  return (
    <div class="field">
      <span class="label">{props.label}</span>
      <div
        aria-hidden="true"
        style="height:10px;border-radius:999px;background:var(--divider);overflow:hidden"
      >
        <div
          style={`height:100%;width:${(share * 100).toFixed(1)}%;background:${share >= 0.9 ? 'var(--warning)' : 'var(--accent)'}`}
        ></div>
      </div>
      <span class="reading">
        {props.used === null ? 'Not available' : props.format(props.used)}
        {props.limit !== null ? ` of ${props.format(props.limit)} included` : ''}
      </span>
    </div>
  );
}

export function BillingPage(props: BillingView) {
  const statusText: Record<string, string> = {
    trialing: `Free trial, ends ${day(props.trialEndsAt)}`,
    active: `Subscribed${props.currentPeriodEnd ? `, renews ${day(props.currentPeriodEnd)}` : ''}`,
    past_due: 'A payment failed. Update the card in the billing portal.',
    canceled: `Cancelled. The workspace's data is deleted on ${day(props.deletionScheduledAt)}.`,
  };
  const { usage } = props;
  return (
    <Layout title="Billing">
      <TopBar title="Billing" current="settings" userName={props.userName} />
      <main class="page">
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
        <section class="panel" aria-labelledby="plan-title">
          <h2 id="plan-title">Plan</h2>
          <dl class="facts">
            <dt>Plan</dt>
            <dd>
              {usage.plan
                ? `${usage.plan.name}, ${money(usage.plan.price_monthly, usage.currency)} a month per workspace`
                : 'Unknown'}
            </dd>
            <dt>Status</dt>
            <dd>{statusText[props.status] ?? props.status}</dd>
            <dt>Keeps data for</dt>
            <dd>{usage.retentionDays ? `${usage.retentionDays} days` : '—'}</dd>
          </dl>
          {props.isAdmin && props.enabled ? (
            <div class="choices">
              {props.status === 'trialing' || props.status === 'canceled' ? (
                <form method="post" action="/billing/checkout">
                  <button class="btn primary" type="submit">
                    Subscribe
                  </button>
                </form>
              ) : null}
              {props.status !== 'canceled' ? (
                <form method="post" action="/billing/cancel">
                  <button class="btn" type="submit">
                    Cancel subscription
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
          {!props.enabled ? (
            <p class="reading">Billing is not set up on this installation.</p>
          ) : null}
          {props.status !== 'canceled' ? (
            <p class="reading">
              Cancelling stops billing at once. Dashboards keep working for a grace period, then the
              workspace’s metrics, dashboards, alerts and memory are deleted. Download an export
              first.
            </p>
          ) : null}
          <p>
            <a class="btn" href="/billing/export">
              Download an export (JSON)
            </a>{' '}
            <a class="btn" href="/billing/export/metrics">
              Download metrics (JSON lines)
            </a>
          </p>
        </section>

        {props.isAdmin ? (
          <section class="panel" aria-labelledby="usage-title">
            <h2 id="usage-title">Usage this month</h2>
            <Meter
              label="Metrics stored (active series)"
              used={usage.activeSeries}
              limit={usage.seriesLimit}
              format={(n) => Math.round(n).toLocaleString('en')}
            />
            <Meter
              label="Model usage"
              used={usage.modelSpend}
              limit={usage.modelBudget}
              format={(n) => money(n, usage.currency)}
            />
            <p class="reading">
              Near the model budget, cheaper models are used. At the budget, building new panels
              pauses; dashboards and alerts keep working.
            </p>
          </section>
        ) : null}

        {props.isAdmin && props.invoices.length > 0 ? (
          <section class="panel" aria-labelledby="invoices-title">
            <h2 id="invoices-title">Invoices</h2>
            <table>
              <caption class="visually-hidden">Invoices</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Invoice</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {props.invoices.map((invoice) => (
                  <tr>
                    <td>{day(invoice.date)}</td>
                    <td>
                      {invoice.url ? <a href={invoice.url}>{invoice.number}</a> : invoice.number}
                    </td>
                    <td>{money(invoice.amount, invoice.currency)}</td>
                    <td>{invoice.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </main>
    </Layout>
  );
}
