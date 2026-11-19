import { randomUUID } from 'node:crypto';
import { listMetrics } from '@app/catalog';
import { createAlertStore, schema, type Database } from '@app/db';
import { formatValue, displayUnit, seriesName } from '@app/charts';
import { createMemory } from '@app/memory';
import { createQueryApiClient } from '@app/query-api/client';
import type { Router } from '@app/router';
import { eq } from 'drizzle-orm';
import {
  measureChanges,
  rankChanges,
  relatedQueries,
  writeHypothesis,
  type Explanation,
} from './explain.js';

/** How far back the explanation looks, and how much of that is "after". */
const WINDOW = '2h';
const WINDOW_SECONDS = 7200;

/**
 * explain_series for an alert: the rule's own query and the related series of
 * its service over the last two hours, split at the moment the alert started.
 * The result is a hypothesis with the charts behind it, and it is added to the
 * incident in memory.
 */
export async function explainRule(options: {
  db: Database;
  router: Router;
  workspaceId: string;
  ruleId: string;
  queryApiUrl: string;
  internalToken: string;
}): Promise<Explanation | undefined> {
  const { db, workspaceId } = options;
  const rule = await createAlertStore(db, workspaceId).current(options.ruleId);
  if (!rule) return undefined;
  const [state] = await db
    .select()
    .from(schema.alertStates)
    .where(eq(schema.alertStates.ruleId, rule.id))
    .limit(1);
  const now = Math.floor(Date.now() / 1000);
  const pivot = state?.since ? Math.floor(state.since.getTime() / 1000) : now - WINDOW_SECONDS / 4;

  const query = createQueryApiClient({
    url: options.queryApiUrl,
    internalToken: options.internalToken,
    workspaceId,
  });
  const sources = [
    ...(rule.spec.query
      ? [
          {
            title: rule.spec.name.replace(/ (above|below) .*$/, ''),
            query: rule.spec.query,
            unit: rule.spec.unit ?? '',
            ...(rule.spec.display_unit ? { display_unit: rule.spec.display_unit } : {}),
          },
        ]
      : []),
    ...(rule.spec.service
      ? relatedQueries(rule.spec.service, await listMetrics(db, workspaceId, rule.spec.service))
      : []),
  ];
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        return measureChanges(
          source,
          await query.query({ query: source.query, range: WINDOW, step: 60 }),
          pivot,
        );
      } catch {
        return [];
      }
    }),
  );
  const ranked = rankChanges(results.flat()).slice(0, 5);
  const describe = (c: (typeof ranked)[number]) => {
    const unit = displayUnit(c.unit, c.display_unit);
    const which = seriesName(c.labels);
    return {
      series: which === 'all' ? c.title : `${c.title} (${which})`,
      before: formatValue(c.before, unit),
      after: formatValue(c.after, unit),
    };
  };
  const { text } = await writeHypothesis(options.router, {
    workspaceId,
    requestId: randomUUID(),
    alertName: rule.spec.name,
    changes: ranked.map(describe),
  });

  const charts = [...new Map(ranked.map((c) => [c.query, c])).values()].slice(0, 2).map((c) => ({
    title: c.title,
    query: c.query,
    unit: c.unit,
    ...(c.display_unit ? { display_unit: c.display_unit } : {}),
    range: WINDOW,
  }));

  // Remember it with the incident, so Review and later explanations can see it.
  await createMemory(db, workspaceId).write(
    {
      kind: 'incident',
      subject: rule.spec.name,
      text,
      source: `explanation of alert rule ${rule.id}`,
      value: { ruleId: rule.id },
    },
    { kind: 'agent', id: 'agent' },
  );
  return { hypothesis: text, charts, changes: ranked };
}
