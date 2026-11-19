"""The product's name, read from its one constant.

The name lives only in packages/config/src/product.ts (`pnpm check:product-name`
enforces it), so Python reads it from there instead of writing it again.
"""

import os
import re
from functools import cache
from pathlib import Path

_CONSTANT = 'packages/config/src/product.ts'
_NAME = re.compile(r"""export\s+const\s+PRODUCT_NAME\s*(?::\s*string\s*)?=\s*(['"`])(.+?)\1""")


def repo_root() -> Path:
    """The repository root: `APP_REPO_ROOT`, else the first parent holding the constant."""
    configured = os.environ.get('APP_REPO_ROOT')
    if configured:
        return Path(configured)
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / _CONSTANT).is_file():
            return parent
    raise RuntimeError(f'Cannot find {_CONSTANT} above {here}; set APP_REPO_ROOT.')


@cache
def product_name() -> str:
    text = (repo_root() / _CONSTANT).read_text(encoding='utf-8')
    match = _NAME.search(text)
    if not match:
        raise RuntimeError(f'PRODUCT_NAME not found in {_CONSTANT}.')
    return match.group(2)


def product_slug() -> str:
    """Lower-case form for names and identifiers, as PRODUCT_SLUG in TypeScript."""
    return re.sub(r'[^a-z0-9]+', '-', product_name().lower())


def manifest_filename() -> str:
    return f'{product_slug()}.yaml'
