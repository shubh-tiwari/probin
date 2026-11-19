/**
 * Runs the query test set: every request in cases.yaml goes through the real
 * agent loop, against the running stack's catalog and Query API.
 *
 *   pnpm evals:query                      all cases, with the configured models
 *   pnpm evals:query --only <id>          one case
 *   pnpm evals:query --gate               also fail unless the 90% gate is met
 *   pnpm evals:query --model <id>         every task on one model
 *   pnpm evals:query --strategy auto      OpenRouter's own routing instead of the table
 *   pnpm evals:query --record-eligibility test each candidate model, write evals/eligibility.json
 *   pnpm evals:query --json <file>        write the full results
 *
 * With no model key it runs on the built-in stand-in, which costs nothing and
 * exercises the loop and its guards; its pass rate is not the product's.
 * With a key it calls real models and needs EVAL_BUDGET (a spend cap in the
 * plans file's currency) to be set.
 *
 * Always enforced, whatever the model: no delivered query uses a name outside
 * the catalog, every delivered query passed a dry run, and no request asks
 * more than two questions.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  MAX_QUESTIONS,
  advance,
  checkGrounding,
  chooseModels,
  createBackends,
  newRequest,
  type AgentOutput,
  type AgentState,
  type LoopDependencies,
} from '@app/agent';
import { loadEnv } from '@app/config';
import { connect } from '@app/db';
import { createQueryApiClient, type QueryApiClient, type QueryResult } from '@app/query-api/client';
import {
  createMemoryLedger,
  createOpenRouterTransport,
  createRouter,
  loadModels,
  parseModels,
  type ModelsConfig,
} from '@app/router';
import { loadCases, type EvalCase } from './cases.js';

const GATE = 0.9;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const { values } = parseArgs({
  options: {
    cases: { type: 'string', default: here('./cases.yaml') },
    only: { type: 'string' },
    gate: { type: 'boolean', default: false },
    model: { type: 'string' },
    strategy: { type: 'string' },
    'record-eligibility': { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});

const env = loadEnv([
  'DATABASE_URL',
  'QUERY_API_URL',
  'INTERNAL_API_TOKEN',
  'DEV_WORKSPACE_ID',
  'MODELS_FILE',
  'OPENROUTER_API_KEY',
  'DEFAULT_DASHBOARD_RANGE',
]);
const workspaceId = env.DEV_WORKSPACE_ID;
const live = Boolean(env.OPENROUTER_API_KEY);
const budget = process.env.EVAL_BUDGET ? Number(process.env.EVAL_BUDGET) : undefined;
if (live && !(budget !== undefined && budget > 0)) {
  console.error(
    'A model key is set, so this run spends money. Set EVAL_BUDGET to a spend cap first.',
  );
  process.exit(2);
}
if (!live && (values.model || values.strategy || values['record-eligibility'])) {
  console.error('--model, --strategy and --record-eligibility need OPENROUTER_API_KEY.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

export interface CaseResult {
  id: string;
  request: string;
  outcome: AgentOutput['kind'];
  /** Why the case did not pass. Empty: it passed. */
  problems: string[];
  /** Rules that must always hold which this run broke. Should always be empty. */
  ruleBreaks: string[];
  attempts: number;
  firstAttemptPassed: boolean;
  /** Attempts whose raw model output used a name outside the catalog (caught in code). */
  rawUngrounded: number;
  questions: string[];
  query?: string;
  cost: number;
}

const mean = (points: [number, number][]) =>
  points.length === 0 ? NaN : points.reduce((sum, point) => sum + point[1], 0) / points.length;
const key = (labels: Record<string, string>) => JSON.stringify(Object.entries(labels).sort());

