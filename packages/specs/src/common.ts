import { z } from 'zod';

/**
 * A Prometheus-style duration: `30s`, `5m`, `5h`, `7d`.
 * Used for panel ranges, alert `for` and collector intervals.
 */
export const durationSchema = z
  .string()
  .regex(/^[1-9][0-9]*(ms|s|m|h|d|w|y)$/, 'must be a duration such as 30s, 5m or 5h');

const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

/** The length of a duration such as `5h` in seconds. Throws if it is not a valid duration. */
export function durationToSeconds(duration: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h|d|w|y)$/.exec(duration);
  if (!match) throw new Error(`"${duration}" is not a duration such as 30s, 5m or 5h`);
  return Number(match[1]) * DURATION_UNIT_SECONDS[match[2]!]!;
}

/** Rules and collectors start as pending and do nothing until a person approves them. */
export const APPROVAL_STATUSES = ['pending', 'active', 'disabled'] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export class SpecValidationError extends Error {
  override name = 'SpecValidationError';
  constructor(
    readonly spec: string,
    readonly issues: readonly SpecIssue[],
  ) {
    super(
      `Invalid ${spec}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
  }
}

export interface SpecIssue {
  /** Dotted path to the offending field, or `(root)`. */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: SpecIssue[] };

/** Validate without throwing. */
export function validate<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/** Validate and return the value, or throw a `SpecValidationError` naming every problem. */
export function parse<T>(spec: string, schema: z.ZodType<T>, input: unknown): T {
  const result = validate(schema, input);
  if (!result.ok) {
    throw new SpecValidationError(spec, result.issues);
  }
  return result.value;
}
