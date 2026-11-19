# Python

Examples use FastAPI. Flask and Django differ only in the instrumentation package and one call.

## Packages

Add to the project's dependency file (`requirements.txt`, `pyproject.toml`):

```
opentelemetry-sdk
opentelemetry-exporter-otlp-proto-http
```

Plus the instrumentation for the web framework:

| Framework | Package                                 | Call                                                     |
| --------- | --------------------------------------- | -------------------------------------------------------- |
| FastAPI   | `opentelemetry-instrumentation-fastapi` | `FastAPIInstrumentor.instrument_app(app)`                |
| Flask     | `opentelemetry-instrumentation-flask`   | `FlaskInstrumentor().instrument_app(app)`                |
| Django    | `opentelemetry-instrumentation-django`  | `DjangoInstrumentor().instrument()` before the app loads |

And for the library the service uses to call other services:

| Library        | Package                                        | Call                                                   |
| -------------- | ---------------------------------------------- | ------------------------------------------------------ |
| httpx          | `opentelemetry-instrumentation-httpx`          | `HTTPXClientInstrumentor().instrument()`               |
| requests       | `opentelemetry-instrumentation-requests`       | `RequestsInstrumentor().instrument(excluded_urls=...)` |
| aiohttp client | `opentelemetry-instrumentation-aiohttp-client` | `AioHttpClientInstrumentor().instrument()`             |

Use the exporter package ending in `-http`, not `-grpc`. Let the package manager pick versions that match each other: the instrumentation packages are released together and must all be the same version.

## The set-up module

Create one module, for example `telemetry.py`, and call it once when the application is created.

```python
# telemetry.py
import os
import re

# Emit the stable HTTP conventions: http.server.request.duration in seconds.
# Must be set before any instrumentation package is imported.
os.environ.setdefault('OTEL_SEMCONV_STABILITY_OPT_IN', 'http')

from opentelemetry import metrics
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import ConsoleMetricExporter, PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import DropAggregation, View

# The web framework's instrumentation also emits these. They are not part of the
# convention, so they are dropped: the service emits exactly what its manifest lists.
_UNLISTED_HTTP_METRICS = (
    'http.server.active_requests',
    'http.server.request.body.size',
    'http.server.response.body.size',
)


def _not_endpoints(app) -> str:
    """A pattern for the framework's own pages (API docs, the OpenAPI schema).

    They are not endpoints of the service, so they are not measured and not in the manifest.
    The pattern is searched for in the full URL (scheme://host/path), so it must be anchored:
    a bare "docs" would also drop requests for /items/docs-1.
    """
    paths = [app.openapi_url, app.docs_url, app.redoc_url, app.swagger_ui_oauth2_redirect_url]
    alternatives = '|'.join(re.escape(path) for path in paths if path)
    return f'^https?://[^/]+(?:{alternatives})$' if alternatives else ''


def setup_telemetry(app) -> None:
    """Send OpenTelemetry metrics for this service. Does nothing if no endpoint is configured."""
    endpoint = os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT')
    use_console = os.environ.get('OTEL_METRICS_EXPORTER') == 'console'
    if not endpoint and not use_console:
        return

    # The OTLP exporter reads the endpoint and headers from the OTEL_ variables.
    exporter = ConsoleMetricExporter() if use_console else OTLPMetricExporter()
    reader = PeriodicExportingMetricReader(
        exporter,
        export_interval_millis=float(os.environ.get('OTEL_METRIC_EXPORT_INTERVAL') or 60000),
    )
    views = [
        View(instrument_name=name, aggregation=DropAggregation()) for name in _UNLISTED_HTTP_METRICS
    ]
    # The service name comes from OTEL_SERVICE_NAME.
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader], views=views))

    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app, excluded_urls=_not_endpoints(app))
```

```python
# main.py
from fastapi import FastAPI
from telemetry import setup_telemetry

app = FastAPI()
setup_telemetry(app)  # before the first request; routes may be added after
```

