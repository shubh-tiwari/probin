"""The "get a metric" loop (apps/agent/src/loop.ts).

A state machine driven by code: parse -> search_catalog -> questions (at most
two) -> write_query -> dry run -> draft -> save on confirm. The model parses
the request and writes the query; everything else is decided here.
"""

import contextlib
import math
import re
import uuid
from typing import Any, Literal, NotRequired, TypedDict, cast
from urllib.parse import urlsplit

from pydantic import ValidationError

from agent.catalog import (
    METHOD_LABEL,
    ROUTE_LABEL,
    SERVICE_LABEL,
    STATUS_LABEL,
    CatalogEndpoint,
    CatalogMetric,
)
from agent.errors import InvalidEventError
from agent.prompts import (
    PreviousAttempt,
    extract_json,
    parse_messages,
    write_context,
    write_query_messages,
)
from agent.state import (
    AgentOutput,
    AgentState,
    Attempt,
    Decisions,
    Event,
    ParsedRequest,
    Question,
    QuestionId,
    QuestionOption,
    RequestFilter,
    UserDefaults,
    WrittenQuery,
)
from agent.tools import MAX_QUESTIONS, ToolBackends, Toolbox
from appcommon.durations import duration_to_seconds
from appcommon.jsnum import js_round, js_string, to_precision
from modelrouter import (
    BudgetExceededError,
    ModelCallError,
    NoEligibleModelError,
    Router,
    RouterRequest,
    RouterResponse,
)

#: How many times the agent may try to write a working query for one request.
MAX_ATTEMPTS = 3
#: How many times it may ask the model to parse a request before giving up.
MAX_PARSE_TRIES = 2

#: Product defaults: used when the request did not say and no question was asked.
DEFAULT_PERCENTILE = 95
DEFAULT_REQUESTS: RequestFilter = 'all'
#: The default time a condition must hold, when the person did not say.
DEFAULT_ALERT_FOR = '5m'


class LoopDependencies:
    def __init__(self, *, router: Router, backends: ToolBackends, default_range: str) -> None:
        self.router = router
        self.backends = backends
        #: The dashboard's range, used to test a query when the request gave no range.
        self.default_range = default_range


def new_request(
    *,
    workspace_id: str,
    user_id: str,
    text: str,
    request_id: str | None = None,
    user_defaults: UserDefaults | None = None,
    channel: str | None = None,
) -> AgentState:
    state: AgentState = {
        'requestId': request_id or str(uuid.uuid4()),
        'workspaceId': workspace_id,
        'userId': user_id,
        'text': text.strip(),
        'status': 'new',
        'allowed': {'metrics': [], 'labels': []},
        'decisions': {},
        'defaulted': [],
        'userDefaults': user_defaults or {},
        'fromUserDefaults': [],
        'questionsAsked': [],
        'attempts': [],
        'testedQueries': [],
        'cost': 0,
    }
    if channel:
        state['channel'] = channel
    return state


# ---------------------------------------------------------------------------
# Matching what the person wrote to what the catalog has
# ---------------------------------------------------------------------------


def _normalise(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '', text.lower())


def match_service(named: str, known: list[str]) -> str | None:
    """ "Checkout", "checkout service" and "order api" match checkout and order-api."""
    wanted = _normalise(re.sub(r'\b(service|api|app)\b', '', named, flags=re.IGNORECASE))
    if wanted == '':
        return None
    for service in known:
        if _normalise(service) == wanted:
            return service
    for service in known:
        if _normalise(service) == _normalise(named):
            return service
    return None


def match_endpoints(
    named: dict[str, Any], endpoints: list[CatalogEndpoint]
) -> list[CatalogEndpoint]:
    """Endpoints a person could mean by a route (and maybe a method) they wrote."""
    method = named['method'].upper() if named.get('method') else None
    by_method = [e for e in endpoints if not method or e['method'] == method]
    exact = [e for e in by_method if e['route'] == named['route']]
    if exact:
        return exact
    wanted = _normalise(named['route'])
    return [e for e in by_method if _normalise(e['route']).endswith(wanted)]


def _endpoint_value(endpoint: dict[str, Any] | CatalogEndpoint) -> str:
    return f'{endpoint["method"]} {endpoint["route"]}'


# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------


def _service_question(services: list[str]) -> Question:
    return {
        'id': 'service',
        'kind': 'choice',
        'text': 'Which service?',
        'options': [
            *(QuestionOption(value=s, label=s) for s in services[:5]),
            QuestionOption(value='*', label='All services combined'),
        ],
    }


