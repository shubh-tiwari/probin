"""JSON written the way JavaScript's JSON.stringify writes it.

Prompts carry JSON for the model, and the stand-in reads it back. Whole
numbers are written without a decimal point (95, not 95.0), non-ASCII text is
kept as is, and NaN or Infinity become null, as in JavaScript.
"""

import json
import math
from typing import Any


def _as_js(value: Any) -> Any:
    if isinstance(value, float) and not isinstance(value, bool):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() and abs(value) < 1e21 else value
    if isinstance(value, dict):
        return {key: _as_js(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_js(item) for item in value]
    return value


def stringify(value: Any, indent: int | None = None) -> str:
    """JSON.stringify(value, null, indent)."""
    if indent is None:
        return json.dumps(_as_js(value), ensure_ascii=False, separators=(',', ':'))
    return json.dumps(_as_js(value), ensure_ascii=False, indent=indent)
