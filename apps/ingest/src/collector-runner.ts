import { registerManifest } from '@app/catalog';
import { listActiveCollectors, schema, type Database, type StoredCollector } from '@app/db';
import { durationToSeconds } from '@app/specs';
import { WORKSPACE_HEADER } from './app.js';
import { runHttpCheck, type CheckResult } from './http-check.js';

/** All checks of a workspace are one service in its catalog. */
export const CHECKS_SERVICE = 'checks';

const CHECKS_MANIFEST = {
  service: CHECKS_SERVICE,
  description: 'HTTP checks run by approved collectors',
  endpoints: [],
  metrics: [
    {
      name: 'http.check.up',
      type: 'gauge',
      unit: '1',
      description: '1 when the checked URL answered with 2xx or 3xx, otherwise 0',
      attributes: ['check.name'],
    },
    {
      name: 'http.check.duration',
      type: 'gauge',
      unit: 's',
      description: 'Time the checked URL took to answer',
      attributes: ['check.name'],
    },
  ],
};

/** One check result as OTLP/HTTP JSON. */
export function checkToOtlp(name: string, result: CheckResult, at = Date.now()): string {
  const attributes = [{ key: 'check.name', value: { stringValue: name } }];
  const time = `${BigInt(at) * 1_000_000n}`;
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: CHECKS_SERVICE } }] },
        scopeMetrics: [
          {
            scope: { name: 'collector' },
            metrics: [
              {
                name: 'http.check.up',
                unit: '1',
                gauge: {
                  dataPoints: [{ asInt: result.ok ? '1' : '0', timeUnixNano: time, attributes }],
                },
              },
              {
                name: 'http.check.duration',
                unit: 's',
                gauge: {
                  dataPoints: [{ asDouble: result.duration, timeUnixNano: time, attributes }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Runs approved collectors on their intervals. A pending collector is never
 * loaded, so it never runs. Results go to the private collector with the
 * collector's own workspace in the trusted header, like any ingested sample.
 */
export function startCollectorRunner(options: {
  db: Database;
  collectorUrl: string;
  allowPrivate: boolean;
  tickMs?: number;
}) {
  const { db } = options;
  const registered = new Set<string>();

  async function runOne(collector: StoredCollector, now: Date) {
    const url = String(collector.spec.config.url ?? '');
    let result: CheckResult;
    let error: string | null;
    try {
      result = await runHttpCheck(url, { allowPrivate: options.allowPrivate });
      error = result.error ?? null;
    } catch (refused) {
      // The URL became unsafe (for example, its host now resolves to a private address).
      result = { ok: false, status: null, duration: 0 };
      error = refused instanceof Error ? refused.message : String(refused);
    }
    await fetch(`${options.collectorUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKSPACE_HEADER]: collector.workspaceId },
      body: checkToOtlp(collector.spec.name, result, now.getTime()),
    });
    if (!registered.has(collector.workspaceId)) {
      await registerManifest(db, collector.workspaceId, CHECKS_MANIFEST);
      registered.add(collector.workspaceId);
    }
    const values = {
      workspaceId: collector.workspaceId,
      lastRunAt: now,
      lastStatus: result.status,
      lastError: error,
    };
    await db
      .insert(schema.collectorStates)
      .values({ collectorId: collector.id, ...values })
      .onConflictDoUpdate({ target: schema.collectorStates.collectorId, set: values });
  }

  async function tick() {
    const now = new Date();
    const active = await listActiveCollectors(db);
    const states = new Map(
      (await db.select().from(schema.collectorStates)).map((row) => [
        row.collectorId,
        row.lastRunAt,
      ]),
    );
    await Promise.all(
      active
        .filter((c) => {
          const last = states.get(c.id);
          return (
            !last ||
            now.getTime() - last.getTime() >= durationToSeconds(c.spec.interval) * 1000 - 500
          );
        })
        .map((c) => runOne(c, now).catch((error) => console.error(`collector ${c.id}`, error))),
    );
  }

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    await tick().catch((error) => console.error('collector runner', error));
    running = false;
  }, options.tickMs ?? 5000);
  return { stop: () => clearInterval(timer), tick };
}
