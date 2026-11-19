"""Where model calls are logged and budgets read (packages/router/src/ledger.ts)."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

from psycopg_pool import AsyncConnectionPool

from modelrouter.types import Budget, CallOutcome, CallRecord


@dataclass
class MemoryLedger:
    """A ledger in memory, for tests and for runs with no database."""

    limit: float | None = None
    calls: list[tuple[str, CallRecord]] = field(default_factory=list)

    async def budget(self, workspace_id: str) -> Budget:
        return Budget(limit=self.limit, spent=sum(call.cost for _, call in self.calls))

    async def record(self, call: CallRecord) -> str:
        call_id = f'call-{len(self.calls) + 1}'
        self.calls.append((call_id, replace(call)))
        return call_id

    async def set_outcome(self, call_id: str, outcome: CallOutcome) -> None:
        for stored_id, call in self.calls:
            if stored_id == call_id:
                call.outcome = outcome

    @property
    def records(self) -> list[CallRecord]:
        return [call for _, call in self.calls]


class DatabaseLedger:
    """model_calls in Postgres for spend; the workspace's budget from the platform service."""

    def __init__(
        self,
        pool: AsyncConnectionPool,
        budget_limit: Callable[[str], Awaitable[float | None]],
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._pool = pool
        self._limit = budget_limit
        self._now = now

    async def budget(self, workspace_id: str) -> Budget:
        limit = await self._limit(workspace_id)
        today = self._now()
        month_start = datetime(today.year, today.month, 1, tzinfo=UTC)
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                'select coalesce(sum(cost), 0) from model_calls '
                'where workspace_id = %s and created_at >= %s',
                (workspace_id, month_start),
            )
            row = await cur.fetchone()
        return Budget(limit=limit, spent=float(row[0]) if row else 0.0)

    async def record(self, call: CallRecord) -> str:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                'insert into model_calls (workspace_id, request_id, task_type, model, '
                'input_tokens, output_tokens, cost, outcome, escalated_from) '
                'values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id',
                (
                    call.workspace_id,
                    call.request_id,
                    call.task,
                    call.model,
                    call.input_tokens,
                    call.output_tokens,
                    f'{call.cost:.6f}',
                    call.outcome,
                    call.escalated_from,
                ),
            )
            row = await cur.fetchone()
        assert row is not None
        return str(row[0])

    async def set_outcome(self, call_id: str, outcome: CallOutcome) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                'update model_calls set outcome = %s where id = %s', (outcome, call_id)
            )
