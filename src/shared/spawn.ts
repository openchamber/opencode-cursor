import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";

export interface BridgeProcess {
  stdin: {
    write(chunk: Uint8Array | Buffer): boolean | void;
    end(): void;
  };
  stdout: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    };
  };
  kill(signal?: string): void;
  exited: Promise<number>;
}

export function spawnBridgeProcess(command: string[], scriptPath: string): BridgeProcess {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    const proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    return {
      stdin: {
        write(chunk) {
          proc.stdin.write(chunk);
        },
        end() {
          proc.stdin.end();
        },
      },
      stdout: proc.stdout as any,
      kill(signal) {
        proc.kill(signal as any);
      },
      exited: proc.exited,
    };
  }

  // Node.js fallback using standard event-driven stream
  const child: ChildProcess = nodeSpawn(command[0]!, command.slice(1), {
    stdio: ["pipe", "pipe", "ignore"],
  });

  const queue: Array<{ done: boolean; value?: Uint8Array }> = [];
  let pendingResolve: ((res: { done: boolean; value?: Uint8Array }) => void) | null = null;

  child.stdout!.on("data", (chunk: Buffer) => {
    const item = { done: false, value: new Uint8Array(chunk) };
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(item);
    } else {
      queue.push(item);
    }
  });

  child.stdout!.on("end", () => {
    const item = { done: true, value: undefined };
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(item);
    } else {
      queue.push(item);
    }
  });

  child.stdout!.on("error", () => {
    const item = { done: true, value: undefined };
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(item);
    } else {
      queue.push(item);
    }
  });

  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });

  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (queue.length > 0) {
        return queue.shift()!;
      }
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },
  };

  return {
    stdin: {
      write(chunk) {
        child.stdin?.write(chunk);
      },
      end() {
        child.stdin?.end();
      },
    },
    stdout: {
      getReader() {
        return reader;
      },
    },
    kill(signal) {
      child.kill((signal as any) || "SIGTERM");
    },
    exited,
  };
}
