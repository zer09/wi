import {
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface CatalogFileIdentity {
  readonly suffix: "" | "-wal" | "-shm";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function catalogFileIdentity(
  databasePath: string,
  suffix: CatalogFileIdentity["suffix"],
): CatalogFileIdentity | null {
  try {
    const identity = lstatSync(`${databasePath}${suffix}`, { bigint: true });
    if (!identity.isFile()) {
      throw new StorageError("storage.corrupt", "Catalog storage is not a regular file");
    }
    return {
      suffix,
      dev: identity.dev,
      ino: identity.ino,
      size: identity.size,
      mtimeNs: identity.mtimeNs,
      ctimeNs: identity.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function catalogFileIdentities(databasePath: string): readonly CatalogFileIdentity[] {
  return (["", "-wal", "-shm"] as const).flatMap((suffix) => {
    const identity = catalogFileIdentity(databasePath, suffix);
    return identity === null ? [] : [identity];
  });
}

function sameCatalogFileIdentities(
  first: readonly CatalogFileIdentity[],
  second: readonly CatalogFileIdentity[],
): boolean {
  return first.length === second.length && first.every((expected, index) => {
    const actual = second[index];
    return actual !== undefined &&
      expected.suffix === actual.suffix &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino &&
      expected.size === actual.size &&
      expected.mtimeNs === actual.mtimeNs &&
      expected.ctimeNs === actual.ctimeNs;
  });
}

function validateCatalogCopy(databasePath: string): void {
  const before = catalogFileIdentities(databasePath);
  if (!before.some(({ suffix }) => suffix === "")) {
    if (before.length > 0) {
      throw new StorageError(
        "storage.corrupt",
        "Catalog sidecars exist without the catalog database",
      );
    }
    return;
  }

  const probeDirectory = mkdtempSync(join(tmpdir(), "wi-catalog-probe-"));
  const probePath = join(probeDirectory, "catalog.sqlite3");
  let probeDatabase: Database.Database | null = null;
  try {
    for (const { suffix } of before) {
      copyFileSync(
        `${databasePath}${suffix}`,
        `${probePath}${suffix}`,
        constants.COPYFILE_EXCL,
      );
    }
    if (!sameCatalogFileIdentities(before, catalogFileIdentities(databasePath))) {
      throw new StorageError("storage.busy", "Catalog storage changed during validation", true);
    }
    probeDatabase = openWorkerDatabase(probePath, { fileMustExist: true });
    const integrity = probeDatabase.pragma("quick_check") as readonly Record<string, unknown>[];
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new StorageError("storage.corrupt", "Catalog integrity check failed");
    }
    new CatalogRepository(probeDatabase);
    if (!sameCatalogFileIdentities(before, catalogFileIdentities(databasePath))) {
      throw new StorageError("storage.busy", "Catalog storage changed during validation", true);
    }
  } finally {
    try {
      probeDatabase?.close();
    } finally {
      rmSync(probeDirectory, { recursive: true, force: true });
    }
  }
}

function openCatalog(): void {
  try {
    validateCatalogCopy(config.databasePath);
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

function repairCatalog(): never {
  if (!config.allowRepair) {
    throw new StorageError("storage.worker_failed", "Catalog repair mode is disabled");
  }
  database?.close();
  database = null;
  repository = null;
  // Node has no cross-platform handle-relative, no-follow, no-overwrite move.
  // Preserve the catalog and sidecars rather than mutate a substituted pathname.
  throw new StorageError(
    "storage.corrupt",
    "Catalog is corrupt and was preserved in place",
    false,
  );
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
