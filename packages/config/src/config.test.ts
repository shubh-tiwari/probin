import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  MANIFEST_FILENAME,
  PRODUCT_NAME,
  PRODUCT_SLUG,
  findPlan,
  loadEnv,
  loadPlans,
  parsePlans,
} from './index.js';

describe('product name', () => {
  it('derives the slug and manifest file name from the one constant', () => {
    expect(PRODUCT_SLUG).toBe(PRODUCT_NAME.toLowerCase());
    expect(PRODUCT_SLUG).toMatch(/^[a-z0-9-]+$/);
    expect(MANIFEST_FILENAME).toBe(`${PRODUCT_SLUG}.yaml`);
  });
});

describe('loadEnv', () => {
  const source = {
    DATABASE_URL: 'postgres://app:app@localhost:5432/app',
    METRICS_STORE_URL: 'http://localhost:8428/',
    INGEST_URL: 'http://localhost:4318',
    PLANS_FILE: 'config/plans.example.yaml',
  };

  it('returns only the requested keys', () => {
    expect(loadEnv(['DATABASE_URL'], source)).toEqual({ DATABASE_URL: source.DATABASE_URL });
  });

  it('defaults the store type to victoriametrics and accepts prometheus', () => {
    expect(loadEnv(['METRICS_STORE_TYPE'], source).METRICS_STORE_TYPE).toBe('victoriametrics');
    expect(
      loadEnv(['METRICS_STORE_TYPE'], { METRICS_STORE_TYPE: 'prometheus' }).METRICS_STORE_TYPE,
    ).toBe('prometheus');
  });

  it('rejects an unknown store type', () => {
    expect(() => loadEnv(['METRICS_STORE_TYPE'], { METRICS_STORE_TYPE: 'influx' })).toThrow(
      ConfigError,
    );
  });

  it('strips the trailing slash from URLs', () => {
    expect(loadEnv(['METRICS_STORE_URL'], source).METRICS_STORE_URL).toBe('http://localhost:8428');
  });

  it('applies defaults to limits and reads numbers from strings', () => {
    expect(loadEnv(['QUERY_MAX_LINES', 'QUERY_TIMEOUT_MS'], {})).toEqual({
      QUERY_MAX_LINES: 50,
      QUERY_TIMEOUT_MS: 10_000,
    });
    expect(loadEnv(['QUERY_MAX_LINES'], { QUERY_MAX_LINES: '20' }).QUERY_MAX_LINES).toBe(20);
    expect(() => loadEnv(['QUERY_MAX_LINES'], { QUERY_MAX_LINES: 'many' })).toThrow(ConfigError);
  });

  it('leaves the model key optional', () => {
    expect(loadEnv(['OPENROUTER_API_KEY'], {})).toEqual({ OPENROUTER_API_KEY: undefined });
  });

  it('names every missing or invalid variable in one error', () => {
    expect(() =>
      loadEnv(['DATABASE_URL', 'METRICS_STORE_URL'], { METRICS_STORE_URL: 'not a url' }),
    ).toThrow(/DATABASE_URL is not set; METRICS_STORE_URL must be an http\(s\) URL/);
  });
});

describe('plans', () => {
  const examplePath = fileURLToPath(new URL('../../../config/plans.example.yaml', import.meta.url));

  it('loads the example file', () => {
    const config = loadPlans(examplePath);
    expect(config.plans.length).toBeGreaterThan(0);
    expect(findPlan(config, config.trial.plan)).toBeDefined();
  });

  it('rejects a trial that points at an unknown plan', () => {
    const yaml = `
currency: USD
trial: { days: 14, plan: missing }
plans:
  - id: a
    name: A
    price_monthly: 1
    limits: { active_series: 1, model_budget_monthly: 1, retention_days: 1 }
`;
    expect(() => parsePlans(yaml)).toThrow(/unknown plan "missing"/);
  });

  it('rejects unknown keys so a typo cannot silently drop a limit', () => {
    const yaml = `
currency: USD
trial: { days: 14, plan: a }
plans:
  - id: a
    name: A
    price_monthly: 1
    limits: { active_series: 1, model_budget_monthly: 1, retention_days: 1, retension_days: 9 }
`;
    expect(() => parsePlans(yaml)).toThrow(ConfigError);
  });

  it('reports a missing file as a ConfigError', () => {
    expect(() => loadPlans('/nonexistent/plans.yaml')).toThrow(ConfigError);
  });
});

describe('secret box', async () => {
  const { createSecretBox } = await import('./index.js');
  const key = Buffer.alloc(32, 7).toString('base64');

  it('round-trips, and never stores the secret in clear', () => {
    const box = createSecretBox(key);
    const sealed = box.seal('xoxb-secret-token');
    expect(sealed).not.toContain('xoxb');
    expect(box.open(sealed)).toBe('xoxb-secret-token');
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('refuses a tampered value and a different key', () => {
    const sealed = createSecretBox(key).seal('token');
    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(() => createSecretBox(key).open(tampered)).toThrow();
    expect(() => createSecretBox(Buffer.alloc(32, 8).toString('base64')).open(sealed)).toThrow();
  });
});
