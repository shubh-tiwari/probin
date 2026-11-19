# Runbook: phase 1, the core loop

What exists after phase 1, how to run it, and what to do when it does not work.
Read the [phase 0 runbook](phase-0.md) first; this one adds to it.

## What was built

| Piece                                                                            | Where                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| Ingestion endpoint: per-workspace keys, OTLP over HTTP, manifest registration    | `apps/ingest/`                                   |
| Catalog sync job (Postgres-backed queue)                                         | `apps/ingest/src/sync-worker.ts`                 |
| Catalog: name mapping, registration, search, sync, convention checks             | `packages/catalog/`                              |
| Query API: time limit, line cap, workspace scoping, result cache                 | `apps/query-api/`                                |
| PromQL reading and scoping                                                       | `packages/promql/`                               |
| Model router: task-type table, budget cap, escalation, call log                  | `packages/router/`, `config/models.example.yaml` |
| Agent: tools with their guards, the "get a metric" loop, prompts, stand-in model | `apps/agent/`                                    |
| Spec store (append-only versions)                                                | `packages/db/src/spec-store.ts`                  |
| The skill for Claude Code                                                        | `skill/src/`, built with `pnpm skill:build`      |
| Demo services: Node and Python, each with an uninstrumented baseline             | `infra/demo/`                                    |
| Query test set                                                                   | `evals/query/`                                   |
| Acceptance check                                                                 | `scripts/verify-phase1.ts`                       |

## How a request flows

```text
service --OTLP + key--> ingest --header--> collector --remote write--> metrics store
service --manifest + key--> ingest --> catalog (Postgres) <--sync-- query-api <-- metrics store

person --"latency of checkout"--> agent
   agent: parse (model) -> search_catalog -> questions (at most two) -> write_query (model)
          -> grounding check (code) -> run_query via query-api (dry run) -> draft -> save on confirm
```

Only the Query API knows the metrics store's address. Only the agent calls a model.

## Everyday commands

| Command                                 | What it does                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm ask "<request>"`                  | Sends a request to the agent and prints the draft panel spec                 |
| `pnpm ask "<request>" --answer <v> ...` | Answers questions in order, by option value, label or number                 |
| `pnpm ask "<request>" --save`           | Saves the draft to the workspace's dashboard                                 |
| `pnpm ask "<request>" --json`           | Prints the whole reply, including every attempt and what the catalog allowed |
| `pnpm ws:create <name>`                 | Creates a workspace and prints its ingestion key, once                       |
| `pnpm ws:rotate-key <workspace id>`     | Replaces the key; the old one stops working at once                          |
| `pnpm conformance [service]`            | Checks the demo services against the metric convention                       |
| `pnpm evals:query`                      | Runs the query test set (see `evals/README.md`)                              |
| `pnpm skill:build`                      | Builds the skill into `skill/dist/`                                          |
| `scripts/test-skill.sh <service>`       | Applies the skill to a baseline service with a fresh Claude Code session     |
| `pnpm db:seed`                          | Re-creates the dev workspace and re-registers the demo manifests             |

## Ports added in this phase

| Service            | Default | Variable                                       |
| ------------------ | ------- | ---------------------------------------------- |
| Ingestion endpoint | 4318    | `INGEST_PORT` (also change `INGEST_URL`)       |
| Query API          | 8090    | `QUERY_API_PORT` (also change `QUERY_API_URL`) |
| Agent              | 8091    | `AGENT_PORT` (also change `AGENT_URL`)         |
| Demo inventory     | 8082    | `DEMO_INVENTORY_PORT`                          |

The collector's OTLP ports are no longer published. Nothing outside the compose network
can send to it directly.

## Using real models

Out of the box no model is called: with `OPENROUTER_API_KEY` empty, the agent uses a
built-in stand-in (keyword rules and query templates). The agent's start-up log line says
which it is using.

To switch to real models:

1. Put the key in `.env` as `OPENROUTER_API_KEY=...`. Never commit it.
2. Run `EVAL_BUDGET=<cap> pnpm evals:query --record-eligibility`. This tests each
   candidate model in `config/models.example.yaml` on the test set and writes
   `evals/eligibility.json`. **Until this file exists the router refuses every call**,
   because no model has passed the test set.
3. Run `make dev` again so the agent picks up the key and the file.
4. Run `EVAL_BUDGET=<cap> pnpm evals:query --gate` to measure the phase 1 gate.

To compare OpenRouter's own routing with the task-type table (an open item in the plan):
`EVAL_BUDGET=<cap> pnpm evals:query --strategy auto`, and compare its summary with the
default run's.

## Looking at the data

The catalog:

```sh
docker compose --env-file .env -f infra/compose.yaml exec postgres psql -U app -d app \
  -c 'select service, metric_name, stored_name, type, last_seen from catalog_metrics order by 1, 2' \
  -c 'select service, method, route, request_rate, p95 from catalog_endpoints order by 1, 3'
