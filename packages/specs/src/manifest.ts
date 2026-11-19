import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SpecValidationError, parse, validate } from './common.js';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const METRIC_TYPES = ['histogram', 'counter', 'gauge'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/**
 * Units that break "base units only: seconds and bytes".
 * Anything else (`s`, `By`, `1`, `{order}`) is accepted.
 */
const NON_BASE_UNITS = new Set([
  'ns',
  'us',
  'µs',
  'ms',
  'min',
  'h',
  'd',
  'bit',
  'kb',
  'mb',
  'gb',
  'tb',
  'kby',
  'mby',
  'gby',
  'tby',
  'kiby',
  'miby',
  'giby',
  'tiby',
]);

/** OpenTelemetry-style name: lower-case words joined by dots, e.g. `http.server.request.duration`. */
const otelNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/,
    'must be lower-case words joined by dots, e.g. http.server.request.duration',
  );

/** `http.route` is the route template (`/orders/{id}`), never the full URL. */
const routeSchema = z
  .string()
  .startsWith('/', 'must be a route template starting with /, not a full URL')
  .refine((route) => !/[?#\s]/.test(route), {
    message: 'must be a route template with no query string, fragment or spaces',
  });

export const manifestEndpointSchema = z.strictObject({
  method: z.enum(HTTP_METHODS),
  route: routeSchema,
  description: z.string().min(1).optional(),
});

export const manifestMetricSchema = z.strictObject({
  name: otelNameSchema,
  type: z.enum(METRIC_TYPES),
  unit: z.string().refine((unit) => !NON_BASE_UNITS.has(unit.toLowerCase()), {
    message: 'must be a base unit: seconds (s) or bytes (By), not a multiple of one',
  }),
  description: z.string().min(1),
  /** Attribute names. Each must have a short, fixed set of values. */
  attributes: z.array(otelNameSchema).optional(),
});

/**
 * The service manifest: written by the skill into each repository and sent on
 * registration. It is the catalog's first source for endpoints and metrics.
 */
export const manifestSchema = z
  .strictObject({
    service: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/, 'must be a lower-case name such as checkout or order-api'),
    description: z.string().min(1),
    endpoints: z.array(manifestEndpointSchema),
    metrics: z.array(manifestMetricSchema),
  })
  .superRefine((manifest, ctx) => {
    const endpoints = new Set<string>();
    manifest.endpoints.forEach((endpoint, index) => {
      const key = `${endpoint.method} ${endpoint.route}`;
      if (endpoints.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoints', index],
          message: `duplicate endpoint ${key}`,
        });
      }
      endpoints.add(key);
    });
    const metrics = new Set<string>();
    manifest.metrics.forEach((metric, index) => {
      if (metrics.has(metric.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['metrics', index, 'name'],
          message: `duplicate metric ${metric.name}`,
        });
      }
      metrics.add(metric.name);
    });
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestEndpoint = z.infer<typeof manifestEndpointSchema>;
export type ManifestMetric = z.infer<typeof manifestMetricSchema>;

export const validateManifest = (input: unknown) => validate(manifestSchema, input);
export const parseManifest = (input: unknown) => parse('service manifest', manifestSchema, input);

/** Parse the manifest file's YAML text. */
export function parseManifestYaml(yamlText: string): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new SpecValidationError('service manifest', [
      { path: '(root)', message: `not valid YAML: ${(error as Error).message}` },
    ]);
  }
  return parseManifest(raw);
}
