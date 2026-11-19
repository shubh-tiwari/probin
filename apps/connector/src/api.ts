/** The read-only API the connector uses: the web tool's /api, with an API token. */
export function createReadApi(options: { url: string; token: string; fetch?: typeof fetch }) {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${base}/api${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  }
  return {
    services: () => call<{ services: string[] }>('/v1/services'),
    search: (text: string, service?: string) =>
      call<{ metrics: unknown[]; endpoints: unknown[] }>(
        `/v1/catalog/search?text=${encodeURIComponent(text)}${service ? `&service=${encodeURIComponent(service)}` : ''}`,
      ),
    endpoints: (service: string) =>
      call<{ endpoints: unknown[] }>(`/v1/endpoints?service=${encodeURIComponent(service)}`),
    query: (query: string, range: string) =>
      call<{
        series: { labels: Record<string, string>; points: [number, number][] }[];
        lineCount: number;
        step: number;
      }>('/v1/query', {
        method: 'POST',
        body: JSON.stringify({ query, range }),
      }),
  };
}

export type ReadApi = ReturnType<typeof createReadApi>;
