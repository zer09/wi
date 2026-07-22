import type Database from "better-sqlite3";
import { z } from "zod";

import {
  BrowserSessionSummarySchema,
  canonicalJson,
  CommandIdSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  SessionIdSchema,
  type BrowserSessionSummary,
} from "@wi/protocol";

import { applyMigrations } from "../common/migrations.js";
import { StorageError } from "../common/worker-rpc.js";
import {
  CATALOG_SCHEMA_VERSION,
  GlobalCommandRecordSchema,
  HashSchema,
  SessionCreationRequestSchema,
  ProjectRecordSchema,
  SessionManifestSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  type GlobalCommandRecord,
  type GlobalCommandReservation,
  type ProjectRecord,
  type SessionManifest,
  type SessionSummary,
} from "../types.js";
import { catalogMigrations } from "./migrations.js";

export const MAXIMUM_BOUNDED_SESSION_LIST_LIMIT = 1_001;
export const MAXIMUM_CATALOG_REPAIR_PAGE_SIZE = 1_000;
const BOUNDED_SESSION_LIST_TEXT_CODE_POINTS = 256;

export const BoundedSessionListInputSchema = z.strictObject({
  limit: z.number().int().positive().max(MAXIMUM_BOUNDED_SESSION_LIST_LIMIT),
});

export const UnavailableReasonSchema = z.enum(["quarantined"]);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const CatalogRepairPageInputSchema = z.strictObject({
  afterSessionId: z.union([SessionIdSchema, z.null()]),
  limit: z.number().int().positive().max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
});
export const CatalogRepairPageSchema = z.strictObject({
  records: z.array(z.strictObject({
    sessionId: SessionIdSchema,
    status: SessionStatusSchema,
    unavailableReason: z.union([UnavailableReasonSchema, z.null()]),
  })).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
  nextCursor: z.union([SessionIdSchema, z.null()]),
});
export type CatalogRepairPage = z.infer<typeof CatalogRepairPageSchema>;

export const MarkSessionsMissingInputSchema = z.strictObject({
  sessions: z.array(z.strictObject({
    sessionId: SessionIdSchema,
    dbRelativePath: z.string().min(1),
  })).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
});

export const CatalogRepairReasonSchema = z.enum([
  "catalog_new",
  "catalog_corrupt",
  "explicit",
]);
export type CatalogRepairReason = z.infer<typeof CatalogRepairReasonSchema>;

export const ReserveGlobalCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  reservedSessionId: SessionIdSchema,
  reservedEventId: EventIdSchema,
  request: SessionCreationRequestSchema,
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const CompleteGlobalCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  result: z.unknown(),
  acceptedAtMs: z.number().int().nonnegative().safe(),
});

export const FailGlobalCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  session: SessionSummarySchema,
  failureCode: z.string().min(1),
  failureMessage: z.string(),
  diagnosticId: z.string().min(1),
  quarantinedRelativePath: z.union([z.string().min(1), z.null()]),
  failedAtMs: z.number().int().nonnegative().safe(),
});
export type FailGlobalCommandInput = z.infer<typeof FailGlobalCommandInputSchema>;

export const SetGlobalCommandQuarantineInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  diagnosticId: DiagnosticIdSchema,
  quarantinedRelativePath: z.string().min(1),
});
export type SetGlobalCommandQuarantineInput = z.infer<
  typeof SetGlobalCommandQuarantineInputSchema
>;

export const CreateSessionIndexInputSchema = SessionSummarySchema.extend({
  unavailableReason: z.union([UnavailableReasonSchema, z.null()]).default(null),
}).superRefine((input, context) => {
  if (input.status !== "unavailable" && input.unavailableReason !== null) {
    context.addIssue({
      code: "custom",
      path: ["unavailableReason"],
      message: "Only an unavailable session can retain unavailable provenance",
    });
  }
});
export type CreateSessionIndexInput = z.input<typeof CreateSessionIndexInputSchema>;

