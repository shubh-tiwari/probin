"""The read-only API the connector uses: the web tool's /api, with an API token."""

from typing import Any

import httpx


class ReadApi:
    def __init__(self, url: str, token: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = url.rstrip('/')
        self._headers = {'authorization': f'Bearer {token}', 'content-type': 'application/json'}
        self._http = client or httpx.AsyncClient(timeout=30)

    async def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._http.request(
            method, f'{self._base}/api{path}', headers=self._headers, **kwargs
        )
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.is_error:
            raise RuntimeError((body or {}).get('error') or f'HTTP {response.status_code}')
        return body

    async def services(self) -> Any:
        return await self._call('GET', '/v1/services')

    async def search(self, text: str, service: str | None = None) -> Any:
        params = {'text': text, **({'service': service} if service else {})}
        return await self._call('GET', '/v1/catalog/search', params=params)

    async def endpoints(self, service: str) -> Any:
        return await self._call('GET', '/v1/endpoints', params={'service': service})

    async def query(self, query: str, range_: str) -> Any:
        return await self._call('POST', '/v1/query', json={'query': query, 'range': range_})

    async def context(self, files: list[dict[str, str]], manifests: list[dict[str, str]]) -> Any:
        return await self._call(
            'POST', '/v1/context', json={'files': files, 'manifests': manifests}
        )