def endpoint_question(endpoints: list[CatalogEndpoint]) -> Question:
    """The endpoint picker: real endpoints from the catalog, tagged, with "all combined" last."""

    def first_by(key: Literal['p95', 'requestRate']) -> int | None:
        if not endpoints:
            return None
        ranked = sorted(
            range(len(endpoints)),
            key=lambda i: -(endpoints[i][key] if endpoints[i][key] is not None else -1),  # type: ignore[operator]
        )
        return ranked[0]

    slowest = first_by('p95')
    busiest = first_by('requestRate')
    options: list[Any] = []
    for index, endpoint in enumerate(endpoints):
        tags = [
            *(['Slowest'] if index == slowest and endpoint['p95'] is not None else []),
            *(['Busiest'] if index == busiest and endpoint['requestRate'] is not None else []),
        ]
        option: dict[str, Any] = {
            'value': _endpoint_value(endpoint),
            'label': _endpoint_value(endpoint),
        }
        if tags:
            option['tags'] = tags
        options.append(option)
    options.append({'value': 'all', 'label': 'All endpoints combined'})
    return {'id': 'endpoint', 'kind': 'endpoint', 'text': 'Which endpoint?', 'options': options}


PERCENTILE_QUESTION: Question = {
    'id': 'percentile',
    'kind': 'choice',
    'text': 'Which latency: typical (p50), slow tail (p95) or worst 1% (p99)?',
    'options': [
        {'value': '50', 'label': 'Typical (p50)'},
        {'value': '95', 'label': 'Slow tail (p95)'},
        {'value': '99', 'label': 'Worst 1% (p99)'},
    ],
}

REQUESTS_QUESTION: Question = {
    'id': 'requests',
    'kind': 'choice',
    'text': 'Count failed requests too?',
    'options': [
        {'value': 'all', 'label': 'Yes, all requests'},
        {'value': 'successful_only', 'label': 'No, successful requests only'},
    ],
}


# ---------------------------------------------------------------------------
# Deciding what is still open
# ---------------------------------------------------------------------------


def _candidate_metrics(state: AgentState) -> list[CatalogMetric]:
    """The metrics the query will be written from: the chosen service's, best match first."""
    service = state['decisions'].get('service')
    metrics = state['catalog']['metrics'] if 'catalog' in state else []
    return (
        [m for m in metrics if m['service'] == service] if service and service != '*' else metrics
    )


def _splits_by_endpoint(split_by: list[str]) -> bool:
    return any(re.search(r'endpoint|route|path', s, re.IGNORECASE) for s in split_by)


class _Next(TypedDict):
    type: Literal['ask', 'stop', 'write']
    question: NotRequired[Question]
    message: NotRequired[str]


def _decide(state: AgentState) -> _Next:
    """Work out what is still ambiguous: endpoint, then percentile, then failed requests.

    A question is asked only while fewer than two have been asked; after that the
    product default applies and is stated as an assumption. The endpoint has no
    default: the person must choose.
    """
    parsed = state['parsed']
    catalog = state['catalog']
    decisions = state['decisions']

    def can_ask() -> bool:
        return len(state['questionsAsked']) < MAX_QUESTIONS

    if 'service' not in decisions:
        top = catalog['metrics'][0]
        services = list(
            dict.fromkeys(
                m['service'] for m in catalog['metrics'] if m['storedName'] == top['storedName']
            )
        )
        if len(services) == 1:
            decisions['service'] = services[0]
        else:
            return {'type': 'ask', 'question': _service_question(services)}

    candidates = _candidate_metrics(state)
    if not candidates:
        return {
            'type': 'stop',
            'message': (
                f'Nothing in the catalog matches “{parsed["measure"]}” for the '
                f'{decisions.get("service")} service.'
            ),
        }
    primary = candidates[0]

    endpoints_apply = ROUTE_LABEL in primary['labels'] and decisions.get('service') != '*'
    if endpoints_apply and 'endpoint' not in decisions:
        endpoints = [e for e in catalog['endpoints'] if e['service'] == decisions.get('service')]
        # Splitting by endpoint shows every endpoint, so there is nothing to pick.
        if parsed['all_endpoints'] or _splits_by_endpoint(parsed['split_by']) or not endpoints:
            decisions['endpoint'] = 'all'
        elif parsed['endpoint']:
            matches = match_endpoints(parsed['endpoint'], endpoints)
            if not matches:
                return {
                    'type': 'stop',
                    'message': (
                        f'The {decisions.get("service")} service has no endpoint matching '
                        f'“{parsed["endpoint"]["route"]}”. '
                        f'Its endpoints are: {", ".join(_endpoint_value(e) for e in endpoints)}.'
                    ),
                }
            if len(matches) == 1:
                decisions['endpoint'] = {
                    'method': matches[0]['method'],
                    'route': matches[0]['route'],
                }
            else:
                return {'type': 'ask', 'question': endpoint_question(matches)}
        elif len(endpoints) == 1:
            decisions['endpoint'] = {
                'method': endpoints[0]['method'],
                'route': endpoints[0]['route'],
            }
        else:
            return {'type': 'ask', 'question': endpoint_question(endpoints)}

    user_defaults = state['userDefaults']
    percentile_applies = parsed['kind'] == 'latency' and primary['type'] == 'histogram'
    if percentile_applies and 'percentile' not in decisions:
        if parsed['percentile'] is not None:
            decisions['percentile'] = parsed['percentile']
        elif 'percentile' in user_defaults:
            decisions['percentile'] = user_defaults['percentile']
            state['fromUserDefaults'].append('percentile')
        elif can_ask():
            return {'type': 'ask', 'question': PERCENTILE_QUESTION}
        else:
            decisions['percentile'] = DEFAULT_PERCENTILE
            state['defaulted'].append('percentile')

    requests_apply = parsed['kind'] in ('latency', 'traffic') and STATUS_LABEL in primary['labels']
    if requests_apply and 'requests' not in decisions:
        if parsed['requests'] is not None:
            decisions['requests'] = parsed['requests']
        elif 'requests' in user_defaults:
            decisions['requests'] = user_defaults['requests']
            state['fromUserDefaults'].append('requests')
        elif can_ask():
            return {'type': 'ask', 'question': REQUESTS_QUESTION}
        else:
            decisions['requests'] = DEFAULT_REQUESTS
            state['defaulted'].append('requests')

    return {'type': 'write'}