export const UpdateSessionProjectionInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  updatedAtMs: z.number().int().nonnegative().safe(),
  lastEventSequence: z.number().int().nonnegative().safe(),
  lastRunState: SessionSummarySchema.shape.lastRunState,
  lastMessagePreview: SessionSummarySchema.shape.lastMessagePreview,
  requiresAttention: z.boolean(),
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  recoveryNeeded: z.boolean().default(false),
});
export type UpdateSessionProjectionInput = z.input<typeof UpdateSessionProjectionInputSchema>;

export const CatalogProjectionUpdateResultSchema = z.strictObject({
  summary: SessionSummarySchema,
  outcome: z.enum(["applied", "idempotent", "stale"]),
});
export type CatalogProjectionUpdateResult = z.infer<typeof CatalogProjectionUpdateResultSchema>;

export const MarkSessionStatusInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  status: SessionStatusSchema.exclude(["ready"]),
});
export type MarkSessionStatusInput = z.infer<typeof MarkSessionStatusInputSchema>;

export const RepairSessionClassificationInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  dbRelativePath: z.string().min(1),
  status: SessionStatusSchema.exclude(["ready"]),
  sessionSchemaVersion: z.number().int().positive().safe().nullable(),
  unavailableReason: z.union([UnavailableReasonSchema, z.null()]),
}).superRefine((input, context) => {
  if (input.status !== "unavailable" && input.unavailableReason !== null) {
    context.addIssue({
      code: "custom",
      path: ["unavailableReason"],
      message: "Only an unavailable session can retain unavailable provenance",
    });
  }
});
export type RepairSessionClassificationInput = z.infer<
  typeof RepairSessionClassificationInputSchema
>;

export const ReconcileSessionInputSchema = z.strictObject({
  manifest: SessionManifestSchema,
  dbRelativePath: z.string().min(1),
  expectedCatalogSequence: z.union([z.number().int().nonnegative().safe(), z.null()]),
  expectedCatalogStatus: z.union([SessionSummarySchema.shape.status, z.null()]),
  updatedAtMs: z.number().int().nonnegative().safe(),
  lastRunState: SessionSummarySchema.shape.lastRunState,
  lastMessagePreview: SessionSummarySchema.shape.lastMessagePreview,
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  recoveryNeeded: z.boolean().default(false),
});

export const ReconcileSessionResultSchema = z.strictObject({
  summary: SessionSummarySchema,
  applied: z.boolean(),
});
export type ReconcileSessionResult = z.infer<typeof ReconcileSessionResultSchema>;

function decodeCatalogValue<T>(description: string, decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new StorageError("storage.corrupt", `Stored ${description} is invalid`);
  }
}

interface GlobalCommandRow {
  commandId: string;
  commandMethod: "session.create";
  payloadHash: string;
  state: "creating" | "accepted" | "failed";
  reservedSessionId: string;
  reservedEventId: string;
  requestJson: string;
  resultJson: string | null;
  acceptedAtMs: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  diagnosticId: string | null;
  quarantinedRelativePath: string | null;
  updatedAtMs: number;
}

function globalCommandFromRow(row: GlobalCommandRow): GlobalCommandRecord {
  return decodeCatalogValue(`global command ${row.commandId}`, () =>
    GlobalCommandRecordSchema.parse({
      commandId: row.commandId,
      commandMethod: row.commandMethod,
      payloadHash: row.payloadHash,
      state: row.state,
      reservedSessionId: row.reservedSessionId,
      reservedEventId: row.reservedEventId,
      request: JSON.parse(row.requestJson) as unknown,
      result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as unknown),
      acceptedAtMs: row.acceptedAtMs,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      diagnosticId: row.diagnosticId,
      quarantinedRelativePath: row.quarantinedRelativePath,
      updatedAtMs: row.updatedAtMs,
    }),
  );
}

function sessionFromRow(row: Record<string, unknown>): SessionSummary {
  return decodeCatalogValue("session summary", () =>
    SessionSummarySchema.parse({
      ...row,
      requiresAttention: row.requiresAttention === 1,
      recoveryCandidate: row.recoveryCandidate === 1,
    }),
  );
}

