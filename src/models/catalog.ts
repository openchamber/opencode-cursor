import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { callCursorUnaryRpc, decodeConnectUnaryProtoBody } from "../cursor-rpc.js";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "../proto/agent_pb.js";
import { normalizeAvailableModels } from "./available-normalizer.js";
import type { CursorModel } from "../model-selection.js";
import { normalizeCursorModels } from "./usable-normalizer.js";
import { AVAILABLE_MODELS_RPC_TIMEOUT_MS } from "../shared/constants.js";
import { log } from "../shared/log.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

// Cursor's AvailableModels omits some catalog entries unless they are named
// explicitly. Grok models are user-added and never appear with an empty list.
const ADDITIONAL_MODEL_NAMES = [
  "grok-4-5",
  "grok-4.20",
  "grok-code-fast-1",
  "grok-4-fast-reasoning",
  "grok-4-0709",
] as const;

async function fetchCursorAvailableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const requestBody = new TextEncoder().encode(
        JSON.stringify({
          isNightly: false,
          excludeMaxNamedModels: true,
          additionalModelNames: [...ADDITIONAL_MODEL_NAMES],
          useModelParameters: true,
          useReactModelPicker: true,
        }),
      );
      const response = await callCursorUnaryRpc({
        accessToken: apiKey,
        rpcPath: AVAILABLE_MODELS_PATH,
        requestBody,
        contentType: "application/json",
        connectProtocolVersion: "1",
        timeoutMs: AVAILABLE_MODELS_RPC_TIMEOUT_MS,
      });
      if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
        if (response.timedOut) {
          log.warn(
            `[opencode-cursor] AvailableModels timed out after ${AVAILABLE_MODELS_RPC_TIMEOUT_MS}ms; falling back to GetUsableModels`,
          );
        }
        return null;
      }

      const decoded = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
      const record = asRecord(decoded);
      const models = Array.isArray(record?.models)
        ? normalizeAvailableModels(record.models)
        : [];
      if (models.length > 0) {
        log.info(
          `[opencode-cursor] discovered ${models.length} models via AvailableModels`,
        );
      }
      return models.length > 0 ? models : null;
    } catch {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function fetchCursorUsableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);

    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
    });

    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }

    const decoded = decodeGetUsableModelsResponse(response.body);
    if (!decoded) return null;

    const models = normalizeCursorModels(decoded.models);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

let cachedModels: CursorModel[] | null = null;
let degradedCache: { models: CursorModel[]; expiresAt: number; apiKey: string } | null = null;
const inFlightDiscoveries = new Map<string, Promise<CursorModel[]>>();
const DEGRADED_CACHE_TTL_MS = 60_000;

/**
 * Discover the live Cursor model catalog for this account.
 * Returns [] on failure — never invents a hardcoded catalog.
 * Uses Single-Flight deduplication by apiKey and tiered caching (long-term for full AvailableModels, 60s TTL for degraded GetUsableModels).
 */
export async function getCursorModels(apiKey: string): Promise<CursorModel[]> {
  if (cachedModels && cachedModels.length > 0) return cachedModels;

  const now = Date.now();
  if (degradedCache && degradedCache.apiKey === apiKey && degradedCache.expiresAt > now) {
    return degradedCache.models;
  }

  const existingInFlight = inFlightDiscoveries.get(apiKey);
  if (existingInFlight) return existingInFlight;

  const discoveryPromise = (async () => {
    try {
      const available = await fetchCursorAvailableModels(apiKey);
      if (available && available.length > 0) {
        cachedModels = available;
        degradedCache = null;
        return available;
      }

      const fallback = await fetchCursorUsableModels(apiKey);
      if (fallback && fallback.length > 0) {
        log.warn(
          `[opencode-cursor] using GetUsableModels fallback (${fallback.length} models; capability metadata may be incomplete)`,
        );
        degradedCache = {
          models: fallback,
          expiresAt: Date.now() + DEGRADED_CACHE_TTL_MS,
          apiKey,
        };
        return fallback;
      }
      return [];
    } finally {
      inFlightDiscoveries.delete(apiKey);
    }
  })();

  inFlightDiscoveries.set(apiKey, discoveryPromise);
  return discoveryPromise;
}

/** Invalidate the in-memory catalog (after login or account change). */
export function clearModelCache(): void {
  cachedModels = null;
  degradedCache = null;
  inFlightDiscoveries.clear();
}

function decodeGetUsableModelsResponse(payload: Uint8Array): {
  models: readonly unknown[];
} | null {
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    const framedBody = decodeConnectUnaryProtoBody(payload);
    if (!framedBody) return null;
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
