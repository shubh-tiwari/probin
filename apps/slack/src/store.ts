import type { SecretBox } from '@app/config';
import { schema, type Database } from '@app/db';
import { and, eq } from 'drizzle-orm';

const { slackInstallations, users } = schema;

export interface Installation {
  workspaceId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
}

/** Installations and people, in Postgres. Bot tokens are sealed before they are stored. */
export function createSlackStore(db: Database, secrets: SecretBox) {
  return {
    async installationForTeam(teamId: string): Promise<Installation | undefined> {
      const [row] = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.teamId, teamId))
        .limit(1);
      if (!row) return undefined;
      return {
        workspaceId: row.workspaceId,
        teamId: row.teamId,
        teamName: row.teamName,
        botUserId: row.botUserId,
        botToken: secrets.open(row.botTokenEncrypted),
      };
    },

    async installationForWorkspace(workspaceId: string): Promise<Installation | undefined> {
      const [row] = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.workspaceId, workspaceId))
        .limit(1);
      if (!row) return undefined;
      return {
        workspaceId: row.workspaceId,
        teamId: row.teamId,
        teamName: row.teamName,
        botUserId: row.botUserId,
        botToken: secrets.open(row.botTokenEncrypted),
      };
    },

    async saveInstallation(installation: Installation, installedBy: string | null): Promise<void> {
      const values = {
        workspaceId: installation.workspaceId,
        teamId: installation.teamId,
        teamName: installation.teamName,
        botUserId: installation.botUserId,
        botTokenEncrypted: secrets.seal(installation.botToken),
        installedBy,
      };
      await db
        .insert(slackInstallations)
        .values(values)
        .onConflictDoUpdate({ target: slackInstallations.workspaceId, set: values });
    },

    /** The users.id of a Slack person, creating the row the first time they are seen. */
    async ensureUser(
      workspaceId: string,
      slackUserId: string,
      name: () => Promise<string>,
      role: 'admin' | 'member' = 'member',
    ): Promise<string> {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.workspaceId, workspaceId), eq(users.slackUserId, slackUserId)))
        .limit(1);
      if (existing) return existing.id;
      const displayName = await name().catch(() => slackUserId);
      const [row] = await db
        .insert(users)
        .values({ workspaceId, slackUserId, name: displayName, role })
        .onConflictDoUpdate({
          target: [users.workspaceId, users.slackUserId],
          set: { name: displayName },
        })
        .returning({ id: users.id });
      return row!.id;
    },
  };
}

export type SlackStore = ReturnType<typeof createSlackStore>;
