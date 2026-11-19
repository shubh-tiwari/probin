import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  ModelCallError,
  NoEligibleModelError,
  createMemoryLedger,
  createOpenRouterTransport,
  createRouter,
  loadModels,
  parseModels,
  type CompletionRequest,
  type Eligibility,
  type ModelTransport,
  type ModelsConfig,
} from './index.js';

const config: ModelsConfig = parseModels(`
strategy: table
auto_model: provider/auto
tiers:
  - id: fast
    models:
      - { id: fast-a, input_per_mtok: 1, output_per_mtok: 1 }
      - { id: fast-cheap, input_per_mtok: 0.1, output_per_mtok: 0.1 }
  - id: standard
    models:
      - { id: std-a, input_per_mtok: 2, output_per_mtok: 10 }
      - { id: std-cheap, input_per_mtok: 1, output_per_mtok: 2 }
  - id: strong
    models:
      - { id: strong-a, input_per_mtok: 4, output_per_mtok: 20 }
tasks: { parse: fast, ask: fast, write_query: standard, explain: strong, review: strong }
budget: { near_cap_ratio: 0.8 }
`);

function setup(
  options: {
    limit?: number | null;
    eligibility?: Eligibility | undefined | null;
    config?: ModelsConfig;
    complete?: ModelTransport['complete'];
  } = {},
) {
  const complete = vi.fn<ModelTransport['complete']>(
    options.complete ??
      (async () => ({ content: '{"ok":true}', inputTokens: 1000, outputTokens: 500 })),
  );
  const { ledger, calls } = createMemoryLedger({ limit: options.limit ?? null });
  const router = createRouter({
    config: options.config ?? config,
    eligibility: options.eligibility === undefined ? null : options.eligibility,
    transport: { complete },
    ledger,
  });
  const request = {
    workspaceId: 'w',
    requestId: 'r',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };
  return { router, calls, complete, request };
}

const usedModel = (complete: { mock: { calls: [CompletionRequest][] } }, index = 0) =>
  complete.mock.calls[index]![0].model;

describe('task-type routing', () => {
  it.each([
    ['parse', 'fast-a', 'fast'],
    ['ask', 'fast-a', 'fast'],
    ['write_query', 'std-a', 'standard'],
    ['explain', 'strong-a', 'strong'],
    ['review', 'strong-a', 'strong'],
  ] as const)('%s uses %s (%s tier)', async (task, model, tier) => {
    const { router, complete, request } = setup();
    const reply = await router.call({ ...request, task });
    expect(usedModel(complete)).toBe(model);
    expect(reply).toMatchObject({ model, tier, escalated: false });
  });
});

describe('escalation', () => {
  it('stays on the tier for the first two attempts, then moves to a stronger one', async () => {
    const { router, complete, request } = setup();
    for (const failures of [0, 1, 2, 3]) {
      await router.call({ ...request, task: 'write_query', failures });
    }
    expect(complete.mock.calls.map(([call]) => call.model)).toEqual([
      'std-a',
      'std-a',
      'strong-a',
      'strong-a',
    ]);
  });

  it('records which call it escalated from', async () => {
    const { router, calls, request } = setup();
    const first = await router.call({ ...request, task: 'write_query' });
    const escalated = await router.call({
      ...request,
      task: 'write_query',
      failures: 2,
      previousCallId: first.callId,
    });
    expect(escalated.escalated).toBe(true);
    expect(calls.map((call) => call.escalatedFrom)).toEqual([undefined, first.callId]);
  });

  it('has nowhere to go from the strongest tier', async () => {
    const { router, request } = setup();
    const reply = await router.call({ ...request, task: 'explain', failures: 5 });
    expect(reply).toMatchObject({ tier: 'strong', escalated: false });
  });
});

describe('budget', () => {
  // Each default call costs (1000 * 2 + 500 * 10) / 1e6 = 0.007 on std-a.
  it('uses the first listed model while well under the cap', async () => {
    const { router, complete, request } = setup({ limit: 1 });
    await router.call({ ...request, task: 'write_query' });
    expect(usedModel(complete)).toBe('std-a');
  });

  it('prefers the cheapest eligible model near the cap', async () => {
    const { router, calls, complete, request } = setup({ limit: 1 });
    calls.push({ id: 'old', ...baseCall, cost: 0.85 });
    await router.call({ ...request, task: 'write_query' });
    expect(usedModel(complete)).toBe('std-cheap');
  });

  it('refuses at the cap without calling a model', async () => {
    const { router, calls, complete, request } = setup({ limit: 1 });
    calls.push({ id: 'old', ...baseCall, cost: 1 });
    await expect(router.call({ ...request, task: 'parse' })).rejects.toThrow(BudgetExceededError);
    expect(complete).not.toHaveBeenCalled();
  });

  it('has no cap when the workspace has no limit', async () => {
    const { router, calls, request } = setup({ limit: null });
    calls.push({ id: 'old', ...baseCall, cost: 1_000_000 });
    await expect(router.call({ ...request, task: 'parse' })).resolves.toBeDefined();
  });

  const baseCall = {
    workspaceId: 'w',
    requestId: 'old',
    task: 'parse' as const,
    model: 'x',
    inputTokens: 0,
    outputTokens: 0,
    outcome: 'ok' as const,
  };
});

