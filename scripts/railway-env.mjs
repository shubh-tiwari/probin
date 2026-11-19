/**
 * Writes the Railway variables for every service, ready to paste into each
 * service's Variables → Raw Editor.
 *
 *   pnpm railway:env demo   a public demo: fake Slack, GitHub and Stripe, demo services, live data
 *   pnpm railway:env real   the product with real Slack, GitHub and Stripe apps
 *
 * Output goes to .railway/<setup>/ (git-ignored): one <service>.env per service,
 * and services.md listing what to create. Secrets are generated once per setup
 * and kept in .railway/<setup>/secrets.env, so running this again gives the
 * same values. The real setup also reads .railway/real/inputs.env, the values
 * from your Slack, GitHub and Stripe apps.
 *
 * The service names below must match the names in Railway exactly: the
 * variables refer to each other through Railway's private network
 * (<name>.railway.internal) and reference variables (${{<name>.RAILWAY_PUBLIC_DOMAIN}}).
 *
 * No dependencies: plain Node.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const setup = process.argv[2];
if (setup !== 'demo' && setup !== 'real') {
  console.error('Usage: pnpm railway:env demo|real');
  process.exit(64);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = `${root}.railway/${setup}`;
mkdirSync(dir, { recursive: true });

/** KEY=value lines, ignoring blanks and comments. */
const readEnv = (path) =>
  Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
const writeEnv = (path, values, header = '') =>
  writeFileSync(
    path,
    header +
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') +
      '\n',
    { mode: 0o600 },
  );

// Secrets: generated once, then reused.
const secretsPath = `${dir}/secrets.env`;
if (!existsSync(secretsPath)) {
  const token = () => randomBytes(24).toString('base64url');
  const secrets = {
    INTERNAL_API_TOKEN: token(),
    SECRETS_KEY: randomBytes(32).toString('base64'),
  };
  if (setup === 'demo') {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    Object.assign(secrets, {
      DEV_WORKSPACE_ID: randomUUID(),
      DEV_INGESTION_KEY: token(),
      SLACK_SIGNING_SECRET: token(),
      SLACK_CLIENT_ID: `demo-${token().slice(0, 12)}`,
      SLACK_CLIENT_SECRET: token(),
      STRIPE_SECRET_KEY: `sk_test_demo_${token()}`,
      STRIPE_WEBHOOK_SECRET: `whsec_demo_${token()}`,
      GITHUB_APP_ID: '1',
      GITHUB_WEBHOOK_SECRET: token(),
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
    });
  }
  writeEnv(secretsPath, secrets, '# Generated secrets for this Railway setup. Never commit.\n');
}
const secrets = readEnv(secretsPath);

