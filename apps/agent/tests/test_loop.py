"""The loop's behaviour, case for case with apps/agent/src/loop.test.ts."""

import json
from typing import Any

import pytest

from agent.errors import InvalidEventError, ToolRefusal
from agent.grounding import check_grounding
from agent.loop import (
    advance,
    decisions_from_query,
    new_request,
    rememberable_answers,
    seed_refinement,
)
from agent.state import AgentOutput, AgentState
from agent.tools import ResolvedCache, ResolvedRequest, Toolbox

from .harness import CATALOG, Harness, analyze, create_harness, oracle


def request(text: str) -> AgentState:
    return new_request(workspace_id='w', user_id='u1', text=text)


async def run(
    text: str, answers: list[str] | None = None, harness: Harness | None = None
) -> tuple[AgentState, list[AgentOutput], AgentOutput, Harness]:
    """Start a request and answer every question with the given values, in order."""
    harness = harness or create_harness()
    state = request(text)
    outputs = [await advance(state, {'type': 'start'}, harness.deps)]
    for value in answers or []:
        outputs.append(await advance(state, {'type': 'answer', 'value': value}, harness.deps))
    return state, outputs, outputs[-1], harness


def kinds(outputs: list[AgentOutput]) -> list[str]:
    return [output['kind'] for output in outputs]


EXAMPLE = 'latency graph of checkout service in last 5 hr'


def test_label_names_match_the_catalog_package() -> None:
    from agent import catalog

    names = oracle().ask({'op': 'constants'})
    assert names == {
        'SERVICE_LABEL': catalog.SERVICE_LABEL,
        'METHOD_LABEL': catalog.METHOD_LABEL,
        'ROUTE_LABEL': catalog.ROUTE_LABEL,
        'STATUS_LABEL': catalog.STATUS_LABEL,
        'HTTP_SERVER_DURATION': catalog.HTTP_SERVER_DURATION,
        'HTTP_CLIENT_DURATION': catalog.HTTP_CLIENT_DURATION,
    }


# The build plan example ----------------------------------------------------


async def test_asks_which_endpoint_with_real_endpoints_tags_and_all_last() -> None:
    _, _, last, _ = await run(EXAMPLE)
    assert last['kind'] == 'question'
    assert last['questionsLeft'] == 1
    assert last['question'] == {
        'id': 'endpoint',
        'kind': 'endpoint',
        'text': 'Which endpoint?',
        'options': [
            {'value': 'POST /checkout/pay', 'label': 'POST /checkout/pay', 'tags': ['Slowest']},
            {
                'value': 'GET /checkout/summary',
                'label': 'GET /checkout/summary',
                'tags': ['Busiest'],
            },
            {'value': 'all', 'label': 'All endpoints combined'},
        ],
    }


async def test_then_asks_one_more_question_and_defaults_the_rest() -> None:
    state, outputs, _last, _ = await run(EXAMPLE, ['POST /checkout/pay', '95'])
    assert kinds(outputs) == ['question', 'question', 'draft']
    assert outputs[1]['question']['id'] == 'percentile'
    assert outputs[1]['questionsLeft'] == 0
    assert state['questionsAsked'] == ['endpoint', 'percentile']
    assert state['defaulted'] == ['requests']


async def test_produces_the_panel_spec_from_the_plan() -> None:
    _, _, last, _ = await run(EXAMPLE, ['POST /checkout/pay', '95'])
    assert last['kind'] == 'draft'
    assert last['panel'] == {
        'title': 'POST /checkout/pay · p95 latency',
        'type': 'timeseries',
        'query': (
            'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket'
            '{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))'
        ),
        'unit': 's',
        'display_unit': 'ms',
        'range': '5h',
        'thresholds': [],
        'request': EXAMPLE,
        'assumptions': ['p95', 'all requests including failures', 'all regions combined'],
    }


# Questions -----------------------------------------------------------------


async def test_never_asks_more_than_two() -> None:
    state, outputs, _, _ = await run('latency', ['checkout', 'all'])
    assert kinds(outputs) == ['question', 'question', 'draft']
    assert state['questionsAsked'] == ['service', 'endpoint']
    assert state['defaulted'] == ['percentile', 'requests']
    assert state['decisions']['percentile'] == 95
    assert state['decisions']['requests'] == 'all'


