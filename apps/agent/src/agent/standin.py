"""A stand-in for the model, used when no model key is configured (apps/agent/src/standin.ts).

It is NOT the product's model and makes no network calls. It answers the
agent's prompts with fixed rules: a keyword parser and a few query templates.
That is enough to run the whole loop, its guards and the test set end to end
without spending anything. It handles plain requests only, so its pass rate
says nothing about the real gate.
"""

import json
import re
from typing import Any

from agent.jsonjs import stringify
from agent.prompts import WriteContext, read_block
from appcommon.jsnum import js_string
from modelrouter import CompletionRequest, CompletionResponse

STAND_IN_MODEL = 'stand-in'

_I = re.IGNORECASE

_WORDS = {
    'errors': re.compile(
        r'\b(errors?|error rate|failures?|failure rate|fails?|failing|5xx|500s?)\b', _I
    ),
    'latency': re.compile(
        r'\b(latenc(y|ies)|slow(est|er)?|response times?|durations?|how long|speed|p\d{2})\b', _I
    ),
    'traffic': re.compile(
        r'\b(traffic|requests?|rps|throughput|hits|calls|load|busy|busiest)\b', _I
    ),
}

_RANGE_UNITS = {
    's': 's', 'sec': 's', 'secs': 's', 'second': 's', 'seconds': 's',
    'm': 'm', 'min': 'm', 'mins': 'm', 'minute': 'm', 'minutes': 'm',
    'h': 'h', 'hr': 'h', 'hrs': 'h', 'hour': 'h', 'hours': 'h',
    'd': 'd', 'day': 'd', 'days': 'd',
    'w': 'w', 'wk': 'w', 'week': 'w', 'weeks': 'w',
}  # fmt: skip

_RANGE = re.compile(
    r'\b(?:(?:in|over|for|during)\s+)?(?:the\s+)?(?:last|past|previous)\s+(\d+)?\s*('
    + '|'.join(_RANGE_UNITS)
    + r')\b',
    _I,
)

_THRESHOLD_WORDS = r'(above|over|more than|exceeds?|greater than|below|under|less than)'


def js_number(text: str) -> int | float:
    """Number(text) for a numeric string: whole numbers stay whole."""
    value = float(text)
    return int(value) if value.is_integer() else value