// The real setup's values from your Slack, GitHub and Stripe apps.
const REAL_INPUTS = {
  SLACK_SIGNING_SECRET: 'Slack app → Basic Information → Signing Secret',
  SLACK_CLIENT_ID: 'Slack app → Basic Information → Client ID',
  SLACK_CLIENT_SECRET: 'Slack app → Basic Information → Client Secret',
  STRIPE_SECRET_KEY: 'Stripe → Developers → API keys → Secret key (sk_test_... or sk_live_...)',
  STRIPE_WEBHOOK_SECRET: 'Stripe → Developers → Webhooks → your endpoint → Signing secret',
  GITHUB_APP_ID: 'GitHub App settings → App ID',
  GITHUB_APP_SLUG: 'The name in your GitHub App URL: github.com/apps/<this>',
  GITHUB_WEBHOOK_SECRET: 'The webhook secret you chose for the GitHub App',
  GITHUB_APP_PRIVATE_KEY_PATH: 'Path to the .pem file GitHub gave you (it is read, not copied)',
  PLANS_FILE: 'A plans file in the repository with your real Stripe price id',
  OPENROUTER_API_KEY: 'Optional. Leave empty to use the built-in stand-in instead of models',
};
let inputs = {};
if (setup === 'real') {
  const inputsPath = `${dir}/inputs.env`;
  if (!existsSync(inputsPath)) {
    writeFileSync(
      inputsPath,
      '# Fill these in, then run `pnpm railway:env real` again. Never commit this file.\n' +
        Object.entries(REAL_INPUTS)
          .map(
            ([key, help]) => `# ${help}\n${key}=${key === 'PLANS_FILE' ? 'config/plans.yaml' : ''}`,
          )
          .join('\n\n') +
        '\n',
      { mode: 0o600 },
    );
    console.log(`Created ${inputsPath}. Fill it in, then run this again.`);
    process.exit(1);
  }
  inputs = readEnv(inputsPath);
  const missing = Object.keys(REAL_INPUTS).filter(
    (key) => key !== 'OPENROUTER_API_KEY' && !inputs[key],
  );
  if (missing.length) {
    console.error(`Fill these in ${inputsPath} first: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!existsSync(`${root}${inputs.PLANS_FILE}`)) {
    console.error(`PLANS_FILE ${inputs.PLANS_FILE} does not exist in the repository.`);
    process.exit(1);
  }
  inputs.GITHUB_APP_PRIVATE_KEY_BASE64 = readFileSync(inputs.GITHUB_APP_PRIVATE_KEY_PATH).toString(
    'base64',
  );
}

const demo = setup === 'demo';
const internal = (service, port = 8080) => `http://${service}.railway.internal:${port}`;
const publicUrl = (service) => `https://\${{${service}.RAILWAY_PUBLIC_DOMAIN}}`;
const pick = (source, ...keys) => Object.fromEntries(keys.map((key) => [key, source[key]]));
const s = { ...secrets, ...inputs };

const APP_IMAGE = 'infra/docker/app.Dockerfile';
const app = (name, variables) => ({
  RAILWAY_DOCKERFILE_PATH: APP_IMAGE,
  APP: name,
  PORT: '8080',
  ...variables,
});
const common = {
  DATABASE_URL: '${{Postgres.DATABASE_URL}}',
  INTERNAL_API_TOKEN: s.INTERNAL_API_TOKEN,
  QUERY_API_URL: internal('query-api'),
};
const plans = demo ? 'config/plans.example.yaml' : inputs.PLANS_FILE;
const slackApi = demo ? `${internal('slack-fake')}/api` : 'https://slack.com/api';
const otel = (service) => ({
  OTEL_SERVICE_NAME: service,
  OTEL_EXPORTER_OTLP_ENDPOINT: internal('ingest'),
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${s.DEV_INGESTION_KEY}`,
  OTEL_METRIC_EXPORT_INTERVAL: '15000',
});

/** Every service: its variables, whether it needs a public domain, and notes. */
const services = {
  'metrics-store': {
    vars: { RAILWAY_DOCKERFILE_PATH: 'infra/railway/metrics-store.Dockerfile' },
    note: 'Add a volume mounted at /storage.',
  },
  'otel-collector': {
    vars: {
      RAILWAY_DOCKERFILE_PATH: 'infra/railway/otel-collector.Dockerfile',
      METRICS_STORE_REMOTE_WRITE_URL: `${internal('metrics-store', 8428)}/api/v1/write`,
      OTLP_HTTP_ENDPOINT: '[::]:4318',
    },
  },
  'query-api': {
    vars: app('query-api', {
      ...common,
      METRICS_STORE_URL: internal('metrics-store', 8428),
      METRICS_STORE_TYPE: 'victoriametrics',
      QUERY_TIMEOUT_MS: '10000',
      QUERY_MAX_LINES: '50',
      QUERY_CACHE_TTL_SECONDS: '15',
      PLANS_FILE: plans,
      SECRETS_KEY: s.SECRETS_KEY,
    }),
  },
  ingest: {
    public: true,
    vars: app('ingest', {
      ...common,
      COLLECTOR_URL: internal('otel-collector', 4318),
      COLLECTOR_ALLOW_PRIVATE_NETWORKS: 'false',
      // Migrations run here, before the service starts. Other services restart until they are applied.
      RUN_MIGRATIONS: 'true',
      ...(demo
        ? {
            RUN_DEMO_SEED: 'true',
            INGEST_URL: publicUrl('ingest'),
            PLANS_FILE: plans,
            SECRETS_KEY: s.SECRETS_KEY,
            ...pick(s, 'DEV_WORKSPACE_ID', 'DEV_INGESTION_KEY'),
          }
        : {}),
    }),
    note: 'Public: services send metrics here. It also applies database migrations on start.',
  },
  agent: {
    vars: app('agent', {
      ...common,
      PLANS_FILE: plans,
      MODELS_FILE: 'config/models.example.yaml',
      ...(s.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: s.OPENROUTER_API_KEY } : {}),
      COLLECTOR_ALLOW_PRIVATE_NETWORKS: 'false',
      DEFAULT_DASHBOARD_RANGE: '6h',
    }),
  },
  slack: {
    public: true,
    vars: app('slack', {
      ...common,
      ...pick(s, 'SLACK_SIGNING_SECRET', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SECRETS_KEY'),
      SLACK_API_URL: slackApi,
      SLACK_AUTHORIZE_URL: demo
        ? `${publicUrl('slack-fake')}/oauth/v2/authorize`
        : 'https://slack.com/oauth/v2/authorize',
      SLACK_PUBLIC_URL: publicUrl('slack'),
      WEB_URL: publicUrl('web'),
      INGEST_URL: publicUrl('ingest'),
      AGENT_URL: internal('agent'),
      PLANS_FILE: plans,
      DEFAULT_DASHBOARD_RANGE: '6h',
    }),
    note: demo
      ? 'Public: the install page. The fake Slack sends it events over the private network.'
      : 'Public: Slack sends events and button clicks here, and people install the app here.',
  },
  alerts: {
    vars: app('alerts', {
      ...common,
      SLACK_API_URL: slackApi,
      SECRETS_KEY: s.SECRETS_KEY,
      ALERT_EVAL_SECONDS: '15',
    }),
  },
  web: {
    public: true,
    vars: app('web', {
      ...common,
      SECRETS_KEY: s.SECRETS_KEY,
      WEB_URL: publicUrl('web'),
      AGENT_URL: internal('agent'),
      DEFAULT_DASHBOARD_RANGE: '6h',
      ...pick(
        s,
        'SLACK_CLIENT_ID',
        'SLACK_CLIENT_SECRET',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
      ),
      SLACK_API_URL: slackApi,
      SLACK_OPENID_AUTHORIZE_URL: demo
        ? `${publicUrl('slack-fake')}/openid/connect/authorize`
        : 'https://slack.com/openid/connect/authorize',
      COLLECTOR_ALLOW_PRIVATE_NETWORKS: 'false',
      PLANS_FILE: plans,
      STRIPE_API_URL: demo ? internal('stripe-fake') : 'https://api.stripe.com',
      GITHUB_APP_INSTALL_URL: demo
        ? `${publicUrl('github-fake')}/fake/install`
        : `https://github.com/apps/${inputs.GITHUB_APP_SLUG}/installations/new`,
      REVIEW_URL: internal('review'),
    }),
    note: 'Public: the web tool. Open this address to use the product.',
  },
  review: {
    public: !demo,
    vars: app('review', {
      ...common,
      WEB_URL: publicUrl('web'),
      SLACK_API_URL: slackApi,
      ...pick(
        s,
        'SECRETS_KEY',
        'GITHUB_APP_ID',
        'GITHUB_WEBHOOK_SECRET',
        'GITHUB_APP_PRIVATE_KEY_BASE64',
      ),
      GITHUB_API_URL: demo ? internal('github-fake') : 'https://api.github.com',
      REVIEW_WINDOW: '24h',
      REVIEW_DEPLOY_WINDOW: demo ? '10m' : '30m',
    }),
    note: demo ? undefined : 'Public: GitHub sends webhooks to <this address>/github/webhook.',
  },
};

if (demo) {
  Object.assign(services, {
    'slack-fake': {
      public: true,
      vars: app('slack-fake', {
        ...pick(s, 'SLACK_SIGNING_SECRET', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'),
        SLACK_APP_URL: internal('slack'),
        FAKE_INTERNAL_URL: internal('slack-fake'),
        FAKE_PUBLIC_URL: publicUrl('slack-fake'),
      }),
      note: 'Public: the stand-in Slack sign-in page, and the endpoints that act as people.',
    },
    'stripe-fake': {
      public: true,
      vars: app('stripe-fake', {
        ...pick(s, 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'),
        STRIPE_WEBHOOK_URL: `${internal('web')}/billing/webhook`,
        FAKE_PUBLIC_URL: publicUrl('stripe-fake'),
      }),
      note: 'Public: the stand-in checkout page.',
    },
    'github-fake': {
      public: true,
      vars: app('github-fake', {
        ...pick(s, 'GITHUB_APP_ID', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY_BASE64'),
        GITHUB_WEBHOOK_URL: `${internal('review')}/github/webhook`,
        GITHUB_SETUP_URL: `${publicUrl('web')}/github/setup`,
        DEMO_ROOT: '/repo/infra/demo',
      }),
      note: 'Public: the stand-in "install the GitHub App" page.',
    },
    'demo-inventory': {
      vars: {
        RAILWAY_DOCKERFILE_PATH: 'infra/railway/demo-inventory.Dockerfile',
        PORT: '8080',
        HOST: '::',
        ...otel('inventory'),
      },
    },
    'demo-checkout': {
      vars: {
        RAILWAY_DOCKERFILE_PATH: 'infra/railway/demo-checkout.Dockerfile',
        PORT: '8080',
        INVENTORY_URL: internal('demo-inventory'),
        ...otel('checkout'),
      },
    },
    'demo-loadgen': {
      vars: {
        RAILWAY_DOCKERFILE_PATH: 'infra/railway/demo-loadgen.Dockerfile',
        CHECKOUT_URL: internal('demo-checkout'),
        INVENTORY_URL: internal('demo-inventory'),
      },
    },
  });
}

for (const [name, service] of Object.entries(services)) {
  writeEnv(`${dir}/${name}.env`, service.vars);
}

const rows = Object.entries(services).map(
  ([name, service]) => `| \`${name}\` | ${service.public ? 'yes' : 'no'} | ${service.note ?? ''} |`,
);
writeFileSync(
  `${dir}/services.md`,
  `# Railway services: ${setup} setup

Create one Railway project. Add **Postgres** (Database → PostgreSQL; keep the name \`Postgres\`),
then one service per row below, each from this GitHub repository, named exactly as shown.
For each one, open Variables → Raw Editor and paste the matching \`<name>.env\` from this folder.
For rows marked public, open Settings → Networking → Generate Domain (port 8080).

| Service | Public | Notes |
| --- | --- | --- |
${rows.join('\n')}
`,
);

console.log(
  `Wrote ${Object.keys(services).length} services to .railway/${setup}/ (see services.md).`,
);
if (demo) console.log('Secrets are fresh random values in .railway/demo/secrets.env.');
