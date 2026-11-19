import { AgentApiError, type AgentClient, type AgentReply } from '@app/agent/client';
import { readChart, renderSvg, svgToPng } from '@app/charts';
import type { QueryApiClient } from '@app/query-api/client';
import type { AlertRuleSpec, CollectorSpec, PanelSpec } from '@app/specs';
import { collectorCard, ruleCard } from './alert-messages.js';
import type { SlackApi } from './api.js';
import {
  answeredMessage,
  draftMessage,
  plainMessage,
  questionMessage,
  savedMessage,
} from './blocks.js';

/** What the conversation needs for one Slack workspace and one person in it. */
export interface ConversationContext {
  api: SlackApi;
  /** The agent, acting for the person who clicked or wrote. */
  agent: AgentClient;
  /** The Query API, scoped to the workspace. Charts are drawn from it; no model is involved. */
  query: QueryApiClient;
  webUrl: string;
  defaultRange: string;
  /** Approvals and alert actions, which change stored rules directly. */
  ops?: AlertOps;
}

/** What the alert buttons do. Every change records the person's user id. */
export interface AlertOps {
  approveRule(ruleId: string): Promise<AlertRuleSpec | undefined>;
  discardRule(ruleId: string): Promise<AlertRuleSpec | undefined>;
  approveCollector(collectorId: string): Promise<{ spec: CollectorSpec } | undefined>;
  discardCollector(collectorId: string): Promise<{ spec: CollectorSpec } | undefined>;
  snooze(ruleId: string, hours: number): Promise<boolean>;
  acknowledge(ruleId: string): Promise<boolean>;
}

/** Where a request lives in Slack. Stored with the request so replies go back to the same thread. */
export interface SlackSurface {
  channel: string;
  thread_ts: string;
}

/** A Slack mention or direct message: strip the bot's own mention. */
export function requestText(text: string, botUserId?: string): string {
  const own = botUserId
    ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g')
    : /^\s*<@[A-Z0-9]+(\|[^>]*)?>/;
  return text.replace(own, ' ').replace(/\s+/g, ' ').trim();
}

/** Keep a reply only the clicker sees in the thread they clicked in. */
const thread = (input: { threadTs?: string }) =>
  input.threadTs ? { thread_ts: input.threadTs } : {};

const HELP =
  'Ask me for a chart in plain words, for example: “latency of checkout service in the last 5 hours”.';

/** Render the draft's chart and post it in the thread, then the details and buttons under it. */
async function postDraft(
  ctx: ConversationContext,
  reply: AgentReply,
  surface: SlackSurface,
  panel: PanelSpec,
) {
  const range = panel.range ?? ctx.defaultRange;
  let chartProblem: string | undefined;
  try {
    const result = await ctx.query.query({ query: panel.query, range });
    await ctx.api.uploadPng({
      ...surface,
      png: svgToPng(renderSvg(panel, result.series, { range })),
      filename: 'chart.png',
      title: panel.title,
      // The one-line reading, written in code from the data.
      comment: readChart(panel, result.series, range),
    });
  } catch (error) {
    chartProblem = `The chart could not be drawn: ${error instanceof Error ? error.message : String(error)}`;
  }
  await ctx.api.postMessage({
    ...surface,
    ...draftMessage({
      requestId: reply.requestId,
      panel,
      webUrl: ctx.webUrl,
      canRemember: Object.keys(reply.rememberable).length > 0,
      ...(chartProblem ? { chartProblem } : {}),
    }),
  });
}

/** Show the person whatever the agent's reply calls for, in the thread. */
async function present(ctx: ConversationContext, reply: AgentReply, surface: SlackSurface) {
  const { output } = reply;
  switch (output.kind) {
    case 'question':
      await ctx.api.postMessage({
        ...surface,
        ...questionMessage(reply.requestId, output.question, output.questionsLeft),
      });
      return;
    case 'draft':
      await postDraft(ctx, reply, surface, output.panel);
      return;
    case 'no_match':
    case 'failed':
      await ctx.api.postMessage({ ...surface, ...plainMessage(output.message) });
      return;
    case 'alert':
      await ctx.api.postMessage({
        ...surface,
        ...ruleCard(output.ruleId, output.rule, ctx.webUrl),
      });
      return;
    case 'collector':
      await ctx.api.postMessage({
        ...surface,
        ...collectorCard(output.collectorId, output.spec, output.test, ctx.webUrl),
      });
      return;
    case 'saved':
      return;
  }
}

