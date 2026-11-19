import { z } from 'zod';
import { approvalStatusSchema, durationSchema, parse, validate } from './common.js';

/**
 * A collector fetches a data source on an interval ("monitor <url>/health every minute").
 *
 * PROVISIONAL: the build plan gives the stored fields (source type, config,
 * interval, metric names, status) and no example. `source_type` and `config`
 * are left open until phase 4 decides which sources exist.
 *
 * Like alert rules, collectors start as pending and do nothing until approved.
 */
export const collectorSpecSchema = z.strictObject({
  name: z.string().min(1),
  source_type: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lower-case identifier'),
  config: z.record(z.string(), z.unknown()),
  interval: durationSchema,
  /** The metrics this collector writes, in OpenTelemetry naming. */
  metric_names: z.array(z.string().min(1)).min(1),
  status: approvalStatusSchema,
});

/** What `draft_collector` may write: always pending. */
export const draftCollectorSpecSchema = collectorSpecSchema.extend({
  status: z.literal('pending'),
});

export type CollectorSpec = z.infer<typeof collectorSpecSchema>;
export type DraftCollectorSpec = z.infer<typeof draftCollectorSpecSchema>;

export const validateCollectorSpec = (input: unknown) => validate(collectorSpecSchema, input);
export const parseCollectorSpec = (input: unknown) =>
  parse('collector spec', collectorSpecSchema, input);
export const validateDraftCollectorSpec = (input: unknown) =>
  validate(draftCollectorSpecSchema, input);
export const parseDraftCollectorSpec = (input: unknown) =>
  parse('draft collector spec', draftCollectorSpecSchema, input);
