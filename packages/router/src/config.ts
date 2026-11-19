import { readFileSync } from 'node:fs';
import { ConfigError } from '@app/config';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** What a model call is for. The router maps each to a tier. */
export const TASK_TYPES = ['parse', 'ask', 'write_query', 'explain', 'review'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

const modelSchema = z.strictObject({
  id: z.string().min(1),
  /** List prices per million tokens, in the plans file's currency. */
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
});

const tierSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  models: z.array(modelSchema).min(1),
});

export const modelsConfigSchema = z
  .strictObject({
    strategy: z.enum(['table', 'openrouter_auto']).default('table'),
    auto_model: z.string().min(1).optional(),
    /** Cheapest first. Escalation moves towards the end. */
    tiers: z.array(tierSchema).min(1),
    tasks: z.strictObject(
      Object.fromEntries(TASK_TYPES.map((task) => [task, z.string()])) as Record<
        TaskType,
        z.ZodString
      >,
    ),
    budget: z.strictObject({ near_cap_ratio: z.number().min(0).max(1) }),
    /** Null or absent: every listed model may be used. Only for tests and local stand-ins. */
    eligibility_file: z.string().min(1).nullable().optional(),
  })
  .superRefine((config, ctx) => {
    const tierIds = config.tiers.map((tier) => tier.id);
    if (new Set(tierIds).size !== tierIds.length) {
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'tier ids must be unique' });
    }
    for (const task of TASK_TYPES) {
      if (!tierIds.includes(config.tasks[task])) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', task],
          message: `unknown tier "${config.tasks[task]}"`,
        });
      }
    }
    if (config.strategy === 'openrouter_auto' && !config.auto_model) {
      ctx.addIssue({
        code: 'custom',
        path: ['auto_model'],
        message: 'auto_model is required when strategy is openrouter_auto',
      });
    }
  });

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type ModelEntry = z.infer<typeof modelSchema>;

export function parseModels(yamlText: string, origin = 'models config'): ModelsConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ConfigError(`${origin}: not valid YAML: ${(error as Error).message}`);
  }
  const parsed = modelsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`${origin}: ${issues}`);
  }
  return parsed.data;
}

export function loadModels(path: string): ModelsConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read models file ${path}: ${(error as Error).message}`);
  }
  return parseModels(text, path);
}

/**
 * Which models passed the test set for which tier. Written by the test set
 * (`evals/`), read by the router. A model that is not listed is not used.
 */
const eligibilitySchema = z.strictObject({
  /** When the test set last wrote this file. */
  updated: z.string(),
  /** tier id → model ids that passed. */
  tiers: z.record(z.string(), z.array(z.string())),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;

/** Returns undefined when the file does not exist yet: no model has passed. */
export function loadEligibility(path: string): Eligibility | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = eligibilitySchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new ConfigError(`${path}: not a valid eligibility file`);
  return parsed.data;
}
