import type Database from "better-sqlite3";
import { z } from "zod";

import {
  canonicalJson,
  CanonicalJsonValueSchema,
  CommandIdSchema,
  SessionEventSchema,
  SessionIdSchema,
  type SessionEvent,
} from "@wi/protocol";

import { applyMigrations } from "../common/migrations.js";
import { StorageError } from "../common/worker-rpc.js";
import {
  AcceptCommandInputSchema,
  AcceptedCommandResultSchema,
  AppendTransactionInputSchema,
  PendingApprovalRecordSchema,
  PendingInputRecordSchema,
  ProviderStepRecordSchema,
  RunRecordSchema,
  ProjectionMutationSchema,
  SESSION_FORMAT_VERSION,
  SESSION_SCHEMA_VERSION,
  SessionCatalogObservationSchema,
  SessionCatalogProjectionSchema,
  SessionManifestSchema,
  SessionRecoveryResultSchema,
  type AcceptCommandInput,
  type AcceptedCommandResult,
  type AppendTransactionInput,
  type PendingApprovalRecord,
  type PendingInputRecord,
  type ProviderStepRecord,
  type RunRecord,
  type SessionCatalogObservation,
  type SessionCatalogProjection,
  type SessionManifest,
  type SessionRecoveryResult,
} from "../types.js";
import { sessionMigrations } from "./migrations.js";
import { applyProjection } from "./projections.js";

export const InitializeSessionInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  projectId: z.string().nullable(),
  title: z.string(),
  createdAtMs: z.number().int().nonnegative().safe(),
  eventId: z.string().min(1),
});

interface EventRow {
  sequence: number;
  eventId: string;
  eventType: string;
  createdAtMs: number;
  payloadJson: string;
}

interface AcceptedCommandRow {
  commandId: string;
  commandMethod: string;
  payloadHash: string;
  acceptedSequence: number | null;
  runId: string | null;
  resultJson: string;
  acceptedAtMs: number;
}

function runIdFromData(data: unknown): string | null {
  if (data === null || typeof data !== "object" || !("runId" in data)) return null;
  const runId = (data as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : null;
}

function decodeStoredValue<T>(description: string, decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new StorageError("storage.corrupt", `Stored ${description} is invalid`);
  }
}