```

Model calls and spend:

```sh
docker compose --env-file .env -f infra/compose.yaml exec postgres psql -U app -d app \
  -c 'select task_type, model, outcome, count(*), sum(cost) from model_calls group by 1, 2, 3 order by 1, 2'
```

A query through the Query API, as the dev workspace:

```sh
curl -s http://localhost:8090/v1/dry-run \
  -H 'authorization: Bearer dev-only-internal-token-not-a-secret' \
  -H 'x-workspace-id: 00000000-0000-4000-8000-000000000001' \
  -H 'content-type: application/json' \
  -d '{"query": "sum(rate(http_server_request_duration_seconds_count[5m]))", "range": "1h"}'
```

## When something is wrong

| Symptom                                                              | Likely cause                                                                                  | Fix                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A service's metrics never arrive; its log shows HTTP 401 on export   | Wrong or missing ingestion key                                                                | `OTEL_EXPORTER_OTLP_HEADERS` must be `Authorization=Bearer <key>`. For the demo services, run `pnpm db:seed` |
| Metrics arrive at the ingestion endpoint (HTTP 200) but not in store | The collector dropped them: no workspace header reached it                                    | Only the ingestion service may call the collector. Check `COLLECTOR_URL` and the collector's log             |
| `pnpm ask` says nothing in the catalog matches a metric you can see  | The catalog has not synced yet, or the manifest was not registered                            | Sync runs every minute and five seconds after a registration. Look at `catalog_metrics`; run `pnpm db:seed`  |
| The ingest log says a declared metric "is not in the store"          | The service does not emit it, or the name mapping in `packages/catalog/src/names.ts` is wrong | Compare the manifest with `curl -s localhost:8428/api/v1/label/__name__/values`                              |
| `pnpm ask` fails with "No model is eligible"                         | A model key is set and `evals/eligibility.json` does not exist yet                            | See "Using real models", step 2                                                                              |
| `pnpm ask` fails with "used its model budget for the month"          | The workspace's spend this month reached its plan's limit                                     | Raise `monthly_model_budget` on the workspace, or the plan's limit. Dashboards are unaffected                |
| A query is refused with `forbidden`                                  | It mentions the `workspace` label or uses `info()`                                            | Remove it. Queries are scoped automatically and never need to name the workspace                             |
| A query is refused with `too_many_lines`                             | It returns more series than `QUERY_MAX_LINES`                                                 | Aggregate with `sum by (...)`, or raise the limit in `.env`                                                  |
| Every attempt fails with "returned no data"                          | The demo services have only just started, or the range is shorter than the data               | Wait a minute and retry                                                                                      |
| `make verify` fails on "the collector drops data…"                   | The check runs `docker compose exec`; it needs the stack started by `make dev`                | Start the stack with `make dev`, from the repository root                                                    |
| `pnpm conformance` reports `endpoint-in-manifest`                    | A route is measured that the manifest does not list                                           | The manifest is out of step with the code. Update it, then `pnpm db:seed`                                    |
| The agent forgot a request between question and answer               | Open requests are kept in the agent's memory for an hour and lost on restart                  | Ask again. Requests move to Postgres in phase 2                                                              |

## Known limits of phase 1

- **The 90% gate has not been measured.** It needs a model key. Everything else in the
  acceptance sentence is checked by `make verify`.
- The model prompts have only been exercised by the stand-in. Expect to adjust them once
  real models are run against the test set.
- OTLP over gRPC is not accepted. Services must use `http/protobuf`.
- Open requests live in the agent's memory. One agent instance only, until phase 2.
- The query result cache is per Query API process.
- Callers of the agent and the Query API authenticate with one shared internal token.
  People sign in from phase 2.
- `scripts/test-skill.sh` has not been run end to end; the skill was tested in this
  phase by fresh agents given only the skill and a baseline service.
