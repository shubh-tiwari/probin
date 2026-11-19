import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './env.js';

/**
 * Plans, limits and prices. None are decided yet (see "Open items" in the
 * build plan), so the code reads them from a file and hard-codes nothing.
 * The shape follows the proposed pricing: one flat monthly price per
 * workspace with included limits, and a time-limited free trial.
 */
export const planSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'must be a lower-case identifier'),
  name: z.string().min(1),
  /** Flat price per workspace per month, in `currency`. */
  price_monthly: z.number().nonnegative(),
  limits: z.strictObject({
    /** Included "metrics stored": the number of active time series. */
    active_series: z.number().int().positive(),
    /** Included model usage per month, in `currency`. Default for the workspace budget cap. */
    model_budget_monthly: z.number().nonnegative(),
    /** How long metrics are kept. */
    retention_days: z.number().int().positive(),
  }),
  /** The billing provider's price for this plan (a Stripe price id). Unset: the plan cannot be bought online. */
  stripe_price: z.string().min(1).optional(),
});

export const plansConfigSchema = z
  .strictObject({
    /** ISO 4217 code used for every price and budget in this file. */
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter currency code'),
    trial: z.strictObject({
      days: z.number().int().positive(),
      /** The plan a trial workspace gets the limits of. */
      plan: z.string().min(1),
    }),
    plans: z.array(planSchema).min(1),
    /** After a cancellation takes effect, how long before the workspace's data is deleted. */
    cancellation: z
      .strictObject({ grace_days: z.number().nonnegative() })
      .default({ grace_days: 7 }),
  })
  .superRefine((config, ctx) => {
    const ids = config.plans.map((plan) => plan.id);
    for (const id of new Set(ids)) {
      if (ids.indexOf(id) !== ids.lastIndexOf(id)) {
        ctx.addIssue({ code: 'custom', path: ['plans'], message: `duplicate plan id "${id}"` });
      }
    }
    if (!ids.includes(config.trial.plan)) {
      ctx.addIssue({
        code: 'custom',
        path: ['trial', 'plan'],
        message: `unknown plan "${config.trial.plan}"`,
      });
    }
  });

export type Plan = z.infer<typeof planSchema>;
export type PlansConfig = z.infer<typeof plansConfigSchema>;

export function parsePlans(yamlText: string, origin = 'plans config'): PlansConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ConfigError(`${origin}: not valid YAML: ${(error as Error).message}`);
  }
  const parsed = plansConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`${origin}: ${issues}`);
  }
  return parsed.data;
}

/** Load plans from a YAML file. A relative path is resolved from the working directory. */
export function loadPlans(path: string): PlansConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read plans file ${path}: ${(error as Error).message}`);
  }
  return parsePlans(text, path);
}

export function findPlan(config: PlansConfig, id: string): Plan | undefined {
  return config.plans.find((plan) => plan.id === id);
}
