import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { hashCommandContent } from "@wi/protocol";
import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
} from "@wi/storage";

const [homeDirectory, sessionId, mode] = process.argv.slice(2);
if (homeDirectory === undefined || sessionId === undefined || mode === undefined) process.exit(64);

const storage = new SessionStoreManager({
  homeDirectory,
  sessionWorkers: {
    size: 1,
    maxOpenHandlesPerWorker: 2,
    allowTestOperations: true,
  },
  ...(mode === "after_session_commit_before_catalog"
    ? { catalogProjectionWriter: async () => process.exit(82) }
    : {}),
});

if (mode === "corrupt_incomplete_creation") {
  await storage.ready();
  const command = {
    v: 1,
    kind: "command",
    commandId: "cmd_processCorruptCreate",
    method: "session.create",
    params: { title: "Corrupt incomplete" },
  };
  await storage.catalog.reserveGlobalCommand({
    commandId: command.commandId,
    payloadHash: await hashCommandContent(command),
    reservedSessionId: sessionId,
    reservedEventId: "evt_processCorruptCreate",
    request: { title: command.params.title, projectId: null },
    updatedAtMs: 1_000,
  });
  await storage.close();
  const databasePath = resolveStoragePath(
    homeDirectory,
    sessionDatabaseRelativePath(sessionId),
  );
  await mkdir(dirname(databasePath), { recursive: true });
  await writeFile(databasePath, "not a sqlite database");
  process.exit(86);
}

if (
  mode === "after_session_create_commit_before_catalog" ||
  mode === "after_session_schema_before_manifest"
) {
  await storage.ready();
  const command = {
    v: 1,
    kind: "command",
    commandId: "cmd_processIncompleteCreate",
    method: "session.create",
    params: { title: "Incomplete creation" },
  };
  const payloadHash = await hashCommandContent(command);
  await storage.catalog.reserveGlobalCommand({
    commandId: command.commandId,
    payloadHash,
    reservedSessionId: sessionId,
    reservedEventId: "evt_processIncompleteCreate",
    request: { title: command.params.title, projectId: null },
    updatedAtMs: 1_000,
  });
  const relativePath = sessionDatabaseRelativePath(sessionId);
  const databasePath = resolveStoragePath(homeDirectory, relativePath);
  if (mode === "after_session_schema_before_manifest") {
    await storage.sessions.initializeSchemaOnlyForTest(sessionId, databasePath);
    process.exit(85);
  }
  await storage.sessions.initialize(
    {
      sessionId,
      projectId: null,
      title: command.params.title,
      createdAtMs: 1_000,
      eventId: "evt_processIncompleteCreate",
    },
    databasePath,
  );
  process.exit(84);
}

const eventSuffix = mode.replaceAll("_", "");
const input = {
  events: [
    {
      eventId: `evt_${eventSuffix}`,
      eventType: "run.created",
      createdAtMs: 2_000,
      data: { eventVersion: 1, runId: `run_${eventSuffix}` },
    },
  ],
  projections: [
    {
      kind: "run.put",
      runId: `run_${eventSuffix}`,
      state: "created",
      providerId: "fake",
      providerConfig: { scenario: "plain-text" },
      createdAtMs: 2_000,
      startedAtMs: null,
      completedAtMs: null,
      cancelledAtMs: null,
      failureCategory: null,
      failureMessage: null,
      activeProviderStepId: null,
    },
  ],
};

try {
  const session = await storage.openSession(sessionId);
  if (mode === "failpoint_gate_probe") {
    try {
      await session.appendTransaction({ ...input, testFailpoint: "crash_before_commit" });
      process.exit(87);
    } catch (error) {
      const stored = await session.getEventById(input.events[0].eventId);
      process.exit(error?.code === "storage.worker_failed" && stored === null ? 0 : 88);
    }
  }
  if (mode === "after_session_commit_before_catalog") {
    await session.appendTransaction(input);
    await storage.drainCatalogObservations();
    process.exit(67);
  }
  if (mode === "before_commit") {
    await session.appendTransaction({ ...input, testFailpoint: "crash_before_commit" });
  } else if (mode === "after_commit_before_publication") {
    await session.appendTransaction({ ...input, testFailpoint: "crash_after_commit" });
  } else {
    process.exit(65);
  }
  process.exit(66);
} catch {
  process.exit(mode === "before_commit" ? 80 : 83);
}
