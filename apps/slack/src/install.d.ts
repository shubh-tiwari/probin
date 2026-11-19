import type { IncomingMessage, ServerResponse } from 'node:http';
import { type PlansConfig } from '@app/config';
import { type Database } from '@app/db';
import type { SlackStore } from './store.js';
/** What the bot needs: mentions, direct messages, posting, files, and people's names. */
export declare const BOT_SCOPES: string[];
export interface InstallOptions {
  db: Database;
  store: SlackStore;
  plans: PlansConfig;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  apiUrl: string;
  publicUrl: string;
  ingestUrl: string;
  webUrl: string;
}
export declare function checkState(state: string, secret: string, now?: number): boolean;
/**
 * The install flow, which is also sign-up: the first install from a Slack
 * workspace creates a product workspace, its first admin, and its ingestion
 * key (shown once). A later install from the same Slack workspace refreshes
 * the bot token and keeps everything else.
 */
export declare function installRoutes(options: InstallOptions): {
  path: string;
  method: string[];
  handler: (_req: IncomingMessage, res: ServerResponse) => void;
}[];
//# sourceMappingURL=install.d.ts.map
