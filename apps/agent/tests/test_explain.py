"""Explaining an alert, case for case with apps/agent/src/explain.test.ts."""

import re
from typing import Any

from agent.explain import (
    explain_messages,
    measure_changes,
    rank_changes,
    related_queries,
    stand_in_hypothesis,
)

from .harness import CATALOG


def result(series: list[tuple[dict[str, str], list[float]]]) -> dict[str, Any]:
    return {
        'series': [
            {'labels': labels, 'points': [[i * 60, v] for i, v in enumerate(values)]}
            for labels, values in series
        ]
    }


def test_looks_at_traffic_errors_and_latency_of_the_same_service() -> None:
    titles = [q['title'] for q in related_queries('checkout', CATALOG['metrics'])]
    assert titles == [
        'checkout · p95 latency by endpoint',
        'checkout · requests per second by endpoint',
        'checkout · failed requests per second by endpoint',
    ]


def test_ranks_the_lines_that_moved_most() -> None:
    changes = measure_changes(
        {'title': 't', 'query': 'q', 'unit': 's'},
        result(
            [
                ({'r': 'steady'}, [1, 1, 1, 1, 1, 1]),
                ({'r': 'doubled'}, [1, 1, 1, 2, 2, 2]),
                ({'r': 'halved'}, [4, 4, 4, 2, 2, 2]),
                ({'r': 'tripled'}, [1, 1, 1, 3, 3, 3]),
            ]
        ),
        180,
    )
    assert [c['labels']['r'] for c in rank_changes(changes)] == ['tripled', 'doubled', 'halved']


def test_labels_the_explanation_as_a_hypothesis() -> None:
    assert re.match(
        r'^Hypothesis: ',
        stand_in_hypothesis(explain_messages({'alert': {'name': 'x'}, 'changes': []})),
    )
    assert stand_in_hypothesis(
        explain_messages(
            {'alert': {'name': 'x'}, 'changes': [{'series': 'a', 'before': '1', 'after': '3'}]}
        )
    ) == (
        'Hypothesis: this is likely related to a, which moved from 1 to 3 around the time the '
        'alert started.'
    )
