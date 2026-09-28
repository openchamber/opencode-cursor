/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";
import os from "os";
import {
  startCursorBrowserLogin,

  getPendingCursorLogin,
  waitForCursorBrowserLogin,
} from "./auth-login.js";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
} from "./model-selection.js";
import { clearModelCache, resolveCursorModelSelection, type CursorModel } from "./models.js";
import { resolveConfigModels } from "./provider/config-models.js";
import { loadCursorRuntime } from "./provider/credential-runtime.js";
import { ensureCursorProviderConfig } from "./provider/provider-config.js";
import { getCursorProxyBaseUrl, startProxy, updateProxyModels } from "./proxy.js";
import { readStoredCursorAuth, writeStoredCursorAuth } from "./auth/opencode-auth-store.js";
import { ensureValidAccessToken } from "./auth/credential-manager.js";
import {
  CURSOR_PROVIDER_ID,
  CURSOR_VARIANT_OPTION,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "./shared/constants.js";

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["@openchamber/opencode-cursor"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  let modelCatalog: CursorModel[] = [];
  const rememberModels = (models: CursorModel[]) => {
    modelCatalog = models;
  };

  /**
   * Bind the local proxy early (ephemeral port) so the static provider
   * `options.baseURL` OpenCode reads from config points at a live listener.
   * Auth/token wiring is upgraded later by `loadCursorRuntime`.
   */
  async function ensureProxyForConfig(
    models: CursorModel[],
  ): Promise<string> {
    const existing = getCursorProxyBaseUrl();
    if (existing) return existing;
    const port = await startProxy(async () => {
      throw new Error("Cursor proxy is not authenticated yet");
    }, models);
    return `http://localhost:${port}/v1`;
  }

  return {
    // Newer OpenCode releases build the model catalog from statically declared
    // `config.provider.<id>` entries. Seed a concrete `cursor` provider so it
    // always appears; dynamic hooks refine connection details at runtime.
    async config(config) {
      const models = await resolveConfigModels();
      rememberModels(models);
      const baseURL = await ensureProxyForConfig(models);
      ensureCursorProviderConfig(config, models, baseURL);
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      const messageModel = hookInput.message.model as typeof hookInput.message.model & {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string" ? messageModel.variant : undefined;
      const selected = resolveCursorModelSelection(
        modelCatalog,
        hookInput.model.id,
        variant,
      );
      if (selected) {
        output.headers[CURSOR_SELECTION_HEADER] =
          encodeCursorModelSelection(selected);
      }
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      // Route the selected Cursor variant through a private local header —
      // do not leak OpenCode reasoning defaults or our marker into the SDK body.
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
    },

    provider: {
      id: CURSOR_PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadCursorRuntime(
          input,
          async () => ctx.auth,
          provider,
          rememberModels,
        );
        return runtime?.providerModels ?? {};
      },
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadCursorRuntime(
          input,
          getAuth,
          provider,
          rememberModels,
        );
        if (!runtime) return {};

        return {
          baseURL: `http://localhost:${runtime.port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            stripAuthorizationHeader(init);
            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Login with Cursor",
          async authorize() {
            // Reuse the headless browser login started by the config hook so
            // OpenChamber / CLI show one URL and share one poll session.
            let pending = getPendingCursorLogin();
            if (!pending || pending.completed) {
              pending = await startCursorBrowserLogin();
            }

            return {
              url: pending.url,
              instructions:
                "Open the URL below in your browser to authorize Cursor (same as `opencode auth login`). After you approve access, return here and click Complete — the live model list will load automatically. No API key is required.",
              method: "auto" as const,
              async callback() {
                const tokens = await waitForCursorBrowserLogin();
                clearModelCache();
                return {
                  type: "success" as const,
                  refresh: tokens.refresh,
                  access: tokens.access,
                  expires: tokens.expires,
                };
              },
            };
          },
        },
      ],
    },
  };
};

/** Remove Authorization so the local proxy does not forward a dummy API key. */
function stripAuthorizationHeader(init?: RequestInit): void {
  if (!init?.headers) return;
  if (init.headers instanceof Headers) {
    init.headers.delete("authorization");
  } else if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(
      ([key]) => key.toLowerCase() !== "authorization",
    );
  } else {
    delete (init.headers as Record<string, string>)["authorization"];
    delete (init.headers as Record<string, string>)["Authorization"];
  }
}

/**
 * OpenCode 2.0 Plugin Setup Hook
 */
async function setupV2(ctx: any): Promise<void> {
  // 1. 【立即启动本地 Proxy】绝不等待耗时的模型发现，确保端口第一时间处于监听状态！
  let baseURL = getCursorProxyBaseUrl();
  let proxyPortNumber: number | undefined;

  if (!baseURL) {
    try {
      proxyPortNumber = await startProxy(async () => {
        const stored = readStoredCursorAuth();
        if (stored) {
          try {
            const token = await ensureValidAccessToken({
              auth: stored,
              persist: writeStoredCursorAuth,
            });
            if (token) return token;
          } catch {}
          if (stored.access) return stored.access;
        }
        throw new Error("Cursor proxy is not authenticated yet");
      }, []);
      baseURL = `http://localhost:${proxyPortNumber}/v1`;
    } catch (e: any) {
      console.error("[opencode-cursor] Immediate startProxy failed:", e?.message || e);
    }
  }

  let modelCatalog: CursorModel[] = [];

  const mapToModelInfoList = (catalog: CursorModel[]) => {
    return catalog.map((m) => {
      const supportsImages = m.supportsImages !== false;
      const inputModalities = supportsImages ? ["text", "image"] : ["text"];
      return {
        id: m.id,
        modelID: m.id,
        providerID: CURSOR_PROVIDER_ID,
        name: m.name || m.id,
        limit: {
          context: m.contextWindow > 0 ? m.contextWindow : DEFAULT_CONTEXT_WINDOW,
          output: m.maxTokens > 0 ? m.maxTokens : DEFAULT_MAX_TOKENS,
        },
        reasoning: m.reasoning,
        capabilities: {
          tools: true,
          input: inputModalities,
          output: ["text"],
        },
        modalities: {
          input: inputModalities,
          output: ["text"],
        },
        variants: [],
        time: {
          released: 0,
        },
        cost: [],
        status: "active",
        enabled: true,
      };
    });
  };

  const applyModelsToEditor = (providers: any, catalog: CursorModel[]) => {
    try {
      // V2 Editor 模式: 优先使用 providers.models.set 传入 readonly Model.Info[] 数组
      if (providers?.models && typeof providers.models.set === "function") {
        const modelList = mapToModelInfoList(catalog);
        providers.models.set(CURSOR_PROVIDER_ID, modelList);
      } else if (providers?.models && typeof providers.models.update === "function") {
        for (const m of catalog) {
          providers.models.update(CURSOR_PROVIDER_ID, m.id, (modelDef: any) => {
            modelDef.name = m.name || m.id;
            if (m.contextWindow || m.maxTokens) {
              modelDef.limit = {
                context: m.contextWindow || DEFAULT_CONTEXT_WINDOW,
                output: m.maxTokens || DEFAULT_MAX_TOKENS,
              };
            }
            if (m.reasoning !== undefined) {
              modelDef.reasoning = m.reasoning;
            }
          });
        }
      }

      // 对象/字典模式兜底 (兼容测试 Mock 或特定加载器)
      if (providers && typeof providers === "object" && !providers.update) {
        const existing = providers[CURSOR_PROVIDER_ID] || {};
        const existingOptions = existing.options || existing.settings || {};
        const existingModels = existing.models || {};

        const modelMap: Record<string, any> = { ...existingModels };
        for (const m of catalog) {
          const supportsImages = m.supportsImages !== false;
          modelMap[m.id] = {
            name: m.name || m.id,
            limit: {
              context: m.contextWindow || DEFAULT_CONTEXT_WINDOW,
              output: m.maxTokens || DEFAULT_MAX_TOKENS,
            },
            reasoning: m.reasoning,
            capabilities: {
              attachment: true,
              toolcall: true,
              input: {
                text: true,
                image: supportsImages,
              },
            },
            ...(existingModels[m.id] || {}),
          };
        }

        providers[CURSOR_PROVIDER_ID] = {
          ...existing,
          name: existing.name || "Cursor",
          npm: existing.npm || existing.package || "@ai-sdk/openai-compatible",
          options: {
            ...existingOptions,
            baseURL,
            includeUsage: true,
          },
          settings: {
            ...(existing.settings || {}),
            baseURL,
          },
          models: modelMap,
        };
      }
    } catch (err) {}
  };

  // 2. 注册 OpenCode 2.0 Integration & OAuth 认证方式（消除 API Key 提示）
  if (ctx.integration && typeof ctx.integration.transform === "function") {
    ctx.integration.transform((editor: any) => {
      try {
        if (typeof editor.update === "function") {
          editor.update(CURSOR_PROVIDER_ID, (ref: any) => {
            ref.name = ref.name || "Cursor";
          });
        }
        if (editor?.method && typeof editor.method.update === "function") {
          editor.method.update({
            integrationID: CURSOR_PROVIDER_ID,
            method: {
              id: "oauth",
              type: "oauth",
              label: "Login with Cursor",
            },
            authorize: async () => {
              let pending = getPendingCursorLogin();
              if (!pending || pending.completed) {
                pending = await startCursorBrowserLogin();
              }
              return {
                url: pending.url,
                instructions:
                  "Open the URL below in your browser to authorize Cursor. No API key is required.",
                mode: "auto" as const,
                callback: async () => {
                  const tokens = await waitForCursorBrowserLogin();
                  clearModelCache();
                  return {
                    type: "oauth" as const,
                    methodID: "oauth",
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                  };
                },
              };
            },
          });
        }
      } catch (err) {
        console.error("[opencode-cursor] Failed to register integration in setupV2:", err);
      }
    });
  }

  // 3. 毫秒级注册 Provider 基础信息与 Transform（闭包持有 modelCatalog）
  if (ctx.provider && typeof ctx.provider.transform === "function") {
    ctx.provider.transform((providers: any) => {
      try {
        if (typeof providers.update === "function") {
          providers.update(CURSOR_PROVIDER_ID, (p: any) => {
            p.name = p.name || "Cursor";
            p.activation = "enabled";
            p.package = p.package || "aisdk:@ai-sdk/openai-compatible";
            p.settings = p.settings || {};
            p.settings.baseURL = baseURL;
            p.settings.apiKey = p.settings.apiKey || "cursor-proxy";
            p.options = p.options || {};
            p.options.baseURL = baseURL;
            p.options.apiKey = p.options.apiKey || "cursor-proxy";
          });
        }
        if (modelCatalog.length > 0) {
          applyModelsToEditor(providers, modelCatalog);
        }
      } catch (err) {}
    });
  }

  // 3. 【非阻塞后台模型发现】完全脱离启动关键路径，发现就绪后调用 reload() 通知 OpenCode
  void resolveConfigModels()
    .then(async (discovered) => {
      if (discovered && discovered.length > 0) {
        modelCatalog = discovered;
        updateProxyModels(discovered);
        if (ctx.provider && typeof ctx.provider.reload === "function") {
          await ctx.provider.reload();
        } else if (ctx.provider && typeof ctx.provider.transform === "function") {
          ctx.provider.transform((providers: any) => {
            applyModelsToEditor(providers, discovered);
          });
        }
      }
    })
    .catch(() => {});

  // 3. 挂载 Session 请求钩子
  if (ctx.session && typeof ctx.session.hook === "function") {
    ctx.session.hook("model.request", (event: any) => {
      if (event?.providerID !== CURSOR_PROVIDER_ID && event?.model?.providerID !== CURSOR_PROVIDER_ID) return;
      const modelId = event.model?.id || event.modelID;
      const variant = typeof event.variant === "string" ? event.variant : undefined;
      const selected = resolveCursorModelSelection(modelCatalog, modelId, variant);
      if (selected && event.headers) {
        event.headers[CURSOR_SELECTION_HEADER] = encodeCursorModelSelection(selected);
      }
    });

    ctx.session.hook("context", (event: any) => {
      if (event?.providerID !== CURSOR_PROVIDER_ID && event?.model?.providerID !== CURSOR_PROVIDER_ID) return;
      if (event.options) {
        delete event.options.reasoningEffort;
        delete event.options[CURSOR_VARIANT_OPTION];
      }
    });
  }
}

const pluginExport = {
  id: "cursor",
  setup: setupV2,
  server: CursorAuthPlugin,
};

export default pluginExport;
