"""The router's behaviour, case for case with packages/router/src/router.test.ts."""

import json
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
import pytest
import respx

from appcommon.errors import ConfigError
from modelrouter import (
    BudgetExceededError,
    CallRecord,
    CompletionRequest,
    CompletionResponse,
    Eligibility,
    MemoryLedger,
    ModelCallError,
    ModelsConfig,
    NoEligibleModelError,
    OpenRouterTransport,
    Router,
    RouterRequest,
    TaskType,
    load_models,
    parse_models,
)

CONFIG = parse_models("""
strategy: table
auto_model: provider/auto
tiers:
  - id: fast
    models:
      - { id: fast-a, input_per_mtok: 1, output_per_mtok: 1 }
      - { id: fast-cheap, input_per_mtok: 0.1, output_per_mtok: 0.1 }
  - id: standard
    models:
      - { id: std-a, input_per_mtok: 2, output_per_mtok: 10 }
      - { id: std-cheap, input_per_mtok: 1, output_per_mtok: 2 }
  - id: strong
    models:
      - { id: strong-a, input_per_mtok: 4, output_per_mtok: 20 }
tasks: { parse: fast, ask: fast, write_query: standard, explain: strong, review: strong }
budget: { near_cap_ratio: 0.8 }
""")

Complete = Callable[[CompletionRequest], Awaitable[CompletionResponse]]


class FakeTransport:
    def __init__(self, complete: Complete | None = None) -> None:
        self.calls: list[CompletionRequest] = []
        self._complete = complete

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.calls.append(request)
        if self._complete:
            return await self._complete(request)
        return CompletionResponse(content='{"ok":true}', input_tokens=1000, output_tokens=500)

    @property
    def models(self) -> list[str]:
        return [call.model for call in self.calls]


def setup(
    *,
    limit: float | None = None,
    eligibility: Eligibility | None = None,
    config: ModelsConfig = CONFIG,
    complete: Complete | None = None,
) -> tuple[Router, MemoryLedger, FakeTransport]:
    ledger = MemoryLedger(limit=limit)
    transport = FakeTransport(complete)
    router = Router(config=config, eligibility=eligibility, transport=transport, ledger=ledger)
    return router, ledger, transport


def request(task: TaskType, **extra: object) -> RouterRequest:
    return RouterRequest(
        workspace_id='w',
        request_id='r',
        task=task,
        messages=[{'role': 'user', 'content': 'hi'}],
        **extra,  # type: ignore[arg-type]
    )


def old_call(cost: float) -> tuple[str, CallRecord]:
    return (
        'old',
        CallRecord(
            workspace_id='w',
            request_id='old',
            task='parse',
            model='x',
            input_tokens=0,
            output_tokens=0,
            cost=cost,
            outcome='ok',
        ),
    )


@pytest.mark.parametrize(
    ('task', 'model', 'tier'),
    [
        ('parse', 'fast-a', 'fast'),
        ('ask', 'fast-a', 'fast'),
        ('write_query', 'std-a', 'standard'),
        ('explain', 'strong-a', 'strong'),
        ('review', 'strong-a', 'strong'),
    ],
)
async def test_task_type_routing(task: TaskType, model: str, tier: str) -> None:
    router, _, transport = setup()
    reply = await router.call(request(task))
    assert transport.models == [model]
    assert (reply.model, reply.tier, reply.escalated) == (model, tier, False)


async def test_escalates_after_two_failures() -> None:
    router, _, transport = setup()
    for failures in [0, 1, 2, 3]:
        await router.call(request('write_query', failures=failures))
    assert transport.models == ['std-a', 'std-a', 'strong-a', 'strong-a']


async def test_records_which_call_it_escalated_from() -> None:
    router, ledger, _ = setup()
    first = await router.call(request('write_query'))
    escalated = await router.call(
        request('write_query', failures=2, previous_call_id=first.call_id)
    )
    assert escalated.escalated
    assert [call.escalated_from for call in ledger.records] == [None, first.call_id]


async def test_has_nowhere_to_go_from_the_strongest_tier() -> None:
    router, _, _ = setup()
    reply = await router.call(request('explain', failures=5))
    assert (reply.tier, reply.escalated) == ('strong', False)


async def test_uses_the_first_model_well_under_the_cap() -> None:
    router, _, transport = setup(limit=1)
    await router.call(request('write_query'))
    assert transport.models == ['std-a']


async def test_prefers_the_cheapest_eligible_model_near_the_cap() -> None:
    router, ledger, transport = setup(limit=1)
    ledger.calls.append(old_call(0.85))
    await router.call(request('write_query'))
    assert transport.models == ['std-cheap']


async def test_refuses_at_the_cap_without_calling_a_model() -> None:
    router, ledger, transport = setup(limit=1)
    ledger.calls.append(old_call(1))
    with pytest.raises(BudgetExceededError):
        await router.call(request('parse'))
    assert transport.calls == []


async def test_has_no_cap_without_a_limit() -> None:
    router, ledger, _ = setup(limit=None)
    ledger.calls.append(old_call(1_000_000))
    assert await router.call(request('parse'))


def passed(tiers: dict[str, list[str]]) -> Eligibility:
    return Eligibility(updated='test', tiers=tiers)


async def test_uses_only_models_that_passed_for_the_tier() -> None:
    router, _, transport = setup(eligibility=passed({'standard': ['std-cheap']}))
    await router.call(request('write_query'))
    assert transport.models == ['std-cheap']


