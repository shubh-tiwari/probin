"""The shared cases in testdata/, which the TypeScript tests run too."""

import json
import math
from pathlib import Path

import pytest

from appcommon.durations import duration_to_seconds
from appcommon.format import display_unit, format_value, series_name
from appcommon.jsnum import js_round, js_string, to_precision
from appcommon.product import manifest_filename, product_name, product_slug, repo_root

TESTDATA = Path(__file__).resolve().parents[3] / 'testdata'
FORMAT = json.loads((TESTDATA / 'format.json').read_text())
DURATIONS = json.loads((TESTDATA / 'durations.json').read_text())


@pytest.mark.parametrize(
    'case', FORMAT['format'], ids=lambda c: f'{c["value"]}-{c["unit"]}-{c["wanted"]}'
)
def test_format_matches_typescript(case: dict[str, object]) -> None:
    value = float(case['value'])  # type: ignore[arg-type]  # 'NaN' and 'Infinity' parse too
    wanted = case['wanted']
    unit = display_unit(str(case['unit']), str(wanted) if wanted else None)
    assert format_value(value, unit) == case['text']


@pytest.mark.parametrize('case', FORMAT['seriesNames'])
def test_series_name_matches_typescript(case: dict[str, object]) -> None:
    assert series_name(case['labels']) == case['name']  # type: ignore[arg-type]


@pytest.mark.parametrize('case', DURATIONS, ids=lambda c: c['input'])
def test_durations_match_typescript(case: dict[str, object]) -> None:
    if case['seconds'] is None:
        with pytest.raises(ValueError):
            duration_to_seconds(str(case['input']))
    else:
        assert duration_to_seconds(str(case['input'])) == case['seconds']


@pytest.mark.parametrize(
    ('value', 'text'),
    [
        (0.000123, '0.000123'),
        (0.0000123, '0.0000123'),
        (1.23e-7, '1.23e-7'),
        (1e21, '1e+21'),
        (123456789012345680000.0, '123456789012345680000'),
        (100.0, '100'),
        (-0.5, '-0.5'),
        (12.3, '12.3'),
        (math.nan, 'NaN'),
    ],
)
def test_js_string(value: float, text: str) -> None:
    assert js_string(value) == text


def test_to_precision_rounds_ties_away_from_zero_like_javascript() -> None:
    assert to_precision(12.25, 3) == 12.3  # Python's '%.3g' gives 12.2
    assert to_precision(-12.25, 3) == -12.3
    assert to_precision(0.000123456, 3) == 0.000123


def test_js_round_rounds_halves_up() -> None:
    assert js_round(2.5) == 3
    assert js_round(-2.5) == -2


def test_product_name_comes_from_the_one_constant() -> None:
    constant = (repo_root() / 'packages/config/src/product.ts').read_text()
    assert f"'{product_name()}'" in constant
    assert product_slug() == product_name().lower()
    assert manifest_filename() == f'{product_slug()}.yaml'