async def test_asks_nothing_when_the_request_says_everything() -> None:
    state, outputs, _, _ = await run(
        'p99 latency of POST /checkout/pay on checkout service including failures in last 30 min'
    )
    assert kinds(outputs) == ['draft']
    assert state['questionsAsked'] == []
    assert state['decisions'] == {
        'service': 'checkout',
        'endpoint': {'method': 'POST', 'route': '/checkout/pay'},
        'percentile': 99,
        'requests': 'all',
    }


async def test_no_endpoint_question_when_the_service_has_one() -> None:
    state, _, last, _ = await run('p95 latency of inventory service including failures')
    assert last['kind'] == 'draft'
    assert state['decisions']['endpoint'] == {'method': 'GET', 'route': '/items/{id}'}


async def test_no_endpoint_or_percentile_question_for_a_business_metric() -> None:
    state, outputs, _, _ = await run('orders completed on checkout service in last 24 hours')
    assert kinds(outputs) == ['draft']
    assert state['decisions'] == {'service': 'checkout'}
    assert outputs[0]['panel']['query'] == (
        'sum (rate(orders_completed_total{service_name="checkout"}[5m]))'
    )


async def test_no_endpoint_question_when_split_by_endpoint() -> None:
    state, _, last, _ = await run(
        'p95 latency of checkout service by endpoint including failures in last 6 hours'
    )
    assert state['questionsAsked'] == []
    assert last['kind'] == 'draft'
    assert last['panel']['query'] == (
        'histogram_quantile(0.95, sum by (le, http_route) '
        '(rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[5m])))'
    )
    assert last['panel']['assumptions'] == [
        'p95',
        'all requests including failures',
        'all regions combined',
    ]


async def test_refuses_an_answer_that_is_not_an_option_and_keeps_waiting() -> None:
    state, _, _, harness = await run(EXAMPLE)
    with pytest.raises(InvalidEventError):
        await advance(state, {'type': 'answer', 'value': 'DELETE /everything'}, harness.deps)
    assert state['status'] == 'question'
    assert state['questionsAsked'] == ['endpoint']


def test_the_tool_itself_refuses_a_third_question() -> None:
    state = request('x')
    state['questionsAsked'] = ['endpoint', 'percentile']
    tools = Toolbox(state, create_harness().deps.backends)
    with pytest.raises(ToolRefusal):
        tools.ask_user(
            {
                'id': 'requests',
                'kind': 'choice',
                'text': '?',
                'options': [{'value': 'a', 'label': 'a'}, {'value': 'b', 'label': 'b'}],
            }
        )


# Saved answers -------------------------------------------------------------


async def test_uses_saved_answers_instead_of_asking() -> None:
    harness = create_harness()
    state = new_request(
        workspace_id='w',
        user_id='u1',
        text='latency of POST /checkout/pay on checkout service',
        user_defaults={'percentile': 99, 'requests': 'successful_only'},
    )
    out = await advance(state, {'type': 'start'}, harness.deps)
    assert state['questionsAsked'] == []
    assert state['fromUserDefaults'] == ['percentile', 'requests']
    assert out['kind'] == 'draft'
    assert {'p99', 'successful requests only'} <= set(out['panel']['assumptions'])


async def test_offers_to_save_only_percentile_and_requests() -> None:
    state, _, _, _ = await run(EXAMPLE, ['POST /checkout/pay', '50'])
    assert rememberable_answers(state) == {'percentile': 50}


# Resolved-request cache ----------------------------------------------------

CACHED_TEXT = (
    'p95 latency of POST /checkout/pay on checkout service including failures in last 1 hour'
)