def _js_number(text: str) -> int | float:
    value = float(text)
    return int(value) if value.is_integer() else value


def _apply_answer(state: AgentState, value: str) -> None:
    question = state['question']
    if not any(option['value'] == value for option in question['options']):
        values = ', '.join(option['value'] for option in question['options'])
        raise InvalidEventError(f'“{value}” is not one of the options: {values}.')
    decisions = state['decisions']
    match question['id']:
        case 'service':
            decisions['service'] = value
        case 'endpoint':
            if value == 'all':
                decisions['endpoint'] = 'all'
            else:
                method, *route = value.split(' ')
                decisions['endpoint'] = {'method': method, 'route': ' '.join(route)}
        case 'percentile':
            decisions['percentile'] = _js_number(value)
        case 'requests':
            decisions['requests'] = cast(RequestFilter, value)
    del state['question']


# ---------------------------------------------------------------------------
# The draft
# ---------------------------------------------------------------------------

REQUESTS_TEXT = {
    'all': 'all requests including failures',
    'failed_only': 'failed requests only',
    'successful_only': 'successful requests only',
}


def rememberable_answers(state: AgentState) -> UserDefaults:
    """The answers worth saving as the person's defaults: percentile and request filter.

    The endpoint is particular to one service and is never saved.
    """
    answers: UserDefaults = {}
    decisions = state['decisions']
    if 'percentile' in state['questionsAsked'] and 'percentile' in decisions:
        answers['percentile'] = decisions['percentile']
    if 'requests' in state['questionsAsked'] and 'requests' in decisions:
        answers['requests'] = decisions['requests']
    return answers


def assumptions(state: AgentState) -> list[str]:
    """Every choice behind the panel that the person did not spell out, in plain words."""
    parsed = state['parsed']
    decisions = state['decisions']
    out: list[str] = []
    if 'percentile' in decisions:
        out.append(f'p{js_string(decisions["percentile"])}')
    if parsed['kind'] == 'errors':
        out.append('errors are responses with status 5xx')
    if 'requests' in decisions:
        out.append(REQUESTS_TEXT[decisions['requests']])
    if decisions.get('service') == '*':
        out.append('all services combined')
    if decisions.get('endpoint') == 'all' and not _splits_by_endpoint(parsed['split_by']):
        out.append('all endpoints combined')
    # Region is never asked. Unless the request split by it, say that it is combined.
    if not any(re.search('region', s, re.IGNORECASE) for s in parsed['split_by']):
        out.append('all regions combined')
    if parsed['range'] is None:
        out.append('dashboard time range')
    return out


async def _build_draft(
    state: AgentState, written: WrittenQuery, deps: LoopDependencies
) -> dict[str, Any]:
    parsed = state['parsed']
    spec: dict[str, Any] = {
        'title': written.title,
        'type': parsed['chart'] or 'timeseries',
        'query': written.query,
        'unit': written.unit,
    }
    if written.display_unit:
        spec['display_unit'] = written.display_unit
    # The range stays outside the query. Left out, the panel follows its dashboard.
    if parsed['range']:
        spec['range'] = parsed['range']
    spec.update(thresholds=[], request=state['text'], assumptions=assumptions(state))
    return await deps.backends.validate('panel', spec)


