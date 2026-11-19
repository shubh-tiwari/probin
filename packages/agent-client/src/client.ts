import type { AgentReply } from './types.js';

export * from './types.js';

export class AgentApiError extends Error {
  override name = 'AgentApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A client for the agent service, acting for one person in one workspace. */
export function createAgentClient(options: {
  url: string;
  internalToken: string;
  workspaceId: string;
  userId: string;
  fetch?: typeof fetch;
}) {
  const doFetch = options.fetch ?? fetch;
  async function post(path: string, body: unknown): Promise<AgentReply> {
    const response = await doFetch(`${options.url}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.internalToken}`,
        'content-type': 'application/json',
        'x-workspace-id': options.workspaceId,
        'x-user-id': options.userId,
      },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => undefined)) as
      (AgentReply & { error?: string }) | undefined;
    if (!response.ok || !parsed) {
      throw new AgentApiError(response.status, parsed?.error ?? `agent HTTP ${response.status}`);
    }
    return parsed;
  }
  async function get(path: string): Promise<AgentReply> {
    const response = await doFetch(`${options.url}${path}`, {
      headers: {
        authorization: `Bearer ${options.internalToken}`,
        'x-workspace-id': options.workspaceId,
        'x-user-id': options.userId,
      },
    });
    const parsed = (await response.json().catch(() => undefined)) as
      (AgentReply & { error?: string }) | undefined;
    if (!response.ok || !parsed) {
      throw new AgentApiError(response.status, parsed?.error ?? `agent HTTP ${response.status}`);
    }
    return parsed;
  }
  return {
    /** Send a request in plain language. `surface` says where to reply, e.g. a Slack thread. */
    ask: (text: string, surface?: Record<string, unknown>) =>
      post('/v1/requests', surface ? { text, surface } : { text }),
    /** "Alert me on this": a pending alert rule from the request's chart. */
    alert: (
      requestId: string,
      options: { op?: '>' | '<'; threshold?: number; for?: string; channel?: string } = {},
    ) => post(`/v1/requests/${requestId}/alert`, options),
    /** "Why did this happen?" for an alert rule. */
    explain: async (ruleId: string) =>
      (await post('/v1/explain', { ruleId })) as unknown as {
        hypothesis: string;
        charts: {
          title: string;
          query: string;
          unit: string;
          display_unit?: string;
          range: string;
        }[];
      },
    /** Change an existing chart: from a conversation (`requestId`) or a saved panel (`panelId`). */
    refine: (
      base: { requestId: string } | { panelId: string },
      text: string,
      surface?: Record<string, unknown>,
    ) => post('/v1/refine', { ...base, text, ...(surface ? { surface } : {}) }),
    /** The latest chart in a Slack thread. */
    inThread: (channel: string, threadTs: string) =>
      get(`/v1/threads/${encodeURIComponent(channel)}/${encodeURIComponent(threadTs)}`),
    /** A request as it stands. */
    get: (requestId: string) => get(`/v1/requests/${requestId}`),
    /** Save the request's answers as the asker's defaults ("Skip questions next time"). */
    remember: async (requestId: string) =>
      (await post(`/v1/requests/${requestId}/remember`, {})) as unknown as {
        saved: number;
        answers: Record<string, unknown>;
      },
    /** Answer the open question with one of its option values. */
    answer: (requestId: string, value: string) =>
      post(`/v1/requests/${requestId}/answer`, { value }),
    /** Save the draft panel. */
    confirm: (requestId: string, dashboardId?: string) =>
      post(`/v1/requests/${requestId}/confirm`, dashboardId ? { dashboardId } : {}),
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