describe('eligibility', () => {
  const passed = (tiers: Record<string, string[]>): Eligibility => ({ updated: 'test', tiers });

  it('uses only models that passed the test set for the tier', async () => {
    const { router, complete, request } = setup({
      eligibility: passed({ standard: ['std-cheap'] }),
    });
    await router.call({ ...request, task: 'write_query' });
    expect(usedModel(complete)).toBe('std-cheap');
  });

  it('lets a stronger tier stand in when nothing in the tier passed', async () => {
    const { router, request } = setup({ eligibility: passed({ strong: ['strong-a'] }) });
    const reply = await router.call({ ...request, task: 'parse' });
    expect(reply).toMatchObject({ model: 'strong-a', tier: 'strong' });
  });

  it('never falls back to a weaker tier', async () => {
    const { router, request } = setup({ eligibility: passed({ fast: ['fast-a'] }) });
    await expect(router.call({ ...request, task: 'explain' })).rejects.toThrow(
      NoEligibleModelError,
    );
  });

  it('calls nothing when no model has passed yet', async () => {
    const { router, complete, request } = setup({ eligibility: passed({}) });
    await expect(router.call({ ...request, task: 'parse' })).rejects.toThrow(NoEligibleModelError);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('call log', () => {
  it('logs every call with task, model, tokens and cost', async () => {
    const { router, calls, request } = setup();
    await router.call({ ...request, task: 'write_query' });
    expect(calls).toEqual([
      {
        id: 'call-1',
        workspaceId: 'w',
        requestId: 'r',
        task: 'write_query',
        model: 'std-a',
        inputTokens: 1000,
        outputTokens: 500,
        cost: 0.007,
        outcome: 'ok',
        escalatedFrom: undefined,
      },
    ]);
  });

  it("uses the provider's own cost and model when it reports them", async () => {
    const { router, calls, request } = setup({
      complete: async () => ({
        content: 'x',
        model: 'provider/actual',
        inputTokens: 10,
        outputTokens: 10,
        cost: 0.5,
      }),
    });
    const reply = await router.call({ ...request, task: 'parse' });
    expect(reply).toMatchObject({ model: 'provider/actual', cost: 0.5 });
    expect(calls[0]).toMatchObject({ model: 'provider/actual', cost: 0.5 });
  });

  it('logs a failed call, then tries the next model in the tier once', async () => {
    let attempt = 0;
    const { router, calls, request } = setup({
      complete: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('provider down');
        return { content: 'x', inputTokens: 1, outputTokens: 1 };
      },
    });
    const reply = await router.call({ ...request, task: 'write_query' });
    expect(reply.model).toBe('std-cheap');
    expect(calls.map((call) => [call.model, call.outcome])).toEqual([
      ['std-a', 'transport_error'],
      ['std-cheap', 'ok'],
    ]);
  });

  it('gives up with a clear error when the fallback fails too', async () => {
    const { router, calls, request } = setup({
      complete: async () => {
        throw new Error('provider down');
      },
    });
    await expect(router.call({ ...request, task: 'write_query' })).rejects.toThrow(ModelCallError);
    expect(calls.map((call) => call.outcome)).toEqual(['transport_error', 'transport_error']);
  });

  it('lets the caller record how the output fared', async () => {
    const { router, calls, request } = setup();
    const reply = await router.call({ ...request, task: 'write_query' });
    await router.report(reply.callId, 'dry_run_failed');
    expect(calls[0]!.outcome).toBe('dry_run_failed');
  });
});

describe('automatic routing strategy', () => {
  it('sends every task to the auto model', async () => {
    const auto = { ...config, strategy: 'openrouter_auto' as const };
    const { router, complete, request } = setup({ config: auto });
    await router.call({ ...request, task: 'parse' });
    await router.call({ ...request, task: 'explain' });
    expect(complete.mock.calls.map(([call]) => call.model)).toEqual([
      'provider/auto',
      'provider/auto',
    ]);
  });
});

describe('configuration', () => {
  it('loads the example file', () => {
    const path = fileURLToPath(new URL('../../../config/models.example.yaml', import.meta.url));
    const loaded = loadModels(path);
    expect(loaded.tiers.map((tier) => tier.id)).toEqual(['fast', 'standard', 'strong']);
    expect(loaded.eligibility_file).toBeTruthy();
  });

  it('rejects a task mapped to an unknown tier', () => {
    expect(() =>
      parseModels(`
tiers: [{ id: fast, models: [{ id: a, input_per_mtok: 1, output_per_mtok: 1 }] }]
tasks: { parse: fast, ask: fast, write_query: missing, explain: fast, review: fast }
budget: { near_cap_ratio: 0.8 }
`),
    ).toThrow(/unknown tier "missing"/);
  });
});

describe('OpenRouter transport', () => {
  it('sends one chat completion and reads content, tokens and cost', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        model: 'vendor/model-x',
        choices: [{ message: { content: '{"a":1}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 },
      }),
    );
    const transport = createOpenRouterTransport({
      apiKey: 'test-key',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const reply = await transport.complete({
      model: 'vendor/model-x',
      messages: [{ role: 'user', content: 'hi' }],
      json: true,
      maxTokens: 100,
      task: 'parse',
    });
    expect(reply).toEqual({
      content: '{"a":1}',
      model: 'vendor/model-x',
      inputTokens: 12,
      outputTokens: 3,
      cost: 0.0004,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'vendor/model-x',
      response_format: { type: 'json_object' },
      temperature: 0,
    });
  });

  it('turns a provider error into an exception', async () => {
    const transport = createOpenRouterTransport({
      apiKey: 'k',
      fetch: (async () =>
        Response.json(
          { error: { message: 'rate limited' } },
          { status: 429 },
        )) as unknown as typeof fetch,
    });
    await expect(
      transport.complete({ model: 'm', messages: [], json: false, maxTokens: 1, task: 'parse' }),
    ).rejects.toThrow('rate limited');
  });
});
