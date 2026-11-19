"""The connector, case for case with apps/connector/src/connector.test.ts."""

import json
from typing import Any

from mcp.client import Client

from connector.server import create_connector


class FakeApi:
    async def services(self) -> Any:
        return {'services': ['checkout', 'inventory']}

    async def search(self, text: str, service: str | None = None) -> Any:
        return {
            'metrics': [{'name': 'http.server.request.duration', 'text': text}],
            'endpoints': [],
        }

    async def endpoints(self, service: str) -> Any:
        return {'endpoints': [{'method': 'POST', 'route': '/checkout/pay', 'p95': 0.8}]}

    async def query(self, query: str, range_: str) -> Any:
        if query == 'boom':
            raise RuntimeError('too many lines')
        return {
            'series': [{'labels': {'http_route': '/pay'}, 'points': [[1, 0.5], [2, 0.9]]}],
            'lineCount': 1,
            'step': 60,
        }


async def test_offers_five_read_only_tools() -> None:
    async with Client(create_connector(FakeApi())) as client:
        tools = (await client.list_tools()).tools
    assert [t.name for t in tools] == [
        'list_services',
        'search_metrics',
        'endpoint_stats',
        'query_metrics',
        'production_context',
    ]
    assert all(t.annotations and t.annotations.read_only_hint for t in tools)


async def test_summarises_a_query_per_line() -> None:
    async with Client(create_connector(FakeApi())) as client:
        result = await client.call_tool('query_metrics', {'query': 'up', 'range': '1h'})
    assert not result.is_error
    body = json.loads(result.content[0].text)  # type: ignore[union-attr]
    assert body == {
        'lines': 1,
        'step_seconds': 60,
        'series': [
            {
                'labels': {'http_route': '/pay'},
                'points': 2,
                'first': 0.5,
                'last': 0.9,
                'min': 0.5,
                'max': 0.9,
            }
        ],
    }


async def test_refuses_a_range_that_is_not_a_duration() -> None:
    async with Client(create_connector(FakeApi())) as client:
        result = await client.call_tool('query_metrics', {'query': 'up', 'range': 'forever'})
    assert result.is_error


async def test_a_failed_query_is_an_error_result_with_the_reason() -> None:
    async with Client(create_connector(FakeApi())) as client:
        result = await client.call_tool('query_metrics', {'query': 'boom'})
    assert result.is_error
    assert result.content[0].text == 'The query failed: too many lines'  # type: ignore[union-attr]


async def test_lists_services_as_pretty_json() -> None:
    async with Client(create_connector(FakeApi())) as client:
        result = await client.call_tool('list_services', {})
    assert result.content[0].text == json.dumps({'services': ['checkout', 'inventory']}, indent=2)  # type: ignore[union-attr]


class ContextApi(FakeApi):
    def __init__(self) -> None:
        self.sent: dict[str, Any] = {}

    async def context(self, files: list[dict[str, str]], manifests: list[dict[str, str]]) -> Any:
        self.sent = {'files': files, 'manifests': manifests}
        return {'summary': 'Production context from the last hour of metrics.'}


def repo(tmp: Any) -> Any:
    from appcommon.product import manifest_filename

    (tmp / '.git').mkdir()
    service = tmp / 'services' / 'checkout'
    (service / 'src').mkdir(parents=True)
    (service / manifest_filename()).write_text('service: checkout\n')
    (service / 'src' / 'server.cjs').write_text("app.post('/checkout/pay', async () => {});\n")
    return tmp


async def test_production_context_sends_the_files_and_their_manifest(tmp_path: Any) -> None:
    from appcommon.product import manifest_filename

    root = repo(tmp_path)
    api = ContextApi()
    async with Client(create_connector(api, cwd=root / 'services')) as client:
        result = await client.call_tool(
            'production_context', {'paths': ['checkout/src/server.cjs']}
        )
    assert not result.is_error
    assert result.content[0].text.startswith('Production context')  # type: ignore[union-attr]
    assert api.sent['files'] == [
        {
            'path': 'services/checkout/src/server.cjs',
            'content': "app.post('/checkout/pay', async () => {});\n",
        }
    ]
    assert api.sent['manifests'] == [
        {'path': f'services/checkout/{manifest_filename()}', 'content': 'service: checkout\n'}
    ]


async def test_production_context_reports_files_it_could_not_read(tmp_path: Any) -> None:
    root = repo(tmp_path)
    api = ContextApi()
    async with Client(create_connector(api, cwd=root)) as client:
        partly = await client.call_tool(
            'production_context',
            {'paths': ['services/checkout/src/server.cjs', 'nope.js', '../../etc/passwd']},
        )
        none = await client.call_tool('production_context', {'paths': ['nope.js']})
    text = partly.content[0].text  # type: ignore[union-attr]
    assert 'Not read: nope.js: no such file; ../../etc/passwd: outside the repository' in text
    assert none.is_error
