import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import type Database from "better-sqlite3";
import { z } from "zod";

import { openWorkerDatabase } from "../common/sqlite.js";
import {
  assertWorkerPayloadBounds,
  StorageError,
  toStorageError,
  WorkerRequestSchema,
  workerError,
  type WorkerResponse,
} from "../common/worker-rpc.js";
import { SessionRepository } from "./repository.js";

const WorkerDataSchema = z.strictObject({
  workerId: z.string().min(1),
  maxOpenHandles: z.number().int().positive().safe(),
  allowTestOperations: z.boolean(),
});
const SessionPayloadSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    databasePath: z.string().min(1),
  })
  .passthrough();

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface OpenSession {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly database: Database.Database;
  readonly repository: SessionRepository;
}

const config = WorkerDataSchema.parse(workerData);
if (parentPort === null) throw new Error("Session worker requires a parent port");
const port = parentPort;
const sessions = new Map<string, OpenSession>();

function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session === undefined) return;
  session.database.close();
  sessions.delete(sessionId);
}

function fileIdentity(path: string): FileIdentity | null {
  try {
    const stats = statSync(path);
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return null;
    const message = error instanceof Error ? error.message : "Session database stat failed";
    throw new StorageError("storage.corrupt", message);
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function repositoryFor(
  payload: z.infer<typeof SessionPayloadSchema>,
  allowCreate: boolean,
): SessionRepository {
  const existing = sessions.get(payload.sessionId);
  if (existing !== undefined) {
    if (existing.path !== payload.databasePath) {
      throw new StorageError("storage.corrupt", "Session database path changed within a worker");
    }
    const currentIdentity = fileIdentity(existing.path);
    if (currentIdentity === null) {
      closeSession(payload.sessionId);
      throw new StorageError("storage.session_missing", "Session database file is missing");
    }
    if (!sameFileIdentity(existing.identity, currentIdentity)) {
      closeSession(payload.sessionId);
      throw new StorageError("storage.corrupt", "Session database file was replaced while open");
    }
    sessions.delete(payload.sessionId);
    sessions.set(payload.sessionId, existing);
    return existing.repository;
  }

  while (sessions.size >= config.maxOpenHandles) {
    const oldestSessionId = sessions.keys().next().value as string | undefined;
    if (oldestSessionId === undefined) break;
    closeSession(oldestSessionId);
  }

  const identityBeforeOpen = fileIdentity(payload.databasePath);
  if (!allowCreate && identityBeforeOpen === null) {
    throw new StorageError("storage.session_missing", "Session database file is missing");
  }

  let database: Database.Database;
  try {
    database = openWorkerDatabase(payload.databasePath, { fileMustExist: !allowCreate });
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (!allowCreate && code === "SQLITE_CANTOPEN") {
      throw new StorageError("storage.session_missing", "Session database file is missing");
    }
    throw toStorageError(error, "storage.corrupt", "Session database open failed");
  }
  let repository: SessionRepository;
  try {
    repository = new SessionRepository(database, config.allowTestOperations);
  } catch (error) {
    database.close();
    throw toStorageError(error, "storage.migration_failed", "Session migration failed");
  }
  const identityAfterOpen = fileIdentity(payload.databasePath);
  if (identityAfterOpen === null) {
    database.close();
    throw new StorageError("storage.session_missing", "Session database file disappeared while opening");
  }
  if (identityBeforeOpen !== null && !sameFileIdentity(identityBeforeOpen, identityAfterOpen)) {
    database.close();
    throw new StorageError("storage.corrupt", "Session database file changed while opening");
  }
  sessions.set(payload.sessionId, {
    path: payload.databasePath,
    identity: identityAfterOpen,
    database,
    repository,
  });
  return repository;
}

function execute(operation: string, payloadValue: unknown): unknown {
  if (operation === "worker.close") {
    for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
    return null;
  }
  if (operation === "session.getStats") {
    return { openSessionIds: [...sessions.keys()] };
  }

  const payload = SessionPayloadSchema.parse(payloadValue);
  if (operation.startsWith("session.test") && !config.allowTestOperations) {
    throw new StorageError("storage.worker_failed", "Test operations are disabled");
  }
  if (operation === "session.close") {
    closeSession(payload.sessionId);
    return null;
  }

  const repository = repositoryFor(
    payload,
    operation === "session.initialize" || operation === "session.testInitializeSchemaOnly",
  );
  if (
    operation !== "session.initialize" &&
    operation !== "session.testInitializeSchemaOnly"
  ) {
    const manifest = repository.getManifest();
    if (manifest.sessionId !== payload.sessionId) {
      closeSession(payload.sessionId);
      throw new StorageError(
        "storage.corrupt",
        `Session manifest ${manifest.sessionId} does not match requested ${payload.sessionId}`,
      );
    }
  }

  switch (operation) {
    case "session.initialize":
      mkdirSync(join(dirname(payload.databasePath), "artifacts"), { recursive: true });
      return repository.initialize({
        sessionId: payload.sessionId,
        projectId: payload.projectId,
        title: payload.title,
        createdAtMs: payload.createdAtMs,
        eventId: payload.eventId,
      });
    case "session.getManifest":
      return repository.getManifest();
    case "session.acceptCommand":
      return repository.acceptCommand(payload.input);
    case "session.appendTransaction":
      return repository.appendTransaction(payload.input);
    case "session.getEventsAfter":
      return repository.getEventsAfter(
        z.number().int().nonnegative().safe().parse(payload.afterSequence),
        payload.throughSequence === undefined
          ? undefined
          : z.number().int().nonnegative().safe().parse(payload.throughSequence),
      );
    case "session.getHeadSequence":
      return repository.getHeadSequence();
    case "session.getEventById":
      return repository.getEventById(z.string().min(1).parse(payload.eventId));
    case "session.getRun":
      return repository.getRun(z.string().min(1).parse(payload.runId));
    case "session.getAcceptedCommand":
      return repository.getAcceptedCommand(z.string().min(1).parse(payload.commandId));
    case "session.getProviderStep":
      return repository.getProviderStep(z.string().min(1).parse(payload.stepId));
    case "session.getNonterminalRuns":
      return repository.getNonterminalRuns();
    case "session.getCatalogProjection":
      return repository.getCatalogProjection();
    case "session.getCatalogObservation":
      return repository.getCatalogObservation();
    case "session.getPendingApprovals":
      return repository.getPendingApprovals();
    case "session.getPendingInputs":
      return repository.getPendingInputs();
    case "session.getPendingInputCount":
      return repository.getPendingInputCount();
    case "session.recover":
      return repository.recover();
    case "session.testInitializeSchemaOnly":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      return null;
    case "session.testBarrier": {
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      const barrier = z.instanceof(SharedArrayBuffer).parse(payload.barrier);
      const view = new Int32Array(barrier);
      Atomics.add(view, 0, 1);
      Atomics.notify(view, 0);
      while (Atomics.load(view, 1) === 0) Atomics.wait(view, 1, 0, 1_000);
      return null;
    }
    case "session.testGetProjectionIdentity":
      return repository.testGetProjectionIdentity(
        z
          .enum([
            "run",
            "message",
            "messagePart",
            "providerStep",
            "toolExecution",
            "approval",
            "input",
          ])
          .parse(payload.kind),
        z.string().min(1).parse(payload.id),
      );
    case "session.testGetPragmas":
      return repository.testGetPragmas();
    case "session.testMalformedResponse":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      return null;
    case "session.testMalformedResult":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      return { invalid: true };
    case "session.testCorruptManifest":
      repository.testCorruptManifest();
      return null;
    case "session.testMutateEvent":
      repository.testMutateEvent(
        z.enum(["update", "delete"]).parse(payload.action),
        z.number().int().positive().safe().parse(payload.sequence),
      );
      return null;
    case "session.testCrashWorker":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      process.exit(73);
      return null;
    default:
      throw new StorageError("storage.worker_failed", `Unknown session operation ${operation}`);
  }
}

port.on("message", (message: unknown) => {
  const parsed = WorkerRequestSchema.safeParse(message);
  if (!parsed.success) return;
  if (parsed.data.operation === "session.testMalformedResponse" && config.allowTestOperations) {
    port.postMessage({ invalid: true });
    return;
  }

  let response: WorkerResponse;
  try {
    response = {
      v: 1,
      requestId: parsed.data.requestId,
      workerId: config.workerId,
      ok: true,
      result: execute(parsed.data.operation, parsed.data.payload),
    };
  } catch (error) {
    response = {
      v: 1,
      requestId: parsed.data.requestId,
      workerId: config.workerId,
      ok: false,
      error: workerError(error),
    };
  }
  try {
    assertWorkerPayloadBounds(response, { maxNodes: 40_000, maxUnits: 2_000_000 });
  } catch (error) {
    response = {
      v: 1,
      requestId: parsed.data.requestId,
      workerId: config.workerId,
      ok: false,
      error: workerError(error),
    };
  }
  port.postMessage(response);
});
