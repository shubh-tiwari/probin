import type { WebClient } from '@slack/web-api';

/**
 * The part of Slack's Web API this app uses. The real WebClient is wrapped in
 * this, so the conversation logic has one small surface to test.
 */
export interface SlackApi {
  postMessage(message: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ts: string }>;
  update(message: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  postEphemeral(message: {
    channel: string;
    user: string;
    thread_ts?: string;
    text: string;
  }): Promise<void>;
  uploadPng(file: {
    channel: string;
    thread_ts: string;
    png: Buffer;
    filename: string;
    title: string;
    comment: string;
  }): Promise<void>;
  userName(userId: string): Promise<string>;
}

export function wrapWebClient(client: WebClient): SlackApi {
  return {
    async postMessage(message) {
      const result = await client.chat.postMessage(
        message as Parameters<WebClient['chat']['postMessage']>[0],
      );
      return { ts: result.ts ?? '' };
    },
    async update(message) {
      await client.chat.update(message as Parameters<WebClient['chat']['update']>[0]);
    },
    async postEphemeral(message) {
      await client.chat.postEphemeral(message as Parameters<WebClient['chat']['postEphemeral']>[0]);
    },
    async uploadPng(file) {
      await client.files.uploadV2({
        channel_id: file.channel,
        thread_ts: file.thread_ts,
        file: file.png,
        filename: file.filename,
        title: file.title,
        initial_comment: file.comment,
      });
    },
    async userName(userId) {
      const result = await client.users.info({ user: userId });
      const user = result.user;
      return user?.profile?.display_name || user?.real_name || user?.name || userId;
    },
  };
}
