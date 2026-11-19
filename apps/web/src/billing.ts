import { findPlan, type PlansConfig } from '@app/config';
import { getWorkspace, schema, type Database } from '@app/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import Stripe from 'stripe';

export interface BillingOptions {
  db: Database;
  plans: PlansConfig;
  secretKey?: string;
  webhookSecret?: string;
  apiUrl: string;
  webUrl: string;
  /** Overrides the plans file's grace period. Development and tests only. */
  graceSeconds?: number;
}

export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/**
 * Subscriptions through Stripe (H5). Prices and plan limits come from the
 * plans file; nothing about them is in code. Stripe's webhooks are the only
 * thing that changes a workspace's billing status.
 */
export interface Invoice {
  number: string;
  status: string;
  amount: number;
  currency: string;
  date: Date;
  url: string | null;
}

export interface Billing {
  enabled: boolean;
  checkout(workspaceId: string, email: string | undefined): Promise<string>;
  cancel(workspaceId: string): Promise<void>;
  invoices(workspaceId: string): Promise<Invoice[]>;
  webhook(payload: string, signature: string | undefined): Promise<boolean>;
}

export function createBilling(options: BillingOptions): Billing {
  const url = new URL(options.apiUrl);
  const stripe = options.secretKey
    ? new Stripe(options.secretKey, {
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        protocol: url.protocol === 'https:' ? 'https' : 'http',
        maxNetworkRetries: 1,
      })
    : undefined;
  const graceMs = () =>
    (options.graceSeconds ?? options.plans.cancellation.grace_days * 86_400) * 1000;

  return {
    enabled: Boolean(stripe),

    /** Start a Stripe Checkout for the workspace's plan. Returns the page to send the admin to. */
    async checkout(workspaceId: string, email: string | undefined): Promise<string> {
      if (!stripe) throw new Error('Billing is not set up.');
      const workspace = await getWorkspace(options.db, workspaceId);
      if (!workspace) throw new Error('No such workspace.');
      const plan = findPlan(options.plans, workspace.plan);
      if (!plan?.stripe_price)
        throw new Error(`The plan "${workspace.plan}" cannot be bought online.`);
      let customer = workspace.billingCustomerId;
      if (!customer) {
        customer = (
          await stripe.customers.create({
            ...(email ? { email } : {}),
            name: workspace.name,
            metadata: { workspace: workspaceId },
          })
        ).id;
        await options.db
          .update(schema.workspaces)
          .set({ billingCustomerId: customer })
          .where(eq(schema.workspaces.id, workspaceId));
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: workspaceId,
        line_items: [{ price: plan.stripe_price, quantity: 1 }],
        metadata: { workspace: workspaceId },
        success_url: `${options.webUrl}/billing?notice=Subscribed.`,
        cancel_url: `${options.webUrl}/billing`,
      });
      if (!session.url) throw new Error('Stripe returned no checkout page.');
      return session.url;
    },

    /** Cancel now. Stripe confirms with a webhook, which schedules the data's deletion. */
    async cancel(workspaceId: string): Promise<void> {
      if (!stripe) throw new Error('Billing is not set up.');
      const workspace = await getWorkspace(options.db, workspaceId);
      if (workspace?.billingSubscriptionId) {
        await stripe.subscriptions.cancel(workspace.billingSubscriptionId);
      } else {
        // A trial with no subscription: cancel directly.
        await options.db
          .update(schema.workspaces)
          .set({ billingStatus: 'canceled', deletionScheduledAt: new Date(Date.now() + graceMs()) })
          .where(eq(schema.workspaces.id, workspaceId));
      }
    },

    async invoices(workspaceId: string) {
      if (!stripe) return [];
      const workspace = await getWorkspace(options.db, workspaceId);
      if (!workspace?.billingCustomerId) return [];
      const list = await stripe.invoices.list({ customer: workspace.billingCustomerId, limit: 24 });
      return list.data.map((invoice) => ({
        number: invoice.number ?? invoice.id,
        status: invoice.status ?? 'unknown',
        amount: invoice.amount_paid / 100,
        currency: invoice.currency.toUpperCase(),
        date: new Date(invoice.created * 1000),
        url: invoice.hosted_invoice_url ?? null,
      }));
    },

    /** Verify and apply a Stripe webhook. Returns false when the signature is wrong. */
    async webhook(payload: string, signature: string | undefined): Promise<boolean> {
      if (!stripe || !options.webhookSecret || !signature) return false;
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(payload, signature, options.webhookSecret);
      } catch {
        return false;
      }
      const object = event.data.object as unknown as Record<string, unknown>;
      const set = (
        workspaceId: string | undefined,
        values: Partial<typeof schema.workspaces.$inferInsert>,
      ) =>
        workspaceId
          ? options.db
              .update(schema.workspaces)
              .set(values)
              .where(eq(schema.workspaces.id, workspaceId))
          : undefined;
      const byCustomer = async (customer: unknown) => {
        if (typeof customer !== 'string') return undefined;
        const [row] = await options.db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.billingCustomerId, customer))
          .limit(1);
        return row?.id;
      };
      const periodEnd = (subscription: Record<string, unknown>) => {
        const item = (
          subscription.items as { data?: { current_period_end?: number }[] } | undefined
        )?.data?.[0];
        const end =
          item?.current_period_end ?? (subscription.current_period_end as number | undefined);
        return end ? new Date(end * 1000) : null;
      };
      switch (event.type) {
        case 'checkout.session.completed': {
          const workspaceId =
            (object.client_reference_id as string | null) ?? (await byCustomer(object.customer));
          const subscriptionId =
            typeof object.subscription === 'string' ? object.subscription : undefined;
          const subscription = subscriptionId
            ? await stripe.subscriptions.retrieve(subscriptionId)
            : undefined;
          await set(workspaceId, {
            billingCustomerId: String(object.customer),
            billingSubscriptionId: subscriptionId ?? null,
            billingStatus: 'active',
            currentPeriodEnd: subscription
              ? periodEnd(subscription as unknown as Record<string, unknown>)
              : null,
            deletionScheduledAt: null,
          });
          break;
        }
        case 'customer.subscription.updated': {
          const status = String(object.status);
          await set(await byCustomer(object.customer), {
            billingStatus:
              status === 'active' || status === 'trialing'
                ? 'active'
                : status === 'past_due' || status === 'unpaid'
                  ? 'past_due'
                  : 'canceled',
            currentPeriodEnd: periodEnd(object),
          });
          break;
        }
        case 'customer.subscription.deleted':
          await set(await byCustomer(object.customer), {
            billingStatus: 'canceled',
            deletionScheduledAt: new Date(Date.now() + graceMs()),
          });
          break;
        case 'invoice.paid':
          await set(await byCustomer(object.customer), { billingStatus: 'active' });
          break;
        case 'invoice.payment_failed':
          await set(await byCustomer(object.customer), { billingStatus: 'past_due' });
          break;
        default:
          break;
      }
      return true;
    },
  };
}

/** H6: what the workspace uses this month, against its plan. */
export async function usage(
  db: Database,
  plans: PlansConfig,
  workspaceId: string,
  activeSeries: () => Promise<number>,
) {
  const workspace = await getWorkspace(db, workspaceId);
  const plan = workspace ? findPlan(plans, workspace.plan) : undefined;
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${schema.modelCalls.cost}), 0)` })
    .from(schema.modelCalls)
    .where(
      and(
        eq(schema.modelCalls.workspaceId, workspaceId),
        gte(schema.modelCalls.createdAt, monthStart),
      ),
    );
  const budget =
    workspace?.monthlyModelBudget !== null && workspace?.monthlyModelBudget !== undefined
      ? Number(workspace.monthlyModelBudget)
      : (plan?.limits.model_budget_monthly ?? null);
  return {
    plan,
    currency: plans.currency,
    activeSeries: await activeSeries().catch(() => null),
    seriesLimit: plan?.limits.active_series ?? null,
    modelSpend: Number(row?.spent ?? 0),
    modelBudget: budget,
    retentionDays: plan?.limits.retention_days ?? null,
  };
}
