"""The two prompts the agent sends (apps/agent/src/prompts.ts), word for word."""

import json
import re
from typing import Any, NotRequired, TypedDict

from agent.catalog import METHOD_LABEL, ROUTE_LABEL, SERVICE_LABEL, STATUS_LABEL, CatalogMetric
from agent.jsonjs import stringify
from agent.state import AgentState
from modelrouter import ChatMessage

#: The window used inside rate(): long enough to be smooth at the default scrape interval.
RATE_WINDOW = '5m'


def block(tag: str, body: str) -> str:
    return f'<{tag}>\n{body}\n</{tag}>'


def read_block(messages: list[ChatMessage], tag: str) -> str | None:
    """Read a tagged block back out of a prompt. Used by the stand-in model and by tests."""
    pattern = re.compile(f'<{tag}>\n([\\s\\S]*?)\n</{tag}>')
    for message in reversed(messages):
        match = pattern.search(message['content'])
        if match:
            return match.group(1)
    return None


PARSE_SYSTEM = """You turn one monitoring request into a small JSON object. You do not write queries and you do not know which metrics exist.

Reply with one JSON object and nothing else, with exactly these keys:
- "measure": what to measure, in the person's own words, without the service, endpoint or time range. Example: "latency", "orders completed", "error rate".
- "kind": "latency" (how long requests take), "traffic" (how many requests), "errors" (failed requests or error rate), or "other" (anything else, such as a business metric or a queue).
- "service": the service the person named, in their words, or null.
- "endpoint": {"method": "POST" or null, "route": "/path/as/written"} if the person named an endpoint, else null.
- "all_endpoints": true only if the person asked for all endpoints together.
- "percentile": a number such as 50, 95 or 99 if the person named one ("median" is 50), else null. Never choose one for them.
- "requests": "failed_only" or "successful_only" if the person restricted the requests counted, "all" if they said to include failures, else null.
- "range": the time range as a duration such as "30m", "5h" or "7d" if the person gave one, else null.
- "chart": "timeseries", "bar" or "stat" if the person asked for a line chart, a bar chart or a single number, else null.
- "split_by": a list of at most three things to split by, in the person's words ("region", "endpoint"), else [].
- "intent": "alert" if the person asks to be alerted or notified when something happens, "collector" if they ask to monitor, poll or check a URL, else "chart".
- "alert": for an alert, {"op": ">" or "<", "threshold": a number, "unit": the threshold's unit as written ("ms", "s", "%") or null, "for": how long it must hold as a duration such as "5m", or null}; else null. "above", "over" and "more than" are ">"; "below" and "under" are "<". For an alert, "measure", "service" and "endpoint" describe what is watched.
- "collector": for a URL to monitor, {"url": the URL exactly as written, "interval": how often as a duration such as "1m", or null}; else null.

Use null when the person did not say. Do not guess."""


def parse_messages(text: str) -> list[ChatMessage]:
    return [
        {'role': 'system', 'content': PARSE_SYSTEM},
        {'role': 'user', 'content': block('request', text)},
    ]


WRITE_SYSTEM = """You write one PromQL query for a chart. Reply with one JSON object and nothing else:
{"query": "...", "title": "...", "unit": "...", "display_unit": "..." or null}

Rules:
1. Use ONLY the series names and label names listed in the context under "metrics". Never invent or guess a name. If the context cannot answer the request, still use only listed names.
2. Standard PromQL only. No time range for the chart inside the query; the only durations allowed are rate windows such as [{RATE_WINDOW}].
3. Never mention a "workspace" label.
4. Apply every decision in the context: service, endpoint, percentile, which requests to count, and what to split by.
5. Keep the number of lines small. Aggregate with sum by (...) and keep only the labels the request splits by.
6. Histograms are stored as three series: <name>_bucket, <name>_sum and <name>_count.
   - A percentile: histogram_quantile(0.95, sum by (le) (rate(<name>_bucket{...}[{RATE_WINDOW}])))
   - Request rate: sum(rate(<name>_count{...}[{RATE_WINDOW}]))
   - Error rate: failed requests (status 5xx) divided by all requests, both from <name>_count, using the status label. When the result is not split by any label, write the failed part as (sum(rate(...)) or vector(0)) so that a period with no failures shows as 0 instead of no data.
   There is no separate request counter.
7. "title" is short: the target, then what is measured, e.g. "POST /checkout/pay · p95 latency".
8. "unit" is what the query returns ("s", "By", "req/s", "%", "1" or a plain word). "display_unit" is a friendlier unit to show ("ms" for a query in seconds), or null.
9. If "previous_attempt" is set, that query failed for the stated reason. Fix that problem.
10. If "change" is set, start from "change.base_query" and make only the change asked for, applying every decision in the context.""".replace(
    '{RATE_WINDOW}', RATE_WINDOW
)


class PreviousAttempt(TypedDict):
    query: str | None
    problem: str


class WriteContext(TypedDict):
    request: str
    measure: str
    kind: str
    service: str | None
    endpoint: dict[str, str] | None
    percentile: float | None
    requests: str | None
    split_by: list[str]
    rate_window: str
    labels: dict[str, str]
    metrics: list[dict[str, Any]]
    previous_attempt: PreviousAttempt | None
    change: NotRequired[dict[str, str] | None]


def write_context(
    state: AgentState, metrics: list[CatalogMetric], previous: PreviousAttempt | None
) -> WriteContext:
    parsed = state['parsed']
    primary = metrics[0]
    decisions = state['decisions']
    service = decisions.get('service')
    endpoint = decisions.get('endpoint')
    labels = {'service': SERVICE_LABEL}
    if METHOD_LABEL in primary['labels']:
        labels['method'] = METHOD_LABEL
    if ROUTE_LABEL in primary['labels']:
        labels['route'] = ROUTE_LABEL
    if STATUS_LABEL in primary['labels']:
        labels['status'] = STATUS_LABEL
    revises = state.get('revises')
    return {
        'request': state['text'],
        'measure': parsed['measure'],
        'kind': parsed['kind'],
        'service': None if service is None or service == '*' else service,
        'endpoint': (
            None
            if endpoint is None or endpoint == 'all'
            else {'method': endpoint['method'], 'route': endpoint['route']}
        ),
        'percentile': decisions.get('percentile'),
        'requests': decisions.get('requests'),
        'split_by': parsed['split_by'],
        'rate_window': RATE_WINDOW,
        'labels': labels,
        'metrics': [
            {
                'name': metric['metricName'],
                'series': metric['series'],
                'type': metric['type'],
                'unit': metric['unit'],
                'labels': metric['labels'],
                'description': metric['description'],
            }
            for metric in metrics
        ],
        'previous_attempt': previous,
        'change': (
            {'base_query': revises['query'], 'asked': state.get('refinement', '')}
            if revises
            else None
        ),
    }


def write_query_messages(context: WriteContext) -> list[ChatMessage]:
    return [
        {'role': 'system', 'content': WRITE_SYSTEM},
        {'role': 'user', 'content': block('context', stringify(context, 2))},
    ]


def extract_json(reply: str) -> Any:
    """Pull the JSON object out of a model reply, tolerating code fences and stray text."""
    start = reply.find('{')
    end = reply.rfind('}')
    if start == -1 or end <= start:
        raise ValueError('The reply contains no JSON object.')
    return json.loads(reply[start : end + 1])
