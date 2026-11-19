import { createAgentClient } from '@app/agent-client';
import { createQueryApiClient } from '@app/query-api/client';
import { App, HTTPReceiver, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { wrapWebClient } from './api.js';
import { ACTIONS, type AnswerValue } from './blocks.js';
import { ALERT_ACTIONS } from './alert-messages.js';
import { alertOps } from './ops.js';
import {
  handleAlert,
  handleAnswer,
  handleCollectorDecision,
  handleExplain,
  handleFiringAction,
  handleRuleDecision,
  handleRemember,
  handleRequest,
  handleSave,
  requestText,
  type ConversationContext,
} from './conversation.js';
import { installRoutes, type InstallOptions } from './install.js';
import type { SlackStore } from './store.js';

export interface SlackAppOptions extends InstallOptions {
  signingSecret: string;
  store: SlackStore;
  agentUrl: string;
  queryApiUrl: string;
  internalToken: string;
  defaultRange: string;
}

/**
 * The Slack app: events and button clicks arrive at /slack/events, signed by
 * Slack. Each Slack workspace is mapped to its product workspace through its
 * installation, and every request acts for the person who wrote or clicked.
 */
export function createSlackApp(options: SlackAppOptions) {
  const receiver = new HTTPReceiver({
    signingSecret: options.signingSecret,
    endpoints: '/slack/events',
    customRoutes: [
      ...installRoutes(options),
      {
        path: '/healthz',
        method: ['GET'],
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"status":"ok"}');
        },
      },
    ],
  });

  const app = new App({
    receiver,
    logLevel: LogLevel.WARN,
    clientOptions: { slackApiUrl: `${options.apiUrl}/` },
    authorize: async ({ teamId }) => {
      const installation = teamId ? await options.store.installationForTeam(teamId) : undefined;
      if (!installation) throw new Error(`No installation for Slack team ${teamId}.`);
      return { botToken: installation.botToken, botUserId: installation.botUserId, teamId };
    },
  });

  /** The conversation context for one person in one Slack workspace. */
  async function contextFor(teamId: string | undefined, slackUser: string, client: WebClient) {
    const installation = teamId ? await options.store.installationForTeam(teamId) : undefined;
    if (!installation) throw new Error(`No installation for Slack team ${teamId}.`);
    const api = wrapWebClient(client);
    const userId = await options.store.ensureUser(installation.workspaceId, slackUser, () =>
      api.userName(slackUser),
    );
    const ctx: ConversationContext = {
      api,
      agent: createAgentClient({
        url: options.agentUrl,
        internalToken: options.internalToken,
        workspaceId: installation.workspaceId,
        userId,
      }),
      query: createQueryApiClient({
        url: options.queryApiUrl,
        internalToken: options.internalToken,
        workspaceId: installation.workspaceId,
      }),
      webUrl: options.webUrl,
      defaultRange: options.defaultRange,
      ops: alertOps(options.db, installation.workspaceId, userId),
    };
    return { ctx, installation };
  }

  const reportFailure = async (
    client: WebClient,
    channel: string,
    thread_ts: string,
    error: unknown,
  ) => {
    console.error(error);
    await client.chat
      .postMessage({
        channel,
        thread_ts,
        text: 'Something went wrong on my side. Try again in a moment.',
      })
      .catch(() => undefined);
  };

  app.event('app_mention', async ({ event, context, client }) => {
    if (!event.user) return;
    try {
      const { ctx, installation } = await contextFor(context.teamId, event.user, client);
      await handleRequest(ctx, {
        channel: event.channel,
        ts: event.ts,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        text: requestText(event.text, installation.botUserId),
      });
    } catch (error) {
      await reportFailure(client, event.channel, event.thread_ts ?? event.ts, error);
    }
  });

  app.event('message', async ({ event, context, client }) => {
    // Direct messages only; channels go through mentions. Ignore edits and bots.
    const message = event as {
      channel_type?: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
    };
    if (message.channel_type !== 'im' || message.subtype || message.bot_id || !message.user) return;
    try {
      const { ctx, installation } = await contextFor(context.teamId, message.user, client);
      await handleRequest(ctx, {
        channel: message.channel,
        ts: message.ts,
        ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
        text: requestText(message.text ?? '', installation.botUserId),
      });
    } catch (error) {
      await reportFailure(client, message.channel, message.thread_ts ?? message.ts, error);
    }
  });

  type Click = {
    user: { id: string };
    team?: { id: string } | null;
    channel?: { id: string };
    message?: { ts: string; thread_ts?: string };
    container?: { message_ts?: string; thread_ts?: string };
  };
  const clickInfo = (body: unknown) => {
    const click = body as Click;
    return {
      slackUser: click.user.id,
      teamId: click.team?.id,
      channel: click.channel?.id ?? '',
      messageTs: click.message?.ts ?? click.container?.message_ts ?? '',
      threadTs: click.message?.thread_ts ?? click.container?.thread_ts ?? click.message?.ts ?? '',
    };
  };

  app.action(
    new RegExp(`^${ACTIONS.answer}:\\d+$`),
    async ({ ack, body, action, context, client }) => {
      await ack();
      const info = clickInfo(body);
      try {
        const { r, v } = JSON.parse((action as { value?: string }).value ?? '{}') as AnswerValue;
        const { ctx } = await contextFor(context.teamId ?? info.teamId, info.slackUser, client);
        await handleAnswer(ctx, { requestId: r, value: v, ...info });
      } catch (error) {
        await reportFailure(client, info.channel, info.threadTs, error);
      }
    },
  );

  app.action(ACTIONS.pick, async ({ ack, body, action, context, client }) => {
    await ack();
    const info = clickInfo(body);
    try {
      const picked = action as { block_id: string; selected_option?: { value: string } };
      const requestId = picked.block_id.replace(/^q:/, '');
      if (!picked.selected_option) return;
      const { ctx } = await contextFor(context.teamId ?? info.teamId, info.slackUser, client);
      await handleAnswer(ctx, { requestId, value: picked.selected_option.value, ...info });
    } catch (error) {
      await reportFailure(client, info.channel, info.threadTs, error);
    }
  });

  const simple = (
    id: string,
    run: (
      ctx: ConversationContext,
      input: {
        requestId: string;
        slackUser: string;
        channel: string;
        messageTs: string;
        threadTs: string;
      },
    ) => Promise<void>,
  ) => {
    app.action(id, async ({ ack, body, action, context, client }) => {
      await ack();
      const info = clickInfo(body);
      try {
        const requestId = (action as { value?: string }).value ?? '';
        const { ctx } = await contextFor(context.teamId ?? info.teamId, info.slackUser, client);
        await run(ctx, { requestId, ...info });
      } catch (error) {
        await reportFailure(client, info.channel, info.threadTs, error);
      }
    });
  };
  const byValue = (
    id: string,
    run: (
      ctx: ConversationContext,
      value: string,
      info: ReturnType<typeof clickInfo>,
    ) => Promise<void>,
  ) => {
    app.action(id, async ({ ack, body, action, context, client }) => {
      await ack();
      const info = clickInfo(body);
      try {
        const { ctx } = await contextFor(context.teamId ?? info.teamId, info.slackUser, client);
        await run(ctx, (action as { value?: string }).value ?? '', info);
      } catch (error) {
        await reportFailure(client, info.channel, info.threadTs, error);
      }
    });
  };
  byValue(ALERT_ACTIONS.approve, (ctx, ruleId, info) =>
    handleRuleDecision(ctx, { ruleId, approve: true, ...info }),
  );
  byValue(ALERT_ACTIONS.discard, (ctx, ruleId, info) =>
    handleRuleDecision(ctx, { ruleId, approve: false, ...info }),
  );
  byValue(ALERT_ACTIONS.approveCollector, (ctx, collectorId, info) =>
    handleCollectorDecision(ctx, { collectorId, approve: true, ...info }),
  );
  byValue(ALERT_ACTIONS.discardCollector, (ctx, collectorId, info) =>
    handleCollectorDecision(ctx, { collectorId, approve: false, ...info }),
  );
  byValue(ALERT_ACTIONS.snooze, (ctx, ruleId, info) =>
    handleFiringAction(ctx, { ruleId, action: 'snooze', ...info }),
  );
  byValue(ALERT_ACTIONS.acknowledge, (ctx, ruleId, info) =>
    handleFiringAction(ctx, { ruleId, action: 'acknowledge', ...info }),
  );
  byValue(ALERT_ACTIONS.explain, (ctx, ruleId, info) => handleExplain(ctx, { ruleId, ...info }));
  for (const link of ['alert_edit', 'collector_edit']) {
    app.action(link, async ({ ack }) => {
      await ack();
    });
  }
  simple(ACTIONS.save, handleSave);
  simple(ACTIONS.remember, handleRemember);
  simple(ACTIONS.alert, handleAlert);
  // A link button still sends a click; nothing to do.
  app.action(ACTIONS.openWeb, async ({ ack }) => {
    await ack();
  });

  return app;
}
