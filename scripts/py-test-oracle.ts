/**
 * The TypeScript rules, for the Python agent's unit tests.
 *
 * In production the Python agent reaches catalog ranking, PromQL analysis and
 * spec validation through the platform service. Its unit tests run without
 * the stack, so they start this process once and ask it the same questions
 * over stdin and stdout, one JSON object per line. That keeps one
 * implementation of each rule, in one language.
 *
 *   {"op": "rank", "catalog": {...}, "search": {"text": "...", "service"?: "..."}}
 *   {"op": "analyze", "query": "..."}
 *   {"op": "validate", "kind": "panel" | "alert" | "collector", "spec": {...}}
 *   {"op": "constants"}
 */
import { createInterface } from 'node:readline';
import {
  HTTP_CLIENT_DURATION,
  HTTP_SERVER_DURATION,
  METHOD_LABEL,
  ROUTE_LABEL,
  SERVICE_LABEL,
  STATUS_LABEL,
  rankCatalog,
  storedSeriesNames,
  type CatalogContents,
} from '@app/catalog';
import { PromqlError, analyze, extractNames } from '@app/promql';
import { parseDraftAlertRuleSpec, parseDraftCollectorSpec, parsePanelSpec } from '@app/specs';

const PARSERS = {
  panel: parsePanelSpec,
  alert: parseDraftAlertRuleSpec,
  collector: parseDraftCollectorSpec,
} as const;

function answer(request: Record<string, unknown>): unknown {
  switch (request.op) {
    case 'rank': {
      const catalog = request.catalog as CatalogContents;
      return rankCatalog(catalog, request.search as { text: string; service?: string });
    }
    case 'analyze': {
      const query = String(request.query);
      try {
        return { ok: true, ...analyze(query), names: extractNames(query) };
      } catch (error) {
        if (error instanceof PromqlError)
          return { ok: false, reason: error.reason, error: error.message };
        throw error;
      }
    }
    case 'validate': {
      try {
        return { ok: true, spec: PARSERS[request.kind as keyof typeof PARSERS](request.spec) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
    case 'series': {
      return storedSeriesNames(String(request.name), request.type as 'histogram');
    }
    case 'constants':
      return {
        SERVICE_LABEL,
        METHOD_LABEL,
        ROUTE_LABEL,
        STATUS_LABEL,
        HTTP_SERVER_DURATION,
        HTTP_CLIENT_DURATION,
      };
    default:
      throw new Error(`Unknown op ${String(request.op)}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let reply: unknown;
  try {
    reply = { result: answer(JSON.parse(line) as Record<string, unknown>) };
  } catch (error) {
    reply = { error: (error as Error).message };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
