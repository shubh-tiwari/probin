# Runbook: phase 3, the web tool

What phase 3 added and how to run it. The earlier runbooks still apply.

## What was built

| Piece                                                                                        | Where                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The web tool: dashboard grid, Ask panel, endpoint picker and cross-check, live draft preview | `apps/web/`                                                    |
| Sign in with Slack (OpenID Connect); signed session cookie                                   | `apps/web/src/auth.ts`, `apps/web/src/session.ts`              |
| Time range picker and auto-refresh, with no model call                                       | `apps/web/src/app.tsx` (`/dashboards/:id/panels/:panel/chart`) |
| Query shown under every panel and editable by hand, saved only after a dry run               | same                                                           |
| Memory page: list, add a team decision, edit, delete                                         | `apps/web/src/views/memory.tsx`                                |
| Resolved-request cache: the same words reuse the tested query with no model call             | `apps/agent/src/agent/loop.py`, table `resolved_requests`      |
| Acceptance check                                                                             | `scripts/verify-phase3.ts`                                     |

## Using it

Open <http://localhost:8094> and choose **Sign in with Slack**. In development the fake Slack signs you in as Alice
in the dev team at once. Only people whose Slack workspace has installed the app can sign in.

- **Ask** on the left: “latency graph of checkout service in last 5 hr”. Answer the endpoint picker and at most one
  more question. The preview on the right fills in as you answer and shows the chart once the query is tested.
  **Looks right, add to dashboard** saves it.
- **Time range** in the top bar changes every panel. **Auto-refresh** re-runs each panel's saved query every 30 seconds.
- **Edit the query** under a panel: the new query must run and return data, or it is not saved.
- **Memory** lists what the assistant remembers. Anyone in the workspace can edit or delete an entry.
- **Open in web** from Slack lands on the same request here.

## How "no model call on refresh" holds

Viewing a dashboard, changing its range and refreshing it read the panel specs from Postgres and run their saved
queries through the Query API. None of those paths reach the agent, so no model can be called. `make verify` loads
every range and refreshes every panel, and checks that `model_calls` did not change.

The one shortcut that touches the agent, the resolved-request cache, also avoids the model: an identical request
(same words, ignoring case and spacing) reuses the earlier query while the catalog of its services is unchanged.
The query is still dry-run before it is shown, and the draft says "the same choices as the last time this was asked".

## When something is wrong

| Symptom                                            | Likely cause                                                                                                    | Fix                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| "Not installed" after signing in                   | The person's Slack workspace has not installed the app                                                          | Install it from `/slack/install` on the Slack service first                         |
| Sent back to sign in repeatedly                    | The session cookie is refused: `SECRETS_KEY` changed, or the site is served over HTTP with an `https` `WEB_URL` | Use the same `SECRETS_KEY` everywhere; make `WEB_URL` match how the site is reached |
| A form submit answers "Cross-site request refused" | The page was opened at a different address than `WEB_URL`                                                       | Open the site at `WEB_URL`                                                          |
| A panel shows an error instead of a chart          | Its query fails now, for example after a metric was renamed                                                     | Edit the query; the error text says what failed                                     |
| A request skips its questions                      | It matched an earlier identical request (cache), or the person saved answers                                    | Expected. Reword the request, or delete the saved answer on the memory page         |

## Known limits of phase 3

- Built with server-rendered pages and a small script, not React (see `docs/decisions.md`).
- Sharing a dashboard by link (W9), alerts (W7), collectors (W8) and editing a panel by prompt (W6) come in phase 4.
- Version history (W10) is stored but not shown.
- One dashboard per workspace is created automatically; there is no page to create more yet.
