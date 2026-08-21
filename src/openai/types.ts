/** OpenAI-compatible request/message types used by the local proxy. */

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A single element in an OpenAI multi-part content array. */
export interface ContentPart {
  type: string;
  text?: string;
  /** OpenAI vision part: string URL or `{ url }`. */
  image_url?: string | { url?: string; detail?: string };
  /** Some OpenCode paths use explicit mime + data/url fields. */
  mime?: string;
  mime_type?: string;
  data?: string;
  url?: string;
  filename?: string;
  name?: string;
}

export interface ExtractedImage {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
  user?: string;
  metadata?: Record<string, unknown>;
  thread_id?: string;
  conversation_id?: string;
  session_id?: string;
}

export interface ToolResultInfo {
  toolCallId: string;
  content: string;
}

export interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  /** Images attached to the current user turn (OpenAI vision / file parts). */
  images: ExtractedImage[];
  turns: Array<{ userText: string; assistantText: string }>;
  toolResults: ToolResultInfo[];
}

/** Normalize OpenAI message content to a plain string. */
export function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/**
 * OpenCode's `task` (subagent delegation) tool must be bridged under an
 * unambiguous name. Cursor's engine also has a native `task` tool that runs
 * server-side: calls to it never reach this bridge and are silently dropped
 * from the stream, hanging the turn. Advertising an MCP tool with the same
 * name invites the model to pick the native one and lose the call. So the
 * tool is advertised as TASK_BRIDGE_NAME and mapped back to TASK_TOOL_NAME
 * when the tool_call is surfaced to OpenCode (results match by id, not name).
 */
export const TASK_TOOL_NAME = "task";
export const TASK_BRIDGE_NAME = "opencode_task";

export function bridgeToolName(name: string): string {
  return name.trim().toLowerCase() === TASK_TOOL_NAME ? TASK_BRIDGE_NAME : name;
}

export function originalToolName(bridgedName: string): string {
  return bridgedName === TASK_BRIDGE_NAME ? TASK_TOOL_NAME : bridgedName;
}
