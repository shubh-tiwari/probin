import type { CompletionRequest, CompletionResponse, ModelTransport } from './types.js';

/**
 * The OpenRouter transport. This file is the only provider-specific code in
 * the product: it speaks OpenRouter's chat completions API and nothing else
 * knows that API exists.
 */
export function createOpenRouterTransport(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): ModelTransport {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

  return {
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: 0,
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          // Ask for the cost of this call in the response.
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });

      const body = (await response.json().catch(() => undefined)) as
        | {
            model?: string;
            choices?: { message?: { content?: string | null } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
            error?: { message?: string };
          }
        | undefined;
      if (!response.ok || body?.error) {
        throw new Error(body?.error?.message ?? `provider returned HTTP ${response.status}`);
      }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content === '') {
        throw new Error('provider returned no content');
      }
      return {
        content,
        ...(body?.model ? { model: body.model } : {}),
        inputTokens: body?.usage?.prompt_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? 0,
        ...(typeof body?.usage?.cost === 'number' ? { cost: body.usage.cost } : {}),
      };
    },
  };
}
