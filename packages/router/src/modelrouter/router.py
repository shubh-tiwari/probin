"""The model router (packages/router/src/router.ts).

Every model call in the product goes through `Router.call`: it picks the
model, enforces the workspace budget, escalates after failures, and logs the
call. Nothing else may talk to a model provider.
"""

from dataclasses import dataclass

from modelrouter.config import Eligibility, ModelEntry, ModelsConfig
from modelrouter.types import (
    CallOutcome,
    CallRecord,
    Ledger,
    ModelTransport,
    RouterRequest,
    RouterResponse,
)
from modelrouter.types import CompletionRequest as _Completion

#: How many failures on one request before the router moves to a stronger tier.
ESCALATE_AFTER_FAILURES = 2


class BudgetExceededError(Exception):
    """The workspace has used its monthly model budget. Building pauses; viewing is unaffected."""

    def __init__(self, limit: float, spent: float) -> None:
        self.limit = limit
        self.spent = spent
        super().__init__(
            f'This workspace has used its model budget for the month ({spent:.2f} of {limit:.2f}). '
            'Building new panels is paused; dashboards and alerts keep working.'
        )


class NoEligibleModelError(Exception):
    """No model has passed the test set for the tier a task needs."""

    def __init__(self, tier: str) -> None:
        super().__init__(
            f'No model is eligible for the "{tier}" tier. '
            'A model becomes eligible by passing the test set.'
        )


class ModelCallError(Exception):
    pass


@dataclass(frozen=True)
class _Plan:
    tier: str
    escalated: bool
    models: list[ModelEntry]


class Router:
    def __init__(
        self,
        *,
        config: ModelsConfig,
        #: None: eligibility is not enforced (tests, the stand-in).
        eligibility: Eligibility | None,
        transport: ModelTransport,
        ledger: Ledger,
    ) -> None:
        self.config = config
        self.eligibility = eligibility
        self.transport = transport
        self.ledger = ledger

    def _eligible_in(self, index: int) -> list[ModelEntry]:
        tier = self.config.tiers[index]
        if self.eligibility is None:
            return list(tier.models)
        passed = self.eligibility.tiers.get(tier.id, [])
        return [model for model in tier.models if model.id in passed]

    def _plan(self, request: RouterRequest, near_cap: bool) -> _Plan:
        config = self.config
        wanted = config.tasks.tier_of(request.task)
        base = next(i for i, tier in enumerate(config.tiers) if tier.id == wanted)
        escalated = request.failures >= ESCALATE_AFTER_FAILURES and base < len(config.tiers) - 1
        index = base + 1 if escalated else base

        if config.strategy == 'openrouter_auto':
            auto = ModelEntry(id=config.auto_model or '', input_per_mtok=0, output_per_mtok=0)
            return _Plan('auto', False, [auto])

        # If nothing in the tier is eligible, a stronger tier may stand in; a weaker one may not.
        models = self._eligible_in(index)
        while not models and index < len(config.tiers) - 1:
            index += 1
            models = self._eligible_in(index)
        if not models:
            raise NoEligibleModelError(wanted)
        if near_cap:
            models = sorted(models, key=lambda model: model.blended_price)
        return _Plan(config.tiers[index].id, escalated, models)

    async def call(self, request: RouterRequest) -> RouterResponse:
        budget = await self.ledger.budget(request.workspace_id)
        if budget.limit is not None and budget.spent >= budget.limit:
            raise BudgetExceededError(budget.limit, budget.spent)
        near_cap = (
            budget.limit is not None
            and budget.spent >= budget.limit * self.config.budget.near_cap_ratio
        )

        plan = self._plan(request, near_cap)
        escalated_from = request.previous_call_id if plan.escalated else None
        last_error: BaseException | None = None
        # One fallback inside the tier, so a single provider outage does not fail the request.
        for model in plan.models[:2]:
            try:
                reply = await self.transport.complete(
                    _Completion(
                        model=model.id,
                        messages=request.messages,
                        json=request.json,
                        max_tokens=request.max_tokens,
                        task=request.task,
                    )
                )
            except Exception as error:
                last_error = error
                await self.ledger.record(
                    CallRecord(
                        workspace_id=request.workspace_id,
                        request_id=request.request_id,
                        task=request.task,
                        model=model.id,
                        input_tokens=0,
                        output_tokens=0,
                        cost=0,
                        outcome='transport_error',
                        escalated_from=escalated_from,
                    )
                )
                continue
            cost = (
                reply.cost
                if reply.cost is not None
                else (
                    reply.input_tokens * model.input_per_mtok
                    + reply.output_tokens * model.output_per_mtok
                )
                / 1_000_000
            )
            used = reply.model or model.id
            call_id = await self.ledger.record(
                CallRecord(
                    workspace_id=request.workspace_id,
                    request_id=request.request_id,
                    task=request.task,
                    model=used,
                    input_tokens=reply.input_tokens,
                    output_tokens=reply.output_tokens,
                    cost=cost,
                    outcome='ok',
                    escalated_from=escalated_from,
                )
            )
            return RouterResponse(
                call_id=call_id,
                model=used,
                tier=plan.tier,
                escalated=plan.escalated,
                content=reply.content,
                input_tokens=reply.input_tokens,
                output_tokens=reply.output_tokens,
                cost=cost,
            )
        raise ModelCallError(f'The model call failed: {last_error}')

    async def report(self, call_id: str, outcome: CallOutcome) -> None:
        """Record how a call's output fared once the caller has checked it."""
        await self.ledger.set_outcome(call_id, outcome)