async def test_a_stronger_tier_may_stand_in() -> None:
    router, _, _ = setup(eligibility=passed({'strong': ['strong-a']}))
    reply = await router.call(request('parse'))
    assert (reply.model, reply.tier) == ('strong-a', 'strong')


async def test_never_falls_back_to_a_weaker_tier() -> None:
    router, _, _ = setup(eligibility=passed({'fast': ['fast-a']}))
    with pytest.raises(NoEligibleModelError):
        await router.call(request('explain'))


async def test_calls_nothing_when_no_model_has_passed() -> None:
    router, _, transport = setup(eligibility=passed({}))
    with pytest.raises(NoEligibleModelError):
        await router.call(request('parse'))
    assert transport.calls == []


async def test_logs_every_call() -> None:
    router, ledger, _ = setup()
    await router.call(request('write_query'))
    assert ledger.calls == [
        (
            'call-1',
            CallRecord(
                workspace_id='w',
                request_id='r',
                task='write_query',
                model='std-a',
                input_tokens=1000,
                output_tokens=500,
                cost=pytest.approx(0.007),  # type: ignore[arg-type]
                outcome='ok',
                escalated_from=None,
            ),
        )
    ]


async def test_uses_the_providers_own_cost_and_model() -> None:
    async def complete(_: CompletionRequest) -> CompletionResponse:
        return CompletionResponse(
            content='x', model='provider/actual', input_tokens=10, output_tokens=10, cost=0.5
        )

    router, ledger, _ = setup(complete=complete)
    reply = await router.call(request('parse'))
    assert (reply.model, reply.cost) == ('provider/actual', 0.5)
    assert (ledger.records[0].model, ledger.records[0].cost) == ('provider/actual', 0.5)


async def test_logs_a_failed_call_then_tries_the_next_model_once() -> None:
    attempts = 0

    async def complete(_: CompletionRequest) -> CompletionResponse:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError('provider down')
        return CompletionResponse(content='x', input_tokens=1, output_tokens=1)

    router, ledger, _ = setup(complete=complete)
    reply = await router.call(request('write_query'))
    assert reply.model == 'std-cheap'
    assert [(c.model, c.outcome) for c in ledger.records] == [
        ('std-a', 'transport_error'),
        ('std-cheap', 'ok'),
    ]


async def test_gives_up_when_the_fallback_fails_too() -> None:
    async def complete(_: CompletionRequest) -> CompletionResponse:
        raise RuntimeError('provider down')

    router, ledger, _ = setup(complete=complete)
    with pytest.raises(ModelCallError, match='provider down'):
        await router.call(request('write_query'))
    assert [c.outcome for c in ledger.records] == ['transport_error', 'transport_error']


async def test_the_caller_records_how_the_output_fared() -> None:
    router, ledger, _ = setup()
    reply = await router.call(request('write_query'))
    await router.report(reply.call_id, 'dry_run_failed')
    assert ledger.records[0].outcome == 'dry_run_failed'


async def test_automatic_routing_sends_every_task_to_the_auto_model() -> None:
    auto = CONFIG.model_copy(update={'strategy': 'openrouter_auto'})
    router, _, transport = setup(config=auto)
    await router.call(request('parse'))
    await router.call(request('explain'))
    assert transport.models == ['provider/auto', 'provider/auto']


def test_loads_the_example_file() -> None:
    path = Path(__file__).resolve().parents[3] / 'config/models.example.yaml'
    loaded = load_models(path)
    assert [tier.id for tier in loaded.tiers] == ['fast', 'standard', 'strong']
    assert loaded.eligibility_file


def test_rejects_a_task_mapped_to_an_unknown_tier() -> None:
    with pytest.raises(ConfigError, match='unknown tier "missing"'):
        parse_models("""
tiers: [{ id: fast, models: [{ id: a, input_per_mtok: 1, output_per_mtok: 1 }] }]
tasks: { parse: fast, ask: fast, write_query: missing, explain: fast, review: fast }
budget: { near_cap_ratio: 0.8 }
""")


@respx.mock
async def test_openrouter_sends_one_completion_and_reads_content_tokens_and_cost() -> None:
    route = respx.post('https://openrouter.ai/api/v1/chat/completions').mock(
        return_value=httpx.Response(
            200,
            json={
                'model': 'vendor/model-x',
                'choices': [{'message': {'content': '{"a":1}'}}],
                'usage': {'prompt_tokens': 12, 'completion_tokens': 3, 'cost': 0.0004},
            },
        )
    )
    transport = OpenRouterTransport(api_key='test-key')
    reply = await transport.complete(
        CompletionRequest(
            model='vendor/model-x',
            messages=[{'role': 'user', 'content': 'hi'}],
            json=True,
            max_tokens=100,
            task='parse',
        )
    )
    assert reply == CompletionResponse(
        content='{"a":1}', model='vendor/model-x', input_tokens=12, output_tokens=3, cost=0.0004
    )
    sent = route.calls.last.request
    assert sent.headers['authorization'] == 'Bearer test-key'
    body = json.loads(sent.content)
    assert body['response_format'] == {'type': 'json_object'}
    assert body['temperature'] == 0
    assert body['model'] == 'vendor/model-x'


@respx.mock
async def test_openrouter_turns_a_provider_error_into_an_exception() -> None:
    respx.post('https://openrouter.ai/api/v1/chat/completions').mock(
        return_value=httpx.Response(429, json={'error': {'message': 'rate limited'}})
    )
    transport = OpenRouterTransport(api_key='k')
    with pytest.raises(RuntimeError, match='rate limited'):
        await transport.complete(
            CompletionRequest(model='m', messages=[], json=False, max_tokens=1, task='parse')
        )
