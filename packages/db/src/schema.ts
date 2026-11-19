/**
 * The database schema: every table in "Data model and formats" of the build plan.
 *
 * Two rules hold for the whole file.
 *
 * 1. Workspace isolation. Every table carries `workspace_id` (the `workspaces`
 *    table is the root, so its `id` is the workspace). It is NOT NULL, it leads
 *    every index, and deleting a workspace deletes its rows.
 * 2. Specs are versioned. Dashboards, panels, alert rules and collectors are
 *    append-only: a change is a new row with the same `id` and the next
 *    `version`, and every row records who or what created it.
 *
 * Keep this file free of relative imports: drizzle-kit reads it directly.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', ['admin', 'member']);

/** Who or what created a row: a person, the agent, or platform code (sync jobs, the alert engine). */
export const actorKind = pgEnum('actor_kind', ['user', 'agent', 'system']);

export const panelType = pgEnum('panel_type', ['timeseries', 'bar', 'stat']);

/**
 * Alert rules and collectors start as pending and do nothing until approved.
 * `disabled`: discarded or switched off; kept for history, never evaluated.
 */
export const approvalStatus = pgEnum('approval_status', ['pending', 'active', 'disabled']);

export const memoryKind = pgEnum('memory_kind', [
  'user_default',
  'team_decision',
  'incident',
  'service_map',
  'review_feedback',
]);

export const findingStatus = pgEnum('finding_status', ['open', 'accepted', 'dismissed']);

// ---------------------------------------------------------------------------
// Shared column sets
// ---------------------------------------------------------------------------

const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** "Stores who or what created it": the kind of actor, and its id (a user id, or a name for agent and system). */
const createdBy = () => ({
  createdByKind: actorKind('created_by_kind').notNull(),
  createdById: text('created_by_id').notNull(),
});

/** Identity of one version of a spec. The primary key is (id, version). */
const versioned = () => ({
  id: uuid('id').notNull().defaultRandom(),
  version: integer('version').notNull().default(1),
  workspaceId: workspaceId(),
});

