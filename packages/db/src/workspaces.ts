import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { workspaces } from './schema.js';

export type Workspace = typeof workspaces.$inferSelect;

export interface NewWorkspace {
  /** Omit to let the database choose. */
  id?: string;
  name: string;
  /** A plan id from the plans file. */
  plan: string;
  ingestionKeyHash?: string | null;
  /** When the free trial ends. */
  trialEndsAt?: Date | null;
}

export async function createWorkspace(db: Database, input: NewWorkspace): Promise<Workspace> {
  const [row] = await db
    .insert(workspaces)
    .values({
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      plan: input.plan,
      ingestionKeyHash: input.ingestionKeyHash ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
    })
    .returning();
  return row!;
}

export async function getWorkspace(db: Database, id: string): Promise<Workspace | undefined> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row;
}

/** Find the workspace an ingestion key belongs to, by the key's hash. */
export async function findWorkspaceByIngestionKeyHash(
  db: Database,
  keyHash: string,
): Promise<Workspace | undefined> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ingestionKeyHash, keyHash))
    .limit(1);
  return row;
}

/** Replace a workspace's ingestion key. The old key stops working at once. */
export async function setIngestionKeyHash(
  db: Database,
  workspaceId: string,
  keyHash: string,
): Promise<boolean> {
  const updated = await db
    .update(workspaces)
    .set({ ingestionKeyHash: keyHash })
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id });
  return updated.length === 1;
}
