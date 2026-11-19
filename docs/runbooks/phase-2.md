# Runbook: phase 2, Slack

What phase 2 added, how to run it, and how to connect a real Slack workspace.
The [phase 0](phase-0.md) and [phase 1](phase-1.md) runbooks still apply.

## What was built

| Piece                                                                                                     | Where                            |
| --------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Slack app: mentions, direct messages, questions as controls, chart images, buttons                        | `apps/slack/`                    |
| Install flow, which is also sign-up: first install creates the workspace, its admin and its ingestion key | `apps/slack/src/install.ts`      |
| Bot tokens stored encrypted (AES-256-GCM, key from `SECRETS_KEY`)                                         | `packages/config/src/secrets.ts` |
| Server-side charts (SVG → PNG) and the one-line reading, shared with the web tool                         | `packages/charts/`               |
| Agent requests kept in Postgres, so a thread can be answered later and after a restart                    | `apps/agent/src/requests.ts`     |
| Memory: "Skip questions next time" saves answers as `user_default` entries                                | `packages/memory/`               |
| A fake Slack for development and tests                                                                    | `apps/slack/src/fake/server.ts`  |
| Acceptance check                                                                                          | `scripts/verify-phase2.ts`       |

## How a thread goes

1. Someone mentions the bot, or sends it a direct message. The app replies in the thread.
2. Questions arrive one at a time. Short choices are buttons. The endpoint picker is a menu that filters as you type, with "Slowest" and "Busiest" tags and "All endpoints combined" last. At most two questions; anyone in the thread may answer.
3. The answered question is edited to show the answer and who gave it.
4. The draft arrives as a PNG chart with a one-line reading, then the assumptions, the query, and four buttons: **Save to dashboard**, **Alert me on this** (phase 4), **Open in web** (phase 3), and **Skip questions next time** when questions were asked.

Charts in Slack are snapshots and do not refresh. No model is called to draw them or write the reading.

## Talking to the fake Slack

`make dev` starts the Slack app and a fake Slack. The fake's development team (`T0DEV`) is linked to the dev workspace by `pnpm db:seed`. It knows three people: `U0ALICE`, `U0BOB` and `U0CAROL`.

```sh
F=http://localhost:8093
# A mention in #ops (channel C0OPS). Note the ts it returns: it is the thread.
curl -s -X POST $F/fake/mention -H 'content-type: application/json' \
  -d '{"text": "latency graph of checkout service in last 5 hr"}'
# See the thread.
curl -s "$F/fake/thread?channel=C0OPS&thread_ts=<ts>"
# Pick from a menu, or click a button by its text.
curl -s -X POST $F/fake/click -H 'content-type: application/json' \
  -d '{"message_ts": "<ts of the question>", "action_id": "answer_pick", "option": "POST /checkout/pay"}'
curl -s -X POST $F/fake/click -H 'content-type: application/json' \
  -d '{"message_ts": "<ts of the question>", "label": "Slow tail (p95)"}'
```

Chart images are at the `url` on the image message. Direct messages: `POST $F/fake/dm` with `{"text": ...}`.
To try the install flow, open <http://localhost:8092/slack/install> in a browser.

## Connecting a real Slack workspace

1. Make the Slack service reachable from the internet over HTTPS (a tunnel works for testing).
2. Run `pnpm slack:manifest https://<that address> https://<web tool address>` and create the app at
   <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
3. From the app's **Basic Information** page, put the signing secret, client id and client
   secret in the environment as `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID` and
   `SLACK_CLIENT_SECRET`. These are secrets.
4. Set `SLACK_API_URL=https://slack.com/api`, `SLACK_AUTHORIZE_URL=https://slack.com/oauth/v2/authorize`,
   and `SLACK_PUBLIC_URL` to the public address. In `infra/compose.yaml` the Slack service
   points at the fake; change its `SLACK_API_URL` too.
5. Generate a real `SECRETS_KEY` (`openssl rand -base64 32`). Never reuse the dev value.
6. Open `<public address>/slack/install` and approve. The page shows the workspace's
   ingestion key once.

## When something is wrong

| Symptom                                        | Likely cause                                                                                  | Fix                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The bot never replies                          | Events are not reaching `/slack/events`, or the signing secret is wrong (the app answers 401) | Check the app's logs. In the Slack app settings, the request URL must verify   |
| "Something went wrong on my side"              | The agent or the Query API failed                                                             | `make logs`, look at `agent` and `query-api`                                   |
| The bot replies "There is no service called …" | The Slack workspace's product workspace has no services yet                                   | Send metrics with that workspace's ingestion key                               |
| Install fails with "The link has expired"      | The install took more than ten minutes, or the client secret changed                          | Start the install again                                                        |
| Chart images have no text                      | No sans-serif font where the Slack service runs                                               | The services image installs `font-dejavu`; install a font if running elsewhere |
| A question was skipped unexpectedly            | The person saved answers with "Skip questions next time"                                      | They show on the memory page (phase 3); delete them there                      |

## Known limits of phase 2

- **The pilot is not measured.** "70% of charts saved or kept without editing the query" needs people in a real Slack.
- **The time to a chart was measured with the stand-in model** (median 0.16 s). Real models will be slower; measure again with a key.
- "Alert me on this" says alerts are not available until phase 4. "Open in web" links to the web tool, which arrives in phase 3.
- Follow-ups in the same thread (S7) and scheduled posts (S8) are later phases.
- Only bot tokens are stored; tokens do not rotate.
