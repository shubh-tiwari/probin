"""The models file and the eligibility file (packages/router/src/config.ts)."""

import json
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from appcommon.errors import ConfigError

TaskType = Literal['parse', 'ask', 'write_query', 'explain', 'review']
TASK_TYPES: tuple[TaskType, ...] = ('parse', 'ask', 'write_query', 'explain', 'review')

_strict = ConfigDict(extra='forbid', frozen=True)


class ModelEntry(BaseModel):
    model_config = _strict
    id: str = Field(min_length=1)
    #: List prices per million tokens, in the plans file's currency.
    input_per_mtok: float = Field(ge=0)
    output_per_mtok: float = Field(ge=0)

    @property
    def blended_price(self) -> float:
        return self.input_per_mtok + self.output_per_mtok


class Tier(BaseModel):
    model_config = _strict
    id: str = Field(pattern=r'^[a-z][a-z0-9_-]*$')
    models: list[ModelEntry] = Field(min_length=1)


class Tasks(BaseModel):
    model_config = _strict
    parse: str
    ask: str
    write_query: str
    explain: str
    review: str

    def tier_of(self, task: TaskType) -> str:
        return str(getattr(self, task))


class Budget(BaseModel):
    model_config = _strict
    near_cap_ratio: float = Field(ge=0, le=1)


class ModelsConfig(BaseModel):
    model_config = _strict
    strategy: Literal['table', 'openrouter_auto'] = 'table'
    auto_model: str | None = Field(default=None, min_length=1)
    #: Cheapest first. Escalation moves towards the end.
    tiers: list[Tier] = Field(min_length=1)
    tasks: Tasks
    budget: Budget
    #: None or absent: every listed model may be used. Only for tests and local stand-ins.
    eligibility_file: str | None = Field(default=None, min_length=1)

    @model_validator(mode='after')
    def _check(self) -> 'ModelsConfig':
        ids = [tier.id for tier in self.tiers]
        problems: list[str] = []
        if len(set(ids)) != len(ids):
            problems.append('tiers: tier ids must be unique')
        for task in TASK_TYPES:
            if self.tasks.tier_of(task) not in ids:
                problems.append(f'tasks.{task}: unknown tier "{self.tasks.tier_of(task)}"')
        if self.strategy == 'openrouter_auto' and not self.auto_model:
            problems.append('auto_model: auto_model is required when strategy is openrouter_auto')
        if problems:
            raise ValueError('; '.join(problems))
        return self


def _issues(error: ValidationError) -> str:
    out = []
    for issue in error.errors():
        path = '.'.join(str(part) for part in issue['loc']) or '(root)'
        message = str(issue['msg']).removeprefix('Value error, ')
        out.append(message if issue['type'] == 'value_error' else f'{path}: {message}')
    return '; '.join(out)


def parse_models(yaml_text: str, origin: str = 'models config') -> ModelsConfig:
    try:
        raw = yaml.safe_load(yaml_text)
    except yaml.YAMLError as error:
        raise ConfigError(f'{origin}: not valid YAML: {error}') from error
    try:
        return ModelsConfig.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f'{origin}: {_issues(error)}') from error


def load_models(path: str | Path) -> ModelsConfig:
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError as error:
        raise ConfigError(f'Cannot read models file {path}: {error}') from error
    return parse_models(text, str(path))


class Eligibility(BaseModel):
    """Which models passed the test set, per tier. Written by the query test set."""

    model_config = _strict
    #: When the test set last wrote this file. Empty when no file exists yet.
    updated: str
    #: tier id -> model ids that passed.
    tiers: dict[str, list[str]]


#: No file yet: no model has passed, so every call is refused.
NOTHING_PASSED = Eligibility(updated='', tiers={})


def load_eligibility(path: str | Path) -> Eligibility:
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError:
        return NOTHING_PASSED
    try:
        return Eligibility.model_validate(json.loads(text))
    except (ValidationError, json.JSONDecodeError) as error:
        raise ConfigError(f'{path}: not a valid eligibility file') from error
