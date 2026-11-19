"""The real backends behind the tools, for one workspace (apps/agent/src/backends.ts).

Catalog, specs and stores through the platform service; queries through the
Query API; the resolved-request cache in the agent's own table.
"""

import httpx
from psycopg_pool import AsyncConnectionPool

from agent.clients import Platform, QueryApi
from agent.settings import Settings
from agent.store import ResolvedRows
from agent.tools import ResolvedCache, ToolBackends


def platform_for(http: httpx.AsyncClient, settings: Settings, workspace_id: str) -> Platform:
    return Platform(http, settings.platform_url, settings.internal_token, workspace_id)


def query_api_for(http: httpx.AsyncClient, settings: Settings, workspace_id: str) -> QueryApi:
    return QueryApi(http, settings.query_api_url, settings.internal_token, workspace_id)


def create_backends(
    *, http: httpx.AsyncClient, pool: AsyncConnectionPool, settings: Settings, workspace_id: str
) -> ToolBackends:
    platform = platform_for(http, settings, workspace_id)
    query_api = query_api_for(http, settings, workspace_id)
    rows = ResolvedRows(pool, workspace_id)

    async def fingerprint(services: list[str]) -> str:
        return str((await platform.resolved(services))['fingerprint'])

    async def names(services: list[str]) -> dict[str, list[str]]:
        found: dict[str, list[str]] = (await platform.resolved(services))['names']
        return found

    return ToolBackends(
        search_catalog=platform.search_catalog,
        dry_run=query_api.dry_run,
        save_panel=platform.save_panel,
        analyze=platform.analyze,
        validate=platform.validate,
        draft_alert=platform.draft_alert,
        draft_collector=platform.draft_collector,
        resolved=ResolvedCache(get=rows.get, put=rows.put, fingerprint=fingerprint, names=names),
    )