/** A mention in a channel or a direct message: start a request, replying in its thread. */
export async function handleRequest(
  ctx: ConversationContext,
  input: { channel: string; ts: string; thread_ts?: string; text: string },
): Promise<void> {
  const surface: SlackSurface = { channel: input.channel, thread_ts: input.thread_ts ?? input.ts };
  if (input.text === '' || /^(help|hi|hello)\??$/i.test(input.text)) {
    await ctx.api.postMessage({ ...surface, ...plainMessage(HELP) });
    return;
  }
  // S7: a message in a thread that already has a chart changes that chart.
  if (input.thread_ts) {
    const base = await ctx.agent.inThread(input.channel, input.thread_ts).catch(() => undefined);
    if (base && (base.output.kind === 'draft' || base.output.kind === 'saved')) {
      const reply = await ctx.agent.refine({ requestId: base.requestId }, input.text, {
        slack: surface,
      });
      await present(ctx, reply, surface);
      return;
    }
  }
  const reply = await ctx.agent.ask(input.text, { slack: surface });
  await present(ctx, reply, surface);
}

const surfaceOf = (reply: AgentReply): SlackSurface | undefined => {
  const slack = (reply.surface as { slack?: SlackSurface }).slack;
  return slack?.channel && slack.thread_ts ? slack : undefined;
};

/** Someone answered a question: mark it answered, then carry on in the thread. */
export async function handleAnswer(
  ctx: ConversationContext,
  input: {
    requestId: string;
    value: string;
    slackUser: string;
    channel: string;
    messageTs: string;
    threadTs?: string;
  },
): Promise<void> {
  let before: AgentReply;
  try {
    before = await ctx.agent.get(input.requestId);
  } catch {
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text: 'This request has expired. Ask again.',
    });
    return;
  }
  if (before.output.kind !== 'question') {
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text: 'This question has already been answered.',
    });
    return;
  }
  const surface = surfaceOf(before) ?? { channel: input.channel, thread_ts: input.messageTs };
  let reply: AgentReply;
  try {
    reply = await ctx.agent.answer(input.requestId, input.value);
  } catch (error) {
    if (error instanceof AgentApiError && error.status === 409) {
      await ctx.api.postEphemeral({
        channel: input.channel,
        user: input.slackUser,
        ...thread(input),
        text: error.message,
      });
      return;
    }
    throw error;
  }
  await ctx.api.update({
    channel: input.channel,
    ts: input.messageTs,
    ...answeredMessage(before.output.question, input.value, input.slackUser),
  });
  await present(ctx, reply, surface);
}

/** "Save to dashboard". */
export async function handleSave(
  ctx: ConversationContext,
  input: {
    requestId: string;
    slackUser: string;
    channel: string;
    messageTs: string;
    threadTs?: string;
  },
): Promise<void> {
  try {
    const current = await ctx.agent.get(input.requestId);
    if (current.output.kind === 'saved') {
      await ctx.api.postEphemeral({
        channel: input.channel,
        user: input.slackUser,
        ...thread(input),
        text: 'This chart is already saved.',
      });
      return;
    }
    if (current.output.kind !== 'draft') return;
    const panel = current.output.panel;
    const saved = await ctx.agent.confirm(input.requestId);
    if (saved.output.kind !== 'saved') return;
    await ctx.api.update({
      channel: input.channel,
      ts: input.messageTs,
      ...savedMessage({
        panel,
        webUrl: ctx.webUrl,
        dashboardId: saved.output.dashboardId,
        user: input.slackUser,
      }),
    });
  } catch (error) {
    const text = error instanceof AgentApiError ? error.message : 'Saving failed. Try again.';
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text,
    });
  }
}

/** "Skip questions next time": only the person who asked can save their answers. */
export async function handleRemember(
  ctx: ConversationContext,
  input: { requestId: string; slackUser: string; channel: string; threadTs?: string },
): Promise<void> {
  try {
    const result = await ctx.agent.remember(input.requestId);
    const text =
      result.saved === 0
        ? 'There were no answers to save.'
        : 'Saved. I will use these answers instead of asking next time. You can change them on the memory page.';
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text,
    });
  } catch (error) {
    const text = error instanceof AgentApiError ? error.message : 'Could not save your answers.';
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text,
    });
  }
}

/** "Alert me on this": a pending rule from the chart, posted in the thread for approval. */
export async function handleAlert(
  ctx: ConversationContext,
  input: { requestId: string; slackUser: string; channel: string; threadTs?: string },
): Promise<void> {
  let reply: AgentReply;
  try {
    reply = await ctx.agent.alert(input.requestId, { channel: `#${input.channel}` });
  } catch (error) {
    const text = error instanceof AgentApiError ? error.message : 'Could not draft an alert.';
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text,
    });
    return;
  }
  const surface = surfaceOf(reply) ?? { channel: input.channel, thread_ts: input.threadTs ?? '' };
  await present(ctx, reply, surface);
}

