import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  signalProcessTree,
  spawnNodeProcessTree,
  terminateProcessTree,
} from "@wi/test-support";

const fixturePath = fileURLToPath(
  new URL("./milestone5-startup-shutdown-fixture.mjs", import.meta.url),
);
const activeFixturePath = fileURLToPath(
  new URL("./milestone5-active-shutdown-fixture.mjs", import.meta.url),
);
const children = new Set<ChildProcess>();
const homes = new Set<string>();

function startedServerPort(output: string): number | null {
  for (const line of output.split("\n")) {
    if (!line.includes('"event":"server_started"')) continue;
    const record = JSON.parse(line) as { readonly port?: unknown };
    if (typeof record.port === "number" && Number.isInteger(record.port)) return record.port;
  }
  return null;
}

async function halfOpenRejectedUpgrade(port: number, suffix: number): Promise<Socket> {
  const socket = createConnection({
    host: "127.0.0.1",
    port,
    allowHalfOpen: true,
  });
  socket.on("error", () => undefined);
  await within(
    new Promise<void>((resolve) => socket.once("connect", resolve)),
    2_000,
    () => `Rejected upgrade ${suffix} did not connect`,
  );
  socket.setEncoding("utf8");
  let response = "";
  const rejected = new Promise<void>((resolve) => {
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.includes("HTTP/1.1 401 Unauthorized")) resolve();
    });
  });
  socket.write(
    `GET /ws HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Origin: http://127.0.0.1:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n" +
      "Sec-WebSocket-Protocol: wi.v1\r\n" +
      "\r\n",
  );
  await within(rejected, 2_000, () => `Rejected upgrade ${suffix} received no 401 response`);
  return socket;
}

async function within<T>(operation: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message())), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all([...children].map((child) => terminateProcessTree(child)));
  children.clear();
  await Promise.all(
    [...homes].map((home) => rm(home, { recursive: true, force: true })),
  );
  homes.clear();
});

describe("Milestone 5 server process lifecycle", () => {
  it("exits with an active WebSocket and rejected half-open upgrades", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-process-main-"));
    homes.add(homeDirectory);
    const mainPath = fileURLToPath(new URL("../../apps/server/dist/main.js", import.meta.url));
    const child = await spawnNodeProcessTree([mainPath], {
      environment: { ...process.env, WI_HOME: homeDirectory, WI_PORT: "0" },
    });
    children.add(child);
    if (child.stdout === null || child.stderr === null) {
      throw new Error("Production main did not expose output pipes");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let signalStarted: (port: number) => void = () => undefined;
    const started = new Promise<number>((resolve) => {
      signalStarted = resolve;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const port = startedServerPort(stdout);
      if (port !== null) signalStarted(port);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const port = await within(
      started,
      8_000,
      () => `Production main did not start: ${stderr}`,
    );

    const origin = `http://127.0.0.1:${port}`;
    const bootstrap = await fetch(`${origin}/bootstrap`);
    const setCookie = bootstrap.headers.get("set-cookie");
    if (setCookie === null) throw new Error("Production main returned no bootstrap cookie");
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, "wi.v1", {
      origin,
      headers: { Cookie: setCookie.split(";", 1)[0] },
    });
    await within(
      new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      5_000,
      () => `Production WebSocket did not open: ${stderr}`,
    );
    const welcomed = new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { readonly kind?: unknown };
        if (message.kind === "welcome") resolve();
      });
    });
    socket.send(
      JSON.stringify({ v: 1, kind: "hello", clientId: "client_processMain", resume: [] }),
    );
    await within(welcomed, 5_000, () => `Production WebSocket was not welcomed: ${stderr}`);

    const incompleteHttp = createConnection({ host: "127.0.0.1", port });
    incompleteHttp.on("error", () => undefined);
    await within(
      new Promise<void>((resolve) => incompleteHttp.once("connect", resolve)),
      2_000,
      () => "Incomplete HTTP probe did not connect",
    );
    incompleteHttp.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}`);
    const incompleteHttpClosed = new Promise<void>((resolve) =>
      incompleteHttp.once("close", () => resolve()),
    );
    const rejectedUpgrades = await Promise.all(
      Array.from({ length: 3 }, (_, index) => halfOpenRejectedUpgrade(port, index)),
    );
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await signalProcessTree(child, "SIGTERM");
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      result = await within(
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
        }),
        12_000,
        () => `Production main did not exit: ${stderr}`,
      );
    } finally {
      for (const rejected of rejectedUpgrades) rejected.destroy();
    }
    await within(socketClosed, 2_000, () => "Production WebSocket did not close");
    await within(incompleteHttpClosed, 2_000, () => "Incomplete HTTP socket did not close");
    children.delete(child);

    expect(result).toEqual({ code: 0, signal: null });
    expect(stdout).toContain('"event":"server_shutdown_started"');
    expect(stdout).toContain('"event":"http_shutdown_forced"');
    expect(stdout).toContain('"event":"server_shutdown_completed"');
    expect(stderr).not.toContain("Error");
  }, 20_000);

  it("keeps production running when its stdout consumer closes", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-stdout-epipe-"));
    homes.add(homeDirectory);
    const mainPath = fileURLToPath(new URL("../../apps/server/dist/main.js", import.meta.url));
    const child = await spawnNodeProcessTree([mainPath], {
      environment: { ...process.env, WI_HOME: homeDirectory, WI_PORT: "0" },
    });
    children.add(child);
    if (child.stdout === null || child.stderr === null) {
      throw new Error("Production EPIPE fixture did not expose output pipes");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let signalStarted: (port: number) => void = () => undefined;
    const started = new Promise<number>((resolve) => {
      signalStarted = resolve;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const port = startedServerPort(stdout);
      if (port !== null) signalStarted(port);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const port = await within(
      started,
      8_000,
      () => `Production EPIPE fixture did not start: ${stderr}`,
    );

    child.stdout.destroy();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(
          `GET /health HTTP/1.1\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.once("end", () => resolve(text));
      socket.once("error", reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 421 /u);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).resolves.toMatchObject({
      status: 200,
    });

    await signalProcessTree(child, "SIGTERM");
    const result = await within(closed, 12_000, () => `Production EPIPE fixture did not exit: ${stderr}`);
    children.delete(child);
    expect(result).toEqual({ code: 0, signal: null });
    expect(stderr).not.toContain("EPIPE");
    expect(stderr).not.toContain("Error");
  }, 20_000);

  it("rejects every invalid runtime scalar before storage workers are spawned", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-invalid-runtime-"));
    homes.add(homeDirectory);
    const fixturePath = fileURLToPath(
      new URL("./milestone5-invalid-runtime-fixture.mjs", import.meta.url),
    );
    const child = await spawnNodeProcessTree([fixturePath, homeDirectory]);
    children.add(child);
    if (child.stdout === null || child.stderr === null) {
      throw new Error("Invalid-runtime fixture did not expose output pipes");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const result = await within(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      8_000,
      () => `Invalid-runtime fixture did not exit: ${stderr}`,
    );
    children.delete(child);

    expect(result).toEqual({ code: 0, signal: null });
    expect(stderr).not.toMatch(/Error|Unhandled|StorageError/u);
    expect(JSON.parse(stdout) as unknown).toEqual({
      rejected: [
        "providerCapacity",
        "toolCapacity",
        "actorIdleTimeoutMs",
        "actorEvictionIntervalMs",
        "reservedStorageHome",
        "reservedStorageClock",
        "catalogObservationShutdownTimeoutMs",
        "sessionWorkerSize",
        "sessionWorkerHandles",
        "sessionWorkerRequestTimeout",
        "sessionWorkerCloseTimeout",
        "catalogWorkerRequestTimeout",
        "catalogWorkerCloseTimeout",
      ],
    });
  }, 15_000);

  it("closes an active WebSocket and run on SIGTERM without leaking work", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-process-active-"));
    homes.add(homeDirectory);
    const child = await spawnNodeProcessTree([activeFixturePath, homeDirectory]);
    children.add(child);
    if (child.stdout === null || child.stderr === null) {
      throw new Error("Active shutdown fixture did not expose output pipes");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let signalActive = (): void => {};
    const active = new Promise<void>((resolve) => {
      signalActive = resolve;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("active-run-blocked\n")) signalActive();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await within(active, 8_000, () => `Active shutdown fixture did not block: ${stderr}`);
    await signalProcessTree(child, "SIGTERM");
    const result = await within(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      12_000,
      () => `Active shutdown fixture did not exit: ${stderr}`,
    );
    children.delete(child);

    expect(result).toEqual({ code: 0, signal: null });
    const summaryLine = stdout.trim().split("\n").at(-1);
    expect(JSON.parse(summaryLine ?? "null")).toEqual({
      fulfilled: true,
      address: null,
      socketClosed: true,
      runState: "interrupted",
    });
    expect(stderr).not.toContain("Error");
  }, 15_000);

  it.each([
    {
      name: "after storage readiness before recovery adoption",
      mode: "storage-ready",
      marker: "startup-blocked\n",
      pageCalls: 0,
      adoptedCandidates: 0,
    },
    {
      name: "after adopting recovery candidates across a full page boundary",
      mode: "candidate-pages",
      marker: "candidates-adopted\n",
      pageCalls: 2,
      adoptedCandidates: 1_001,
    },
    {
      name: "while the second recovery-candidate page is blocked",
      mode: "candidate-page-blocked",
      marker: "candidate-page-blocked\n",
      pageCalls: 2,
      adoptedCandidates: 1_000,
    },
  ])("handles SIGTERM $name", async ({ mode, marker, pageCalls, adoptedCandidates }) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-process-startup-"));
    homes.add(homeDirectory);
    const child = await spawnNodeProcessTree([fixturePath, homeDirectory, mode]);
    children.add(child);
    if (child.stdout === null || child.stderr === null) {
      throw new Error("Startup fixture did not expose output pipes");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let signalBlocked = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(marker)) signalBlocked();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await within(blocked, 5_000, () => `Startup fixture did not reach ${mode}: ${stderr}`);
    await signalProcessTree(child, "SIGTERM");
    const result = await within(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      10_000,
      () => `Startup fixture did not exit: ${stderr}`,
    );
    children.delete(child);

    expect(result).toEqual({ code: 0, signal: null });
    const summaryLine = stdout.trim().split("\n").at(-1);
    expect(JSON.parse(summaryLine ?? "null")).toEqual({
      fulfilled: true,
      address: null,
      mode,
      pageCalls,
      adoptedCandidates,
    });
    expect(stderr).not.toContain("Error");
  });
});
