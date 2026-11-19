import { z } from 'zod';

export const METRICS_STORE_TYPES = ['victoriametrics', 'prometheus'] as const;
export type MetricsStoreType = (typeof METRICS_STORE_TYPES)[number];

const httpUrl = z
  .string()
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
    message: 'must be an http(s) URL',
  })
  .transform((value) => value.replace(/\/+$/, ''));

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * Every environment variable the platform reads. Services ask for the subset
 * they need with `loadEnv`, so a service never fails on a variable it does not use.
 */
export const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), { message: 'must be a postgres:// URL' }),
  /** Which Prometheus-compatible store is behind METRICS_STORE_URL. */
  METRICS_STORE_TYPE: z.enum(METRICS_STORE_TYPES).default('victoriametrics'),
  /** Base URL of the store's Prometheus-compatible query API. */
  METRICS_STORE_URL: httpUrl,
  /**
   * The public ingestion endpoint: services send OTLP over HTTP to
   * `<INGEST_URL>/v1/metrics` and register manifests at `<INGEST_URL>/v1/manifests`.
   */
  INGEST_URL: httpUrl,
  /** The collector behind the ingestion endpoint. Private: only the ingestion service calls it. */
  COLLECTOR_URL: httpUrl,
  /** Largest OTLP request body the ingestion endpoint accepts. */
  INGEST_MAX_BODY_BYTES: positiveInt.default(4 * 1024 * 1024),

  /** The Query API: the only service that talks to the metrics store. */
  QUERY_API_URL: httpUrl,
  /** Longest a single query may run. */
  QUERY_TIMEOUT_MS: positiveInt.default(10_000),
  /** Line cap: the most series one query may return. */
  QUERY_MAX_LINES: positiveInt.default(50),
  /** How long a query result is reused. About the dashboard refresh interval. */
  QUERY_CACHE_TTL_SECONDS: nonNegativeInt.default(15),

  /** The agent service. */
  AGENT_URL: httpUrl,
  /** The range a new dashboard gets, and the range a query is tested over when the request gave none. */
  DEFAULT_DASHBOARD_RANGE: z
    .string()
    .regex(/^[1-9][0-9]*(m|h|d|w)$/, 'must be a duration such as 6h')
    .default('6h'),

  /** Slack app credentials, from the app's settings page. */
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  /** Slack's Web API. Points at the local fake in development. */
  SLACK_API_URL: httpUrl.default('https://slack.com/api'),
  /** Where people are sent to approve the install. Points at the local fake in development. */
  SLACK_AUTHORIZE_URL: httpUrl.default('https://slack.com/oauth/v2/authorize'),
  /** This Slack service's public address, for the install redirect. */
  SLACK_PUBLIC_URL: httpUrl,
  /** The web tool's public address, for "Open in web" links. */
  WEB_URL: httpUrl,
  /** Where people are sent to sign in with Slack. Points at the local fake in development. */
  SLACK_OPENID_AUTHORIZE_URL: httpUrl.default('https://slack.com/openid/connect/authorize'),

  /**
   * Encrypts secrets stored in the database (Slack bot tokens). 32 random
   * bytes, base64. Losing it means every workspace must reinstall.
   */
  SECRETS_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'must be 32 random bytes, base64-encoded',
  }),

  /** Stripe. Without a secret key, billing pages say billing is not set up. */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Stripe's API. Points at the local fake in development. */
  STRIPE_API_URL: httpUrl.default('https://api.stripe.com'),
  /** Overrides the plans file's grace period, in seconds. For development and tests only. */
  DELETION_GRACE_SECONDS: nonNegativeInt.optional(),

  /** The GitHub App, for Review. The private key is read from a file and is a secret. */
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  /** GitHub's API. Points at the local fake in development. */
  GITHUB_API_URL: httpUrl.default('https://api.github.com'),
  /** Where people install the GitHub App. Points at the local fake in development. */
  GITHUB_APP_INSTALL_URL: httpUrl,
  /** The Review service. */
  REVIEW_URL: httpUrl,
  /** How far back Review reads numbers. */
  REVIEW_WINDOW: z
    .string()
    .regex(/^[1-9][0-9]*(m|h|d)$/)
    .default('24h'),
  /** How long before and after a deploy Review compares. */
  REVIEW_DEPLOY_WINDOW: z
    .string()
    .regex(/^[1-9][0-9]*(s|m|h)$/)
    .default('30m'),

  /** Shared secret for calls between our own services. Never sent to customers or the model. */
  INTERNAL_API_TOKEN: z.string().min(16, 'must be at least 16 characters'),

  /** Path to the YAML file holding plans, limits and prices. */
  PLANS_FILE: z.string().min(1),
  /** Path to the YAML file mapping task types to model tiers and models. */
  MODELS_FILE: z.string().min(1),
  /** Unset means no model calls can be made; building features report that clearly. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  /**
   * Let collectors fetch private network addresses. Only for local development,
   * where the demo services are on a private network. Never in production.
   */
  COLLECTOR_ALLOW_PRIVATE_NETWORKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** How often the alert engine evaluates active rules. */
  ALERT_EVAL_SECONDS: positiveInt.default(15),

  /** The port a service listens on. */
  PORT: positiveInt,

  /** Local development only: the workspace and ingestion key `make dev` seeds. */
  DEV_WORKSPACE_ID: z.uuid(),
  DEV_INGESTION_KEY: z.string().min(16, 'must be at least 16 characters'),
});

export type Env = z.infer<typeof envSchema>;
export type EnvKey = keyof Env;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Read and validate the named variables.
 *
 * @example const { DATABASE_URL } = loadEnv(['DATABASE_URL']);
 */
export function loadEnv<K extends EnvKey>(
  keys: readonly K[],
  source: Record<string, string | undefined> = process.env,
): Pick<Env, K> {
  const result: Partial<Env> = {};
  const problems: string[] = [];
  for (const key of keys) {
    const raw = source[key];
    const parsed = envSchema.shape[key].safeParse(raw === '' ? undefined : raw);
    if (parsed.success) {
      (result as Record<string, unknown>)[key] = parsed.data;
    } else {
      const reason =
        raw === undefined || raw === '' ? 'is not set' : parsed.error.issues[0]?.message;
      problems.push(`${key} ${reason}`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid environment: ${problems.join('; ')}`);
  }
  return result as Pick<Env, K>;
}
