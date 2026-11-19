"""The agent service's HTTP API (apps/agent/src/app.ts), route for route.

Slack, the web tool and the command line reach the one agent through this
API. Callers are our own services: they prove it with the internal token and
say which workspace and person they act for. The routes, status codes and
error bodies match the TypeScript service, so callers cannot tell them apart.
"""

import hmac
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from agent.errors import InvalidEventError
from agent.loop import LoopDependencies, advance, new_request, rememberable_answers, seed_refinement
from agent.state import AgentOutput, AgentState, Event, UserDefaults

log = logging.getLogger('agent')

_WORKSPACE_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

Surface = dict[str, Any]


class RequestStore(Protocol):
    async def get(
        self, request_id: str, workspace_id: str
    ) -> tuple[AgentState, Surface] | None: ...

    async def put(self, state: AgentState, surface: Surface | None = None) -> None: ...

    async def latest_in_thread(
        self, workspace_id: str, channel: str, thread_ts: str
    ) -> AgentState | None: ...


@dataclass
class AgentAppDependencies:
    internal_token: str
    #: The loop's dependencies for one workspace.
    for_workspace: Callable[[str], LoopDependencies]
    requests: RequestStore
    #: The person's saved answers.
    read_user_defaults: Callable[[str, str], Awaitable[UserDefaults]]
    save_user_defaults: Callable[[str, str, UserDefaults, str], Awaitable[int]]
    #: Where alerts go when the request did not come from a Slack channel.
    default_alert_channel: Callable[[str], Awaitable[str]] | None = None
    #: "Why did this happen?" for an alert rule.
    explain_alert: Callable[[str, str], Awaitable[Any]] | None = None
    #: Whether the workspace may build: (ok, reason). Viewing never asks this.
    can_build: Callable[[str], Awaitable[tuple[bool, str | None]]] | None = None
    #: A saved panel, for changing it by prompt: {"spec": ..., "dashboardId"?: ...}.
    load_panel: Callable[[str, str], Awaitable[dict[str, Any] | None]] | None = None


_TRACE_KEYS = (
    'status',
    'text',
    'parsed',
    'decisions',
    'defaulted',
    'fromUserDefaults',
    'questionsAsked',
    'attempts',
    'allowed',
    'cost',
)


def reply(state: AgentState, output: AgentOutput, surface: Surface) -> dict[str, Any]:
    """What a caller gets back: what to show, and the request's record."""
    return {
        'requestId': state['requestId'],
        'output': output,
        'rememberable': (
            rememberable_answers(state) if state['status'] in ('draft', 'saved') else {}
        ),
        'surface': surface,
        'trace': {key: state[key] for key in _TRACE_KEYS if key in state},  # type: ignore[literal-required]
    }


def current_output(state: AgentState) -> AgentOutput:
    """The output a stored request would show now, without moving it on."""
    match state['status']:
        case 'question':
            return {
                'kind': 'question',
                'question': state['question'],
                'questionsLeft': 2 - len(state['questionsAsked']),
            }
        case 'draft':
            return {'kind': 'draft', 'panel': state['draft'], 'attempts': state['attempts']}
        case 'saved':
            return {'kind': 'saved', **state['saved']}
        case 'no_match':
            return {'kind': 'no_match', 'message': state.get('message', '')}
        case 'alert':
            draft = state['alertDraft']
            return {'kind': 'alert', 'ruleId': draft['ruleId'], 'rule': draft['spec']}
        case 'collector':
            return {'kind': 'collector', **state['collectorDraft']}
        case _:
            return {
                'kind': 'failed',
                'message': state.get('message') or 'Not started.',
                'attempts': state['attempts'],
            }


def _slack_channel(surface: Surface) -> str | None:
    """A Slack channel id as an alert channel: #C0123ABC."""
    channel = (
        (surface.get('slack') or {}).get('channel')
        if isinstance(surface.get('slack'), dict)
        else None
    )
    return f'#{channel}' if channel else None