# ---------------------------------------------------------------------------
# Model steps
# ---------------------------------------------------------------------------


async def _parse_request(state: AgentState, deps: LoopDependencies) -> dict[str, Any]:
    previous: RouterResponse | None = None
    for attempt in range(MAX_PARSE_TRIES):
        reply = await deps.router.call(
            RouterRequest(
                workspace_id=state['workspaceId'],
                request_id=state['requestId'],
                task='parse',
                messages=parse_messages(state['text']),
                json=True,
                max_tokens=400,
                failures=attempt,
                previous_call_id=previous.call_id if previous else None,
            )
        )
        state['cost'] += reply.cost
        previous = reply
        try:
            return ParsedRequest.model_validate(extract_json(reply.content)).as_json()
        except (ValueError, ValidationError):
            await deps.router.report(reply.call_id, 'invalid_output')
    raise ModelCallError('The request could not be understood.')


async def _write_and_test(state: AgentState, tools: Toolbox, deps: LoopDependencies) -> AgentOutput:
    metrics = _candidate_metrics(state)
    range_ = state['parsed']['range'] or deps.default_range
    previous: PreviousAttempt | None = None
    last_problem = ''

    while len(state['attempts']) < MAX_ATTEMPTS:
        failures = len(state['attempts'])
        reply = await deps.router.call(
            RouterRequest(
                workspace_id=state['workspaceId'],
                request_id=state['requestId'],
                task='write_query',
                messages=write_query_messages(write_context(state, metrics, previous)),
                json=True,
                max_tokens=600,
                # After two failures the router moves to a stronger model.
                failures=failures,
                previous_call_id=state['attempts'][-1]['callId'] if state['attempts'] else None,
            )
        )
        state['cost'] += reply.cost
        attempt: Attempt = {
            'number': failures + 1,
            'model': reply.model,
            'tier': reply.tier,
            'escalated': reply.escalated,
            'callId': reply.call_id,
            'cost': reply.cost,
        }
        state['attempts'].append(attempt)

        try:
            written = WrittenQuery.model_validate(extract_json(reply.content))
        except (ValueError, ValidationError):
            attempt['failure'] = 'The reply was not the JSON that was asked for.'
            await deps.router.report(reply.call_id, 'invalid_output')
            previous = {'query': None, 'problem': attempt['failure']}
            last_problem = attempt['failure']
            continue
        attempt['query'] = written.query

        run = await tools.run_query(written.query, range_)
        if run['ok']:
            attempt['lineCount'] = run['lineCount']
            state['draft'] = await _build_draft(state, written, deps)
            state['status'] = 'draft'
            with contextlib.suppress(Exception):
                await _remember(state, deps)
            if state['parsed']['intent'] == 'alert':
                return await _draft_alert_from_draft(state, tools, deps, {})
            return {'kind': 'draft', 'panel': state['draft'], 'attempts': state['attempts']}
        attempt['failure'] = run.get('reason', '')
        if run.get('ungrounded'):
            attempt['ungrounded'] = run['ungrounded']
        if 'lineCount' in run:
            attempt['lineCount'] = run['lineCount']
        await deps.router.report(
            reply.call_id, 'ungrounded' if run.get('ungrounded') else 'dry_run_failed'
        )
        previous = {'query': written.query, 'problem': attempt['failure']}
        last_problem = attempt['failure']

    return _fail(
        state,
        f'I could not build a working query for this after {MAX_ATTEMPTS} attempts. '
        f'The last problem: {last_problem}',
    )


# ---------------------------------------------------------------------------
# Alerts and data sources
# ---------------------------------------------------------------------------


def threshold_in_query_unit(threshold: float, written: str | None, query_unit: str) -> float:
    """A threshold as written ("800 ms", "2%") in the query's own unit (seconds, a ratio)."""
    unit = written.lower() if written else None
    if query_unit == 's':
        if unit == 'ms':
            return threshold / 1000
        if unit in ('m', 'min'):
            return threshold * 60
        return threshold
    if query_unit == '1' and unit in ('%', 'percent'):
        return threshold / 100
    return threshold


def nice_above(value: float) -> float:
    """A round number just above `value`, for a suggested threshold."""
    if not math.isfinite(value) or value <= 0:
        return 1
    power = 10.0 ** math.floor(math.log10(value))
    step = next(
        (s for s in (m * power for m in (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10)) if s > value),
        10 * power,
    )
    return to_precision(step, 6)


