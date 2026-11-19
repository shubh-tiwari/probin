import {
  createOpenRouterTransport,
  loadEligibility,
  loadModels,
  parseModels,
  type Eligibility,
  type ModelTransport,
  type ModelsConfig,
} from '@app/router';
import { STAND_IN_MODEL, createStandInTransport } from './standin.js';

export interface ModelSetup {
  config: ModelsConfig;
  eligibility: Eligibility | undefined | null;
  transport: ModelTransport;
  /** What to tell an operator at start-up. */
  description: string;
}

/** Every task goes to the stand-in. It costs nothing and is always "eligible". */
const STAND_IN_CONFIG = parseModels(`
tiers:
  - { id: stand-in, models: [{ id: ${STAND_IN_MODEL}, input_per_mtok: 0, output_per_mtok: 0 }] }
tasks: { parse: stand-in, ask: stand-in, write_query: stand-in, explain: stand-in, review: stand-in }
budget: { near_cap_ratio: 1 }
`);

/**
 * Choose the model set-up from the environment. With a key, real models
 * through OpenRouter, limited to those that passed the test set. Without one,
 * the built-in stand-in, so the product can be run and tested end to end.
 */
export function chooseModels(options: {
  apiKey: string | undefined;
  modelsFile: string;
}): ModelSetup {
  if (!options.apiKey) {
    return {
      config: STAND_IN_CONFIG,
      eligibility: null,
      transport: createStandInTransport(),
      description:
        'no model key set: using the built-in stand-in (keyword rules, plain requests only, no model calls)',
    };
  }
  const config = loadModels(options.modelsFile);
  const eligibility = config.eligibility_file ? loadEligibility(config.eligibility_file) : null;
  const passed = eligibility
    ? Object.values(eligibility.tiers).reduce((sum, models) => sum + models.length, 0)
    : undefined;
  return {
    config,
    eligibility,
    transport: createOpenRouterTransport({ apiKey: options.apiKey }),
    description:
      eligibility === null
        ? `models from ${options.modelsFile} (${config.strategy}), eligibility not enforced`
        : `models from ${options.modelsFile} (${config.strategy}), ${passed ?? 0} eligible by the test set`,
  };
}