def _error(message: str, status: int) -> JSONResponse:
    return JSONResponse({'error': message}, status_code=status)


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def create_agent_app(deps: AgentAppDependencies) -> FastAPI:
    app = FastAPI(title='agent', docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def internal_only(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if not request.url.path.startswith('/v1/'):
            return await call_next(request)
        match = re.match(
            r'^Bearer\s+(\S+)$', request.headers.get('authorization', ''), re.IGNORECASE
        )
        token = match.group(1) if match else ''
        if not hmac.compare_digest(token.encode(), deps.internal_token.encode()):
            return _error('Not an internal caller.', 401)
        workspace_id = request.headers.get('x-workspace-id', '')
        if not _WORKSPACE_ID.match(workspace_id):
            return _error('A workspace is required.', 400)
        request.state.workspace_id = workspace_id
        request.state.user_id = request.headers.get('x-user-id') or 'unknown'
        try:
            return await call_next(request)
        except InvalidEventError as error:
            return _error(str(error), 409)
        except Exception:
            log.exception('request failed')
            return _error('Internal error.', 500)

    @app.get('/healthz')
    async def healthz() -> dict[str, str]:
        return {'status': 'ok'}

    async def step(
        state: AgentState, event: Event, surface: Surface | None = None
    ) -> dict[str, Any]:
        if event['type'] not in ('answer', 'confirm') and deps.can_build:
            ok, reason = await deps.can_build(state['workspaceId'])
            if not ok:
                state['status'] = 'failed'
                state['message'] = reason or 'Building is paused for this workspace.'
                await deps.requests.put(state, surface)
                return reply(
                    state,
                    {'kind': 'failed', 'message': state['message'], 'attempts': []},
                    surface or {},
                )
        output = await advance(state, event, deps.for_workspace(state['workspaceId']))
        await deps.requests.put(state, surface)
        stored = await deps.requests.get(state['requestId'], state['workspaceId'])
        return reply(state, output, stored[1] if stored else surface or {})

    @app.post('/v1/requests')
    async def ask(request: Request) -> Any:
        body = await _body(request)
        text = body.get('text')
        if not isinstance(text, str) or text.strip() == '':
            return _error('"text" is required.', 400)
        workspace_id: str = request.state.workspace_id
        user_id: str = request.state.user_id
        surface = body['surface'] if isinstance(body.get('surface'), dict) else {}
        channel = (
            _slack_channel(surface)
            or (
                await deps.default_alert_channel(workspace_id)
                if deps.default_alert_channel
                else None
            )
            or '#alerts'
        )
        state = new_request(
            workspace_id=workspace_id,
            user_id=user_id,
            text=text,
            user_defaults=await deps.read_user_defaults(workspace_id, user_id),
            channel=channel,
        )
        return await step(state, {'type': 'start'}, surface)

    @app.get('/v1/requests/{request_id}')
    async def get_request(request_id: str, request: Request) -> Any:
        entry = await deps.requests.get(request_id, request.state.workspace_id)
        if not entry:
            return _error('No such request.', 404)
        state, surface = entry
        return reply(state, current_output(state), surface)

    @app.post('/v1/requests/{request_id}/answer')
    async def answer(request_id: str, request: Request) -> Any:
        entry = await deps.requests.get(request_id, request.state.workspace_id)
        if not entry:
            return _error('No such request.', 404)
        body = await _body(request)
        if not isinstance(body.get('value'), str):
            return _error('"value" is required.', 400)
        return await step(entry[0], {'type': 'answer', 'value': body['value']})

    @app.post('/v1/requests/{request_id}/confirm')
    async def confirm(request_id: str, request: Request) -> Any:
        entry = await deps.requests.get(request_id, request.state.workspace_id)
        if not entry:
            return _error('No such request.', 404)
        body = await _body(request)
        event: Event = {'type': 'confirm'}
        if isinstance(body.get('dashboardId'), str):
            event['dashboardId'] = body['dashboardId']
        return await step(entry[0], event)

    @app.post('/v1/requests/{request_id}/alert')
    async def alert(request_id: str, request: Request) -> Any:
        """ "Alert me on this": a pending alert rule from this request's chart."""
        entry = await deps.requests.get(request_id, request.state.workspace_id)
        if not entry:
            return _error('No such request.', 404)
        state = entry[0]
        body = await _body(request)
        event: Event = {'type': 'alert'}
        if body.get('op') in ('>', '<'):
            event['op'] = body['op']
        if isinstance(body.get('threshold'), (int, float)) and not isinstance(
            body.get('threshold'), bool
        ):
            event['threshold'] = body['threshold']
        if isinstance(body.get('for'), str):
            event['for_'] = body['for']
        if isinstance(body.get('channel'), str) and re.match(r'^#\S+$', body['channel']):
            state['channel'] = body['channel']
        return await step(state, event)

    @app.post('/v1/refine')
    async def refine(request: Request) -> Any:
        """Change an existing chart: requestId (a chart from a conversation) or panelId (saved)."""
        body = await _body(request)
        text = body['text'].strip() if isinstance(body.get('text'), str) else ''
        if not text:
            return _error('"text" is required.', 400)
        workspace_id: str = request.state.workspace_id
        surface = body['surface'] if isinstance(body.get('surface'), dict) else {}
        backends = deps.for_workspace(workspace_id).backends
        if isinstance(body.get('requestId'), str):
            base = await deps.requests.get(body['requestId'], workspace_id)
            if not base or 'draft' not in base[0]:
                return _error('That request has no chart to change.', 404)
            state = await seed_refinement(
                workspace_id=workspace_id,
                user_id=request.state.user_id,
                text=text,
                base={'kind': 'request', 'state': base[0]},
                backends=backends,
            )
        elif isinstance(body.get('panelId'), str) and deps.load_panel:
            panel = await deps.load_panel(workspace_id, body['panelId'])
            if not panel:
                return _error('No such panel.', 404)
            seed: dict[str, Any] = {
                'kind': 'panel',
                'panel': panel['spec'],
                'panelId': body['panelId'],
            }
            if panel.get('dashboardId'):
                seed['dashboardId'] = panel['dashboardId']
            state = await seed_refinement(
                workspace_id=workspace_id,
                user_id=request.state.user_id,
                text=text,
                base=seed,
                backends=backends,
            )
        else:
            return _error('"requestId" or "panelId" is required.', 400)
        return await step(state, {'type': 'refine', 'text': text}, surface)

    @app.get('/v1/threads/{channel}/{thread_ts}')
    async def in_thread(channel: str, thread_ts: str, request: Request) -> Any:
        """The latest chart in a Slack thread, so a follow-up there can change it."""
        state = await deps.requests.latest_in_thread(request.state.workspace_id, channel, thread_ts)
        if not state:
            return _error('No chart in this thread.', 404)
        return reply(state, current_output(state), {})

    @app.post('/v1/explain')
    async def explain(request: Request) -> Any:
        """ "Why did this happen?": a labelled hypothesis with the charts behind it."""
        body = await _body(request)
        rule_id = body.get('ruleId')
        if not isinstance(rule_id, str) or not _WORKSPACE_ID.match(rule_id):
            return _error('"ruleId" is required.', 400)
        if not deps.explain_alert:
            return _error('Explanations are not available.', 501)
        result = await deps.explain_alert(request.state.workspace_id, rule_id)
        if not result:
            return _error('No such alert rule.', 404)
        return result

    @app.post('/v1/requests/{request_id}/remember')
    async def remember(request_id: str, request: Request) -> Any:
        """ "Skip questions next time": save this request's answers as the asker's defaults."""
        entry = await deps.requests.get(request_id, request.state.workspace_id)
        if not entry:
            return _error('No such request.', 404)
        state = entry[0]
        if state['userId'] != request.state.user_id:
            return _error('Only the person who asked can save these answers.', 403)
        answers = rememberable_answers(state)
        saved = await deps.save_user_defaults(
            state['workspaceId'], state['userId'], answers, f'request {state["requestId"]}'
        )
        return {'saved': saved, 'answers': answers}

    return app
