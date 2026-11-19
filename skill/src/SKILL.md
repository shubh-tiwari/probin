---
name: {{PRODUCT_SLUG}}-metrics
description: Make a service emit standard OpenTelemetry metrics and register with {{PRODUCT_NAME}}. Use whenever you build a new backend service, or add or change an HTTP endpoint, a background job, or a business metric in an existing one, in any repository that sends metrics to {{PRODUCT_NAME}} (it has a {{MANIFEST_FILENAME}} file, or the user asks for {{PRODUCT_NAME}}, monitoring, metrics, dashboards or alerts for the service).
---

# {{PRODUCT_NAME}} metrics

{{PRODUCT_NAME}} turns plain-language requests ("latency of checkout in the last 5 hours") into charts and alerts. It can only do that for metrics it knows: every service must emit the same metrics, named the same way, and say what it emits. This skill is how that happens. Apply it to every service you build or change.

You do four things, in order. Each has a section below.

1. **Instrument**: emit OpenTelemetry metrics with the language's OpenTelemetry SDK.
2. **Describe**: write or update `{{MANIFEST_FILENAME}}` at the service root.
3. **Connect**: send the metrics to the workspace's ingestion endpoint, with the key taken from the environment.
4. **Register**: send `{{MANIFEST_FILENAME}}` to the registration endpoint.

Then **check your work** (last section). Do not skip it: a wrong metric name is silent until someone asks for a chart and gets nothing.

If a {{PRODUCT_NAME}} connector is available to you as a tool, use it to look at the service's live metrics while you work.

## The convention

Names follow the OpenTelemetry semantic conventions. Do not invent names for things the conventions already cover.

| What is measured                       | Metric                                                                | Type and unit            | Attributes                                                           |
| -------------------------------------- | --------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| Requests the service handles           | `http.server.request.duration`                                        | Histogram, seconds (`s`) | `http.request.method`, `http.route`, `http.response.status_code`     |
| HTTP calls the service makes to others | `http.client.request.duration`                                        | Histogram, seconds (`s`) | `http.request.method`, `server.address`, `http.response.status_code` |
| Background jobs                        | Your own name in the same style, for example `orders.export.duration` | Histogram, seconds (`s`) | `job.name`, `job.result` (`success` or `failure`)                    |
| Business metrics the owner asks for    | Your own name in the same style, for example `orders.completed`       | Counter or gauge         | A short fixed set                                                    |

The first two come from the framework's OpenTelemetry instrumentation; you do not record them by hand. You write code only for background jobs and business metrics.

The instrumentation adds a few more attributes to the two HTTP metrics than the table lists (`url.scheme`, `network.protocol.version`, `server.port`). Those are fine; leave them. A request that matches no route has no `http.route`; that is expected, and you must not fill it in with the raw path.

Rules. Each one is checked on the service's pull requests.

- **Base units only.** Durations in seconds, sizes in bytes (`By`). Never milliseconds or megabytes. A count uses an annotation such as `{order}`.
- **`http.route` is the route template**, as the framework declares it: `/orders/{id}`, never `/orders/8841` and never the full URL.
- **No personal or secret values**, in names or attributes: no user ids, emails, tokens, IP addresses.
- **No attribute with unbounded values.** An attribute needs a short fixed set of values: a payment method, a region, a result. Never an order id, a URL, a timestamp or free text.
- **No separate request counter.** Request counts and error rates are computed from the `http.server.request.duration` histogram. Do not add `requests.total` or similar.
- **Own names are lower-case words joined by dots**: `area.thing.measure`, for example `orders.completed` or `stock.restock.duration`. Do not start a metric name with the service's name: in a service called `inventory`, write `stock.level`, not `inventory.stock.level`. The service is recorded separately on every sample.
- **Attribute names are lower-case too**, with a dot when they belong to a group: `payment.method`, `job.result`. A single plain word such as `warehouse` is fine.
- **Nothing about the machine.** Send the service name and no host name, OS user, process id or command line. The language guides show how to switch those off where the SDK adds them by default.
- **Metrics only.** Do not set up trace or log export for {{PRODUCT_NAME}}.

Add a business metric only when the owner asks for one or the task clearly calls for it. Do not add metrics speculatively.

## 1. Instrument

Follow the guide for the service's language. Read it before writing code; the details differ and matter.

- Node.js: [reference/node.md](reference/node.md)
- Python: [reference/python.md](reference/python.md)

For another language, apply the same four requirements with that language's OpenTelemetry SDK and say in your summary that the language has no guide yet:

1. A meter provider with a periodic reader and the OTLP **HTTP** metric exporter (`http/protobuf`). gRPC is not accepted.
2. The framework's HTTP server instrumentation, configured for the stable HTTP conventions, so that `http.server.request.duration` is emitted in seconds with `http.route` as the route template.
3. HTTP client instrumentation for the library the service uses to call other services, excluding the exporter's own requests to the ingestion endpoint.
4. The service name set with `OTEL_SERVICE_NAME`.

