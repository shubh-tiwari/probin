"""The query test set (evals/query/run.ts): every request in cases.yaml through the real loop.

    pnpm evals:query                       all cases, with the configured models
    pnpm evals:query --only <id>           one case
    pnpm evals:query --gate                also fail unless the 90% gate is met
    pnpm evals:query --model <id>          every task on one model
    pnpm evals:query --strategy auto       OpenRouter's own routing instead of the table
    pnpm evals:query --record-eligibility  test each candidate model, write evals/eligibility.json
    pnpm evals:query --json <file>         write the full results

With no model key it runs on the built-in stand-in, which costs nothing and
exercises the loop and its guards; its pass rate is not the product's. With a
key it calls real models and needs EVAL_BUDGET (a spend cap) to be set.

Always enforced, whatever the model: no delivered query uses a name outside the
catalog, every delivered query passed a dry run, and no request asks more than
two questions.
"""

import argparse
import asyncio
import json
import math
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict, Field

from agent.backends import create_backends, query_api_for
from agent.clients import QueryApi
from agent.grounding import check_grounding
from agent.loop import LoopDependencies, advance, new_request
from agent.models import choose_models
from agent.settings import Settings
from agent.tools import MAX_QUESTIONS, Actor
from appcommon.dotenv import load_env_file
from modelrouter import (
    MemoryLedger,
    ModelsConfig,
    ModelTransport,
    OpenRouterTransport,
    Router,
    load_models,
    parse_models,
)

GATE = 0.9
ROOT = Path(__file__).resolve().parents[4]

QuestionId = Literal['service', 'endpoint', 'percentile', 'requests']


class Expect(BaseModel):
    model_config = ConfigDict(extra='forbid')
    outcome: Literal['draft', 'no_match']
    asks: list[QuestionId] | None = None
    reference: str | None = Field(default=None, min_length=1)
    #: The time range the draft must carry; None in the file means it must carry none.
    range: str | None = None
    has_range: bool = False
    type: Literal['timeseries', 'bar', 'stat'] | None = None
    assumptions: list[str] | None = None


