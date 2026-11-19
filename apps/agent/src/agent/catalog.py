"""Catalog shapes and the stored label names the agent writes queries with.

The names come from packages/catalog/src/names.ts; a test checks they match.
"""

from typing import Literal, NotRequired, TypedDict

SERVICE_LABEL = 'service_name'
METHOD_LABEL = 'http_request_method'
ROUTE_LABEL = 'http_route'
STATUS_LABEL = 'http_response_status_code'
HTTP_SERVER_DURATION = 'http_server_request_duration_seconds'
HTTP_CLIENT_DURATION = 'http_client_request_duration_seconds'

MetricType = Literal['counter', 'gauge', 'histogram', 'updowncounter']


class CatalogMetric(TypedDict):
    service: str
    metricName: str
    storedName: str
    series: list[str]
    type: str
    unit: str
    labels: list[str]
    description: str
    lastSeen: str | None


class CatalogEndpoint(TypedDict):
    service: str
    method: str
    route: str
    description: str
    lastSeen: str | None
    requestRate: float | None
    p95: float | None


class CatalogSearch(TypedDict):
    text: str
    service: NotRequired[str]


class CatalogSearchResult(TypedDict):
    knownServices: list[str]
    services: list[str]
    metrics: list[CatalogMetric]
    endpoints: list[CatalogEndpoint]
