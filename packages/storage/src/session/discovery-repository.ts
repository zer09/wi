import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import Database from "better-sqlite3";

import { canonicalJson } from "@wi/protocol";

import {
  CreationProvenanceSchema,
  SESSION_EVENT_PAGE_BOUNDS,
  SESSION_SCHEMA_VERSION,
  SessionCatalogObservationSchema,
  SessionManifestSchema,
  type CreationProvenance,
  type SessionCatalogObservation,
  type SessionManifest,
} from "../types.js";
import { StorageError, toStorageError } from "../common/worker-rpc.js";

const MAX_CANONICAL_EVENT_BYTES = SESSION_EVENT_PAGE_BOUNDS.maximumSingleEventBytes;
const MAX_PROVENANCE_RESULT_BYTES = 16 * 1024;
const MAX_PENDING_ROWS = 10_000;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

function requireByteBudget(value: unknown, maximum: number, description: string): void {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    throw new StorageError("storage.resource_limit", `${description} exceeds its discovery byte budget`, true);
  }
}

function pendingCount(database: Database.Database, table: "approvals" | "pending_inputs"): number {
  // LIMIT avoids an unbounded COUNT scan on a hostile retained database while
  // still preserving every count representable by the catalog contract.
  const rows = database.prepare(
    `SELECT 1 AS present FROM ${table} WHERE state = 'pending' LIMIT ${MAX_PENDING_ROWS + 1}`,
  ).all() as readonly { present: number }[];
  if (rows.length > MAX_PENDING_ROWS) {
    throw new StorageError("storage.resource_limit", `${table} pending-row budget was exceeded`, true);
  }
  return rows.length;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validCreationPayloadHashes(manifest: SessionManifest): ReadonlySet<string> {
  const requiredParams = manifest.projectId === null ? {} : { projectId: manifest.projectId };
  const params = manifest.title === ""
    ? [requiredParams, { ...requiredParams, title: "" }]
    : [{ ...requiredParams, title: manifest.title }];
  return new Set(params.map((value) => canonicalHash({ method: "session.create", params: value })));
}

function validateCreationProvenance(
  database: Database.Database,
  manifest: SessionManifest,
  provenance: CreationProvenance,
): void {
  const createdMetadata = database.prepare(
    `SELECT event_id AS eventId, event_type AS eventType, created_at_ms AS createdAtMs,
            length(CAST(payload_json AS BLOB)) AS payloadBytes
     FROM events WHERE sequence = 1`,
  ).get() as Record<string, unknown> | undefined;
  if (createdMetadata === undefined) {
    throw new StorageError("storage.corrupt", "Canonical session creation event is missing");
  }
  requireByteBudget(createdMetadata.payloadBytes, MAX_CANONICAL_EVENT_BYTES, "Session creation payload");
  const createdPayload = (database.prepare(
    "SELECT payload_json AS payloadJson FROM events WHERE sequence = 1",
  ).get() as { payloadJson: string }).payloadJson;
  const expectedPayload = {
    eventVersion: 1,
    title: manifest.title,
    ...(manifest.projectId === null ? {} : { projectId: manifest.projectId }),
  };
  if (
    createdMetadata.eventType !== "session.created" ||
    createdMetadata.eventId !== provenance.eventId ||
    createdMetadata.createdAtMs !== manifest.createdAtMs ||
    provenance.acceptedAtMs !== manifest.createdAtMs ||
    canonicalJson(JSON.parse(createdPayload) as unknown) !== canonicalJson(expectedPayload)
  ) {
    throw new StorageError("storage.corrupt", "Creation provenance conflicts with canonical session data");
  }
  if (provenance.result.sessionId !== manifest.sessionId) {
    throw new StorageError("storage.corrupt", "Creation provenance result identifies another session");
  }
  if (!validCreationPayloadHashes(manifest).has(provenance.payloadHash)) {
    throw new StorageError("storage.corrupt", "Creation provenance payload hash is invalid");
  }
}

export interface ReadonlyDiscovery {
  readonly manifest: SessionManifest;
  readonly observation: SessionCatalogObservation;
  readonly creationProvenance: CreationProvenance | null;
}

export class OversizedSessionDatabaseError extends StorageError {
  constructor(readonly databaseBytes: number) {
    super("storage.resource_limit", "Session database exceeds the discovery size limit");
    this.name = "OversizedSessionDatabaseError";
  }
}

export class UnsupportedSessionSchemaError extends StorageError {
  constructor(readonly schemaVersion: number) {
    super("storage.migration_failed", "Session discovery schema is newer than this Wi version");
    this.name = "UnsupportedSessionSchemaError";
  }
}

/** Reads only retained schemas; this deliberately never creates WAL/SHM files or migrates. */
export function discoverSessionDatabase(databasePath: string): ReadonlyDiscovery {
  let database: Database.Database | null = null;
  try {
    const databaseBytes = statSync(databasePath).size;
    if (!Number.isSafeInteger(databaseBytes) || databaseBytes > MAX_DATABASE_BYTES) {
      throw new OversizedSessionDatabaseError(databaseBytes);
    }
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    database.pragma("busy_timeout = 5000");
    const schemaVersion = database.pragma("user_version", { simple: true }) as number;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      throw new StorageError("storage.corrupt", "Session discovery schema version is invalid");
    }
    if (schemaVersion > SESSION_SCHEMA_VERSION) {
      throw new UnsupportedSessionSchemaError(schemaVersion);
    }
    const manifestMetadata = database.prepare(
      `SELECT session_id AS sessionId, project_id AS projectId, created_at_ms AS createdAtMs,
              schema_version AS schemaVersion, format_version AS formatVersion,
              length(CAST(title AS BLOB)) AS titleBytes,
              last_event_sequence AS lastEventSequence
       FROM manifest WHERE singleton = 1`,
    ).get() as Record<string, unknown> | undefined;
    if (manifestMetadata === undefined) {
      throw new StorageError("storage.corrupt", "Discovered manifest is missing");
    }
    const { titleBytes: _titleBytes, ...manifestFields } = manifestMetadata;
    requireByteBudget(_titleBytes, MAX_CANONICAL_EVENT_BYTES, "Manifest title");
    const manifest = SessionManifestSchema.parse({
      ...manifestFields,
      title: (database.prepare("SELECT title FROM manifest WHERE singleton = 1").get() as { title: unknown }).title,
    });
    const head = (database.prepare("SELECT COALESCE(MAX(sequence), 0) AS head FROM events").get() as { head: number }).head;
    if (head !== manifest.lastEventSequence) {
      throw new StorageError("storage.corrupt", "Discovered manifest head does not match its events");
    }
    const latestEvent = database.prepare(
      "SELECT created_at_ms AS createdAtMs FROM events ORDER BY sequence DESC LIMIT 1",
    ).get() as { createdAtMs: number } | undefined;
    const runEvent = database.prepare(
      `SELECT event_type AS eventType FROM events
       WHERE event_type IN (
         'run.created', 'run.started', 'run.waiting_for_user', 'run.cancel.requested',
         'run.cancelled', 'run.completed', 'run.failed', 'run.interrupted'
       )
       ORDER BY sequence DESC LIMIT 1`,
    ).get() as { eventType: string } | undefined;
    const runStates: Readonly<Record<string, SessionCatalogObservation["projection"]["lastRunState"]>> = {
      "run.created": "created",
      "run.started": "running",
      "run.waiting_for_user": "waiting_for_user",
      "run.cancel.requested": "cancelling",
      "run.cancelled": "cancelled",
      "run.completed": "completed",
      "run.failed": "failed",
      "run.interrupted": "interrupted",
    };
    const latestMessageMetadata = database.prepare(
      `SELECT sequence, length(CAST(payload_json AS BLOB)) AS payloadBytes
       FROM events WHERE event_type = 'user.message.appended' ORDER BY sequence DESC LIMIT 1`,
    ).get() as { sequence: number; payloadBytes: unknown } | undefined;
    let latestMessagePreview: string | null = null;
    if (latestMessageMetadata !== undefined) {
      requireByteBudget(
        latestMessageMetadata.payloadBytes,
        MAX_CANONICAL_EVENT_BYTES,
        "Latest message payload",
      );
      // JSON is deliberately never extracted by SQLite during discovery. The
      // bounded source is parsed only after its byte budget is established.
      const payload = (database.prepare(
        "SELECT payload_json AS payload FROM events WHERE sequence = ?",
      ).get(latestMessageMetadata.sequence) as { payload: string }).payload;
      const parsed = JSON.parse(payload) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("text" in parsed) ||
        typeof parsed.text !== "string"
      ) {
        throw new StorageError("storage.corrupt", "Latest user message payload is invalid");
      }
      latestMessagePreview = parsed.text.slice(0, 200);
    }
    const approvals = pendingCount(database, "approvals");
    const inputs = pendingCount(database, "pending_inputs");
    const recoveryNeeded = database.prepare(
      "SELECT 1 AS present FROM runs WHERE state IN ('created', 'queued', 'running', 'waiting_for_user', 'cancelling') LIMIT 1",
    ).get() !== undefined;
    let creationProvenance: CreationProvenance | null = null;
    if (schemaVersion >= 4) {
      const metadata = database.prepare(
        `SELECT command_id AS commandId, payload_hash AS payloadHash, command_method AS commandMethod,
                event_id AS eventId, length(CAST(result_json AS BLOB)) AS resultBytes,
                accepted_at_ms AS acceptedAtMs
         FROM creation_provenance WHERE singleton = 1`,
      ).get() as Record<string, unknown> | undefined;
      if (metadata !== undefined) {
        const { resultBytes, ...provenanceFields } = metadata;
        requireByteBudget(resultBytes, MAX_PROVENANCE_RESULT_BYTES, "Creation provenance result");
        const resultJson = (database.prepare("SELECT result_json AS resultJson FROM creation_provenance WHERE singleton = 1").get() as { resultJson: string }).resultJson;
        creationProvenance = CreationProvenanceSchema.parse({
          ...provenanceFields,
          result: JSON.parse(resultJson),
        });
        validateCreationProvenance(database, manifest, creationProvenance);
      }
    }
    return {
      manifest,
      observation: SessionCatalogObservationSchema.parse({
        headSequence: head,
        projection: {
          updatedAtMs: latestEvent?.createdAtMs ?? manifest.createdAtMs,
          lastRunState: runEvent === undefined ? null : (runStates[runEvent.eventType] ?? null),
          lastMessagePreview: latestMessagePreview,
        },
        pendingApprovalCount: approvals,
        pendingInputCount: inputs,
        recoveryNeeded,
      }),
      creationProvenance,
    };
  } catch (error) {
    throw toStorageError(error, "storage.corrupt", "Read-only session discovery failed");
  } finally {
    database?.close();
  }
}
