"""The stand-in parser, case for case with apps/agent/src/standin.test.ts."""

import pytest

from agent.standin import stand_in_parse
from agent.state import ParsedRequest


def test_always_returns_a_valid_parsed_request() -> None:
    for text in ['', 'x', 'latency', 'p95 of /a/b last 5 hr by region', '???']:
        ParsedRequest.model_validate(stand_in_parse(text or 'anything'))


def test_reads_the_build_plan_example() -> None:
    parsed = stand_in_parse('latency graph of checkout service in last 5 hr')
    assert {
        k: parsed[k]
        for k in (
            'kind',
            'service',
            'endpoint',
            'percentile',
            'requests',
            'range',
            'chart',
            'split_by',
        )
    } == {
        'kind': 'latency',
        'service': 'checkout',
        'endpoint': None,
        'percentile': None,
        'requests': None,
        'range': '5h',
        'chart': 'timeseries',
        'split_by': [],
    }


@pytest.mark.parametrize(
    ('phrase', 'range_'),
    [
        ('in the last 30 minutes', '30m'),
        ('over the past 2 hours', '2h'),
        ('last hour', '1h'),
        ('for the last 7 days', '7d'),
        ('today', '24h'),
    ],
)
def test_reads_the_range(phrase: str, range_: str) -> None:
    assert stand_in_parse(f'traffic {phrase}')['range'] == range_


@pytest.mark.parametrize(
    ('text', 'percentile'),
    [
        ('p99 latency', 99),
        ('median latency', 50),
        ('90th percentile latency', 90),
        ('latency', None),
    ],
)
def test_reads_the_percentile(text: str, percentile: int | None) -> None:
    assert stand_in_parse(text)['percentile'] == percentile


def test_tells_what_is_measured_from_which_requests_are_counted() -> None:
    parsed = stand_in_parse('throughput of POST /pay including failures')
    assert (parsed['kind'], parsed['requests'], parsed['endpoint']) == (
        'traffic',
        'all',
        {'method': 'POST', 'route': '/pay'},
    )
    parsed = stand_in_parse('p95 latency of failed requests')
    assert (parsed['kind'], parsed['requests']) == ('latency', 'failed_only')
    parsed = stand_in_parse('error rate')
    assert (parsed['kind'], parsed['requests']) == ('errors', None)


def test_reads_a_split_and_does_not_mistake_a_unit_for_one() -> None:
    assert stand_in_parse('orders completed by payment method in the last 6 hours')['split_by'] == [
        'payment method'
    ]
    assert stand_in_parse('requests per second for checkout')['split_by'] == []