/** Whether two results show the same data: same lines, each with about the same average. */
function sameData(a: QueryResult, b: QueryResult): string | undefined {
  if (a.lineCount !== b.lineCount) return `${a.lineCount} lines, the reference has ${b.lineCount}`;
  const reference = new Map(b.series.map((series) => [key(series.labels), series]));
  for (const series of a.series) {
    // With one line on each side the labels need not match; with more they must.
    const other = a.lineCount === 1 ? b.series[0] : reference.get(key(series.labels));
    if (!other) return `no reference line for ${key(series.labels)}`;
    const [x, y] = [mean(series.points), mean(other.points)];
    const bothEmpty = Number.isNaN(x) && Number.isNaN(y);
    const close = bothEmpty || Math.abs(x - y) <= Math.max(0.001 * Math.abs(y), 1e-9);
    if (!close) return `average ${x.toPrecision(4)}, the reference gives ${y.toPrecision(4)}`;
  }
  return undefined;
}

async function runCase(
  one: EvalCase,
  deps: LoopDependencies,
  queryApi: QueryApiClient,
): Promise<CaseResult> {
  const state: AgentState = newRequest({ workspaceId, userId: 'evals', text: one.request });
  const problems: string[] = [];
  const ruleBreaks: string[] = [];

  let output = await advance(state, { type: 'start' }, deps);
  while (output.kind === 'question') {
    const { question } = output;
    let answer = one.answers[question.id];
    if (answer === undefined) {
      problems.push(`asked “${question.text}”, which the case does not expect`);
      answer = question.options.at(-1)!.value;
    }
    if (!question.options.some((option) => option.value === answer)) {
      problems.push(`“${answer}” is not offered for “${question.text}”`);
      answer = question.options.at(-1)!.value;
    }
    output = await advance(state, { type: 'answer', value: answer }, deps);
  }

  // Rules that must always hold.
  if (state.questionsAsked.length > MAX_QUESTIONS) {
    ruleBreaks.push(`asked ${state.questionsAsked.length} questions`);
  }
  if (output.kind === 'draft') {
    if (!state.testedQueries.includes(output.panel.query)) {
      ruleBreaks.push('the delivered query did not pass a dry run');
    }
    const grounding = checkGrounding(output.panel.query, state.allowed);
    if (!grounding.ok)
      ruleBreaks.push(`delivered a query outside the catalog: ${grounding.message}`);
  }

  // What this case expects.
  const { expect } = one;
  if (output.kind !== expect.outcome) {
    const detail =
      output.kind === 'no_match' || output.kind === 'failed' ? `: ${output.message}` : '';
    problems.push(`ended as ${output.kind}, expected ${expect.outcome}${detail}`);
  }
  if (expect.asks && expect.asks.join() !== state.questionsAsked.join()) {
    problems.push(
      `asked [${state.questionsAsked.join(', ')}], expected [${expect.asks.join(', ')}]`,
    );
  }
  if (output.kind === 'draft' && expect.outcome === 'draft') {
    const { panel } = output;
    if (expect.range !== undefined && (panel.range ?? null) !== expect.range) {
      problems.push(`range is ${panel.range ?? 'none'}, expected ${expect.range ?? 'none'}`);
    }
    if (expect.type && panel.type !== expect.type) {
      problems.push(`chart type is ${panel.type}, expected ${expect.type}`);
    }
    for (const assumption of expect.assumptions ?? []) {
      if (!panel.assumptions.includes(assumption)) problems.push(`does not state “${assumption}”`);
    }
    try {
      // Both queries are evaluated over exactly the same window, so equal
      // queries give equal numbers however fast the data is changing.
      const range = panel.range ?? env.DEFAULT_DASHBOARD_RANGE;
      const end = Math.floor(Date.now() / 1000) - 30;
      const [got, wanted] = await Promise.all([
        queryApi.query({ query: panel.query, range, end }),
        queryApi.query({ query: expect.reference!, range, end }),
      ]);
      const difference = sameData(got, wanted);
      if (difference) problems.push(`shows different data from the reference: ${difference}`);
    } catch (error) {
      problems.push(`could not compare with the reference: ${(error as Error).message}`);
    }
  }

  return {
    id: one.id,
    request: one.request,
    outcome: output.kind,
    problems,
    ruleBreaks,
    attempts: state.attempts.length,
    firstAttemptPassed: state.attempts.length > 0 && state.attempts[0]!.failure === undefined,
    rawUngrounded: state.attempts.filter((attempt) => attempt.ungrounded?.length).length,
    questions: state.questionsAsked,
    ...(output.kind === 'draft' ? { query: output.panel.query } : {}),
    cost: state.cost,
  };
}

