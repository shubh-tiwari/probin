"""The connector for coding agents, run on a developer's machine:

    claude mcp add <name> -e METRICS_API_URL=https://<web tool> -e METRICS_API_TOKEN=<token> \\
      -- uv run --project <repo>/apps/connector connector

The token is a read-only API token from Settings in the web tool.
"""

import os
import sys

from connector.api import ReadApi
from connector.server import create_connector


def run() -> None:
    url = os.environ.get('METRICS_API_URL')
    token = os.environ.get('METRICS_API_TOKEN')
    if not url or not token:
        print(
            'Set METRICS_API_URL (the web tool) and METRICS_API_TOKEN '
            '(a read-only API token from Settings).',
            file=sys.stderr,
        )
        sys.exit(2)
    create_connector(ReadApi(url, token)).run()


if __name__ == '__main__':
    run()
