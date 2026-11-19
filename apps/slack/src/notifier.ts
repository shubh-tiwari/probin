import type { SlackStore } from './store.js';
import { WebClient } from '@slack/web-api';
import { firingMessage, postableChannel, resolvedMessage } from './alert-messages.js';
import type { StoredRule } from '@app/db';

/** Matches the alert engine's Notifier. */
export interface Notifier {
  firing(rule: StoredRule, value: number): Promise<{ channel: string; ts: string } | null>;
  resolved(rule: StoredRule, where: { channel: string; ts: string } | null): Promise<void>;
}

/** Posts alerts to the rule's Slack channel, with the workspace's own bot token. */
export function createSlackNotifier(options: { store: SlackStore; apiUrl: string }): Notifier {
  const clientFor = async (workspaceId: string) => {
    const installation = await options.store.installationForWorkspace(workspaceId);
    if (!installation) throw new Error(`workspace ${workspaceId} has no Slack installation`);
    return new WebClient(installation.botToken, { slackApiUrl: `${options.apiUrl}/` });
  };
  return {
    async firing(rule, value) {
      const client = await clientFor(rule.workspaceId);
      const channel = postableChannel(rule.spec.channel);
      const result = await client.chat.postMessage({
        channel,
        ...firingMessage(rule.id, rule.spec, value),
      } as never);
      return result.ts ? { channel: result.channel ?? channel, ts: result.ts } : null;
    },
    async resolved(rule, where) {
      const client = await clientFor(rule.workspaceId);
      const channel = where?.channel ?? postableChannel(rule.spec.channel);
      await client.chat.postMessage({
        channel,
        ...(where ? { thread_ts: where.ts } : {}),
        ...resolvedMessage(rule.spec),
      } as never);
    },
  };
}
