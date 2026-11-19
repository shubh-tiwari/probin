"""What flows between the agent, the router, transports and the ledger."""

from dataclasses import dataclass
from typing import Literal, Protocol, TypedDict

from modelrouter.config import TaskType


class ChatMessage(TypedDict):
    role: Literal['system', 'user', 'assistant']
    content: str


@dataclass(frozen=True)
class CompletionRequest:
    """What the router sends to a transport: one model, one completion."""

    model: str
    messages: list[ChatMessage]
    #: Ask for a single JSON object as the reply.
    json: bool
    max_tokens: int
    #: The task, for transports that are not a real model (the stand-in).
    task: TaskType


@dataclass(frozen=True)
class CompletionResponse:
    content: str
    input_tokens: int
    output_tokens: int
    #: The model that answered, when the provider reports one (it differs under auto-routing).
    model: str | None = None
    #: The provider's own figure, when it reports one.
    cost: float | None = None


class ModelTransport(Protocol):
    """The one seam to a model provider. Everything provider-specific lives behind it."""

    async def complete(self, request: CompletionRequest) -> CompletionResponse: ...


#: How a call turned out. Starts as ok or transport_error; the caller may refine ok.
CallOutcome = Literal['ok', 'transport_error', 'invalid_output', 'ungrounded', 'dry_run_failed']


@dataclass
class CallRecord:
    workspace_id: str
    request_id: str
    task: TaskType
    model: str
    input_tokens: int
    output_tokens: int
    cost: float
    outcome: CallOutcome
    escalated_from: str | None = None


@dataclass(frozen=True)
class Budget:
    #: The month's limit; None: no cap.
    limit: float | None
    spent: float


class Ledger(Protocol):
    """Where calls are logged and budgets are read. Backed by model_calls in production."""

    async def budget(self, workspace_id: str) -> Budget: ...

    async def record(self, call: CallRecord) -> str: ...

    async def set_outcome(self, call_id: str, outcome: CallOutcome) -> None: ...


@dataclass(frozen=True)
class RouterRequest:
    workspace_id: str
    #: Groups every call made for one user request.
    request_id: str
    task: TaskType
    messages: list[ChatMessage]
    json: bool = False
    max_tokens: int = 1024
    #: Failures so far on this request. From two on, the router uses a stronger tier.
    failures: int = 0
    #: The earlier call this one retries, when escalating.
    previous_call_id: str | None = None


@dataclass(frozen=True)
class RouterResponse:
    call_id: str
    model: str
    tier: str
    escalated: bool
    content: str
    input_tokens: int
    output_tokens: int
    cost: float
