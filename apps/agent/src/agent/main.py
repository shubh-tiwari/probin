"""Start the agent service (apps/agent/src/main.ts)."""

import asyncio
import contextlib
import logging
import socket
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
import uvicorn
from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool

from agent.app import AgentAppDependencies, create_agent_app
from agent.backends import create_backends, platform_for, query_api_for
from agent.explain_rule import explain_rule
from agent.loop import LoopDependencies
from agent.models import choose_models
from agent.settings import Settings
from agent.state import UserDefaults
from agent.store import DatabaseRequestStore
from modelrouter import DatabaseLedger, Router

log = logging.getLogger('agent')

#: Open requests nobody has touched for this many days are dropped, checked hourly.
PRUNE_AFTER_DAYS = 7
PRUNE_EVERY_SECONDS = 3600

_CANCELLED = (
    'This workspace\u2019s subscription is cancelled. Building new charts and alerts is paused.'
)
_TRIAL_OVER = (
    'The free trial has ended. An admin can subscribe on the Billing page. '
    'Dashboards and alerts keep working.'
)


def build_app(settings: Settings) -> FastAPI:
    pool = AsyncConnectionPool(settings.database_url, open=False, min_size=1, max_size=10)
    http = httpx.AsyncClient(timeout=30)
    models = choose_models(api_key=settings.openrouter_api_key, models_file=settings.models_file)

    async def budget_limit(workspace_id: str) -> float | None:
        workspace = await platform_for(http, settings, workspace_id).workspace()
        if not workspace:
            raise RuntimeError(f'No workspace {workspace_id}.')
        limit = workspace.get('modelBudget')
        return float(limit) if limit is not None else None

    router = Router(
        config=models.config,
        eligibility=models.eligibility,
        transport=models.transport,
        ledger=DatabaseLedger(pool, budget_limit),
    )
    requests = DatabaseRequestStore(pool)

    def for_workspace(workspace_id: str) -> LoopDependencies:
        return LoopDependencies(
            router=router,
            backends=create_backends(
                http=http, pool=pool, settings=settings, workspace_id=workspace_id
            ),
            default_range=settings.default_dashboard_range,
        )

    async def read_user_defaults(workspace_id: str, user_id: str) -> UserDefaults:
        found: UserDefaults = await platform_for(http, settings, workspace_id).read_defaults(
            user_id
        )  # type: ignore[assignment]
        return found

    async def save_user_defaults(
        workspace_id: str, user_id: str, answers: UserDefaults, source: str
    ) -> int:
        return await platform_for(http, settings, workspace_id).save_defaults(
            user_id, dict(answers), source
        )

    async def can_build(workspace_id: str) -> tuple[bool, str | None]:
        workspace = await platform_for(http, settings, workspace_id).workspace()
        if not workspace:
            return False, 'No such workspace.'
        status = workspace['billingStatus']
        if status in ('active', 'past_due'):
            return True, None
        trial_ends = workspace.get('trialEndsAt')
        if status == 'trialing' and (
            not trial_ends or datetime.fromisoformat(trial_ends) > datetime.now(UTC)
        ):
            return True, None
        return False, _CANCELLED if status == 'canceled' else _TRIAL_OVER

    async def default_alert_channel(workspace_id: str) -> str:
        workspace = await platform_for(http, settings, workspace_id).workspace()
        return (workspace or {}).get('alertChannel') or '#alerts'

    async def load_panel(workspace_id: str, panel_id: str) -> dict[str, object] | None:
        return await platform_for(http, settings, workspace_id).load_panel(panel_id)

    async def explain_alert(workspace_id: str, rule_id: str) -> object:
        return await explain_rule(
            platform=platform_for(http, settings, workspace_id),
            query_api=query_api_for(http, settings, workspace_id),
            router=router,
            workspace_id=workspace_id,
            rule_id=rule_id,
        )

    app = create_agent_app(
        AgentAppDependencies(
            internal_token=settings.internal_token,
            for_workspace=for_workspace,
            requests=requests,
            read_user_defaults=read_user_defaults,
            save_user_defaults=save_user_defaults,
            default_alert_channel=default_alert_channel,
            explain_alert=explain_alert,
            can_build=can_build,
            load_panel=load_panel,
        )
    )

    async def prune_forever() -> None:
        while True:
            try:
                await requests.prune(PRUNE_AFTER_DAYS)
            except Exception:
                log.exception('pruning requests')
            await asyncio.sleep(PRUNE_EVERY_SECONDS)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await pool.open()
        pruning = asyncio.create_task(prune_forever())
        log.info('agent listening on :%s; %s', settings.port, models.description)
        try:
            yield
        finally:
            pruning.cancel()
            await http.aclose()
            await pool.close()

    app.router.lifespan_context = lifespan
    return app


def listening_socket(port: int) -> socket.socket:
    """One socket for IPv6 and IPv4 (Railway's private network is IPv6; health checks use IPv4).

    asyncio marks a socket bound to "::" as IPv6-only, so the socket is made here
    with IPV6_V6ONLY off. Where IPv6 is unavailable it falls back to IPv4.
    """
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        sock.bind(('::', port))
    except OSError:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('0.0.0.0', port))
    sock.listen(128)
    return sock


def run() -> None:
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    settings = Settings.from_env()
    server = uvicorn.Server(uvicorn.Config(build_app(settings), log_level='warning'))
    server.run(sockets=[listening_socket(settings.port)])


if __name__ == '__main__':
    run()
