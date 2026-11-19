"""HTTP clients for the services the agent calls: the Query API and the platform service.

Both are internal: the agent proves it with the shared token and names the
workspace it acts for. The agent never holds the metrics store's address.
"""

from typing import Any

import httpx

from agent.catalog import CatalogMetric, CatalogSearch, CatalogSearchResult
from agent.errors import SpecValidationError, UnsafeUrlError
from agent.tools import Actor, DryRunResult, SpecKind


class QueryApiError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class PlatformError(Exception):
    pass


def _headers(token: str, workspace_id: str) -> dict[str, str]:
    return {'authorization': f'Bearer {token}', 'x-workspace-id': workspace_id}


class QueryApi:
    """apps/query-api: dry runs and range queries, scoped to one workspace."""

    def __init__(self, http: httpx.AsyncClient, url: str, token: str, workspace_id: str) -> None:
        self._http = http
        self._url = url
        self._headers = _headers(token, workspace_id)

    async def _post(self, path: str, body: dict[str, Any]) -> Any:
        try:
            response = await self._http.post(f'{self._url}{path}', json=body, headers=self._headers)
        except httpx.HTTPError as error:
            raise QueryApiError('unavailable', f'The Query API is unavailable: {error}') from error
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if response.is_error:
            problem = (payload or {}).get('error') or {}
            raise QueryApiError(
                str(problem.get('code', 'unavailable')),
                str(problem.get('message', f'The Query API returned HTTP {response.status_code}.')),
            )
        return payload

    async def dry_run(self, query: str, range_: str) -> DryRunResult:
        result: DryRunResult = await self._post('/v1/dry-run', {'query': query, 'range': range_})
        return result

    async def query(
        self, query: str, range_: str, step: int | None = None, end: int | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {'query': query, 'range': range_}
        if step is not None:
            body['step'] = step
        if end is not None:
            body['end'] = end
        result: dict[str, Any] = await self._post('/v1/query', body)
        return result


class Platform:
    """apps/platform: catalog, PromQL analysis, spec validation and the stores."""

    def __init__(self, http: httpx.AsyncClient, url: str, token: str, workspace_id: str) -> None:
        self._http = http
        self._url = url
        self._headers = _headers(token, workspace_id)

    async def _call(
        self, method: str, path: str, body: Any = None, params: dict[str, str] | None = None
    ) -> httpx.Response:
        try:
            return await self._http.request(
                method, f'{self._url}{path}', json=body, params=params, headers=self._headers
            )
        except httpx.HTTPError as error:
            raise PlatformError(f'The platform service is unavailable: {error}') from error

    async def _json(
        self, method: str, path: str, body: Any = None, params: dict[str, str] | None = None
    ) -> Any:
        response = await self._call(method, path, body, params)
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code == 422:
            message = str(payload.get('error', 'Invalid.'))
            if payload.get('reason') == 'unsafe_url':
                raise UnsafeUrlError(message)
            raise SpecValidationError(message)
        if response.status_code == 404:
            return None
        if response.is_error:
            raise PlatformError(str(payload.get('error', f'HTTP {response.status_code}')))
        return payload

    async def workspace(self) -> dict[str, Any] | None:
        result: dict[str, Any] | None = await self._json('GET', '/v1/workspace')
        return result

    async def search_catalog(self, search: CatalogSearch) -> CatalogSearchResult:
        result: CatalogSearchResult = await self._json('POST', '/v1/catalog/search', search)
        return result

    async def resolved(self, services: list[str]) -> dict[str, Any]:
        result: dict[str, Any] = await self._json(
            'POST', '/v1/catalog/resolved', {'services': services}
        )
        return result

    async def list_metrics(self, service: str | None = None) -> list[CatalogMetric]:
        params = {'service': service} if service else None
        result = await self._json('GET', '/v1/catalog/metrics', params=params)
        metrics: list[CatalogMetric] = result['metrics']
        return metrics

    async def analyze(self, query: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._json('POST', '/v1/promql/analyze', {'query': query})
        return result

    async def validate(self, kind: SpecKind, spec: Any) -> dict[str, Any]:
        result = await self._json('POST', f'/v1/specs/{kind}/validate', {'spec': spec})
        valid: dict[str, Any] = result['spec']
        return valid

    async def save_panel(
        self, spec: dict[str, Any], actor: Actor, dashboard_id: str | None, panel_id: str | None
    ) -> Any:
        body: dict[str, Any] = {'spec': spec, 'actor': actor}
        if dashboard_id:
            body['dashboardId'] = dashboard_id
        if panel_id:
            body['panelId'] = panel_id
        return await self._json('POST', '/v1/panels', body)

    async def load_panel(self, panel_id: str) -> dict[str, Any] | None:
        result: dict[str, Any] | None = await self._json('GET', f'/v1/panels/{panel_id}')
        return result

    async def draft_alert(self, spec: dict[str, Any], actor: Actor) -> dict[str, str]:
        result: dict[str, str] = await self._json(
            'POST', '/v1/alerts/draft', {'spec': spec, 'actor': actor}
        )
        return result

    async def alert(self, rule_id: str) -> dict[str, Any] | None:
        result: dict[str, Any] | None = await self._json('GET', f'/v1/alerts/{rule_id}')
        return result

    async def draft_collector(self, spec: dict[str, Any], actor: Actor) -> dict[str, Any]:
        result: dict[str, Any] = await self._json(
            'POST', '/v1/collectors/draft', {'spec': spec, 'actor': actor}
        )
        return result

    async def read_defaults(self, user_id: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._json(
            'GET', '/v1/memory/defaults', params={'user': user_id}
        )
        return result

    async def save_defaults(self, user_id: str, defaults: dict[str, Any], source: str) -> int:
        result = await self._json(
            'PUT', '/v1/memory/defaults', {'user': user_id, 'defaults': defaults, 'source': source}
        )
        return int(result['saved'])

    async def write_incident(self, entry: dict[str, Any]) -> None:
        await self._json('POST', '/v1/memory/incident', entry)
