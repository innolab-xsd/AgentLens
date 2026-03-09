export type ActorType = "agent" | "user" | "system" | "tool";
export type EventVisibility = "raw" | "review" | "debug";
export type EventKind =
  | "session_start"
  | "intent"
  | "file_op"
  | "tool_call"
  | "decision"
  | "assumption"
  | "verification"
  | "session_end"
  | "artifact_created"
  | "intent_transition"
  | "risk_signal"
  | "verification_run"
  | "diff_summary"
  | "decision_link"
  | "assumption_lifecycle"
  | "blocker"
  | "token_usage_checkpoint"
  | "session_quality"
  | "replay_bookmark"
  | "hotspot";

export interface TokenUsagePayload extends Record<string, unknown> {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    source_model_context_window?: number;
  };
  raw?: unknown;
  source?: string;
}

export interface ArtifactPayload extends Record<string, unknown> {
  artifact_type?: string;
  title?: string;
  text?: string;
  summary?: string;
  source?: string;
  [key: string]: unknown;
}

export interface ToolCallPayload {
  category?: "file" | "tool" | "search" | "execution";
  action?: string;
  target?: string;
  details?: unknown;
  [key: string]: unknown;
}

export type CanonicalPayload = Record<string, unknown> &
  Partial<TokenUsagePayload & ArtifactPayload & ToolCallPayload>;

export interface CanonicalEvent {
  id: string;
  session_id: string;
  seq: number;
  ts: string;
  kind: EventKind;
  actor: {
    type: ActorType;
    id?: string;
  };
  scope?: {
    intent_id?: string;
    file?: string;
    module?: string;
    agent_id?: string;
    parent_agent_id?: string;
    delegation_id?: string;
    thread_id?: string;
    task_id?: string;
  };
  payload: CanonicalPayload;
  derived?: boolean;
  confidence?: number;
  visibility?: EventVisibility;
  schema_version: number;
}

export const EVENT_SCHEMA_VERSION = 1;

export interface SessionLogFile {
  session_id: string;
  goal: string;
  user_prompt?: string;
  repo?: string;
  branch?: string;
  started_at: string;
  ended_at?: string;
  events: CanonicalEvent[];
}
