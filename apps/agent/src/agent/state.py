"""The agent's state and outputs.

The shapes match packages/agent-client/src/types.ts exactly, keys included,
because they are stored in Postgres and returned to the TypeScript services.
They are plain JSON: typed dictionaries, not objects.
"""

from typing import Any, Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from agent.catalog import CatalogEndpoint, CatalogMetric
from appcommon.durations import DURATION

MeasureKind = Literal['latency', 'traffic', 'errors', 'other']
RequestFilter = Literal['all', 'failed_only', 'successful_only']
QuestionId = Literal['service', 'endpoint', 'percentile', 'requests']
AgentStatus = Literal[
    'new', 'question', 'draft', 'saved', 'alert', 'collector', 'no_match', 'failed'
]

#: A JSON number as JavaScript has it: whole numbers stay whole, so 95 never reads as 95.0.
Num = StrictInt | float

_strict = ConfigDict(extra='forbid')
_DURATION = DURATION.pattern


class EndpointNamed(BaseModel):
    model_config = _strict
    method: str | None = Field(min_length=1)
    route: str = Field(min_length=1)


class AlertWanted(BaseModel):
    model_config = _strict
    op: Literal['>', '<']
    threshold: Num
    #: The threshold's unit as written: "ms", "s", "%", or None.
    unit: str | None = Field(min_length=1)
    for_: str | None = Field(alias='for', pattern=_DURATION)


class CollectorWanted(BaseModel):
    model_config = _strict
    url: str = Field(min_length=1)
    interval: str | None = Field(pattern=_DURATION)


class ParsedRequest(BaseModel):
    """The model's `parse` output. The schema is what makes it safe to act on."""

    model_config = _strict
    measure: str = Field(min_length=1)
    kind: MeasureKind
    service: str | None = Field(min_length=1)
    endpoint: EndpointNamed | None
    all_endpoints: bool
    percentile: Num | None = Field(gt=0, lt=100)
    requests: RequestFilter | None
    range: str | None = Field(pattern=_DURATION)
    chart: Literal['timeseries', 'bar', 'stat'] | None
    split_by: list[str] = Field(max_length=3)
    intent: Literal['chart', 'alert', 'collector'] = 'chart'
    alert: AlertWanted | None = None
    collector: CollectorWanted | None = None

    def as_json(self) -> dict[str, Any]:
        """The same keys and order as the TypeScript schema's output."""
        return self.model_dump(mode='json', by_alias=True)


class WrittenQuery(BaseModel):
    """The model's `write_query` output."""

    model_config = _strict
    query: str = Field(min_length=1)
    title: str = Field(min_length=1)
    unit: str
    display_unit: str | None = Field(default=None, min_length=1)


class QuestionOption(TypedDict):
    value: str
    label: str
    tags: NotRequired[list[str]]


class Question(TypedDict):
    id: QuestionId
    text: str
    #: choice: 2 to 6 options as buttons. endpoint: the endpoint picker.
    kind: Literal['choice', 'endpoint']
    options: list[QuestionOption]


class EndpointChoice(TypedDict):
    method: str
    route: str


class Decisions(TypedDict, total=False):
    #: A service name, or * for all services combined.
    service: str
    endpoint: EndpointChoice | Literal['all']
    percentile: Num
    requests: RequestFilter


class Attempt(TypedDict):
    number: int
    model: str
    tier: str
    escalated: bool
    callId: str
    cost: float
    query: NotRequired[str]
    ungrounded: NotRequired[list[str]]
    lineCount: NotRequired[int]
    failure: NotRequired[str]


class UserDefaults(TypedDict, total=False):
    percentile: Num
    requests: RequestFilter


class CheckResult(TypedDict):
    ok: bool
    status: int | None
    duration: float
    error: NotRequired[str]


class AlertDraft(TypedDict):
    ruleId: str
    spec: dict[str, Any]


class CollectorDraft(TypedDict):
    collectorId: str
    spec: dict[str, Any]
    test: CheckResult


class Catalog(TypedDict):
    knownServices: list[str]
    metrics: list[CatalogMetric]
    endpoints: list[CatalogEndpoint]


class Allowed(TypedDict):
    metrics: list[str]
    labels: list[str]


class Saved(TypedDict):
    panelId: str
    version: int
    dashboardId: str


class Revises(TypedDict):
    query: str
    panelId: NotRequired[str]
    dashboardId: NotRequired[str]


class AgentState(TypedDict):
    """Everything about one request. Plain data, stored between events."""

    requestId: str
    workspaceId: str
    userId: str
    text: str
    status: AgentStatus
    parsed: NotRequired[dict[str, Any]]
    catalog: NotRequired[Catalog]
    #: The names search_catalog returned. A query may use these and no others.
    allowed: Allowed
    decisions: Decisions
    defaulted: list[QuestionId]
    fromCache: NotRequired[bool]
    userDefaults: UserDefaults
    fromUserDefaults: list[QuestionId]
    questionsAsked: list[QuestionId]
    question: NotRequired[Question]
    attempts: list[Attempt]
    #: Queries that passed run_query in this request. Only these may be saved.
    testedQueries: list[str]
    draft: NotRequired[dict[str, Any]]
    saved: NotRequired[Saved]
    alertDraft: NotRequired[AlertDraft]
    collectorDraft: NotRequired[CollectorDraft]
    channel: NotRequired[str]
    revises: NotRequired[Revises]
    refinement: NotRequired[str]
    message: NotRequired[str]
    cost: float


#: What the person sees after each step: {"kind": ...} as in AgentOutput.
AgentOutput = dict[str, Any]


class Event(TypedDict, total=False):
    type: Literal['start', 'answer', 'confirm', 'alert', 'refine']
    value: str
    dashboardId: str
    op: Literal['>', '<']
    threshold: Num
    for_: str
    text: str