export class SessionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly allowTestOperations: boolean,
  ) {
    applyMigrations(database, sessionMigrations, SESSION_SCHEMA_VERSION);
  }

  initialize(inputValue: unknown): { manifest: SessionManifest; events: readonly SessionEvent[] } {
    const input = InitializeSessionInputSchema.parse(inputValue);
    const existing = this.getManifestOrNull();
    if (existing !== null) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.projectId !== input.projectId ||
        existing.title !== input.title ||
        existing.createdAtMs !== input.createdAtMs
      ) {
        throw new StorageError("storage.corrupt", "Session manifest identity does not match");
      }
      const events = this.getEventsAfter(0, 1);
      const created = events[0];
      if (
        created === undefined ||
        created.eventType !== "session.created" ||
        created.eventId !== input.eventId
      ) {
        throw new StorageError("storage.corrupt", "Session creation event identity does not match");
      }
      const createdProjectId = created.data.projectId ?? null;
      if (created.data.title !== input.title || createdProjectId !== input.projectId) {
        throw new StorageError("storage.corrupt", "Session creation event payload does not match");
      }
      return { manifest: existing, events };
    }

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO manifest (
             singleton, session_id, project_id, created_at_ms, schema_version,
             format_version, title, last_event_sequence
           ) VALUES (1, @sessionId, @projectId, @createdAtMs, @schemaVersion,
                     @formatVersion, @title, 0)`,
        )
        .run({
          ...input,
          schemaVersion: SESSION_SCHEMA_VERSION,
          formatVersion: SESSION_FORMAT_VERSION,
        });
      const data = {
        eventVersion: 1 as const,
        title: input.title,
        ...(input.projectId === null ? {} : { projectId: input.projectId }),
      };
      const events = this.appendRows([
        {
          eventId: input.eventId,
          eventType: "session.created",
          createdAtMs: input.createdAtMs,
          data,
        },
      ]);
      return events;
    });
    const events = transaction.immediate();
    return { manifest: this.getManifest(), events };
  }

  getManifest(): SessionManifest {
    const manifest = this.getManifestOrNull();
    if (manifest === null) {
      throw new StorageError("storage.session_uninitialized", "Session is not initialized");
    }
    return manifest;
  }

  private getManifestOrNull(): SessionManifest | null {
    const row = this.database
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId, created_at_ms AS createdAtMs,
                schema_version AS schemaVersion, format_version AS formatVersion,
                title, last_event_sequence AS lastEventSequence
         FROM manifest WHERE singleton = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row === undefined
      ? null
      : decodeStoredValue("session manifest", () => SessionManifestSchema.parse(row));
  }

  private appendRows(eventsInput: readonly unknown[]): readonly SessionEvent[] {
    const manifest = this.getManifest();
    let expectedSequence = manifest.lastEventSequence;
    const inserted: SessionEvent[] = [];
    const statement = this.database.prepare(
      `INSERT INTO events (
         event_id, event_type, event_version, created_at_ms, run_id, item_id, payload_json
       ) VALUES (@eventId, @eventType, @eventVersion, @createdAtMs, @runId, @itemId, @payloadJson)`,
    );

    for (const value of eventsInput) {
      const eventInput = z
        .strictObject({
          eventId: z.string().min(1),
          eventType: z.string().min(1),
          createdAtMs: z.number().int().nonnegative().safe(),
          data: z.unknown(),
          itemId: z.string().nullable().optional(),
        })
        .parse(value);
      const eventVersion =
        eventInput.data !== null &&
        typeof eventInput.data === "object" &&
        "eventVersion" in eventInput.data
          ? (eventInput.data as { eventVersion?: unknown }).eventVersion
          : undefined;
      if (eventVersion !== 1) throw new StorageError("protocol.invalid_message", "Event version must be 1");

      const result = statement.run({
        eventId: eventInput.eventId,
        eventType: eventInput.eventType,
        eventVersion,
        createdAtMs: eventInput.createdAtMs,
        runId: runIdFromData(eventInput.data),
        itemId: eventInput.itemId ?? null,
        payloadJson: canonicalJson(eventInput.data),
      });
      const sequence = Number(result.lastInsertRowid);
      expectedSequence += 1;
      if (sequence !== expectedSequence) {
        throw new StorageError("storage.corrupt", "Session event sequence is not contiguous");
      }
      inserted.push(
        SessionEventSchema.parse({
          v: 1,
          kind: "event",
          sessionId: manifest.sessionId,
          sequence,
          eventId: eventInput.eventId,
          eventType: eventInput.eventType,
          createdAtMs: eventInput.createdAtMs,
          data: eventInput.data,
        }),
      );
    }

    this.database
      .prepare("UPDATE manifest SET last_event_sequence = ? WHERE singleton = 1")
      .run(expectedSequence);
    return inserted;
  }

  private applyTransaction(input: AppendTransactionInput): {
    events: readonly SessionEvent[];
    headSequence: number;
  } {
    const events = this.appendRows(input.events);
    for (const mutation of input.projections ?? []) {
      applyProjection(this.database, ProjectionMutationSchema.parse(mutation));
    }
    const headSequence = events.at(-1)?.sequence ?? this.getManifest().lastEventSequence;
    return { events, headSequence };
  }

  appendTransaction(inputValue: unknown): {
    events: readonly SessionEvent[];
    headSequence: number;
  } {
    const input = AppendTransactionInputSchema.parse(inputValue);
    if (input.testFailpoint !== undefined && !this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Storage failpoints are disabled");
    }
    const transaction = this.database.transaction(() => {
      const result = this.applyTransaction(input);
      if (input.testFailpoint === "crash_before_commit") process.exit(71);
      return result;
    });
    const result = transaction.immediate();
    if (input.testFailpoint === "crash_after_commit") process.exit(72);
    return result;
  }

  acceptCommand(inputValue: unknown): AcceptedCommandResult {
    const input = AcceptCommandInputSchema.parse(inputValue);
    if (input.transaction.testFailpoint !== undefined && !this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Storage failpoints are disabled");
    }
    const transaction = this.database.transaction(() => {
      const existing = this.getAcceptedCommandRow(input.commandId);
      if (existing !== null) {
        if (
          existing.commandMethod !== input.commandMethod ||
          existing.payloadHash !== input.payloadHash
        ) {
          throw new StorageError(
            "protocol.command_id_conflict",
            `Command ${input.commandId} was reused with different content`,
          );
        }
        return this.acceptedResult(existing, true, []);
      }

      const append = this.applyTransaction(input.transaction);
      this.database
        .prepare(
          `INSERT INTO accepted_commands (
             command_id, command_method, payload_hash, accepted_sequence,
             run_id, result_json, accepted_at_ms
           ) VALUES (
             @commandId, @commandMethod, @payloadHash, @acceptedSequence,
             @runId, @resultJson, @acceptedAtMs
           )`,
        )
        .run({
          commandId: input.commandId,
          commandMethod: input.commandMethod,
          payloadHash: input.payloadHash,
          acceptedSequence: append.headSequence,
          runId: input.runId,
          resultJson: canonicalJson(input.result),
          acceptedAtMs: input.acceptedAtMs,
        });
      if (input.transaction.testFailpoint === "crash_before_commit") process.exit(71);
      const row = this.getAcceptedCommandRow(input.commandId);
      if (row === null) throw new Error("Accepted command disappeared");
      return this.acceptedResult(row, false, append.events);
    });
    const result = transaction.immediate();
    if (input.transaction.testFailpoint === "crash_after_commit") process.exit(72);
    return result;
  }

  private getAcceptedCommandRow(commandIdValue: string): AcceptedCommandRow | null {
    const commandId = CommandIdSchema.parse(commandIdValue);
    const row = this.database
      .prepare(
        `SELECT command_id AS commandId, command_method AS commandMethod,
                payload_hash AS payloadHash, accepted_sequence AS acceptedSequence,
                run_id AS runId, result_json AS resultJson, accepted_at_ms AS acceptedAtMs
         FROM accepted_commands WHERE command_id = ?`,
      )
      .get(commandId) as AcceptedCommandRow | undefined;
    return row ?? null;
  }

  getAcceptedCommand(commandIdValue: string): AcceptedCommandResult | null {
    const row = this.getAcceptedCommandRow(commandIdValue);
    return row === null ? null : this.acceptedResult(row, true, []);
  }

  private acceptedResult(
    row: AcceptedCommandRow,
    duplicate: boolean,
    events: readonly SessionEvent[],
  ): AcceptedCommandResult {
    return decodeStoredValue(`accepted command ${row.commandId}`, () =>
      AcceptedCommandResultSchema.parse({
        commandId: row.commandId,
        commandMethod: row.commandMethod as AcceptCommandInput["commandMethod"],
        payloadHash: row.payloadHash,
        acceptedSequence: row.acceptedSequence,
        runId: row.runId,
        result: CanonicalJsonValueSchema.parse(JSON.parse(row.resultJson) as unknown),
        acceptedAtMs: row.acceptedAtMs,
        duplicate,
        events: [...events],
      }),
    );
  }

  getEventsAfter(afterSequence: number, throughSequence?: number): readonly SessionEvent[] {
    const after = z.number().int().nonnegative().safe().parse(afterSequence);
    const through =
      throughSequence === undefined
        ? this.getManifest().lastEventSequence
        : z.number().int().nonnegative().safe().parse(throughSequence);
    const rows = this.database
      .prepare(
        `SELECT sequence, event_id AS eventId, event_type AS eventType,
                created_at_ms AS createdAtMs, payload_json AS payloadJson
         FROM events
         WHERE sequence > ? AND sequence <= ?
         ORDER BY sequence`,
      )
      .all(after, through) as EventRow[];
    const sessionId = this.getManifest().sessionId;
    return rows.map((row) =>
      decodeStoredValue(`session event ${row.sequence}`, () =>
        SessionEventSchema.parse({
          v: 1,
          kind: "event",
          sessionId,
          sequence: row.sequence,
          eventId: row.eventId,
          eventType: row.eventType,
          createdAtMs: row.createdAtMs,
          data: JSON.parse(row.payloadJson) as unknown,
        }),
      ),
    );
  }

  getHeadSequence(): number {
    return this.getManifest().lastEventSequence;
  }

  getEventById(eventId: string): SessionEvent | null {
    const row = this.database
      .prepare(
        `SELECT sequence, event_id AS eventId, event_type AS eventType,
                created_at_ms AS createdAtMs, payload_json AS payloadJson
         FROM events WHERE event_id = ?`,
      )
      .get(eventId) as EventRow | undefined;
    if (row === undefined) return null;
    const sessionId = this.getManifest().sessionId;
    return decodeStoredValue(`session event ${row.sequence}`, () =>
      SessionEventSchema.parse({
        v: 1,
        kind: "event",
        sessionId,
        sequence: row.sequence,
        eventId: row.eventId,
        eventType: row.eventType,
        createdAtMs: row.createdAtMs,
        data: JSON.parse(row.payloadJson) as unknown,
      }),
    );
  }

  getRun(runId: string): RunRecord | null {
    const row = this.database
      .prepare(
        `SELECT run_id AS runId, state, provider_id AS providerId,
                provider_config_json AS providerConfigJson, created_at_ms AS createdAtMs,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                cancelled_at_ms AS cancelledAtMs, failure_category AS failureCategory,
                failure_message AS failureMessage,
                active_provider_step_id AS activeProviderStepId
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as (Omit<RunRecord, "providerConfig"> & { providerConfigJson: string }) | undefined;
    if (row === undefined) return null;
    const { providerConfigJson, ...record } = row;
    return decodeStoredValue(`run ${runId}`, () =>
      RunRecordSchema.parse({
        ...record,
        providerConfig: CanonicalJsonValueSchema.parse(JSON.parse(providerConfigJson) as unknown),
      }),
    );
  }

  getProviderStep(stepId: string): ProviderStepRecord | null {
    const row = this.database
      .prepare(
        `SELECT step_id AS stepId, run_id AS runId, step_index AS stepIndex, state,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                response_id AS responseId, error_category AS errorCategory,
                error_message AS errorMessage
         FROM provider_steps WHERE step_id = ?`,
      )
      .get(stepId) as unknown;
    if (row === undefined) return null;
    return decodeStoredValue(`provider step ${stepId}`, () => ProviderStepRecordSchema.parse(row));
  }

  getNonterminalRuns(): readonly RunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT runs.run_id AS runId, runs.state,
                runs.provider_id AS providerId,
                runs.provider_config_json AS providerConfigJson,
                runs.created_at_ms AS createdAtMs,
                runs.started_at_ms AS startedAtMs,
                runs.completed_at_ms AS completedAtMs,
                runs.cancelled_at_ms AS cancelledAtMs,
                runs.failure_category AS failureCategory,
                runs.failure_message AS failureMessage,
                runs.active_provider_step_id AS activeProviderStepId
         FROM runs
         LEFT JOIN accepted_commands AS command
           ON command.run_id = runs.run_id AND command.command_method = 'message.submit'
         WHERE state NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
         ORDER BY command.accepted_sequence IS NULL, command.accepted_sequence,
                  runs.created_at_ms, runs.run_id`,
      )
      .all() as (Omit<RunRecord, "providerConfig"> & { providerConfigJson: string })[];
    return rows.map(({ providerConfigJson, ...record }) =>
      decodeStoredValue(`run ${record.runId}`, () =>
        RunRecordSchema.parse({
          ...record,
          providerConfig: CanonicalJsonValueSchema.parse(JSON.parse(providerConfigJson) as unknown),
        }),
      ),
    );
  }

  getCatalogProjection(): SessionCatalogProjection {
    const latestEvent = this.database
      .prepare("SELECT created_at_ms AS createdAtMs FROM events ORDER BY sequence DESC LIMIT 1")
      .get() as { createdAtMs: number } | undefined;
    const runEvent = this.database
      .prepare(
        `SELECT event_type AS eventType FROM events
         WHERE event_type IN (
           'run.created', 'run.started', 'run.waiting_for_user', 'run.cancel.requested',
           'run.cancelled', 'run.completed', 'run.failed', 'run.interrupted'
         )
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get() as { eventType: string } | undefined;
    const runStates: Readonly<Record<string, SessionCatalogProjection["lastRunState"]>> = {
      "run.created": "created",
      "run.started": "running",
      "run.waiting_for_user": "waiting_for_user",
      "run.cancel.requested": "cancelling",
      "run.cancelled": "cancelled",
      "run.completed": "completed",
      "run.failed": "failed",
      "run.interrupted": "interrupted",
    };
    const messageEvent = this.database
      .prepare(
        `SELECT payload_json AS payloadJson FROM events
         WHERE event_type = 'user.message.appended'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get() as { payloadJson: string } | undefined;
    const messageData =
      messageEvent === undefined
        ? null
        : decodeStoredValue("latest user message", () =>
            z
              .strictObject({ text: z.string() })
              .passthrough()
              .parse(JSON.parse(messageEvent.payloadJson) as unknown),
          );
    return decodeStoredValue("catalog projection", () =>
      SessionCatalogProjectionSchema.parse({
        updatedAtMs: latestEvent?.createdAtMs ?? this.getManifest().createdAtMs,
        lastRunState: runEvent === undefined ? null : (runStates[runEvent.eventType] ?? null),
        lastMessagePreview: messageData?.text.slice(0, 200) ?? null,
      }),
    );
  }

  getPendingApprovals(): readonly PendingApprovalRecord[] {
    const rows = this.database
      .prepare(
        `SELECT approval_id AS approvalId, run_id AS runId, call_id AS callId,
                state, action_digest AS actionDigest, requested_at_ms AS requestedAtMs
         FROM approvals WHERE state = 'pending' ORDER BY requested_at_ms, approval_id`,
      )
      .all() as unknown[];
    return rows.map((row) =>
      decodeStoredValue("pending approval", () => PendingApprovalRecordSchema.parse(row)),
    );
  }

  getPendingInputs(): readonly PendingInputRecord[] {
    const rows = this.database
      .prepare(
        `SELECT input_id AS inputId, run_id AS runId, state, prompt,
                requested_at_ms AS requestedAtMs
         FROM pending_inputs WHERE state = 'pending' ORDER BY requested_at_ms, input_id`,
      )
      .all() as unknown[];
    return rows.map((row) =>
      decodeStoredValue("pending input", () => PendingInputRecordSchema.parse(row)),
    );
  }

  getPendingInputCount(): number {
    return this.getPendingInputs().length;
  }

  getCatalogObservation(): SessionCatalogObservation {
    return SessionCatalogObservationSchema.parse({
      headSequence: this.getHeadSequence(),
      projection: this.getCatalogProjection(),
      pendingApprovalCount: this.getPendingApprovals().length,
      pendingInputCount: this.getPendingInputCount(),
    });
  }

  recover(): SessionRecoveryResult {
    const interruptedRunIds = (
      this.database.prepare("SELECT run_id AS id FROM runs WHERE state IN ('running', 'cancelling')").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const interruptedStepIds = (
      this.database.prepare("SELECT step_id AS id FROM provider_steps WHERE state = 'streaming'").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const startedToolCalls = this.database
      .prepare(
        `SELECT call_id AS callId, effect_class AS effectClass
         FROM tool_executions WHERE state = 'started' ORDER BY call_id`,
      )
      .all() as SessionRecoveryResult["startedToolCalls"];

    // Milestone 2 reports raw recovery candidates. Later milestones own transition policy/events.
    return decodeStoredValue("session recovery state", () =>
      SessionRecoveryResultSchema.parse({
        interruptedRunIds,
        interruptedStepIds,
        startedToolCalls,
      }),
    );
  }

  testGetProjectionIdentity(
    kind: "run" | "message" | "messagePart" | "providerStep" | "toolExecution" | "approval" | "input",
    id: string,
  ): Record<string, string | number | null> {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    const queries = {
      run: `SELECT run_id AS runId, provider_id AS providerId,
                   provider_config_json AS providerConfigJson, created_at_ms AS createdAtMs
            FROM runs WHERE run_id = ?`,
      message: `SELECT message_id AS messageId, run_id AS runId, role,
                       created_at_ms AS createdAtMs FROM messages WHERE message_id = ?`,
      messagePart: `SELECT part_id AS partId, message_id AS messageId,
                           part_index AS partIndex, part_type AS partType
                    FROM message_parts WHERE part_id = ?`,
      providerStep: `SELECT step_id AS stepId, run_id AS runId, step_index AS stepIndex,
                            started_at_ms AS startedAtMs FROM provider_steps WHERE step_id = ?`,
      toolExecution: `SELECT call_id AS callId, run_id AS runId, step_id AS stepId,
                             tool_name AS toolName, arguments_json AS argumentsJson,
                             arguments_hash AS argumentsHash, effect_class AS effectClass
                      FROM tool_executions WHERE call_id = ?`,
      approval: `SELECT approval_id AS approvalId, run_id AS runId, call_id AS callId,
                        action_digest AS actionDigest FROM approvals WHERE approval_id = ?`,
      input: `SELECT input_id AS inputId, run_id AS runId, prompt
              FROM pending_inputs WHERE input_id = ?`,
    } as const;
    const row = this.database.prepare(queries[kind]).get(id) as
      | Record<string, string | number | null>
      | undefined;
    if (row === undefined) throw new StorageError("session.not_found", "Projection not found");
    return row;
  }

  testGetPragmas(): Record<string, string | number> {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    const sqliteVersion = this.database.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    return {
      journalMode: this.database.pragma("journal_mode", { simple: true }) as string,
      synchronous: this.database.pragma("synchronous", { simple: true }) as number,
      foreignKeys: this.database.pragma("foreign_keys", { simple: true }) as number,
      busyTimeout: this.database.pragma("busy_timeout", { simple: true }) as number,
      trustedSchema: this.database.pragma("trusted_schema", { simple: true }) as number,
      sqliteVersion: sqliteVersion.version,
    };
  }

  testCorruptManifest(): void {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    this.database.prepare("UPDATE manifest SET schema_version = 0 WHERE singleton = 1").run();
  }

  testMutateEvent(action: "update" | "delete", sequence: number): void {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    if (action === "update") {
      this.database.prepare("UPDATE events SET event_type = event_type WHERE sequence = ?").run(sequence);
    } else {
      this.database.prepare("DELETE FROM events WHERE sequence = ?").run(sequence);
    }
  }
}