def _describe_threshold(value: float, unit: str, display: str | None) -> str:
    if unit == 's' and display == 'ms':
        return f'{js_string(to_precision(value * 1000, 6))} ms'
    if unit == '1' and display == '%':
        return f'{js_string(to_precision(value * 100, 6))}%'
    if unit == 's':
        return f'{js_string(value)} s'
    return f'{js_string(value)}{f" {unit}" if unit and unit != "1" else ""}'


class _Given(TypedDict, total=False):
    op: Literal['>', '<']
    threshold: float
    for_: str


async def _draft_alert_from_draft(
    state: AgentState, tools: Toolbox, deps: LoopDependencies, given: _Given
) -> AgentOutput:
    """Turn the tested draft into a pending alert rule.

    The threshold comes from the request, the event, or (for "Alert me on this")
    a round number just above the highest value in the range, stated as an
    assumption.
    """
    panel = state['draft']
    parsed = state['parsed']
    alert = parsed.get('alert')
    rule_assumptions = list(panel['assumptions'])
    op = given.get('op') or (alert['op'] if alert else '>')
    threshold: float
    if 'threshold' in given:
        threshold = given['threshold']
    elif alert:
        threshold = threshold_in_query_unit(alert['threshold'], alert['unit'], panel['unit'])
    else:
        range_ = panel.get('range') or deps.default_range
        dry = await deps.backends.dry_run(panel['query'], range_)
        maxima = [s['max'] for s in dry['sample'] if s.get('max') is not None]
        highest = max(maxima, default=-math.inf)
        threshold = nice_above(highest * 1.1 if math.isfinite(highest) else 1)
        rule_assumptions.append(
            f'threshold suggested from the data: just above the highest value in {range_}'
        )
    duration = (
        given.get('for_')
        or (alert['for'] if alert and alert['for'] else None)
        or (DEFAULT_ALERT_FOR)
    )
    if not given.get('for_') and not (alert and alert['for']):
        rule_assumptions.append(f'must hold for {DEFAULT_ALERT_FOR} (default)')
    try:
        duration_to_seconds(duration)
    except ValueError:
        return _fail(state, f'“{duration}” is not a duration such as 5m.')
    shown = _describe_threshold(threshold, panel['unit'], panel.get('display_unit'))
    spec: dict[str, Any] = {
        'name': f'{panel["title"]} {"above" if op == ">" else "below"} {shown}',
        'expr': f'({panel["query"]}) {op} {js_string(threshold)}',
        'for': duration,
        'severity': 'warning',
        'channel': state.get('channel', '#alerts'),
        'status': 'pending',
        'query': panel['query'],
        'comparison': {'op': op, 'threshold': threshold},
        'unit': panel['unit'],
    }
    if panel.get('display_unit'):
        spec['display_unit'] = panel['display_unit']
    service = state['decisions'].get('service')
    if service and service != '*':
        spec['service'] = service
    spec['request'] = state['text']
    spec['assumptions'] = rule_assumptions
    result = await tools.draft_alert(spec)
    state['alertDraft'] = {'ruleId': result['ruleId'], 'spec': spec}
    state['status'] = 'alert'
    return {'kind': 'alert', 'ruleId': result['ruleId'], 'rule': spec}


def _parse_url(raw: str) -> tuple[str, str, str] | None:
    """(normalised URL, host, path) as the WHATWG URL parser would give them, or None."""
    try:
        parts = urlsplit(raw.strip())
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc or parts.hostname is None:
        return None
    host = parts.hostname.lower()
    netloc = parts.netloc.rsplit('@', 1)[-1]
    netloc = host + (netloc[len(parts.hostname) :] if netloc.lower().startswith(host) else '')
    path = parts.path or '/'
    url = f'{parts.scheme.lower()}://{netloc}{path}'
    if parts.query:
        url += f'?{parts.query}'
    if parts.fragment:
        url += f'#{parts.fragment}'
    return url, host, path


async def _draft_collector(state: AgentState, tools: Toolbox) -> AgentOutput:
    wanted = state['parsed']['collector']
    parsed_url = _parse_url(wanted['url'])
    if not parsed_url:
        return _no_match(state, f'“{wanted["url"]}” is not a URL I can monitor.')
    url, host, path = parsed_url
    interval = wanted['interval'] or '1m'
    if duration_to_seconds(interval) < 30:
        return _no_match(state, 'The shortest interval is 30 seconds.')
    spec = {
        # Collector names are what the check is about: the host and path.
        'name': f'{host}{"" if path == "/" else path}'[:80],
        'source_type': 'http',
        'config': {'url': url, 'method': 'GET', 'timeout_seconds': 5},
        'interval': interval,
        'metric_names': ['http.check.up', 'http.check.duration'],
        'status': 'pending',
    }
    try:
        result = await tools.draft_collector(spec)
    except Exception as error:
        return _no_match(state, str(error))
    state['collectorDraft'] = {
        'collectorId': result['collectorId'],
        'test': result['test'],
        'spec': spec,
    }
    state['status'] = 'collector'
    return {'kind': 'collector', **state['collectorDraft']}


