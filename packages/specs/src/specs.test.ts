import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SpecValidationError,
  parseAlertRuleSpec,
  parseCollectorSpec,
  parseDashboardSpec,
  parseDraftAlertRuleSpec,
  parseDraftCollectorSpec,
  parseManifestYaml,
  parsePanelSpec,
  validateAlertRuleSpec,
  validateManifest,
  validatePanelSpec,
} from './index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;

/** Field paths a validation result complained about. */
const paths = (result: { ok: boolean; issues?: { path: string }[] }) =>
  result.issues?.map((issue) => issue.path) ?? [];

describe('panel spec', () => {
  it('accepts the example from the build plan unchanged', () => {
    expect(parsePanelSpec(json('panel.json'))).toEqual(json('panel.json'));
  });

  it('accepts each first-release panel type and nothing else', () => {
    for (const type of ['timeseries', 'bar', 'stat']) {
      expect(validatePanelSpec({ ...json('panel.json'), type }).ok).toBe(true);
    }
    expect(paths(validatePanelSpec({ ...json('panel.json'), type: 'pie' }))).toEqual(['type']);
  });

  it('requires the query, the assumptions and the original request (show the work)', () => {
    for (const field of ['query', 'assumptions', 'request']) {
      const spec = json('panel.json');
      delete spec[field];
      expect(paths(validatePanelSpec(spec))).toEqual([field]);
    }
  });

  it('lets a panel follow its dashboard range by leaving range out', () => {
    const spec = json('panel.json');
    delete spec.range;
    expect(validatePanelSpec(spec).ok).toBe(true);
  });

  it('rejects a range that is not a duration', () => {
    expect(paths(validatePanelSpec({ ...json('panel.json'), range: 'last 5 hours' }))).toEqual([
      'range',
    ]);
  });

  it('rejects chart code or any other unknown field', () => {
    const result = validatePanelSpec({ ...json('panel.json'), render: 'function draw() {}' });
    expect(result.ok).toBe(false);
  });
});

describe('alert rule spec', () => {
  it('accepts the example from the build plan unchanged', () => {
    expect(parseAlertRuleSpec(json('alert-rule.json'))).toEqual(json('alert-rule.json'));
  });

  it('rejects a rule with no `for` duration', () => {
    const spec = json('alert-rule.json');
    delete spec.for;
    expect(paths(validateAlertRuleSpec(spec))).toEqual(['for']);
  });

  it('rejects a `for` that is not a duration', () => {
    expect(paths(validateAlertRuleSpec({ ...json('alert-rule.json'), for: '0' }))).toEqual(['for']);
  });

  it('only knows pending and active', () => {
    expect(validateAlertRuleSpec({ ...json('alert-rule.json'), status: 'active' }).ok).toBe(true);
    expect(paths(validateAlertRuleSpec({ ...json('alert-rule.json'), status: 'firing' }))).toEqual([
      'status',
    ]);
  });

  it('a draft can only be pending (approval before effect)', () => {
    expect(parseDraftAlertRuleSpec(json('alert-rule.json')).status).toBe('pending');
    expect(() => parseDraftAlertRuleSpec({ ...json('alert-rule.json'), status: 'active' })).toThrow(
      SpecValidationError,
    );
  });
});

describe('collector spec', () => {
  const collector = {
    name: 'Storefront health',
    source_type: 'http',
    config: { url: 'https://example.com/health' },
    interval: '1m',
    metric_names: ['storefront.health.up'],
    status: 'pending',
  };

  it('accepts a pending collector', () => {
    expect(parseCollectorSpec(collector)).toEqual(collector);
  });

  it('a draft can only be pending (approval before effect)', () => {
    expect(() => parseDraftCollectorSpec({ ...collector, status: 'active' })).toThrow(
      SpecValidationError,
    );
  });

  it('requires an interval and at least one metric name', () => {
    expect(() => parseCollectorSpec({ ...collector, interval: 'often' })).toThrow(/interval/);
    expect(() => parseCollectorSpec({ ...collector, metric_names: [] })).toThrow(/metric_names/);
  });
});

describe('dashboard spec', () => {
  const a = '0b3f1d5e-6a57-4c1b-9d0a-2f8f3f1c9a10';
  const b = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dashboard = {
    title: 'Checkout',
    panel_ids: [a, b],
    layout: [
      { panel_id: a, x: 0, y: 0, w: 6, h: 4 },
      { panel_id: b, x: 6, y: 0, w: 6, h: 4 },
    ],
    default_range: '6h',
  };

  it('accepts a dashboard whose layout places its own panels', () => {
    expect(parseDashboardSpec(dashboard)).toEqual(dashboard);
  });

  it('rejects a layout item for a panel that is not on the dashboard', () => {
    expect(() => parseDashboardSpec({ ...dashboard, panel_ids: [a] })).toThrow(
      /not on this dashboard/,
    );
  });

  it('rejects a panel placed twice', () => {
    const layout = [dashboard.layout[0], { ...dashboard.layout[1], panel_id: a }];
    expect(() => parseDashboardSpec({ ...dashboard, layout })).toThrow(/more than once/);
  });
});

describe('service manifest', () => {
  const manifest = () => parseManifestYaml(fixture('manifest.yaml'));

  it('accepts the example from the build plan', () => {
    const parsed = manifest();
    expect(parsed.service).toBe('checkout');
    expect(parsed.endpoints.map((e) => `${e.method} ${e.route}`)).toEqual([
      'POST /checkout/pay',
      'GET /checkout/summary',
    ]);
    expect(parsed.metrics.map((m) => m.name)).toEqual([
      'http.server.request.duration',
      'orders.completed',
    ]);
    expect(parsed.metrics[1]?.attributes).toEqual(['payment.method']);
  });

  it('accepts a route template with a parameter', () => {
    const input = { ...manifest(), endpoints: [{ method: 'GET', route: '/orders/{id}' }] };
    expect(validateManifest(input).ok).toBe(true);
  });

  it('rejects a full URL as a route', () => {
    for (const route of ['https://shop.example.com/checkout/pay', '/orders?id=42']) {
      const input = { ...manifest(), endpoints: [{ method: 'GET', route }] };
      expect(paths(validateManifest(input))).toEqual(['endpoints.0.route']);
    }
  });

  it('rejects units that are not base units', () => {
    for (const unit of ['ms', 'MiBy', 'min']) {
      const metric = { ...manifest().metrics[0], unit };
      expect(paths(validateManifest({ ...manifest(), metrics: [metric] }))).toEqual([
        'metrics.0.unit',
      ]);
    }
  });

  it('rejects metric names outside the OpenTelemetry naming style', () => {
    const metric = { ...manifest().metrics[0], name: 'HTTP Server Duration' };
    expect(paths(validateManifest({ ...manifest(), metrics: [metric] }))).toEqual([
      'metrics.0.name',
    ]);
  });

  it('rejects duplicate endpoints and metrics', () => {
    const parsed = manifest();
    const input = {
      ...parsed,
      endpoints: [...parsed.endpoints, parsed.endpoints[0]],
      metrics: [...parsed.metrics, parsed.metrics[0]],
    };
    expect(paths(validateManifest(input))).toEqual(['endpoints.2', 'metrics.2.name']);
  });

  it('reports broken YAML as a validation error', () => {
    expect(() => parseManifestYaml('service: [unclosed')).toThrow(SpecValidationError);
  });
});
