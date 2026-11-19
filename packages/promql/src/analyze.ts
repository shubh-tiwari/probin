import { parser } from '@prometheus-io/lezer-promql';
import type { SyntaxNode } from '@lezer/common';

export class PromqlError extends Error {
  override name = 'PromqlError';
  constructor(
    message: string,
    /** Why the query was refused, for callers that branch on it. */
    readonly reason: 'syntax' | 'forbidden',
  ) {
    super(message);
  }
}

export type MatchOp = '=' | '!=' | '=~' | '!~';

export interface Matcher {
  label: string;
  op: MatchOp;
  value: string;
}

/** One series selector in a query, e.g. `http_requests_total{job="api"}`. */
export interface Selector {
  /** The metric this selector names exactly, or undefined when it matches by pattern or not at all. */
  metric: string | undefined;
  /** Matchers other than the metric name. */
  matchers: Matcher[];
  /** Character range of the selector in the query. */
  from: number;
  to: number;
  /** Where a new matcher goes: just inside `{`, or after the metric name when there are no braces. */
  insert: { at: number; braces: 'none' | 'empty' | 'filled' };
}

export interface Analysis {
  query: string;
  selectors: Selector[];
  /**
   * Every label name the query mentions: in matchers, in `by` / `without` /
   * `on` / `ignoring` / `group_left` / `group_right`, and as a label argument
   * of `label_replace` and `label_join`.
   */
  labels: string[];
  /** Function names the query calls, lower case. */
  functions: string[];
}

/**
 * Functions that read series the query does not name in a selector.
 * `info()` joins in `target_info` series implicitly, so a rewrite of the
 * visible selectors would not cover it.
 */
const FORBIDDEN_FUNCTIONS = new Set(['info']);

const unquote = (literal: string): string => {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === '`') return body;
  return body.replace(/\\(.)/g, (_, char: string) => {
    if (char === 'n') return '\n';
    if (char === 't') return '\t';
    return char;
  });
};

/**
 * Parse a PromQL query and describe what it reads.
 *
 * Fails closed: a query with any syntax error throws, so callers never act on
 * a partial understanding of a query.
 */
export function analyze(query: string): Analysis {
  if (query.trim() === '') {
    throw new PromqlError('The query is empty.', 'syntax');
  }
  const tree = parser.parse(query);
  const text = (node: SyntaxNode) => query.slice(node.from, node.to);

  const selectors: Selector[] = [];
  const labels = new Set<string>();
  const functions = new Set<string>();

  const readSelector = (node: SyntaxNode): Selector => {
    let metric: string | undefined;
    let metricIsExact = true;
    const matchers: Matcher[] = [];
    const identifier = node.getChild('Identifier');
    if (identifier) metric = text(identifier);

    const block = node.getChild('LabelMatchers');
    let braces: Selector['insert']['braces'] = 'none';
    if (block) {
      braces = 'empty';
      for (let child = block.firstChild; child; child = child.nextSibling) {
        braces = 'filled';
        if (child.name === 'QuotedLabelName') {
          // `{"metric.name", ...}`: a bare quoted name is the metric name.
          const literal = child.getChild('StringLiteral');
          if (literal) metric = unquote(text(literal));
          continue;
        }
        if (child.name !== 'UnquotedLabelMatcher' && child.name !== 'QuotedLabelMatcher') continue;
        const nameNode =
          child.getChild('LabelName') ??
          child.getChild('QuotedLabelName')?.getChild('StringLiteral');
        const opNode = child.getChild('MatchOp');
        const valueNode = child.getChild('StringLiteral');
        if (!nameNode || !opNode || !valueNode) continue;
        const label = nameNode.name === 'StringLiteral' ? unquote(text(nameNode)) : text(nameNode);
        const op = text(opNode) as MatchOp;
        const value = unquote(text(valueNode));
        if (label === '__name__') {
          if (op === '=' && metric === undefined) metric = value;
          else metricIsExact = false;
          continue;
        }
        labels.add(label);
        matchers.push({ label, op, value });
      }
    }
    return {
      metric: metricIsExact ? metric : undefined,
      matchers,
      from: node.from,
      to: node.to,
      insert: block
        ? { at: block.from + 1, braces }
        : { at: identifier ? identifier.to : node.to, braces: 'none' },
    };
  };

  tree.iterate({
    enter(ref) {
      if (ref.type.isError) {
        const near = query.slice(Math.max(0, ref.from - 20), ref.from + 20).trim();
        throw new PromqlError(
          `The query is not valid PromQL (near position ${ref.from}: "${near}").`,
          'syntax',
        );
      }
      const node = ref.node;
      switch (ref.name) {
        case 'VectorSelector':
          selectors.push(readSelector(node));
          break;
        case 'GroupingLabels':
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'LabelName') labels.add(text(child));
            if (child.name === 'QuotedLabelName') {
              const literal = child.getChild('StringLiteral');
              if (literal) labels.add(unquote(text(literal)));
            }
          }
          break;
        case 'FunctionCall': {
          const identifier = node.getChild('FunctionIdentifier');
          const name = identifier ? text(identifier).toLowerCase() : '';
          functions.add(name);
          if (name === 'label_replace' || name === 'label_join') {
            // label_replace(v, dst, replacement, src, regex)
            // label_join(v, dst, separator, src...)
            const args = node.getChild('FunctionCallBody')?.getChildren('StringLiteral') ?? [];
            const labelArguments =
              name === 'label_replace' ? [args[0], args[2]] : [args[0], ...args.slice(2)];
            for (const argument of labelArguments) {
              if (argument) labels.add(unquote(text(argument)));
            }
          }
          break;
        }
      }
    },
  });

  for (const name of functions) {
    if (FORBIDDEN_FUNCTIONS.has(name)) {
      throw new PromqlError(`The function ${name}() is not allowed.`, 'forbidden');
    }
  }

  return { query, selectors, labels: [...labels].sort(), functions: [...functions].sort() };
}

export interface QueryNames {
  /** Metric names selected exactly. */
  metrics: string[];
  /** Every label name the query mentions. */
  labels: string[];
  /** Selectors that do not name one exact metric (`{job="x"}`, `{__name__=~"http.*"}`). */
  unnamedSelectors: string[];
}

/** The metric and label names a query uses, for checking them against the catalog. */
export function extractNames(query: string): QueryNames {
  const analysis = analyze(query);
  const metrics = new Set<string>();
  const unnamedSelectors: string[] = [];
  for (const selector of analysis.selectors) {
    if (selector.metric === undefined)
      unnamedSelectors.push(query.slice(selector.from, selector.to));
    else metrics.add(selector.metric);
  }
  return { metrics: [...metrics].sort(), labels: analysis.labels, unnamedSelectors };
}