# ---------------------------------------------------------------------------
# Refining an existing chart
# ---------------------------------------------------------------------------


async def decisions_from_query(query: str, backends: ToolBackends) -> Decisions:
    """What a chart's query says about its decisions: service, endpoint, percentile, failures."""
    decisions: Decisions = {}
    analysis = await backends.analyze(query)
    if not analysis.get('ok'):
        return decisions
    matchers = [m for s in analysis['selectors'] for m in s['matchers']]

    def exact(label: str) -> str | None:
        return next((m['value'] for m in matchers if m['label'] == label and m['op'] == '='), None)

    service = exact(SERVICE_LABEL)
    if service:
        decisions['service'] = service
    route = exact(ROUTE_LABEL)
    method = exact(METHOD_LABEL)
    if route and method:
        decisions['endpoint'] = {'method': method, 'route': route}
    elif service:
        decisions['endpoint'] = 'all'
    quantile = re.search(r'histogram_quantile\(\s*([0-9.]+)', query)
    if quantile:
        decisions['percentile'] = _whole(js_round(float(quantile.group(1)) * 1000) / 10)
    status = next((m for m in matchers if m['label'] == STATUS_LABEL), None)
    if not re.search(r' / ', query):
        filter_: RequestFilter = (
            'all' if not status else 'failed_only' if status['op'] == '=~' else 'successful_only'
        )
        decisions['requests'] = filter_
    return decisions


