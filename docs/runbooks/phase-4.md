# Runbook: phase 4, alerts, data sources and the paid product

What phase 4 added and how to run it. The earlier runbooks still apply.

## What was built

| Piece                                                                                                                     | Where                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Alerts from a request (“alert me if … above 800 ms for 5 min”) or from a chart (“Alert me on this”), always pending first | `apps/agent/src/loop.ts`, `packages/db/src/alert-store.ts`             |
| Pending rule cards with Approve, Edit, Discard, in Slack and on the web Alerts page                                       | `apps/slack/src/alert-messages.ts`, `apps/web/src/views/alerts.tsx`    |
| The alert engine: evaluates approved rules only, every 15 s, through the Query API; posts firing and resolved messages    | `apps/alerts/`                                                         |
| Why did this happen? (a labelled hypothesis with its charts), Snooze 1 hour, Acknowledge; incidents in memory             | `apps/agent/src/explain*.ts`, `apps/slack/src/conversation.ts`         |
| Data sources: “monitor <URL> every minute”, a test fetch, a pending card, then a runner                                   | `apps/ingest/src/http-check.ts`, `apps/ingest/src/collector-runner.ts` |
| Starter dashboard and two suggested (pending) alerts when a service first sends data                                      | `apps/ingest/src/starter.ts`                                           |
| Change a chart: a follow-up in the Slack thread (S7), or “Change this panel” on the web (W6)                              | `seedRefinement` in `apps/agent/src/loop.ts`                           |
| Share a dashboard by read-only link (W9); export it to Grafana (W12)                                                      | `apps/web/src/tokens.ts`, `apps/web/src/grafana.ts`                    |
| Billing with Stripe (H5), usage (H6), retention, export and deletion on cancel (H7)                                       | `apps/web/src/billing.ts`, `apps/ingest/src/deletion.ts`               |
| Read from a store the customer already runs (H8)                                                                          | `apps/query-api/src/workspace-stores.ts`, Settings page                |
| Read-only API tokens; a Prometheus-compatible API for Grafana; the connector for Claude Code (K6)                         | `apps/web/src/app.tsx` (`/api`), `apps/connector/`                     |
| A fake Stripe for development                                                                                             | `apps/web/src/fake/stripe.ts`                                          |
| Acceptance check                                                                                                          | `scripts/verify-phase4.ts`                                             |

## The rules, and where they are enforced

- **Approval before effect.** The engine loads only rules whose latest version is active; the collector runner only active collectors. A database check forbids an active rule without a recorded approver. Editing a rule or collector makes it pending again.
- **No model on refresh.** The engine evaluates saved expressions through the Query API. Only “Why did this happen?” calls a model, and only when someone presses it.
- **Explanations are hypotheses.** The text always starts “Hypothesis:” (added in code if the model leaves it out) and is posted with the charts it rests on.
- **Collectors cannot reach our network.** The URL check refuses loopback, link-local (including cloud metadata) and, outside local development, every private address. It does not follow redirects. It runs again on every fetch.

## Using it locally

- In the fake Slack, mention `alert me if p95 latency of POST /checkout/pay on checkout service goes above 300 ms for 1 minute`, then press Approve on the card. Firing and resolved messages arrive in the same channel.
- `monitor http://demo-checkout:8080/checkout/summary every 30 seconds`, then Approve. The results appear as `http_check_up_ratio` and `http_check_duration_seconds` under the `checks` service.
- Web: **Alerts**, **Data sources**, **Settings** (alert channel, API tokens, shared links, your own store), **Billing**.
- Connector for Claude Code: make a token in Settings, then
  `claude mcp add metrics -e METRICS_API_URL=http://localhost:8094 -e METRICS_API_TOKEN=<token> -- node --import tsx apps/connector/src/main.ts`
- Grafana: add a Prometheus data source with URL `<web>/api/prom` and header `Authorization: Bearer <token>`, then import an exported dashboard.

## Billing

In development the web tool talks to a fake Stripe (port 8095): Subscribe goes to a checkout page that pays at once and sends Stripe's webhooks. `DELETION_GRACE_SECONDS=20` in `.env` makes a cancelled workspace's data go after 20 seconds instead of the plan's grace period.

For real Stripe:

1. Create a product and a monthly price per plan; put each price id in the plans file as `stripe_price`.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_API_URL=https://api.stripe.com`, and `STRIPE_WEBHOOK_SECRET` from a webhook endpoint pointing at `<web>/billing/webhook` with the events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
3. Remove `DELETION_GRACE_SECONDS`.

## When something is wrong

| Symptom                                     | Likely cause                                                                               | Fix                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| An approved rule never fires                | Its condition is not true for the whole duration, or the engine cannot reach the Query API | `curl` the alerts service's `/healthz` from inside the network; it shows the last evaluation |
| A firing message never arrives              | The workspace's Slack installation is missing, or the bot is not in the channel            | Check the alerts service's log for “notify” lines                                            |
| “Why did this happen?” finds nothing        | The rule's service has no related series, or the alert just started                        | Expected; the hypothesis then says the related series do not explain it                      |
| A collector is never run                    | It is pending, or its URL is now refused                                                   | Approve it on Data sources; the last error shows there                                       |
| Billing says it is not set up               | No `STRIPE_SECRET_KEY`                                                                     | Set it, see above                                                                            |
| A cancelled workspace's data is still there | The grace period has not passed, or deleting its metrics failed                            | The ingestion service retries every 10 s and logs failures                                   |

## Known limits of phase 4

- The engine judges a rule by its whole expression; per-series alerting (one alert per endpoint) is not built.
- Per-plan retention is enforced when querying. Data is physically kept for the store's global retention (30 days locally).
- A customer's own store is read without the workspace label. Its URL and token are checked when saved; it is only ever read.
- The Grafana export points at a data source chosen on import; nothing stays in sync.
- Real Slack, real Stripe and a real model were not used; each has a fake or stand-in.
