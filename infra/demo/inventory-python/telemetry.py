"""OpenTelemetry metrics for Probin. Configured entirely from the standard OTEL_ variables."""

import os
import re

# Emit the stable HTTP conventions: http.server.request.duration in seconds.
# Must be set before any instrumentation package is imported.
os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN", "http")

from opentelemetry import metrics
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import ConsoleMetricExporter, PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import DropAggregation, View

# The FastAPI instrumentation also emits these. They are not part of the Probin convention and
# are not in probin.yaml, so they are dropped: the service emits exactly what the manifest lists.
_UNLISTED_HTTP_METRICS = (
    "http.server.active_requests",
    "http.server.request.body.size",
    "http.server.response.body.size",
)


def _framework_docs_urls(app) -> str:
    """A pattern for FastAPI's own pages (API docs and the OpenAPI schema), and nothing else.

    They are not endpoints of the service, so they are not measured and not in probin.yaml.
    The pattern is searched for in the full URL (scheme://host/path), so it is anchored: a bare
    "docs" would also drop requests for /inventory/items/docs-1.
    """
    paths = [app.openapi_url, app.docs_url, app.redoc_url, app.swagger_ui_oauth2_redirect_url]
    alternatives = "|".join(re.escape(path) for path in paths if path)
    return f"^https?://[^/]+(?:{alternatives})$" if alternatives else ""


def setup_telemetry(app) -> None:
    """Send OpenTelemetry metrics for this service. Does nothing if no endpoint is configured."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    use_console = os.environ.get("OTEL_METRICS_EXPORTER") == "console"
    if not endpoint and not use_console:
        return

    # The OTLP exporter reads the endpoint, headers and protocol from the OTEL_ variables.
    exporter = ConsoleMetricExporter() if use_console else OTLPMetricExporter()
    reader = PeriodicExportingMetricReader(
        exporter,
        export_interval_millis=float(os.environ.get("OTEL_METRIC_EXPORT_INTERVAL", "60000")),
    )
    views = [
        View(instrument_name=name, aggregation=DropAggregation()) for name in _UNLISTED_HTTP_METRICS
    ]
    # The service name comes from OTEL_SERVICE_NAME.
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader], views=views))

    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app, excluded_urls=_framework_docs_urls(app))
