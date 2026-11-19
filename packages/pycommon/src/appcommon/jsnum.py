"""JavaScript's number-to-text rules, where Python's differ.

The TypeScript services write numbers with `String(n)`, `toPrecision` and
`Math.round`. Text the agent shows or sends to a model must read the same.
"""

import math
from decimal import ROUND_HALF_UP, Decimal


def js_string(value: float) -> str:
    """`String(value)` for a JavaScript number (ECMAScript Number::toString)."""
    if math.isnan(value):
        return 'NaN'
    if math.isinf(value):
        return 'Infinity' if value > 0 else '-Infinity'
    if value == 0:
        return '0'
    sign = '-' if value < 0 else ''
    # repr gives the shortest digits that round-trip, as JavaScript does.
    parts = Decimal(repr(abs(float(value)))).normalize().as_tuple()
    digits = ''.join(map(str, parts.digits))
    k = len(digits)
    n = k + int(parts.exponent)  # where the decimal point sits, counted from the first digit
    if k <= n <= 21:
        text = digits + '0' * (n - k)
    elif 0 < n <= 21:
        text = f'{digits[:n]}.{digits[n:]}'
    elif -6 < n <= 0:
        text = '0.' + '0' * (-n) + digits
    else:
        e = n - 1
        mantissa = digits[0] + (f'.{digits[1:]}' if k > 1 else '')
        text = f'{mantissa}e{"+" if e >= 0 else "-"}{abs(e)}'
    return sign + text


def to_precision(value: float, precision: int) -> float:
    """`Number(value.toPrecision(precision))`: ties round away from zero, as JavaScript does."""
    if value == 0 or not math.isfinite(value):
        return value
    exact = Decimal(abs(value))
    exponent = exact.adjusted() - precision + 1
    rounded = exact.quantize(Decimal(1).scaleb(exponent), rounding=ROUND_HALF_UP)
    return math.copysign(float(rounded), value)


def js_round(value: float) -> int:
    """`Math.round`: halves round toward positive infinity."""
    return math.floor(value + 0.5)
