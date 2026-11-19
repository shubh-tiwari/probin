"""The agent's HTTP contract: routes, auth, status codes and error bodies as in TypeScript."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent.app import AgentAppDependencies, create_agent_app
from agent.state import UserDefaults
from agent.store import MemoryRequestStore

from .harness import create_harness

TOKEN = 'test-internal-token'
WS = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'


def client(can_build: tuple[bool, str | None] = (True, None)) -> tuple[TestClient, dict[str, Any]]:
    harness = create_harness()
    saved: dict[str, Any] = {}

    async def read_defaults(_ws: str, _user: str) -> UserDefaults:
        return {}

    async def save_defaults(ws: str, user: str, answers: UserDefaults, source: str) -> int:
        saved.update(ws=ws, user=user, answers=answers, source=source)
        return len(answers)

    async def allowed(_ws: str) -> tuple[bool, str | None]:
        return can_build

    app = create_agent_app(
        AgentAppDependencies(
            internal_token=TOKEN,
            for_workspace=lambda _ws: harness.deps,
            requests=MemoryRequestStore(),
            read_user_defaults=read_defaults,
            save_user_defaults=save_defaults,
            can_build=allowed,
        )
    )
    return TestClient(app), saved


def headers(workspace: str = WS, user: str = 'U1') -> dict[str, str]:
    return {'authorization': f'Bearer {TOKEN}', 'x-workspace-id': workspace, 'x-user-id': user}


def test_refuses_callers_without_the_token_or_a_workspace() -> None:
    http, _ = client()
    assert http.get('/healthz').json() == {'status': 'ok'}
    refused = http.post(
        '/v1/requests', json={'text': 'x'}, headers={**headers(), 'authorization': 'Bearer no'}
    )
    assert (refused.status_code, refused.json()) == (401, {'error': 'Not an internal caller.'})
    missing = http.post(
        '/v1/requests', json={'text': 'x'}, headers={**headers(), 'x-workspace-id': 'nope'}
    )
    assert (missing.status_code, missing.json()) == (400, {'error': 'A workspace is required.'})


def test_a_request_goes_from_question_to_saved_over_http() -> None:
    http, _ = client()
    asked = http.post(
        '/v1/requests',
        json={'text': 'latency graph of checkout service in last 5 hr'},
        headers=headers(),
    ).json()
    assert asked['output']['kind'] == 'question'
    assert asked['trace']['questionsAsked'] == ['endpoint']
    assert set(asked) == {'requestId', 'output', 'rememberable', 'surface', 'trace'}
    request_id = asked['requestId']

    second = http.post(
        f'/v1/requests/{request_id}/answer', json={'value': 'POST /checkout/pay'}, headers=headers()
    ).json()
    assert second['output']['question']['id'] == 'percentile'
    draft = http.post(
        f'/v1/requests/{request_id}/answer', json={'value': '95'}, headers=headers()
    ).json()
    assert draft['output']['kind'] == 'draft'
    assert draft['rememberable'] == {'percentile': 95}

    stored = http.get(f'/v1/requests/{request_id}', headers=headers()).json()
    assert stored['output']['kind'] == 'draft'
    saved = http.post(f'/v1/requests/{request_id}/confirm', json={}, headers=headers()).json()
    assert saved['output'] == {
        'kind': 'saved',
        'panelId': 'panel-1',
        'version': 1,
        'dashboardId': 'dashboard-1',
    }


def test_a_request_is_only_visible_to_its_workspace() -> None:
    http, _ = client()
    asked = http.post(
        '/v1/requests', json={'text': 'latency of checkout service'}, headers=headers()
    ).json()
    other = http.post(
        f'/v1/requests/{asked["requestId"]}/answer', json={'value': 'all'}, headers=headers(OTHER)
    )
    assert (other.status_code, other.json()) == (404, {'error': 'No such request.'})


def test_an_event_the_request_cannot_take_is_409() -> None:
    http, _ = client()
    asked = http.post(
        '/v1/requests', json={'text': 'latency of checkout service'}, headers=headers()
    ).json()
    wrong = http.post(f'/v1/requests/{asked["requestId"]}/confirm', json={}, headers=headers())
    assert (wrong.status_code, wrong.json()) == (409, {'error': 'There is no draft to save.'})


def test_building_pauses_when_the_workspace_may_not_build() -> None:
    http, _ = client(can_build=(False, 'The free trial has ended.'))
    out = http.post('/v1/requests', json={'text': 'latency of checkout'}, headers=headers()).json()
    assert out['output'] == {
        'kind': 'failed',
        'message': 'The free trial has ended.',
        'attempts': [],
    }


@pytest.mark.parametrize(
    ('body', 'error'),
    [({}, '"text" is required.'), ({'text': '   '}, '"text" is required.')],
)
def test_requires_text(body: dict[str, Any], error: str) -> None:
    http, _ = client()
    response = http.post('/v1/requests', json=body, headers=headers())
    assert (response.status_code, response.json()) == (400, {'error': error})


def test_only_the_asker_can_save_their_answers() -> None:
    http, saved = client()
    text = 'latency graph of checkout service in last 5 hr'
    asked = http.post('/v1/requests', json={'text': text}, headers=headers()).json()
    rid = asked['requestId']
    http.post(f'/v1/requests/{rid}/answer', json={'value': 'all'}, headers=headers())
    http.post(f'/v1/requests/{rid}/answer', json={'value': '99'}, headers=headers())
    refused = http.post(f'/v1/requests/{rid}/remember', json={}, headers=headers(user='U2'))
    assert refused.status_code == 403
    ok = http.post(f'/v1/requests/{rid}/remember', json={}, headers=headers()).json()
    assert ok == {'saved': 1, 'answers': {'percentile': 99}}
    assert saved['source'] == f'request {rid}'


def test_explanations_are_501_when_not_wired() -> None:
    http, _ = client()
    response = http.post('/v1/explain', json={'ruleId': WS}, headers=headers())
    assert response.status_code == 501