def cached_harness() -> tuple[Harness, dict[str, ResolvedRequest], list[str]]:
    store: dict[str, ResolvedRequest] = {}
    fingerprint = ['v1']
    harness = create_harness()

    async def get(key: str) -> ResolvedRequest | None:
        return store.get(key)

    async def put(key: str, entry: ResolvedRequest) -> None:
        store[key] = json.loads(json.dumps(entry))

    async def current(_: list[str]) -> str:
        return fingerprint[0]

    async def names(_: list[str]) -> dict[str, list[str]]:
        return {
            'metrics': [s for m in CATALOG['metrics'] for s in m['series']],
            'labels': list(
                dict.fromkeys(label for m in CATALOG['metrics'] for label in m['labels'])
            ),
        }

    harness.deps.backends.resolved = ResolvedCache(
        get=get, put=put, fingerprint=current, names=names
    )
    return harness, store, fingerprint


async def test_reuses_the_query_for_the_same_words() -> None:
    harness, store, _ = cached_harness()
    await run(CACHED_TEXT, [], harness)
    assert len(store) == 1
    calls = len(harness.model_calls)
    runs = len(harness.dry_runs)
    state, _, last, _ = await run(f'  {CACHED_TEXT.upper()}? ', [], harness)
    assert len(harness.model_calls) == calls
    assert len(harness.dry_runs) == runs + 1
    assert state.get('fromCache') is True
    assert last['kind'] == 'draft'
    assert 'the same choices as the last time this was asked' in last['panel']['assumptions']


async def test_no_reuse_once_the_catalog_changed() -> None:
    harness, _, fingerprint = cached_harness()
    await run(CACHED_TEXT, [], harness)
    fingerprint[0] = 'v2'
    calls = len(harness.model_calls)
    state, _, _, _ = await run(CACHED_TEXT, [], harness)
    assert 'fromCache' not in state
    assert len(harness.model_calls) > calls


async def test_no_reuse_of_a_query_that_no_longer_passes() -> None:
    harness, _, _ = cached_harness()
    await run(CACHED_TEXT, [], harness)
    empty = [True]
    real = harness.deps.backends.dry_run

    async def flaky(query: str, range_: str) -> Any:
        if empty[0]:
            empty[0] = False
            return {'ok': True, 'lineCount': 0, 'durationMs': 1, 'sample': []}
        return await real(query, range_)

    harness.deps.backends.dry_run = flaky
    state, _, _, _ = await run(CACHED_TEXT, [], harness)
    assert 'fromCache' not in state
    assert state['status'] == 'draft'


# Alerts --------------------------------------------------------------------


async def test_alert_from_text_is_a_pending_rule_on_a_tested_query() -> None:
    harness = create_harness()
    state = new_request(
        workspace_id='w',
        user_id='u1',
        text=(
            'alert me if p95 latency of POST /checkout/pay on checkout service including '
            'failures goes above 800 ms for 5 min'
        ),
        channel='#C0OPS',
    )
    out = await advance(state, {'type': 'start'}, harness.deps)
    assert out['kind'] == 'alert'
    assert out['ruleId'] == 'rule-1'
    rule = harness.alerts[0]
    assert rule['status'] == 'pending'
    assert rule['for'] == '5m'
    assert rule['channel'] == '#C0OPS'
    assert rule['comparison'] == {'op': '>', 'threshold': 0.8}
    assert rule['expr'] == f'({rule["query"]}) > 0.8'
    assert rule['service'] == 'checkout'
    assert rule['name'] == 'POST /checkout/pay · p95 latency above 800 ms'
    assert rule['query'] in state['testedQueries']


async def test_suggests_a_threshold_from_the_data_and_says_so() -> None:
    harness = create_harness(
        dry_run=lambda _q, _r: {
            'sample': [
                {'labels': {}, 'points': 3, 'first': 0.4, 'last': 0.6, 'min': 0.4, 'max': 0.72}
            ]
        }
    )
    state, _, _, _ = await run(
        'p95 latency of POST /checkout/pay on checkout service including failures in last 1 hour',
        [],
        harness,
    )
    out = await advance(state, {'type': 'alert'}, harness.deps)
    assert out['kind'] == 'alert'
    assert out['rule']['comparison'] == {'op': '>', 'threshold': 0.8}
    assert out['rule']['status'] == 'pending'
    assert {
        'threshold suggested from the data: just above the highest value in 1h',
        'must hold for 5m (default)',
    } <= set(harness.alerts[0]['assumptions'])


