import type { AgentClient, AgentReply, Question } from '@app/agent/client';
import type { QueryApiClient } from '@app/query-api/client';
import type { PanelSpec } from '@app/specs';
import { describe, expect, it, vi } from 'vitest';
import type { SlackApi } from './api.js';
import { ACTIONS, draftMessage, questionMessage } from './blocks.js';
import {
  handleAnswer,
  handleRequest,
  requestText,
  type ConversationContext,
} from './conversation.js';
import { checkState } from './install.js';

const endpointQuestion: Question = {
  id: 'endpoint',
  kind: 'endpoint',
  text: 'Which endpoint?',
  options: [
    { value: 'POST /checkout/pay', label: 'POST /checkout/pay', tags: ['Slowest'] },
    { value: 'GET /checkout/summary', label: 'GET /checkout/summary', tags: ['Busiest'] },
    { value: 'all', label: 'All endpoints combined' },
  ],
};
const percentileQuestion: Question = {
  id: 'percentile',
  kind: 'choice',
  text: 'Which latency?',
  options: [
    { value: '50', label: 'Typical (p50)' },
    { value: '95', label: 'Slow tail (p95)' },
  ],
};
const panel: PanelSpec = {
  title: 'POST /checkout/pay · p95 latency',
  type: 'timeseries',
  query: 'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))',
  unit: 's',
  display_unit: 'ms',
  range: '5h',
  thresholds: [],
  request: 'latency',
  assumptions: ['p95', 'all regions combined'],
};

type Block = {
  type: string;
  elements?: {
    type: string;
    action_id: string;
    options?: { text: { text: string }; value: string }[];
    text?: { text: string };
  }[];
};

