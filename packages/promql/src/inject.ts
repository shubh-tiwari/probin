import { PromqlError, analyze } from './analyze.js';

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Kept strict on purpose: the value is written into the query text. */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]+$/;

/**
 * Rewrite a query so every series selector also requires `label="value"`.
 *
 * This is how workspace isolation is enforced for metrics: the Query API
 * calls it on every query before the store sees it. It fails closed.
 *
 *   - A query that does not parse is refused.
 *   - A query that mentions the label at all is refused, whether in a matcher,
 *     a grouping clause or a relabelling function. A caller never needs to
 *     name it, so naming it is either a mistake or an attempt to get around
 *     the rewrite.
 *   - Every selector gets the matcher, including ones with no metric name.
 */
export function injectLabel(query: string, label: string, value: string): string {
  if (!LABEL_NAME.test(label)) {
    throw new Error(`Cannot inject "${label}": not a valid label name.`);
  }
  if (!SAFE_VALUE.test(value)) {
    throw new Error(`Cannot inject ${label}="${value}": the value has unsafe characters.`);
  }
  const analysis = analyze(query);
  if (analysis.labels.includes(label)) {
    throw new PromqlError(`A query may not refer to the "${label}" label.`, 'forbidden');
  }

  const matcher = `${label}="${value}"`;
  let rewritten = query;
  // Apply edits from the end so earlier positions stay valid.
  const selectors = [...analysis.selectors].sort((a, b) => b.insert.at - a.insert.at);
  for (const { insert } of selectors) {
    const text =
      insert.braces === 'none'
        ? `{${matcher}}`
        : insert.braces === 'empty'
          ? matcher
          : `${matcher},`;
    rewritten = rewritten.slice(0, insert.at) + text + rewritten.slice(insert.at);
  }

  // Check the result instead of trusting the edit: it must still parse, and
  // every selector in it must carry exactly the matcher we added.
  const check = analyze(rewritten);
  const covered =
    check.selectors.length === analysis.selectors.length &&
    check.selectors.every(
      (selector) =>
        selector.matchers.filter((m) => m.label === label).length === 1 &&
        selector.matchers.some((m) => m.label === label && m.op === '=' && m.value === value),
    );
  if (!covered) {
    throw new PromqlError(`Could not scope the query to ${label}.`, 'forbidden');
  }
  return rewritten;
}
