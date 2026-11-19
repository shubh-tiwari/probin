/**
 * A fake Stripe, for local development and tests. NOT part of the product.
 *
 * It answers the few API calls billing makes (customers, checkout sessions,
 * subscriptions, invoices) with Stripe's shapes, and plays the customer: the
 * checkout page it hands out "pays" at once, then sends the same webhooks
 * Stripe would, signed with the webhook secret.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

/** Stripe's form encoding: `line_items[0][price]=x` into nested objects and arrays. */
export function parseStripeForm(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const path = key.replace(/\]/g, '').split('[');
    let node: Record<string, unknown> = root;
    path.forEach((part, index) => {
      if (index === path.length - 1) {
        node[part] = value;
      } else {
        node[part] ??= /^\d+$/.test(path[index + 1]!) ? [] : {};
        node = node[part] as Record<string, unknown>;
      }
    });
  }
  return root;
}

export function createFakeStripe(options: {
  secretKey: string;
  webhookSecret: string;
  webhookUrl: string;
  publicUrl: string;
}) {
  const customers = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const invoices: Record<string, unknown>[] = [];
  const app = new Hono();

  const authorised = (header: string | undefined) => header === `Bearer ${options.secretKey}`;

  async function webhook(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({
      id: id('evt'),
      object: 'event',
      type,
      created: now(),
      data: { object },
      livemode: false,
      api_version: '2025-01-01',
    });
    const t = now();
    const signature = createHmac('sha256', options.webhookSecret)
      .update(`${t}.${payload}`)
      .digest('hex');
    const response = await fetch(options.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${signature}` },
      body: payload,
    }).catch(() => undefined);
    return response?.status;
  }

  app.use('/v1/*', async (c, next) => {
    if (!authorised(c.req.header('authorization'))) {
      return c.json(
        { error: { type: 'invalid_request_error', message: 'Invalid API Key provided.' } },
        401,
      );
    }
    await next();
  });

  app.post('/v1/customers', async (c) => {
    const body = parseStripeForm(await c.req.text());
    const customer = {
      id: id('cus'),
      object: 'customer',
      email: body.email ?? null,
      name: body.name ?? null,
      metadata: body.metadata ?? {},
      created: now(),
    };
    customers.set(customer.id, customer);
    return c.json(customer);
  });

  app.post('/v1/checkout/sessions', async (c) => {
    const body = parseStripeForm(await c.req.text());
    const session = {
      id: id('cs_test'),
      object: 'checkout.session',
      mode: body.mode,
      customer: body.customer,
      client_reference_id: body.client_reference_id ?? null,
      success_url: body.success_url,
      cancel_url: body.cancel_url,
      line_items: body.line_items,
      metadata: body.metadata ?? {},
      status: 'open',
      payment_status: 'unpaid',
      subscription: null as string | null,
      url: '',
    };
    session.url = `${options.publicUrl}/fake/checkout/${session.id}`;
    sessions.set(session.id, session);
    return c.json(session);
  });

  /** The checkout page: pays at once, as a customer with a working test card would. */
  app.get('/fake/checkout/:id', async (c) => {
    const session = sessions.get(c.req.param('id'));
    if (!session || session.status !== 'open') return c.text('This checkout has expired.', 404);
    const price =
      (session.line_items as { price: string }[] | undefined)?.[0]?.price ?? 'price_unknown';
    const periodEnd = now() + 30 * 86_400;
    const subscription = {
      id: id('sub'),
      object: 'subscription',
      customer: session.customer,
      status: 'active',
      metadata: session.metadata,
      items: {
        object: 'list',
        data: [
          {
            id: id('si'),
            price: { id: price },
            current_period_start: now(),
            current_period_end: periodEnd,
          },
        ],
      },
      current_period_end: periodEnd,
      cancel_at_period_end: false,
    };
    subscriptions.set(subscription.id, subscription);
    session.status = 'complete';
    session.payment_status = 'paid';
    session.subscription = subscription.id;
    const invoice = {
      id: id('in'),
      object: 'invoice',
      customer: session.customer,
      subscription: subscription.id,
      status: 'paid',
      amount_paid: 0,
      currency: 'usd',
      created: now(),
      number: `FAKE-${String(invoices.length + 1).padStart(4, '0')}`,
      hosted_invoice_url: `${options.publicUrl}/fake/invoices/${invoices.length + 1}`,
    };
    invoices.push(invoice);
    await webhook('checkout.session.completed', session);
    await webhook('invoice.paid', invoice);
    return c.redirect(
      String(session.success_url).replace('{CHECKOUT_SESSION_ID}', String(session.id)),
      302,
    );
  });

  app.get('/v1/subscriptions/:id', (c) => {
    const subscription = subscriptions.get(c.req.param('id'));
    return subscription
      ? c.json(subscription)
      : c.json({ error: { type: 'invalid_request_error', message: 'No such subscription' } }, 404);
  });

  app.delete('/v1/subscriptions/:id', async (c) => {
    const subscription = subscriptions.get(c.req.param('id'));
    if (!subscription)
      return c.json(
        { error: { type: 'invalid_request_error', message: 'No such subscription' } },
        404,
      );
    subscription.status = 'canceled';
    subscription.canceled_at = now();
    await webhook('customer.subscription.deleted', subscription);
    return c.json(subscription);
  });

  app.get('/v1/invoices', (c) => {
    const customer = c.req.query('customer');
    const data = invoices.filter((invoice) => !customer || invoice.customer === customer);
    return c.json({ object: 'list', data, has_more: false, url: '/v1/invoices' });
  });

  app.get('/fake/invoices/:n', (c) =>
    c.text(`Invoice ${c.req.param('n')} (fake, test mode): paid.`),
  );
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return { app };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const { app } = createFakeStripe({
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    webhookUrl: required('STRIPE_WEBHOOK_URL'),
    publicUrl: required('FAKE_PUBLIC_URL'),
  });
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
  console.log('fake Stripe listening');
}
