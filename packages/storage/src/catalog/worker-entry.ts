import { existsSync, renameSync } from "node:fs";
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
import { ProjectRecordSchema } from "../types.js";
import { CatalogRepairReasonSchema, CatalogRepository } from "./repository.js";

const WorkerDataSchema = z.strictObject({
  workerId: z.string().min(1),
  databasePath: z.string().min(1),
  allowRepair: z.boolean(),
});

const config = WorkerDataSchema.parse(workerData);
if (parentPort === null) throw new Error("Catalog worker requires a parent port");
const port = parentPort;

let database: Database.Database | null = null;
let repository: CatalogRepository | null = null;
let startupError: StorageError | null = null;

function openCatalog(): void {
  try {
    database = openWorkerDatabase(config.databasePath);
    repository = new CatalogRepository(database);
    startupError = null;
  } catch (error) {
    database?.close();
    database = null;
    repository = null;
    startupError = toStorageError(error, "storage.migration_failed", "Catalog migration failed");
  }
}

function repairCatalog(): { quarantinedPath: string | null } {
  if (!config.allowRepair) {
    throw new StorageError("storage.worker_failed", "Catalog repair mode is disabled");
  }
  database?.close();
  database = null;
  repository = null;
  const quarantinedPath = existsSync(config.databasePath)
    ? `${config.databasePath}.quarantine-${Date.now()}-${process.pid}`
    : null;
  if (quarantinedPath !== null) {
    renameSync(config.databasePath, quarantinedPath);
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${config.databasePath}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${quarantinedPath}${suffix}`);
    }
  }
  openCatalog();
  if (startupError !== null) throw startupError;
  // The replacement database was initialized with catalog_new in the same
  // migration transaction. Classify it before returning control to the manager.
  const repairedRepository = repository as CatalogRepository | null;
  if (repairedRepository === null) {
    throw new StorageError("storage.worker_failed", "Catalog repository is unavailable");
  }
  repairedRepository.beginRepair("catalog_corrupt");
  return { quarantinedPath };
}

openCatalog();

function execute(operation: string, payload: unknown): unknown {
  if (operation === "worker.close") {
    database?.close();
    return null;
  }
  if (operation === "catalog.repair") return repairCatalog();
  if (startupError !== null) throw startupError;
  if (repository === null) {
    throw new StorageError("storage.worker_failed", "Catalog repository is unavailable");
  }

  switch (operation) {
    case "catalog.getStartupState":
      return {
        created: false,
        repairReason: repository.getRepairReason(),
        hasCompletedRepair: repository.hasCompletedRepair(),
      };
    case "catalog.beginRepair": {
      const input = z.strictObject({ reason: CatalogRepairReasonSchema }).parse(payload);
      return repository.beginRepair(input.reason);
    }
    case "catalog.completeRepair":
      repository.completeRepair();
      return null;
    case "catalog.createProject":
      return repository.createProject(ProjectRecordSchema.parse(payload));
    case "catalog.reserveGlobalCommand":
      return repository.reserveGlobalCommand(payload);
    case "catalog.completeGlobalCommand":
      return repository.completeGlobalCommand(payload);
    case "catalog.failGlobalCommand":
      return repository.failGlobalCommand(payload);
    case "catalog.setGlobalCommandQuarantine":
      return repository.setGlobalCommandQuarantine(payload);
    case "catalog.getGlobalCommand": {
      const input = z.strictObject({ commandId: z.string().min(1) }).parse(payload);
      return repository.getGlobalCommand(input.commandId);
    }
    case "catalog.listCreatingGlobalCommands":
      return repository.listCreatingGlobalCommands();
    case "catalog.createSessionIndex":
      return repository.createSessionIndex(payload);
    case "catalog.countSessions":
      return repository.countSessions();
    case "catalog.listSessions":
      return repository.listSessions();
    case "catalog.listCatalogRepairPage":
      return repository.listCatalogRepairPage(payload);
    case "catalog.markSessionsMissing":
      return repository.markSessionsMissing(payload);
    case "catalog.listBrowserSessionsBounded":
      return repository.listBrowserSessionsBounded(payload);
    case "catalog.getSession": {
      const input = z.strictObject({ sessionId: z.string().min(1) }).parse(payload);
      return repository.getSession(input.sessionId);
    }
    case "catalog.updateSessionProjection":
      return repository.updateSessionProjection(payload);
    case "catalog.markSessionStatus":
      return repository.markSessionStatus(payload);
    case "catalog.repairSessionClassification":
      return repository.repairSessionClassification(payload);
    case "catalog.listRecoveryCandidates":
      return repository.listRecoveryCandidates(payload);
    case "catalog.markRecoveryCandidate": {
      const input = z.strictObject({ sessionId: z.string().min(1) }).parse(payload);
      repository.markRecoveryCandidate(input.sessionId);
      return null;
    }
    case "catalog.reconcileSession":
      return repository.reconcileSession(payload);
    default:
      throw new StorageError("storage.worker_failed", `Unknown catalog operation ${operation}`);
  }
}

port.on("message", (message: unknown) => {
  const parsed = WorkerRequestSchema.safeParse(message);
  if (!parsed.success) return;

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