def stand_in_parse(text: str) -> dict[str, Any]:
    lower = text.lower()

    range_: str | None = None
    range_match = _RANGE.search(text)
    if range_match:
        range_ = f'{range_match.group(1) or "1"}{_RANGE_UNITS[range_match.group(2).lower()]}'
    elif re.search(r'\btoday\b', lower):
        range_ = '24h'
    elif re.search(r'\bthis week\b', lower):
        range_ = '7d'

    percentile: int | float | None = None
    p = re.search(r'\bp(\d{2}(?:\.\d)?)\b', text, _I) or re.search(
        r'\b(\d{2})(?:th|st|nd|rd)\s+percentile\b', text, _I
    )
    if p:
        percentile = js_number(p.group(1))
    elif re.search(r'\b(median|typical)\b', lower):
        percentile = 50

    # Latency wins over errors, which win over traffic: "latency of failed requests"
    # is about latency. "Including failures" says which requests to count, not
    # what to measure, so it is set aside first.
    subject = re.sub(r'\b(including|excluding|counting) (failures|errors)\b', ' ', text, flags=_I)
    kind = 'other'
    if _WORDS['latency'].search(subject):
        kind = 'latency'
    elif _WORDS['errors'].search(subject):
        kind = 'errors'
    elif _WORDS['traffic'].search(subject):
        kind = 'traffic'

    requests: str | None = None
    if kind != 'errors':
        if re.search(r'\b(failed|failing|error) requests?\b|\bfailed only\b', lower):
            requests = 'failed_only'
        elif re.search(r'\bsuccessful\b|\bexcluding (failures|errors)\b', lower):
            requests = 'successful_only'
        elif re.search(r'\bincluding (failures|errors)\b', lower):
            requests = 'all'

    route_match = re.search(r'(?:^|\s)(/[A-Za-z0-9_\-/{}:.]+)', text)
    route = route_match.group(1) if route_match else None
    method_match = re.search(r'\b(GET|POST|PUT|PATCH|DELETE)\b', text)
    method = method_match.group(1) if method_match else None
    all_endpoints = bool(re.search(r'\ball (endpoints|routes)\b|\bacross endpoints\b', lower))

    service_match = re.search(r'\b([a-z][a-z0-9-]*)\s+(?:service|api|app)\b', text, _I) or (
        re.search(r'\b(?:service|api|app)\s+([a-z][a-z0-9-]*)\b', text, _I)
    )
    service = service_match.group(1) if service_match else None

    chart: str | None = None
    if re.search(r'\bbar( chart| graph)?\b', lower):
        chart = 'bar'
    elif re.search(r'\b(single number|stat|right now|current(ly)?|how many .* now)\b', lower):
        chart = 'stat'
    elif re.search(r'\b(line|graph|chart|over time|trend|timeseries)\b', lower):
        chart = 'timeseries'

    split: list[str] = []
    split_match = re.search(
        r'\b(?:split by|broken down by|grouped by|group by|per|by|for each)\s+([a-z ]+?)'
        r'(?=\s+(?:in|over|for|during|last|past|of|on|and)\b|[,.]|\Z)',
        text,
        _I,
    )
    if split_match and not re.fullmatch(r'the|a|an', split_match.group(1).strip()):
        words = split_match.group(1).strip()
        # "per second" and the like are units, not splits.
        if not re.fullmatch(r'(second|minute|hour|day|sec|min)s?', words):
            split.append(words)

    measure = (
        re.sub(
            r'\s+',
            ' ',
            re.sub(
                r'\b(show|give|get|plot|graph|chart|me|the|a|an|of|for|in|please|i want to see)\b',
                ' ',
                _RANGE.sub(' ', text, count=1),
                flags=_I,
            ),
        ).strip()
        or text
    )

    # Alerts: "alert me if <thing> goes above 800 ms for 5 min".
    alert_match = re.search(
        r'\b(alert|notify|tell|page|ping)\b.*?\b'
        + _THRESHOLD_WORDS
        + r'\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|%|percent)?',
        text,
        _I,
    )
    alert: dict[str, Any] | None = None
    if alert_match:
        for_match = re.search(
            r'\bfor\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b',
            text,
            _I,
        )
        unit_word = (alert_match.group(4) or '').lower() or None
        if not unit_word:
            unit = None
        elif unit_word.startswith('ms') or unit_word.startswith('milli'):
            unit = 'ms'
        elif unit_word.startswith('s'):
            unit = 's'
        else:
            unit = '%'
        alert = {
            'op': '>'
            if re.search(r'above|over|more|exceed|greater', alert_match.group(2), _I)
            else '<',
            'threshold': js_number(alert_match.group(3)),
            'unit': unit,
            'for': (
                f'{for_match.group(1)}{_RANGE_UNITS.get(for_match.group(2).lower(), "m")}'
                if for_match
                else None
            ),
        }

    # Data sources: "monitor https://example.com/health every minute".
    url_match = re.search(r'\b(monitor|check|poll|watch)\b.*?(https?://\S+)', text, _I)
    collector: dict[str, Any] | None = None
    if url_match:
        every = re.search(
            r'\bevery\s+(\d+)?\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hours?)\b', text, _I
        )
        collector = {
            'url': re.sub(r'[.,)]+$', '', url_match.group(2)),
            'interval': (
                f'{every.group(1) or "1"}{_RANGE_UNITS.get(every.group(2).lower(), "m")}'
                if every
                else None
            ),
        }
    intent = 'collector' if collector else 'alert' if alert else 'chart'

    # In "alert me if X goes above 800 ms", the measure is X and the threshold is not a range.
    if alert and alert_match:
        whole = alert_match.group(0)
        at = re.search(r'\b' + _THRESHOLD_WORDS + r'\b', whole, _I)
        watched = text.replace(whole[at.start() if at else -1 :], ' ', 1)
        measure = (
            re.sub(
                r'\s+',
                ' ',
                re.sub(
                    r'\b(goes|is|gets)\b',
                    ' ',
                    re.sub(
                        r'\b(alert|notify|tell|page|ping) me( if| when)?\b', ' ', watched, flags=_I
                    ),
                    flags=_I,
                ),
            ).strip()
            or measure
        )

    return {
        'intent': intent,
        'alert': alert,
        'collector': collector,
        'measure': measure,
        'kind': kind,
        'service': (
            service
            if service and service.lower() not in ('the', 'my', 'our', 'this', 'that')
            else None
        ),
        'endpoint': {'method': method, 'route': route} if route else None,
        'all_endpoints': all_endpoints,
        'percentile': percentile,
        'requests': requests,
        'range': range_,
        'chart': chart,
        'split_by': split,
    }


_SPLIT_SYNONYMS = {
    'endpoint': ['route'],
    'endpoints': ['route'],
    'path': ['route'],
    'url': ['route'],
    'verb': ['method'],
    'code': ['status'],
    'type': ['method'],
}