async def test_refuses_an_alert_from_a_request_with_no_chart() -> None:
    harness = create_harness()
    state, _, _, _ = await run('latency graph of checkout service in last 5 hr', [], harness)
    with pytest.raises(InvalidEventError):
        await advance(state, {'type': 'alert'}, harness.deps)


async def test_draft_alert_refuses_a_rule_whose_query_skipped_the_dry_run() -> None:
    state = request('x')
    tools = Toolbox(state, create_harness().deps.backends)
    with pytest.raises(ToolRefusal) as refused:
        await tools.draft_alert(
            {
                'name': 'x',
                'expr': '(up) > 1',
                'for': '5m',
                'severity': 'warning',
                'channel': '#a',
                'status': 'pending',
                'query': 'up',
            }
        )
    assert refused.value.rule == 'dry_run_before_display'


# Data sources --------------------------------------------------------------


async def test_monitor_url_becomes_a_pending_collector_after_a_test_fetch() -> None:
    harness = create_harness()
    _, _, last, _ = await run('monitor https://status.example.com/health every minute', [], harness)
    assert last['kind'] == 'collector'
    assert last['collectorId'] == 'collector-1'
    assert last['spec']['name'] == 'status.example.com/health'
    assert last['spec']['interval'] == '1m'
    assert last['spec']['status'] == 'pending'
    assert last['spec']['config']['url'] == 'https://status.example.com/health'
    assert last['test']['ok'] is True
    assert last['test']['status'] == 200
    assert [c for c in harness.model_calls if c.task == 'write_query'] == []


async def test_refuses_an_interval_under_30_seconds() -> None:
    _, _, last, _ = await run('monitor https://example.com/health every 5 seconds')
    assert last['kind'] == 'no_match'
    assert '30 seconds' in last['message']


# Refining a chart ----------------------------------------------------------


async def test_refine_changes_range_and_adds_a_split_keeping_answers() -> None:
    base, _, _, harness = await run(EXAMPLE, ['POST /checkout/pay', '99'])
    state = await seed_refinement(
        workspace_id='w',
        user_id='u1',
        text='split by method in last 24 hours',
        base={'kind': 'request', 'state': base},
        backends=harness.deps.backends,
    )
    out = await advance(
        state, {'type': 'refine', 'text': 'split by method in last 24 hours'}, harness.deps
    )
    assert state['questionsAsked'] == []
    assert out['kind'] == 'draft'
    assert out['panel']['range'] == '24h'
    assert out['panel']['query'] == (
        'histogram_quantile(0.99, sum by (le, http_request_method) '
        '(rate(http_server_request_duration_seconds_bucket{service_name="checkout", '
        'http_route="/checkout/pay", http_request_method="POST"}[5m])))'
    )
    writes = [c for c in harness.model_calls if c.task == 'write_query']
    assert '"base_query"' in writes[-1].messages[-1]['content']


async def test_reads_a_saved_panels_decisions_and_saves_a_new_version() -> None:
    harness = create_harness()
    query = (
        'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket'
        '{service_name="checkout", http_route="/checkout/pay", http_request_method="POST"}[5m])))'
    )
    assert await decisions_from_query(query, harness.deps.backends) == {
        'service': 'checkout',
        'endpoint': {'method': 'POST', 'route': '/checkout/pay'},
        'percentile': 95,
        'requests': 'all',
    }
    panel = {
        'title': 't',
        'type': 'timeseries',
        'query': query,
        'unit': 's',
        'thresholds': [],
        'request': 'latency of pay',
        'assumptions': [],
    }
    state = await seed_refinement(
        workspace_id='w',
        user_id='u1',
        text='p50 instead',
        base={'kind': 'panel', 'panel': panel, 'panelId': 'panel-7'},
        backends=harness.deps.backends,
    )
    out = await advance(state, {'type': 'refine', 'text': 'median instead'}, harness.deps)
    assert out['kind'] == 'draft'
    assert 'histogram_quantile(0.5,' in out['panel']['query']
    await advance(state, {'type': 'confirm'}, harness.deps)
    assert harness.saved[0][3] == 'panel-7'


