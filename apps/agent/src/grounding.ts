import { PromqlError, extractNames } from '@app/promql';

export interface AllowedNames {
  /** Stored series names the catalog search returned. */
  metrics: string[];
  /** Stored label names the catalog search returned. */
  labels: string[];
}

export type GroundingResult =
  | { ok: true }
  | {
      ok: false;
      /** Names the query used that are not in the catalog, e.g. `metric: foo`, `label: bar`. */
      violations: string[];
      message: string;
    };

/**
 * Catalog grounding, in code.
 *
 * A generated query may only use metric and label names that `search_catalog`
 * returned. This function is the rule; the prompt asking the model to behave
 * is only a courtesy. It fails closed: a query it cannot parse, or a selector
 * that does not name one exact metric, is a violation.
 */
export function checkGrounding(query: string, allowed: AllowedNames): GroundingResult {
  let names;
  try {
    names = extractNames(query);
  } catch (error) {
    if (error instanceof PromqlError) {
      return { ok: false, violations: [], message: error.message };
    }
    throw error;
  }

  const metrics = new Set(allowed.metrics);
  const labels = new Set(allowed.labels);
  const violations = [
    ...names.metrics.filter((name) => !metrics.has(name)).map((name) => `metric: ${name}`),
    ...names.labels.filter((name) => !labels.has(name)).map((name) => `label: ${name}`),
    ...names.unnamedSelectors.map((selector) => `selector without one exact metric: ${selector}`),
  ];
  if (violations.length === 0) return { ok: true };
  return {
    ok: false,
    violations,
    message: `The query uses names that are not in the catalog: ${violations.join('; ')}.`,
  };
}
