import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  BootstrapResponseSchema,
  ServerMessageSchema,
  type ServerMessage,
} from "@wi/protocol";
import { RealServerProcess } from "@wi/test-support";

const productionServerPath = fileURLToPath(
  new URL("../../apps/server/dist/main.js", import.meta.url),
);
const processes = new Set<RealServerProcess>();
const roots = new Set<string>();

class TestSocket {
  private readonly inbox: ServerMessage[] = [];
  private transportError: Error | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("error", (error) => {
      this.transportError = error;
    });
    socket.on("message", (data) => {
      this.inbox.push(ServerMessageSchema.parse(JSON.parse(data.toString()) as unknown));
    });
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  async take(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.transportError !== null) throw this.transportError;
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as ServerMessage;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for server message: ${JSON.stringify(this.inbox)}`);
  }

  close(): void {
    this.socket.close();
  }
}

function serverPort(processHandle: RealServerProcess): number | null {
  for (const line of processHandle.diagnostics.stdout.tail.split("\n")) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (
        record.event === "server_started" &&
        typeof record.port === "number" &&
        Number.isSafeInteger(record.port)
      ) {
        return record.port;
      }
    } catch {
      // Ignore incomplete diagnostic-tail lines while startup is still progressing.
    }
  }
  return null;
}

async function waitForServerOrigin(processHandle: RealServerProcess): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const port = serverPort(processHandle);
    if (port !== null) return `http://127.0.0.1:${String(port)}`;
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
      const exit = await processHandle.waitForExit();
      throw new Error(
        `Production server exited before readiness: code=${String(exit.code)} stderr=${exit.stderr}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for production server readiness: ${processHandle.diagnostics.stdout.tail}`,
  );
}

async function startProductionServer(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly process: RealServerProcess; readonly origin: string }> {
  const processHandle = await RealServerProcess.start({
    fixturePath: productionServerPath,
    environment: {
      WI_PORT: "0",
      ...environment,
    },
    waitForReady: false,
  });
  processes.add(processHandle);
  return { process: processHandle, origin: await waitForServerOrigin(processHandle) };
}

async function stopProductionServer(processHandle: RealServerProcess): Promise<void> {
  await processHandle.signal("SIGTERM");
  await expect(processHandle.waitForExit(10_000)).resolves.toMatchObject({
    code: 0,
    signal: null,
  });
  processes.delete(processHandle);
}

async function connect(origin: string): Promise<TestSocket> {
  const bootstrap = await fetch(`${origin}/bootstrap`);
  const setCookie = bootstrap.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Bootstrap cookie is missing");
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, "wi.v1", {
    origin,
    headers: { Cookie: setCookie.split(";", 1)[0] },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const client = new TestSocket(socket);
  client.send({ v: 1, kind: "hello", clientId: "client_firstRun", resume: [] });
  await client.take((message) => message.kind === "welcome");
  return client;
}

afterEach(async () => {
  await Promise.allSettled([...processes].map((processHandle) => processHandle.terminate()));
  processes.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("production first-run bootstrap", () => {
  it("creates a missing default-equivalent home before starting", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "wi-first-run-default-"));
    roots.add(userHome);
    const homeDirectory = join(userHome, ".wi");

    const started = await startProductionServer({ HOME: userHome, WI_HOME: undefined });
    expect((await stat(homeDirectory)).isDirectory()).toBe(true);
    expect((await stat(homeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(homeDirectory, "catalog.sqlite3"))).isFile()).toBe(true);
    await stopProductionServer(started.process);
  });

  it("fails closed without starting workers when the home path is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-first-run-wrong-type-"));
    roots.add(root);
    const homeDirectory = join(root, "not-a-directory");
    await writeFile(homeDirectory, "occupied", "utf8");

    const processHandle = await RealServerProcess.start({
      fixturePath: productionServerPath,
      environment: { WI_HOME: homeDirectory, WI_PORT: "0" },
      waitForReady: false,
    });
    processes.add(processHandle);
    await expect(processHandle.waitForExit(10_000)).resolves.toMatchObject({
      code: 1,
      signal: null,
    });
    processes.delete(processHandle);
    expect(processHandle.diagnostics.stdout.tail).not.toContain(homeDirectory);
    expect(processHandle.diagnostics.stdout.tail).not.toContain("server_started");
    await expect(readFile(homeDirectory, "utf8")).resolves.toBe("occupied");
  });

  it("creates a missing nested configured home, creates a session, and restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-first-run-nested-"));
    roots.add(root);
    const homeDirectory = join(root, "new", "nested", ".wi");

    const first = await startProductionServer({ WI_HOME: homeDirectory });
    const client = await connect(first.origin);
    const commandId = "cmd_firstRunCreate";
    client.send({
      v: 1,
      kind: "command",
      commandId,
      method: "session.create",
      params: { title: "First run session" },
    });
    const accepted = await client.take(
      (message) => message.kind === "command.accepted" && message.commandId === commandId,
    );
    if (accepted.kind !== "command.accepted" || accepted.sessionId === undefined) {
      throw new Error("First-run session creation did not return a session ID");
    }
    const sessionId = accepted.sessionId;
    client.close();
    await stopProductionServer(first.process);

    const second = await startProductionServer({ WI_HOME: homeDirectory });
    const bootstrap = BootstrapResponseSchema.parse(
      await (await fetch(`${second.origin}/bootstrap`)).json(),
    );
    expect(bootstrap.sessions).toContainEqual(
      expect.objectContaining({
        sessionId,
        title: "First run session",
        status: "ready",
      }),
    );
    await stopProductionServer(second.process);
  });
});
