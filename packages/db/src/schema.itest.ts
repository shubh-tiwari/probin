import { randomBytes } from 'node:crypto';
import { loadEnv } from '@app/config';
import { getTableName } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, tables } from './index.js';

// Needs Postgres from the local stack (`make dev`). Works in a throwaway
// database so it never touches development data.

const { DATABASE_URL } = loadEnv(['DATABASE_URL']);
const testDatabase = `schema_test_${randomBytes(6).toString('hex')}`;
const testUrl = new URL(DATABASE_URL);
testUrl.pathname = `/${testDatabase}`;

const EXPECTED_TABLES = [
  'workspaces',
  'users',
  'dashboards',
  'panels',
  'alert_rules',
  'collectors',
  'catalog_metrics',
  'catalog_endpoints',
  'memory_entries',
  'review_findings',
  'model_calls',
  'agent_requests',
  'slack_installations',
  'resolved_requests',
  'alert_states',
  'collector_states',
  'starter_dashboards',
  'dashboard_shares',
  'api_tokens',
  'github_installations',
  'code_index',
  'review_reports',
  'review_comments',
];

let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`create database ${testDatabase}`);
  await runMigrations(testUrl.toString());
  db = new pg.Client({ connectionString: testUrl.toString() });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  await admin?.query(`drop database if exists ${testDatabase} with (force)`);
  await admin?.end();
});

async function createWorkspace(name: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into workspaces (name, plan) values ($1, 'example') returning id`,
    [name],
  );
  return result.rows[0]!.id;
}

async function createUser(workspaceId: string, slackUserId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into users (workspace_id, slack_user_id, name) values ($1, $2, 'Test User') returning id`,
    [workspaceId, slackUserId],
  );
  return result.rows[0]!.id;
}

const insertRule = (
  workspaceId: string,
  fields: { status: 'pending' | 'active'; approvedBy?: string | null },
) =>
  db.query(
    `insert into alert_rules
       (workspace_id, name, expression, duration, severity, channel, status, approved_by, approved_at,
        created_by_kind, created_by_id)
     values ($1, 'Checkout p95 high', 'x > 0.8', '5m', 'warning', '#ops-monitoring', $2, $3,
             case when $3::uuid is null then null else now() end, 'agent', 'agent')`,
    [workspaceId, fields.status, fields.approvedBy ?? null],
  );

describe('migrations', () => {
  it('create every table in the data model, and the schema file lists the same ones', async () => {
    const result = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const actual = result.rows.map((row) => row.table_name).sort();
    expect(actual).toEqual([...EXPECTED_TABLES].sort());
    expect(Object.values(tables).map(getTableName).sort()).toEqual(actual);
  });

  it('can run again without changing anything', async () => {
    await expect(runMigrations(testUrl.toString())).resolves.toBeUndefined();
  });
});

describe('workspace isolation', () => {
  it('every table except workspaces carries a NOT NULL workspace_id', async () => {
    const result = await db.query<{ table_name: string; is_nullable: string }>(
      `select table_name, is_nullable from information_schema.columns
       where table_schema = 'public' and column_name = 'workspace_id'`,
    );
    const carrying = result.rows.map((row) => row.table_name).sort();
    expect(carrying).toEqual(EXPECTED_TABLES.filter((name) => name !== 'workspaces').sort());
    expect(result.rows.filter((row) => row.is_nullable !== 'NO')).toEqual([]);
  });

  it('every workspace_id is a foreign key that cascades on delete', async () => {
    const result = await db.query<{ table_name: string }>(
      `select c.conrelid::regclass::text as table_name
       from pg_constraint c
       where c.contype = 'f' and c.confrelid = 'workspaces'::regclass and c.confdeltype = 'c'`,
    );
    expect(result.rows.map((row) => row.table_name).sort()).toEqual(
      EXPECTED_TABLES.filter((name) => name !== 'workspaces').sort(),
    );
  });

  it('deleting a workspace deletes its rows and leaves other workspaces alone', async () => {
    const a = await createWorkspace('a');
    const b = await createWorkspace('b');
    const approverA = await createUser(a, 'U_A');
    await createUser(b, 'U_B');
    await insertRule(a, { status: 'active', approvedBy: approverA });
    await insertRule(b, { status: 'pending' });

    await db.query(`delete from workspaces where id = $1`, [a]);

    const users = await db.query(`select workspace_id from users`);
    const rules = await db.query(`select workspace_id from alert_rules`);
    expect(users.rows).toEqual([{ workspace_id: b }]);
    expect(rules.rows).toEqual([{ workspace_id: b }]);
    await db.query(`delete from workspaces where id = $1`, [b]);
  });

  it('an approver must belong to the same workspace as the rule', async () => {
    const a = await createWorkspace('a');
    const b = await createWorkspace('b');
    const approverB = await createUser(b, 'U_B');
    await expect(insertRule(a, { status: 'active', approvedBy: approverB })).rejects.toThrow(
      /alert_rules_approved_by_fk/,
    );
    await db.query(`delete from workspaces where id in ($1, $2)`, [a, b]);
  });
});

describe('approval before effect', () => {
  it('a rule cannot be active without a recorded approver', async () => {
    const workspace = await createWorkspace('w');
    await expect(insertRule(workspace, { status: 'active' })).rejects.toThrow(
      /alert_rules_active_needs_approval/,
    );
    await expect(insertRule(workspace, { status: 'pending' })).resolves.toBeDefined();
    await db.query(`delete from workspaces where id = $1`, [workspace]);
  });

  it('a pending rule cannot carry an approver', async () => {
    const workspace = await createWorkspace('w');
    const approver = await createUser(workspace, 'U_W');
    await expect(
      insertRule(workspace, { status: 'pending', approvedBy: approver }),
    ).rejects.toThrow(/alert_rules_active_needs_approval/);
    await db.query(`delete from workspaces where id = $1`, [workspace]);
  });
});

describe('spec versions', () => {
  it('a new version shares the id; the same version twice is rejected', async () => {
    const workspace = await createWorkspace('w');
    const insert = (id: string | null, version: number) =>
      db.query<{ id: string }>(
        `insert into panels (id, version, workspace_id, title, type, query, unit, request, created_by_kind, created_by_id)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, 'p95', 'timeseries', 'up', 's', 'latency graph', 'agent', 'agent')
         returning id`,
        [id, version, workspace],
      );
    const first = await insert(null, 1);
    const id = first.rows[0]!.id;
    await expect(insert(id, 2)).resolves.toBeDefined();
    await expect(insert(id, 2)).rejects.toThrow(/panels_id_version_pk/);
    await db.query(`delete from workspaces where id = $1`, [workspace]);
  });
});

describe('memory', () => {
  it('a team decision needs a person', async () => {
    const workspace = await createWorkspace('w');
    const insert = (kind: string, createdByKind: string) =>
      db.query(
        `insert into memory_entries (workspace_id, kind, subject, text, source, created_by_kind, created_by_id)
         values ($1, $2, '/reports/export', 'allowed to be slow', 'test', $3, 'x')`,
        [workspace, kind, createdByKind],
      );
    await expect(insert('team_decision', 'agent')).rejects.toThrow(
      /memory_entries_team_decision_needs_person/,
    );
    await expect(insert('team_decision', 'user')).resolves.toBeDefined();
    await expect(insert('incident', 'agent')).resolves.toBeDefined();
    await db.query(`delete from workspaces where id = $1`, [workspace]);
  });
});