To leave out health checks as well, add their paths to the pattern in the same anchored form, for example `^https?://[^/]+/(?:healthz|readyz)$`. Never pass a bare word such as `"healthz"` or `"docs"`: it is a regular expression matched anywhere in the URL.

Instrument outbound calls in the same function, after the meter provider is set. The OTLP exporter sends with the `requests` library, so:

- If the service makes its own calls with **httpx** or **aiohttp**, instrument only that library. The exporter's requests are then not measured at all.
- If the service makes its own calls with **requests**, instrument it and exclude the ingestion endpoint, or telemetry export will be counted as an outbound call:

  ```python
  from opentelemetry.instrumentation.requests import RequestsInstrumentor

  RequestsInstrumentor().instrument(
      excluded_urls=re.escape(endpoint)
  )  # endpoint is OTEL_EXPORTER_OTLP_ENDPOINT
  ```

Under a pre-forking server (gunicorn, uvicorn with `--workers`), call the set-up in each worker process after the fork, not in the parent. A reader thread started before the fork does not exist in the workers and nothing is exported.

The Python SDK sends the service name and its own `telemetry.sdk.*` values and nothing about the machine. Do not switch on extra resource detectors.

## Background jobs and business metrics

Create each instrument once, at module level.

```python
import time
from opentelemetry import metrics

meter = metrics.get_meter('inventory')  # the meter is named after the service; metrics are not


# Business metric: a gauge read on each export, with one bounded attribute.
def _observe_stock(options):
    for warehouse, units in current_stock().items():  # a fixed, small set of warehouses
        yield metrics.Observation(units, {'warehouse': warehouse})


meter.create_observable_gauge(
    'stock.level',
    callbacks=[_observe_stock],
    unit='{item}',
    description='Units in stock per warehouse',
)

# Business metric: a counter.
reservations = meter.create_counter(
    'stock.reservations',
    unit='{reservation}',
    description='Stock reservations made',
)
reservations.add(1, {'warehouse': warehouse})

# Background job: a histogram in seconds, recorded on success and on failure.
restock_duration = meter.create_histogram(
    'stock.restock.duration',
    unit='s',
    description='Duration of the restock job',
    explicit_bucket_boundaries_advisory=[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
)


def run_restock():
    started = time.perf_counter()
    result = 'success'
    try:
        restock()
    except Exception:
        result = 'failure'
        raise
    finally:
        restock_duration.record(
            time.perf_counter() - started, {'job.name': 'restock', 'job.result': result}
        )
```

- Time the work of one run, not the wait between runs.
- Record `failure` wherever the failure is actually handled. If the job catches its own errors and carries on, set the result in that handler; the `except` above only sees errors that propagate.
- In an `asyncio` job, a run cancelled at shutdown raises `asyncio.CancelledError`, which is not an `Exception`. Do not record a cancelled run at all: it neither succeeded nor failed, and its duration is cut short.
- `metrics.get_meter` may be called at import time, before `setup_telemetry` runs: instruments created early start recording once the provider is set.
- If an attribute value comes from outside (a request body, a header), it must be mapped onto a fixed list first. If the service already does that, use the service's value. If it does not, map unknown values to `other`.

## Checking

```sh
OTEL_METRICS_EXPORTER=console OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_SERVICE_NAME=<name> \
  uvicorn main:app --port 8000
```

Call each endpoint, wait for an export (about five seconds), and read the printed JSON. Look for a metric named `http.server.request.duration` with unit `s`, and `http.route` in its data point attributes. The only metric names printed should be the ones in the manifest.

Things that go wrong:

- **`http.server.duration` in `ms`**: the stable conventions are off. `OTEL_SEMCONV_STABILITY_OPT_IN=http` must be in the environment before the instrumentation package is imported; setting it in `telemetry.py` above the imports does that.
- **Extra metrics such as `http.server.active_requests`**: add them to the dropped list above.
- **Routes such as `/docs` or `/openapi.json` appear**: the framework's own pages are being measured. Exclude them as above.
- **Nothing is exported**: export errors are logged at warning level by the `opentelemetry` logger. Make sure logging is configured, or run once with the console exporter.
