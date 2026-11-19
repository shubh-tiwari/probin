/** Drives the fake Slack (apps/slack/src/fake) the way a person would. For acceptance scripts. */

export interface ThreadMessage {
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  blocks?: {
    type: string;
    block_id?: string;
    elements?: {
      type: string;
      action_id: string;
      text?: { text: string };
      options?: { value: string; text: { text: string } }[];
    }[];
    text?: { text: string };
  }[];
  files?: { id: string; title: string; url: string; bytes: number }[];
  visibleTo?: string;
  edited?: boolean;
  postedAt: number;
}

export function fakeSlack(baseUrl: string) {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<Record<string, unknown>>;
  };
  return {
    mention: (
      text: string,
      extra: { team?: string; user?: string; channel?: string; thread_ts?: string } = {},
    ) =>
      post('/fake/mention', { text, ...extra }) as Promise<{
        ts: string;
        channel: string;
        status: number;
      }>,
    dm: (text: string, extra: { team?: string; user?: string } = {}) =>
      post('/fake/dm', { text, ...extra }) as Promise<{
        ts: string;
        channel: string;
        status: number;
      }>,
    click: (input: {
      message_ts: string;
      channel?: string;
      action_id?: string;
      label?: string;
      option?: string;
      user?: string;
      team?: string;
    }) => post('/fake/click', input),
    async thread(channel: string, threadTs: string, user?: string): Promise<ThreadMessage[]> {
      const url = new URL(`${baseUrl}/fake/thread`);
      url.searchParams.set('channel', channel);
      url.searchParams.set('thread_ts', threadTs);
      if (user) url.searchParams.set('user', user);
      return ((await (await fetch(url)).json()) as { messages: ThreadMessage[] }).messages;
    },
    /** Wait until the thread has a message matching `test`, and return it. */
    async waitFor(
      channel: string,
      threadTs: string,
      test: (m: ThreadMessage) => boolean,
      timeoutMs = 30_000,
    ): Promise<ThreadMessage> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = (await this.thread(channel, threadTs)).find(test);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('timed out waiting for a reply in the thread');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    },
  };
}

export const hasActions = (m: ThreadMessage) => (m.blocks ?? []).some((b) => b.type === 'actions');
export const hasFile = (m: ThreadMessage) => (m.files?.length ?? 0) > 0;
