import type { TaskType } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What the router sends to a transport: one model, one completion. */
export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** Ask for a single JSON object as the reply. */
  json: boolean;
  maxTokens: number;
  /** The task, for transports that are not a real model (the stand-in). */
  task: TaskType;
}

export interface CompletionResponse {
  content: string;
  /** The model that answered, when the provider reports one (it differs under auto-routing). */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /** The provider's own figure, when it reports one. */
  cost?: number;
}

/** The one seam to a model provider. Everything provider-specific lives behind it. */
export interface ModelTransport {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** How a call turned out. Starts as `ok` or `transport_error`; the caller may refine `ok`. */
export type CallOutcome =
  | 'ok'
  | 'transport_error'
  /** The reply was not the JSON that was asked for. */
  | 'invalid_output'
  /** The query it wrote used a name outside the catalog. */
  | 'ungrounded'
  /** The query it wrote failed the dry run. */
  | 'dry_run_failed';

export interface CallRecord {
  workspaceId: string;
  requestId: string;
  task: TaskType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  outcome: CallOutcome;
  escalatedFrom?: string | undefined;
}

/** Where calls are logged and budgets are read. Backed by `model_calls` in production. */
export interface Ledger {
  /** The workspace's monthly limit (null: none set) and what it has spent this month. */
  budget(workspaceId: string): Promise<{ limit: number | null; spent: number }>;
  /** Log a call. Returns its id. */
  record(call: CallRecord): Promise<string>;
  setOutcome(callId: string, outcome: CallOutcome): Promise<void>;
}

export interface RouterRequest {
  workspaceId: string;
  /** Groups every call made for one user request. */
  requestId: string;
  task: TaskType;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  /** Failures so far on this request. From two on, the router uses a stronger tier. */
  failures?: number;
  /** The earlier call this one retries, when escalating. */
  previousCallId?: string | undefined;
}

export interface RouterResponse {
  callId: string;
  model: string;
  tier: string;
  escalated: boolean;
  content: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
