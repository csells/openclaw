// ── Frame types ──

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

// ── Hello ──

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
  sessionDefaults?: {
    defaultAgentId: string;
    mainKey: string;
    mainSessionKey: string;
    scope?: string;
  };
};

// ── Chat ──

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  attachments?: ChatAttachment[];
  timeoutMs?: number;
  idempotencyKey: string;
};

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string; // base64-encoded
};

export type ChatHistoryParams = {
  sessionKey: string;
  limit?: number;
};

export type ChatHistoryResult = {
  messages?: Message[];
  thinkingLevel?: string;
};

export type ChatAbortParams = {
  sessionKey: string;
  runId?: string;
};

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: Message;
  errorMessage?: string;
  usage?: TokenUsage;
  stopReason?: string;
};

// ── Messages ──

export type Message = {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  timestamp?: number;
  usage?: TokenUsage;
  stopReason?: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type TokenUsage = {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
};

// ── Sessions ──

export type SessionsListParams = {
  limit?: number;
  activeMinutes?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  agentId?: string;
};

export type SessionSummary = {
  key: string;
  label?: string;
  derivedTitle?: string;
  lastMessage?: { role: string; text: string };
  updatedAt?: number;
  model?: string;
  totalTokens?: number;
};

export type SessionsPatchParams = {
  key: string;
  label?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  verboseLevel?: string | null;
};

export type SessionsResetParams = {
  key: string;
};

export type SessionsDeleteParams = {
  key: string;
  deleteTranscript?: boolean;
};

// ── Models & Agents ──

export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type ModelsListResult = {
  models: ModelChoice[];
};
