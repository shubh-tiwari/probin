import { createHash, randomBytes } from 'node:crypto';
import { PRODUCT_SLUG } from '@app/config';
import { schema, type Database } from '@app/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Read-only API tokens (Grafana, the connector for Claude Code) and share
 * links. A token is shown once; only its SHA-256 hash is stored.
 */
const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const make = (kind: 'rt' | 'sh') =>
  `${PRODUCT_SLUG}_${kind}_${randomBytes(32).toString('base64url')}`;

export async function createApiToken(
  db: Database,
  workspaceId: string,
  name: string,
  createdBy: string,
) {
  const token = make('rt');
  const [row] = await db
    .insert(schema.apiTokens)
    .values({ workspaceId, name, tokenHash: hash(token), createdBy })
    .returning({ id: schema.apiTokens.id });
  return { id: row!.id, token };
}

/** The workspace an API token belongs to, if it is valid and not revoked. */
export async function workspaceForApiToken(
  db: Database,
  token: string,
): Promise<string | undefined> {
  if (!token.startsWith(`${PRODUCT_SLUG}_rt_`)) return undefined;
  const [row] = await db
    .select({
      id: schema.apiTokens.id,
      workspaceId: schema.apiTokens.workspaceId,
      lastUsedAt: schema.apiTokens.lastUsedAt,
    })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.tokenHash, hash(token)), isNull(schema.apiTokens.revokedAt)))
    .limit(1);
  if (!row) return undefined;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db
      .update(schema.apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiTokens.id, row.id));
  }
  return row.workspaceId;
}

export async function revokeApiToken(db: Database, workspaceId: string, id: string) {
  await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.workspaceId, workspaceId)));
}

export async function createShare(
  db: Database,
  workspaceId: string,
  dashboardId: string,
  createdBy: string,
) {
  const token = make('sh');
  await db
    .insert(schema.dashboardShares)
    .values({ workspaceId, dashboardId, tokenHash: hash(token), createdBy });
  return token;
}

/** The dashboard a share link shows, if the link is valid and not revoked. */
export async function sharedDashboard(db: Database, token: string) {
  if (!token.startsWith(`${PRODUCT_SLUG}_sh_`)) return undefined;
  const [row] = await db
    .select()
    .from(schema.dashboardShares)
    .where(
      and(
        eq(schema.dashboardShares.tokenHash, hash(token)),
        isNull(schema.dashboardShares.revokedAt),
      ),
    )
    .limit(1);
  return row ? { workspaceId: row.workspaceId, dashboardId: row.dashboardId } : undefined;
}

export async function revokeShare(db: Database, workspaceId: string, id: string) {
  await db
    .update(schema.dashboardShares)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(schema.dashboardShares.id, id), eq(schema.dashboardShares.workspaceId, workspaceId)),
    );
}
