import { Credential, Integration, Model, Plugin } from "@opencode-ai/plugin";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  refreshCursorToken,
  tryPollCursorAuth,
  type CursorAuthParams,
} from "./auth.js";
import {
  clearModelCache,
  getCursorModels,
  LOGIN_PLACEHOLDER_MODELS,
  resolveCursorModelSelection,
  type CursorModel,
} from "./models.js";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
  literalCursorModelSelection,
} from "./model-selection.js";
import { startProxy, stopProxy } from "./proxy.js";
import {
  CURSOR_PROVIDER_ID,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_ID,
} from "./shared/constants.js";

const CURSOR_OAUTH_METHOD_ID = "cursor-browser";
const V2_OPENAI_COMPATIBLE_PACKAGE =
  "@opencode-ai/ai/providers/openai-compatible";
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_MS = 15 * 60 * 1_000;

type CursorCredential = Credential.OAuth;

export interface V2Runtime {
  startProxy: typeof startProxy;
  stopProxy: typeof stopProxy;
  getCursorModels: typeof getCursorModels;
  clearModelCache: typeof clearModelCache;
  generateCursorAuthParams: typeof generateCursorAuthParams;
  tryPollCursorAuth: typeof tryPollCursorAuth;
  refreshCursorToken: typeof refreshCursorToken;
  sleep(ms: number): Promise<void>;
}

const runtime: V2Runtime = {
  startProxy,
  stopProxy,
  getCursorModels,
  clearModelCache,
  generateCursorAuthParams,
  tryPollCursorAuth,
  refreshCursorToken,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function setupV2(
  ctx: Plugin.Context,
  host: V2Runtime = runtime,
): Promise<Plugin.Cleanup> {
  let models: CursorModel[] = LOGIN_PLACEHOLDER_MODELS;

  const credential = async (): Promise<CursorCredential | undefined> => {
    const connection = await ctx.integration.connection.active(CURSOR_PROVIDER_ID);
    if (!connection) return undefined;
    const value = await ctx.integration.connection.resolve(connection);
    return value?.type === "oauth" &&
      value.methodID === CURSOR_OAUTH_METHOD_ID
      ? value
      : undefined;
  };

  const accessToken = async () => {
    const value = await credential();
    if (!value?.access) throw new Error("Cursor authentication is required");
    return value.access;
  };

  const port = await host.startProxy(accessToken, models);
  const baseURL = `http://localhost:${port}/v1`;

  const publishModels = async (access: string) => {
    const discovered = await host.getCursorModels(access);
    if (discovered.length === 0) return;
    models = withDefaultModel(discovered);
    await host.startProxy(accessToken, models);
    await ctx.catalog.reload();
  };

  await ctx.integration.transform((draft) => {
    draft.update(CURSOR_PROVIDER_ID, (integration) => {
      integration.name = "Cursor";
    });
    draft.method.update({
      integrationID: CURSOR_PROVIDER_ID,
      method: {
        id: Integration.MethodID.make(CURSOR_OAUTH_METHOD_ID),
        type: "oauth",
        label: "Login with Cursor",
      },
      authorize: async () => {
        const params = await host.generateCursorAuthParams();
        return {
          url: params.loginUrl,
          instructions:
            "Authorize Cursor in your browser, then return to OpenCode.",
          mode: "auto",
          callback: pollForCredential(params, host).then(async (value) => {
            host.clearModelCache();
            await publishModels(value.access).catch(() => {});
            return value;
          }),
        };
      },
      refresh: async (value) => {
        const refreshed = await host.refreshCursorToken(value.refresh);
        const credential = Credential.OAuth.make({
          ...value,
          access: refreshed.access,
          refresh: refreshed.refresh,
          expires: refreshed.expires,
        });
        host.clearModelCache();
        await publishModels(credential.access).catch(() => {});
        return credential;
      },
    });
  });

  await ctx.catalog.transform((catalog) => {
    catalog.provider.update(CURSOR_PROVIDER_ID, (provider) => {
      provider.name = "Cursor";
      provider.integrationID = Integration.ID.make(CURSOR_PROVIDER_ID);
      provider.package = V2_OPENAI_COMPATIBLE_PACKAGE;
      provider.settings = {
        ...provider.settings,
        baseURL,
        includeUsage: true,
      };
    });

    for (const item of models) {
      catalog.model.update(CURSOR_PROVIDER_ID, item.id, (model) => {
        const context = item.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const output = item.maxTokens || DEFAULT_MAX_TOKENS;
        model.modelID = Model.ID.make(item.id);
        model.name = item.name;
        model.capabilities = {
          tools: true,
          input: ["text", "image"],
          output: ["text"],
        };
        model.limit = { context, output };
        model.headers = {
          ...model.headers,
          [CURSOR_SELECTION_HEADER]: encodeCursorModelSelection(
            item.defaultSelection,
          ),
        };
        model.variants = Object.entries(item.variants).map(
          ([id, selection]) => ({
            id: Model.VariantID.make(id),
            headers: {
              [CURSOR_SELECTION_HEADER]: encodeCursorModelSelection(selection),
            },
          }),
        );
        model.status = "active";
        model.enabled = true;
      });
    }
  });

  await ctx.session.hook("http.request", (event) => {
    if (event.model.providerID !== CURSOR_PROVIDER_ID) return;
    const selection = resolveCursorModelSelection(
      models,
      event.model.id,
      event.model.variant,
    );
    const request = new Request(`${baseURL}/chat/completions`, event.request);
    request.headers.delete("authorization");
    if (selection) {
      request.headers.set(
        CURSOR_SELECTION_HEADER,
        encodeCursorModelSelection(selection),
      );
    }
    event.request = request;
  });

  const current = await credential().catch(() => undefined);
  if (current?.access) await publishModels(current.access).catch(() => {});

  return () => host.stopProxy();
}

function withDefaultModel(models: CursorModel[]): CursorModel[] {
  if (models.some((model) => model.id === DEFAULT_MODEL_ID)) return models;
  const selected =
    models.find((model) => model.id === "composer-2") ??
    models.find((model) => model.id === "composer-2-fast") ??
    models.find((model) => model.id.startsWith("composer-")) ??
    models[0];
  if (!selected) return models;
  return [
    ...models,
    {
      ...selected,
      id: DEFAULT_MODEL_ID,
      name: `Default (${selected.name})`,
      reasoning: false,
      defaultSelection: literalCursorModelSelection(DEFAULT_MODEL_ID),
      variants: {},
    },
  ];
}

async function pollForCredential(
  params: CursorAuthParams,
  host: V2Runtime,
): Promise<CursorCredential> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const tokens = await host.tryPollCursorAuth(params.uuid, params.verifier);
      if (tokens) {
        return Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make(CURSOR_OAUTH_METHOD_ID),
          access: tokens.accessToken,
          refresh: tokens.refreshToken,
          expires: getTokenExpiry(tokens.accessToken),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/fetch|network|timeout|ECONN|ENOTFOUND|429|5\d\d/i.test(message)) {
        throw error;
      }
    }
    await host.sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Cursor authentication polling timeout");
}

export default Plugin.define({
  id: "opencode.provider.cursor",
  setup: setupV2,
});