class EvalCase(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(pattern=r'^[a-z0-9-]+$')
    request: str = Field(min_length=1)
    answers: dict[QuestionId, str] = Field(default_factory=dict)
    expect: Expect


def load_cases(path: Path) -> list[EvalCase]:
    raw = yaml.safe_load(path.read_text(encoding='utf-8'))
    cases = []
    for item in raw:
        expect = item.get('expect', {})
        if 'range' in expect:
            expect = {**expect, 'has_range': True}
        cases.append(EvalCase.model_validate({**item, 'expect': expect}))
    ids = [one.id for one in cases]
    duplicate = next((i for i in ids if ids.count(i) > 1), None)
    if duplicate:
        raise ValueError(f'Duplicate case id "{duplicate}" in {path}')
    for one in cases:
        if one.expect.outcome == 'draft' and not one.expect.reference:
            raise ValueError(f'Case {one.id} expects a draft and needs a reference query.')
    return cases


@dataclass
class CaseResult:
    id: str
    request: str
    outcome: str
    #: Why the case did not pass. Empty: it passed.
    problems: list[str]
    #: Rules that must always hold which this run broke. Should always be empty.
    ruleBreaks: list[str]
    attempts: int
    firstAttemptPassed: bool
    #: Attempts whose raw model output used a name outside the catalog (caught in code).
    rawUngrounded: int
    questions: list[str]
    cost: float
    query: str | None = None


def _mean(points: list[list[float]]) -> float:
    return math.nan if not points else sum(p[1] for p in points) / len(points)


def _key(labels: dict[str, str]) -> str:
    return json.dumps(sorted(labels.items()))


def same_data(got: dict[str, Any], wanted: dict[str, Any]) -> str | None:
    """Whether two results show the same data: same lines, each with about the same average."""
    if got['lineCount'] != wanted['lineCount']:
        return f'{got["lineCount"]} lines, the reference has {wanted["lineCount"]}'
    reference = {_key(s['labels']): s for s in wanted['series']}
    for series in got['series']:
        # With one line on each side the labels need not match; with more they must.
        other = (
            wanted['series'][0] if got['lineCount'] == 1 else reference.get(_key(series['labels']))
        )
        if not other:
            return f'no reference line for {_key(series["labels"])}'
        x, y = _mean(series['points']), _mean(other['points'])
        both_empty = math.isnan(x) and math.isnan(y)
        if not both_empty and not abs(x - y) <= max(0.001 * abs(y), 1e-9):
            return f'average {x:.4g}, the reference gives {y:.4g}'
    return None


async def run_case(
    one: EvalCase,
    deps: LoopDependencies,
    query_api: QueryApi,
    workspace_id: str,
    default_range: str,
) -> CaseResult:
    state = new_request(workspace_id=workspace_id, user_id='evals', text=one.request)
    problems: list[str] = []
    rule_breaks: list[str] = []

    output = await advance(state, {'type': 'start'}, deps)
    while output['kind'] == 'question':
        question = output['question']
        answer = one.answers.get(question['id'])
        last = question['options'][-1]['value']
        if answer is None:
            problems.append(f'asked “{question["text"]}”, which the case does not expect')
            answer = last
        if not any(option['value'] == answer for option in question['options']):
            problems.append(f'“{answer}” is not offered for “{question["text"]}”')
            answer = last
        output = await advance(state, {'type': 'answer', 'value': answer}, deps)

    # Rules that must always hold.
    if len(state['questionsAsked']) > MAX_QUESTIONS:
        rule_breaks.append(f'asked {len(state["questionsAsked"])} questions')
    if output['kind'] == 'draft':
        if output['panel']['query'] not in state['testedQueries']:
            rule_breaks.append('the delivered query did not pass a dry run')
        grounding = await check_grounding(
            output['panel']['query'], state['allowed'], deps.backends.analyze
        )
        if not grounding['ok']:
            rule_breaks.append(f'delivered a query outside the catalog: {grounding.get("message")}')

    # What this case expects.
    expect = one.expect
    if output['kind'] != expect.outcome:
        detail = f': {output["message"]}' if output['kind'] in ('no_match', 'failed') else ''
        problems.append(f'ended as {output["kind"]}, expected {expect.outcome}{detail}')
    if expect.asks is not None and expect.asks != state['questionsAsked']:
        problems.append(
            f'asked [{", ".join(state["questionsAsked"])}], expected [{", ".join(expect.asks)}]'
        )
    if output['kind'] == 'draft' and expect.outcome == 'draft':
        panel = output['panel']
        if expect.has_range and panel.get('range') != expect.range:
            problems.append(
                f'range is {panel.get("range") or "none"}, expected {expect.range or "none"}'
            )
        if expect.type and panel['type'] != expect.type:
            problems.append(f'chart type is {panel["type"]}, expected {expect.type}')
        for assumption in expect.assumptions or []:
            if assumption not in panel['assumptions']:
                problems.append(f'does not state “{assumption}”')
        try:
            # Both queries are evaluated over exactly the same window, so equal queries
            # give equal numbers however fast the data is changing.
            range_ = panel.get('range') or default_range
            end = int(time.time()) - 30
            got, wanted = await asyncio.gather(
                query_api.query(panel['query'], range_, end=end),
                query_api.query(expect.reference or '', range_, end=end),
            )
            difference = same_data(got, wanted)
            if difference:
                problems.append(f'shows different data from the reference: {difference}')
        except Exception as error:
            problems.append(f'could not compare with the reference: {error}')

    attempts = state['attempts']
    return CaseResult(
        id=one.id,
        request=one.request,
        outcome=output['kind'],
        problems=problems,
        ruleBreaks=rule_breaks,
        attempts=len(attempts),
        firstAttemptPassed=bool(attempts) and 'failure' not in attempts[0],
        rawUngrounded=sum(1 for a in attempts if a.get('ungrounded')),
        questions=list(state['questionsAsked']),
        query=output['panel']['query'] if output['kind'] == 'draft' else None,
        cost=state['cost'],
    )


@dataclass
class RunSummary:
    label: str
    cases: int
    passed: int
    draftCases: int
    firstAttempt: int
    firstAttemptRate: float
    rawUngrounded: int
    ruleBreaks: int
    cost: float
    results: list[CaseResult] = field(default_factory=list)


def single_model(model: str, base: ModelsConfig) -> ModelsConfig:
    """Every task on one model, for testing that model on its own."""
    entry = next(
        (m for tier in base.tiers for m in tier.models if m.id == model),
        None,
    )
    models = (
        [entry.model_dump()]
        if entry
        else [{'id': model, 'input_per_mtok': 0, 'output_per_mtok': 0}]
    )
    return parse_models(
        json.dumps(
            {
                'tiers': [{'id': 'only', 'models': models}],
                'tasks': {t: 'only' for t in ('parse', 'ask', 'write_query', 'explain', 'review')},
                'budget': {'near_cap_ratio': 1},
            }
        )
    )


def _percent(value: float) -> str:
    return f'{value * 100:.0f}%'


async def run_set(
    label: str,
    cases: list[EvalCase],
    config: ModelsConfig,
    transport: ModelTransport,
    *,
    http: httpx.AsyncClient,
    pool: AsyncConnectionPool,
    settings: Settings,
    workspace_id: str,
    budget: float | None,
    spent: list[float],
) -> RunSummary:
    ledger = MemoryLedger(limit=None if budget is None else max(0.0, budget - spent[0]))
    backends = create_backends(http=http, pool=pool, settings=settings, workspace_id=workspace_id)

    async def never_save(
        spec: dict[str, Any], actor: Actor, dashboard_id: str | None, panel_id: str | None
    ) -> Any:
        raise RuntimeError('the test set does not save panels')

    backends.save_panel = never_save
    deps = LoopDependencies(
        # The test set is what makes a model eligible, so eligibility is not enforced here.
        router=Router(config=config, eligibility=None, transport=transport, ledger=ledger),
        backends=backends,
        default_range=settings.default_dashboard_range,
    )
    query_api = query_api_for(http, settings, workspace_id)

    print(f'\n{label}\n')
    results: list[CaseResult] = []
    for one in cases:
        result = await run_case(
            one, deps, query_api, workspace_id, settings.default_dashboard_range
        )
        results.append(result)
        spent[0] += result.cost
        mark = 'RULE' if result.ruleBreaks else 'FAIL' if result.problems else 'ok  '
        print(f'  {mark}  {result.id}')
        for line in [*result.ruleBreaks, *result.problems]:
            print(f'          {line}')

    drafts = [r for r, c in zip(results, cases, strict=True) if c.expect.outcome == 'draft']
    first = sum(1 for r in drafts if r.firstAttemptPassed)
    summary = RunSummary(
        label=label,
        cases=len(results),
        passed=sum(1 for r in results if not r.problems and not r.ruleBreaks),
        draftCases=len(drafts),
        firstAttempt=first,
        firstAttemptRate=1.0 if not drafts else first / len(drafts),
        rawUngrounded=sum(r.rawUngrounded for r in results),
        ruleBreaks=sum(len(r.ruleBreaks) for r in results),
        cost=sum(r.cost for r in results),
        results=results,
    )
    print(
        f'\n  Passed the dry run on the first attempt: {first} of {len(drafts)} '
        f'({_percent(summary.firstAttemptRate)}; the gate is {_percent(GATE)})'
        f'\n  Fully correct: {summary.passed} of {summary.cases}'
        f'\n  Names outside the catalog: {summary.rawUngrounded} caught in code before any dry '
        f'run, {"none" if summary.ruleBreaks == 0 else "SOME"} delivered'
        f'\n  Rules broken: {summary.ruleBreaks}'
        f'\n  Model cost: {summary.cost:.4f} in total, '
        f'{summary.cost / max(1, summary.cases):.5f} per request'
    )
    return summary


async def _main(args: argparse.Namespace) -> int:
    settings = Settings.from_env()
    workspace_id = os.environ.get('DEV_WORKSPACE_ID', '')
    if not workspace_id:
        print('DEV_WORKSPACE_ID is required.', file=sys.stderr)
        return 2
    live = settings.openrouter_api_key is not None
    budget_text = os.environ.get('EVAL_BUDGET')
    budget = float(budget_text) if budget_text else None
    if live and not (budget is not None and budget > 0):
        print(
            'A model key is set, so this run spends money. Set EVAL_BUDGET to a spend cap first.',
            file=sys.stderr,
        )
        return 2
    if not live and (args.model or args.strategy or args.record_eligibility):
        print(
            '--model, --strategy and --record-eligibility need OPENROUTER_API_KEY.', file=sys.stderr
        )
        return 2

    every = load_cases(Path(args.cases))
    cases = [c for c in every if c.id == args.only] if args.only else every
    if not cases:
        print(f'No case "{args.only}".', file=sys.stderr)
        return 2

    pool = AsyncConnectionPool(settings.database_url, open=False, min_size=1, max_size=4)
    await pool.open()
    http = httpx.AsyncClient(timeout=30)
    shared: dict[str, Any] = {
        'http': http,
        'pool': pool,
        'settings': settings,
        'workspace_id': workspace_id,
        'budget': budget,
        'spent': [0.0],
    }
    summaries: list[RunSummary] = []
    exit_code = 0
    try:
        if not live:
            chosen = choose_models(api_key=None, models_file=settings.models_file)
            summaries.append(
                await run_set(
                    'Query test set on the stand-in model (no model key set)',
                    cases,
                    chosen.config,
                    chosen.transport,
                    **shared,
                )
            )
        else:
            base = load_models(settings.models_file)
            transport = OpenRouterTransport(api_key=settings.openrouter_api_key or '')
            if args.record_eligibility:
                eligible: dict[str, list[str]] = {}
                for tier in base.tiers:
                    eligible[tier.id] = []
                    for model in tier.models:
                        summary = await run_set(
                            f'Candidate {model.id} for the {tier.id} tier',
                            cases,
                            single_model(model.id, base),
                            transport,
                            **shared,
                        )
                        summaries.append(summary)
                        passes = (
                            summary.ruleBreaks == 0
                            and summary.firstAttemptRate >= GATE
                            and summary.passed / summary.cases >= GATE
                        )
                        if passes:
                            eligible[tier.id].append(model.id)
                        verdict = 'ELIGIBLE' if passes else 'not eligible'
                        print(f'  {model.id} is {verdict} for {tier.id}')
                file = base.eligibility_file or 'evals/eligibility.json'
                await asyncio.to_thread(
                    Path(file).write_text,
                    json.dumps(
                        {'updated': datetime.now(UTC).isoformat(), 'tiers': eligible}, indent=2
                    )
                    + '\n',
                )
                print(f'\nWrote {file}')
            else:
                if args.model:
                    config, label = (
                        single_model(args.model, base),
                        f'Query test set on {args.model}',
                    )
                elif args.strategy == 'auto':
                    config = base.model_copy(update={'strategy': 'openrouter_auto'})
                    label = 'Query test set, openrouter_auto routing'
                else:
                    config, label = base, f'Query test set, {base.strategy} routing'
                summaries.append(await run_set(label, cases, config, transport, **shared))

        if any(s.ruleBreaks > 0 for s in summaries):
            print(
                '\nA rule that must always hold was broken. This is a defect, whatever the model.',
                file=sys.stderr,
            )
            exit_code = 1
        elif args.gate and any(s.firstAttemptRate < GATE for s in summaries):
            print(
                f'\nThe gate was not met: fewer than {GATE * 100:.0f}% passed the dry run on the '
                'first attempt.',
                file=sys.stderr,
            )
            exit_code = 1
    finally:
        if args.json:
            await asyncio.to_thread(
                Path(args.json).write_text,
                json.dumps([asdict(s) for s in summaries], indent=2) + '\n',
            )
        await http.aclose()
        await pool.close()
    print()
    return exit_code


def main() -> None:
    load_env_file(ROOT / '.env')
    parser = argparse.ArgumentParser(prog='evals:query', description=__doc__.split('\n\n')[0])
    parser.add_argument('--cases', default=str(ROOT / 'evals/query/cases.yaml'))
    parser.add_argument('--only')
    parser.add_argument('--gate', action='store_true')
    parser.add_argument('--model')
    parser.add_argument('--strategy')
    parser.add_argument('--record-eligibility', action='store_true')
    parser.add_argument('--json')
    sys.exit(asyncio.run(_main(parser.parse_args())))


if __name__ == '__main__':
    main()
