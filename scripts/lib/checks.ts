/** Small helpers shared by the phase acceptance scripts. */

export class CheckFailed extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

/** Retry a check until it passes or the wait runs out. */
export async function eventually<T>(
  check: () => Promise<T>,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<T> {
  const waitMs = options.waitMs ?? 120_000;
  const pollMs = options.pollMs ?? 3_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() + pollMs > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export interface CheckRun {
  step(name: string, run: () => Promise<string>): Promise<void>;
  /** Prints the verdict and returns the process exit code. */
  finish(label: string): number;
}

export function createCheckRun(): CheckRun {
  const results: { name: string; ok: boolean }[] = [];
  return {
    async step(name, run) {
      try {
        const detail = await run();
        results.push({ name, ok: true });
        console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
      } catch (error) {
        results.push({ name, ok: false });
        console.log(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    finish(label) {
      const failed = results.filter((result) => !result.ok).length;
      console.log(
        failed === 0
          ? `\n${label}: ${results.length} of ${results.length} checks passed.\n`
          : `\n${label}: ${failed} of ${results.length} checks FAILED.\n`,
      );
      return failed === 0 ? 0 : 1;
    },
  };
}

export type Labels = Record<string, string>;

export const labelValues = (series: Labels[], label: string) =>
  [...new Set(series.map((one) => one[label]).filter((v): v is string => v !== undefined))].sort();

/** An instant query straight at the metrics store. Only acceptance scripts may do this. */
export async function storeQuery(
  storeUrl: string,
  query: string,
): Promise<{ metric: Labels; value: number }[]> {
  const response = await fetch(`${storeUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
  assert(response.ok, `metrics store returned HTTP ${response.status} for ${query}`);
  const body = (await response.json()) as {
    status: string;
    data: { result: { metric: Labels; value: [number, string] }[] };
  };
  assert(body.status === 'success', `metrics store rejected the query ${query}`);
  return body.data.result.map((row) => ({ metric: row.metric, value: Number(row.value[1]) }));
}

/** One gauge sample as an OTLP/HTTP JSON body. */
export function otlpGauge(options: {
  service: string;
  metric: string;
  value: number;
  resourceAttributes?: Record<string, string>;
}): string {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute('service.name', options.service),
            ...Object.entries(options.resourceAttributes ?? {}).map(([k, v]) => attribute(k, v)),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'verify' },
            metrics: [
              {
                name: options.metric,
                gauge: {
                  dataPoints: [
                    {
                      asDouble: options.value,
                      timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Send an OTLP body to the ingestion endpoint. Returns the HTTP status. */
export async function sendOtlp(ingestUrl: string, key: string | undefined, body: string) {
  const response = await fetch(`${ingestUrl}/v1/metrics`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body,
  });
  return response.status;
}