function browserSessionFromRow(row: Record<string, unknown>): BrowserSessionSummary {
  return decodeCatalogValue("browser session summary", () =>
    BrowserSessionSummarySchema.parse({
      ...row,
      requiresAttention: row.requiresAttention === 1,
    }),
  );
}

export class CatalogRepository {
  constructor(private readonly database: Database.Database) {
    applyMigrations(database, catalogMigrations, CATALOG_SCHEMA_VERSION, {
      onFreshDatabase: () => {
        database
          .prepare("INSERT INTO catalog_repair_state (singleton, reason) VALUES (1, 'catalog_new')")
          .run();
      },
    });
  }

  getRepairReason(): CatalogRepairReason | null {
    const row = this.database
      .prepare("SELECT reason FROM catalog_repair_state WHERE singleton = 1")
      .get() as { reason: unknown } | undefined;
    return row === undefined
      ? null
      : decodeCatalogValue("catalog repair state", () =>
          CatalogRepairReasonSchema.parse(row.reason),
        );
  }

  beginRepair(reasonValue: unknown): CatalogRepairReason {
    const reason = CatalogRepairReasonSchema.parse(reasonValue);
    this.database
      .prepare(
        `INSERT INTO catalog_repair_state (singleton, reason) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET reason = excluded.reason`,
      )
      .run(reason);
    return reason;
  }

