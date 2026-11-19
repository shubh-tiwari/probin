"""The agent's own tables: open requests and the resolved-request cache.

The schema and its migrations live in packages/db (Drizzle); this module only
reads and writes rows.
"""

import copy
import re
from typing import Any, cast

from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from agent.state import AgentState
from agent.tools import ResolvedRequest

_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
#: Statuses that mean the request has a chart a Slack thread can change.
_WITH_CHART = ('draft', 'saved', 'alert')

Surface = dict[str, Any]


class DatabaseRequestStore:
    """Requests in Postgres, so a Slack thread can be answered hours later and after a restart."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def get(self, request_id: str, workspace_id: str) -> tuple[AgentState, Surface] | None:
        if not _UUID.match(request_id):
            return None
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                'select state, surface from agent_requests where id = %s and workspace_id = %s',
                (request_id, workspace_id),
            )
            row = await cur.fetchone()
        return (cast(AgentState, row[0]), cast(Surface, row[1])) if row else None

    async def put(self, state: AgentState, surface: Surface | None = None) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                'insert into agent_requests (id, workspace_id, user_id, status, state, surface) '
                'values (%s, %s, %s, %s, %s, %s) '
                'on conflict (id) do update set status = excluded.status, state = excluded.state, '
                'updated_at = now()'
                + (', surface = excluded.surface' if surface is not None else ''),
                (
                    state['requestId'],
                    state['workspaceId'],
                    state['userId'],
                    state['status'],
                    Jsonb(state),
                    Jsonb(surface or {}),
                ),
            )

    async def latest_in_thread(
        self, workspace_id: str, channel: str, thread_ts: str
    ) -> AgentState | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                'select state from agent_requests where workspace_id = %s and status = any(%s) '
                "and surface->'slack'->>'channel' = %s and surface->'slack'->>'thread_ts' = %s "
                'order by updated_at desc limit 1',
                (workspace_id, list(_WITH_CHART), channel, thread_ts),
            )
            row = await cur.fetchone()
        return cast(AgentState, row[0]) if row else None

    async def prune(self, days: int) -> None:
        """Delete requests nobody has touched for `days`."""
        async with self._pool.connection() as conn:
            await conn.execute(
                'delete from agent_requests where updated_at < now() - make_interval(days => %s)',
                (days,),
            )


class MemoryRequestStore:
    """Requests in memory: for tests."""

    def __init__(self) -> None:
        self._entries: dict[str, tuple[AgentState, Surface]] = {}

    async def get(self, request_id: str, workspace_id: str) -> tuple[AgentState, Surface] | None:
        entry = self._entries.get(request_id)
        if not entry or entry[0]['workspaceId'] != workspace_id:
            return None
        return copy.deepcopy(entry)

    async def put(self, state: AgentState, surface: Surface | None = None) -> None:
        previous = self._entries.get(state['requestId'])
        kept = surface if surface is not None else (previous[1] if previous else {})
        self._entries[state['requestId']] = copy.deepcopy((state, kept))

    async def latest_in_thread(
        self, workspace_id: str, channel: str, thread_ts: str
    ) -> AgentState | None:
        found = [
            state
            for state, surface in self._entries.values()
            if state['workspaceId'] == workspace_id
            and (surface.get('slack') or {}).get('channel') == channel
            and (surface.get('slack') or {}).get('thread_ts') == thread_ts
            and state['status'] in _WITH_CHART
        ]
        return copy.deepcopy(found[-1]) if found else None


class ResolvedRows:
    """The resolved_requests table for one workspace."""

    def __init__(self, pool: AsyncConnectionPool, workspace_id: str) -> None:
        self._pool = pool
        self._workspace = workspace_id

    async def get(self, key: str) -> ResolvedRequest | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                'select value, catalog_fingerprint from resolved_requests '
                'where workspace_id = %s and key = %s',
                (self._workspace, key),
            )
            row = await cur.fetchone()
            if not row:
                return None
            await conn.execute(
                'update resolved_requests set hits = hits + 1 where workspace_id = %s and key = %s',
                (self._workspace, key),
            )
        return cast(ResolvedRequest, {**row[0], 'fingerprint': row[1]})

    async def put(self, key: str, entry: ResolvedRequest) -> None:
        value = {k: v for k, v in entry.items() if k != 'fingerprint'}
        async with self._pool.connection() as conn:
            await conn.execute(
                'insert into resolved_requests (workspace_id, key, value, catalog_fingerprint) '
                'values (%s, %s, %s, %s) on conflict (workspace_id, key) do update set '
                'value = excluded.value, catalog_fingerprint = excluded.catalog_fingerprint, '
                'hits = 0, created_at = now()',
                (self._workspace, key, Jsonb(value), entry['fingerprint']),
            )
