# Node.js

Works for CommonJS and ES module services. Examples use Express; other frameworks differ only in the instrumentation package.

## Packages

```sh
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-metrics \
  @opentelemetry/resources @opentelemetry/exporter-metrics-otlp-proto \
  @opentelemetry/instrumentation-http
```

Plus the instrumentation for the web framework, which is what supplies `http.route`:

| Framework           | Package                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Express             | `@opentelemetry/instrumentation-express`                                                  |
| Koa                 | `@opentelemetry/instrumentation-koa`                                                      |
| Fastify             | `@fastify/otel`                                                                           |
| NestJS (on Express) | `@opentelemetry/instrumentation-express` and `@opentelemetry/instrumentation-nestjs-core` |

The HTTP instrumentation alone does not know the route. Without the framework package, `http.route` is missing.

Outbound calls made with `fetch` need `@opentelemetry/instrumentation-undici`. Calls made with the `http`/`https` modules (and libraries built on them, such as axios) are covered by `@opentelemetry/instrumentation-http`.

Commit the updated lock file with `package.json`.

## The bootstrap file

Create one file that sets OpenTelemetry up, and load it **before** the application so the framework is patched before it is imported. Name it `instrumentation.cjs` (CommonJS) or `instrumentation.mjs` (ES modules).

```js
// instrumentation.cjs
'use strict';

// Emit the stable HTTP conventions: http.server.request.duration in seconds.
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { envDetector } = require('@opentelemetry/resources');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} = require('@opentelemetry/sdk-metrics');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const useConsole = process.env.OTEL_METRICS_EXPORTER === 'console';

// With no endpoint configured the service runs without exporting.
if (endpoint || useConsole) {
  const ingest = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : undefined;

  const sdk = new NodeSDK({
    // An array. The singular `metricReader` is ignored by current SDK versions,
    // which then build their own reader from the environment.
    metricReaders: [
      new PeriodicExportingMetricReader({
        // The OTLP exporter reads the endpoint and headers from the OTEL_ variables.
        exporter: useConsole ? new ConsoleMetricExporter() : new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60000,
      }),
    ],
    // Metrics only. Left unset, the SDK creates trace and log exporters from the environment.
    spanProcessors: [],
    logRecordProcessors: [],
    // Send the service name and nothing about the machine. The default
    // detectors add the host name, the OS user, the process id and the command line.
    resourceDetectors: [envDetector],
    instrumentations: [
      new HttpInstrumentation({
        // Sending telemetry is not a call to another service. Keep it out of
        // http.client.request.duration.
        ignoreOutgoingRequestHook: (request) =>
          ingest !== undefined &&
          (request.hostname ?? request.host) === ingest.hostname &&
          String(request.port ?? '') === ingest.port,
      }),
      new ExpressInstrumentation(),
    ],
  });
  sdk.start();

  // Send the last metrics when the process is about to end. Do not call
  // process.exit() from a signal handler here: the service's own shutdown must
  // be left to finish the requests it is still handling.
  let flushed;
  const flush = () => (flushed ??= sdk.shutdown().catch(() => {}));
  process.once('beforeExit', flush);
}
```

If the service has no shutdown handling of its own, a `SIGTERM` ends it at once and the last interval of metrics is lost. That is acceptable; do not add a handler that changes how the service stops.

Load the file from the start command, and change **every** place the service is started (the `start` script in `package.json`, the Dockerfile `CMD`, a Procfile):

```sh
node --require ./instrumentation.cjs server.js        # CommonJS
node --import ./instrumentation.mjs server.js         # ES modules
```

For ES modules, write the same file with `import` statements, and add this at the very top so that modules loaded with `import` are patched too:

```js
import { register } from 'node:module';
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
```

If the service uses `fetch` for outbound calls, add the undici instrumentation to `instrumentations`, excluding the exporter's own requests in the same way:

```js
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');

new UndiciInstrumentation({
  ignoreRequestHook: (request) => ingest !== undefined && request.origin === ingest.origin,
}),
```

Do not use `@opentelemetry/auto-instrumentations-node` unless the service already does. It switches on dozens of instrumentations; list the ones the service needs.

## Background jobs and business metrics

Get a meter from the API and create each instrument once, at module level, not per call.

```js
const { metrics } = require('@opentelemetry/api');
const meter = metrics.getMeter('checkout');

// Business metric: a counter with one bounded attribute.
const ordersCompleted = meter.createCounter('orders.completed', {
  unit: '{order}',
  description: 'Orders paid successfully',
});
ordersCompleted.add(1, { 'payment.method': method }); // method is one of a fixed list

// Background job: a histogram in seconds, recorded on success and on failure.
const exportDuration = meter.createHistogram('orders.export.duration', {
  unit: 's',
  description: 'Duration of the nightly order export job',
  advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] },
});

async function runExport() {
  const started = process.hrtime.bigint();
  let result = 'success';
  try {
    await exportOrders();
  } catch (error) {
    result = 'failure';
    throw error;
  } finally {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    exportDuration.record(seconds, { 'job.name': 'orders-export', 'job.result': result });
  }
}
```

- Time the work of one run, not the wait between runs.
- Record `failure` wherever the failure is actually handled. If the job catches its own errors and carries on, set the result in that handler; the `catch` above only sees errors that propagate.
- Choose bucket boundaries that fit the job: the defaults stop at 10 seconds.
- If an attribute value comes from outside (a request body, a header), it must be mapped onto a fixed list first. If the service already does that, use the service's value. If it does not, map unknown values to `other`.

## Checking

```sh
OTEL_METRICS_EXPORTER=console OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_SERVICE_NAME=<name> \
  node --require ./instrumentation.cjs server.js
```

Call each endpoint, wait for an export (about five seconds), and read the printed metrics. Look for the descriptor name `http.server.request.duration`, unit `s`, and `http.route` in the data point attributes.

The console exporter makes no network calls and does not print resource attributes, so two things need another way:

- **Outbound calls and the exclusion of telemetry export.** If the service's downstream is not available locally, start a few-line local HTTP server as a stand-in for it and point the service at it; `http.client.request.duration` then appears in the console output. To check the exclusion, point `OTEL_EXPORTER_OTLP_ENDPOINT` at another throwaway local server and confirm its address never appears as `server.address`. Keep these stand-ins out of the repository.
- **Resource attributes.** With `resourceDetectors: [envDetector]` as above, only the service name and the SDK's own `telemetry.sdk.*` values are sent.

Things that go wrong:

- **Nothing is printed for a minute, then everything at once**: the reader was passed as `metricReader`. It must be `metricReaders: [...]`.
- **`http.route` missing on every request**: the framework instrumentation is not installed, or the bootstrap file loads after the framework. It must be the first thing loaded.
- **`http.server.duration` in `ms`**: the stable conventions are off. Set `OTEL_SEMCONV_STABILITY_OPT_IN=http` before the SDK is imported, as above.
- **Express reports `/orders/:id`**: that is the template for Express. Write it that way in the manifest.
- **Nothing is exported and nothing is logged**: export errors are quiet by default. Run once with `OTEL_LOG_LEVEL=debug`.
