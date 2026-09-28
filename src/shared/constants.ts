/** Shared plugin constants — single source of truth. */

export const CURSOR_PROVIDER_ID = "cursor";
export const DEFAULT_MODEL_ID = "default";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
export const CURSOR_VARIANT_OPTION = "cursorVariant";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

/** AvailableModels can exceed the default 5s RPC budget on slow links. */
export const AVAILABLE_MODELS_RPC_TIMEOUT_MS = 30_000;
/** Outer config discovery timeout — slightly above RPC to avoid racing the bridge. */
export const CONFIG_MODEL_DISCOVERY_TIMEOUT_MS = 35_000;
/** NameAgent title RPC — default 5s is too short; live calls often need ~6s+. */
export const NAME_AGENT_RPC_TIMEOUT_MS = 15_000;

export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
