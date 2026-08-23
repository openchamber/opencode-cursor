import { expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import { decodeCursorModelSelection } from "../src/model-selection";
import { setupV2, type V2Runtime } from "../src/server";

test("V2 registers catalog, request hook, and host-owned OAuth", async () => {
  let catalogTransform: (draft: any) => void = () => {};
  let integrationTransform: (draft: any) => void = () => {};
  let requestHook: (event: any) => void | Promise<void> = () => {};
  let reloads = 0;
  let stopped = false;

  const model = {
    id: "cursor-model",
    name: "Cursor Model",
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 10_000,
    defaultSelection: {
      publicId: "cursor-model",
      modelId: "server-model",
      displayName: "Cursor Model",
      parameters: [],
      maxMode: false,
    },
    variants: {
      high: {
        publicId: "cursor-model-high",
        modelId: "server-model",
        displayName: "Cursor Model High",
        parameters: [{ id: "effort", value: "high" }],
        maxMode: false,
      },
    },
  };

  const host: V2Runtime = {
    async startProxy() { return 4321; },
    stopProxy() { stopped = true; },
    async getCursorModels() { return [model]; },
    clearModelCache() {},
    async generateCursorAuthParams() {
      return {
        verifier: "verifier",
        challenge: "challenge",
        uuid: "uuid",
        loginUrl: "https://cursor.example/login",
      };
    },
    async tryPollCursorAuth() {
      return { accessToken: "access", refreshToken: "refresh" };
    },
    async refreshCursorToken() {
      return { access: "new-access", refresh: "new-refresh", expires: 123 };
    },
    async sleep() {},
  };

  const ctx = {
    catalog: {
      async transform(callback: (draft: any) => void) {
        catalogTransform = callback;
        return { async dispose() {} };
      },
      async reload() { reloads += 1; },
    },
    integration: {
      async transform(callback: (draft: any) => void) {
        integrationTransform = callback;
        return { async dispose() {} };
      },
      connection: {
        async active() { return undefined; },
        async resolve() { return undefined; },
      },
    },
    session: {
      async hook(name: string, callback: (event: any) => void | Promise<void>) {
        expect(name).toBe("http.request");
        requestHook = callback;
        return { async dispose() {} };
      },
    },
  } as unknown as Plugin.Context;

  const cleanup = await setupV2(ctx, host);

  let method: any;
  integrationTransform({
    update(_id: string, update: (value: any) => void) { update({ name: "" }); },
    method: { update(value: any) { method = value; } },
  });
  expect(method.integrationID).toBe("cursor");
  expect(method.method).toMatchObject({ id: "cursor-browser", type: "oauth" });

  const authorization = await method.authorize({});
  expect(authorization).toMatchObject({
    url: "https://cursor.example/login",
    mode: "auto",
  });
  expect(await authorization.callback).toMatchObject({
    type: "oauth",
    methodID: "cursor-browser",
    access: "access",
    refresh: "refresh",
  });
  expect(reloads).toBe(1);

  const provider: any = { settings: {} };
  const models: Record<string, any> = {};
  catalogTransform({
    provider: { update(_id: string, update: (value: any) => void) { update(provider); } },
    model: {
      update(_provider: string, id: string, update: (value: any) => void) {
        models[id] ??= { headers: {} };
        update(models[id]);
      },
    },
  });
  expect(provider).toMatchObject({
    name: "Cursor",
    integrationID: "cursor",
    package: "@opencode-ai/ai/providers/openai-compatible",
    settings: { baseURL: "http://localhost:4321/v1" },
  });
  expect(models["cursor-model"].variants[0].id).toBe("high");
  expect(models.default.name).toBe("Default (Cursor Model)");

  const event = {
    model: { providerID: "cursor", id: "cursor-model", variant: "high" },
    request: new Request("https://upstream.example/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer host-secret" },
      body: "{}",
    }),
  };
  await requestHook(event);
  expect(event.request.url).toBe("http://localhost:4321/v1/chat/completions");
  expect(event.request.headers.has("authorization")).toBe(false);
  expect(
    decodeCursorModelSelection(
      event.request.headers.get("x-opencode-cursor-selection") ?? undefined,
    ),
  ).toMatchObject({ publicId: "cursor-model-high", modelId: "server-model" });

  await cleanup();
  expect(stopped).toBe(true);
});
