import { z } from 'zod';
import { durationSchema, parse, validate } from './common.js';

/**
 * Where one panel sits on the dashboard grid.
 *
 * PROVISIONAL: the build plan gives the stored fields (title, layout, panel
 * ids, default time range) and no example. This is a plain column grid; the
 * web tool in phase 3 may need more.
 */
export const layoutItemSchema = z.strictObject({
  panel_id: z.uuid(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

export const dashboardSpecSchema = z
  .strictObject({
    title: z.string().min(1),
    panel_ids: z.array(z.uuid()),
    layout: z.array(layoutItemSchema),
    /** Panels with no range of their own use this one. */
    default_range: durationSchema,
  })
  .superRefine((dashboard, ctx) => {
    const ids = new Set(dashboard.panel_ids);
    if (ids.size !== dashboard.panel_ids.length) {
      ctx.addIssue({ code: 'custom', path: ['panel_ids'], message: 'panel ids must be unique' });
    }
    const placed = new Set<string>();
    dashboard.layout.forEach((item, index) => {
      if (!ids.has(item.panel_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layout', index, 'panel_id'],
          message: 'layout refers to a panel that is not on this dashboard',
        });
      }
      if (placed.has(item.panel_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layout', index, 'panel_id'],
          message: 'panel is placed more than once',
        });
      }
      placed.add(item.panel_id);
    });
  });

export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;
export type LayoutItem = z.infer<typeof layoutItemSchema>;

export const validateDashboardSpec = (input: unknown) => validate(dashboardSpecSchema, input);
export const parseDashboardSpec = (input: unknown) =>
  parse('dashboard spec', dashboardSpecSchema, input);