def _whole(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def merge_refinement(base: dict[str, Any], change: dict[str, Any]) -> dict[str, Any]:
    """Combine the original request with the change asked for. The change wins where it speaks."""

    def either(key: str) -> Any:
        return change[key] if change[key] is not None else base[key]

    merged = dict(base)
    merged.update(
        intent='chart',
        alert=None,
        collector=None,
        percentile=either('percentile'),
        requests=either('requests'),
        range=either('range'),
        chart=either('chart'),
        endpoint=change['endpoint'] or (None if change['all_endpoints'] else base['endpoint']),
        all_endpoints=change['all_endpoints']
        or (False if change['endpoint'] else base['all_endpoints']),
        split_by=list(dict.fromkeys([*base['split_by'], *change['split_by']]))[:3],
    )
    return merged


async def seed_refinement(
    *,
    workspace_id: str,
    user_id: str,
    text: str,
    base: dict[str, Any],
    backends: ToolBackends,
    channel: str | None = None,
) -> AgentState:
    """A new request that changes an existing chart.

    `base` is {"kind": "request", "state": ...} or {"kind": "panel", "panel": ...,
    "panelId": ..., "dashboardId"?: ...}. Nothing is asked: the original answers
    stand, and anything new is an assumption.
    """
    original = base['state']['text'] if base['kind'] == 'request' else base['panel']['request']
    state = new_request(
        workspace_id=workspace_id,
        user_id=user_id,
        text=f'{original} (then: {text.strip()})',
        channel=channel,
    )
    state['refinement'] = text.strip()
    if base['kind'] == 'request':
        earlier: AgentState = base['state']
        state['decisions'] = dict(earlier['decisions'])  # type: ignore[typeddict-item]
        if 'parsed' in earlier:
            state['parsed'] = earlier['parsed']
        if 'catalog' in earlier:
            state['catalog'] = earlier['catalog']
        state['allowed'] = earlier['allowed']
        revises: Any = {'query': earlier['draft']['query'] if 'draft' in earlier else ''}
        if 'saved' in earlier:
            revises.update(
                panelId=earlier['saved']['panelId'], dashboardId=earlier['saved']['dashboardId']
            )
        state['revises'] = revises
    else:
        state['decisions'] = await decisions_from_query(base['panel']['query'], backends)
        revises = {'query': base['panel']['query'], 'panelId': base['panelId']}
        if base.get('dashboardId'):
            revises['dashboardId'] = base['dashboardId']
        state['revises'] = revises
    return state


async def _refine(
    state: AgentState, tools: Toolbox, deps: LoopDependencies, text: str
) -> AgentOutput:
    change = await _parse_text(state, deps, text)
    base = state.get('parsed') or await _parse_text(
        state, deps, re.sub(r' \(then: .*\)$', '', state['text'])
    )
    merged = merge_refinement(base, change)
    state['parsed'] = merged
    decisions = state['decisions']
    # A refinement keeps every earlier answer; what the change says replaces them.
    if change['percentile'] is not None:
        decisions['percentile'] = change['percentile']
    if change['requests'] is not None:
        decisions['requests'] = change['requests']
    if change['all_endpoints']:
        decisions['endpoint'] = 'all'
    if _splits_by_endpoint(merged['split_by']):
        decisions['endpoint'] = 'all'

    service = decisions.get('service')
    service = service if service and service != '*' else None
    # The chart's own query names its metric; search with those names too, since a
    # panel's request text may not describe it (a starter panel, a hand edit).
    base_query = state.get('revises', {}).get('query', '')
    analysis: dict[str, Any] = (
        await deps.backends.analyze(base_query) if base_query else {'ok': False}
    )
    names_in_query = (
        [re.sub(r'_(bucket|sum|count)$', '', name) for name in analysis['names']['metrics']]
        if analysis.get('ok')
        else []
    )
    search: Any = {'text': f'{state["text"]} {merged["measure"]} {" ".join(names_in_query)}'}
    if service:
        search['service'] = service
    result = await tools.search_catalog(search)
    if 'catalog' not in state or not state['catalog']['metrics']:
        state['catalog'] = {
            'knownServices': result['knownServices'],
            'metrics': result['metrics'],
            'endpoints': result['endpoints'],
        }
    if not state['catalog']['metrics']:
        return _no_match(state, 'I could not find the metric behind this chart in the catalog.')
    if 'service' not in decisions and len(result['services']) == 1:
        decisions['service'] = result['services'][0]
    if merged['kind'] == 'latency' and 'percentile' not in decisions:
        decisions['percentile'] = DEFAULT_PERCENTILE
        state['defaulted'].append('percentile')
    if 'requests' not in decisions and merged['kind'] != 'errors':
        decisions['requests'] = DEFAULT_REQUESTS
        state['defaulted'].append('requests')
    return await _write_and_test(state, tools, deps)


async def _parse_text(state: AgentState, deps: LoopDependencies, text: str) -> dict[str, Any]:
    """Parse some words with the model, outside the main request text."""
    original = state['text']
    state['text'] = text
    try:
        return await _parse_request(state, deps)
    finally:
        state['text'] = original


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------


def _fail(state: AgentState, message: str) -> AgentOutput:
    state['status'] = 'failed'
    state['message'] = message
    return {'kind': 'failed', 'message': message, 'attempts': state['attempts']}


def _no_match(state: AgentState, message: str) -> AgentOutput:
    state['status'] = 'no_match'
    state['message'] = message
    return {'kind': 'no_match', 'message': message}


async def _proceed(state: AgentState, tools: Toolbox, deps: LoopDependencies) -> AgentOutput:
    step = _decide(state)
    if step['type'] == 'stop':
        return _no_match(state, step['message'])
    if step['type'] == 'ask':
        tools.ask_user(step['question'])
        return {
            'kind': 'question',
            'question': step['question'],
            'questionsLeft': MAX_QUESTIONS - len(state['questionsAsked']),
        }
    return await _write_and_test(state, tools, deps)


def resolved_key(text: str) -> str:
    """The cache key for a request: its words, lower case, without spacing or end punctuation."""
    return re.sub(r'[\s.?!]+$', '', re.sub(r'\s+', ' ', text.lower())).strip()


async def _from_cache(
    state: AgentState, tools: Toolbox, deps: LoopDependencies
) -> AgentOutput | None:
    """Reuse an identical earlier request, if the catalog of its services has not changed.

    No model is called; the query is still dry-run before it is shown, and the
    names it uses are still checked against the catalog.
    """
    cache = deps.backends.resolved
    if not cache:
        return None
    entry = await cache.get(resolved_key(state['text']))
    if not entry:
        return None
    if await cache.fingerprint(entry['services']) != entry['fingerprint']:
        return None

    names = await cache.names(entry['services'])
    state['allowed'] = {'metrics': names['metrics'], 'labels': names['labels']}
    try:
        parsed = ParsedRequest.model_validate(entry['parsed']).as_json()
    except ValidationError:
        return None
    run = await tools.run_query(entry['panel']['query'], parsed['range'] or deps.default_range)
    if not run['ok']:
        return None

    state['parsed'] = parsed
    state['decisions'] = entry['decisions']
    state['fromCache'] = True
    state['draft'] = await deps.backends.validate(
        'panel',
        {
            **entry['panel'],
            'request': state['text'],
            'assumptions': [
                *entry['panel']['assumptions'],
                'the same choices as the last time this was asked',
            ],
        },
    )
    state['status'] = 'draft'
    return {'kind': 'draft', 'panel': state['draft'], 'attempts': state['attempts']}


async def _remember(state: AgentState, deps: LoopDependencies) -> None:
    """Remember a fresh draft for the next identical request."""
    cache = deps.backends.resolved
    if not cache or 'draft' not in state or state.get('fromCache'):
        return
    service = state['decisions'].get('service')
    services = (
        [service]
        if service and service != '*'
        else (state['catalog']['knownServices'] if 'catalog' in state else [])
    )
    if not services:
        return
    await cache.put(
        resolved_key(state['text']),
        {
            'panel': state['draft'],
            'parsed': state.get('parsed'),
            'decisions': state['decisions'],
            'services': services,
            'fingerprint': await cache.fingerprint(services),
        },
    )


async def _start(state: AgentState, tools: Toolbox, deps: LoopDependencies) -> AgentOutput:
    cached = await _from_cache(state, tools, deps)
    if cached:
        return cached
    parsed = await _parse_request(state, deps)
    state['parsed'] = parsed
    if parsed['intent'] == 'collector' and parsed['collector']:
        return await _draft_collector(state, tools)

    # Search with the person's own words, the parsed measure, and the kind of measure
    # as a plain word ("how long do payments take" is about latency). A service named
    # in the text narrows the search to that service.
    text = ' '.join(
        [state['text'], parsed['measure'], '' if parsed['kind'] == 'other' else parsed['kind']]
    )
    result = await tools.search_catalog({'text': text})
    if parsed['service'] is not None:
        service = match_service(parsed['service'], result['knownServices'])
        if not service:
            known = result['knownServices']
            return _no_match(
                state,
                f'There is no service called “{parsed["service"]}” in the catalog. '
                + (
                    f'The services I know are: {", ".join(known)}.'
                    if known
                    else 'It has no services yet.'
                ),
            )
        state['decisions']['service'] = service
        result = await tools.search_catalog({'text': text, 'service': service})
    elif len(result['services']) == 1:
        state['decisions']['service'] = result['services'][0]

    state['catalog'] = {
        'knownServices': result['knownServices'],
        'metrics': result['metrics'],
        'endpoints': result['endpoints'],
    }
    if not result['metrics']:
        service = state['decisions'].get('service')
        where = f' for the {service} service' if service else ''
        return _no_match(
            state,
            f'Nothing in the catalog matches “{parsed["measure"]}”{where}. '
            'I can only chart metrics that exist; I will not guess a name.',
        )
    return await _proceed(state, tools, deps)


async def advance(state: AgentState, event: Event, deps: LoopDependencies) -> AgentOutput:
    """Move a request forward by one event and say what the person should see.

    start runs the request until it needs an answer or has a tested draft.
    answer supplies the answer to the open question. confirm saves the draft.
    The state is updated in place; it is plain data and can be stored between events.
    """
    tools = Toolbox(state, deps.backends)
    try:
        match event.get('type'):
            case 'start':
                if state['status'] != 'new':
                    raise InvalidEventError('This request has already started.')
                return await _start(state, tools, deps)
            case 'answer':
                if state['status'] != 'question' or 'question' not in state:
                    raise InvalidEventError('This request is not waiting for an answer.')
                _apply_answer(state, event.get('value', ''))
                return await _proceed(state, tools, deps)
            case 'refine':
                if state['status'] != 'new' or 'revises' not in state:
                    raise InvalidEventError('Start a refinement with seed_refinement.')
                return await _refine(state, tools, deps, event.get('text', ''))
            case 'alert':
                if state['status'] not in ('draft', 'saved'):
                    raise InvalidEventError('Only a tested chart can become an alert.')
                if 'draft' not in state:
                    raise InvalidEventError('There is no chart to alert on.')
                given: _Given = {}
                if 'op' in event:
                    given['op'] = event['op']
                if 'threshold' in event:
                    given['threshold'] = event['threshold']
                if 'for_' in event:
                    given['for_'] = event['for_']
                return await _draft_alert_from_draft(state, tools, deps, given)
            case 'confirm':
                if state['status'] != 'draft' or 'draft' not in state:
                    raise InvalidEventError('There is no draft to save.')
                saved = await tools.save_panel(state['draft'], event.get('dashboardId'))
                state['saved'] = saved
                state['status'] = 'saved'
                return {'kind': 'saved', **saved}
            case _:
                raise InvalidEventError(f'Unknown event {event.get("type")!r}.')
    except (BudgetExceededError, NoEligibleModelError, ModelCallError) as error:
        return _fail(state, str(error))


QuestionIds: tuple[QuestionId, ...] = ('service', 'endpoint', 'percentile', 'requests')
