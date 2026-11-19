# Runbook: phase 0, foundations

What exists after phase 0, how to run it, and what to do when it does not work.

## What was built

| Piece                                                                                          | Where                              |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| Local stack: Postgres, the metrics store, the collector, a demo service and its load generator | `infra/compose.yaml`               |
| Collector pipeline: OTLP in, workspace label stamped, remote write out                         | `infra/otel-collector/config.yaml` |
| Demo `checkout` service, instrumented with OpenTelemetry                                       | `infra/demo/checkout-node/`        |
| Database schema and migrations for the 11 tables in the data model                             | `packages/db/`                     |
| Types and validators for panel, dashboard, alert rule, collector and manifest                  | `packages/specs/`                  |
| Product name constant; environment and plans loading                                           | `packages/config/`                 |
| Acceptance check                                                                               | `scripts/verify-phase0.ts`         |

Every other directory in `apps/` and `packages/` is a placeholder for a later phase.

## Requirements

Node 22.12 or newer, pnpm 12, Docker with Compose, GNU Make.

## Everyday commands

| Command       | What it does                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `make dev`    | Creates `.env` from `.env.example` if missing, installs dependencies, starts the stack, waits until it is healthy, applies migrations |
| `make verify` | Checks the running stack end to end, then runs the database integration tests                                                         |
| `make check`  | Lint, format check, product-name check, type-check and unit tests. Needs no containers                                                |
| `make logs`   | Follows the logs of every service                                                                                                     |
| `make ps`     | Shows the state of every service                                                                                                      |
| `make down`   | Stops the stack and keeps its data                                                                                                    |
| `make reset`  | Stops the stack and deletes its data                                                                                                  |

Phase 0 is accepted when `make dev` followed by `make verify` ends with
`Phase 0 accepted`.

## Ports on your machine

All are set in `.env`.

| Service                                             | Default | Variable                                               |
| --------------------------------------------------- | ------- | ------------------------------------------------------ |
| Postgres                                            | 54320   | `POSTGRES_PORT` (also change `DATABASE_URL`)           |
| Metrics store, Prometheus-compatible API and web UI | 8428    | `METRICS_STORE_PORT` (also change `METRICS_STORE_URL`) |
| Collector, OTLP over gRPC                           | 4317    | `OTLP_GRPC_PORT`                                       |
| Collector, OTLP over HTTP                           | 4318    | `OTLP_HTTP_PORT` (also change `OTLP_ENDPOINT`)         |
| Collector health                                    | 13133   | `COLLECTOR_HEALTH_PORT`                                |
| Demo service                                        | 8081    | `DEMO_CHECKOUT_PORT`                                   |

## Looking at the data

Metrics, in a browser: <http://localhost:8428/vmui>. Try

```promql
histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[5m])))
```

Metrics, from a terminal:

```sh
curl -s 'http://localhost:8428/api/v1/query' \
  --data-urlencode 'query=sum by (http_route) (rate(http_server_request_duration_seconds_count{service_name="checkout"}[1m]))'
```

Every metric name the store holds:

```sh
curl -s 'http://localhost:8428/api/v1/label/__name__/values'
```

Postgres:

```sh
docker compose --env-file .env -f infra/compose.yaml exec postgres psql -U app -d app -c '\dt'
```

## Changing the database schema

1. Edit `packages/db/src/schema.ts`.
2. Run `pnpm db:generate`. It writes a new SQL file in `packages/db/migrations/`. It does not need a database.
3. Read the generated SQL, then commit it with the schema change.
4. Run `make migrate`, then `make verify`.

Never edit a migration that has been merged. Add a new one.

## When something is wrong

| Symptom                                                        | Likely cause                                                                         | Fix                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `make dev` fails with "port is already allocated"              | Another program uses one of the ports above                                          | Change the port in `.env` (and the matching URL), then run `make dev` again                         |
| `make dev` hangs, then reports a container as unhealthy        | That service did not start                                                           | `make ps`, then `docker compose --env-file .env -f infra/compose.yaml logs <service>`               |
| `make verify` fails on "request durations are in the store"    | The demo service cannot reach the collector, or the collector cannot reach the store | Check the logs of `demo-checkout` and `otel-collector`. An export error names the endpoint it tried |
| `make verify` passes the metrics checks only on the second run | New series take up to about 30 seconds to become queryable in VictoriaMetrics        | Nothing. The check waits up to two minutes                                                          |
| `make verify` fails on "missing tables"                        | Migrations were not applied                                                          | `make migrate`                                                                                      |
| `Invalid environment: DATABASE_URL is not set`                 | No `.env`, or the command was run outside the repository root                        | Run commands from the root; `make dev` creates `.env`                                               |
| `http_route` is missing from the demo's metrics                | The instrumentation loaded after Express                                             | The service must start with `node --require ./instrumentation.cjs server.cjs`                       |
| The integration tests leave a `schema_test_…` database behind  | A test run was killed                                                                | Drop it with `psql`; each run uses a new random name                                                |
| `pnpm install` stops with "Ignored build scripts"              | A new dependency wants to run an install script                                      | Review it, then allow it under `allowBuilds` in `pnpm-workspace.yaml`                               |

## Known limits of phase 0

- One static workspace label (`DEV_WORKSPACE`) for every sample. Per-workspace ingestion keys are phase 1.
- The collector has no container health check, because its image has no shell. `make verify` checks its health endpoint instead.
- Only VictoriaMetrics is in the compose file. `METRICS_STORE_TYPE=prometheus` is accepted by configuration, and nothing reads it yet.
- The demo service exists in one language. The second comes with the skill in phase 1.
