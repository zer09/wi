import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ServerMessageSchema, type ServerMessage } from "@wi/protocol";
import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
} from "@wi/storage";
import { RealServerHarness, type RealServerProcess } from "@wi/test-support";

import { FixtureProcessRunner } from "./fixture-process.js";

const fixturePath = fileURLToPath(new URL("./milestone7-server-fixture.mjs", import.meta.url));
const provenanceMutationFixturePath = fileURLToPath(
  new URL("./milestone7-provenance-mutation-fixture.mjs", import.meta.url),
);
const storageCloseFixturePath = fileURLToPath(
  new URL("./milestone7-storage-close-fixture.mjs", import.meta.url),
);
const harnesses = new Set<RealServerHarness>();
const fixtureProcesses = new FixtureProcessRunner(2_000);

class TestSocket {
  readonly all: ServerMessage[] = [];
  private readonly inbox: ServerMessage[] = [];
  private expectedCrashReset = false;
  private transportError: Error | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("error", (error) => {
      // Deliberate failpoint process exits can reset the TCP connection. Keep
      // this narrow: every other transport error remains visible to assertions.
      if (this.expectedCrashReset && (error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      this.transportError = error;
    });
    socket.on("message", (data) => {
      const message = ServerMessageSchema.parse(JSON.parse(data.toString()) as unknown);
      this.all.push(message);
      this.inbox.push(message);
    });
  }

  allowExpectedCrashReset(): void {
    this.expectedCrashReset = true;
  }

  send(value: unknown): void {
    try {
      this.socket.send(JSON.stringify(value));
    } catch (error) {
      if (this.expectedCrashReset && (error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      throw error;
    }
  }

  async take(predicate: (message: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.transportError !== null) throw this.transportError;
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as ServerMessage;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for server message: ${JSON.stringify(this.all)}`);
  }

  close(): void {
    this.socket.close();
  }
}

function isConnectionReset(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return true;
    if ("cause" in error) return isConnectionReset(error.cause);
  }
  return false;
}

async function connect(origin: string, allowExpectedCrashReset = false): Promise<TestSocket> {
  let bootstrap: Response;
  try {
    bootstrap = await fetch(`${origin}/bootstrap`);
  } catch (error) {
    if (!allowExpectedCrashReset || !isConnectionReset(error)) throw error;
    // The immediately preceding fixture deliberately died with an open socket.
    // Retry only this known stale keep-alive reset; all other bootstrap failures
    // remain test failures.
    await new Promise((resolve) => setTimeout(resolve, 10));
    bootstrap = await fetch(`${origin}/bootstrap`);
  }
  const setCookie = bootstrap.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Bootstrap cookie is missing");
  const openSocket = async (): Promise<WebSocket> => {
    const candidate = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, "wi.v1", {
      origin,
      headers: { Cookie: setCookie.split(";", 1)[0] },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("open", resolve);
        candidate.once("error", reject);
      });
      return candidate;
    } catch (error) {
      candidate.terminate();
      throw error;
    }
  };
  let socket: WebSocket;
  try {
    socket = await openSocket();
  } catch (error) {
    if (!allowExpectedCrashReset || !isConnectionReset(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket = await openSocket();
  }
  const client = new TestSocket(socket);
  client.send({ v: 1, kind: "hello", clientId: "client_milestone7", resume: [] });
  await client.take((message) => message.kind === "welcome");
  return client;
}

function command(client: TestSocket, value: unknown): void {
  client.send(value);
}

async function replay(client: TestSocket, sessionId: string): Promise<readonly ServerMessage[]> {
  client.send({
    v: 1,
    kind: "subscribe",
    requestId: `req_m7_${Date.now()}`,
    sessionId,
    afterSequence: 0,
  });
  await client.take(
    (message) => message.kind === "replay.complete" && message.sessionId === sessionId,
  );
  return client.all.filter(
    (message) => message.kind === "event" && message.sessionId === sessionId,
  );
}

async function start(
  harness: RealServerHarness,
  scenario = "plain-text",
  failpoint?: string,
  repairMode = "auto",
): Promise<{ readonly process: RealServerProcess; readonly origin: string; readonly ready: Record<string, unknown> }> {
  const processHandle = await harness.start({
    fixturePath,
    arguments: [scenario, repairMode],
    environment:
      failpoint === undefined
        ? {}
        : {
            NODE_ENV: "test",
            WI_ALLOW_TEST_FAILPOINTS: "1",
            WI_TEST_FAILPOINT: failpoint,
          },
  });
  const portRecord = await findServerOrigin(processHandle);
  return { process: processHandle, origin: portRecord.origin, ready: portRecord };
}

async function findServerOrigin(processHandle: RealServerProcess): Promise<{ origin: string; [key: string]: unknown }> {
  processHandle.send({ type: "report-ready" });
  const message = await processHandle.waitForMessage("ready-report");
  if (typeof message.origin !== "string") throw new Error("Server ready report has no origin");
  return { ...message, origin: message.origin };
}

async function stop(processHandle: RealServerProcess): Promise<void> {
  processHandle.send("shutdown");
  await processHandle.waitForExit();
}

async function seedSession(
  homeDirectory: string,
  suffix: string,
  projectId?: string,
  explicitSessionId = `ses_m7${suffix}`,
  title = `Milestone 7 ${suffix}`,
): Promise<string> {
  const storage = new SessionStoreManager({
    homeDirectory,
    ids: {
      sessionId: () => explicitSessionId,
      eventId: () => `evt_m7${suffix}created`,
    },
    now: () => 1_000,
  });
  try {
    const created = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: `cmd_m7${suffix}create`,
      method: "session.create",
      params: {
        title,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    return created.session.sessionId;
  } finally {
    await storage.close();
  }
}

async function mutateCreationProvenance(
  homeDirectory: string,
  sessionId: string,
  mutation:
    | "result-session"
    | "payload-hash"
    | "event-id"
    | "accepted-at"
    | "command-id"
    | "user-version",
  value: string,
): Promise<void> {
  const databasePath = resolveStoragePath(
    homeDirectory,
    sessionDatabaseRelativePath(sessionId),
  );
  const result = await fixtureProcesses.run(
    process.execPath,
    [provenanceMutationFixturePath, databasePath, mutation, value],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
}

async function mutateCatalogSession(
  homeDirectory: string,
  sessionId: string,
  mutation: "catalog-session-stale" | "catalog-session-path",
): Promise<void> {
  const result = await fixtureProcesses.run(
    process.execPath,
    [
      provenanceMutationFixturePath,
      join(homeDirectory, "catalog.sqlite3"),
      mutation,
      sessionId,
    ],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
}

async function makeCatalogSessionStale(
  homeDirectory: string,
  sessionId: string,
): Promise<void> {
  await mutateCatalogSession(homeDirectory, sessionId, "catalog-session-stale");
}

function maximumLengthSessionId(index: number): string {
  const unique = `a${String(index).padStart(5, "0")}`;
  return `ses_${unique}${"x".repeat(120 - unique.length)}`;
}

async function seedMaximumCatalog(homeDirectory: string, count: number): Promise<void> {
  const result = await fixtureProcesses.run(
    process.execPath,
    [
      provenanceMutationFixturePath,
      join(homeDirectory, "catalog.sqlite3"),
      "catalog-seed-maximum",
      String(count),
    ],
    15_000,
  );
  expect(result).toMatchObject({ code: 0, signal: null });
}

async function readSessionUserVersion(
  homeDirectory: string,
  sessionId: string,
): Promise<number> {
  const databasePath = resolveStoragePath(
    homeDirectory,
    sessionDatabaseRelativePath(sessionId),
  );
  const result = await fixtureProcesses.run(
    process.execPath,
    [provenanceMutationFixturePath, databasePath, "read-user-version", "unused"],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
  return Number.parseInt(result.stdout.trim(), 10);
}

async function deleteCatalog(homeDirectory: string): Promise<void> {
  await Promise.all(
    ["", "-wal", "-shm"].map((suffix) =>
      rm(join(homeDirectory, `catalog.sqlite3${suffix}`), { force: true }),
    ),
  );
}

async function seedPendingInput(homeDirectory: string): Promise<{
  readonly sessionId: string;
  readonly inputId: string;
}> {
  const sessionId = await seedSession(homeDirectory, "pendinginput");
  const storage = new SessionStoreManager({ homeDirectory });
  const runId = "run_m7PendingInput";
  const inputId = "input_m7PendingInput";
  try {
    const session = await storage.openSession(sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_m7PendingInputRunCreated",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId },
        },
        {
          eventId: "evt_m7PendingInputRunStarted",
          eventType: "run.started",
          createdAtMs: 2_001,
          data: { eventVersion: 1, runId },
        },
        {
          eventId: "evt_m7PendingInputRequested",
          eventType: "input.requested",
          createdAtMs: 2_002,
          data: { eventVersion: 1, runId, inputId, prompt: "Continue?" },
        },
        {
          eventId: "evt_m7PendingInputWaiting",
          eventType: "run.waiting_for_user",
          createdAtMs: 2_003,
          data: { eventVersion: 1, runId, reason: "input", inputId },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId,
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: { scenario: "plain-text" },
          createdAtMs: 2_000,
          startedAtMs: 2_001,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId,
          runId,
          state: "pending",
          prompt: "Continue?",
          requestedAtMs: 2_002,
        },
      ],
    });
    await storage.drainCatalogObservations();
  } finally {
    await storage.close();
  }
  return { sessionId, inputId };
}

afterEach(async () => {
  await fixtureProcesses.terminateAll();
  await Promise.all([...harnesses].map((harness) => harness.cleanup()));
  harnesses.clear();
});

const workflowFailpoints = [
  ["after_command_event_insert_before_commit", "plain-text", 90],
  ["after_command_commit_before_ack", "plain-text", 91],
  ["after_event_commit_before_publish", "plain-text", 92],
  ["after_tool_requested_commit", "echo-tool-round-trip", 93],
  ["after_tool_started_commit", "echo-tool-round-trip", 94],
  ["after_tool_result_commit_before_provider_continue", "echo-tool-round-trip", 95],
  ["after_provider_text_commit", "staged-tool-then-text-without-terminal", 96],
  ["after_run_terminal_commit", "plain-text", 97],
] as const;

describe("Milestone 7 real server crash recovery", () => {
  it.each(workflowFailpoints)(
    "recovers %s through the real WebSocket server",
    async (failpoint, scenario, exitCode) => {
      const harness = await RealServerHarness.create(`wi-m7-${failpoint}-`);
      harnesses.add(harness);
      const sessionId = await seedSession(harness.homeDirectory, failpoint.replaceAll("_", "").slice(0, 20));
      const crashedServer = await start(harness, scenario, failpoint);
      const socket = await connect(crashedServer.origin);
      command(socket, {
        v: 1,
        kind: "command",
        commandId: `cmd_m7_submit_${exitCode}`,
        sessionId,
        method: "message.submit",
        params: { text: `Trigger ${failpoint}` },
      });
      const crashed = await crashedServer.process.waitForExit(15_000);
      expect(crashed).toMatchObject({ code: exitCode, signal: null });

      const restarted = await start(harness, scenario);
      const recoveredSocket = await connect(restarted.origin);
      const events = [...(await replay(recoveredSocket, sessionId))];
      if (
        scenario === "echo-tool-round-trip" &&
        !events.some(
          (message) => message.kind === "event" && message.eventType === "run.completed",
        )
      ) {
        events.push(
          await recoveredSocket.take(
            (message) => message.kind === "event" && message.eventType === "run.completed",
          ),
        );
      }
      let eventTypes = events.flatMap((message) =>
        message.kind === "event" ? [message.eventType] : [],
      );
      if (failpoint === "after_command_event_insert_before_commit") {
        expect(eventTypes).not.toContain("user.message.appended");
        command(recoveredSocket, {
          v: 1,
          kind: "command",
          commandId: `cmd_m7_submit_${exitCode}`,
          sessionId,
          method: "message.submit",
          params: { text: `Trigger ${failpoint}` },
        });
        await expect(
          recoveredSocket.take(
            (message) => message.kind === "command.accepted" && message.commandId === `cmd_m7_submit_${exitCode}`,
          ),
        ).resolves.toMatchObject({ kind: "command.accepted", duplicate: false });
      } else {
        expect(eventTypes).toContain("user.message.appended");
      }
      if (failpoint !== "after_command_event_insert_before_commit") {
        command(recoveredSocket, {
          v: 1,
          kind: "command",
          commandId: `cmd_m7_submit_${exitCode}`,
          sessionId,
          method: "message.submit",
          params: { text: `Trigger ${failpoint}` },
        });
        await expect(
          recoveredSocket.take(
            (message) => message.kind === "command.accepted" && message.commandId === `cmd_m7_submit_${exitCode}`,
          ),
        ).resolves.toMatchObject({ kind: "command.accepted", duplicate: true });
      }
      const terminalEventTypes = [
        "run.completed",
        "run.failed",
        "run.cancelled",
        "run.interrupted",
      ];
      if (!eventTypes.some((type) => terminalEventTypes.includes(type))) {
        events.push(
          await recoveredSocket.take(
            (message) =>
              message.kind === "event" && terminalEventTypes.includes(message.eventType),
          ),
        );
        eventTypes = events.flatMap((message) =>
          message.kind === "event" ? [message.eventType] : [],
        );
      }
      const terminalTypes = eventTypes.filter((type) => terminalEventTypes.includes(type));
      expect(terminalTypes).toEqual([
        failpoint === "after_provider_text_commit" ? "run.interrupted" : "run.completed",
      ]);
      const durableEvents = events.filter((message) => message.kind === "event");
      expect(new Set(durableEvents.map((event) => event.eventId)).size).toBe(durableEvents.length);
      if (failpoint === "after_provider_text_commit") {
        expect(eventTypes).toContain("provider.tool_call.staged");
        expect(eventTypes).toContain("provider.text.delta");
        expect(eventTypes).not.toContain("assistant.message.completed");
      }
      if (failpoint === "after_run_terminal_commit") {
        expect(eventTypes).toContain("assistant.message.completed");
        expect(eventTypes).not.toContain("run.interrupted");
      }
      recoveredSocket.close();
      await stop(restarted.process);
      if (
        scenario === "echo-tool-round-trip" ||
        scenario === "staged-tool-then-text-without-terminal"
      ) {
        const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
        try {
          const session = await storage.openSession(sessionId);
          const durableEvents = await session.getEventsAfter(0);
          const created = durableEvents.find((event) => event.eventType === "run.created");
          if (created?.eventType !== "run.created") throw new Error("Recovered run is missing");
          const tools = await session.getToolExecutionsForRun(created.data.runId);
          expect(tools).toHaveLength(1);
          if (failpoint === "after_provider_text_commit") {
            expect(tools[0]).toMatchObject({ state: "discarded", attemptCount: 0 });
            await expect(
              readFile(join(harness.homeDirectory, "milestone7-tool-executions.log"), "utf8"),
            ).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(tools[0]).toMatchObject({
              state: "completed",
              attemptCount: failpoint === "after_tool_started_commit" ? 2 : 1,
            });
            const executionLines = (await readFile(
              join(harness.homeDirectory, "milestone7-tool-executions.log"),
              "utf8",
            )).trim().split("\n").filter(Boolean);
            expect(executionLines).toHaveLength(1);
          }
        } finally {
          await storage.close();
        }
      }
    },
    30_000,
  );

  it("survives two consecutive crashes with the same publication failpoint", async () => {
    const harness = await RealServerHarness.create("wi-m7-double-crash-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "doublecrash");
    const first = await start(harness, "plain-text", "after_event_commit_before_publish");
    const firstSocket = await connect(first.origin);
    // This socket is intentionally reset by the crash failpoint immediately
    // after the command is accepted; do not mask errors outside this window.
    firstSocket.allowExpectedCrashReset();
    command(firstSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_double_crash",
      sessionId,
      method: "message.submit",
      params: { text: "Crash twice at publication boundaries." },
    });
    await expect(first.process.waitForExit()).resolves.toMatchObject({ code: 92, signal: null });

    // Startup actor adoption owns the second recovery attempt. Do not race a
    // browser connection against the deliberate process exit.
    const second = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_event_commit_before_publish",
      },
      waitForReady: false,
    });
    await expect(second.waitForExit()).resolves.toMatchObject({ code: 92, signal: null });

    const third = await start(harness);
    const thirdSocket = await connect(third.origin, true);
    const events = await replay(thirdSocket, sessionId);
    expect(events.filter((message) => message.kind === "event" && message.eventType === "run.interrupted"))
      .toHaveLength(1);
    await stop(third.process);
  }, 30_000);

  it("gracefully interrupts a provider stream on SIGTERM and replays it", async () => {
    const harness = await RealServerHarness.create("wi-m7-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "sigterm");
    const server = await start(harness, "provider-never-completes-until-aborted");
    const socket = await connect(server.origin);
    await replay(socket, sessionId);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_sigterm_submit",
      sessionId,
      method: "message.submit",
      params: { text: "Remain active until SIGTERM." },
    });
    await socket.take(
      (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_sigterm_submit",
    );
    await server.process.signal("SIGTERM");
    await expect(server.process.waitForExit(15_000)).resolves.toMatchObject({ code: 0, signal: null });

    const restarted = await start(harness);
    const replaySocket = await connect(restarted.origin);
    const events = await replay(replaySocket, sessionId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "run.interrupted" }),
      ]),
    );
    await stop(restarted.process);
  }, 30_000);

  it("adopts and recovers a catalog candidate before any browser reconnects", async () => {
    const harness = await RealServerHarness.create("wi-m7-no-browser-recovery-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "nobrowser");
    const crashed = await harness.start({
      fixturePath,
      arguments: ["provider-never-completes-until-aborted", "auto"],
      environment: { WI_M7_BLOCK_CATALOG_OBSERVATION: "1" },
    });
    const ready = await findServerOrigin(crashed);
    const socket = await connect(ready.origin);
    await replay(socket, sessionId);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_no_browser_recovery",
      sessionId,
      method: "message.submit",
      params: { text: "Recover this without a browser." },
    });
    await crashed.waitForMessage("catalog-observation-blocked");
    await socket.take(
      (message) => message.kind === "event" && message.eventType === "provider.step.started",
    );
    await crashed.signal("SIGKILL");
    await crashed.waitForExit();

    // start() returns only after runtime.ready(), including candidate adoption.
    // No HTTP bootstrap or WebSocket connection occurs on this restart.
    const adopted = await start(harness);
    await adopted.process.signal("SIGKILL");
    await adopted.process.waitForExit();

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      const session = await storage.openSession(sessionId);
      const events = await session.getEventsAfter(0);
      expect(events.filter((event) => event.eventType === "run.interrupted")).toHaveLength(1);
      await expect(session.getNonterminalRuns()).resolves.toHaveLength(0);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("shuts down cleanly while historical replay is in flight", async () => {
    const harness = await RealServerHarness.create("wi-m7-replay-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "replaysigterm");
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: { WI_M7_BLOCK_REPLAY: "1" },
    });
    const ready = await findServerOrigin(processHandle);
    const socket = await connect(ready.origin);
    socket.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_m7_replay_sigterm",
      sessionId,
      afterSequence: 0,
    });
    await processHandle.waitForMessage("replay-blocked");
    await processHandle.signal("SIGTERM");
    await expect(processHandle.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });

    const restarted = await start(harness);
    const restartedSocket = await connect(restarted.origin);
    const events = await replay(restartedSocket, sessionId);
    expect(events.filter((message) => message.kind === "event" && message.eventType === "session.created"))
      .toHaveLength(1);
    await stop(restarted.process);
  }, 30_000);

  it("shuts down cleanly while a committed catalog observation is in flight", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-observation-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "catalogobservationsigterm");
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: { WI_M7_BLOCK_CATALOG_OBSERVATION: "1" },
    });
    const ready = await findServerOrigin(processHandle);
    const socket = await connect(ready.origin);
    await replay(socket, sessionId);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_catalog_observation_sigterm",
      sessionId,
      method: "message.submit",
      params: { text: "Commit while catalog observation is blocked." },
    });
    await processHandle.waitForMessage("catalog-observation-blocked");
    await processHandle.signal("SIGTERM");
    await expect(processHandle.waitForExit(15_000)).resolves.toMatchObject({ code: 0, signal: null });

    const restarted = await start(harness);
    const restartedSocket = await connect(restarted.origin);
    const events = await replay(restartedSocket, sessionId);
    const eventTypes = events.flatMap((message) => message.kind === "event" ? [message.eventType] : []);
    expect(eventTypes).toContain("user.message.appended");
    expect(eventTypes.filter((type) => ["run.completed", "run.interrupted"].includes(type)))
      .toHaveLength(1);
    await stop(restarted.process);
  }, 30_000);

  it.each(["replay", "catalog-observation"] as const)(
    "bounds shutdown when a noncooperative %s gate is retained",
    async (kind) => {
      const harness = await RealServerHarness.create(`wi-m7-${kind}-noncooperative-`);
      harnesses.add(harness);
      const sessionId = await seedSession(harness.homeDirectory, `${kind}noncooperative`);
      const processHandle = await harness.start({
        fixturePath,
        arguments: ["plain-text", "auto"],
        environment: {
          WI_M7_RETAIN_BLOCKS_ON_SHUTDOWN: "1",
          ...(kind === "replay"
            ? { WI_M7_BLOCK_REPLAY: "1" }
            : { WI_M7_BLOCK_CATALOG_OBSERVATION: "1" }),
        },
      });
      const ready = await findServerOrigin(processHandle);
      const socket = await connect(ready.origin);
      if (kind === "replay") {
        socket.send({
          v: 1,
          kind: "subscribe",
          requestId: "req_m7_noncooperative_replay",
          sessionId,
          afterSequence: 0,
        });
        await processHandle.waitForMessage("replay-blocked");
      } else {
        await replay(socket, sessionId);
        command(socket, {
          v: 1,
          kind: "command",
          commandId: "cmd_m7_noncooperative_catalog",
          sessionId,
          method: "message.submit",
          params: { text: "Remain blocked through shutdown." },
        });
        await processHandle.waitForMessage("catalog-observation-blocked");
      }

      const shutdownStartedAt = Date.now();
      await processHandle.signal("SIGTERM");
      const exit = await processHandle.waitForExit(10_000);
      expect(Date.now() - shutdownStartedAt).toBeLessThan(5_000);
      expect(exit).toMatchObject({ code: kind === "replay" ? 0 : 1, signal: null });
      if (kind === "replay") {
        expect(exit.stderr).not.toContain("Error");
      } else {
        expect(exit.stderr).toContain("shutdown");
      }

      const restarted = await start(harness);
      const restartedSocket = await connect(restarted.origin);
      const events = await replay(restartedSocket, sessionId);
      if (kind === "catalog-observation") {
        expect(events.some(
          (message) => message.kind === "event" && message.eventType === "user.message.appended",
        )).toBe(true);
      }
      await stop(restarted.process);
    },
    30_000,
  );

  it("bounds shutdown when a session worker request is blocked and times out", async () => {
    const harness = await RealServerHarness.create("wi-m7-storage-request-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "storagerequestsigterm");
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_M7_BLOCK_STORAGE_REQUEST: "1",
      },
    });
    processHandle.send({ type: "block-storage", sessionId });
    await processHandle.waitForMessage("storage-request-blocked");
    const shutdownStartedAt = Date.now();
    await processHandle.signal("SIGTERM");
    const blockedExit = await processHandle.waitForExit(15_000);
    expect(Date.now() - shutdownStartedAt).toBeLessThan(5_000);
    expect(blockedExit).toMatchObject({ code: 1, signal: null });
    const records = blockedExit.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "server_shutdown_diagnostic",
          diagnosticId: expect.stringMatching(/^err_/u),
          classification: "server_shutdown_failure",
          elapsedMs: expect.any(Number),
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              component: "storage",
              classification: expect.stringMatching(/timeout|failure/u),
            }),
          ]),
        }),
      ]),
    );

    const restarted = await start(harness);
    const restartedSocket = await connect(restarted.origin);
    const events = await replay(restartedSocket, sessionId);
    expect(events.filter((message) => message.kind === "event" && message.eventType === "session.created"))
      .toHaveLength(1);
    await stop(restarted.process);
  }, 30_000);

  it("lets a successful deadline-based storage close exit naturally", async () => {
    const harness = await RealServerHarness.create("wi-m7-storage-close-");
    harnesses.add(harness);

    const result = await fixtureProcesses.run(
      process.execPath,
      [storageCloseFixturePath, harness.homeDirectory],
    );

    expect(result).toMatchObject({
      code: 0,
      signal: null,
      stdout: "close-returned\n",
    });
  });

  it("recovers session creation committed before catalog readiness", async () => {
    const harness = await RealServerHarness.create("wi-m7-session-create-");
    harnesses.add(harness);
    const crashedServer = await start(
      harness,
      "plain-text",
      "after_session_create_before_catalog_ready",
    );
    const socket = await connect(crashedServer.origin);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_session_create_crash",
      method: "session.create",
      params: { title: "Recovered creation" },
    });
    await expect(crashedServer.process.waitForExit()).resolves.toMatchObject({ code: 98, signal: null });

    const restarted = await start(harness);
    const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string; title: string }[];
    };
    expect(bootstrap.sessions).toEqual([
      expect.objectContaining({ title: "Recovered creation" }),
    ]);
    const retrySocket = await connect(restarted.origin);
    command(retrySocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_session_create_crash",
      method: "session.create",
      params: { title: "Recovered creation" },
    });
    await expect(
      retrySocket.take(
        (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_session_create_crash",
      ),
    ).resolves.toMatchObject({ kind: "command.accepted", duplicate: true });
    await stop(restarted.process);
  }, 30_000);

  it("restores a pending approval after force kill and resolves it exactly once", async () => {
    const harness = await RealServerHarness.create("wi-m7-approval-recovery-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "approval");
    const first = await start(harness, "approval-round-trip");
    const firstSocket = await connect(first.origin);
    await replay(firstSocket, sessionId);
    command(firstSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_approval_submit",
      sessionId,
      method: "message.submit",
      params: { text: "Wait for durable approval." },
    });
    await firstSocket.take(
      (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_approval_submit",
    );
    const approvalEvent = await firstSocket.take(
      (message) => message.kind === "event" && message.eventType === "tool.approval.requested",
    );
    if (approvalEvent.kind !== "event" || approvalEvent.eventType !== "tool.approval.requested") {
      throw new Error("Approval event was not returned");
    }
    const approvalId = approvalEvent.data.approvalId;
    await first.process.signal("SIGKILL");
    const forcedExit = await first.process.waitForExit();
    if (process.platform === "win32") {
      expect(forcedExit.signal).toBeNull();
      expect(forcedExit.code).not.toBeNull();
    } else {
      expect(forcedExit).toMatchObject({ code: null, signal: "SIGKILL" });
    }

    const pendingRestart = await start(harness, "approval-round-trip");
    const pendingSocket = await connect(pendingRestart.origin);
    const restored = await replay(pendingSocket, sessionId);
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "tool.approval.requested" }),
      ]),
    );
    await stop(pendingRestart.process);

    const resolutionCrash = await start(
      harness,
      "approval-round-trip",
      "after_command_commit_before_ack",
    );
    const resolutionSocket = await connect(resolutionCrash.origin);
    await replay(resolutionSocket, sessionId);
    command(resolutionSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_approval_resolve",
      sessionId,
      method: "approval.resolve",
      params: { approvalId, resolution: "approved" },
    });
    await expect(resolutionCrash.process.waitForExit()).resolves.toMatchObject({
      code: 91,
      signal: null,
    });

    const resolvedRestart = await start(harness, "approval-round-trip");
    const resolvedSocket = await connect(resolvedRestart.origin);
    const resolvedReplay = await replay(resolvedSocket, sessionId);
    command(resolvedSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_approval_resolve",
      sessionId,
      method: "approval.resolve",
      params: { approvalId, resolution: "approved" },
    });
    await expect(
      resolvedSocket.take(
        (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_approval_resolve",
      ),
    ).resolves.toMatchObject({ duplicate: true });
    if (!resolvedReplay.some((message) => message.kind === "event" && message.eventType === "run.completed")) {
      await resolvedSocket.take(
        (message) => message.kind === "event" && message.eventType === "run.completed",
      );
    }
    await stop(resolvedRestart.process);

    const finalRestart = await start(harness, "approval-round-trip");
    const finalSocket = await connect(finalRestart.origin);
    const finalEvents = await replay(finalSocket, sessionId);
    expect(
      finalEvents.filter(
        (message) => message.kind === "event" && message.eventType === "run.completed",
      ),
    ).toHaveLength(1);
    expect(
      finalEvents.filter(
        (message) => message.kind === "event" && message.eventType === "tool.execution.completed",
      ),
    ).toHaveLength(1);
    await stop(finalRestart.process);
  }, 30_000);

  it("restores a pending input across repeated process restarts and resolves it once", async () => {
    const harness = await RealServerHarness.create("wi-m7-input-recovery-");
    harnesses.add(harness);
    const { sessionId, inputId } = await seedPendingInput(harness.homeDirectory);

    const first = await start(harness);
    const firstSocket = await connect(first.origin);
    const firstReplay = await replay(firstSocket, sessionId);
    expect(firstReplay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "input.requested" }),
      ]),
    );
    await first.process.signal("SIGKILL");
    await first.process.waitForExit();

    const second = await start(harness);
    const secondSocket = await connect(second.origin);
    const secondReplay = await replay(secondSocket, sessionId);
    expect(secondReplay.filter((message) => message.kind === "event" && message.eventType === "input.requested"))
      .toHaveLength(1);
    await stop(second.process);

    const third = await start(harness);
    const thirdSocket = await connect(third.origin);
    await replay(thirdSocket, sessionId);
    command(thirdSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_input_resolve",
      sessionId,
      method: "input.respond",
      params: { inputId, value: { continue: true } },
    });
    await thirdSocket.take(
      (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_input_resolve",
    );
    await thirdSocket.take(
      (message) => message.kind === "event" && message.eventType === "run.completed",
    );
    await stop(third.process);

    const final = await start(harness);
    const finalSocket = await connect(final.origin);
    const finalEvents = await replay(finalSocket, sessionId);
    expect(finalEvents.filter((message) => message.kind === "event" && message.eventType === "input.resolved"))
      .toHaveLength(1);
    expect(finalEvents.filter((message) => message.kind === "event" && message.eventType === "run.completed"))
      .toHaveLength(1);
    command(finalSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_input_resolve",
      sessionId,
      method: "input.respond",
      params: { inputId, value: { continue: true } },
    });
    await expect(
      finalSocket.take(
        (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_input_resolve",
      ),
    ).resolves.toMatchObject({ duplicate: true });
    await stop(final.process);
  }, 30_000);

  it("reconstructs sessions and create-command idempotency after total catalog loss", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-delete-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "catalogA", "project_m7missing");
    const secondId = await seedSession(harness.homeDirectory, "catalogB");
    const hyphenId = await seedSession(
      harness.homeDirectory,
      "hyphen",
      undefined,
      "ses_a-review",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 3,
      repaired: 3,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions.map((session) => session.sessionId).sort()).toEqual(
      [firstId, secondId, hyphenId].sort(),
    );

    const retrySocket = await connect(repaired.origin);
    command(retrySocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7catalogAcreate",
      method: "session.create",
      params: { title: "Milestone 7 catalogA", projectId: "project_m7missing" },
    });
    await expect(
      retrySocket.take(
        (message) =>
          message.kind === "command.accepted" &&
          message.commandId === "cmd_m7catalogAcreate",
      ),
    ).resolves.toMatchObject({ duplicate: true, result: { sessionId: firstId } });
    command(retrySocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7catalogAcreate",
      method: "session.create",
      params: { title: "Conflicting reconstructed retry", projectId: "project_m7missing" },
    });
    await expect(
      retrySocket.take(
        (message) =>
          message.kind === "command.rejected" &&
          message.commandId === "cmd_m7catalogAcreate",
      ),
    ).resolves.toMatchObject({ code: "protocol.command_id_conflict" });
    await stop(repaired.process);

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await storage.ready();
      await expect(storage.catalog.getSession(firstId)).resolves.toMatchObject({
        projectId: "project_m7missing",
      });
      expect(storage.catalogRepairStatus()).toMatchObject({ triggered: false, reason: "none" });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("reconstructs valid large-title sessions across bounded discovery pages", async () => {
    const harness = await RealServerHarness.create("wi-m7-paged-discovery-");
    harnesses.add(harness);
    const sessionIds = Array.from({ length: 12 }, (_, index) => `ses_m7Paged${index}`);
    const eventIds = Array.from({ length: 12 }, (_, index) => `evt_m7Paged${index}`);
    const pendingSessionIds = [...sessionIds];
    const pendingEventIds = [...eventIds];
    const takeId = (values: string[], description: string): string => {
      const value = values.shift();
      if (value === undefined) throw new Error(`Missing ${description}`);
      return value;
    };
    const title = `Paged discovery ${"x".repeat(175_000)}`;
    const storage = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      ids: {
        sessionId: () => takeId(pendingSessionIds, "session ID"),
        eventId: () => takeId(pendingEventIds, "event ID"),
      },
      now: () => 1_000,
    });
    try {
      for (let index = 0; index < sessionIds.length; index += 1) {
        await storage.createSession({
          v: 1,
          kind: "command",
          commandId: `cmd_m7Paged${index}`,
          method: "session.create",
          params: { title },
        });
      }
    } finally {
      await storage.close();
    }
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: sessionIds.length,
      repaired: sessionIds.length,
      quarantined: 0,
    });
    await stop(repaired.process);

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      for (const sessionId of sessionIds) {
        await expect(inspected.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status: "ready",
          title,
        });
      }
    } finally {
      await inspected.close();
    }
  }, 40_000);

  it("repairs every stale field on an existing valid catalog row", async () => {
    const harness = await RealServerHarness.create("wi-m7-explicit-stale-row-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "explicitStale",
      "project_m7ExplicitStale",
    );
    await makeCatalogSessionStale(harness.homeDirectory, sessionId);

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 1,
      repaired: 1,
      quarantined: 0,
    });
    await stop(repaired.process);

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await storage.ready();
      await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
        sessionId,
        projectId: "project_m7ExplicitStale",
        dbRelativePath: sessionDatabaseRelativePath(sessionId),
        title: "Milestone 7 explicitStale",
        status: "ready",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        lastEventSequence: 1,
        lastRunState: null,
        lastMessagePreview: null,
        requiresAttention: false,
        pendingApprovalCount: 0,
        pendingInputCount: 0,
        sessionSchemaVersion: 4,
      });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("reconstructs valid large data with exact canonical summary parity", async () => {
    const harness = await RealServerHarness.create("wi-m7-large-summary-parity-");
    harnesses.add(harness);
    const title = "T".repeat(2_000);
    const message = "M".repeat(2_000);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "largeParity",
      undefined,
      "ses_m7LargeParity",
      title,
    );
    const original = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    let before: Awaited<ReturnType<typeof original.catalog.getSession>> = null;
    try {
      const session = await original.openSession(sessionId);
      await session.appendTransaction({
        events: [
          {
            eventId: "evt_m7LargeParityMessage",
            eventType: "user.message.appended",
            createdAtMs: 5_000,
            data: {
              eventVersion: 1,
              messageId: "msg_m7LargeParity",
              runId: "run_m7LargeParityZ",
              text: message,
            },
          },
          {
            eventId: "evt_m7LargeParityRunZ",
            eventType: "run.created",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityZ" },
          },
          {
            eventId: "evt_m7LargeParityRunZCompleted",
            eventType: "run.completed",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityZ" },
          },
          {
            eventId: "evt_m7LargeParityRunA",
            eventType: "run.created",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityA" },
          },
          {
            eventId: "evt_m7LargeParityRunACancelled",
            eventType: "run.cancelled",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityA" },
          },
        ],
        projections: [
          {
            kind: "run.put",
            runId: "run_m7LargeParityZ",
            state: "completed",
            providerId: "fake",
            providerConfig: { scenario: "plain-text" },
            createdAtMs: 6_000,
            startedAtMs: 6_000,
            completedAtMs: 6_000,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          },
          {
            kind: "run.put",
            runId: "run_m7LargeParityA",
            state: "cancelled",
            providerId: "fake",
            providerConfig: { scenario: "plain-text" },
            createdAtMs: 6_000,
            startedAtMs: 6_000,
            completedAtMs: null,
            cancelledAtMs: 6_000,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          },
        ],
      });
      await original.drainCatalogObservations();
      before = await original.catalog.getSession(sessionId);
    } finally {
      await original.close();
    }
    if (before === null) throw new Error("Canonical catalog summary is missing");
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 1,
      repaired: 1,
    });
    await stop(repaired.process);

    const reconstructed = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await reconstructed.ready();
      const after = await reconstructed.catalog.getSession(sessionId);
      expect(after).toMatchObject({
        title,
        updatedAtMs: 6_000,
        lastEventSequence: 6,
        lastRunState: "cancelled",
        lastMessagePreview: message.slice(0, 200),
      });
      expect(after).toEqual(before);
    } finally {
      await reconstructed.close();
    }
  }, 30_000);

  it("preserves an unsupported newer session schema without blocking catalog reconstruction", async () => {
    const harness = await RealServerHarness.create("wi-m7-unsupported-schema-");
    harnesses.add(harness);
    const unsupportedId = await seedSession(harness.homeDirectory, "unsupportedSchema");
    const healthyId = await seedSession(harness.homeDirectory, "unsupportedHealthy");
    await mutateCreationProvenance(
      harness.homeDirectory,
      unsupportedId,
      "user-version",
      "999",
    );
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 2,
      repaired: 1,
      quarantined: 0,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: unsupportedId, status: "unavailable" }),
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
      ]),
    );
    const unsupportedDatabase = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(unsupportedId),
    );
    expect((await stat(unsupportedDatabase)).isFile()).toBe(true);
    await stop(repaired.process);
    await expect(readSessionUserVersion(harness.homeDirectory, unsupportedId)).resolves.toBe(999);

    const restarted = await start(harness);
    expect(restarted.ready.repair).toMatchObject({ triggered: false, reason: "none" });
    await stop(restarted.process);
  }, 30_000);

  it("repairs 10,000 maximum-length catalog IDs through bounded complement pages", async () => {
    const harness = await RealServerHarness.create("wi-m7-maximum-complement-");
    harnesses.add(harness);
    const initial = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await initial.ready();
    } finally {
      await initial.close();
    }
    await seedMaximumCatalog(harness.homeDirectory, 10_000);

    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "force",
      sessionDiscoveryLimit: 10_000,
    });
    try {
      await repairing.ready();
      expect(repairing.catalogRepairStatus()).toMatchObject({
        triggered: true,
        reason: "explicit",
        discovered: 0,
      });
      await expect(repairing.catalog.countSessions()).resolves.toBe(10_000);
      for (const index of [0, 9_999]) {
        const sessionId = maximumLengthSessionId(index);
        expect(sessionId).toHaveLength(124);
        await expect(repairing.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status: "missing",
          dbRelativePath: sessionDatabaseRelativePath(sessionId),
        });
      }
    } finally {
      await repairing.close();
    }
  }, 30_000);

  it("changes deleted preserved sessions to missing but retains quarantined unavailable state", async () => {
    const harness = await RealServerHarness.create("wi-m7-preserved-to-missing-");
    harnesses.add(harness);
    const unsupportedId = await seedSession(harness.homeDirectory, "deletedUnsupported");
    const oversizedId = await seedSession(harness.homeDirectory, "deletedOversized");
    const quarantinedId = await seedSession(harness.homeDirectory, "retainedQuarantine");
    await mutateCreationProvenance(
      harness.homeDirectory,
      unsupportedId,
      "user-version",
      "999",
    );
    await truncate(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(oversizedId)),
      256 * 1024 * 1024 + 1,
    );
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(quarantinedId)),
      "not a sqlite database",
    );

    const classified = await start(harness, "plain-text", undefined, "force");
    const classifiedBootstrap = await fetch(`${classified.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(classified.ready.repair).toMatchObject({ quarantined: 1 });
    expect(classifiedBootstrap.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: unsupportedId, status: "unavailable" }),
      expect.objectContaining({ sessionId: oversizedId, status: "unavailable" }),
      expect.objectContaining({ sessionId: quarantinedId, status: "unavailable" }),
    ]));
    await stop(classified.process);

    for (const sessionId of [unsupportedId, oversizedId]) {
      const directory = resolveStoragePath(
        harness.homeDirectory,
        sessionDatabaseRelativePath(sessionId).slice(0, -"/session.sqlite3".length),
      );
      await rm(directory, { recursive: true, force: true });
    }

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 0,
    });
    await stop(repaired.process);

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      for (const sessionId of [unsupportedId, oversizedId]) {
        await expect(inspected.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status: "missing",
          dbRelativePath: sessionDatabaseRelativePath(sessionId),
        });
      }
      await expect(inspected.catalog.getSession(quarantinedId)).resolves.toMatchObject({
        sessionId: quarantinedId,
        status: "unavailable",
        dbRelativePath: sessionDatabaseRelativePath(quarantinedId),
      });
    } finally {
      await inspected.close();
    }
  }, 40_000);

  it("repairs canonical paths for every discovery classification", async () => {
    const harness = await RealServerHarness.create("wi-m7-classification-paths-");
    harnesses.add(harness);
    const corruptId = await seedSession(harness.homeDirectory, "pathCorrupt");
    const unsupportedId = await seedSession(harness.homeDirectory, "pathUnsupported");
    const missingId = await seedSession(harness.homeDirectory, "pathMissing");
    const healthyId = await seedSession(harness.homeDirectory, "pathHealthy");
    for (const sessionId of [corruptId, unsupportedId, missingId, healthyId]) {
      await mutateCatalogSession(
        harness.homeDirectory,
        sessionId,
        "catalog-session-path",
      );
    }
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(corruptId)),
      "not a sqlite database",
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      unsupportedId,
      "user-version",
      "999",
    );
    await rm(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(missingId)),
      { force: true },
    );

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 4,
      repaired: 1,
      quarantined: 1,
    });
    await stop(repaired.process);

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      for (const [sessionId, status] of [
        [corruptId, "unavailable"],
        [unsupportedId, "unavailable"],
        [missingId, "missing"],
        [healthyId, "ready"],
      ] as const) {
        await expect(inspected.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status,
          dbRelativePath: sessionDatabaseRelativePath(sessionId),
        });
      }
    } finally {
      await inspected.close();
    }
  }, 30_000);

  it("quarantines semantically invalid creation provenance without blocking a healthy session", async () => {
    const harness = await RealServerHarness.create("wi-m7-provenance-validation-");
    harnesses.add(harness);
    const healthyId = await seedSession(harness.homeDirectory, "provenanceHealthy");
    const resultId = await seedSession(harness.homeDirectory, "provenanceResult");
    const hashId = await seedSession(harness.homeDirectory, "provenanceHash");
    const eventId = await seedSession(harness.homeDirectory, "provenanceEvent");
    const timestampId = await seedSession(harness.homeDirectory, "provenanceTimestamp");

    await mutateCreationProvenance(
      harness.homeDirectory,
      resultId,
      "result-session",
      healthyId,
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      hashId,
      "payload-hash",
      "0".repeat(64),
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      eventId,
      "event-id",
      "evt_m7WrongCreationProvenance",
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      timestampId,
      "accepted-at",
      "1001",
    );
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 5,
      repaired: 1,
      quarantined: 4,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
        ...[resultId, hashId, eventId, timestampId].map((sessionId) =>
          expect.objectContaining({ sessionId, status: "unavailable" }),
        ),
      ]),
    );
    await stop(repaired.process);
  }, 30_000);

  it("isolates every conflicting provenance claimant and repairs an independent session", async () => {
    const harness = await RealServerHarness.create("wi-m7-provenance-conflict-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "conflictA");
    const secondId = await seedSession(harness.homeDirectory, "conflictB");
    const healthyId = await seedSession(harness.homeDirectory, "conflictHealthy");
    await mutateCreationProvenance(
      harness.homeDirectory,
      secondId,
      "command-id",
      "cmd_m7conflictAcreate",
    );
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 3,
      repaired: 1,
      quarantined: 2,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: firstId, status: "unavailable" }),
        expect.objectContaining({ sessionId: secondId, status: "unavailable" }),
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
      ]),
    );
    await stop(repaired.process);
  }, 30_000);

  it("marks a catalog-known missing database without overwriting metadata or renaming its directory", async () => {
    const harness = await RealServerHarness.create("wi-m7-explicit-missing-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "explicitMissing",
      "project_m7ExplicitMissing",
    );
    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    let before: Awaited<ReturnType<typeof storage.catalog.getSession>> = null;
    try {
      await storage.ready();
      before = await storage.catalog.getSession(sessionId);
    } finally {
      await storage.close();
    }
    if (before === null) throw new Error("Seeded catalog session is missing");
    const databasePath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const sessionDirectory = databasePath.slice(0, -"/session.sqlite3".length);
    await rm(databasePath, { force: true });

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 1,
      repaired: 0,
      quarantined: 0,
    });
    await stop(repaired.process);
    expect((await stat(sessionDirectory)).isDirectory()).toBe(true);
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      const after = await inspected.catalog.getSession(sessionId);
      expect(after).toEqual({ ...before, status: "missing" });
    } finally {
      await inspected.close();
    }
  }, 30_000);

  it("marks a catalog-known session missing when its entire directory is absent", async () => {
    const harness = await RealServerHarness.create("wi-m7-explicit-missing-directory-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "explicitMissingDirectory",
      "project_m7ExplicitMissingDirectory",
    );
    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    let before: Awaited<ReturnType<typeof storage.catalog.getSession>> = null;
    try {
      await storage.ready();
      before = await storage.catalog.getSession(sessionId);
    } finally {
      await storage.close();
    }
    if (before === null) throw new Error("Seeded catalog session is missing");
    const databasePath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const sessionDirectory = databasePath.slice(0, -"/session.sqlite3".length);
    await rm(sessionDirectory, { recursive: true, force: true });

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 0,
      repaired: 0,
      quarantined: 0,
    });
    await stop(repaired.process);
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      const after = await inspected.catalog.getSession(sessionId);
      expect(after).toEqual({ ...before, status: "missing" });
    } finally {
      await inspected.close();
    }
  }, 30_000);

  it("isolates provenance conflicting with an existing catalog command during explicit repair", async () => {
    const harness = await RealServerHarness.create("wi-m7-existing-provenance-conflict-");
    harnesses.add(harness);
    const sharedTitle = "Existing catalog provenance owner";
    const ownerId = await seedSession(
      harness.homeDirectory,
      "existingOwner",
      undefined,
      "ses_m7ExistingOwner",
      sharedTitle,
    );
    const claimantId = await seedSession(
      harness.homeDirectory,
      "existingClaimant",
      undefined,
      "ses_m7ExistingClaimant",
      sharedTitle,
    );
    const healthyId = await seedSession(harness.homeDirectory, "existingHealthy");
    await mutateCreationProvenance(
      harness.homeDirectory,
      claimantId,
      "command-id",
      "cmd_m7existingOwnercreate",
    );
    await rm(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(ownerId)),
      { force: true },
    );

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 3,
      repaired: 1,
      quarantined: 1,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: claimantId, status: "unavailable" }),
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
      ]),
    );
    const socket = await connect(repaired.origin);
    const healthyEvents = await replay(socket, healthyId);
    expect(
      healthyEvents.filter(
        (message) => message.kind === "event" && message.eventType === "session.created",
      ),
    ).toHaveLength(1);
    await stop(repaired.process);

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await storage.ready();
      await expect(storage.catalog.getSession(ownerId)).resolves.toMatchObject({
        sessionId: ownerId,
        status: "missing",
        title: sharedTitle,
      });
      await expect(
        storage.catalog.getGlobalCommand("cmd_m7existingOwnercreate"),
      ).resolves.toMatchObject({
        state: "accepted",
        reservedSessionId: ownerId,
      });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("continues a durably marked partial catalog repair after a process crash", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-partial-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "partialA");
    const secondId = await seedSession(harness.homeDirectory, "partialB");
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const crashed = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_catalog_session_repair",
      },
      waitForReady: false,
    });
    await expect(crashed.waitForExit()).resolves.toMatchObject({ code: 99, signal: null });

    const restarted = await start(harness);
    expect(restarted.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 2,
      repaired: 2,
    });
    const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    await stop(restarted.process);
  }, 30_000);

  it("continues an in-place explicit repair without losing command idempotency", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-explicit-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "explicitA");
    const secondId = await seedSession(harness.homeDirectory, "explicitB");
    const crashed = await harness.start({
      fixturePath,
      arguments: ["plain-text", "force"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_catalog_session_repair",
      },
      waitForReady: false,
    });
    await expect(crashed.waitForExit()).resolves.toMatchObject({ code: 99, signal: null });

    const restarted = await start(harness);
    expect(restarted.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 2,
      repaired: 2,
    });
    const socket = await connect(restarted.origin);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7explicitAcreate",
      method: "session.create",
      params: { title: "Milestone 7 explicitA" },
    });
    await expect(
      socket.take(
        (message) =>
          message.kind === "command.accepted" &&
          message.commandId === "cmd_m7explicitAcreate",
      ),
    ).resolves.toMatchObject({ duplicate: true, result: { sessionId: firstId } });
    const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string }[] };
    expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    await stop(restarted.process);
  }, 30_000);

  it.each([
    ["missing", false, "catalog_new"],
    ["corrupt", true, "catalog_corrupt"],
  ] as const)(
    "recovers a %s catalog after repeated pre-repair crashes",
    async (_label, corruptCatalog, expectedReason) => {
      const harness = await RealServerHarness.create("wi-m7-catalog-pre-marker-");
      harnesses.add(harness);
      const firstId = await seedSession(harness.homeDirectory, "premarkerA");
      const secondId = await seedSession(harness.homeDirectory, "premarkerB");
      for (const suffix of ["-wal", "-shm"]) {
        await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
      }
      if (corruptCatalog) {
        await writeFile(join(harness.homeDirectory, "catalog.sqlite3"), "not a sqlite database");
      } else {
        await rm(join(harness.homeDirectory, "catalog.sqlite3"), { force: true });
      }

      for (let crash = 0; crash < 2; crash += 1) {
        const processHandle = await harness.start({
          fixturePath,
          arguments: ["plain-text", "auto"],
          environment: {
            NODE_ENV: "test",
            WI_ALLOW_TEST_FAILPOINTS: "1",
            WI_TEST_FAILPOINT: "after_catalog_replacement_before_repair",
          },
          waitForReady: false,
        });
        await expect(processHandle.waitForExit()).resolves.toMatchObject({
          code: 100,
          signal: null,
        });
      }

      const restarted = await start(harness);
      expect(restarted.ready.repair).toMatchObject({
        triggered: true,
        reason: expectedReason,
        discovered: 2,
        repaired: 2,
      });
      const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then(
        (response) => response.json(),
      ) as { sessions: readonly { sessionId: string }[] };
      expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
        [firstId, secondId].sort(),
      );
      await stop(restarted.process);
    },
    40_000,
  );

  it("quarantines a corrupt catalog and reconstructs its surviving sessions", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-corrupt-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "catalogcorrupt");
    await writeFile(join(harness.homeDirectory, "catalog.sqlite3"), "not a sqlite database");
    const server = await start(harness);
    expect(server.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_corrupt",
      discovered: 1,
      repaired: 1,
    });
    const bootstrap = await fetch(`${server.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions).toEqual([expect.objectContaining({ sessionId })]);
    await stop(server.process);
  }, 20_000);

  it("keeps healthy-catalog startup catalog-only", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-healthy-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "healthyA");
    const secondId = await seedSession(harness.homeDirectory, "healthyB");
    for (const sessionId of [firstId, secondId]) {
      const databasePath = resolveStoragePath(
        harness.homeDirectory,
        sessionDatabaseRelativePath(sessionId),
      );
      await rename(databasePath, `${databasePath}.offline`);
    }
    const server = await start(harness);
    expect(server.ready.repair).toMatchObject({ triggered: false, reason: "none" });
    const bootstrap = await fetch(`${server.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    await stop(server.process);
  }, 20_000);

  it("rebuilds a deleted catalog and quarantines one corrupt discovered database", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-repair-");
    harnesses.add(harness);
    const healthyId = await seedSession(harness.homeDirectory, "healthy");
    const corruptId = await seedSession(harness.homeDirectory, "corrupt");
    const mismatchId = await seedSession(harness.homeDirectory, "mismatch");
    const healthyDatabase = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(healthyId),
    );
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(corruptId)),
      "not a sqlite database",
    );
    await copyFile(
      healthyDatabase,
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(mismatchId)),
    );
    const wrongPrefixDirectory = join(
      harness.homeDirectory,
      "sessions",
      "zz",
      healthyId,
    );
    await mkdir(wrongPrefixDirectory, { recursive: true });
    await copyFile(healthyDatabase, join(wrongPrefixDirectory, "session.sqlite3"));
    const symlinkId = "ses_symlinkProbe";
    const symlinkPath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(symlinkId).slice(0, -"/session.sqlite3".length),
    );
    const externalDirectory = join(harness.homeDirectory, "external-session");
    await mkdir(externalDirectory, { recursive: true });
    await mkdir(join(symlinkPath, ".."), { recursive: true });
    await symlink(
      externalDirectory,
      symlinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const repaired = await start(harness);
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string; status: string }[];
    };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
        expect.objectContaining({ sessionId: corruptId, status: "unavailable" }),
        expect.objectContaining({ sessionId: mismatchId, status: "unavailable" }),
      ]),
    );
    expect(bootstrap.sessions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: symlinkId })]),
    );
    const corruptDirectory = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(corruptId).slice(0, -"/session.sqlite3".length),
    );
    await expect(stat(corruptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const mismatchDirectory = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(mismatchId).slice(0, -"/session.sqlite3".length),
    );
    await expect(stat(mismatchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(wrongPrefixDirectory)).resolves.toBeDefined();
    await expect(lstat(symlinkPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    await stop(repaired.process);
  }, 30_000);
});
