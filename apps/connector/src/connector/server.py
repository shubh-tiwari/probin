"""The connector's tools (apps/connector/src/server.ts).

Lets a coding agent look at the workspace's live metrics while it works.
Read-only: it can list and search the catalog, see endpoints with their
request rate and p95, and run queries. It cannot change anything.
"""

import json
from pathlib import Path
from typing import Annotated, Any, Protocol

from mcp.server.mcpserver import MCPServer
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field

from appcommon.product import product_name, product_slug
from connector.workspace_files import gather

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)


class Api(Protocol):
    async def services(self) -> Any: ...
    async def search(self, text: str, service: str | None = None) -> Any: ...
    async def endpoints(self, service: str) -> Any: ...
    async def query(self, query: str, range_: str) -> Any: ...
    async def context(
        self, files: list[dict[str, str]], manifests: list[dict[str, str]]
    ) -> Any: ...


def _text(value: Any) -> str:
    """Tool output as the TypeScript connector wrote it: pretty JSON, two-space indent."""
    return value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False)


def summarise(result: dict[str, Any]) -> dict[str, Any]:
    """A query result small enough for a conversation: per line, first, last, min and max."""
    series = []
    for line in result['series'][:20]:
        values = [point[1] for point in line['points']]
        series.append(
            {
                'labels': line['labels'],
                'points': len(values),
                'first': values[0] if values else None,
                'last': values[-1] if values else None,
                'min': min(values) if values else None,
                'max': max(values) if values else None,
            }
        )
    return {'lines': result['lineCount'], 'step_seconds': result['step'], 'series': series}


def create_connector(api: Api, cwd: Path | None = None) -> MCPServer:
    server = MCPServer(name=f'{product_slug()}-metrics', version='1.0.0')

    @server.tool(
        name='list_services',
        title='List services',
        description=f'Services that send metrics to {product_name()} in this workspace.',
        annotations=READ_ONLY,
        structured_output=False,
    )
    async def list_services() -> str:
        return _text(await api.services())

    @server.tool(
        name='search_metrics',
        title='Search metrics',
        description=(
            'Find metrics by what they measure, e.g. "checkout latency" or "orders completed". '
            'Returns stored series names, labels and units to use in queries.'
        ),
        annotations=READ_ONLY,
        structured_output=False,
    )
    async def search_metrics(
        text: Annotated[str, Field(min_length=1)], service: str | None = None
    ) -> str:
        return _text(await api.search(text, service))

    @server.tool(
        name='endpoint_stats',
        title='Endpoint stats',
        description=(
            'The endpoints of a service with their current request rate (per second) '
            'and p95 latency (seconds).'
        ),
        annotations=READ_ONLY,
        structured_output=False,
    )
    async def endpoint_stats(service: Annotated[str, Field(min_length=1)]) -> str:
        return _text(await api.endpoints(service))

    @server.tool(
        name='query_metrics',
        title='Query metrics',
        description=(
            'Run a PromQL query over a recent range (e.g. "1h", "6h"). Use names from '
            'search_metrics. Returns a summary per line.'
        ),
        annotations=READ_ONLY,
        structured_output=False,
    )
    async def query_metrics(
        query: Annotated[str, Field(min_length=1)],
        range: Annotated[str, Field(pattern=r'^[1-9][0-9]*(m|h|d)$')] = '1h',
    ) -> str | CallToolResult:
        try:
            return _text(summarise(await api.query(query, range)))
        except Exception as error:
            return CallToolResult(
                content=[TextContent(type='text', text=f'The query failed: {error}')], is_error=True
            )

    @server.tool(
        name='production_context',
        title='Production context',
        description=(
            'Call this before you change code that handles requests. Pass the files you are '
            'about to edit (paths relative to the current directory). It says which endpoints '
            'those files serve and how each behaves in production over the last hour: p95 '
            'latency, traffic, failure rate, how it ranks in its service, the alert rules '
            'watching it, and the services it calls. Keep slow and busy paths fast; do not add '
            'work to them without need. The files are read, never stored.'
        ),
        annotations=READ_ONLY,
        structured_output=False,
    )
    async def production_context(
        paths: Annotated[list[str], Field(min_length=1, max_length=20)],
    ) -> str | CallToolResult:
        found = gather(paths, cwd or Path.cwd())
        if not found.files:
            return CallToolResult(
                content=[
                    TextContent(
                        type='text', text='No file could be read: ' + '; '.join(found.skipped)
                    )
                ],
                is_error=True,
            )
        try:
            result = await api.context(found.files, found.manifests)
        except Exception as error:
            return CallToolResult(
                content=[
                    TextContent(type='text', text=f'Production context is unavailable: {error}')
                ],
                is_error=True,
            )
        summary = str(result.get('summary', ''))
        if found.skipped:
            summary += '\n\nNot read: ' + '; '.join(found.skipped)
        return summary

    return server