# Nothing matches -----------------------------------------------------------


async def test_says_so_and_never_calls_the_model_to_write_a_query() -> None:
    _, _, last, harness = await run('cpu temperature of checkout service')
    assert last['kind'] == 'no_match'
    assert 'Nothing in the catalog matches' in last['message']
    assert [c for c in harness.model_calls if c.task == 'write_query'] == []
    assert harness.dry_runs == []


async def test_names_the_known_services_when_the_service_is_unknown() -> None:
    _, _, last, _ = await run('latency of billing service')
    assert last['kind'] == 'no_match'
    assert 'checkout, inventory' in last['message']


async def test_names_the_real_endpoints_when_the_endpoint_is_unknown() -> None:
    _, _, last, _ = await run('latency of /checkout/refund on checkout service')
    assert last['kind'] == 'no_match'
    assert 'POST /checkout/pay, GET /checkout/summary' in last['message']


# Catalog grounding ---------------------------------------------------------


def reply(query: str) -> str:
    return json.dumps({'query': query, 'title': 't', 'unit': 's', 'display_unit': None})


GOOD = 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout"}[5m]))'
READY = 'p95 latency of all endpoints on checkout service including failures'


async def test_rejects_an_invented_metric_before_the_dry_run() -> None:
    harness = create_harness(
        write_query=lambda attempt, _: (
            reply('sum(rate(http_requests_total[5m]))') if attempt == 1 else reply(GOOD)
        )
    )
    state, _, last, _ = await run(READY, [], harness)
    assert state['attempts'][0]['number'] == 1
    assert state['attempts'][0]['ungrounded'] == ['metric: http_requests_total']
    assert 'not in the catalog' in state['attempts'][0]['failure']
    assert [q for q, _ in harness.dry_runs] == [GOOD]
    assert last['kind'] == 'draft'
    assert last['panel']['query'] == GOOD
    outcomes = [c.outcome for c in harness.ledger.records if c.task == 'write_query']
    assert outcomes == ['ungrounded', 'ok']


async def test_rejects_an_invented_label_and_selectors_without_a_metric() -> None:
    bad = [
        'sum by (customer_id) (rate(http_server_request_duration_seconds_count[5m]))',
        'sum({service_name="checkout"})',
        'sum({__name__=~"http_.*"})',
    ]
    harness = create_harness(write_query=lambda attempt, _: reply(bad[attempt - 1]))
    state, _, last, _ = await run(READY, [], harness)
    assert last['kind'] == 'failed'
    assert [a.get('ungrounded', [None])[0] for a in state['attempts']] == [
        'label: customer_id',
        'selector without one exact metric: {service_name="checkout"}',
        'selector without one exact metric: {__name__=~"http_.*"}',
    ]
    assert harness.dry_runs == []
    assert 'draft' not in state


async def test_tells_the_model_what_was_wrong() -> None:
    harness = create_harness(
        write_query=lambda attempt, _: reply('made_up_metric') if attempt == 1 else reply(GOOD)
    )
    await run(READY, [], harness)
    second = [c for c in harness.model_calls if c.task == 'write_query'][1]
    assert '"query": "made_up_metric"' in second.messages[-1]['content']
    assert 'metric: made_up_metric' in second.messages[-1]['content']


async def test_allows_exactly_the_names_the_search_returned() -> None:
    allowed = {'metrics': ['a_bucket'], 'labels': ['le', 'job']}
    ok = await check_grounding('sum by (le) (rate(a_bucket{job="x"}[5m]))', allowed, analyze)  # type: ignore[arg-type]
    assert ok == {'ok': True}
    bad = await check_grounding('a_bucket{', allowed, analyze)  # type: ignore[arg-type]
    assert bad['ok'] is False
    assert await check_grounding('vector(1)', allowed, analyze) == {'ok': True}  # type: ignore[arg-type]


# Dry run before display ----------------------------------------------------


