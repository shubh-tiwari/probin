"""Catalog grounding, in code (apps/agent/src/grounding.ts).

A generated query may only use metric and label names that search_catalog
returned. This is the rule; the prompt asking the model to behave is only a
courtesy. It fails closed: a query that cannot be parsed, or a selector that
does not name one exact metric, is a violation. The query is read by the same
parser that scopes queries to a workspace, through the platform service.
"""

from collections.abc import Awaitable, Callable
from typing import Any, NotRequired, TypedDict

from agent.state import Allowed

#: Reads a query: {"ok": True, "names": {...}, "selectors": [...]} or {"ok": False, "error": ...}.
Analyze = Callable[[str], Awaitable[dict[str, Any]]]


class Grounding(TypedDict):
    ok: bool
    violations: NotRequired[list[str]]
    message: NotRequired[str]


async def check_grounding(query: str, allowed: Allowed, analyze: Analyze) -> Grounding:
    analysis = await analyze(query)
    if not analysis.get('ok'):
        return {'ok': False, 'violations': [], 'message': str(analysis.get('error', ''))}
    names = analysis['names']
    metrics = set(allowed['metrics'])
    labels = set(allowed['labels'])
    violations = [
        *(f'metric: {name}' for name in names['metrics'] if name not in metrics),
        *(f'label: {name}' for name in names['labels'] if name not in labels),
        *(f'selector without one exact metric: {s}' for s in names['unnamedSelectors']),
    ]
    if not violations:
        return {'ok': True}
    return {
        'ok': False,
        'violations': violations,
        'message': f'The query uses names that are not in the catalog: {"; ".join(violations)}.',
    }
