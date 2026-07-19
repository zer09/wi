import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface ReadyMessage {
  readonly type: "ready";
  readonly origin: string;
}

interface RunningChild {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly output: () => string;
}

export interface RestartableServer {
  readonly origin: string;
  restart(): Promise<void>;
  close(): Promise<void>;
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      reject(new Error("Restartable Wi server did not exit before the deadline"));
    }, timeoutMs);
    child.once("exit", finish);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: "close" });
  try {
    await waitForExit(child);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child).catch((killError: unknown) => {
      throw new AggregateError([error, killError], "Restartable Wi server cleanup failed");
    });
  }
  if (child.exitCode !== 0) {
    throw new Error(`Restartable Wi server exited with code ${child.exitCode}`);
  }
}

async function launch(homeDirectory: string, fixedPort?: number): Promise<RunningChild> {
  const script = fileURLToPath(new URL("./server-process.mjs", import.meta.url));
  const child = fork(
    script,
    [homeDirectory, "-", ...(fixedPort === undefined ? [] : [String(fixedPort)])],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out starting restartable Wi server\n${stdout}\n${stderr}`));
      }, 30_000);
      const onMessage = (message: unknown): void => {
        if (
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "ready" &&
          "origin" in message &&
          typeof message.origin === "string"
        ) {
          cleanup();
          resolve(message as ReadyMessage);
        }
      };
      const onExit = (): void => {
        cleanup();
        reject(
          new Error(
            `Restartable Wi server exited before ready (${child.exitCode})\n${stdout}\n${stderr}`,
          ),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
    });
    return { child, origin: ready.origin, output: () => `${stdout}\n${stderr}` };
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child).catch(() => undefined);
    throw error;
  }
}

export async function startRestartableServer(): Promise<RestartableServer> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-e2e-restart-"));
  let current: RunningChild;
  try {
    current = await launch(homeDirectory);
  } catch (error) {
    await rm(homeDirectory, { recursive: true, force: true });
    throw error;
  }
  const origin = current.origin;
  const port = Number(new URL(origin).port);
  let closed = false;

  return {
    origin,
    async restart() {
      if (closed) throw new Error("Restartable Wi server is closed");
      const previous = current;
      await stopChild(previous.child).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${previous.output()}`);
      });
      current = await launch(homeDirectory, port);
      if (current.origin !== origin) {
        throw new Error(`Restart changed origin from ${origin} to ${current.origin}`);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      await stopChild(current.child).catch((error: unknown) => errors.push(error));
      await rm(homeDirectory, { recursive: true, force: true }).catch((error: unknown) =>
        errors.push(error),
      );
      if (errors.length > 0) throw new AggregateError(errors, "Restartable Wi cleanup failed");
    },
  };
}
