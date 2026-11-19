"""Why did an alert fire: related series, how they moved, and a labelled hypothesis.

Port of apps/agent/src/explain.ts.
"""

import json
import math
import re
from typing import Any, NotRequired, TypedDict

from agent.catalog import (
    HTTP_CLIENT_DURATION,
    HTTP_SERVER_DURATION,
    METHOD_LABEL,
    ROUTE_LABEL,
    SERVICE_LABEL,
    STATUS_LABEL,
    CatalogMetric,
)
from agent.jsonjs import stringify
from agent.prompts import extract_json, read_block
from modelrouter import ChatMessage, Router, RouterRequest


class Source(TypedDict):
    title: str
    query: str
    unit: str
    display_unit: NotRequired[str]


class SeriesChange(Source):
    #: Mean before and after the change point, in the query's unit.
    before: float
    after: float
    #: after / before; infinity when it started from zero.
    ratio: float
    labels: dict[str, str]


def _q(value: str) -> str:
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def related_queries(service: str, metrics: list[CatalogMetric]) -> list[Source]:
    """The related series worth looking at: traffic, errors, latency, and calls out."""
    s = f'{SERVICE_LABEL}={_q(service)}'

    def has(stored: str) -> bool:
        return any(m['service'] == service and m['storedName'] == stored for m in metrics)

    out: list[Source] = []
    if has(HTTP_SERVER_DURATION):
        by = f'{METHOD_LABEL}, {ROUTE_LABEL}'
        out += [
            {
                'title': f'{service} · p95 latency by endpoint',
                'query': (
                    f'histogram_quantile(0.95, sum by (le, {by}) '
                    f'(rate({HTTP_SERVER_DURATION}_bucket{{{s}}}[5m])))'
                ),
                'unit': 's',
                'display_unit': 'ms',
            },
            {
                'title': f'{service} · requests per second by endpoint',
                'query': f'sum by ({by}) (rate({HTTP_SERVER_DURATION}_count{{{s}}}[5m]))',
                'unit': 'req/s',
            },
            {
                'title': f'{service} · failed requests per second by endpoint',
                'query': (
                    f'sum by ({by}) (rate({HTTP_SERVER_DURATION}_count'
                    f'{{{s}, {STATUS_LABEL}=~"5.."}}[5m]))'
                ),
                'unit': 'req/s',
            },
        ]
    if has(HTTP_CLIENT_DURATION):
        out.append(
            {
                'title': f'{service} · p95 latency of calls to other services',
                'query': (
                    'histogram_quantile(0.95, sum by (le, server_address) '
                    f'(rate({HTTP_CLIENT_DURATION}_bucket{{{s}}}[5m])))'
                ),
                'unit': 's',
                'display_unit': 'ms',
            }
        )
    return out


def _mean(values: list[float]) -> float:
    return math.nan if not values else sum(values) / len(values)


def measure_changes(source: Source, result: dict[str, Any], pivot: float) -> list[SeriesChange]:
    """Split each line of a query result at `pivot` and measure how much it moved."""
    changes: list[SeriesChange] = []
    for series in result['series']:
        points = series['points']
        before = _mean([v for t, v in points if t < pivot])
        after = _mean([v for t, v in points if t >= pivot])
        if not (math.isfinite(before) and math.isfinite(after)):
            continue
        ratio = (1.0 if after == 0 else math.inf) if before == 0 else after / before
        change: SeriesChange = {
            **source,
            'before': before,
            'after': after,
            'ratio': ratio,
            'labels': series['labels'],
        }
        changes.append(change)
    return changes


def _size(change: SeriesChange) -> float:
    """How big a change is, either way: 2x up and 2x down score the same."""
    if change['ratio'] == math.inf or change['ratio'] <= 0:
        return 10
    return abs(math.log(change['ratio']))


def rank_changes(changes: list[SeriesChange], minimum: float = 0.15) -> list[SeriesChange]:
    return sorted((c for c in changes if _size(c) >= minimum), key=_size, reverse=True)


EXPLAIN_SYSTEM = """An alert fired. You are given the alert and how related series changed around the time it started. Write a short hypothesis about why, for an engineer on call.

Rules:
1. It is a hypothesis, not a finding. Start with "Hypothesis:" and use words such as "likely" or "may". Never claim a cause is certain.
2. Use only the series listed. Name the series and the numbers that support the hypothesis.
3. If nothing changed much, say that the related series do not explain it and suggest what to check.
4. At most three sentences.

Reply with one JSON object: {"hypothesis": "..."}"""  # noqa: E501


def explain_messages(context: Any) -> list[ChatMessage]:
    return [
        {'role': 'system', 'content': EXPLAIN_SYSTEM},
        {'role': 'user', 'content': f'<explain>\n{stringify(context, 2)}\n</explain>'},
    ]


def stand_in_hypothesis(messages: list[ChatMessage]) -> str:
    """The stand-in's hypothesis: names the biggest change. Used when no model key is set."""
    context = json.loads(read_block(messages, 'explain') or '{}')
    changes = context.get('changes') or []
    if not changes:
        return (
            'Hypothesis: the related series did not change much, so they do not explain this. '
            'Check recent deploys and the services this one depends on.'
        )
    top = changes[0]
    text = (
        f'Hypothesis: this is likely related to {top["series"]}, which moved from '
        f'{top["before"]} to {top["after"]} around the time the alert started.'
    )
    if len(changes) > 1:
        second = changes[1]
        text += f' {second["series"]} also changed, from {second["before"]} to {second["after"]}.'
    return text


async def write_hypothesis(
    router: Router,
    *,
    workspace_id: str,
    request_id: str,
    alert_name: str,
    changes: list[dict[str, str]],
) -> tuple[str, float]:
    """Ask the router for a hypothesis about the ranked changes. Enforces the label."""
    reply = await router.call(
        RouterRequest(
            workspace_id=workspace_id,
            request_id=request_id,
            task='explain',
            messages=explain_messages({'alert': {'name': alert_name}, 'changes': changes}),
            json=True,
            max_tokens=400,
        )
    )
    try:
        text = str(extract_json(reply.content).get('hypothesis') or '').strip()
    except (ValueError, AttributeError):
        text = ''
    if not text:
        await router.report(reply.call_id, 'invalid_output')
        text = 'the related series could not be summarised.'
    if not re.match(r'hypothesis:', text, re.IGNORECASE):
        text = f'Hypothesis: {text}'
    return text, reply.cost
