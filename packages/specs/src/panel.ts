import { z } from 'zod';
import { durationSchema, parse, validate } from './common.js';

/** Panel types for the first release. */
export const PANEL_TYPES = ['timeseries', 'bar', 'stat'] as const;
export const panelTypeSchema = z.enum(PANEL_TYPES);
export type PanelType = z.infer<typeof panelTypeSchema>;

/**
 * PROVISIONAL: the build plan shows `thresholds: []` and no populated example.
 * This is the smallest shape that can draw a line on a chart.
 */
export const thresholdSchema = z.strictObject({
  /** In the panel's `unit`, not its `display_unit`. */
  value: z.number(),
  label: z.string().min(1).optional(),
});

/**
 * The agent's output is a spec, never chart code.
 *
 * "Show the work": `query`, `assumptions` and `request` are required so every
 * panel keeps the query behind it, what was assumed, and what was asked.
 * The time range lives outside the query so the dashboard's time picker can
 * change it without calling the model.
 */
export const panelSpecSchema = z.strictObject({
  title: z.string().min(1),
  type: panelTypeSchema,
  /** A query in the store's Prometheus-compatible language, with no time range baked in. */
  query: z.string().min(1),
  /** The unit the query returns. Base units only: seconds and bytes. */
  unit: z.string(),
  /** The unit to show, when it differs from `unit` (for example `ms` for a query in `s`). */
  display_unit: z.string().min(1).optional(),
  /** Omitted means the panel follows its dashboard's range. */
  range: durationSchema.optional(),
  thresholds: z.array(thresholdSchema),
  /** The original request, word for word. */
  request: z.string().min(1),
  /** Every default the agent filled in instead of asking. */
  assumptions: z.array(z.string().min(1)),
});

export type PanelSpec = z.infer<typeof panelSpecSchema>;
export type Threshold = z.infer<typeof thresholdSchema>;

export const validatePanelSpec = (input: unknown) => validate(panelSpecSchema, input);
export const parsePanelSpec = (input: unknown) => parse('panel spec', panelSpecSchema, input);
