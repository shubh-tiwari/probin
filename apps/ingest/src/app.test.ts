import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_HEADER, createIngestApp, type IngestDependencies } from './app.js';
import { bearerKey, generateIngestionKey, hashIngestionKey } from './keys.js';

const WORKSPACE_A = '0b3f1d5e-6a57-4c1b-9d0a-2f8f3f1c9a10';
const KEY_A = generateIngestionKey();

function setup(overrides: Partial<IngestDependencies> = {}) {
  const collector = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('{"partialSuccess":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const registerManifest = vi.fn(async () => ({ registered: true }));
  const app = createIngestApp({
    findWorkspaceId: async (hash) => (hash === hashIngestionKey(KEY_A) ? WORKSPACE_A : undefined),
    collectorUrl: 'http://collector:4318',
    maxBodyBytes: 1024,
    registerManifest,
    fetch: collector as unknown as typeof fetch,
    ...overrides,
  });
  return { app, collector, registerManifest };
}

const post = (path: string, headers: Record<string, string>, body: string | Uint8Array = '{}') => ({
  method: 'POST',
  headers,
  body,
});

describe('ingestion keys', () => {
  it('are long, random and recognisable', () => {
    const a = generateIngestionKey();
    const b = generateIngestionKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+_ik_[A-Za-z0-9_-]{43}$/);
  });

  it('are stored only as a hash', () => {
    expect(hashIngestionKey(KEY_A)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIngestionKey(KEY_A)).not.toContain(KEY_A);
  });

  it('are read from a bearer header only', () => {
    expect(bearerKey('Bearer abc')).toBe('abc');
    expect(bearerKey('bearer abc')).toBe('abc');
    expect(bearerKey('Basic abc')).toBeUndefined();
    expect(bearerKey('Bearer')).toBeUndefined();
    expect(bearerKey(undefined)).toBeUndefined();
  });
});

describe('POST /v1/metrics', () => {
  it('refuses a request with no key, and one with an unknown key', async () => {
    const { app, collector } = setup();
    expect((await app.request('/v1/metrics', post('/v1/metrics', {}))).status).toBe(401);
    const unknown = await app.request(
      '/v1/metrics',
      post('/v1/metrics', { authorization: `Bearer ${generateIngestionKey()}` }),
    );
    expect(unknown.status).toBe(401);
    expect(collector).not.toHaveBeenCalled();
  });

  it('forwards the body untouched with the workspace of the key', async () => {
    const { app, collector } = setup();
    const body = new Uint8Array([1, 2, 3, 4]);
    const response = await app.request(
      '/v1/metrics',
      post(
        '/v1/metrics',
        { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/x-protobuf' },
        body,
      ),
    );
    expect(response.status).toBe(200);
    expect(collector).toHaveBeenCalledOnce();
    const [url, init] = collector.mock.calls[0]!;
    expect(url).toBe('http://collector:4318/v1/metrics');
    const headers = new Headers(init?.headers);
    expect(headers.get(WORKSPACE_HEADER)).toBe(WORKSPACE_A);
    expect(headers.get('content-type')).toBe('application/x-protobuf');
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(body);
  });

  it('a sender cannot choose the workspace or pass its key on to the collector', async () => {
    const { app, collector } = setup();
    await app.request(
      '/v1/metrics',
      post('/v1/metrics', {
        authorization: `Bearer ${KEY_A}`,
        [WORKSPACE_HEADER]: 'someone-else',
        'x-forwarded-for': '10.0.0.1',
      }),
    );
    const headers = new Headers(collector.mock.calls[0]![1]?.headers);
    expect(headers.get(WORKSPACE_HEADER)).toBe(WORKSPACE_A);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
  });

  it('refuses a body over the size limit', async () => {
    const { app, collector } = setup();
    const response = await app.request(
      '/v1/metrics',
      post('/v1/metrics', { authorization: `Bearer ${KEY_A}` }, 'x'.repeat(2000)),
    );
    expect(response.status).toBe(413);
    expect(collector).not.toHaveBeenCalled();
  });

  it('answers 503 when the collector cannot be reached', async () => {
    const { app } = setup({
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    const response = await app.request(
      '/v1/metrics',
      post('/v1/metrics', { authorization: `Bearer ${KEY_A}` }),
    );
    expect(response.status).toBe(503);
  });
});

describe('POST /v1/manifests', () => {
  it('needs a key', async () => {
    const { app, registerManifest } = setup();
    expect((await app.request('/v1/manifests', post('/v1/manifests', {}))).status).toBe(401);
    expect(registerManifest).not.toHaveBeenCalled();
  });

  it('registers YAML text and JSON under the workspace of the key', async () => {
    const { app, registerManifest } = setup();
    const auth = { authorization: `Bearer ${KEY_A}` };
    await app.request('/v1/manifests', post('/v1/manifests', auth, 'service: checkout'));
    await app.request(
      '/v1/manifests',
      post('/v1/manifests', { ...auth, 'content-type': 'application/json' }, '{"service":"x"}'),
    );
    expect(registerManifest.mock.calls).toEqual([
      [WORKSPACE_A, 'service: checkout'],
      [WORKSPACE_A, { service: 'x' }],
    ]);
  });

  it('answers 422 with the problems when the manifest is invalid', async () => {
    const invalid = Object.assign(new Error('Invalid service manifest: service: required'), {
      name: 'SpecValidationError',
      issues: [{ path: 'service', message: 'required' }],
    });
    const { app } = setup({
      registerManifest: async () => {
        throw invalid;
      },
    });
    const response = await app.request(
      '/v1/manifests',
      post('/v1/manifests', { authorization: `Bearer ${KEY_A}` }, 'nope'),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ issues: [{ path: 'service' }] });
  });
});
