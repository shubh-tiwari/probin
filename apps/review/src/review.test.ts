import { MANIFEST_FILENAME } from '@app/config';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parsePatch } from './diff.js';
import { appJwt, verifyWebhook } from './github.js';
import { buildIndex, findHandler } from './indexer.js';

const SERVER = `const express = require('express');
const app = express();

app.post('/checkout/pay', async (req, res) => {
  const reserved = await fetch(\`\${INVENTORY_URL}/inventory/reserve\`, { method: 'POST' });
  res.json({ ok: true });
});

app.get('/checkout/orders/:id', async (req, res) => {
  res.json({});
});
`;

const MAIN = `from fastapi import FastAPI
app = FastAPI()

@app.get("/inventory/stock/history")
async def get_stock_history(days: int = 30):
    history = []
    for day in range(days):
        history.append(day)
    return history


@app.post("/inventory/reserve", status_code=201)
async def reserve(reservation: Reservation):
    return {}
`;

const files = new Map([
  ['checkout/server.cjs', SERVER],
  [
    `checkout/${MANIFEST_FILENAME}`,
    'service: checkout\ndescription: d\nendpoints: []\nmetrics: []\n',
  ],
  ['inventory/main.py', MAIN],
  [
    `inventory/${MANIFEST_FILENAME}`,
    'service: inventory\ndescription: d\nendpoints: []\nmetrics: []\n',
  ],
  ['README.md', '# shop'],
]);

describe('the code index', () => {
  const index = buildIndex('abc', files);

  it('finds Express and FastAPI routes, their handlers and services', () => {
    expect(
      index.routes.map((r) => [r.service, r.method, r.route, r.file, r.line, r.span, r.handler]),
    ).toEqual([
      ['checkout', 'POST', '/checkout/pay', 'checkout/server.cjs', 4, [4, 7], null],
      ['checkout', 'GET', '/checkout/orders/:id', 'checkout/server.cjs', 9, [9, 11], null],
      [
        'inventory',
        'GET',
        '/inventory/stock/history',
        'inventory/main.py',
        4,
        [4, 9],
        'get_stock_history',
      ],
      ['inventory', 'POST', '/inventory/reserve', 'inventory/main.py', 12, [12, 14], 'reserve'],
    ]);
  });

  it('records outbound calls a handler makes', () => {
    expect(index.routes[0]!.calls).toEqual(['${INVENTORY_URL}/inventory/reserve']);
  });

  it('links an endpoint from the metrics to its handler, and only on an exact match', () => {
    expect(
      findHandler(index, { service: 'inventory', method: 'GET', route: '/inventory/stock/history' })
        ?.handler,
    ).toBe('get_stock_history');
    expect(
      findHandler(index, { service: 'inventory', method: 'GET', route: '/inventory/stock' }),
    ).toBeUndefined();
    expect(
      findHandler(index, { service: 'checkout', method: 'GET', route: '/inventory/stock/history' }),
    ).toBeUndefined();
  });
});

describe('diffs', () => {
  it('reads added lines and changed line numbers from a patch', () => {
    const patch = '@@ -3,3 +3,4 @@\n line three\n-old four\n+new four\n+new five\n line six';
    const { added, changed } = parsePatch(patch);
    expect(added).toEqual([
      { line: 4, text: 'new four' },
      { line: 5, text: 'new five' },
    ]);
    expect([...changed]).toEqual([4, 5]);
  });
});

describe('GitHub', () => {
  it('signs the app JWT with the private key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJwt('123', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iss: '123' });
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature!, 'base64url')),
    ).toBe(true);
  });

  it('accepts only correctly signed webhooks', async () => {
    const { createHmac } = await import('node:crypto');
    const body = '{"action":"opened"}';
    const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyWebhook(body, good, 's3cret')).toBe(true);
    expect(verifyWebhook(body, good, 'other')).toBe(false);
    expect(verifyWebhook(`${body} `, good, 's3cret')).toBe(false);
    expect(verifyWebhook(body, undefined, 's3cret')).toBe(false);
  });
});
