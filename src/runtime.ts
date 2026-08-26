import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface RuntimeProcess {
  stdin: {
    write(data: Uint8Array): unknown;
    end(): unknown;
  };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): unknown;
}

/**
 * Start a Node-only bridge from either Bun or Node/Electron.
 *
 * Bun deliberately delegates to an external Node executable because its
 * node:http2 implementation is not suitable for Cursor's streaming bridge.
 * Electron can run its bundled executable as Node via ELECTRON_RUN_AS_NODE,
 * so desktop hosts do not need a shell-visible `node` binary.
 */
export function spawnNodeBridge(scriptPath: string): RuntimeProcess {
  if (typeof Bun !== "undefined") {
    return Bun.spawn(["node", scriptPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    }) as RuntimeProcess;
  }

  const electron = Boolean(process.versions.electron);
  const child = spawn(process.execPath, [scriptPath], {
    env: electron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : process.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });

  return {
    stdin: child.stdin,
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    exited,
    kill: () => child.kill(),
  };
}

export interface FetchServer {
  readonly port: number;
  stop(): void;
}

interface FetchServerOptions {
  port: number;
  idleTimeout?: number;
  fetch(request: Request): Response | Promise<Response>;
}

/** Serve a Fetch-style handler in both Bun CLI and Node/Electron hosts. */
export async function serveFetch(options: FetchServerOptions): Promise<FetchServer> {
  if (typeof Bun !== "undefined") {
    const server = Bun.serve({
      port: options.port,
      idleTimeout: options.idleTimeout ?? 255,
      fetch: options.fetch,
    });
    if (!server.port) {
      server.stop();
      throw new Error("Failed to bind proxy to a port");
    }
    return {
      port: server.port,
      stop: () => server.stop(),
    };
  }

  const server = createServer((incoming, outgoing) => {
    void handleNodeRequest(incoming, outgoing, options.fetch);
  });
  server.keepAliveTimeout = (options.idleTimeout ?? 5) * 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "localhost");
  });

  const address = server.address() as AddressInfo | null;
  if (!address?.port) {
    server.close();
    throw new Error("Failed to bind proxy to a port");
  }

  return {
    port: address.port,
    stop() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

async function handleNodeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: FetchServerOptions["fetch"],
): Promise<void> {
  const abortController = new AbortController();
  incoming.once("aborted", () => abortController.abort());
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) abortController.abort();
  });

  try {
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
    }

    const method = incoming.method ?? "GET";
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      signal: abortController.signal,
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }

    const host = incoming.headers.host ?? "localhost";
    const request = new Request(
      new URL(incoming.url ?? "/", `http://${host}`),
      init,
    );
    const response = await handler(request);

    outgoing.statusCode = response.status;
    if (response.statusText) outgoing.statusMessage = response.statusText;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));

    if (!response.body || method === "HEAD") {
      outgoing.end();
      return;
    }

    await pipeline(
      Readable.fromWeb(
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ),
      outgoing,
    );
  } catch (error) {
    if (abortController.signal.aborted) return;
    if (outgoing.headersSent) {
      outgoing.destroy(error instanceof Error ? error : undefined);
      return;
    }
    outgoing.writeHead(500, { "Content-Type": "text/plain" });
    outgoing.end("Internal Server Error");
  }
}