def _resolve_split(phrase: str, labels: list[str]) -> str | None:
    """The stored label a split phrase means, if the metric has one."""
    wanted: list[str] = []
    for word in (w for w in re.split(r'[^a-z0-9]+', phrase.lower()) if w):
        wanted += [word, re.sub(r's$', '', word), *_SPLIT_SYNONYMS.get(word, [])]
    best: tuple[str, int] | None = None
    for label in labels:
        if label == 'le':
            continue
        parts = label.split('_')
        score = sum(1 for word in wanted if word in parts)
        if score > 0 and (best is None or score > best[1]):
            best = (label, score)
    return best[0] if best else None


def _quote(value: str) -> str:
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def stand_in_write_query(context: WriteContext) -> dict[str, Any]:
    metric = context['metrics'][0]
    stored = re.sub(r'_bucket$', '', metric['series'][0])
    labels = context['labels']

    matchers: list[str] = []
    if context['service']:
        matchers.append(f'{labels["service"]}={_quote(context["service"])}')
    endpoint = context['endpoint']
    if endpoint and labels.get('route'):
        matchers.append(f'{labels["route"]}={_quote(endpoint["route"])}')
        if labels.get('method'):
            matchers.append(f'{labels["method"]}={_quote(endpoint["method"])}')
    status_matcher: str | None = None
    if labels.get('status') and context['requests'] == 'failed_only':
        status_matcher = f'{labels["status"]}=~"5.."'
    elif labels.get('status') and context['requests'] == 'successful_only':
        status_matcher = f'{labels["status"]}!~"5.."'

    def selector(extra: str | None = None) -> str:
        every = [
            *matchers,
            *([status_matcher] if status_matcher else []),
            *([extra] if extra else []),
        ]
        return '{' + ', '.join(every) + '}' if every else ''

    splits = [
        label
        for label in (_resolve_split(phrase, metric['labels']) for phrase in context['split_by'])
        if label is not None
    ]

    def by(extra: list[str] | None = None) -> str:
        every = [*(extra or []), *splits]
        return f' by ({", ".join(every)})' if every else ''

    window = f'[{context["rate_window"]}]'
    target = (
        f'{endpoint["method"]} {endpoint["route"]}'
        if endpoint
        else (context['service'] or 'All services')
    )
    histogram = metric['type'] == 'histogram'

    if histogram and context['kind'] in ('latency', 'other'):
        percentile = context['percentile'] if context['percentile'] is not None else 95
        return {
            'query': (
                f'histogram_quantile({js_string(percentile / 100)}, sum{by(["le"])} '
                f'(rate({stored}_bucket{selector()}{window})))'
            ),
            'title': (
                f'{target} · p{js_string(percentile)} '
                f'{"latency" if context["kind"] == "latency" else metric["name"]}'
            ),
            'unit': metric['unit'],
            'display_unit': 'ms' if metric['unit'] == 's' else None,
        }
    if histogram and context['kind'] == 'errors' and labels.get('status'):
        failed = f'sum{by()} (rate({stored}_count{selector(f'{labels["status"]}=~"5.."')}{window}))'
        every = f'sum{by()} (rate({stored}_count{selector()}{window}))'
        # With no failures in the window there are no failed series at all, and the
        # division would return nothing. `or vector(0)` makes that a plain zero.
        numerator = f'({failed} or vector(0))' if not splits else failed
        return {
            'query': f'{numerator} / {every}',
            'title': f'{target} · error rate',
            'unit': '1',
            'display_unit': '%',
        }
    if histogram:
        return {
            'query': f'sum{by()} (rate({stored}_count{selector()}{window}))',
            'title': f'{target} · requests per second',
            'unit': 'req/s',
            'display_unit': None,
        }
    if metric['type'] == 'counter':
        return {
            'query': f'sum{by()} (rate({stored}{selector()}{window}))',
            'title': f'{target} · {metric["name"]} per second',
            'unit': f'{metric["unit"] or "1"}/s',
            'display_unit': None,
        }
    return {
        'query': f'sum{by()} ({stored}{selector()})',
        'title': f'{target} · {metric["name"]}',
        'unit': metric['unit'] or '1',
        'display_unit': None,
    }


class StandInTransport:
    """The stand-in as a transport, so it goes through the router like any model."""

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        from agent.explain import stand_in_hypothesis

        reply: Any
        if request.task == 'parse':
            reply = stand_in_parse(read_block(request.messages, 'request') or '')
        elif request.task == 'write_query':
            context: WriteContext = json.loads(read_block(request.messages, 'context') or '{}')
            reply = stand_in_write_query(context)
        elif request.task == 'explain':
            reply = {'hypothesis': stand_in_hypothesis(request.messages)}
        else:
            raise RuntimeError(f'The stand-in model cannot do "{request.task}" tasks.')
        return CompletionResponse(
            content=stringify(reply), model=STAND_IN_MODEL, input_tokens=0, output_tokens=0, cost=0
        )
