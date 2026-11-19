"""The agent's tools for one request (apps/agent/src/tools.ts).

The agent may only act through these, and each one enforces its rule itself,
whatever the caller or the model intended:

- search_catalog is the only source of names; it records what it returned.
- run_query refuses names the search did not return, then dry-runs.
- ask_user refuses a third question.
- save_panel refuses a query that has not passed run_query here.

The tools write to the state, which is the request's record.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, NotRequired, TypedDict

from agent.catalog import CatalogSearch, CatalogSearchResult
from agent.errors import ToolRefusal
from agent.grounding import check_grounding
from agent.state import AgentState, CheckResult, Question, Saved

#: The most questions one request may ask, counting the endpoint question.
MAX_QUESTIONS = 2

SpecKind = Literal['panel', 'alert', 'collector']


class Actor(TypedDict):
    kind: Literal['user', 'agent', 'system']
    id: str


class DryRunResult(TypedDict):
    ok: bool
    lineCount: int
    durationMs: float
    sample: list[dict[str, Any]]
    error: NotRequired[dict[str, Any]]


class ResolvedRequest(TypedDict):
    """A request already turned into a tested query."""

    panel: dict[str, Any]
    parsed: Any
    decisions: Any
    #: The services its query reads.
    services: list[str]
    fingerprint: str


@dataclass
class ResolvedCache:
    """The resolved-request cache: identical requests reuse a tested query."""

    get: Callable[[str], Awaitable[ResolvedRequest | None]]
    put: Callable[[str, ResolvedRequest], Awaitable[None]]
    #: The catalog fingerprint of some services now.
    fingerprint: Callable[[list[str]], Awaitable[str]]
    #: Every name the catalog has for some services: {"metrics": [...], "labels": [...]}.
    names: Callable[[list[str]], Awaitable[dict[str, list[str]]]]


@dataclass
class ToolBackends:
    """What the tools reach the outside world through. All of it is scoped to one workspace."""

    search_catalog: Callable[[CatalogSearch], Awaitable[CatalogSearchResult]]
    dry_run: Callable[[str, str], Awaitable[DryRunResult]]
    #: (spec, actor, dashboard id, panel id): with a panel id, a new version of that panel.
    save_panel: Callable[[dict[str, Any], Actor, str | None, str | None], Awaitable[Saved]]
    #: Reads a query with the parser that scopes queries (see grounding.check_grounding).
    analyze: Callable[[str], Awaitable[dict[str, Any]]]
    #: Validates a spec with the shared schema; raises SpecValidationError.
    validate: Callable[[SpecKind, Any], Awaitable[dict[str, Any]]]
    draft_alert: Callable[[dict[str, Any], Actor], Awaitable[dict[str, str]]] | None = None
    draft_collector: Callable[[dict[str, Any], Actor], Awaitable[dict[str, Any]]] | None = None
    resolved: ResolvedCache | None = None


class RunQueryResult(TypedDict):
    ok: bool
    lineCount: NotRequired[int]
    dryRun: NotRequired[DryRunResult]
    reason: NotRequired[str]
    ungrounded: NotRequired[list[str]]


class Toolbox:
    def __init__(self, state: AgentState, backends: ToolBackends) -> None:
        self.state = state
        self.backends = backends

    def _actor(self) -> Actor:
        return {'kind': 'user', 'id': self.state['userId']}

    async def search_catalog(self, search: CatalogSearch) -> CatalogSearchResult:
        """search_catalog: free text and an optional service. Records the names it returned."""
        result = await self.backends.search_catalog(search)
        metrics = set(self.state['allowed']['metrics'])
        labels = set(self.state['allowed']['labels'])
        for metric in result['metrics']:
            metrics.update(metric['series'])
            labels.update(metric['labels'])
        self.state['allowed'] = {'metrics': sorted(metrics), 'labels': sorted(labels)}
        return result

    async def run_query(self, query: str, range_: str) -> RunQueryResult:
        """run_query: the dry run. A query that fails here never reaches a person or a spec."""
        grounding = await check_grounding(query, self.state['allowed'], self.backends.analyze)
        if not grounding['ok']:
            return {
                'ok': False,
                'reason': grounding.get('message', ''),
                'ungrounded': grounding.get('violations', []),
            }
        dry_run = await self.backends.dry_run(query, range_)
        if not dry_run['ok']:
            error = dry_run.get('error') or {}
            return {
                'ok': False,
                'reason': error.get('message') or 'The query failed.',
                'lineCount': dry_run['lineCount'],
            }
        if dry_run['lineCount'] == 0:
            return {'ok': False, 'reason': 'The query ran but returned no data.', 'lineCount': 0}
        if query not in self.state['testedQueries']:
            self.state['testedQueries'].append(query)
        return {'ok': True, 'lineCount': dry_run['lineCount'], 'dryRun': dry_run}

    def ask_user(self, question: Question) -> None:
        """ask_user: one question. The answer arrives later as an event."""
        if len(self.state['questionsAsked']) >= MAX_QUESTIONS:
            raise ToolRefusal(
                'question_limit',
                f'A request may ask at most {MAX_QUESTIONS} questions. '
                'State an assumption instead.',
            )
        if question['kind'] == 'choice' and not 2 <= len(question['options']) <= 6:
            raise ValueError('A question needs 2 to 6 options.')
        self.state['questionsAsked'].append(question['id'])
        self.state['question'] = question
        self.state['status'] = 'question'

    async def draft_alert(self, spec: dict[str, Any]) -> dict[str, str]:
        """draft_alert: a pending rule. Its query must have passed the dry run here."""
        if not self.backends.draft_alert:
            raise RuntimeError('Alerts are not available.')
        valid = await self.backends.validate('alert', spec)
        if valid.get('query') and valid['query'] not in self.state['testedQueries']:
            raise ToolRefusal(
                'dry_run_before_display', 'The query behind this alert has not passed a dry run.'
            )
        grounding = await check_grounding(
            valid['expr'], self.state['allowed'], self.backends.analyze
        )
        if not grounding['ok']:
            raise ToolRefusal('catalog_grounding', grounding.get('message', ''))
        return await self.backends.draft_alert(valid, self._actor())

    async def draft_collector(self, spec: dict[str, Any]) -> dict[str, Any]:
        """draft_collector: a pending collector after one test fetch."""
        if not self.backends.draft_collector:
            raise RuntimeError('Data sources are not available.')
        valid = await self.backends.validate('collector', spec)
        return await self.backends.draft_collector(valid, self._actor())

    async def save_panel(self, spec: dict[str, Any], dashboard_id: str | None) -> Saved:
        """save_panel: writes a spec. Only for a query that passed the dry run in this request."""
        valid = await self.backends.validate('panel', spec)
        if valid['query'] not in self.state['testedQueries']:
            raise ToolRefusal(
                'dry_run_before_display',
                'This query has not passed a dry run in this request, so it cannot be saved.',
            )
        grounding = await check_grounding(
            valid['query'], self.state['allowed'], self.backends.analyze
        )
        if not grounding['ok']:
            raise ToolRefusal('catalog_grounding', grounding.get('message', ''))
        revises: dict[str, Any] = dict(self.state.get('revises') or {})
        return await self.backends.save_panel(
            valid, self._actor(), dashboard_id, revises.get('panelId')
        )


__all__ = [
    'MAX_QUESTIONS',
    'Actor',
    'CheckResult',
    'DryRunResult',
    'ResolvedCache',
    'ResolvedRequest',
    'RunQueryResult',
    'SpecKind',
    'ToolBackends',
    'Toolbox',
]
