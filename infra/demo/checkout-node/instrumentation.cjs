// Sets up OpenTelemetry metrics for Probin. Loaded before the application
// (node --require ./instrumentation.cjs server.cjs) so that http, Express and
// fetch are patched before the service imports them.
'use strict';

// Emit the stable HTTP conventions: http.server.request.duration in seconds.
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { envDetector } = require('@opentelemetry/resources');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { ConsoleMetricExporter, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const useConsole = process.env.OTEL_METRICS_EXPORTER === 'console';

// With no endpoint configured the service runs without exporting.
if (endpoint || useConsole) {
  const ingest = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : undefined;

  const sdk = new NodeSDK({
    metricReaders: [
      new PeriodicExportingMetricReader({
        // The OTLP exporter reads the endpoint, headers and protocol from the OTEL_ variables.
        exporter: useConsole ? new ConsoleMetricExporter() : new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60000),
      }),
    ],
    // Metrics only: no spans and no log records are exported. Left unset, the
    // SDK would create OTLP trace and log exporters from the environment.
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
      // Outbound calls made with fetch (the inventory service).
      new UndiciInstrumentation({
        ignoreRequestHook: (request) => ingest !== undefined && request.origin === ingest.origin,
      }),
    ],
  });
  sdk.start();

  let flushed;
  const flush = () => (flushed ??= sdk.shutdown().catch(() => {}));

  // On SIGTERM the service closes its own server and the process ends once
  // in-flight requests have finished. Send the last metrics at that point
  // rather than exiting from here, which would cut those requests off.
  process.once('beforeExit', flush);

  // Ctrl-C: send the last metrics, then let the signal end the process as before.
  process.once('SIGINT', () => flush().finally(() => process.kill(process.pid, 'SIGINT')));
}
