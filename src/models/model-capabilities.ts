import { DEFAULT_CONTEXT_WINDOW } from "../shared/constants.js";

const EFFORT_PARAMETER_IDS = ["reasoning", "effort", "reasoning_effort"] as const;

export function isEffortParameterId(id: string): boolean {
  return (EFFORT_PARAMETER_IDS as readonly string[]).includes(id);
}

export function readRawEffortValue(
  values: ReadonlyMap<string, string>,
): string | undefined {
  for (const id of EFFORT_PARAMETER_IDS) {
    const value = values.get(id);
    if (value) return value;
  }
  return undefined;
}

export interface AvailableModelCapabilities {
  supportsImages: boolean;
  supportsThinking: boolean;
}

export function extractAvailableModelCapabilities(
  model: Record<string, unknown>,
): AvailableModelCapabilities {
  return {
    supportsImages: model.supportsImages !== false,
    supportsThinking: model.supportsThinking === true,
  };
}

export function parseContextFromTooltip(
  markdown: string | undefined,
): number | undefined {
  if (!markdown) return undefined;
  const match = markdown.match(/(\d+(?:\.\d+)?)\s*([km])\b/i);
  if (!match) return undefined;
  return parseTokenLimit(`${match[1]}${match[2].toLowerCase()}`);
}

export function parseTokenLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier =
    match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function readTooltipMarkdown(source: Record<string, unknown> | undefined): string | undefined {
  const tooltip = asRecord(source?.tooltipData);
  return typeof tooltip?.markdownContent === "string"
    ? tooltip.markdownContent
    : undefined;
}

export function inferAvailableContextWindow(
  model: Record<string, unknown>,
  variantContext?: string,
  variant?: Record<string, unknown>,
): number {
  const fromVariant = parseTokenLimit(variantContext);
  if (fromVariant) return fromVariant;

  const standardLimit = positiveNumber(model.contextTokenLimit);
  if (standardLimit) return standardLimit;

  const maxModeLimit = positiveNumber(model.contextTokenLimitForMaxMode);
  if (maxModeLimit) return maxModeLimit;

  const fromVariantTooltip = parseContextFromTooltip(readTooltipMarkdown(variant));
  if (fromVariantTooltip) return fromVariantTooltip;

  const fromTooltip = parseContextFromTooltip(readTooltipMarkdown(model));
  if (fromTooltip) return fromTooltip;

  const fromDisplayName = parseContextFromTooltip(
    typeof model.clientDisplayName === "string" ? model.clientDisplayName : undefined,
  );
  if (fromDisplayName) return fromDisplayName;

  const modelId = typeof model.name === "string" ? model.name : undefined;
  const fromFamily = inferKnownFamilyContext(modelId);
  if (fromFamily) return fromFamily;

  return DEFAULT_CONTEXT_WINDOW;
}

interface KnownFamilyRule {
  pattern: RegExp;
  contextTokens: number;
}

const KNOWN_FAMILY_RULES: readonly KnownFamilyRule[] = [
  // Gemini 2M 特殊版本
  { pattern: /^gemini-1\.5-pro\b/i, contextTokens: 2_000_000 },
  // Gemini 官方标准 Flash / Pro 全系列在 Cursor 为 1M
  { pattern: /^gemini-(?:2\.5|3|3\.\d+)-(?:flash|pro)\b/i, contextTokens: 1_000_000 },
  { pattern: /^gemini\b/i, contextTokens: 1_000_000 },
  // Kimi
  { pattern: /^kimi-k3\b/i, contextTokens: 1_048_576 },
  { pattern: /^kimi-k2\.7-code\b/i, contextTokens: 262_000 },
  // GLM
  { pattern: /^glm-5/i, contextTokens: 1_000_000 },
  // GPT-5 / Codex-5
  { pattern: /^(?:gpt|codex)-5/i, contextTokens: 272_000 },
  // Grok 系列
  { pattern: /^grok-/i, contextTokens: 256_000 },
  // Claude 300k 系列 (Claude 4.7+, 5, Fable 5)
  { pattern: /^claude-(?:fable-5|opus-(?:4\.[7-9]|5)|sonnet-5)/i, contextTokens: 300_000 },
];

/**
 * Infer context window by model family when explicit metadata is absent (e.g. GetUsableModels).
 * Normalizes provider prefixes (e.g. "cursor/") and case before matching.
 */
export function inferKnownFamilyContext(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const normalized = modelId.trim().toLowerCase().replace(/^(?:cursor\/)/, "");
  for (const rule of KNOWN_FAMILY_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.contextTokens;
    }
  }
  return undefined;
}

export function buildInputModalities(supportsImages: boolean): string[] {
  return supportsImages ? ["text", "image"] : ["text"];
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
