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

  const maxModeLimit = positiveNumber(model.contextTokenLimitForMaxMode);
  if (maxModeLimit) return maxModeLimit;

  const fromVariantTooltip = parseContextFromTooltip(readTooltipMarkdown(variant));
  if (fromVariantTooltip) return fromVariantTooltip;

  const fromTooltip = parseContextFromTooltip(readTooltipMarkdown(model));
  if (fromTooltip) return fromTooltip;

  return DEFAULT_CONTEXT_WINDOW;
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
