"""Fixtures and fakes for the agent's tests (apps/agent/src/testing.ts).

Catalog ranking, PromQL analysis and spec validation come from the real
TypeScript code through scripts/py-test-oracle.ts, so the tests exercise the
same rules production reaches through the platform service.
"""

import asyncio
import json
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.catalog import CatalogSearch, CatalogSearchResult
from agent.errors import SpecValidationError
from agent.loop import LoopDependencies
from agent.standin import StandInTransport
from agent.tools import Actor, DryRunResult, SpecKind, ToolBackends
from modelrouter import (
    CompletionRequest,
    CompletionResponse,
    MemoryLedger,
    Router,
    parse_models,
)

ROOT = Path(__file__).resolve().parents[3]


class Oracle:
    """One long-lived Node process answering with the TypeScript rules."""

    def __init__(self) -> None:
        self._process = subprocess.Popen(
            ['node', '--import', 'tsx', 'scripts/py-test-oracle.ts'],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._lock = threading.Lock()

    def ask(self, request: dict[str, Any]) -> Any:
        assert self._process.stdin and self._process.stdout
        with self._lock:
            self._process.stdin.write(json.dumps(request) + '\n')
            self._process.stdin.flush()
            reply = json.loads(self._process.stdout.readline())
        if 'error' in reply:
            raise RuntimeError(reply['error'])
        return reply['result']

    def close(self) -> None:
        self._process.terminate()


_oracle: Oracle | None = None


def oracle() -> Oracle:
    global _oracle
    if _oracle is None:
        _oracle = Oracle()
    return _oracle


def _metric(
    service: str,
    metric_name: str,
    stored: str,
    type_: str,
    unit: str,
    description: str,
    labels: list[str],
) -> dict[str, Any]:
    series = (
        [f'{stored}_bucket', f'{stored}_sum', f'{stored}_count']
        if type_ == 'histogram'
        else [stored]
    )
    return {
        'service': service,
        'metricName': metric_name,
        'storedName': stored,
        'series': series,
        'type': type_,
        'unit': unit,
        'labels': ['service_name', *labels],
        'description': description,
        'lastSeen': None,
    }


_HTTP_LABELS = ['http_request_method', 'http_route', 'http_response_status_code', 'le']


def _http(service: str) -> dict[str, Any]:
    return _metric(
        service,
        'http.server.request.duration',
        'http_server_request_duration_seconds',
        'histogram',
        's',
        'Duration of requests this service handles',
        _HTTP_LABELS,
    )


CATALOG: dict[str, Any] = {
    'services': ['checkout', 'inventory'],
    'metrics': [
        _http('checkout'),
        _metric('checkout', 'orders.completed', 'orders_completed_total', 'counter', '{order}', 'Orders paid successfully', ['payment_method']),
        _http('inventory'),
        _metric('inventory', 'stock.level', 'stock_level', 'gauge', '{item}', 'Units in stock per warehouse', ['warehouse']),
    ],
    'endpoints': [
        {'service': 'checkout', 'method': 'POST', 'route': '/checkout/pay', 'description': '', 'lastSeen': None, 'requestRate': 1.2, 'p95': 0.8},
        {'service': 'checkout', 'method': 'GET', 'route': '/checkout/summary', 'description': '', 'lastSeen': None, 'requestRate': 3.8, 'p95': 0.05},
        {'service': 'inventory', 'method': 'GET', 'route': '/items/{id}', 'description': '', 'lastSeen': None, 'requestRate': 2, 'p95': 0.02},
    ],
}  # fmt: skip

#: One fast tier, one strong tier, no eligibility file: enough to see escalation.
TEST_MODELS = parse_models("""
tiers:
  - { id: fast, models: [{ id: test-fast, input_per_mtok: 1, output_per_mtok: 1 }] }
  - { id: strong, models: [{ id: test-strong, input_per_mtok: 10, output_per_mtok: 10 }] }
tasks: { parse: fast, ask: fast, write_query: fast, explain: strong, review: strong }
budget: { near_cap_ratio: 0.8 }
""")


async def analyze(query: str) -> dict[str, Any]:
    return await asyncio.to_thread(oracle().ask, {'op': 'analyze', 'query': query})


async def validate(kind: SpecKind, spec: Any) -> dict[str, Any]:
    reply = await asyncio.to_thread(oracle().ask, {'op': 'validate', 'kind': kind, 'spec': spec})
    if not reply['ok']:
        raise SpecValidationError(reply['error'])
    spec_out: dict[str, Any] = reply['spec']
    return spec_out


@dataclass
class Harness:
    deps: LoopDependencies
    model_calls: list[CompletionRequest] = field(default_factory=list)
    dry_runs: list[tuple[str, str]] = field(default_factory=list)
    saved: list[tuple[dict[str, Any], Actor, str | None, str | None]] = field(default_factory=list)
    alerts: list[dict[str, Any]] = field(default_factory=list)
    collectors: list[dict[str, Any]] = field(default_factory=list)
    ledger: MemoryLedger = field(default_factory=MemoryLedger)


class _Transport:
    def __init__(
        self, harness: 'Harness', write_query: Callable[[int, CompletionRequest], str] | None
    ):
        self.harness = harness
        self.write_query = write_query
        self.writes = 0
        self.stand_in = StandInTransport()

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.harness.model_calls.append(request)
        if request.task == 'write_query' and self.write_query:
            self.writes += 1
            return CompletionResponse(
                content=self.write_query(self.writes, request), input_tokens=100, output_tokens=50
            )
        return await self.stand_in.complete(request)


def create_harness(
    *,
    catalog: dict[str, Any] | None = None,
    dry_run: Callable[[str, str], dict[str, Any]] | None = None,
    write_query: Callable[[int, CompletionRequest], str] | None = None,
    budget_limit: float | None = None,
) -> Harness:
    """A loop wired to fakes. The model is the stand-in unless write_query scripts it."""
    harness = Harness(deps=None)  # type: ignore[arg-type]
    harness.ledger = MemoryLedger(limit=budget_limit)
    contents = catalog or CATALOG

    async def search_catalog(search: CatalogSearch) -> CatalogSearchResult:
        result: CatalogSearchResult = await asyncio.to_thread(
            oracle().ask, {'op': 'rank', 'catalog': contents, 'search': search}
        )
        return result

    async def fake_dry_run(query: str, range_: str) -> DryRunResult:
        harness.dry_runs.append((query, range_))
        result: dict[str, Any] = {'ok': True, 'lineCount': 1, 'durationMs': 5, 'sample': []}
        if dry_run:
            result.update(dry_run(query, range_))
        return result  # type: ignore[return-value]

    async def draft_alert(spec: dict[str, Any], actor: Actor) -> dict[str, str]:
        harness.alerts.append(spec)
        return {'ruleId': f'rule-{len(harness.alerts)}'}

    async def draft_collector(spec: dict[str, Any], actor: Actor) -> dict[str, Any]:
        harness.collectors.append(spec)
        return {
            'collectorId': f'collector-{len(harness.collectors)}',
            'test': {'ok': True, 'status': 200, 'duration': 0.05},
        }

    async def save_panel(
        spec: dict[str, Any], actor: Actor, dashboard_id: str | None, panel_id: str | None
    ) -> Any:
        harness.saved.append((spec, actor, dashboard_id, panel_id))
        return {'panelId': 'panel-1', 'version': 1, 'dashboardId': dashboard_id or 'dashboard-1'}

    backends = ToolBackends(
        search_catalog=search_catalog,
        dry_run=fake_dry_run,
        save_panel=save_panel,
        analyze=analyze,
        validate=validate,
        draft_alert=draft_alert,
        draft_collector=draft_collector,
    )
    router = Router(
        config=TEST_MODELS,
        eligibility=None,
        transport=_Transport(harness, write_query),
        ledger=harness.ledger,
    )
    harness.deps = LoopDependencies(router=router, backends=backends, default_range='6h')
    return harness
