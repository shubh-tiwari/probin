"""Choose the model set-up from the environment (apps/agent/src/models.ts)."""

from dataclasses import dataclass

from agent.standin import STAND_IN_MODEL, StandInTransport
from modelrouter import (
    Eligibility,
    ModelsConfig,
    ModelTransport,
    OpenRouterTransport,
    load_eligibility,
    load_models,
    parse_models,
)

#: Every task goes to the stand-in. It costs nothing and is always "eligible".
STAND_IN_CONFIG = parse_models(f"""
tiers:
  - {{ id: stand-in, models: [{{ id: {STAND_IN_MODEL}, input_per_mtok: 0, output_per_mtok: 0 }}] }}
tasks:
  {{ parse: stand-in, ask: stand-in, write_query: stand-in, explain: stand-in, review: stand-in }}
budget: {{ near_cap_ratio: 1 }}
""")


@dataclass(frozen=True)
class ModelSetup:
    config: ModelsConfig
    #: None: eligibility is not enforced (the stand-in).
    eligibility: Eligibility | None
    transport: ModelTransport
    #: What to tell an operator at start-up.
    description: str


def choose_models(*, api_key: str | None, models_file: str) -> ModelSetup:
    """With a key, real models through OpenRouter, limited to those that passed the test set.

    Without one, the built-in stand-in, so the product can be run and tested end to end.
    """
    if not api_key:
        return ModelSetup(
            config=STAND_IN_CONFIG,
            eligibility=None,
            transport=StandInTransport(),
            description=(
                'no model key set: using the built-in stand-in '
                '(keyword rules, plain requests only, no model calls)'
            ),
        )
    config = load_models(models_file)
    eligibility = load_eligibility(config.eligibility_file) if config.eligibility_file else None
    if eligibility is None:
        described = 'eligibility not enforced'
    else:
        passed = sum(len(models) for models in eligibility.tiers.values())
        described = f'{passed} eligible by the test set'
    return ModelSetup(
        config=config,
        eligibility=eligibility,
        transport=OpenRouterTransport(api_key=api_key),
        description=f'models from {models_file} ({config.strategy}), {described}',
    )
