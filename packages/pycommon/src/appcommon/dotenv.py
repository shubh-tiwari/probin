"""Load a .env file into the environment, as `node --env-file-if-exists=.env` does.

Variables already set win. Lines are KEY=VALUE; blank lines and # comments are
skipped; matching single or double quotes around a value are removed.
"""

import os
from pathlib import Path


def load_env_file(path: str | Path = '.env') -> None:
    file = Path(path)
    if not file.is_file():
        return
    for raw in file.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip().removeprefix('export ').strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        os.environ.setdefault(key, value)