/** "The approver's name is recorded": set together, and required once a row is active. */
const approval = () => ({
  status: approvalStatus('status').notNull().default('pending'),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** A plan id from the plans file (see @app/config). Never a hard-coded list. */
  plan: text('plan').notNull(),
  /** Workspace settings, e.g. the default Slack channel for alerts. */
  settings: jsonb('settings').notNull().default({}),
  /** Billing, mirrored from the billing provider. */
  billingCustomerId: text('billing_customer_id'),
  billingSubscriptionId: text('billing_subscription_id'),
  /** trialing | active | past_due | canceled. */
  billingStatus: text('billing_status').notNull().default('trialing'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  /** When the workspace's data is deleted after a cancellation. */
  deletionScheduledAt: timestamp('deletion_scheduled_at', { withTimezone: true }),
  /** A hash of the ingestion key. The key itself is never stored. Null until one is issued. */
  ingestionKeyHash: text('ingestion_key_hash').unique(),
  /** Overrides the plan's included model budget. Null means use the plan's. In the plans file's currency. */
  monthlyModelBudget: numeric('monthly_model_budget', { precision: 12, scale: 4 }),
  /** Empty means the hosted store. Otherwise the customer's own store (type and read-only URL). */
  metricsStoreConfig: jsonb('metrics_store_config').notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    slackUserId: text('slack_user_id').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull().default('member'),
    /** The user's saved answers to cross-check questions, e.g. preferred percentile. */
    personalDefaults: jsonb('personal_defaults').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique('users_workspace_slack_user_key').on(t.workspaceId, t.slackUserId),
    // Lets other tables reference a user together with its workspace, so a row
    // can never point at a user from another workspace.
    unique('users_workspace_id_key').on(t.workspaceId, t.id),
  ],
);

// ---------------------------------------------------------------------------
// Specs (versioned, append-only)
// ---------------------------------------------------------------------------

export const dashboards = pgTable(
  'dashboards',
  {
    ...versioned(),
    title: text('title').notNull(),
    layout: jsonb('layout').notNull().default([]),
    panelIds: uuid('panel_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    defaultRange: text('default_range').notNull(),
    ...createdBy(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index('dashboards_workspace_idx').on(t.workspaceId, t.id, t.version),
    check('dashboards_version_positive', sql`${t.version} > 0`),
  ],
);

export const panels = pgTable(
  'panels',
  {
    ...versioned(),
    title: text('title').notNull(),
    type: panelType('type').notNull(),
    query: text('query').notNull(),
    unit: text('unit').notNull(),
    displayUnit: text('display_unit'),
    /** Null means the panel follows its dashboard's range. */
    range: text('range'),
    thresholds: jsonb('thresholds').notNull().default([]),
    /** The original request, word for word. */
    request: text('request').notNull(),
    assumptions: jsonb('assumptions').notNull().default([]),
    ...createdBy(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index('panels_workspace_idx').on(t.workspaceId, t.id, t.version),
    check('panels_version_positive', sql`${t.version} > 0`),
  ],
);

export const alertRules = pgTable(
  'alert_rules',
  {
    ...versioned(),
    name: text('name').notNull(),
    expression: text('expression').notNull(),
    /** The spec's `for`. Required: a rule with no duration is not valid. */
    duration: text('duration').notNull(),
    severity: text('severity').notNull(),
    channel: text('channel').notNull(),
    /** The query the rule watches, before the comparison; for showing and explaining. */
    query: text('query'),
    comparison: jsonb('comparison'),
    unit: text('unit'),
    displayUnit: text('display_unit'),
    service: text('service'),
    request: text('request'),
    assumptions: jsonb('assumptions').notNull().default([]),
    ...approval(),
    ...createdBy(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index('alert_rules_workspace_idx').on(t.workspaceId, t.id, t.version),
    index('alert_rules_workspace_status_idx').on(t.workspaceId, t.status),
    foreignKey({
      name: 'alert_rules_approved_by_fk',
      columns: [t.workspaceId, t.approvedBy],
      foreignColumns: [users.workspaceId, users.id],
    }),
    check('alert_rules_version_positive', sql`${t.version} > 0`),
    // Approval before effect, enforced by the database: a rule cannot be
    // active without a recorded approver, and a pending rule has none.
    check(
      'alert_rules_active_needs_approval',
      sql`(${t.status} = 'active') = (${t.approvedBy} is not null and ${t.approvedAt} is not null)`,
    ),
  ],
);

export const collectors = pgTable(
  'collectors',
  {
    ...versioned(),
    name: text('name').notNull(),
    sourceType: text('source_type').notNull(),
    config: jsonb('config').notNull().default({}),
    interval: text('interval').notNull(),
    metricNames: text('metric_names').array().notNull(),
    ...approval(),
    ...createdBy(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index('collectors_workspace_idx').on(t.workspaceId, t.id, t.version),
    index('collectors_workspace_status_idx').on(t.workspaceId, t.status),
    foreignKey({
      name: 'collectors_approved_by_fk',
      columns: [t.workspaceId, t.approvedBy],
      foreignColumns: [users.workspaceId, users.id],
    }),
    check('collectors_version_positive', sql`${t.version} > 0`),
    check(
      'collectors_active_needs_approval',
      sql`(${t.status} = 'active') = (${t.approvedBy} is not null and ${t.approvedAt} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const catalogMetrics = pgTable(
  'catalog_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    service: text('service').notNull(),
    /** The OpenTelemetry name, e.g. `http.server.request.duration`. */
    metricName: text('metric_name').notNull(),
    /** The name in the metrics store, e.g. `http_server_request_duration_seconds`. */
    storedName: text('stored_name').notNull(),
    type: text('type').notNull(),
    unit: text('unit').notNull(),
    /** Label names as stored. */
    labels: jsonb('labels').notNull().default([]),
    description: text('description').notNull().default(''),
    lastSeen: timestamp('last_seen', { withTimezone: true }),
  },
  (t) => [unique('catalog_metrics_workspace_key').on(t.workspaceId, t.service, t.metricName)],
);

export const catalogEndpoints = pgTable(
  'catalog_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    service: text('service').notNull(),
    method: text('method').notNull(),
    /** The route template, never a full URL. */
    route: text('route').notNull(),
    description: text('description').notNull().default(''),
    lastSeen: timestamp('last_seen', { withTimezone: true }),
    /** Requests per second and p95 in seconds, refreshed periodically for the endpoint picker. */
    requestRate: doublePrecision('request_rate'),
    p95: doublePrecision('p95'),
    statsRefreshedAt: timestamp('stats_refreshed_at', { withTimezone: true }),
  },
  (t) => [
    unique('catalog_endpoints_workspace_key').on(t.workspaceId, t.service, t.method, t.route),
  ],
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    kind: memoryKind('kind').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    /** Where the entry came from, e.g. a Slack thread or the memory page. */
    source: text('source').notNull(),
    /** The same fact in a form code can read, when code needs it (e.g. a user default). */
    value: jsonb('value'),
    ...createdBy(),
    createdAt: createdAt(),
    lastUsed: timestamp('last_used', { withTimezone: true }),
  },
  (t) => [
    index('memory_entries_workspace_idx').on(t.workspaceId, t.kind, t.subject),
    // The agent may write user_default and incident entries by itself.
    // A team decision needs a person.
    check(
      'memory_entries_team_decision_needs_person',
      sql`${t.kind} <> 'team_decision' or ${t.createdByKind} = 'user'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const reviewFindings = pgTable(
  'review_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    repository: text('repository').notNull(),
    /** A finding belongs to a pull request or to a report, never both. */
    pullRequest: integer('pull_request'),
    reportId: uuid('report_id'),
    kind: text('kind').notNull(),
    /** The metric and time window the finding rests on. Required: show the work. */
    evidence: jsonb('evidence').notNull(),
    status: findingStatus('status').notNull().default('open'),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    /** Where in the code, when the finding is about a place in it. */
    path: text('path'),
    line: integer('line'),
    commit: text('commit'),
    service: text('service'),
    route: text('route'),
    /** The comment posted for it on GitHub, if any. */
    externalRef: jsonb('external_ref'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('review_findings_workspace_idx').on(t.workspaceId, t.repository, t.status),
    check('review_findings_one_origin', sql`(${t.pullRequest} is null) <> (${t.reportId} is null)`),
  ],
);

// ---------------------------------------------------------------------------
// Model usage
// ---------------------------------------------------------------------------

export const modelCalls = pgTable(
  'model_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** Groups every call made for one user request. */
    requestId: text('request_id').notNull(),
    /** What the call was for: parse, ask, write_query, explain or review. */
    taskType: text('task_type').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** In the plans file's currency, so it can be summed against the workspace budget. */
    cost: numeric('cost', { precision: 12, scale: 6 }).notNull().default('0'),
    outcome: text('outcome').notNull(),
    /** The earlier call this one escalated from, when the router moved to a stronger model. */
    escalatedFrom: uuid('escalated_from'),
    createdAt: createdAt(),
  },
  (t) => [
    index('model_calls_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('model_calls_workspace_request_idx').on(t.workspaceId, t.requestId),
    foreignKey({
      name: 'model_calls_escalated_from_fk',
      columns: [t.escalatedFrom],
      foreignColumns: [t.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * A request to the agent, kept so a person can answer its questions later, in
 * a Slack thread or the web tool. `state` is the agent's plain-data record.
 */
export const agentRequests = pgTable(
  'agent_requests',
  {
    id: uuid('id').primaryKey(),
    workspaceId: workspaceId(),
    /** The person who asked: a users.id. */
    userId: text('user_id').notNull(),
    status: text('status').notNull(),
    state: jsonb('state').notNull(),
    /** Where the conversation happens, e.g. a Slack channel and thread. */
    surface: jsonb('surface').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_requests_workspace_idx').on(t.workspaceId, t.updatedAt)],
);

/**
 * Resolved requests: a request already turned into a tested query, so the
 * same words later reuse the query without calling a model. An entry is
 * used only while the catalog of the services it reads is unchanged.
 */
export const resolvedRequests = pgTable(
  'resolved_requests',
  {
    workspaceId: workspaceId(),
    /** The request text, normalised. */
    key: text('key').notNull(),
    /** The panel spec, decisions and the services it reads. */
    value: jsonb('value').notNull(),
    /** The catalog of those services when the entry was written. */
    catalogFingerprint: text('catalog_fingerprint').notNull(),
    hits: integer('hits').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/** A Slack workspace that installed the app. One per product workspace. */
export const slackInstallations = pgTable('slack_installations', {
  workspaceId: workspaceId().primaryKey(),
  teamId: text('team_id').notNull().unique(),
  teamName: text('team_name').notNull(),
  botUserId: text('bot_user_id').notNull(),
  /** The bot token, encrypted with SECRETS_KEY. Never stored in clear. */
  botTokenEncrypted: text('bot_token_encrypted').notNull(),
  installedBy: uuid('installed_by'),
  installedAt: createdAt(),
});

/** What the alert engine knows about each active rule between evaluations. */
export const alertStates = pgTable(
  'alert_states',
  {
    ruleId: uuid('rule_id').primaryKey(),
    workspaceId: workspaceId(),
    /** inactive | pending (true, not yet for long enough) | firing */
    state: text('state').notNull().default('inactive'),
    since: timestamp('since', { withTimezone: true }),
    value: doublePrecision('value'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    /** Where the firing message was posted, so updates go to its thread. */
    notification: jsonb('notification'),
    /** The memory entry recording this incident. */
    incidentId: uuid('incident_id'),
  },
  (t) => [index('alert_states_workspace_idx').on(t.workspaceId, t.state)],
);

/** The last run of each approved collector. */
export const collectorStates = pgTable('collector_states', {
  collectorId: uuid('collector_id').primaryKey(),
  workspaceId: workspaceId(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
});

/** A starter dashboard made for a service the first time its data arrived. */
export const starterDashboards = pgTable(
  'starter_dashboards',
  {
    workspaceId: workspaceId(),
    service: text('service').notNull(),
    dashboardId: uuid('dashboard_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.service] })],
);

/** A read-only link to a dashboard. Only the token's hash is stored. */
export const dashboardShares = pgTable(
  'dashboard_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    dashboardId: uuid('dashboard_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('dashboard_shares_workspace_idx').on(t.workspaceId, t.dashboardId)],
);

/** Read-only API tokens: the connector for Claude Code, and Grafana. Only hashes are stored. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_tokens_workspace_idx').on(t.workspaceId)],
);

/** A GitHub App installation, linked to the workspace that connected it. */
export const githubInstallations = pgTable('github_installations', {
  installationId: text('installation_id').primaryKey(),
  workspaceId: workspaceId(),
  account: text('account').notNull(),
  createdAt: createdAt(),
});

/**
 * What Review knows about a repository at a commit: its route definitions,
 * their handlers, and its manifests. Kept until the commit is no longer on a
 * tracked branch.
 */
export const codeIndex = pgTable(
  'code_index',
  {
    workspaceId: workspaceId(),
    repository: text('repository').notNull(),
    commit: text('commit').notNull(),
    index: jsonb('index').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.repository, t.commit] })],
);

/** A Review report: bottlenecks, an architecture review, a pull request, or a deploy follow-up. */
export const reviewReports = pgTable(
  'review_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    repository: text('repository').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** What the report shows beyond its findings, e.g. the service map. */
    body: jsonb('body').notNull().default({}),
    pullRequest: integer('pull_request'),
    createdAt: createdAt(),
  },
  (t) => [index('review_reports_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/** People's comments on the review page, on a report or one finding. */
export const reviewComments = pgTable(
  'review_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    reportId: uuid('report_id').notNull(),
    findingId: uuid('finding_id'),
    userId: uuid('user_id').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('review_comments_report_idx').on(t.workspaceId, t.reportId)],
);

/** Every table, for tests and tooling that must cover the whole schema. */
export const tables = {
  workspaces,
  users,
  dashboards,
  panels,
  alertRules,
  collectors,
  catalogMetrics,
  catalogEndpoints,
  memoryEntries,
  reviewFindings,
  modelCalls,
  agentRequests,
  slackInstallations,
  resolvedRequests,
  alertStates,
  collectorStates,
  starterDashboards,
  dashboardShares,
  apiTokens,
  githubInstallations,
  codeIndex,
  reviewReports,
  reviewComments,
} as const;
