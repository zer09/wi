import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
} from "@wi/storage";

const fixture = fileURLToPath(new URL("./storage-crash-fixture.mjs", import.meta.url));
const homes: string[] = [];
const managers: SessionStoreManager[] = [];

async function createHomeAndSession(): Promise<{
  homeDirectory: string;
  sessionId: string;
}> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
  homes.push(homeDirectory);
  const storage = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: {
      sessionId: () => "ses_processA",
      eventId: () => "evt_processCreated",
    },
    sessionWorkers: { size: 1, allowTestOperations: true },
  });
  const created = await storage.createSession({
    v: 1,
    kind: "command",
    commandId: "cmd_processCreate",
    method: "session.create",
    params: { title: "Process recovery" },
  });
  await storage.close();
  return { homeDirectory, sessionId: created.session.sessionId };
}

function runCrashFixture(
  homeDirectory: string,
  sessionId: string,
  mode: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, homeDirectory, sessionId, mode], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stderr.trim().length > 0) reject(new Error(stderr));
      else resolve(code);
    });
  });
}

function restart(homeDirectory: string): SessionStoreManager {
  const storage = new SessionStoreManager({
    homeDirectory,
    sessionWorkers: { size: 1, allowTestOperations: true },
  });
  managers.push(storage);
  return storage;
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((storage) => storage.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("storage crash windows", () => {
  it("completes session creation committed before catalog readiness during startup", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(
      runCrashFixture(
        homeDirectory,
        "ses_processIncomplete",
        "after_session_create_commit_before_catalog",
      ),
    ).resolves.toBe(84);

    const storage = restart(homeDirectory);
    await storage.ready();
    await expect(storage.catalog.getGlobalCommand("cmd_processIncompleteCreate")).resolves.toMatchObject({
      state: "accepted",
      reservedSessionId: "ses_processIncomplete",
    });
    await expect(storage.catalog.getSession("ses_processIncomplete")).resolves.toMatchObject({
      lastEventSequence: 1,
      title: "Incomplete creation",
    });
  });

  it("finishes initialization when schema creation committed without a manifest", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(
      runCrashFixture(
        homeDirectory,
        "ses_processSchemaOnly",
        "after_session_schema_before_manifest",
      ),
    ).resolves.toBe(85);

    const storage = restart(homeDirectory);
    await storage.ready();
    await expect(storage.catalog.getGlobalCommand("cmd_processIncompleteCreate")).resolves.toMatchObject({
      state: "accepted",
      reservedSessionId: "ses_processSchemaOnly",
    });
    await expect((await storage.openSession("ses_processSchemaOnly")).getManifest()).resolves.toMatchObject({
      title: "Incomplete creation",
      lastEventSequence: 1,
    });
  });

  it("does not recreate a missing session database and marks its catalog row missing", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    await rm(databasePath, { force: true });

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    await expect(session.getManifest()).rejects.toMatchObject({
      code: "storage.session_missing",
    });
    await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "missing",
    });
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines a corrupt session database without blocking the catalog", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    await writeFile(databasePath, "not a sqlite database");

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    await expect(session.getManifest()).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(storage.catalog.listSessions()).resolves.toHaveLength(1);
  });

  it("rolls back an event when the session worker exits before commit", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(runCrashFixture(homeDirectory, sessionId, "before_commit")).resolves.toBe(80);

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    await expect(session.getHeadSequence()).resolves.toBe(1);
    await expect(session.getEventsAfter(1)).resolves.toEqual([]);
  });

  it("keeps a committed event when the process exits before catalog update and repairs catalog", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(
      runCrashFixture(homeDirectory, sessionId, "after_session_commit_before_catalog"),
    ).resolves.toBe(82);

    const storage = restart(homeDirectory);
    expect((await storage.catalog.getSession(sessionId))?.lastEventSequence).toBe(1);
    const session = await storage.openSession(sessionId);
    await expect(session.getHeadSequence()).resolves.toBe(2);
    await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      updatedAtMs: 2_000,
    });
  });

  it("replays an event committed before the worker exits without returning it for publication", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(
      runCrashFixture(homeDirectory, sessionId, "after_commit_before_publication"),
    ).resolves.toBe(83);

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    const replay = await session.getEventsAfter(1);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      sequence: 2,
      eventType: "run.created",
      eventId: "evt_aftercommitbeforepublication",
    });
  });
});