Set the service name to the short name people use for the service: `checkout`, `order-api`. It must match `service` in `{{MANIFEST_FILENAME}}`.

## 2. Describe

Write `{{MANIFEST_FILENAME}}` at the root of the service (next to its package or project file). Format and a full example: [reference/manifest.md](reference/manifest.md).

It lists every endpoint the service handles and every metric it emits. Keep it in step with the code: **whenever you add, change or remove an endpoint or a metric, update the manifest in the same change.** An endpoint that is in the code but not in the manifest is a defect.

Leave out endpoints that exist only for infrastructure (health checks, readiness probes) if they are excluded from instrumentation; otherwise list them.

## 3. Connect

The exporter is configured entirely from standard OpenTelemetry environment variables. Do not hard-code any of these values.

| Variable                      | Value                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `OTEL_SERVICE_NAME`           | The service's short name. Not a secret.                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The workspace's ingestion URL, from the {{PRODUCT_NAME}} workspace settings.    |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf`. Some SDKs ignore it; set it anyway so the intent is on record. |
| `OTEL_EXPORTER_OTLP_HEADERS`  | `Authorization=Bearer <ingestion key>`. **This is a secret.**                   |

The ingestion key **never goes in the repository**: not in code, not in a committed `.env`, not in a Dockerfile, compose file or CI file as a literal. It comes from the deployment's secret store. For local runs, read it from an untracked file and make sure that file is git-ignored. If you find a key committed, tell the user it must be rotated.

Where each value goes:

- **`OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_PROTOCOL`** are not secrets and are the same everywhere. Set them where the service's fixed configuration lives: an `ENV` line in the Dockerfile, or the deployment manifest. If there is no such place, the Dockerfile is the default.
- **The endpoint and the key** differ per environment and come from the deployment.
- **For local runs**, put all four in an untracked `.env` file and load it when starting the service (`node --env-file=.env ...`, `uvicorn --env-file .env ...`, or the project's own loader). Do not add a new dependency just to load it.

Document the variables wherever the project documents configuration, with the key shown as a placeholder. If the project has no such place, create `.env.example`.

If the variables are not set, the service must still start and work. It should run without exporting, not crash.

## 4. Register

Registration sends the manifest to {{PRODUCT_NAME}} so the catalog knows the service's endpoints and metrics. It uses the same endpoint and key as the metrics.

Add this script to the service as `scripts/register-manifest.sh`, make it executable, and call it from the deploy pipeline after a successful deploy (or tell the user where to call it if there is no pipeline yet):

```sh
#!/usr/bin/env bash
# Registers {{MANIFEST_FILENAME}} with {{PRODUCT_NAME}}. Uses the same endpoint and key as metric export.
set -euo pipefail
: "${OTEL_EXPORTER_OTLP_ENDPOINT:?set OTEL_EXPORTER_OTLP_ENDPOINT to the ingestion URL}"
: "${OTEL_EXPORTER_OTLP_HEADERS:?set OTEL_EXPORTER_OTLP_HEADERS to Authorization=Bearer <key>}"
manifest="$(dirname "$0")/../{{MANIFEST_FILENAME}}"
curl --fail-with-body --silent --show-error \
  --request POST "${OTEL_EXPORTER_OTLP_ENDPOINT%/}/v1/manifests" \
  --header "${OTEL_EXPORTER_OTLP_HEADERS/=/: }" \
  --header 'content-type: application/yaml' \
  --data-binary "@${manifest}"
echo
```

A `422` reply lists what is wrong with the manifest. Fix the manifest; do not work around the check.

The script expects `OTEL_EXPORTER_OTLP_HEADERS` to hold the one `Authorization` header and nothing else, and needs curl 7.76 or newer.

Run the script yourself only if the variables are already set in your environment. Never ask the user to paste the key into the chat. If there is no deploy pipeline, say in your summary that the owner must run it after each deploy.

## Check your work

Before you finish, confirm each point by running the service, not by reading the code.

1. Start the service with the console metric exporter (each language guide shows how) and call every endpoint at least once, including one with a path parameter if the service has any.
2. In the output, confirm:
   - `http.server.request.duration` is present, with unit `s`. If you see `http.server.duration` or a unit of `ms`, the stable conventions are not switched on.
   - `http.route` is the template (`/orders/{id}`), on every endpoint.
   - Each background job and business metric you added appears with the name, unit and attributes in the manifest.
   - There is no request counter, and no attribute carrying an id, URL or personal value.
   - If the service calls other services, `http.client.request.duration` is present and does **not** include calls to the ingestion endpoint. The console exporter cannot show this on its own; the language guide says how to check it with local stand-ins. If you cannot, say so in your summary.
3. Confirm `{{MANIFEST_FILENAME}}` lists exactly the endpoints and metrics you saw.
4. Confirm the service still starts with none of the `OTEL_` variables set.
5. Confirm no file you created or changed contains an ingestion key: check `git status` and the diff, or search the service directory for `Bearer` if it is not a git repository. Placeholders such as `<ingestion key>` are fine.

In your summary to the user, say which of these you ran and what you saw, and list anything you could not check.