// ---------------------------------------------------------------------------
// One run of the whole set
// ---------------------------------------------------------------------------

export interface RunSummary {
  label: string;
  cases: number;
  passed: number;
  /** Of the cases that expect a draft: how many passed the dry run on the first attempt. */
  draftCases: number;
  firstAttempt: number;
  firstAttemptRate: number;
  rawUngrounded: number;
  ruleBreaks: number;
  cost: number;
  results: CaseResult[];
}

/** Every task on one model, for testing that model on its own. */
function singleModel(model: string, base: ModelsConfig): ModelsConfig {
  const entry = base.tiers.flatMap((tier) => tier.models).find((one) => one.id === model);
  return parseModels(
    JSON.stringify({
      tiers: [
        { id: 'only', models: [entry ?? { id: model, input_per_mtok: 0, output_per_mtok: 0 }] },
      ],
      tasks: { parse: 'only', ask: 'only', write_query: 'only', explain: 'only', review: 'only' },
      budget: { near_cap_ratio: 1 },
    }),
  );
}

async function runSet(
  label: string,
  cases: EvalCase[],
  models: { config: ModelsConfig; transport: ReturnType<typeof chooseModels>['transport'] },
  shared: {
    db: ReturnType<typeof connect>['db'];
    queryApi: QueryApiClient;
    spent: { total: number };
  },
): Promise<RunSummary> {
  const { ledger } = createMemoryLedger({
    limit: budget === undefined ? null : Math.max(0, budget - shared.spent.total),
  });
  const deps: LoopDependencies = {
    // The test set is what makes a model eligible, so eligibility is not enforced here.
    router: createRouter({
      config: models.config,
      eligibility: null,
      transport: models.transport,
      ledger,
    }),
    backends: {
      ...createBackends({
        db: shared.db,
        workspaceId,
        queryApiUrl: env.QUERY_API_URL,
        internalToken: env.INTERNAL_API_TOKEN,
        defaultRange: env.DEFAULT_DASHBOARD_RANGE,
      }),
      // The test set never saves anything.
      savePanel: async () => {
        throw new Error('the test set does not save panels');
      },
    },
    defaultRange: env.DEFAULT_DASHBOARD_RANGE,
  };

  console.log(`\n${label}\n`);
  const results: CaseResult[] = [];
  for (const one of cases) {
    const result = await runCase(one, deps, shared.queryApi);
    results.push(result);
    shared.spent.total += result.cost;
    const mark =
      result.ruleBreaks.length > 0 ? 'RULE' : result.problems.length > 0 ? 'FAIL' : 'ok  ';
    console.log(`  ${mark}  ${result.id}`);
    for (const line of [...result.ruleBreaks, ...result.problems]) console.log(`          ${line}`);
  }

  const drafts = results.filter((_, index) => cases[index]!.expect.outcome === 'draft');
  const firstAttempt = drafts.filter((result) => result.firstAttemptPassed).length;
  const summary: RunSummary = {
    label,
    cases: results.length,
    passed: results.filter((r) => r.problems.length === 0 && r.ruleBreaks.length === 0).length,
    draftCases: drafts.length,
    firstAttempt,
    firstAttemptRate: drafts.length === 0 ? 1 : firstAttempt / drafts.length,
    rawUngrounded: results.reduce((sum, result) => sum + result.rawUngrounded, 0),
    ruleBreaks: results.reduce((sum, result) => sum + result.ruleBreaks.length, 0),
    cost: results.reduce((sum, result) => sum + result.cost, 0),
    results,
  };
  const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
  console.log(
    `\n  Passed the dry run on the first attempt: ${firstAttempt} of ${drafts.length} (${percent(summary.firstAttemptRate)}; the gate is ${percent(GATE)})` +
      `\n  Fully correct: ${summary.passed} of ${summary.cases}` +
      `\n  Names outside the catalog: ${summary.rawUngrounded} caught in code before any dry run, ${summary.ruleBreaks === 0 ? 'none' : 'SOME'} delivered` +
      `\n  Rules broken: ${summary.ruleBreaks}` +
      `\n  Model cost: ${summary.cost.toFixed(4)} in total, ${(summary.cost / Math.max(1, summary.cases)).toFixed(5)} per request`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const all = loadCases(values.cases);
const cases = values.only ? all.filter((one) => one.id === values.only) : all;
if (cases.length === 0) {
  console.error(`No case "${values.only}".`);
  process.exit(2);
}

const { db, close } = connect(env.DATABASE_URL);
const shared = {
  db,
  queryApi: createQueryApiClient({
    url: env.QUERY_API_URL,
    internalToken: env.INTERNAL_API_TOKEN,
    workspaceId,
  }),
  spent: { total: 0 },
};

const summaries: RunSummary[] = [];
let exitCode = 0;
try {
  const chosen = chooseModels({ apiKey: env.OPENROUTER_API_KEY, modelsFile: env.MODELS_FILE });
  if (!live) {
    summaries.push(
      await runSet(
        'Query test set on the stand-in model (no model key set)',
        cases,
        chosen,
        shared,
      ),
    );
  } else {
    const base = loadModels(env.MODELS_FILE);
    const transport = createOpenRouterTransport({ apiKey: env.OPENROUTER_API_KEY! });
    if (values['record-eligibility']) {
      const eligible: Record<string, string[]> = {};
      for (const tier of base.tiers) {
        eligible[tier.id] = [];
        for (const model of tier.models) {
          const summary = await runSet(
            `Candidate ${model.id} for the ${tier.id} tier`,
            cases,
            { config: singleModel(model.id, base), transport },
            shared,
          );
          summaries.push(summary);
          const passes =
            summary.ruleBreaks === 0 &&
            summary.firstAttemptRate >= GATE &&
            summary.passed / summary.cases >= GATE;
          if (passes) eligible[tier.id]!.push(model.id);
          console.log(`  ${model.id} is ${passes ? 'ELIGIBLE' : 'not eligible'} for ${tier.id}`);
        }
      }
      const file = base.eligibility_file ?? 'evals/eligibility.json';
      writeFileSync(
        file,
        `${JSON.stringify({ updated: new Date().toISOString(), tiers: eligible }, null, 2)}\n`,
      );
      console.log(`\nWrote ${file}`);
    } else {
      const config = values.model
        ? singleModel(values.model, base)
        : values.strategy === 'auto'
          ? { ...base, strategy: 'openrouter_auto' as const }
          : base;
      const label = values.model
        ? `Query test set on ${values.model}`
        : `Query test set, ${config.strategy} routing`;
      summaries.push(await runSet(label, cases, { config, transport }, shared));
    }
  }

  if (summaries.some((summary) => summary.ruleBreaks > 0)) {
    console.error(
      '\nA rule that must always hold was broken. This is a defect, whatever the model.',
    );
    exitCode = 1;
  } else if (values.gate && summaries.some((summary) => summary.firstAttemptRate < GATE)) {
    console.error(
      `\nThe gate was not met: fewer than ${GATE * 100}% passed the dry run on the first attempt.`,
    );
    exitCode = 1;
  }
} finally {
  if (values.json) writeFileSync(values.json, `${JSON.stringify(summaries, null, 2)}\n`);
  await close();
}
console.log();
process.exit(exitCode);
