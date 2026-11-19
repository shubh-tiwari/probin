import type { SecretBox } from '@app/config';
import { type Database } from '@app/db';
export interface Installation {
  workspaceId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
}
/** Installations and people, in Postgres. Bot tokens are sealed before they are stored. */
export declare function createSlackStore(
  db: Database,
  secrets: SecretBox,
): {
  installationForTeam(teamId: string): Promise<Installation | undefined>;
  saveInstallation(installation: Installation, installedBy: string | null): Promise<void>;
  /** The users.id of a Slack person, creating the row the first time they are seen. */
  ensureUser(
    workspaceId: string,
    slackUserId: string,
    name: () => Promise<string>,
    role?: 'admin' | 'member',
  ): Promise<string>;
};
export type SlackStore = ReturnType<typeof createSlackStore>;
//# sourceMappingURL=store.d.ts.map
