"""Prometheus-style durations such as 30s, 5m, 5h, 7d (packages/specs/src/common.ts)."""

import re

DURATION = re.compile(r'^[1-9][0-9]*(ms|s|m|h|d|w|y)$')

_UNIT_SECONDS: dict[str, float] = {
    'ms': 0.001,
    's': 1,
    'm': 60,
    'h': 3600,
    'd': 86_400,
    'w': 604_800,
    'y': 31_536_000,
}


def is_duration(value: str) -> bool:
    return DURATION.fullmatch(value) is not None


def duration_to_seconds(duration: str) -> float:
    """The length of a duration in seconds. Raises ValueError if it is not one."""
    match = re.fullmatch(r'([1-9][0-9]*)(ms|s|m|h|d|w|y)', duration)
    if not match:
        raise ValueError(f'"{duration}" is not a duration such as 30s, 5m or 5h')
    seconds = int(match.group(1)) * _UNIT_SECONDS[match.group(2)]
    return int(seconds) if float(seconds).is_integer() else seconds
