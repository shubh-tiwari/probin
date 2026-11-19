"""Units and numbers as people read them (packages/charts/src/format.ts)."""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass

from appcommon.jsnum import js_round, js_string, to_precision


@dataclass(frozen=True)
class DisplayUnit:
    factor: float
    suffix: str
    spaced: bool


_KNOWN: dict[str, dict[str, DisplayUnit]] = {
    's': {
        's': DisplayUnit(1, 's', False),
        'ms': DisplayUnit(1000, 'ms', True),
    },
    '1': {
        '1': DisplayUnit(1, '', False),
        '%': DisplayUnit(100, '%', False),
    },
    'By': {
        'By': DisplayUnit(1, 'B', True),
    },
}


def display_unit(unit: str, wanted: str | None = None) -> DisplayUnit:
    """How to show values of a query in `unit`, asked to be shown in `wanted`."""
    from_unit = _KNOWN.get(unit)
    if from_unit and wanted and wanted in from_unit:
        return from_unit[wanted]
    if from_unit and unit in from_unit:
        return from_unit[unit]
    plain = re.sub(r'^1$', '', re.sub(r'\{([^}]*)\}', r'\1', unit))
    return DisplayUnit(1, plain, True)


def _trim(value: float) -> str:
    return js_string(to_precision(value, 3))


def format_number(value: float) -> str:
    """A number with three significant digits at most, without trailing zeros."""
    if not math.isfinite(value):
        return '\u2013'  # an en dash, as the TypeScript charts write it
    size = abs(value)
    if size >= 1e9:
        return f'{_trim(value / 1e9)}B'
    if size >= 1e6:
        return f'{_trim(value / 1e6)}M'
    if size >= 1e4:
        return f'{_trim(value / 1e3)}k'
    if size == 0:
        return '0'
    if size >= 100:
        return js_string(js_round(value))
    return _trim(value)


def format_value(value: float, unit: DisplayUnit) -> str:
    """A value in the query's unit, shown in the display unit."""
    shown = format_number(value * unit.factor)
    if not unit.suffix:
        return shown
    return f'{shown} {unit.suffix}' if unit.spaced else f'{shown}{unit.suffix}'


def series_name(labels: Mapping[str, str]) -> str:
    """A label set as a short legend entry. `{}` reads as "all"."""
    values = [value for key, value in labels.items() if key != '__name__']
    return ' · '.join(values) if values else 'all'
