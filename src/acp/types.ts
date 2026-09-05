// src/acp/types.ts — ACP v1 wire shapes.
//
// Every shape here was captured from a live `dsh --profile acp` (dsh 0.1.2-rc.1,
// agentInfo deepseek-harness-acp/0.0.1), not transcribed from a spec. Fields the
// agent never actually sent are omitted rather than guessed at.

/** `initialize` result. `authMethods` is empty for dsh: ACP over stdio needs no auth. */
export interface InitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string };
  agentCapabilities?: {
    mcpCapabilities?: { http?: boolean };
    /** `image` tracks the configured model route, not the protocol: a vision route flips it true. */
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { close?: unknown; list?: unknown; resume?: unknown };
  };
  authMethods?: unknown[];
}

/** One selectable value inside a `ConfigOption`, optionally nested under a provider group. */
export interface ConfigOptionChoice {
  value?: string;
  name?: string;
  description?: string;
  group?: string;
  options?: ConfigOptionChoice[];
}

/** An agent-advertised setting, e.g. `model` or `reasoning_effort`. */
export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: ConfigOptionChoice[];
}

export interface NewSessionResult {
  sessionId: string;
  configOptions?: ConfigOption[];
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
}

export interface ListSessionsResult {
  sessions: SessionSummary[];
}

/** Why a turn ended. `end_turn` is the normal path; `cancelled` follows `session/cancel`. */
export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | string;

export interface PromptResult {
  stopReason: StopReason;
}

/** A text block inside an assistant message, thought, or tool-call result. */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * The `update` payload of a `session/update` notification.
 *
 * Observed kinds, in the order a real turn produces them:
 *   config_option_update → usage_update → tool_call → tool_call_update
 *   → agent_thought_chunk → agent_message_chunk
 */
export type SessionUpdate =
  | { sessionUpdate: 'config_option_update'; configOptions: ConfigOption[] }
  | { sessionUpdate: 'usage_update'; used: number; size: number }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: ToolCallStatus;
      rawInput?: Record<string, unknown>;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: ToolCallStatus;
      title?: string;
      content?: ToolCallContent[];
    }
  | { sessionUpdate: 'agent_thought_chunk'; messageId?: string; content: TextContent }
  | { sessionUpdate: 'agent_message_chunk'; messageId?: string; content: TextContent }
  | { sessionUpdate: string; [k: string]: unknown };

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string;

/** Tool output arrives wrapped one level deeper: `{ type: 'content', content: { type: 'text', text } }`. */
export interface ToolCallContent {
  type: string;
  content?: TextContent;
}

/**
 * `session/request_permission` params (agent → client).
 *
 * Note: with the shipped acp profile this was never observed to fire — a file
 * write completed with no prompt. It is implemented because the policy layer is
 * patchable, but it must not be treated as a safety net. See README.
 */
export interface RequestPermissionParams {
  sessionId?: string;
  toolCall?: { toolCallId?: string; title?: string; rawInput?: unknown };
  options?: PermissionOption[];
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}