async def test_failing_queries_are_retried_up_to_three_attempts() -> None:
    harness = create_harness(
        write_query=lambda *_: reply(GOOD), dry_run=lambda *_: {'lineCount': 0}
    )
    state, _, last, _ = await run(READY, [], harness)
    assert len(state['attempts']) == 3
    assert last['kind'] == 'failed'
    assert 'returned no data' in last['message']
    assert 'draft' not in state
    assert state['testedQueries'] == []


async def test_moves_to_a_stronger_model_after_two_failures() -> None:
    runs = [0]

    def dry_run(*_: str) -> dict[str, Any]:
        runs[0] += 1
        if runs[0] < 3:
            return {
                'ok': False,
                'lineCount': 0,
                'error': {'code': 'too_many_lines', 'message': 'Too many lines.'},
            }
        return {}

    harness = create_harness(write_query=lambda *_: reply(GOOD), dry_run=dry_run)
    state, _, last, _ = await run(READY, [], harness)
    assert last['kind'] == 'draft'
    assert [(a['model'], a['escalated']) for a in state['attempts']] == [
        ('test-fast', False),
        ('test-fast', False),
        ('test-strong', True),
    ]
    calls = [(call_id, c) for call_id, c in harness.ledger.calls if c.task == 'write_query']
    assert calls[2][1].escalated_from == calls[1][0]


async def test_a_reply_that_is_not_json_is_a_failed_attempt() -> None:
    harness = create_harness(
        write_query=lambda attempt, _: 'Sure! Here is your query.' if attempt == 1 else reply(GOOD)
    )
    state, _, last, _ = await run(READY, [], harness)
    assert last['kind'] == 'draft'
    assert 'not the JSON' in state['attempts'][0]['failure']


async def test_save_refuses_a_query_that_has_not_passed_a_dry_run() -> None:
    state, _, _, harness = await run(READY)
    tools = Toolbox(state, harness.deps.backends)
    with pytest.raises(ToolRefusal) as refused:
        await tools.save_panel({**state['draft'], 'query': f'{GOOD} * 2'}, None)
    assert refused.value.rule == 'dry_run_before_display'
    assert harness.saved == []


# Saving --------------------------------------------------------------------


async def test_saves_nothing_until_the_person_confirms() -> None:
    state, _, _, harness = await run(READY)
    assert state['status'] == 'draft'
    assert harness.saved == []
    saved = await advance(state, {'type': 'confirm', 'dashboardId': 'dash-9'}, harness.deps)
    assert saved == {'kind': 'saved', 'panelId': 'panel-1', 'version': 1, 'dashboardId': 'dash-9'}
    assert len(harness.saved) == 1
    assert harness.saved[0][1] == {'kind': 'user', 'id': 'u1'}
    assert harness.saved[0][0]['request'] == READY


async def test_cannot_confirm_a_request_with_no_draft() -> None:
    state, _, _, harness = await run(EXAMPLE)
    with pytest.raises(InvalidEventError):
        await advance(state, {'type': 'confirm'}, harness.deps)


# Budget --------------------------------------------------------------------


async def test_pauses_building_at_the_cap_and_says_why() -> None:
    harness = create_harness(budget_limit=0)
    _, _, last, _ = await run(EXAMPLE, [], harness)
    assert last['kind'] == 'failed'
    assert 'model budget' in last['message']
    assert harness.model_calls == []


# State ---------------------------------------------------------------------


async def test_a_request_survives_being_stored_between_events() -> None:
    harness = create_harness()
    first = request(EXAMPLE)
    await advance(first, {'type': 'start'}, harness.deps)
    restored: AgentState = json.loads(json.dumps(first))
    await advance(restored, {'type': 'answer', 'value': 'all'}, harness.deps)
    out = await advance(restored, {'type': 'answer', 'value': '50'}, harness.deps)
    assert out['kind'] == 'draft'
    assert out['panel']['assumptions'] == [
        'p50',
        'all requests including failures',
        'all endpoints combined',
        'all regions combined',
    ]


async def test_only_allows_names_from_the_catalog() -> None:
    state, _, _, _ = await run(READY)
    known = {s for m in CATALOG['metrics'] for s in m['series']}
    assert all(name in known for name in state['allowed']['metrics'])
