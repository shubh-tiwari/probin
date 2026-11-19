"""explain_series for an alert (apps/agent/src/explain-rule.ts).

The rule's own query and the related series of its service over the last two
hours, split at the moment the alert started. The result is a hypothesis with
the charts behind it, and it is added to the incident in memory.
"""

import asyncio
import re
import time
import uuid
from datetime import datetime
from typing import Any

from agent.clients import Platform, QueryApi
from agent.explain import (
    SeriesChange,
    Source,
    measure_changes,
    rank_changes,
    related_queries,
    write_hypothesis,
)
from appcommon.format import display_unit, format_value, series_name
from modelrouter import Router

#: How far back the explanation looks.
WINDOW = '2h'
WINDOW_SECONDS = 7200


async def explain_rule(
    *, platform: Platform, query_api: QueryApi, router: Router, workspace_id: str, rule_id: str
) -> dict[str, Any] | None:
    rule = await platform.alert(rule_id)
    if not rule:
        return None
    spec = rule['spec']
    now = int(time.time())
    since = rule.get('since')
    pivot = int(datetime.fromisoformat(since).timestamp()) if since else now - WINDOW_SECONDS // 4

    sources: list[Source] = []
    if spec.get('query'):
        own: Source = {
            'title': re.sub(r' (above|below) .*$', '', spec['name']),
            'query': spec['query'],
            'unit': spec.get('unit') or '',
        }
        if spec.get('display_unit'):
            own['display_unit'] = spec['display_unit']
        sources.append(own)
    if spec.get('service'):
        sources += related_queries(spec['service'], await platform.list_metrics(spec['service']))

    async def measure(source: Source) -> list[SeriesChange]:
        try:
            result = await query_api.query(source['query'], WINDOW, 60)
        except Exception:
            return []
        return measure_changes(source, result, pivot)

    results = await asyncio.gather(*(measure(source) for source in sources))
    ranked = rank_changes([change for found in results for change in found])[:5]

    def describe(change: SeriesChange) -> dict[str, str]:
        unit = display_unit(change['unit'], change.get('display_unit'))
        which = series_name(change['labels'])
        return {
            'series': change['title'] if which == 'all' else f'{change["title"]} ({which})',
            'before': format_value(change['before'], unit),
            'after': format_value(change['after'], unit),
        }

    text, _ = await write_hypothesis(
        router,
        workspace_id=workspace_id,
        request_id=str(uuid.uuid4()),
        alert_name=spec['name'],
        changes=[describe(change) for change in ranked],
    )

    charts: dict[str, dict[str, Any]] = {}
    for change in ranked:
        if change['query'] in charts:
            continue
        chart: dict[str, Any] = {
            'title': change['title'],
            'query': change['query'],
            'unit': change['unit'],
        }
        if change.get('display_unit'):
            chart['display_unit'] = change['display_unit']
        chart['range'] = WINDOW
        charts[change['query']] = chart

    # Remember it with the incident, so Review and later explanations can see it.
    await platform.write_incident(
        {
            'subject': spec['name'],
            'text': text,
            'source': f'explanation of alert rule {rule["id"]}',
            'value': {'ruleId': rule['id']},
        }
    )
    return {'hypothesis': text, 'charts': list(charts.values())[:2], 'changes': ranked}
