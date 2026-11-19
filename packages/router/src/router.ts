import type { Eligibility, ModelEntry, ModelsConfig } from './config.js';
import type {
  CallOutcome,
  Ledger,
  ModelTransport,
  RouterRequest,
  RouterResponse,
} from './types.js';

/** The workspace has used its monthly model budget. Building pauses; viewing is unaffected. */
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(
    readonly limit: number,
    readonly spent: number,
  ) {
    super(
      `This workspace has used its model budget for the month (${spent.toFixed(2)} of ${limit.toFixed(2)}). ` +
        `Building new panels is paused; dashboards and alerts keep working.`,
    );
  }
}

/** No model has passed the test set for the tier a task needs. */
export class NoEligibleModelError extends Error {
  override name = 'NoEligibleModelError';
  constructor(tier: string) {
    super(
      `No model is eligible for the "${tier}" tier. A model becomes eligible by passing the test set.`,
    );
  }
}

export class ModelCallError extends Error {
  override name = 'ModelCallError';
}

/** How many failures on one request before the router moves to a stronger tier. */
export const ESCALATE_AFTER_FAILURES = 2;

const blendedPrice = (model: ModelEntry) => model.input_per_mtok + model.output_per_mtok;

export interface RouterDependencies {
  config: ModelsConfig;
  /** Undefined: no model has passed yet. Null: eligibility is not enforced (tests, stand-in). */
  eligibility: Eligibility | undefined | null;
  transport: ModelTransport;
  ledger: Ledger;
}

/**
 * The model router. Every model call in the product goes through `call`:
 * it picks the model, enforces the workspace budget, escalates after
 * failures, and logs the call. Nothing else may talk to a model provider.
 */
export function createRouter(deps: RouterDependencies) {
  const { config } = deps;

  const eligibleIn = (tierIndex: number): ModelEntry[] => {
    const tier = config.tiers[tierIndex]!;
    if (deps.eligibility === null) return tier.models;
    const passed = deps.eligibility?.tiers[tier.id] ?? [];
    return tier.models.filter((model) => passed.includes(model.id));
  };

  /** The tier a task runs on, and the models to try in order. */
  function plan(request: RouterRequest, nearCap: boolean) {
    const base = config.tiers.findIndex((tier) => tier.id === config.tasks[request.task]);
    const escalated =
      (request.failures ?? 0) >= ESCALATE_AFTER_FAILURES && base < config.tiers.length - 1;
    let index = escalated ? base + 1 : base;

    if (config.strategy === 'openrouter_auto') {
      const auto: ModelEntry = { id: config.auto_model!, input_per_mtok: 0, output_per_mtok: 0 };
      return { tier: 'auto', escalated: false, models: [auto] };
    }

    // If nothing in the tier is eligible, a stronger tier may stand in; a weaker one may not.
    let models = eligibleIn(index);
    while (models.length === 0 && index < config.tiers.length - 1) {
      index += 1;
      models = eligibleIn(index);
    }
    if (models.length === 0) throw new NoEligibleModelError(config.tasks[request.task]);
    if (nearCap) models = [...models].sort((a, b) => blendedPrice(a) - blendedPrice(b));
    return { tier: config.tiers[index]!.id, escalated, models };
  }

  return {
    async call(request: RouterRequest): Promise<RouterResponse> {
      const { limit, spent } = await deps.ledger.budget(request.workspaceId);
      if (limit !== null && spent >= limit) throw new BudgetExceededError(limit, spent);
      const nearCap = limit !== null && spent >= limit * config.budget.near_cap_ratio;

      const { tier, escalated, models } = plan(request, nearCap);
      let lastError: unknown;
      // One fallback inside the tier, so a single provider outage does not fail the request.
      for (const model of models.slice(0, 2)) {
        const base = {
          workspaceId: request.workspaceId,
          requestId: request.requestId,
          task: request.task,
          escalatedFrom: escalated ? request.previousCallId : undefined,
        };
        try {
          const reply = await deps.transport.complete({
            model: model.id,
            messages: request.messages,
            json: request.json ?? false,
            maxTokens: request.maxTokens ?? 1024,
            task: request.task,
          });
          const cost =
            reply.cost ??
            (reply.inputTokens * model.input_per_mtok +
              reply.outputTokens * model.output_per_mtok) /
              1_000_000;
          const used = reply.model ?? model.id;
          const callId = await deps.ledger.record({
            ...base,
            model: used,
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            cost,
            outcome: 'ok',
          });
          return {
            callId,
            model: used,
            tier,
            escalated,
            content: reply.content,
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            cost,
          };
        } catch (error) {
          lastError = error;
          await deps.ledger.record({
            ...base,
            model: model.id,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            outcome: 'transport_error',
          });
        }
      }
      throw new ModelCallError(
        `The model call failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    },

    /** Record how a call's output fared once the caller has checked it. */
    report(callId: string, outcome: CallOutcome): Promise<void> {
      return deps.ledger.setOutcome(callId, outcome);
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
