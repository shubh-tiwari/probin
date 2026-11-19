// Checkout service: cart summary, payment and order lookup.
'use strict';

const express = require('express');
const { metrics } = require('@opentelemetry/api');

const PAYMENT_METHODS = ['card', 'wallet', 'bank_transfer'];
const INVENTORY_URL = process.env.INVENTORY_URL;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A latency in milliseconds: usually near `typical`, occasionally several times slower. */
const latency = (typical, slowChance, slowFactor) =>
  typical * (0.6 + Math.random() * 0.8) * (Math.random() < slowChance ? slowFactor : 1);

const orders = new Map();
let nextOrder = 1000;

// Business metric for Probin. Listed in probin.yaml; keep the two in step.
const ordersCompleted = metrics.getMeter('checkout').createCounter('orders.completed', {
  unit: '{order}',
  description: 'Orders paid successfully',
});

const app = express();
app.use(express.json());

// Charges the customer and creates the order. Slow: it talks to a payment
// provider, and reserves stock first when an inventory service is configured.
app.post('/checkout/pay', async (req, res) => {
  const method = PAYMENT_METHODS.includes(req.body?.payment_method)
    ? req.body.payment_method
    : 'card';

  if (INVENTORY_URL) {
    try {
      const reserved = await fetch(`${INVENTORY_URL}/inventory/reserve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item_id: req.body?.item_id ?? 'sku-1', quantity: 1 }),
      });
      if (!reserved.ok) {
        res.status(409).json({ error: 'item is out of stock' });
        return;
      }
    } catch {
      res.status(502).json({ error: 'inventory service unavailable' });
      return;
    }
  }

  await sleep(latency(180, 0.08, 5));
  if (Math.random() < 0.02) {
    res.status(502).json({ error: 'payment provider unavailable' });
    return;
  }

  const id = String(nextOrder++);
  orders.set(id, { id, status: 'paid', payment_method: method, total: 4200, currency: 'INR' });
  if (orders.size > 500) orders.delete(orders.keys().next().value);
  ordersCompleted.add(1, { 'payment.method': method }); // method is one of PAYMENT_METHODS
  res.status(201).json(orders.get(id));
});

// Returns the order summary before payment.
app.get('/checkout/summary', async (_req, res) => {
  await sleep(latency(25, 0.02, 4));
  res.json({ items: 3, total: 4200, currency: 'INR' });
});

// Returns one order.
app.get('/checkout/orders/:id', async (req, res) => {
  await sleep(latency(12, 0.01, 6));
  const order = orders.get(req.params.id);
  if (!order) {
    res.status(404).json({ error: 'no such order' });
    return;
  }
  res.json(order);
});

const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, () => {
  console.log(`checkout listening on :${port}`);
});

process.on('SIGTERM', () => server.close());