  completeRepair(): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM catalog_repair_state WHERE singleton = 1").run();
      this.database
        .prepare("INSERT INTO catalog_meta (key, value) VALUES ('repair_completed', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
        .run();
    })();
  }

  hasCompletedRepair(): boolean {
    return this.database
      .prepare("SELECT 1 AS present FROM catalog_meta WHERE key = 'repair_completed'")
      .get() !== undefined;
  }

  createProject(project: ProjectRecord): ProjectRecord {
    const input = ProjectRecordSchema.parse(project);
    this.database
      .prepare(
        `INSERT INTO projects (
          project_id, name, root_path, root_realpath, created_at_ms, updated_at_ms, config_json
        ) VALUES (
          @projectId, @name, @rootPath, @rootRealpath, @createdAtMs, @updatedAtMs, @configJson
        ) ON CONFLICT(project_id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          root_realpath = excluded.root_realpath,
          updated_at_ms = excluded.updated_at_ms,
          config_json = excluded.config_json`,
      )
      .run({ ...input, configJson: canonicalJson(input.config) });
    return input;
  }

  reserveGlobalCommand(inputValue: unknown): GlobalCommandReservation {
    const input = ReserveGlobalCommandInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing !== null) {
        if (existing.payloadHash !== input.payloadHash || existing.commandMethod !== "session.create") {
          throw new StorageError(
            "protocol.command_id_conflict",
            `Command ${input.commandId} was reused with different content`,
          );
        }
        return { command: existing, duplicate: true };
      }

      this.database
        .prepare(
          `INSERT INTO catalog_commands (
            command_id, command_method, payload_hash, state, reserved_session_id,
            reserved_event_id, request_json, updated_at_ms
          ) VALUES (
            @commandId, 'session.create', @payloadHash, 'creating', @reservedSessionId,
            @reservedEventId, @requestJson, @updatedAtMs
          )`,
        )
        .run({ ...input, requestJson: canonicalJson(input.request) });
      const created = this.getGlobalCommand(input.commandId);
      if (created === null) throw new Error("Reserved global command disappeared");
      return { command: created, duplicate: false };
    })();
  }

  completeGlobalCommand(inputValue: unknown): GlobalCommandRecord {
    const input = CompleteGlobalCommandInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing === null) throw new StorageError("session.not_found", "Global command reservation not found");
      if (existing.payloadHash !== input.payloadHash) {
        throw new StorageError(
          "protocol.command_id_conflict",
          `Command ${input.commandId} was reused with different content`,
        );
      }
      if (existing.state === "accepted") {
        // Recovery provenance is canonical.  A duplicate completion must agree
        // with every immutable accepted field instead of silently preserving a
        // contradictory catalog result.
        if (
          existing.commandMethod !== "session.create" ||
          canonicalJson(existing.result) !== canonicalJson(input.result) ||
          existing.acceptedAtMs !== input.acceptedAtMs
        ) {
          throw new StorageError(
            "storage.corrupt",
            `Accepted global command ${input.commandId} conflicts with canonical provenance`,
          );
        }
        return existing;
      }
      if (existing.state === "failed") {
        throw new StorageError(
          "session.invalid_transition",
          `Global command ${input.commandId} already failed`,
        );
      }

      this.database
        .prepare(
          `UPDATE catalog_commands
           SET state = 'accepted', result_json = @resultJson,
               accepted_at_ms = @acceptedAtMs, updated_at_ms = @acceptedAtMs
           WHERE command_id = @commandId`,
        )
        .run({
          commandId: input.commandId,
          resultJson: canonicalJson(input.result),
          acceptedAtMs: input.acceptedAtMs,
        });
      const completed = this.getGlobalCommand(input.commandId);
      if (completed === null) throw new Error("Completed global command disappeared");
      return completed;
    })();
  }

  failGlobalCommand(inputValue: unknown): GlobalCommandRecord {
    const input = FailGlobalCommandInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing === null) {
        throw new StorageError("session.not_found", "Global command reservation not found");
      }
      if (existing.payloadHash !== input.payloadHash) {
        throw new StorageError(
          "protocol.command_id_conflict",
          `Command ${input.commandId} was reused with different content`,
        );
      }
      if (existing.state === "accepted") {
        throw new StorageError("session.invalid_transition", "Accepted session creation cannot fail");
      }
      if (existing.state === "failed") return existing;

      this.createSessionIndex({
        ...input.session,
        unavailableReason: input.quarantinedRelativePath === null ? null : "quarantined",
      });
      const result = {
        sessionId: input.session.sessionId,
        failed: true,
        code: input.failureCode,
        message: input.failureMessage,
        diagnosticId: input.diagnosticId,
      };
      this.database
        .prepare(
          `UPDATE catalog_commands SET
             state = 'failed', result_json = @resultJson, failure_code = @failureCode,
             failure_message = @failureMessage, diagnostic_id = @diagnosticId,
             quarantined_relative_path = @quarantinedRelativePath,
             updated_at_ms = @failedAtMs
           WHERE command_id = @commandId AND state = 'creating'`,
        )
        .run({ ...input, resultJson: canonicalJson(result) });
      const failed = this.getGlobalCommand(input.commandId);
      if (failed === null) throw new Error("Failed global command disappeared");
      return failed;
    })();
  }

  setGlobalCommandQuarantine(inputValue: unknown): GlobalCommandRecord {
    const input = SetGlobalCommandQuarantineInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing === null) {
        throw new StorageError("session.not_found", "Global command reservation not found");
      }
      if (existing.state !== "failed" || existing.diagnosticId !== input.diagnosticId) {
        throw new StorageError(
          "session.invalid_transition",
          "Only the matching failed session creation can record quarantine",
        );
      }
      if (
        existing.quarantinedRelativePath !== null &&
        existing.quarantinedRelativePath !== input.quarantinedRelativePath
      ) {
        throw new StorageError(
          "session.invalid_transition",
          "Failed session creation already recorded a different quarantine path",
        );
      }
      if (existing.quarantinedRelativePath === null) {
        this.database
          .prepare(
            `UPDATE catalog_commands SET quarantined_relative_path = @quarantinedRelativePath
             WHERE command_id = @commandId AND state = 'failed' AND diagnostic_id = @diagnosticId
               AND quarantined_relative_path IS NULL`,
          )
          .run(input);
      }
      this.database
        .prepare(
          `UPDATE sessions SET unavailable_reason = 'quarantined'
           WHERE session_id = ? AND status = 'unavailable'`,
        )
        .run(existing.reservedSessionId);
      const updated = this.getGlobalCommand(input.commandId);
      if (updated === null) throw new Error("Failed global command disappeared");
      return updated;
    })();
  }

  listCreatingGlobalCommands(): readonly GlobalCommandRecord[] {
    const rows = this.database
      .prepare(
        `SELECT command_id AS commandId, command_method AS commandMethod,
                payload_hash AS payloadHash, state, reserved_session_id AS reservedSessionId,
                reserved_event_id AS reservedEventId, request_json AS requestJson,
                result_json AS resultJson, accepted_at_ms AS acceptedAtMs,
                failure_code AS failureCode, failure_message AS failureMessage,
                diagnostic_id AS diagnosticId,
                quarantined_relative_path AS quarantinedRelativePath,
                updated_at_ms AS updatedAtMs
         FROM catalog_commands WHERE state = 'creating' ORDER BY updated_at_ms, command_id`,
      )
      .all() as GlobalCommandRow[];
    return rows.map(globalCommandFromRow);
  }

  getGlobalCommand(commandId: string): GlobalCommandRecord | null {
    const row = this.database
      .prepare(
        `SELECT command_id AS commandId, command_method AS commandMethod,
                payload_hash AS payloadHash, state, reserved_session_id AS reservedSessionId,
                reserved_event_id AS reservedEventId, request_json AS requestJson,
                result_json AS resultJson, accepted_at_ms AS acceptedAtMs,
                failure_code AS failureCode, failure_message AS failureMessage,
                diagnostic_id AS diagnosticId,
                quarantined_relative_path AS quarantinedRelativePath,
                updated_at_ms AS updatedAtMs
         FROM catalog_commands WHERE command_id = ?`,
      )
      .get(commandId) as GlobalCommandRow | undefined;
    return row === undefined ? null : globalCommandFromRow(row);
  }

  createSessionIndex(
    inputValue: unknown,
    options: {
      readonly allowPathRepair?: boolean;
      readonly allowReadyPromotion?: boolean;
    } = {},
  ): SessionSummary {
    const input = CreateSessionIndexInputSchema.parse(inputValue);
    this.database.transaction(() => {
      const existing = this.getSession(input.sessionId);
      if (
        options.allowPathRepair !== true &&
        existing !== null &&
        existing.dbRelativePath !== input.dbRelativePath
      ) {
        throw new StorageError("storage.corrupt", "Session path changed for an existing session");
      }
      if (
        options.allowReadyPromotion !== true &&
        existing !== null &&
        existing.status !== "ready" &&
        input.status === "ready"
      ) {
        throw new StorageError(
          "storage.corrupt",
          "Only validated repair can restore a non-ready session",
        );
      }
      this.database
        .prepare(
          `INSERT INTO sessions (
             session_id, project_id, db_relative_path, title, status, created_at_ms, updated_at_ms,
             last_event_sequence, last_run_state, last_message_preview, requires_attention,
             pending_approval_count, pending_input_count, session_schema_version, recovery_candidate,
             unavailable_reason
           ) VALUES (
             @sessionId, @projectId, @dbRelativePath, @title, @status, @createdAtMs, @updatedAtMs,
             @lastEventSequence, @lastRunState, @lastMessagePreview, @requiresAttention,
             @pendingApprovalCount, @pendingInputCount, @sessionSchemaVersion, @recoveryCandidate,
             @unavailableReason
           ) ON CONFLICT(session_id) DO UPDATE SET
             project_id = excluded.project_id,
             db_relative_path = excluded.db_relative_path,
             title = excluded.title,
             status = excluded.status,
             created_at_ms = excluded.created_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             last_event_sequence = excluded.last_event_sequence,
             last_run_state = excluded.last_run_state,
             last_message_preview = excluded.last_message_preview,
             requires_attention = excluded.requires_attention,
             pending_approval_count = excluded.pending_approval_count,
             pending_input_count = excluded.pending_input_count,
             session_schema_version = excluded.session_schema_version,
             unavailable_reason = excluded.unavailable_reason,
             recovery_candidate = CASE
               WHEN sessions.recovery_candidate = 1 AND excluded.recovery_candidate = 0 THEN 0
               WHEN excluded.recovery_candidate = 1 THEN 1
               ELSE sessions.recovery_candidate
             END`,
        )
        .run({
          ...input,
          requiresAttention: input.requiresAttention ? 1 : 0,
          recoveryCandidate: input.recoveryCandidate ? 1 : 0,
        });
    })();
    const created = this.getSession(input.sessionId);
    if (created === null) throw new Error("Session index disappeared");
    return created;
  }

  countSessions(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw new StorageError("storage.corrupt", "Catalog session count is invalid");
    }
    return row.count;
  }

  listSessions(): readonly SessionSummary[] {
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId,
                db_relative_path AS dbRelativePath, title, status,
                created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
                last_event_sequence AS lastEventSequence, last_run_state AS lastRunState,
                last_message_preview AS lastMessagePreview, requires_attention AS requiresAttention,
                pending_approval_count AS pendingApprovalCount,
                pending_input_count AS pendingInputCount,
                session_schema_version AS sessionSchemaVersion,
                recovery_candidate AS recoveryCandidate
         FROM sessions ORDER BY updated_at_ms DESC, session_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(sessionFromRow);
  }

  listCatalogRepairPage(inputValue: unknown): CatalogRepairPage {
    const input = CatalogRepairPageInputSchema.parse(inputValue);
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId, status,
                unavailable_reason AS unavailableReason
         FROM sessions
         WHERE @afterSessionId IS NULL OR session_id > @afterSessionId
         ORDER BY session_id
         LIMIT @rowLimit`,
      )
      .all({
        afterSessionId: input.afterSessionId,
        rowLimit: input.limit + 1,
      }) as Record<string, unknown>[];
    const hasMore = rows.length > input.limit;
    const records = CatalogRepairPageSchema.shape.records.parse(rows.slice(0, input.limit));
    return {
      records,
      nextCursor: hasMore ? (records.at(-1)?.sessionId ?? null) : null,
    };
  }

  markSessionsMissing(inputValue: unknown): readonly string[] {
    const input = MarkSessionsMissingInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const updated: string[] = [];
      const statement = this.database.prepare(
        `UPDATE sessions SET
           db_relative_path = @dbRelativePath,
           status = 'missing',
           unavailable_reason = NULL,
           recovery_candidate = 0
         WHERE session_id = @sessionId
           AND (status <> 'unavailable' OR unavailable_reason IS NULL)`,
      );
      for (const session of input.sessions) {
        if (statement.run(session).changes === 1) updated.push(session.sessionId);
      }
      return updated;
    })();
  }

  listBrowserSessionsBounded(inputValue: unknown): readonly BrowserSessionSummary[] {
    const input = BoundedSessionListInputSchema.parse(inputValue);
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId,
                substr(title, 1, ${BOUNDED_SESSION_LIST_TEXT_CODE_POINTS}) AS title, status,
                created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
                last_event_sequence AS lastEventSequence, last_run_state AS lastRunState,
                substr(last_message_preview, 1, ${BOUNDED_SESSION_LIST_TEXT_CODE_POINTS})
                  AS lastMessagePreview,
                requires_attention AS requiresAttention,
                pending_approval_count AS pendingApprovalCount,
                pending_input_count AS pendingInputCount
         FROM sessions
         WHERE status <> 'missing'
         ORDER BY updated_at_ms DESC, session_id
         LIMIT @limit`,
      )
      .all(input) as Record<string, unknown>[];
    return rows.map(browserSessionFromRow);
  }

  getSession(sessionId: string): SessionSummary | null {
    const row = this.database
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId,
                db_relative_path AS dbRelativePath, title, status,
                created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
                last_event_sequence AS lastEventSequence, last_run_state AS lastRunState,
                last_message_preview AS lastMessagePreview, requires_attention AS requiresAttention,
                pending_approval_count AS pendingApprovalCount,
                pending_input_count AS pendingInputCount,
                session_schema_version AS sessionSchemaVersion,
                recovery_candidate AS recoveryCandidate
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : sessionFromRow(row);
  }

  updateSessionProjection(inputValue: unknown): CatalogProjectionUpdateResult {
    const input = UpdateSessionProjectionInputSchema.parse(inputValue);
    const existing = this.getSession(input.sessionId);
    if (existing === null) throw new StorageError("session.not_found", "Session index not found");
    if (input.lastEventSequence < existing.lastEventSequence) {
      return { summary: existing, outcome: "stale" };
    }
    if (input.lastEventSequence === existing.lastEventSequence) {
      const identical =
        input.updatedAtMs === existing.updatedAtMs &&
        input.lastRunState === existing.lastRunState &&
        input.lastMessagePreview === existing.lastMessagePreview &&
        input.requiresAttention === existing.requiresAttention &&
        input.pendingApprovalCount === existing.pendingApprovalCount &&
        input.pendingInputCount === existing.pendingInputCount;
      if (!identical) {
        throw new StorageError(
          "storage.catalog_projection_conflict",
          `Catalog projection ${input.sessionId} conflicts at head ${input.lastEventSequence}`,
        );
      }
      return { summary: existing, outcome: "idempotent" };
    }

    const result = this.database
      .prepare(
        `UPDATE sessions SET
           updated_at_ms = @updatedAtMs,
           last_event_sequence = @lastEventSequence,
           last_run_state = @lastRunState,
           last_message_preview = @lastMessagePreview,
           requires_attention = @requiresAttention,
           pending_approval_count = @pendingApprovalCount,
           pending_input_count = @pendingInputCount,
           recovery_candidate = CASE WHEN @recoveryNeeded = 0 THEN 0 ELSE 1 END
         WHERE session_id = @sessionId AND last_event_sequence < @lastEventSequence`,
      )
      .run({
        ...input,
        requiresAttention: input.requiresAttention ? 1 : 0,
        recoveryNeeded: input.recoveryNeeded ? 1 : 0,
      });
    if (result.changes !== 1) {
      throw new StorageError("storage.catalog_projection_conflict", "Catalog projection lost its head CAS");
    }
    const updated = this.getSession(input.sessionId);
    if (updated === null) throw new Error("Updated session index disappeared");
    return { summary: updated, outcome: "applied" };
  }

  listRecoveryCandidates(inputValue: unknown = {}): {
    readonly sessionIds: readonly string[];
    readonly nextCursor: { readonly updatedAtMs: number; readonly sessionId: string } | null;
  } {
    const input = z
      .strictObject({
        afterUpdatedAtMs: z.number().int().nonnegative().safe().nullable().default(null),
        afterSessionId: SessionIdSchema.nullable().default(null),
        limit: z.number().int().positive().max(1_000).default(1_000),
      })
      .parse(inputValue);
    if ((input.afterUpdatedAtMs === null) !== (input.afterSessionId === null)) {
      throw new StorageError("storage.corrupt", "Recovery candidate cursor is incomplete");
    }
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId, updated_at_ms AS updatedAtMs FROM sessions
         WHERE status = 'ready' AND recovery_candidate = 1
           AND (
             @afterUpdatedAtMs IS NULL
             OR updated_at_ms > @afterUpdatedAtMs
             OR (updated_at_ms = @afterUpdatedAtMs AND session_id > @afterSessionId)
           )
         ORDER BY updated_at_ms, session_id LIMIT @limit`,
      )
      .all(input) as readonly { sessionId: string; updatedAtMs: number }[];
    const last = rows.at(-1);
    return {
      sessionIds: rows.map((row) => SessionIdSchema.parse(row.sessionId)),
      nextCursor: last === undefined ? null : { updatedAtMs: last.updatedAtMs, sessionId: SessionIdSchema.parse(last.sessionId) },
    };
  }

  markRecoveryCandidate(sessionIdValue: unknown): void {
    const sessionId = SessionIdSchema.parse(sessionIdValue);
    const result = this.database
      .prepare("UPDATE sessions SET recovery_candidate = 1 WHERE session_id = ?")
      .run(sessionId);
    if (result.changes !== 1) throw new StorageError("session.not_found", "Session index not found");
  }

  markSessionStatus(inputValue: unknown): SessionSummary {
    const input = MarkSessionStatusInputSchema.parse(inputValue);
    const result = this.database
      .prepare(
        `UPDATE sessions SET status = @status, unavailable_reason = NULL
         WHERE session_id = @sessionId`,
      )
      .run(input);
    if (result.changes !== 1) throw new StorageError("session.not_found", "Session index not found");
    const updated = this.getSession(input.sessionId);
    if (updated === null) throw new Error("Updated session index disappeared");
    return updated;
  }

  repairSessionClassification(inputValue: unknown): SessionSummary {
    const input = RepairSessionClassificationInputSchema.parse(inputValue);
    const result = this.database
      .prepare(
        `UPDATE sessions SET
           db_relative_path = @dbRelativePath,
           status = @status,
           session_schema_version = COALESCE(@sessionSchemaVersion, session_schema_version),
           unavailable_reason = @unavailableReason,
           recovery_candidate = 0
         WHERE session_id = @sessionId`,
      )
      .run(input);
    if (result.changes !== 1) throw new StorageError("session.not_found", "Session index not found");
    const updated = this.getSession(input.sessionId);
    if (updated === null) throw new Error("Repaired session index disappeared");
    return updated;
  }

  reconcileSession(inputValue: unknown): ReconcileSessionResult {
    return this.reconcileSessionInternal(inputValue, "generic");
  }

  reconcileCreationSession(inputValue: unknown): ReconcileSessionResult {
    return this.reconcileSessionInternal(inputValue, "creation");
  }

  reconcileValidatedRepairSession(inputValue: unknown): ReconcileSessionResult {
    return this.reconcileSessionInternal(inputValue, "validated-repair");
  }

  private reconcileSessionInternal(
    inputValue: unknown,
    mode: "generic" | "creation" | "validated-repair",
  ): ReconcileSessionResult {
    const input = ReconcileSessionInputSchema.parse(inputValue);
    const manifest: SessionManifest = input.manifest;
    const existing = this.getSession(manifest.sessionId);
    const validatedRepair = mode === "validated-repair";
    if (!validatedRepair) {
      if (existing === null && mode !== "creation") {
        throw new StorageError(
          "storage.corrupt",
          "Generic reconciliation requires an existing ready session",
        );
      }
      if (existing !== null && existing.status !== "ready") {
        return { summary: existing, applied: false };
      }
      if (
        input.expectedCatalogStatus !== "ready" &&
        !(mode === "creation" && existing === null && input.expectedCatalogStatus === null)
      ) {
        if (existing === null) {
          throw new StorageError(
            "storage.corrupt",
            "Creation reconciliation received an invalid catalog status",
          );
        }
        return { summary: existing, applied: false };
      }
    }
    if (existing !== null) {
      const statusChangedDuringInspection = existing.status !== input.expectedCatalogStatus;
      const newerProjectionWon =
        existing.lastEventSequence !== input.expectedCatalogSequence &&
        existing.lastEventSequence > manifest.lastEventSequence;
      if (statusChangedDuringInspection || newerProjectionWon) {
        return { summary: existing, applied: false };
      }
    }

    const summary = this.createSessionIndex({
      sessionId: manifest.sessionId,
      projectId: manifest.projectId,
      dbRelativePath: input.dbRelativePath,
      title: manifest.title,
      status: "ready",
      createdAtMs: manifest.createdAtMs,
      updatedAtMs: input.updatedAtMs,
      lastEventSequence: manifest.lastEventSequence,
      lastRunState: input.lastRunState,
      lastMessagePreview: input.lastMessagePreview,
      requiresAttention: input.pendingApprovalCount > 0 || input.pendingInputCount > 0,
      pendingApprovalCount: input.pendingApprovalCount,
      pendingInputCount: input.pendingInputCount,
      sessionSchemaVersion: manifest.schemaVersion,
      // Only an observation of canonical terminal/no-active state clears a candidate.
      recoveryCandidate: input.recoveryNeeded,
    }, {
      allowPathRepair: true,
      allowReadyPromotion: validatedRepair,
    });
    return { summary, applied: true };
  }
}
