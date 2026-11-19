import type { CatalogSearch, CatalogSearchResult } from '@app/catalog';
import type { Actor } from '@app/db';
import type { DryRunResult } from '@app/query-api/client';
import {
  parseDraftAlertRuleSpec,
  parseDraftCollectorSpec,
  parsePanelSpec,
  type AlertRuleSpec,
  type CollectorSpec,
  type PanelSpec,
} from '@app/specs';
import { checkGrounding } from './grounding.js';
import type { AgentState, Question } from './types.js';

/** The most questions one request may ask, counting the endpoint question. */
export const MAX_QUESTIONS = 2;

/** A tool refused to act because doing so would break one of the rules that must always hold. */
export class ToolRefusal extends Error {
  override name = 'ToolRefusal';
  constructor(
    readonly rule: 'catalog_grounding' | 'dry_run_before_display' | 'question_limit',
    message: string,
  ) {
    super(message);
  }
}

/** What the tools reach the outside world through. All of it is scoped to one workspace. */
export interface CollectorDraftResult {
  collectorId: string;
  test: { ok: boolean; status: number | null; duration: number; error?: string };
}

/** A request already turned into a tested query. */
export interface ResolvedRequest {
  panel: PanelSpec;
  parsed: unknown;
  decisions: unknown;
  /** The services its query reads. */
  services: string[];
  fingerprint: string;
}

export interface ToolBackends {
  /** draft_alert: write a pending rule. Optional: without it, alerts are not available. */
  draftAlert?(spec: AlertRuleSpec, actor: Actor): Promise<{ ruleId: string }>;
  /** draft_collector: one test fetch, then a pending collector. */
  draftCollector?(spec: CollectorSpec, actor: Actor): Promise<CollectorDraftResult>;
  /**
   * The resolved-request cache. Optional: without it every request goes to
   * the model.
   */
  resolved?: {
    get(key: string): Promise<ResolvedRequest | undefined>;
    put(key: string, entry: ResolvedRequest): Promise<void>;
    /** The catalog fingerprint of some services now. */
    fingerprint(services: string[]): Promise<string>;
    /** Every name the catalog has for some services. */
    names(services: string[]): Promise<{ metrics: string[]; labels: string[] }>;
  };
  searchCatalog(search: CatalogSearch): Promise<CatalogSearchResult>;
  dryRun(query: string, range: string): Promise<DryRunResult>;
  /** Save a panel; with `panelId`, as a new version of that panel. */
  savePanel(
    spec: PanelSpec,
    actor: Actor,
    dashboardId: string | undefined,
    panelId?: string,
  ): Promise<{ panelId: string; version: number; dashboardId: string }>;
}

export type RunQueryResult =
  | { ok: true; lineCount: number; dryRun: DryRunResult }
  | { ok: false; reason: string; ungrounded?: string[]; lineCount?: number };

/**
 * The agent's tools for one request. The agent may only act through these,
 * and each one enforces its rule itself, whatever the caller or the model
 * intended:
 *
 *   - `searchCatalog` is the only source of names; it records what it returned.
 *   - `runQuery` refuses names the search did not return, then dry-runs.
 *   - `askUser` refuses a third question.
 *   - `savePanel` refuses a query that has not passed `runQuery` here.
 *
 * The tools write to `state`, which is the request's record.
 */
export function createToolbox(state: AgentState, backends: ToolBackends) {
  return {
    /** search_catalog: free text and an optional service. No side effect beyond recording the names. */
    async searchCatalog(search: CatalogSearch) {
      const result = await backends.searchCatalog(search);
      const metrics = new Set(state.allowed.metrics);
      const labels = new Set(state.allowed.labels);
      for (const metric of result.metrics) {
        for (const series of metric.series) metrics.add(series);
        for (const label of metric.labels) labels.add(label);
      }
      state.allowed = { metrics: [...metrics].sort(), labels: [...labels].sort() };
      return result;
    },

    /** run_query: the dry run. A query that fails here never reaches a person or a spec. */
    async runQuery(query: string, range: string): Promise<RunQueryResult> {
      const grounding = checkGrounding(query, state.allowed);
      if (!grounding.ok) {
        return { ok: false, reason: grounding.message, ungrounded: grounding.violations };
      }
      const dryRun = await backends.dryRun(query, range);
      if (!dryRun.ok) {
        return {
          ok: false,
          reason: dryRun.error?.message ?? 'The query failed.',
          lineCount: dryRun.lineCount,
        };
      }
      if (dryRun.lineCount === 0) {
        return { ok: false, reason: 'The query ran but returned no data.', lineCount: 0 };
      }
      if (!state.testedQueries.includes(query)) state.testedQueries.push(query);
      return { ok: true, lineCount: dryRun.lineCount, dryRun };
    },

    /** ask_user: one question. The answer arrives later as an event. */
    askUser(question: Question): void {
      if (state.questionsAsked.length >= MAX_QUESTIONS) {
        throw new ToolRefusal(
          'question_limit',
          `A request may ask at most ${MAX_QUESTIONS} questions. State an assumption instead.`,
        );
      }
      if (
        question.kind === 'choice' &&
        (question.options.length < 2 || question.options.length > 6)
      ) {
        throw new Error('A question needs 2 to 6 options.');
      }
      state.questionsAsked.push(question.id);
      state.question = question;
      state.status = 'question';
    },

    /**
     * draft_alert: writes a pending rule. The query it watches must have
     * passed the dry run here, like any query a person sees.
     */
    async draftAlert(spec: AlertRuleSpec) {
      if (!backends.draftAlert) throw new Error('Alerts are not available.');
      const valid = parseDraftAlertRuleSpec(spec);
      if (valid.query && !state.testedQueries.includes(valid.query)) {
        throw new ToolRefusal(
          'dry_run_before_display',
          'The query behind this alert has not passed a dry run.',
        );
      }
      const grounding = checkGrounding(valid.expr, state.allowed);
      if (!grounding.ok) throw new ToolRefusal('catalog_grounding', grounding.message);
      return backends.draftAlert(valid, { kind: 'user', id: state.userId });
    },

    /** draft_collector: a pending collector after one test fetch. */
    async draftCollector(spec: CollectorSpec) {
      if (!backends.draftCollector) throw new Error('Data sources are not available.');
      return backends.draftCollector(parseDraftCollectorSpec(spec), {
        kind: 'user',
        id: state.userId,
      });
    },

    /** save_panel: writes a spec. Only for a query that passed the dry run in this request. */
    async savePanel(spec: PanelSpec, dashboardId: string | undefined) {
      const valid = parsePanelSpec(spec);
      if (!state.testedQueries.includes(valid.query)) {
        throw new ToolRefusal(
          'dry_run_before_display',
          'This query has not passed a dry run in this request, so it cannot be saved.',
        );
      }
      const grounding = checkGrounding(valid.query, state.allowed);
      if (!grounding.ok) throw new ToolRefusal('catalog_grounding', grounding.message);
      return backends.savePanel(
        valid,
        { kind: 'user', id: state.userId },
        dashboardId,
        state.revises?.panelId,
      );
    },
  };
}

export type Toolbox = ReturnType<typeof createToolbox>;
