import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { hashCommandContent, type SessionCreateCommand } from "@wi/protocol";
import {
  resolveStoragePath,
  SessionStoreManager,
  SESSION_SCHEMA_VERSION,
  StorageError,
  stableSessionWorkerIndex,
  type AcceptCommandInput,
  type AppendTransactionInput,
  type CatalogObservationFailure,
  type ProjectionMutation,
  type SessionStoreManagerOptions,
} from "@wi/storage";
import { sessionWorkerPoolForTest } from "../../packages/storage/dist/testing.js";

type StorageTestManager = SessionStoreManager & {
  readonly sessions: ReturnType<typeof sessionWorkerPoolForTest>;
};

const homes: string[] = [];
const managers: SessionStoreManager[] = [];
const originalFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;

beforeAll(() => {
  process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
});

afterAll(() => {
  if (originalFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
  else process.env.WI_ALLOW_TEST_FAILPOINTS = originalFailpointGate;
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "wi-storage-"));
  homes.push(home);
  return home;
}

function sequenceGenerator(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Deterministic ID sequence exhausted");
    index += 1;
    return value;
  };
}

async function manager(
  options: Partial<SessionStoreManagerOptions> = {},
  sessionIds: readonly string[] = ["ses_storageA"],
): Promise<StorageTestManager> {
  const homeDirectory = options.homeDirectory ?? (await temporaryHome());
  let eventNumber = 1;
  const core = new SessionStoreManager({
    homeDirectory,
    now: options.now ?? (() => 1_000),
    ids: options.ids ?? {
      sessionId: sequenceGenerator(sessionIds),
      eventId: () => `evt_storage${eventNumber++}`,
    },
    sessionWorkers: {
      size: 2,
      maxOpenHandlesPerWorker: 2,
      allowTestOperations: true,
      ...options.sessionWorkers,
    },
    ...(options.catalogProjectionWriter === undefined
      ? {}
      : { catalogProjectionWriter: options.catalogProjectionWriter }),
    ...(options.onCatalogObservationError === undefined
      ? {}
      : { onCatalogObservationError: options.onCatalogObservationError }),
    ...(options.catalogObservationShutdownTimeoutMs === undefined
      ? {}
      : {
          catalogObservationShutdownTimeoutMs:
            options.catalogObservationShutdownTimeoutMs,
        }),
    ...(options.sessionDiscoveryLimit === undefined
      ? {}
      : { sessionDiscoveryLimit: options.sessionDiscoveryLimit }),
    ...(options.catalogRepair === undefined ? {} : { catalogRepair: options.catalogRepair }),
    ...(options.testFailpoints === undefined ? {} : { testFailpoints: options.testFailpoints }),
  });
  const storage = new Proxy(core, {
    get(target, property) {
      if (property === "sessions") return sessionWorkerPoolForTest(target);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StorageTestManager;
  managers.push(storage);
  return storage;
}

function createCommand(
  commandId = "cmd_createA",
  title = "Storage test",
  projectId?: string,
): SessionCreateCommand {
  return {
    v: 1,
    kind: "command",
    commandId,
    method: "session.create",
    params: { title, ...(projectId === undefined ? {} : { projectId }) },
  };
}

function runAppend(
  eventId = "evt_runCreated",
  runId = "run_storageA",
): AppendTransactionInput {
  return {
    events: [
      {
        eventId,
        eventType: "run.created",
        createdAtMs: 1_010,
        data: { eventVersion: 1, runId },
      },
    ],
    projections: [
      {
        kind: "run.put",
        runId,
        state: "created",
        providerId: "fake",
        providerConfig: { scenario: "plain-text" },
        createdAtMs: 1_010,
        startedAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: null,
      },
    ],
  };
}

function acceptRun(suffix: string): AcceptCommandInput {
  const runId = `run_${suffix}`;
  return {
    commandId: `cmd_${suffix}`,
    commandMethod: "message.submit",
    payloadHash: suffix.padEnd(64, "0").slice(0, 64),
    result: { runId },
    acceptedAtMs: 1_010,
    runId,
    transaction: runAppend(`evt_${suffix}`, runId),
  };
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((storage) => storage.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("catalog and per-session storage workers", () => {
  it("creates a generated catalog-relative session database with a matching manifest", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    await storage.createProject({
      projectId: "project_storageA",
      name: "Storage project",
      rootPath: "/tmp/storage-project",
      rootRealpath: "/tmp/storage-project",
      createdAtMs: 900,
      updatedAtMs: 900,
      config: {},
    });
    const created = await storage.createSession(
      createCommand("cmd_createA", "Storage test", "project_storageA"),
    );

    expect(created.duplicate).toBe(false);
    expect(created.session.dbRelativePath).toBe(
      "sessions/st/ses_storageA/session.sqlite3",
    );
    expect(created.events.map((event) => event.eventType)).toEqual(["session.created"]);

    const session = await storage.openSession(created.session.sessionId);
    const manifest = await session.getManifest();
    expect(manifest).toMatchObject({
      sessionId: created.session.sessionId,
      projectId: "project_storageA",
      title: "Storage test",
      lastEventSequence: 1,
      schemaVersion: SESSION_SCHEMA_VERSION,
      formatVersion: 1,
    });
    await expect(
      readFile(join(homeDirectory, created.session.dbRelativePath)),
    ).resolves.toBeInstanceOf(Buffer);
    expect(
      (await stat(join(homeDirectory, created.session.dbRelativePath, "..", "artifacts"))).isDirectory(),
    ).toBe(true);
    expect((await storage.catalog.listSessions()).map((item) => item.sessionId)).toEqual([
      created.session.sessionId,
    ]);
  });

  it("enforces the configured recoverable session count while preserving duplicates", async () => {
    const storage = await manager(
      { sessionDiscoveryLimit: 1 },
      ["ses_capacityA", "ses_capacityDuplicate", "ses_capacityB"],
    );
    const firstCommand = createCommand("cmd_capacityA", "Capacity A");
    const first = await storage.createSession(firstCommand);
    await expect(storage.createSession(firstCommand)).resolves.toMatchObject({
      duplicate: true,
      session: { sessionId: first.session.sessionId },
    });
    await expect(
      storage.createSession(createCommand("cmd_capacityB", "Capacity B")),
    ).rejects.toMatchObject({ code: "storage.resource_limit" });
    await expect(storage.catalog.countSessions()).resolves.toBe(1);
  });

  it("rejects unsupported catalog session lifecycle status", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());

    await expect(
      storage.catalog.createSessionIndex({ ...created.session, status: "invalid" } as never),
    ).rejects.toMatchObject({ code: "storage.worker_failed" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("rejects a database whose manifest does not match the requested session", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    const created = await storage.createSession(createCommand());
    const wrongSession = storage.sessions.registerSession(
      "ses_wrongManifest",
      resolveStoragePath(homeDirectory, created.session.dbRelativePath),
    );

    await expect(wrongSession.getManifest()).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    await expect((await storage.openSession(created.session.sessionId)).getHeadSequence()).resolves.toBe(1);
  });

  it("detects deletion of a cached session database before another operation", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    const created = await storage.createSession(createCommand());
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    await rm(databasePath, { force: true });

    await expect(
      (await storage.openSession(created.session.sessionId)).getHeadSequence(),
    ).rejects.toMatchObject({ code: "storage.session_missing" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "missing",
    });
  });

  it("detects replacement of a cached session database before another operation", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    const created = await storage.createSession(createCommand());
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    const replacementPath = `${databasePath}.replacement`;
    await writeFile(replacementPath, "replacement database");
    await rename(replacementPath, databasePath);

    await expect(
      (await storage.openSession(created.session.sessionId)).getHeadSequence(),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("makes unavailable and missing catalog status authoritative for every normal session API", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager(
      { homeDirectory },
      ["ses_statusUnavailable", "ses_statusMissing", "ses_statusHealthy"],
    );
    const unavailable = await storage.createSession(
      createCommand("cmd_createStatusUnavailable", "Unavailable status"),
    );
    const missing = await storage.createSession(
      createCommand("cmd_createStatusMissing", "Missing status"),
    );
    const healthy = await storage.createSession(
      createCommand("cmd_createStatusHealthy", "Healthy status"),
    );
    const unavailableClient = await storage.openSession(unavailable.session.sessionId);
    const missingClient = await storage.openSession(missing.session.sessionId);
    const before = new Map<string, { head: number; device: number; inode: number }>();
    for (const created of [unavailable, missing]) {
      const identity = await stat(resolveStoragePath(homeDirectory, created.session.dbRelativePath));
      before.set(created.session.sessionId, {
        head: await storage.sessions.getHeadSequence(created.session.sessionId),
        device: identity.dev,
        inode: identity.ino,
      });
    }
    await storage.catalog.markSessionStatus({
      sessionId: unavailable.session.sessionId,
      status: "unavailable",
    });
    await storage.catalog.markSessionStatus({
      sessionId: missing.session.sessionId,
      status: "missing",
    });

    for (const [created, client, expectedStatus] of [
      [unavailable, unavailableClient, "unavailable"],
      [missing, missingClient, "missing"],
    ] as const) {
      const expectedCode = expectedStatus === "missing" ? "storage.session_missing" : "storage.corrupt";
      await expect(storage.openSession(created.session.sessionId)).rejects.toMatchObject({
        code: expectedCode,
      });
      await expect(client.getManifest()).rejects.toMatchObject({ code: expectedCode });
      await expect(client.acceptCommand(acceptRun(`${expectedStatus}Client`))).rejects.toMatchObject({
        code: expectedCode,
      });
      await expect(
        storage.acceptCommand(created.session.sessionId, acceptRun(`${expectedStatus}Manager`)),
      ).rejects.toMatchObject({ code: expectedCode });
      await expect(
        client.appendTransaction(runAppend(`evt_${expectedStatus}ClientAppend`, `run_${expectedStatus}ClientAppend`)),
      ).rejects.toMatchObject({ code: expectedCode });
      await expect(
        storage.appendTransaction(
          created.session.sessionId,
          runAppend(`evt_${expectedStatus}ManagerAppend`, `run_${expectedStatus}ManagerAppend`),
        ),
      ).rejects.toMatchObject({ code: expectedCode });
      await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
        status: expectedStatus,
      });
      const identity = await stat(resolveStoragePath(homeDirectory, created.session.dbRelativePath));
      expect({
        head: await storage.sessions.getHeadSequence(created.session.sessionId),
        device: identity.dev,
        inode: identity.ino,
      }).toEqual(before.get(created.session.sessionId));
      await storage.sessions.closeSession(created.session.sessionId);
    }

    const openSessionIds = (await storage.sessions.getStats()).flatMap(
      (worker) => worker.openSessionIds,
    );
    expect(openSessionIds).not.toContain(unavailable.session.sessionId);
    expect(openSessionIds).not.toContain(missing.session.sessionId);
    await expect(
      storage.appendTransaction(
        healthy.session.sessionId,
        runAppend("evt_statusHealthyAppend", "run_statusHealthyAppend"),
      ),
    ).resolves.toMatchObject({ headSequence: 2 });

    await storage.close();
    managers.splice(managers.indexOf(storage), 1);
    const repaired = await manager(
      { homeDirectory, catalogRepair: "force" },
      ["ses_unusedStatusRepair"],
    );
    await repaired.ready();
    for (const created of [unavailable, missing]) {
      await expect(repaired.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
        status: "ready",
      });
      await expect(repaired.openSession(created.session.sessionId)).resolves.toBeDefined();
    }
  });

  it("never lets generic reconciliation promote an unavailable session", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const inspection = await storage.reconciler.inspectSession(created.session.sessionId);
    await storage.catalog.markSessionStatus({
      sessionId: created.session.sessionId,
      status: "unavailable",
    });

    await expect(
      storage.catalog.reconcileSession({
        ...inspection,
        expectedCatalogStatus: "unavailable",
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      storage.catalog.createSessionIndex({ ...created.session, status: "ready" }),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("does not expose hookless session-worker access through the normal package API", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const client = await storage.openSession(created.session.sessionId);
    const storagePackage = await import("@wi/storage");

    expect(Object.hasOwn(storage, "sessions")).toBe(false);
    expect(Object.hasOwn(storage.reconciler, "sessions")).toBe(false);
    expect(Object.hasOwn(client, "pool")).toBe(false);
    expect(storagePackage).not.toHaveProperty("SessionWorkerPool");
    expect(storagePackage).not.toHaveProperty("SessionClient");
  });

  it("does not expose validated repair or its worker RPC through catalog reflection", async () => {
    const storage = await manager();
    const prototype = Object.getPrototypeOf(storage.catalog) as object;
    const symbolDescriptions = Object.getOwnPropertySymbols(prototype).map(
      (symbol) => symbol.description,
    );

    expect(symbolDescriptions).not.toContain("validatedRepairReconciliation");
    expect(Object.hasOwn(storage.catalog, "rpc")).toBe(false);
  });

  it("rejects changed immutable session-creation identity", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    const created = await storage.createSession(createCommand());
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);

    await expect(
      storage.sessions.initialize(
        {
          sessionId: created.session.sessionId,
          projectId: null,
          title: "Changed title",
          createdAtMs: 1_000,
          eventId: "evt_storage1",
        },
        databasePath,
      ),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(
      storage.sessions.initialize(
        {
          sessionId: created.session.sessionId,
          projectId: null,
          title: "Storage test",
          createdAtMs: 1_000,
          eventId: "evt_changedCreationIdentity",
        },
        databasePath,
      ),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
  });

  it("rebuilds a project-linked session index from its manifest in an empty catalog", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory });
    await original.createProject({
      projectId: "project_rebuildA",
      name: "Rebuild project",
      rootPath: "/tmp/rebuild-project",
      rootRealpath: "/tmp/rebuild-project",
      createdAtMs: 900,
      updatedAtMs: 900,
      config: {},
    });
    const created = await original.createSession(
      createCommand("cmd_rebuildA", "Rebuild", "project_rebuildA"),
    );
    await original.appendTransaction(
      created.session.sessionId,
      runAppend("evt_rebuildRun", "run_rebuildA"),
    );
    await original.appendTransaction(created.session.sessionId, {
      events: [
        {
          eventId: "evt_rebuildMessage",
          eventType: "user.message.appended",
          createdAtMs: 1_020,
          data: {
            eventVersion: 1,
            messageId: "msg_rebuildA",
            runId: "run_rebuildA",
            text: "Rebuild this preview",
          },
        },
      ],
      projections: [
        {
          kind: "message.put",
          messageId: "msg_rebuildA",
          runId: "run_rebuildA",
          role: "user",
          state: "completed",
          createdAtMs: 1_020,
          completedAtMs: 1_020,
        },
      ],
    });
    await original.close();
    await Promise.all([
      rm(join(homeDirectory, "catalog.sqlite3"), { force: true }),
      rm(join(homeDirectory, "catalog.sqlite3-wal"), { force: true }),
      rm(join(homeDirectory, "catalog.sqlite3-shm"), { force: true }),
    ]);

    const rebuilt = await manager({ homeDirectory }, ["ses_unusedRebuild"]);
    await expect(rebuilt.reconciler.reconcileSession(created.session.sessionId)).resolves.toMatchObject({
      sessionId: created.session.sessionId,
      projectId: "project_rebuildA",
      lastEventSequence: 3,
      lastRunState: "created",
      lastMessagePreview: "Rebuild this preview",
    });
  });

  it("configures every session connection with the required SQLite safety pragmas", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const pragmas = await storage.sessions.getPragmasForTest(created.session.sessionId);
    const [major = 0, minor = 0, patch = 0] = pragmas.sqliteVersion
      .split(".")
      .map((part) => Number.parseInt(part, 10));

    expect(pragmas).toMatchObject({
      journalMode: "wal",
      synchronous: 2,
      foreignKeys: 1,
      busyTimeout: 5_000,
      trustedSchema: 0,
    });
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(3_051_003);
  });

  it("commits events and run projections atomically with contiguous ordered replay", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);

    const committed = await storage.appendTransaction(created.session.sessionId, runAppend());
    expect(committed).toMatchObject({ headSequence: 2, catalogObservationScheduled: true });
    await expect(session.getRun("run_storageA")).resolves.toMatchObject({
      state: "created",
      providerConfig: { scenario: "plain-text" },
    });

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_rolledBack",
            eventType: "run.started",
            createdAtMs: 1_020,
            data: { eventVersion: 1, runId: "run_missing" },
          },
        ],
        projections: [
          {
            kind: "run.state",
            runId: "run_missing",
            expectedState: "created",
            nextState: "running",
            startedAtMs: 1_020,
            completedAtMs: null,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.not_found" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "ready",
    });
    await expect(session.getHeadSequence()).resolves.toBe(2);

    await session.appendTransaction({
      events: [
        {
          eventId: "evt_runStarted",
          eventType: "run.started",
          createdAtMs: 1_030,
          data: { eventVersion: 1, runId: "run_storageA" },
        },
      ],
      projections: [
        {
          kind: "run.state",
          runId: "run_storageA",
          expectedState: "created",
          nextState: "running",
          startedAtMs: 1_030,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
      ],
    });
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 3,
      lastRunState: "running",
    });
    const replay = await session.getEventsAfter(1);
    expect(replay.map((event) => [event.sequence, event.eventType])).toEqual([
      [2, "run.created"],
      [3, "run.started"],
    ]);
    await expect(session.getEventById("evt_runStarted")).resolves.toMatchObject({
      sequence: 3,
      eventType: "run.started",
    });
    await expect(session.getEventById("evt_missing")).resolves.toBeNull();
    expect(await session.getEventsAfter(2, 2)).toEqual([]);
  });

  it("protects immutable projection identities and rolls back conflicting events", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const sessionId = created.session.sessionId;
    const session = await storage.openSession(sessionId);
    const run = (runId: string): Extract<ProjectionMutation, { kind: "run.put" }> => ({
      kind: "run.put",
      runId,
      state: "created",
      providerId: "fake",
      providerConfig: { scenario: "identity" },
      createdAtMs: 2_000,
      startedAtMs: null,
      completedAtMs: null,
      cancelledAtMs: null,
      failureCategory: null,
      failureMessage: null,
      activeProviderStepId: null,
    });
    const message = (
      messageId: string,
      runId: string,
    ): Extract<ProjectionMutation, { kind: "message.put" }> => ({
      kind: "message.put",
      messageId,
      runId,
      role: "user",
      state: "completed",
      createdAtMs: 2_001,
      completedAtMs: 2_001,
    });
    const step = (
      stepId: string,
      runId: string,
      stepIndex: number,
    ): Extract<ProjectionMutation, { kind: "providerStep.put" }> => ({
      kind: "providerStep.put",
      stepId,
      runId,
      stepIndex,
      state: "streaming",
      startedAtMs: 2_002,
      completedAtMs: null,
      responseId: null,
      errorCategory: null,
      errorMessage: null,
    });
    const tool: Extract<ProjectionMutation, { kind: "toolExecution.put" }> = {
      kind: "toolExecution.put",
      callId: "call_identityA",
      runId: "run_identityA",
      stepId: "step_identityA",
      toolName: "echo",
      argumentsJson: '{"a":1,"b":2}',
      argumentsHash: "a".repeat(64),
      effectClass: "pure",
      state: "requested",
      attemptCount: 0,
      requestedAtMs: 2_003,
      startedAtMs: null,
      completedAtMs: null,
      result: null,
      error: null,
    };
    const approval: Extract<ProjectionMutation, { kind: "approval.put" }> = {
      kind: "approval.put",
      approvalId: "approval_identityA",
      runId: "run_identityA",
      callId: "call_identityA",
      state: "pending",
      actionDigest: "b".repeat(64),
      requestedAtMs: 2_004,
    };
    const input: Extract<ProjectionMutation, { kind: "input.put" }> = {
      kind: "input.put",
      inputId: "input_identityA",
      runId: "run_identityA",
      state: "pending",
      prompt: "Continue?",
      requestedAtMs: 2_005,
    };
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_identityInitial",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId: "run_identityA" },
        },
      ],
      projections: [
        run("run_identityA"),
        run("run_identityB"),
        message("msg_identityA", "run_identityA"),
        message("msg_identityB", "run_identityB"),
        {
          kind: "messagePart.put",
          partId: "part_identityA",
          messageId: "msg_identityA",
          partIndex: 0,
          partType: "text",
          textContent: "original",
          data: null,
        },
        step("step_identityA", "run_identityA", 0),
        step("step_identityB", "run_identityB", 1),
        tool,
        approval,
        input,
      ],
    });

    const cases: readonly {
      name: string;
      kind: Parameters<typeof storage.sessions.getProjectionIdentityForTest>[1];
      id: string;
      mutation: ProjectionMutation;
      code: string;
    }[] = [
      { name: "run providerId", kind: "run", id: "run_identityA", mutation: { ...run("run_identityA"), providerId: "other" }, code: "session.invalid_transition" },
      { name: "run providerConfig", kind: "run", id: "run_identityA", mutation: { ...run("run_identityA"), providerConfig: { scenario: "other" } }, code: "session.invalid_transition" },
      { name: "run createdAtMs", kind: "run", id: "run_identityA", mutation: { ...run("run_identityA"), createdAtMs: 9_999 }, code: "session.invalid_transition" },
      { name: "message runId", kind: "message", id: "msg_identityA", mutation: { ...message("msg_identityA", "run_identityA"), runId: "run_identityB" }, code: "session.invalid_transition" },
      { name: "message role", kind: "message", id: "msg_identityA", mutation: { ...message("msg_identityA", "run_identityA"), role: "assistant" }, code: "session.invalid_transition" },
      { name: "message createdAtMs", kind: "message", id: "msg_identityA", mutation: { ...message("msg_identityA", "run_identityA"), createdAtMs: 9_999 }, code: "session.invalid_transition" },
      { name: "part messageId", kind: "messagePart", id: "part_identityA", mutation: { kind: "messagePart.put", partId: "part_identityA", messageId: "msg_identityB", partIndex: 0, partType: "text", textContent: "changed", data: null }, code: "session.invalid_transition" },
      { name: "part index", kind: "messagePart", id: "part_identityA", mutation: { kind: "messagePart.put", partId: "part_identityA", messageId: "msg_identityA", partIndex: 1, partType: "text", textContent: "changed", data: null }, code: "session.invalid_transition" },
      { name: "part type", kind: "messagePart", id: "part_identityA", mutation: { kind: "messagePart.put", partId: "part_identityA", messageId: "msg_identityA", partIndex: 0, partType: "json", textContent: "changed", data: null }, code: "session.invalid_transition" },
      { name: "step runId", kind: "providerStep", id: "step_identityA", mutation: { ...step("step_identityA", "run_identityA", 0), runId: "run_identityB" }, code: "session.invalid_transition" },
      { name: "step index", kind: "providerStep", id: "step_identityA", mutation: { ...step("step_identityA", "run_identityA", 0), stepIndex: 9 }, code: "session.invalid_transition" },
      { name: "step startedAtMs", kind: "providerStep", id: "step_identityA", mutation: { ...step("step_identityA", "run_identityA", 0), startedAtMs: 9_999 }, code: "session.invalid_transition" },
      { name: "tool runId", kind: "toolExecution", id: "call_identityA", mutation: { ...tool, runId: "run_identityB" }, code: "provider.protocol_error" },
      { name: "tool stepId", kind: "toolExecution", id: "call_identityA", mutation: { ...tool, stepId: "step_identityB" }, code: "provider.protocol_error" },
      { name: "tool name", kind: "toolExecution", id: "call_identityA", mutation: { ...tool, toolName: "other" }, code: "provider.protocol_error" },
      { name: "tool arguments", kind: "toolExecution", id: "call_identityA", mutation: { ...tool, argumentsJson: '{"a":2,"b":2}' }, code: "provider.protocol_error" },
      { name: "tool hash", kind: "toolExecution", id: "call_identityA", mutation: { ...tool, argumentsHash: "c".repeat(64) }, code: "provider.protocol_error" },
      { name: "tool effect", kind: "toolExecution", id: "call_identityA", mutation: { ...tool, effectClass: "non_idempotent" }, code: "provider.protocol_error" },
      { name: "approval runId", kind: "approval", id: "approval_identityA", mutation: { ...approval, runId: "run_identityB" }, code: "session.invalid_transition" },
      { name: "approval callId", kind: "approval", id: "approval_identityA", mutation: { ...approval, callId: "call_other" }, code: "session.invalid_transition" },
      { name: "approval digest", kind: "approval", id: "approval_identityA", mutation: { ...approval, actionDigest: "d".repeat(64) }, code: "session.invalid_transition" },
      { name: "input runId", kind: "input", id: "input_identityA", mutation: { ...input, runId: "run_identityB" }, code: "session.invalid_transition" },
      { name: "input prompt", kind: "input", id: "input_identityA", mutation: { ...input, prompt: "Changed?" }, code: "session.invalid_transition" },
    ];

    let eventNumber = 0;
    for (const item of cases) {
      const original = await storage.sessions.getProjectionIdentityForTest(
        sessionId,
        item.kind,
        item.id,
      );
      const head = await session.getHeadSequence();
      await expect(
        session.appendTransaction({
          events: [
            {
              eventId: `evt_identityConflict${eventNumber++}`,
              eventType: "run.started",
              createdAtMs: 2_100 + eventNumber,
              data: { eventVersion: 1, runId: "run_identityA" },
            },
          ],
          projections: [item.mutation],
        }),
        item.name,
      ).rejects.toMatchObject({ code: item.code });
      await expect(session.getHeadSequence(), item.name).resolves.toBe(head);
      await expect(
        storage.sessions.getProjectionIdentityForTest(sessionId, item.kind, item.id),
        item.name,
      ).resolves.toEqual(original);
    }

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_identityCanonicalArguments",
            eventType: "run.started",
            createdAtMs: 2_500,
            data: { eventVersion: 1, runId: "run_identityA" },
          },
        ],
        projections: [
          {
            ...tool,
            expectedState: "requested",
            argumentsJson: '{"b":2,"a":1}',
            state: "started",
            attemptCount: 1,
            startedAtMs: 2_500,
          },
        ],
      }),
    ).resolves.toMatchObject({ headSequence: 3 });
  });

  it("applies run state transitions with an atomic expected-state CAS", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    await session.appendTransaction(runAppend("evt_runCasCreated", "run_casA"));
    const createdHead = await session.getHeadSequence();
    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_runCasPutBypass",
            eventType: "run.started",
            createdAtMs: 3_000,
            data: { eventVersion: 1, runId: "run_casA" },
          },
        ],
        projections: [
          {
            kind: "run.put",
            runId: "run_casA",
            state: "running",
            providerId: "fake",
            providerConfig: { scenario: "plain-text" },
            createdAtMs: 1_010,
            startedAtMs: 3_000,
            completedAtMs: null,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(createdHead);
    await expect(session.getRun("run_casA")).resolves.toMatchObject({ state: "created" });

    const transition = (
      eventId: string,
      expectedState: "created" | "running" | "completed",
      nextState: "running" | "completed",
      completedAtMs: number | null,
    ): AppendTransactionInput => ({
      events: [
        {
          eventId,
          eventType: nextState === "running" ? "run.started" : "run.completed",
          createdAtMs: completedAtMs ?? 3_000,
          data: { eventVersion: 1, runId: "run_casA" },
        },
      ],
      projections: [
        {
          kind: "run.state",
          runId: "run_casA",
          expectedState,
          nextState,
          startedAtMs: 3_000,
          completedAtMs,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
      ],
    });

    await session.appendTransaction(transition("evt_runCasStarted", "created", "running", null));
    const runningHead = await session.getHeadSequence();
    await expect(
      session.appendTransaction(transition("evt_runCasStale", "created", "running", null)),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(runningHead);

    await session.appendTransaction(transition("evt_runCasCompleted", "running", "completed", 3_100));
    await expect(session.getRun("run_casA")).resolves.toMatchObject({
      state: "completed",
      completedAtMs: 3_100,
    });
    const terminalHead = await session.getHeadSequence();
    await expect(
      session.appendTransaction(transition("evt_runCasSameTerminal", "running", "completed", 3_100)),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(terminalHead);
    await expect(
      session.appendTransaction(transition("evt_runCasDifferentTerminal", "running", "completed", 3_101)),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(
      session.appendTransaction(
        transition("evt_runCasInvalidTerminalRetry", "created", "completed", 3_100),
      ),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(
      session.appendTransaction(transition("evt_runCasRegress", "completed", "running", null)),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(terminalHead);
  });

  it("rolls back terminal regression and allows only one competing terminal transition", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    const transition = (
      runId: string,
      eventId: string,
      expectedState: "created" | "running" | "cancelling" | "cancelled",
      nextState: "running" | "cancelling" | "cancelled" | "completed" | "failed",
      atMs: number,
    ): AppendTransactionInput => {
      const eventTypes = {
        running: "run.started",
        cancelling: "run.cancel.requested",
        cancelled: "run.cancelled",
        completed: "run.completed",
        failed: "run.failed",
      } as const;
      return {
        events: [
          {
            eventId,
            eventType: eventTypes[nextState],
            createdAtMs: atMs,
            data: {
              eventVersion: 1,
              runId,
              ...(nextState === "failed"
                ? {
                    code: "session.invalid_transition" as const,
                    message: "competing terminal",
                    diagnosticId: "err_competingTerminal",
                  }
                : {}),
            },
          },
        ],
        projections: [
          {
            kind: "run.state",
            runId,
            expectedState,
            nextState,
            startedAtMs: atMs,
            completedAtMs:
              nextState === "completed" || nextState === "failed" ? atMs : null,
            cancelledAtMs: nextState === "cancelled" ? atMs : null,
            failureCategory: nextState === "failed" ? "competing" : null,
            failureMessage: nextState === "failed" ? "competing terminal" : null,
            activeProviderStepId: null,
          },
        ],
      };
    };

    await session.appendTransaction(runAppend("evt_cancelCreated", "run_cancelCas"));
    await session.appendTransaction(
      transition("run_cancelCas", "evt_cancelRunning", "created", "running", 3_200),
    );
    await session.appendTransaction(
      transition("run_cancelCas", "evt_cancelRequested", "running", "cancelling", 3_201),
    );
    await session.appendTransaction(
      transition("run_cancelCas", "evt_cancelled", "cancelling", "cancelled", 3_202),
    );
    const cancelledHead = await session.getHeadSequence();
    await expect(
      session.appendTransaction(
        transition("run_cancelCas", "evt_cancelledCompleted", "cancelled", "completed", 3_203),
      ),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(cancelledHead);

    await session.appendTransaction(runAppend("evt_competingCreated", "run_competingCas"));
    await session.appendTransaction(
      transition("run_competingCas", "evt_competingRunning", "created", "running", 3_210),
    );
    const competingHead = await session.getHeadSequence();
    const competing = await Promise.allSettled([
      session.appendTransaction(
        transition("run_competingCas", "evt_competingCompleted", "running", "completed", 3_211),
      ),
      session.appendTransaction(
        transition("run_competingCas", "evt_competingFailed", "running", "failed", 3_212),
      ),
    ]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(competing.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "session.invalid_transition" },
    });
    await expect(session.getHeadSequence()).resolves.toBe(competingHead + 1);
    await expect(session.getRun("run_competingCas")).resolves.toMatchObject({
      state: expect.stringMatching(/^(completed|failed)$/),
    });
  });

  it("enforces append-only event triggers through worker-owned SQLite", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());

    await expect(
      storage.sessions.testMutateEvent(created.session.sessionId, "update", 1),
    ).rejects.toThrow("session events are immutable");
    await expect(
      storage.sessions.testMutateEvent(created.session.sessionId, "delete", 1),
    ).rejects.toThrow("session events are immutable");
    await expect((await storage.openSession(created.session.sessionId)).getHeadSequence()).resolves.toBe(1);
  });

  it("deduplicates session commands and rejects conflicting command content", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    const input = {
      commandId: "cmd_messageA",
      commandMethod: "message.submit" as const,
      payloadHash: "a".repeat(64),
      result: { runId: "run_storageA" },
      acceptedAtMs: 1_020,
      runId: "run_storageA",
      transaction: runAppend("evt_commandRun"),
    };

    const accepted = await session.acceptCommand(input);
    const duplicate = await storage.acceptCommand(created.session.sessionId, input);
    expect(accepted).toMatchObject({
      duplicate: false,
      acceptedSequence: 2,
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      acceptedSequence: accepted.acceptedSequence,
      result: accepted.result,
    });
    expect(duplicate.events).toEqual([]);
    await expect(
      storage.acceptCommand(created.session.sessionId, {
        ...input,
        payloadHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    await expect(session.getHeadSequence()).resolves.toBe(2);
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      lastRunState: "created",
    });
  });

  it("durably accepts an idempotent session command without inventing an event", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    const input = {
      commandId: "cmd_noopCancel",
      commandMethod: "run.cancel" as const,
      payloadHash: "c".repeat(64),
      result: { runId: "run_alreadyTerminal", state: "completed" },
      acceptedAtMs: 1_030,
      runId: "run_alreadyTerminal",
      transaction: { events: [], projections: [] },
    };

    await expect(session.acceptCommand(input)).resolves.toMatchObject({
      duplicate: false,
      acceptedSequence: 1,
      events: [],
    });
    await expect(session.acceptCommand(input)).resolves.toMatchObject({
      duplicate: true,
      acceptedSequence: 1,
      result: input.result,
      events: [],
    });
    await expect(
      session.acceptCommand({ ...input, payloadHash: "d".repeat(64) }),
    ).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    await expect(session.getHeadSequence()).resolves.toBe(1);
  });

  it("deduplicates global session creation and rejects conflicting reuse", async () => {
    const storage = await manager({}, ["ses_storageA", "ses_unusedB", "ses_unusedC"]);
    const first = await storage.createSession(createCommand());
    await storage.appendTransaction(first.session.sessionId, runAppend());
    await storage.drainCatalogObservations();
    const summaryBeforeDuplicate = await storage.catalog.getSession(first.session.sessionId);
    const duplicate = await storage.createSession(createCommand());

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.events).toEqual([]);
    expect(duplicate.session.sessionId).toBe(first.session.sessionId);
    expect(duplicate.session).toEqual(summaryBeforeDuplicate);
    expect(await storage.catalog.listSessions()).toHaveLength(1);
    await expect(storage.createSession(createCommand("cmd_createA", "Different"))).rejects.toMatchObject({
      code: "protocol.command_id_conflict",
    });
    expect(await storage.catalog.listSessions()).toHaveLength(1);
  });

  it("rejects contradictory accepted global-create provenance", async () => {
    const storage = await manager({}, ["ses_provenanceA"]);
    const created = await storage.createSession(createCommand("cmd_provenanceA", "Provenance"));
    await expect(
      storage.catalog.completeGlobalCommand({
        commandId: created.command.commandId,
        payloadHash: created.command.payloadHash,
        result: { sessionId: "ses_conflictingResult" },
        acceptedAtMs: created.command.acceptedAtMs ?? 0,
      }),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(
      storage.catalog.completeGlobalCommand({
        commandId: created.command.commandId,
        payloadHash: created.command.payloadHash,
        result: created.command.result,
        acceptedAtMs: (created.command.acceptedAtMs ?? 0) + 1,
      }),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
  });

  it("resumes an incomplete global session reservation without changing its session identity", async () => {
    const storage = await manager({}, ["ses_unusedA"]);
    await storage.ready();
    const command = createCommand("cmd_reservedCreate", "Reserved");
    const payloadHash = await hashCommandContent(command);
    await storage.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash,
      reservedSessionId: "ses_reservedA",
      reservedEventId: "evt_reservedCreate",
      request: { title: "Reserved", projectId: null },
      updatedAtMs: 950,
    });

    const recovered = await storage.createSession(command);
    expect(recovered).toMatchObject({
      duplicate: true,
      session: { sessionId: "ses_reservedA" },
      command: { state: "accepted", reservedSessionId: "ses_reservedA" },
    });
    expect(await storage.catalog.listSessions()).toHaveLength(1);
    await expect((await storage.openSession("ses_reservedA")).getManifest()).resolves.toMatchObject({
      createdAtMs: 950,
    });
    await expect((await storage.openSession("ses_reservedA")).getEventsAfter(0, 1)).resolves.toMatchObject([
      { eventId: "evt_reservedCreate", createdAtMs: 950 },
    ]);
  });

  it("retries an incomplete global reservation without losing command identity", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory }, ["ses_unusedOriginal"]);
    await original.ready();
    const command = createCommand("cmd_abandonedCreate", "Abandoned");
    await original.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash: await hashCommandContent(command),
      reservedSessionId: "ses_abandonedA",
      reservedEventId: "evt_abandonedCreate",
      request: { title: "Abandoned", projectId: null },
      updatedAtMs: 950,
    });
    await original.close();

    const restarted = await manager({ homeDirectory }, ["ses_unusedRestart"]);
    await restarted.ready();
    await expect(restarted.catalog.getGlobalCommand(command.commandId)).resolves.toMatchObject({
      state: "accepted",
      reservedSessionId: "ses_abandonedA",
    });
    await expect(restarted.catalog.getSession("ses_abandonedA")).resolves.toMatchObject({
      title: "Abandoned",
      lastEventSequence: 1,
    });
    await expect(
      restarted.createSession(createCommand(command.commandId, "Different")),
    ).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
  });

  it("preserves a corrupt incomplete creation without blocking healthy sessions", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory }, ["ses_healthyA"]);
    const healthy = await original.createSession(createCommand("cmd_healthyA", "Healthy"));
    const corruptCommand = createCommand("cmd_corruptCreating", "Corrupt creating");
    await original.catalog.reserveGlobalCommand({
      commandId: corruptCommand.commandId,
      payloadHash: await hashCommandContent(corruptCommand),
      reservedSessionId: "ses_corruptCreating",
      reservedEventId: "evt_corruptCreating",
      request: { title: "Corrupt creating", projectId: null },
      updatedAtMs: 1_100,
    });
    await original.close();
    await mkdir(resolveStoragePath(homeDirectory, "sessions/co/ses_corruptCreating"), {
      recursive: true,
    });
    await writeFile(
      resolveStoragePath(homeDirectory, "sessions/co/ses_corruptCreating/session.sqlite3"),
      "not a sqlite database",
    );

    const restarted = await manager({ homeDirectory }, ["ses_unusedAfterCorruption"]);
    await expect(restarted.ready()).resolves.toBeUndefined();
    await expect((await restarted.openSession(healthy.session.sessionId)).getHeadSequence()).resolves.toBe(1);
    await expect(restarted.catalog.getGlobalCommand(corruptCommand.commandId)).resolves.toMatchObject({
      state: "failed",
      reservedSessionId: "ses_corruptCreating",
      failureCode: "storage.corrupt",
      diagnosticId: expect.stringMatching(/^err_/),
      quarantinedRelativePath: null,
    });
    await expect(restarted.catalog.getSession("ses_corruptCreating")).resolves.toMatchObject({
      status: "unavailable",
      title: "Corrupt creating",
    });
    await expect(
      stat(resolveStoragePath(homeDirectory, "sessions/co/ses_corruptCreating/session.sqlite3")),
    ).resolves.toBeDefined();
  });

  it("does not claim quarantine when a quarantine-style sibling already exists", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory }, ["ses_unusedQuarantineSetup"]);
    await original.ready();
    const command = createCommand("cmd_quarantineBlocked", "Blocked quarantine");
    await original.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash: await hashCommandContent(command),
      reservedSessionId: "ses_quarantineBlocked",
      reservedEventId: "evt_quarantineBlocked",
      request: { title: "Blocked quarantine", projectId: null },
      updatedAtMs: 1_125,
    });
    await original.close();

    const sourceDirectory = resolveStoragePath(
      homeDirectory,
      "sessions/qu/ses_quarantineBlocked",
    );
    const blockedDestination = resolveStoragePath(
      homeDirectory,
      "sessions/qu/ses_quarantineBlocked.quarantine-err_quarantineBlocked",
    );
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "session.sqlite3"), "not a sqlite database");
    await mkdir(blockedDestination, { recursive: true });
    await writeFile(join(blockedDestination, "keep"), "occupied");

    const restarted = await manager({
      homeDirectory,
      ids: {
        sessionId: () => "ses_unusedQuarantineRestart",
        eventId: () => "evt_unusedQuarantineRestart",
        diagnosticId: () => "err_quarantineBlocked",
      },
    });
    await restarted.ready();
    await expect(restarted.catalog.getGlobalCommand(command.commandId)).resolves.toMatchObject({
      state: "failed",
      failureMessage:
        "The partial session database is unavailable and was retained for recovery.",
      quarantinedRelativePath: null,
    });
    await expect(stat(join(sourceDirectory, "session.sqlite3"))).resolves.toBeDefined();
    await expect(readFile(join(blockedDestination, "keep"), "utf8")).resolves.toBe(
      "occupied",
    );
  });

  it("isolates semantically corrupt stored data without blocking healthy sessions", async () => {
    const storage = await manager({}, ["ses_corruptData", "ses_healthyData"]);
    const corrupt = await storage.createSession(createCommand("cmd_corruptData", "Corrupt"));
    const healthy = await storage.createSession(createCommand("cmd_healthyData", "Healthy"));

    await storage.sessions.corruptManifestForTest(corrupt.session.sessionId);
    await expect(
      (await storage.openSession(corrupt.session.sessionId)).getManifest(),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(storage.catalog.getSession(corrupt.session.sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      (await storage.openSession(healthy.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(1);
  });

  it("fails startup when incomplete-creation recovery cannot update the catalog", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory }, ["ses_unusedCatalogFailure"]);
    await original.ready();
    const command = createCommand("cmd_catalogRecoveryFailure", "Catalog failure");
    await original.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash: await hashCommandContent(command),
      reservedSessionId: "ses_catalogRecoveryFailure",
      reservedEventId: "evt_catalogRecoveryFailure",
      request: { title: "Catalog failure", projectId: null },
      updatedAtMs: 1_150,
    });
    await original.sessions.initialize(
      {
        sessionId: "ses_catalogRecoveryFailure",
        projectId: null,
        title: "Catalog failure",
        createdAtMs: 1_150,
        eventId: "evt_catalogRecoveryFailure",
      },
      resolveStoragePath(
        homeDirectory,
        "sessions/ca/ses_catalogRecoveryFailure/session.sqlite3",
      ),
    );
    await original.close();

    const restarted = new SessionStoreManager({
      homeDirectory,
      sessionWorkers: { size: 1, allowTestOperations: true },
    });
    managers.push(restarted);
    vi.spyOn(restarted.catalog, "reconcileSession").mockRejectedValue(
      new StorageError("storage.disk_full", "injected catalog failure"),
    );

    await expect(restarted.ready()).rejects.toMatchObject({ code: "storage.disk_full" });
    await expect(restarted.catalog.getGlobalCommand(command.commandId)).resolves.toMatchObject({
      state: "creating",
    });
  });

  it("fails startup on a non-isolatable incomplete-creation error", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory }, ["ses_unusedDiskFull"]);
    await original.ready();
    const command = createCommand("cmd_diskFullRecovery", "Disk full");
    await original.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash: await hashCommandContent(command),
      reservedSessionId: "ses_diskFullRecovery",
      reservedEventId: "evt_diskFullRecovery",
      request: { title: "Disk full", projectId: null },
      updatedAtMs: 1_175,
    });
    await original.close();

    const restarted = new SessionStoreManager({
      homeDirectory,
      sessionWorkers: { size: 1, allowTestOperations: true },
    });
    managers.push(restarted);
    vi.spyOn(sessionWorkerPoolForTest(restarted), "initialize").mockRejectedValue(
      new StorageError("storage.disk_full", "injected session storage failure"),
    );

    await expect(restarted.ready()).rejects.toMatchObject({ code: "storage.disk_full" });
  });

  it("fails startup when a corrupt creation cannot be marked in the catalog", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory }, ["ses_unusedMarkFailure"]);
    await original.ready();
    const command = createCommand("cmd_markFailure", "Mark failure");
    await original.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash: await hashCommandContent(command),
      reservedSessionId: "ses_markFailure",
      reservedEventId: "evt_markFailure",
      request: { title: "Mark failure", projectId: null },
      updatedAtMs: 1_180,
    });
    await original.close();
    await mkdir(resolveStoragePath(homeDirectory, "sessions/ma/ses_markFailure"), {
      recursive: true,
    });
    await writeFile(
      resolveStoragePath(homeDirectory, "sessions/ma/ses_markFailure/session.sqlite3"),
      "not a sqlite database",
    );

    const restarted = new SessionStoreManager({
      homeDirectory,
      sessionWorkers: { size: 1, allowTestOperations: true },
    });
    managers.push(restarted);
    vi.spyOn(restarted.catalog, "failGlobalCommand").mockRejectedValue(
      new StorageError("storage.disk_full", "injected catalog status failure"),
    );

    await expect(restarted.ready()).rejects.toMatchObject({ code: "storage.disk_full" });
  });

  it("returns a committed result when post-commit observation scheduling throws", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    const created = await storage.createSession(createCommand());
    const session = storage.sessions.registerSession(
      created.session.sessionId,
      resolveStoragePath(homeDirectory, created.session.dbRelativePath),
      undefined,
      () => {
        throw new Error("injected synchronous observation failure");
      },
    );

    await expect(
      session.appendTransaction(
        runAppend("evt_syncObservationFailure", "run_syncObservationFailure"),
      ),
    ).resolves.toMatchObject({
      headSequence: 2,
      events: [{ eventId: "evt_syncObservationFailure" }],
    });
    await expect(session.getEventsAfter(1)).resolves.toMatchObject([
      { eventId: "evt_syncObservationFailure" },
    ]);
  });

  it("keeps a session commit canonical when catalog projection update fails, then reconciles", async () => {
    const failures: CatalogObservationFailure[] = [];
    const storage = await manager({
      catalogProjectionWriter: async () => {
        throw new Error("injected catalog failure");
      },
      onCatalogObservationError: (failure) => {
        failures.push(failure);
        throw new Error("injected diagnostic callback failure");
      },
    });
    const created = await storage.createSession(createCommand());
    const committed = await storage.appendTransaction(created.session.sessionId, runAppend());

    expect(committed.catalogObservationScheduled).toBe(true);
    await storage.drainCatalogObservations();
    expect(failures).toEqual([
      expect.objectContaining({
        diagnosticId: expect.stringMatching(/^err_/u),
        sessionId: created.session.sessionId,
        headSequence: 2,
        code: "storage.worker_failed",
        error: expect.objectContaining({
          name: "StorageError",
          code: "storage.worker_failed",
        }),
      }),
    ]);
    expect((await storage.catalog.getSession(created.session.sessionId))?.lastEventSequence).toBe(1);
    await expect(
      (await storage.openSession(created.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(2);
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      updatedAtMs: 1_010,
    });
  });

  it("repairs a failed catalog observation when the same client retries a command", async () => {
    const storage = await manager({
      catalogProjectionWriter: async () => {
        throw new Error("injected catalog failure");
      },
    });
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    const input = {
      commandId: "cmd_retryCatalogRepair",
      commandMethod: "message.submit" as const,
      payloadHash: "c".repeat(64),
      result: { runId: "run_retryCatalogRepair" },
      acceptedAtMs: 1_200,
      runId: "run_retryCatalogRepair",
      transaction: runAppend("evt_retryCatalogRepair", "run_retryCatalogRepair"),
    };

    await expect(session.acceptCommand(input)).resolves.toMatchObject({ duplicate: false });
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 1,
    });
    await expect(session.acceptCommand(input)).resolves.toMatchObject({ duplicate: true });
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      lastRunState: "created",
    });
  });

  it("repairs catalog state after a live worker exits following command commit", async () => {
    const storage = await manager({
      sessionWorkers: { size: 1, allowTestOperations: true },
    });
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    const transaction = runAppend("evt_liveCrashCommit", "run_liveCrashCommit");
    const input = {
      commandId: "cmd_liveCrashCommit",
      commandMethod: "message.submit" as const,
      payloadHash: "d".repeat(64),
      result: { runId: "run_liveCrashCommit" },
      acceptedAtMs: 1_225,
      runId: "run_liveCrashCommit",
      transaction: { ...transaction, testFailpoint: "crash_after_commit" as const },
    };

    await expect(session.acceptCommand(input)).rejects.toMatchObject({
      code: "storage.ambiguous_outcome",
    });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 1,
    });
    await expect(session.getHeadSequence()).resolves.toBe(2);
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      lastRunState: "created",
    });
    await expect(session.acceptCommand({ ...input, transaction })).resolves.toMatchObject({
      duplicate: true,
    });
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      lastRunState: "created",
    });
  });

  it("coalesces blocked same-session catalog observers and rejects stale head updates", async () => {
    let releaseFirstWriter = (): void => {};
    let markFirstWriterStarted = (): void => {};
    const firstWriterGate = new Promise<void>((resolve) => {
      releaseFirstWriter = resolve;
    });
    const firstWriterStarted = new Promise<void>((resolve) => {
      markFirstWriterStarted = resolve;
    });
    let writerCalls = 0;
    const storage = await manager({
      catalogProjectionWriter: async (catalog, update) => {
        writerCalls += 1;
        if (writerCalls === 1) {
          markFirstWriterStarted();
          await firstWriterGate;
        }
        await catalog.updateSessionProjection(update);
      },
    });
    const created = await storage.createSession(createCommand());

    const first = await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_observerFirst", "run_observerFirst"),
    );
    expect(first).toMatchObject({
      headSequence: 2,
      events: [{ eventId: "evt_observerFirst" }],
      catalogObservationScheduled: true,
    });
    await firstWriterStarted;
    await expect(
      storage.sessions.getEventsAfter(created.session.sessionId, 1),
    ).resolves.toMatchObject([{ eventId: "evt_observerFirst" }]);
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 1,
    });

    let latestHead = first.headSequence;
    for (let index = 2; index <= 64; index += 1) {
      const committed = await storage.appendTransaction(
        created.session.sessionId,
        runAppend(`evt_observer${index}`, `run_observer${index}`),
      );
      latestHead = committed.headSequence;
    }
    expect(latestHead).toBe(65);
    // One writer plus one coalesced latest-head record is retained while the writer is blocked.
    expect(writerCalls).toBe(1);

    releaseFirstWriter();
    await storage.drainCatalogObservations();
    expect(writerCalls).toBe(2);
    const current = await storage.catalog.getSession(created.session.sessionId);
    if (current === null) throw new Error("Session summary disappeared");
    expect(current.lastEventSequence).toBe(latestHead);
    await expect(
      storage.catalog.updateSessionProjection({
        sessionId: current.sessionId,
        updatedAtMs: current.updatedAtMs,
        lastEventSequence: latestHead - 1,
        lastRunState: current.lastRunState,
        lastMessagePreview: current.lastMessagePreview,
        requiresAttention: current.requiresAttention,
        pendingApprovalCount: current.pendingApprovalCount,
        pendingInputCount: current.pendingInputCount,
      }),
    ).resolves.toMatchObject({
      outcome: "stale",
      summary: { lastEventSequence: latestHead },
    });
  });

  it("writes catalog metadata with the atomic session head that produced it", async () => {
    let releaseFirstSnapshot = (): void => {};
    let markFirstSnapshotStarted = (): void => {};
    const firstSnapshotGate = new Promise<void>((resolve) => {
      releaseFirstSnapshot = resolve;
    });
    const firstSnapshotStarted = new Promise<void>((resolve) => {
      markFirstSnapshotStarted = resolve;
    });
    let writerCalls = 0;
    const storage = await manager({
      catalogProjectionWriter: async (catalog, update) => {
        writerCalls += 1;
        if (writerCalls === 2) throw new Error("injected newer observation failure");
        await catalog.updateSessionProjection(update);
      },
    });
    const created = await storage.createSession(createCommand());
    const getCatalogObservation = storage.sessions.getCatalogObservation.bind(storage.sessions);
    let snapshotCalls = 0;
    vi.spyOn(storage.sessions, "getCatalogObservation").mockImplementation(async (sessionId) => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        markFirstSnapshotStarted();
        await firstSnapshotGate;
      }
      return getCatalogObservation(sessionId);
    });

    await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_atomicObservationCreated", "run_atomicObservation"),
    );
    await firstSnapshotStarted;
    await storage.appendTransaction(created.session.sessionId, {
      events: [
        {
          eventId: "evt_atomicObservationStarted",
          eventType: "run.started",
          createdAtMs: 1_020,
          data: { eventVersion: 1, runId: "run_atomicObservation" },
        },
      ],
      projections: [
        {
          kind: "run.state",
          runId: "run_atomicObservation",
          expectedState: "created",
          nextState: "running",
          startedAtMs: 1_020,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
      ],
    });

    releaseFirstSnapshot();
    await storage.drainCatalogObservations();
    expect(writerCalls).toBe(2);
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 3,
      lastRunState: "running",
      updatedAtMs: 1_020,
    });
  });

  it("treats equal-head catalog updates as idempotent or conflicting without overwriting", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_equalHead", "run_equalHead"),
    );
    await storage.drainCatalogObservations();
    const current = await storage.catalog.getSession(created.session.sessionId);
    if (current === null) throw new Error("Session summary disappeared");
    const update = {
      sessionId: current.sessionId,
      updatedAtMs: current.updatedAtMs,
      lastEventSequence: current.lastEventSequence,
      lastRunState: current.lastRunState,
      lastMessagePreview: current.lastMessagePreview,
      requiresAttention: current.requiresAttention,
      pendingApprovalCount: current.pendingApprovalCount,
      pendingInputCount: current.pendingInputCount,
    };

    await expect(storage.catalog.updateSessionProjection(update)).resolves.toMatchObject({
      outcome: "idempotent",
      summary: current,
    });
    const conflicts = [
      { updatedAtMs: current.updatedAtMs + 1 },
      { lastRunState: "running" as const },
      { lastMessagePreview: "stale" },
      { requiresAttention: !current.requiresAttention },
      { pendingApprovalCount: current.pendingApprovalCount + 1 },
      { pendingInputCount: current.pendingInputCount + 1 },
    ];
    for (const changed of conflicts) {
      await expect(
        storage.catalog.updateSessionProjection({ ...update, ...changed }),
      ).rejects.toMatchObject({ code: "storage.catalog_projection_conflict" });
      await expect(storage.catalog.getSession(current.sessionId)).resolves.toEqual(current);
    }
  });

  it("stops new commits while shutdown drains an accepted catalog observation", async () => {
    const homeDirectory = await temporaryHome();
    let releaseWriter = (): void => {};
    let markWriterStarted = (): void => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const storage = await manager({
      homeDirectory,
      catalogProjectionWriter: async (catalog, update) => {
        markWriterStarted();
        await writerGate;
        await catalog.updateSessionProjection(update);
      },
    });
    const created = await storage.createSession(createCommand());
    const accepted = storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_shutdownAccepted", "run_shutdownAccepted"),
    );
    await writerStarted;

    let closed = false;
    const closing = storage.close().then(() => {
      closed = true;
    });
    await expect(
      storage.appendTransaction(
        created.session.sessionId,
        runAppend("evt_shutdownRejected", "run_shutdownRejected"),
      ),
    ).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Session store manager is closing",
    });
    expect(closed).toBe(false);
    await expect(accepted).resolves.toMatchObject({
      headSequence: 2,
      catalogObservationScheduled: true,
    });

    releaseWriter();
    await expect(closing).resolves.toBeUndefined();

    const reopened = await manager({ homeDirectory });
    await expect(reopened.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      lastRunState: "created",
    });
    await expect(
      (await reopened.openSession(created.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(2);
  });

  it("bounds shutdown when a catalog observer never resolves", async () => {
    let markWriterStarted = (): void => {};
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const storage = await manager({
      catalogObservationShutdownTimeoutMs: 30,
      catalogProjectionWriter: async () => {
        markWriterStarted();
        await new Promise<void>(() => {});
      },
    });
    const created = await storage.createSession(createCommand());
    await expect(
      storage.appendTransaction(
        created.session.sessionId,
        runAppend("evt_shutdownBounded", "run_shutdownBounded"),
      ),
    ).resolves.toMatchObject({ headSequence: 2, catalogObservationScheduled: true });
    await writerStarted;
    await expect(storage.close()).rejects.toMatchObject({
      message: "Storage shutdown failed",
    });
  });

  it("drains an accepted session creation before shutdown closes workers", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({ homeDirectory });
    const reserveGlobalCommand = storage.catalog.reserveGlobalCommand.bind(storage.catalog);
    let releaseReservation = (): void => {};
    let markReservationCommitted = (): void => {};
    const reservationGate = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const reservationCommitted = new Promise<void>((resolve) => {
      markReservationCommitted = resolve;
    });
    vi.spyOn(storage.catalog, "reserveGlobalCommand").mockImplementation(async (input) => {
      const reservation = await reserveGlobalCommand(input);
      markReservationCommitted();
      await reservationGate;
      return reservation;
    });

    const creation = storage.createSession(
      createCommand("cmd_shutdownCreateAccepted", "Shutdown accepted"),
    );
    await reservationCommitted;
    let closed = false;
    const closing = storage.close().then(() => {
      closed = true;
    });

    await expect(
      storage.createSession(createCommand("cmd_shutdownCreateRejected", "Shutdown rejected")),
    ).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Session store manager is closing",
    });
    await expect(
      storage.catalog.getGlobalCommand("cmd_shutdownCreateRejected"),
    ).resolves.toBeNull();
    expect(closed).toBe(false);

    releaseReservation();
    const created = await creation;
    expect(created.session).toMatchObject({
      sessionId: "ses_storageA",
      status: "ready",
      lastEventSequence: 1,
    });
    await expect(closing).resolves.toBeUndefined();

    const reopened = await manager({ homeDirectory });
    await expect(
      reopened.catalog.getGlobalCommand("cmd_shutdownCreateAccepted"),
    ).resolves.toMatchObject({ state: "accepted", reservedSessionId: created.session.sessionId });
    await expect(
      reopened.catalog.getGlobalCommand("cmd_shutdownCreateRejected"),
    ).resolves.toBeNull();
    await expect(reopened.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "ready",
      lastEventSequence: 1,
    });
  });

  it("does not let stale reconciliation regress a newer catalog projection", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_reconcileSnapshot", "run_reconcileSnapshot"),
    );
    await storage.drainCatalogObservations();
    const staleInspection = await storage.reconciler.inspectSession(created.session.sessionId);

    await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_reconcileNewest", "run_reconcileNewest"),
    );
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 3,
    });
    await expect(storage.catalog.reconcileSession(staleInspection)).resolves.toMatchObject({
      lastEventSequence: 3,
    });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 3,
      lastRunState: "created",
    });
  });

  it("applies a newer canonical snapshot after a partial catalog advance wins the first CAS", async () => {
    const storage = await manager({
      catalogProjectionWriter: async () => {
        throw new Error("injected catalog lag");
      },
    });
    const created = await storage.createSession(createCommand());
    await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_partialCasSecond", "run_partialCasSecond"),
    );
    await storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_partialCasThird", "run_partialCasThird"),
    );
    await storage.drainCatalogObservations();
    const inspection = await storage.reconciler.inspectSession(created.session.sessionId);
    const stale = await storage.catalog.getSession(created.session.sessionId);
    if (stale === null) throw new Error("Session summary disappeared");
    await storage.catalog.updateSessionProjection({
      sessionId: stale.sessionId,
      updatedAtMs: stale.updatedAtMs,
      lastEventSequence: 2,
      lastRunState: stale.lastRunState,
      lastMessagePreview: stale.lastMessagePreview,
      requiresAttention: stale.requiresAttention,
      pendingApprovalCount: stale.pendingApprovalCount,
      pendingInputCount: stale.pendingInputCount,
    });

    await expect(storage.catalog.reconcileSession(inspection)).resolves.toMatchObject({
      lastEventSequence: 3,
      lastRunState: "created",
      status: "ready",
    });
  });

  it("repairs a catalog head that was already ahead of canonical session storage", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const current = await storage.catalog.getSession(created.session.sessionId);
    if (current === null) throw new Error("Session summary disappeared");
    await storage.catalog.updateSessionProjection({
      sessionId: current.sessionId,
      updatedAtMs: current.updatedAtMs,
      lastEventSequence: 9,
      lastRunState: current.lastRunState,
      lastMessagePreview: current.lastMessagePreview,
      requiresAttention: current.requiresAttention,
      pendingApprovalCount: current.pendingApprovalCount,
      pendingInputCount: current.pendingInputCount,
    });

    await expect(storage.reconciler.reconcileSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 1,
      status: "ready",
    });
  });

  it("reports an unhealthy catalog when empty-event reconciliation loses a fault race", async () => {
    const homeDirectory = await temporaryHome();
    const storage = await manager({
      homeDirectory,
      sessionWorkers: { size: 1, allowTestOperations: true },
    });
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    const transaction = runAppend("evt_observationFaultRace", "run_observationFaultRace");
    const input = {
      commandId: "cmd_observationFaultRace",
      commandMethod: "message.submit" as const,
      payloadHash: "e".repeat(64),
      result: { runId: "run_observationFaultRace" },
      acceptedAtMs: 1_230,
      runId: "run_observationFaultRace",
      transaction: { ...transaction, testFailpoint: "crash_after_commit" as const },
    };
    await expect(session.acceptCommand(input)).rejects.toMatchObject({
      code: "storage.ambiguous_outcome",
    });

    const reconcileSession = storage.catalog.reconcileSession.bind(storage.catalog);
    let releaseReconciliation = (): void => {};
    let markReconciliationStarted = (): void => {};
    const reconciliationGate = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const reconciliationStarted = new Promise<void>((resolve) => {
      markReconciliationStarted = resolve;
    });
    vi.spyOn(storage.catalog, "reconcileSession").mockImplementation(async (reconcileInput) => {
      markReconciliationStarted();
      await reconciliationGate;
      return reconcileSession(reconcileInput);
    });

    const retry = session.acceptCommand({ ...input, transaction });
    await reconciliationStarted;
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    const movedDatabasePath = `${databasePath}.observation-fault-race`;
    await rename(databasePath, movedDatabasePath);
    await expect(
      storage.sessions.getHeadSequence(created.session.sessionId),
    ).rejects.toMatchObject({ code: "storage.session_missing" });
    releaseReconciliation();
    await expect(retry).rejects.toMatchObject({ code: "storage.session_missing" });

    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "missing",
      lastEventSequence: 1,
    });

    await rename(movedDatabasePath, databasePath);
    await expect(session.getHeadSequence()).rejects.toMatchObject({
      code: "storage.session_missing",
    });
    await storage.close();
    managers.splice(managers.indexOf(storage), 1);
    const repaired = await manager(
      { homeDirectory, catalogRepair: "force" },
      ["ses_unusedObservationFaultRepair"],
    );
    await repaired.ready();
    await expect(
      (await repaired.openSession(created.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(2);
    await expect(repaired.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "ready",
      lastEventSequence: 2,
    });
  });

  it("keeps unavailable status sticky when a delayed observer races database removal", async () => {
    let releaseWriter = (): void => {};
    let markWriterStarted = (): void => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const homeDirectory = await temporaryHome();
    const storage = await manager({
      homeDirectory,
      catalogProjectionWriter: async (catalog, update) => {
        markWriterStarted();
        await writerGate;
        await catalog.updateSessionProjection(update);
      },
    });
    const created = await storage.createSession(createCommand());
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    const movedDatabasePath = `${databasePath}.temporarily-missing`;

    const append = storage.appendTransaction(
      created.session.sessionId,
      runAppend("evt_quarantineRace", "run_quarantineRace"),
    );
    await writerStarted;
    await rename(databasePath, movedDatabasePath);
    await expect(
      (await storage.openSession(created.session.sessionId)).getHeadSequence(),
    ).rejects.toMatchObject({ code: "storage.session_missing" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "missing",
    });

    await expect(append).resolves.toMatchObject({
      headSequence: 2,
      catalogObservationScheduled: true,
    });
    releaseWriter();
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "missing",
      lastEventSequence: 2,
    });

    await rename(movedDatabasePath, databasePath);
    await expect(storage.openSession(created.session.sessionId)).rejects.toMatchObject({
      code: "storage.session_missing",
    });
    await storage.close();
    managers.splice(managers.indexOf(storage), 1);
    const repaired = await manager(
      { homeDirectory, catalogRepair: "force" },
      ["ses_unusedDelayedObserverRepair"],
    );
    await repaired.ready();
    await expect(
      (await repaired.openSession(created.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(2);
    await expect(repaired.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "ready",
      lastEventSequence: 2,
    });
  });

  it("reapplies unavailable status when stale reconciliation races database removal", async () => {
    const homeDirectory = await temporaryHome();
    const original = await manager({ homeDirectory });
    const created = await original.createSession(createCommand());
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    const movedDatabasePath = `${databasePath}.reconcile-race`;
    await original.close();

    const restarted = await manager({ homeDirectory }, ["ses_unusedReconcileRace"]);
    const reconcileSession = restarted.catalog.reconcileSession.bind(restarted.catalog);
    let releaseReconciliation = (): void => {};
    let markReconciliationStarted = (): void => {};
    const reconciliationGate = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const reconciliationStarted = new Promise<void>((resolve) => {
      markReconciliationStarted = resolve;
    });
    vi.spyOn(restarted.catalog, "reconcileSession").mockImplementation(async (input) => {
      markReconciliationStarted();
      await reconciliationGate;
      return reconcileSession(input);
    });

    const client = await restarted.openSession(created.session.sessionId);
    const opening = client.getHeadSequence();
    await reconciliationStarted;
    await rename(databasePath, movedDatabasePath);
    await expect(
      restarted.sessions.getHeadSequence(created.session.sessionId),
    ).rejects.toMatchObject({ code: "storage.session_missing" });
    await expect(restarted.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "missing",
    });

    releaseReconciliation();
    await expect(opening).rejects.toMatchObject({ code: "storage.session_missing" });
    await expect(restarted.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "missing",
    });

    await rename(movedDatabasePath, databasePath);
    await expect(restarted.openSession(created.session.sessionId)).rejects.toMatchObject({
      code: "storage.session_missing",
    });
    await restarted.close();
    managers.splice(managers.indexOf(restarted), 1);
    const repaired = await manager(
      { homeDirectory, catalogRepair: "force" },
      ["ses_unusedStaleReconciliationRepair"],
    );
    await repaired.ready();
    await expect(
      (await repaired.openSession(created.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(1);
    await expect(repaired.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("orders concurrent original and duplicate command observation", async () => {
    let releaseWriter = (): void => {};
    let markWriterStarted = (): void => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    let writerCalls = 0;
    const storage = await manager({
      catalogProjectionWriter: async (catalog, update) => {
        writerCalls += 1;
        if (writerCalls === 1) {
          markWriterStarted();
          await writerGate;
        }
        await catalog.updateSessionProjection(update);
      },
    });
    const created = await storage.createSession(createCommand());
    const input = {
      commandId: "cmd_concurrentDuplicate",
      commandMethod: "message.submit" as const,
      payloadHash: "d".repeat(64),
      result: { runId: "run_concurrentDuplicate" },
      acceptedAtMs: 1_250,
      runId: "run_concurrentDuplicate",
      transaction: runAppend("evt_concurrentDuplicate", "run_concurrentDuplicate"),
    };

    const original = storage.acceptCommand(created.session.sessionId, input);
    await writerStarted;
    const duplicate = storage.acceptCommand(created.session.sessionId, input);
    await expect(storage.sessions.getHeadSequence(created.session.sessionId)).resolves.toBe(2);
    expect(writerCalls).toBe(1);

    releaseWriter();
    await expect(Promise.all([original, duplicate])).resolves.toMatchObject([
      { duplicate: false, catalogObservationScheduled: true },
      { duplicate: true, catalogObservationScheduled: true },
    ]);
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
    });
  });

  it("routes stably, lazily opens sessions, evicts least-recently-used handles, and lists from catalog", async () => {
    const ids = ["ses_routeA", "ses_routeB"] as const;
    const storage = await manager(
      { sessionWorkers: { size: 1, maxOpenHandlesPerWorker: 1, allowTestOperations: true } },
      ids,
    );
    const first = await storage.createSession(createCommand("cmd_routeA", "A"));
    const second = await storage.createSession(createCommand("cmd_routeB", "B"));
    expect(storage.sessions.workerIndexFor(first.session.sessionId)).toBe(0);
    expect(storage.sessions.workerIndexFor(first.session.sessionId)).toBe(
      storage.sessions.workerIndexFor(first.session.sessionId),
    );
    expect((await storage.sessions.getStats())[0]?.openSessionIds).toEqual([
      second.session.sessionId,
    ]);
    await (await storage.openSession(second.session.sessionId)).close();
    expect((await storage.sessions.getStats())[0]?.openSessionIds).toEqual([]);

    const firstClient = await storage.openSession(first.session.sessionId);
    expect((await storage.sessions.getStats())[0]?.openSessionIds).toEqual([]);
    await firstClient.getManifest();
    expect((await storage.sessions.getStats())[0]?.openSessionIds).toEqual([
      first.session.sessionId,
    ]);

    await firstClient.close();
    expect((await storage.sessions.getStats()).flatMap((worker) => worker.openSessionIds)).toEqual([]);
    expect(await storage.catalog.listSessions()).toHaveLength(2);
  });

  it("appends concurrently on sessions assigned to different fixed workers", async () => {
    const ids: string[] = [];
    for (let number = 0; ids.length < 2; number += 1) {
      const candidate = `ses_concurrent${number}`;
      if (
        ids.length === 0 ||
        stableSessionWorkerIndex(candidate, 2) !== stableSessionWorkerIndex(ids[0] ?? "", 2)
      ) {
        ids.push(candidate);
      }
    }
    const storage = await manager({}, ids);
    const first = await storage.createSession(createCommand("cmd_concurrentA", "A"));
    const second = await storage.createSession(createCommand("cmd_concurrentB", "B"));
    await storage.sessions.proveConcurrentWorkersForTest([
      first.session.sessionId,
      second.session.sessionId,
    ]);

    const [firstAppend, secondAppend] = await Promise.all([
      storage.appendTransaction(first.session.sessionId, runAppend("evt_concurrentA", "run_concurrentA")),
      storage.appendTransaction(second.session.sessionId, runAppend("evt_concurrentB", "run_concurrentB")),
    ]);
    expect([firstAppend.headSequence, secondAppend.headSequence]).toEqual([2, 2]);
  });

  it("restores pending approvals and reports recovery candidates without inventing events", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_recoveryRun",
          eventType: "run.started",
          createdAtMs: 1_100,
          data: { eventVersion: 1, runId: "run_recoveryA" },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_recoveryA",
          state: "running",
          providerId: "fake",
          providerConfig: { scenario: "approval-round-trip" },
          createdAtMs: 1_090,
          startedAtMs: 1_100,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: "step_recoveryA",
        },
        {
          kind: "providerStep.put",
          stepId: "step_recoveryA",
          runId: "run_recoveryA",
          stepIndex: 0,
          state: "streaming",
          startedAtMs: 1_100,
          completedAtMs: null,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        },
        {
          kind: "toolExecution.put",
          callId: "call_recoveryPure",
          runId: "run_recoveryA",
          stepId: "step_recoveryA",
          toolName: "guarded_echo",
          argumentsJson: "{}",
          argumentsHash: "c".repeat(64),
          effectClass: "pure",
          state: "started",
          attemptCount: 1,
          requestedAtMs: 1_100,
          startedAtMs: 1_110,
          completedAtMs: null,
          result: null,
          error: null,
        },
        {
          kind: "toolExecution.put",
          callId: "call_recoveryExternal",
          runId: "run_recoveryA",
          stepId: "step_recoveryA",
          toolName: "external",
          argumentsJson: "{}",
          argumentsHash: "d".repeat(64),
          effectClass: "non_idempotent",
          state: "started",
          attemptCount: 1,
          requestedAtMs: 1_100,
          startedAtMs: 1_110,
          completedAtMs: null,
          result: null,
          error: null,
        },
        {
          kind: "approval.put",
          approvalId: "approval_recoveryA",
          runId: "run_recoveryA",
          callId: "call_recoveryPure",
          state: "pending",
          actionDigest: "e".repeat(64),
          requestedAtMs: 1_105,
        },
      ],
    });

    await expect(session.getPendingApprovals()).resolves.toMatchObject([
      { approvalId: "approval_recoveryA", state: "pending" },
    ]);
    await expect(session.recover()).resolves.toEqual({
      interruptedRunIds: ["run_recoveryA"],
      interruptedStepIds: ["step_recoveryA"],
      startedToolCalls: [
        { callId: "call_recoveryExternal", effectClass: "non_idempotent" },
        { callId: "call_recoveryPure", effectClass: "pure" },
      ],
      outcomeUnknownRunIds: [],
    });
    await expect(session.getRun("run_recoveryA")).resolves.toMatchObject({ state: "running" });
    await expect(session.getPendingApprovals()).resolves.toHaveLength(1);
    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_effectClassConflict",
            eventType: "run.started",
            createdAtMs: 1_115,
            data: { eventVersion: 1, runId: "run_recoveryA" },
          },
        ],
        projections: [
          {
            kind: "toolExecution.put",
            callId: "call_recoveryPure",
            runId: "run_recoveryA",
            stepId: "step_recoveryA",
            toolName: "guarded_echo",
            argumentsJson: "{}",
            argumentsHash: "c".repeat(64),
            effectClass: "non_idempotent",
            state: "started",
            attemptCount: 1,
            requestedAtMs: 1_100,
            startedAtMs: 1_110,
            completedAtMs: null,
            result: null,
            error: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "provider.protocol_error" });
    await expect(session.getHeadSequence()).resolves.toBe(2);
    await expect(session.recover()).resolves.toMatchObject({
      startedToolCalls: expect.arrayContaining([
        { callId: "call_recoveryPure", effectClass: "pure" },
      ]),
    });

    await session.appendTransaction({
      events: [
        {
          eventId: "evt_approvalResolved",
          eventType: "tool.approval.resolved",
          createdAtMs: 1_120,
          data: {
            eventVersion: 1,
            runId: "run_recoveryA",
            callId: "call_recoveryPure",
            approvalId: "approval_recoveryA",
            resolution: "approved",
          },
        },
      ],
      projections: [
        {
          kind: "approval.resolve",
          approvalId: "approval_recoveryA",
          resolution: "approved",
          resolvedAtMs: 1_120,
          resolvedByClientId: "client_recoveryA",
        },
      ],
    });
    await expect(session.getPendingApprovals()).resolves.toEqual([]);
    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_approvalSecondResolution",
            eventType: "tool.approval.resolved",
            createdAtMs: 1_130,
            data: {
              eventVersion: 1,
              runId: "run_recoveryA",
              callId: "call_recoveryPure",
              approvalId: "approval_recoveryA",
              resolution: "denied",
            },
          },
        ],
        projections: [
          {
            kind: "approval.resolve",
            approvalId: "approval_recoveryA",
            resolution: "denied",
            resolvedAtMs: 1_130,
            resolvedByClientId: "client_recoveryB",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(3);
  });

  it("tracks and reconciles pending-input attention with one durable resolution", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    await storage.appendTransaction(created.session.sessionId, {
      events: [
        {
          eventId: "evt_inputRequested",
          eventType: "input.requested",
          createdAtMs: 1_200,
          data: {
            eventVersion: 1,
            runId: "run_inputA",
            inputId: "input_storageA",
            prompt: "Continue?",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_inputA",
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: { scenario: "input" },
          createdAtMs: 1_190,
          startedAtMs: 1_195,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId: "input_storageA",
          runId: "run_inputA",
          state: "pending",
          prompt: "Continue?",
          requestedAtMs: 1_200,
        },
      ],
    });
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      requiresAttention: true,
      pendingInputCount: 1,
    });

    const stale = await storage.catalog.getSession(created.session.sessionId);
    if (stale === null) throw new Error("Session index disappeared");
    await expect(
      storage.catalog.updateSessionProjection({
        sessionId: stale.sessionId,
        updatedAtMs: stale.updatedAtMs,
        lastEventSequence: stale.lastEventSequence,
        lastRunState: stale.lastRunState,
        lastMessagePreview: stale.lastMessagePreview,
        requiresAttention: false,
        pendingApprovalCount: stale.pendingApprovalCount,
        pendingInputCount: 0,
      }),
    ).rejects.toMatchObject({ code: "storage.catalog_projection_conflict" });
    await expect(storage.reconciler.reconcileSession(created.session.sessionId)).resolves.toMatchObject({
      requiresAttention: true,
      pendingInputCount: 1,
    });
    await expect(session.getInput("input_storageA")).resolves.toMatchObject({
      state: "pending",
      value: null,
    });

    await storage.appendTransaction(created.session.sessionId, {
      events: [
        {
          eventId: "evt_inputResolved",
          eventType: "input.resolved",
          createdAtMs: 1_210,
          data: {
            eventVersion: 1,
            runId: "run_inputA",
            inputId: "input_storageA",
            value: "yes",
          },
        },
      ],
      projections: [
        {
          kind: "input.resolve",
          inputId: "input_storageA",
          resolvedAtMs: 1_210,
          value: "yes",
        },
      ],
    });
    await storage.drainCatalogObservations();
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      requiresAttention: false,
      pendingInputCount: 0,
    });
    await expect(session.getInput("input_storageA")).resolves.toMatchObject({
      state: "resolved",
      resolvedAtMs: 1_210,
      value: "yes",
    });
    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_inputSecondResolution",
            eventType: "input.resolved",
            createdAtMs: 1_220,
            data: {
              eventVersion: 1,
              runId: "run_inputA",
              inputId: "input_storageA",
              value: "again",
            },
          },
        ],
        projections: [
          {
            kind: "input.resolve",
            inputId: "input_storageA",
            resolvedAtMs: 1_220,
            value: "again",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(3);
  });

  it("makes pending interactions non-actionable when their run is cancelled", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_cancelInteractionRequested",
          eventType: "input.requested",
          createdAtMs: 1_300,
          data: {
            eventVersion: 1,
            runId: "run_cancelInteraction",
            inputId: "input_cancelInteraction",
            prompt: "Continue?",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_cancelInteraction",
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: {},
          createdAtMs: 1_290,
          startedAtMs: 1_295,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId: "input_cancelInteraction",
          runId: "run_cancelInteraction",
          state: "pending",
          prompt: "Continue?",
          requestedAtMs: 1_300,
        },
      ],
    });
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_cancelInteractionRequestedCancel",
          eventType: "run.cancel.requested",
          createdAtMs: 1_310,
          data: { eventVersion: 1, runId: "run_cancelInteraction" },
        },
      ],
      projections: [
        {
          kind: "run.state",
          runId: "run_cancelInteraction",
          expectedState: "waiting_for_user",
          nextState: "cancelling",
          startedAtMs: 1_295,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
      ],
    });
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_cancelInteractionCancelled",
          eventType: "run.cancelled",
          createdAtMs: 1_320,
          data: { eventVersion: 1, runId: "run_cancelInteraction" },
        },
      ],
      projections: [
        {
          kind: "run.state",
          runId: "run_cancelInteraction",
          expectedState: "cancelling",
          nextState: "cancelled",
          startedAtMs: 1_295,
          completedAtMs: null,
          cancelledAtMs: 1_320,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "run.pendingInteractions.cancel",
          runId: "run_cancelInteraction",
          cancelledAtMs: 1_320,
        },
      ],
    });

    await expect(session.getPendingInputs()).resolves.toEqual([]);
    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_cancelInteractionLateResponse",
            eventType: "input.resolved",
            createdAtMs: 1_330,
            data: {
              eventVersion: 1,
              runId: "run_cancelInteraction",
              inputId: "input_cancelInteraction",
              value: "late",
            },
          },
        ],
        projections: [
          {
            kind: "input.resolve",
            inputId: "input_cancelInteraction",
            resolvedAtMs: 1_330,
            value: "late",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });
    await expect(session.getHeadSequence()).resolves.toBe(4);
  });

  it("rejects oversized worker payloads before they can mutate a session", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());
    const session = await storage.openSession(created.session.sessionId);

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_oversizedPayload",
            eventType: "user.message.appended",
            createdAtMs: 1_300,
            data: {
              eventVersion: 1,
              messageId: "msg_oversizedPayload",
              text: "x".repeat(1_000_001),
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "storage.payload_too_large" });
    await expect(session.getHeadSequence()).resolves.toBe(1);
  });

  it("keeps crash and mutation test operations disabled in normal worker configuration", async () => {
    const storage = await manager({
      sessionWorkers: {
        size: 1,
        maxOpenHandlesPerWorker: 2,
        allowTestOperations: false,
      },
    });
    const created = await storage.createSession(createCommand());
    await expect(
      (await storage.openSession(created.session.sessionId)).appendTransaction({
        ...runAppend(),
        testFailpoint: "crash_before_commit",
      }),
    ).rejects.toThrow("Storage failpoints are disabled");
    await expect(
      storage.sessions.crashWorkerForTest(created.session.sessionId),
    ).rejects.toThrow("Test operations are disabled");
    await expect(
      storage.sessions.testMutateEvent(created.session.sessionId, "delete", 1),
    ).rejects.toThrow("Test operations are disabled");
  });

  it("cannot enable destructive test operations outside the test environment", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let storage: SessionStoreManager | null = null;
    try {
      storage = await manager({
        sessionWorkers: {
          size: 1,
          maxOpenHandlesPerWorker: 2,
          allowTestOperations: true,
        },
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (storage === null) throw new Error("Storage manager did not initialize");
    await storage.createSession(createCommand());
    expect(() => sessionWorkerPoolForTest(storage)).toThrow(
      "Session worker test access was not enabled",
    );
  });

  it("keeps a replacement worker healthy when its monitoring callback throws", async () => {
    let replacements = 0;
    const storage = await manager({
      sessionWorkers: {
        size: 1,
        maxOpenHandlesPerWorker: 2,
        allowTestOperations: true,
        onWorkerReplacement: () => {
          replacements += 1;
          throw new Error("injected replacement callback failure");
        },
      },
    });
    const created = await storage.createSession(createCommand());

    await expect(
      storage.sessions.malformedResponseForTest(created.session.sessionId),
    ).rejects.toMatchObject({ code: "storage.worker_failed" });
    await vi.waitFor(() => {
      expect(replacements).toBe(1);
    });
    await expect(
      (await storage.openSession(created.session.sessionId)).getHeadSequence(),
    ).resolves.toBe(1);
  });

  it("fails closed when a durable incomplete repair is restarted with repair disabled", async () => {
    const homeDirectory = await temporaryHome();
    const first = new SessionStoreManager({ homeDirectory, catalogRepair: "off" });
    managers.push(first);
    await first.ready();
    await first.catalog.beginRepair("catalog_new");
    await first.close();
    managers.splice(managers.indexOf(first), 1);

    const restarted = new SessionStoreManager({ homeDirectory, catalogRepair: "off" });
    managers.push(restarted);
    await expect(restarted.ready()).rejects.toMatchObject({ code: "storage.corrupt" });
  });

  it("reconciles a healthy catalog in place without losing catalog-only state", async () => {
    const homeDirectory = await temporaryHome();
    const original = new SessionStoreManager({
      homeDirectory,
      now: () => 1_000,
      ids: {
        sessionId: () => "ses_forceHealthy",
        eventId: () => "evt_forceHealthyCreated",
      },
    });
    managers.push(original);
    await original.createProject({
      projectId: "project_forceHealthy",
      name: "Force repair project",
      rootPath: "/tmp/force-repair-project",
      rootRealpath: "/tmp/force-repair-project",
      createdAtMs: 900,
      updatedAtMs: 900,
      config: { retained: true },
    });
    const created = await original.createSession(
      createCommand("cmd_forceHealthy", "Force repair", "project_forceHealthy"),
    );
    await original.catalog.createSessionIndex({
      sessionId: "ses_forceUnavailable",
      projectId: null,
      dbRelativePath: "sessions/fo/ses_forceUnavailable/session.sqlite3",
      title: "Unavailable before repair",
      status: "unavailable",
      createdAtMs: 950,
      updatedAtMs: 950,
      lastEventSequence: 0,
      lastRunState: null,
      lastMessagePreview: null,
      requiresAttention: true,
      pendingApprovalCount: 0,
      pendingInputCount: 0,
      sessionSchemaVersion: SESSION_SCHEMA_VERSION,
      recoveryCandidate: false,
      unavailableReason: "quarantined",
    });
    await original.close();
    managers.splice(managers.indexOf(original), 1);
    const catalogIdentity = await stat(join(homeDirectory, "catalog.sqlite3"));

    const forced = new SessionStoreManager({ homeDirectory, catalogRepair: "force" });
    managers.push(forced);
    await forced.ready();

    expect(forced.catalogRepairStatus()).toMatchObject({
      triggered: true,
      reason: "explicit",
      repaired: 1,
    });
    expect((await stat(join(homeDirectory, "catalog.sqlite3"))).ino).toBe(catalogIdentity.ino);
    await expect(forced.catalog.getGlobalCommand("cmd_forceHealthy")).resolves.toMatchObject({
      state: "accepted",
      reservedSessionId: created.session.sessionId,
    });
    await expect(forced.catalog.getSession("ses_forceUnavailable")).resolves.toMatchObject({
      status: "unavailable",
      title: "Unavailable before repair",
    });
    expect((await readdir(homeDirectory)).some((name) => name.includes("quarantine"))).toBe(false);
  });

  it("rejects a noncanonical path for an existing catalog session", async () => {
    const storage = await manager();
    const created = await storage.createSession(createCommand());

    await expect(
      storage.catalog.createSessionIndex({
        ...created.session,
        dbRelativePath: "sessions/zz/ses_storageA/session.sqlite3",
      }),
    ).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(storage.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      dbRelativePath: created.session.dbRelativePath,
    });
  });

  it(
    "rejects a healthy-catalog lazy open through a symlink outside WI_HOME",
    async () => {
      const homeDirectory = await temporaryHome();
      const original = new SessionStoreManager({
        homeDirectory,
        ids: {
          sessionId: () => "ses_lazySymlink",
          eventId: () => "evt_lazySymlinkCreated",
        },
      });
      managers.push(original);
      const created = await original.createSession(
        createCommand("cmd_lazySymlink", "Lazy symlink"),
      );
      await original.close();
      managers.splice(managers.indexOf(original), 1);

      const sessionDirectory = resolveStoragePath(
        homeDirectory,
        created.session.dbRelativePath.slice(0, -"/session.sqlite3".length),
      );
      const externalHome = await mkdtemp(join(tmpdir(), "wi-storage-external-"));
      homes.push(externalHome);
      const externalDirectory = join(externalHome, "moved-session");
      await rename(sessionDirectory, externalDirectory);
      await symlink(externalDirectory, sessionDirectory, "dir");
      const externalSize = (await stat(join(externalDirectory, "session.sqlite3"))).size;

      const restarted = new SessionStoreManager({ homeDirectory });
      managers.push(restarted);
      await restarted.ready();
      expect(restarted.catalogRepairStatus()).toMatchObject({ triggered: false, reason: "none" });
      const session = await restarted.openSession(created.session.sessionId);
      await expect(session.getManifest()).rejects.toMatchObject({ code: "storage.corrupt" });
      expect((await lstat(sessionDirectory)).isSymbolicLink()).toBe(true);
      expect((await stat(join(externalDirectory, "session.sqlite3"))).size).toBe(externalSize);
    },
  );

  it(
    "retains repair intent and canonical files after an operational discovery failure",
    async () => {
      const homeDirectory = await temporaryHome();
      const original = new SessionStoreManager({
        homeDirectory,
        ids: {
          sessionId: () => "ses_operationalDiscovery",
          eventId: () => "evt_operationalDiscoveryCreated",
        },
      });
      managers.push(original);
      const created = await original.createSession(
        createCommand("cmd_operationalDiscovery", "Operational discovery"),
      );
      await original.close();
      managers.splice(managers.indexOf(original), 1);
      const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
      for (const suffix of ["", "-wal", "-shm"]) {
        await rm(join(homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
      }
      await chmod(databasePath, 0);

      const blocked = new SessionStoreManager({ homeDirectory });
      managers.push(blocked);
      await expect(blocked.ready()).rejects.toMatchObject({ code: "storage.busy" });
      expect((await stat(databasePath)).isFile()).toBe(true);
      await expect(blocked.catalog.getSession(created.session.sessionId)).resolves.toBeNull();
      await blocked.close().catch(() => undefined);
      managers.splice(managers.indexOf(blocked), 1);

      await chmod(databasePath, 0o600);
      const retried = new SessionStoreManager({ homeDirectory });
      managers.push(retried);
      await retried.ready();
      await expect(retried.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
        status: "ready",
      });
    },
  );

  it("bounds database-derived discovery data before parsing or isolation", async () => {
    const homeDirectory = await temporaryHome();
    const original = new SessionStoreManager({
      homeDirectory,
      ids: {
        sessionId: () => "ses_oversizedDiscovery",
        eventId: () => "evt_oversizedDiscoveryCreated",
      },
    });
    managers.push(original);
    const created = await original.createSession(
      createCommand("cmd_oversizedDiscovery", "x".repeat(999_000)),
    );
    await original.close();
    managers.splice(managers.indexOf(original), 1);
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const repairing = new SessionStoreManager({ homeDirectory });
    managers.push(repairing);
    await expect(repairing.ready()).rejects.toMatchObject({ code: "storage.busy" });
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    expect((await stat(databasePath)).isFile()).toBe(true);
    await expect(repairing.catalog.getSession(created.session.sessionId)).resolves.toBeNull();
  });

  it("isolates an oversized session database without retaining installation repair", async () => {
    const homeDirectory = await temporaryHome();
    const original = new SessionStoreManager({
      homeDirectory,
      ids: {
        sessionId: () => "ses_oversizedDatabase",
        eventId: () => "evt_oversizedDatabaseCreated",
      },
    });
    managers.push(original);
    const created = await original.createSession(
      createCommand("cmd_oversizedDatabase", "Oversized database"),
    );
    await original.close();
    managers.splice(managers.indexOf(original), 1);
    const databasePath = resolveStoragePath(homeDirectory, created.session.dbRelativePath);
    await truncate(databasePath, 256 * 1_024 * 1_024 + 1);
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const repairing = new SessionStoreManager({ homeDirectory });
    managers.push(repairing);
    await repairing.ready();
    expect(repairing.catalogRepairStatus()).toMatchObject({
      triggered: true,
      repaired: 0,
      quarantined: 0,
    });
    await expect(repairing.catalog.getSession(created.session.sessionId)).resolves.toMatchObject({
      status: "unavailable",
      title: "Oversized recovered session",
      dbRelativePath: created.session.dbRelativePath,
    });
    expect((await stat(databasePath)).size).toBe(256 * 1_024 * 1_024 + 1);
    await expect(repairing.catalog.getStartupState()).resolves.toMatchObject({
      repairReason: null,
    });
  });

  it("bounds discovery work even when every session-directory entry is invalid", async () => {
    const homeDirectory = await temporaryHome();
    const prefixDirectory = join(homeDirectory, "sessions", "aa");
    await mkdir(prefixDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        mkdir(join(prefixDirectory, `invalid-${String(index).padStart(3, "0")}`)),
      ),
    );
    const storage = new SessionStoreManager({
      homeDirectory,
      catalogRepair: "force",
      sessionDiscoveryLimit: 1,
      sessionWorkers: { size: 1 },
    });
    managers.push(storage);

    await expect(storage.ready()).rejects.toMatchObject({ code: "storage.resource_limit" });
  });

  it("fails an affected RPC on worker crash and reopens the session on its replacement", async () => {
    let replacements = 0;
    const storage = await manager({
      sessionWorkers: {
        size: 1,
        maxOpenHandlesPerWorker: 2,
        allowTestOperations: true,
        onWorkerReplacement: () => {
          replacements += 1;
        },
      },
    });
    const created = await storage.createSession(createCommand());

    await expect(
      storage.sessions.malformedResponseForTest(created.session.sessionId),
    ).rejects.toMatchObject({ code: "storage.worker_failed" });
    await expect((await storage.openSession(created.session.sessionId)).getHeadSequence()).resolves.toBe(1);
    expect(replacements).toBe(1);

    await expect(
      storage.sessions.malformedResultForTest(created.session.sessionId),
    ).rejects.toMatchObject({ code: "storage.worker_failed" });
    await vi.waitFor(() => {
      expect(replacements).toBe(2);
    });
    await expect((await storage.openSession(created.session.sessionId)).getHeadSequence()).resolves.toBe(1);

    await expect(storage.sessions.crashWorkerForTest(created.session.sessionId)).rejects.toMatchObject({
      code: "storage.worker_failed",
    });
    expect(replacements).toBe(3);
    await expect((await storage.openSession(created.session.sessionId)).getHeadSequence()).resolves.toBe(1);
  });

});