describe('messages', () => {
  it('shows the endpoint picker as a searchable menu, tags included, "all" last', () => {
    const message = questionMessage('r1', endpointQuestion, 1);
    const select = (message.blocks[1] as Block).elements![0]!;
    expect(select.type).toBe('static_select');
    expect(select.action_id).toBe(ACTIONS.pick);
    expect(select.options!.map((o) => o.text.text)).toEqual([
      'POST /checkout/pay · Slowest',
      'GET /checkout/summary · Busiest',
      'All endpoints combined',
    ]);
  });

  it('caps a long picker at Slack’s 100 options and clips long labels', () => {
    const many: Question = {
      ...endpointQuestion,
      options: Array.from({ length: 130 }, (_, i) => ({
        value: `v${i}`,
        label: `GET /${'x'.repeat(90)}${i}`,
      })),
    };
    const select = (questionMessage('r1', many, 1).blocks[1] as Block).elements![0]!;
    expect(select.options).toHaveLength(100);
    expect(select.options![0]!.text.text.length).toBeLessThanOrEqual(75);
  });

  it('shows a short choice as buttons', () => {
    const buttons = (questionMessage('r1', percentileQuestion, 0).blocks[1] as Block).elements!;
    expect(buttons.map((b) => [b.type, b.text?.text])).toEqual([
      ['button', 'Typical (p50)'],
      ['button', 'Slow tail (p95)'],
    ]);
  });

  it('puts the query and the assumptions under every draft, and the four buttons', () => {
    const message = draftMessage({
      requestId: 'r1',
      panel,
      webUrl: 'http://web',
      canRemember: true,
    });
    const text = JSON.stringify(message.blocks);
    expect(text).toContain(panel.query.replace(/"/g, '\\"'));
    expect(text).toContain('Assumed: p95 · all regions combined');
    const buttons = (message.blocks.at(-1) as Block).elements!.map((b) => b.text?.text);
    expect(buttons).toEqual([
      'Save to dashboard',
      'Alert me on this',
      'Open in web',
      'Skip questions next time',
    ]);
  });

  it('offers to skip questions only when there were answers to save', () => {
    const message = draftMessage({
      requestId: 'r1',
      panel,
      webUrl: 'http://web',
      canRemember: false,
    });
    expect(JSON.stringify(message)).not.toContain('Skip questions');
  });

  it('strips the bot’s mention from a request', () => {
    expect(requestText('<@U0BOT> latency of checkout', 'U0BOT')).toBe('latency of checkout');
    expect(requestText('<@U0BOT|probe>   p95  ', 'U0BOT')).toBe('p95');
    expect(requestText('ask <@U0ALICE> about it', 'U0BOT')).toBe('ask <@U0ALICE> about it');
  });
});

describe('install state', () => {
  it('accepts its own fresh state only', async () => {
    const { installRoutes } = await import('./install.js');
    const routes = installRoutes({
      clientId: 'id', clientSecret: 'secret', authorizeUrl: 'http://slack/authorize',
    } as never);
    let location = '';
    routes[0]!.handler({} as never, { writeHead: (_s: number, h: { location: string }) => (location = h.location), end: () => {} } as never);
    const state = new URL(location).searchParams.get('state')!;
    expect(checkState(state, 'secret')).toBe(true);
    expect(checkState(state, 'other secret')).toBe(false);
    expect(checkState(state, 'secret', Date.now() + 11 * 60 * 1000)).toBe(false);
    expect(checkState(`${state}x`, 'secret')).toBe(false);
  }); // prettier-ignore
});

function context(replies: Partial<Record<'ask' | 'get' | 'answer', AgentReply>>) {
  const posted: { kind: string; payload: unknown }[] = [];
  const api: SlackApi = {
    postMessage: vi.fn(async (m) => (posted.push({ kind: 'post', payload: m }), { ts: '1.1' })),
    update: vi.fn(async (m) => void posted.push({ kind: 'update', payload: m })),
    postEphemeral: vi.fn(async (m) => void posted.push({ kind: 'ephemeral', payload: m })),
    uploadPng: vi.fn(async (f) => void posted.push({ kind: 'upload', payload: { ...f, png: f.png.length } })),
    userName: async (id) => id,
  };
  const agent = {
    ask: vi.fn(async () => replies.ask!),
    get: vi.fn(async () => replies.get!),
    answer: vi.fn(async () => replies.answer!),
  } as unknown as AgentClient;
  const query = {
    query: vi.fn(async () => ({
      series: [{ labels: {}, points: [[1, 0.5], [2, 0.8]] }], start: 0, end: 2, step: 1, lineCount: 1, durationMs: 1, cached: false,
    })),
  } as unknown as QueryApiClient;
  const ctx: ConversationContext = { api, agent, query, webUrl: 'http://web', defaultRange: '6h' };
  return { ctx, posted, agent };
} // prettier-ignore

const reply = (output: AgentReply['output'], extra: Partial<AgentReply> = {}): AgentReply => ({
  requestId: 'r1',
  output,
  rememberable: {},
  surface: { slack: { channel: 'C1', thread_ts: '9.9' } },
  trace: {} as AgentReply['trace'],
  ...extra,
});

describe('conversation', () => {
  it('replies in the thread of the mention', async () => {
    const { ctx, posted, agent } = context({ ask: reply({ kind: 'question', question: endpointQuestion, questionsLeft: 1 }) });
    await handleRequest(ctx, { channel: 'C1', ts: '9.9', text: 'latency of checkout' });
    expect(agent.ask).toHaveBeenCalledWith('latency of checkout', { slack: { channel: 'C1', thread_ts: '9.9' } });
    expect(posted).toMatchObject([{ kind: 'post', payload: { channel: 'C1', thread_ts: '9.9', text: 'Which endpoint?' } }]);
  });

  it('posts a draft as a chart image with its reading, then the query and buttons', async () => {
    const { ctx, posted } = context({ ask: reply({ kind: 'draft', panel, attempts: [] }) });
    await handleRequest(ctx, { channel: 'C1', ts: '9.9', text: 'p95 of pay' });
    expect(posted.map((p) => p.kind)).toEqual(['upload', 'post']);
    expect(posted[0]!.payload).toMatchObject({
      thread_ts: '9.9',
      title: panel.title,
      comment: 'P95 latency was 800 ms most recently, between 500 ms and 800 ms over the last 5 hours.',
    });
    expect((posted[0]!.payload as { png: number }).png).toBeGreaterThan(1000);
  });

  it('marks a question answered by whom, then carries on', async () => {
    const { ctx, posted, agent } = context({
      get: reply({ kind: 'question', question: endpointQuestion, questionsLeft: 1 }),
      answer: reply({ kind: 'question', question: percentileQuestion, questionsLeft: 0 }),
    });
    await handleAnswer(ctx, { requestId: 'r1', value: 'POST /checkout/pay', slackUser: 'U1', channel: 'C1', messageTs: '9.10' });
    expect(agent.answer).toHaveBeenCalledWith('r1', 'POST /checkout/pay');
    expect(posted[0]).toMatchObject({ kind: 'update', payload: { ts: '9.10' } });
    expect(JSON.stringify(posted[0]!.payload)).toContain('<@U1>');
    expect(posted[1]).toMatchObject({ kind: 'post', payload: { thread_ts: '9.9', text: 'Which latency?' } });
  });

  it('tells a late clicker the question is already answered', async () => {
    const { ctx, posted, agent } = context({ get: reply({ kind: 'draft', panel, attempts: [] }) });
    await handleAnswer(ctx, { requestId: 'r1', value: '95', slackUser: 'U2', channel: 'C1', messageTs: '9.10', threadTs: '9.9' });
    expect(agent.answer).not.toHaveBeenCalled();
    expect(posted).toMatchObject([{ kind: 'ephemeral', payload: { user: 'U2', thread_ts: '9.9' } }]);
  });
}); // prettier-ignore