/** Approve or discard a pending rule from its card. */
export async function handleRuleDecision(
  ctx: ConversationContext,
  input: {
    ruleId: string;
    approve: boolean;
    slackUser: string;
    channel: string;
    messageTs: string;
    threadTs?: string;
  },
): Promise<void> {
  if (!ctx.ops) return;
  const after = input.approve
    ? await ctx.ops.approveRule(input.ruleId)
    : await ctx.ops.discardRule(input.ruleId);
  if (!after) {
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text: 'This rule no longer exists.',
    });
    return;
  }
  const footer = input.approve
    ? `:white_check_mark: Approved by <@${input.slackUser}>. It is now watched.`
    : `Discarded by <@${input.slackUser}>. Nothing is watched.`;
  await ctx.api.update({
    channel: input.channel,
    ts: input.messageTs,
    ...ruleCard(input.ruleId, after, ctx.webUrl, footer),
  });
}

/** Approve or discard a pending collector from its card. */
export async function handleCollectorDecision(
  ctx: ConversationContext,
  input: {
    collectorId: string;
    approve: boolean;
    slackUser: string;
    channel: string;
    messageTs: string;
    threadTs?: string;
  },
): Promise<void> {
  if (!ctx.ops) return;
  const result = input.approve
    ? await ctx.ops.approveCollector(input.collectorId)
    : await ctx.ops.discardCollector(input.collectorId);
  if (!result) {
    await ctx.api.postEphemeral({
      channel: input.channel,
      user: input.slackUser,
      ...thread(input),
      text: 'This collector no longer exists.',
    });
    return;
  }
  const footer = input.approve
    ? `:white_check_mark: Approved by <@${input.slackUser}>. It runs every ${result.spec.interval}.`
    : `Discarded by <@${input.slackUser}>.`;
  await ctx.api.update({
    channel: input.channel,
    ts: input.messageTs,
    ...collectorCard(
      input.collectorId,
      result.spec,
      { ok: true, status: null, duration: 0 },
      ctx.webUrl,
      footer,
    ),
  });
}

/** "Snooze 1 hour" and "Acknowledge" on a firing message. Replies in its thread. */
export async function handleFiringAction(
  ctx: ConversationContext,
  input: {
    ruleId: string;
    action: 'snooze' | 'acknowledge';
    slackUser: string;
    channel: string;
    messageTs: string;
  },
): Promise<void> {
  if (!ctx.ops) return;
  const done =
    input.action === 'snooze'
      ? await ctx.ops.snooze(input.ruleId, 1)
      : await ctx.ops.acknowledge(input.ruleId);
  const text = !done
    ? 'This alert is no longer firing.'
    : input.action === 'snooze'
      ? `<@${input.slackUser}> snoozed this alert for 1 hour.`
      : `<@${input.slackUser}> acknowledged this alert.`;
  await ctx.api.postMessage({
    channel: input.channel,
    thread_ts: input.messageTs,
    ...plainMessage(text),
  });
}

/** "Why did this happen?": a labelled hypothesis and the charts behind it, in the alert's thread. */
export async function handleExplain(
  ctx: ConversationContext,
  input: { ruleId: string; slackUser: string; channel: string; messageTs: string },
): Promise<void> {
  const surface = { channel: input.channel, thread_ts: input.messageTs };
  await ctx.api.postMessage({ ...surface, ...plainMessage('Looking at related series…') });
  let result: Awaited<ReturnType<AgentClient['explain']>>;
  try {
    result = await ctx.agent.explain(input.ruleId);
  } catch (error) {
    const text = error instanceof AgentApiError ? error.message : 'Could not look into this.';
    await ctx.api.postMessage({ ...surface, ...plainMessage(text) });
    return;
  }
  await ctx.api.postMessage({ ...surface, ...plainMessage(result.hypothesis) });
  for (const chart of result.charts) {
    const panel: PanelSpec = {
      title: chart.title,
      type: 'timeseries',
      query: chart.query,
      unit: chart.unit,
      ...(chart.display_unit ? { display_unit: chart.display_unit } : {}),
      range: chart.range,
      thresholds: [],
      request: 'explanation',
      assumptions: [],
    };
    try {
      const data = await ctx.query.query({ query: chart.query, range: chart.range });
      await ctx.api.uploadPng({
        ...surface,
        png: svgToPng(renderSvg(panel, data.series, { range: chart.range })),
        filename: 'evidence.png',
        title: chart.title,
        comment: readChart(panel, data.series, chart.range),
      });
    } catch {
      // A chart that cannot be drawn is left out; the hypothesis names the numbers.
    }
  }
}
