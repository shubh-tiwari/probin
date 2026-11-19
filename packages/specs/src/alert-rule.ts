import { z } from 'zod';
import { approvalStatusSchema, durationSchema, parse, validate } from './common.js';

/**
 * An alert rule. `for` is required: a rule with no duration is not valid.
 * Only `active` rules are compiled into the alert engine's rule files.
 *
 * Who approved a rule and when is recorded on the stored row, not in the spec.
 */
export const alertRuleSpecSchema = z.strictObject({
  name: z.string().min(1),
  /** A comparison in the store's Prometheus-compatible language, e.g. `<query> > 0.8`. */
  expr: z.string().min(1),
  /** How long `expr` must hold before the rule fires. */
  for: durationSchema,
  /** PROVISIONAL: the build plan shows `warning` and does not list the allowed values. */
  severity: z.string().min(1),
  /** The Slack channel to notify, e.g. `#ops-monitoring`. */
  channel: z.string().regex(/^#\S+$/, 'must be a channel name starting with #'),
  status: approvalStatusSchema,
  /**
   * PROVISIONAL, not in the build plan's example: the parts the comparison is
   * built from, so a rule can be shown, edited and explained in plain words.
   */
  query: z.string().min(1).optional(),
  comparison: z.strictObject({ op: z.enum(['>', '<']), threshold: z.number() }).optional(),
  unit: z.string().optional(),
  display_unit: z.string().optional(),
  service: z.string().optional(),
  request: z.string().optional(),
  assumptions: z.array(z.string()).optional(),
});

/** What `draft_alert` may write: the same rule, and always pending. */
export const draftAlertRuleSpecSchema = alertRuleSpecSchema.extend({
  status: z.literal('pending'),
});

export type AlertRuleSpec = z.infer<typeof alertRuleSpecSchema>;
export type DraftAlertRuleSpec = z.infer<typeof draftAlertRuleSpecSchema>;

export const validateAlertRuleSpec = (input: unknown) => validate(alertRuleSpecSchema, input);
export const parseAlertRuleSpec = (input: unknown) =>
  parse('alert rule spec', alertRuleSpecSchema, input);
export const validateDraftAlertRuleSpec = (input: unknown) =>
  validate(draftAlertRuleSpecSchema, input);
export const parseDraftAlertRuleSpec = (input: unknown) =>
  parse('draft alert rule spec', draftAlertRuleSpecSchema, input);
