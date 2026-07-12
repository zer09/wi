import type Database from "better-sqlite3";

import { canonicalJson } from "@wi/protocol";

import { StorageError } from "../common/worker-rpc.js";
import type { ProjectionMutation } from "../types.js";

export function applyProjection(database: Database.Database, mutation: ProjectionMutation): void {
  switch (mutation.kind) {
    case "run.put":
      database
        .prepare(
          `INSERT INTO runs (
             run_id, state, provider_id, provider_config_json, created_at_ms, started_at_ms,
             completed_at_ms, cancelled_at_ms, failure_category, failure_message,
             active_provider_step_id
           ) VALUES (
             @runId, @state, @providerId, @providerConfigJson, @createdAtMs, @startedAtMs,
             @completedAtMs, @cancelledAtMs, @failureCategory, @failureMessage,
             @activeProviderStepId
           ) ON CONFLICT(run_id) DO UPDATE SET
             state = excluded.state,
             provider_id = excluded.provider_id,
             provider_config_json = excluded.provider_config_json,
             started_at_ms = excluded.started_at_ms,
             completed_at_ms = excluded.completed_at_ms,
             cancelled_at_ms = excluded.cancelled_at_ms,
             failure_category = excluded.failure_category,
             failure_message = excluded.failure_message,
             active_provider_step_id = excluded.active_provider_step_id`,
        )
        .run({ ...mutation, providerConfigJson: canonicalJson(mutation.providerConfig) });
      return;
    case "run.state": {
      const result = database
        .prepare(
          `UPDATE runs SET
             state = @state,
             started_at_ms = @startedAtMs,
             completed_at_ms = @completedAtMs,
             cancelled_at_ms = @cancelledAtMs,
             failure_category = @failureCategory,
             failure_message = @failureMessage,
             active_provider_step_id = @activeProviderStepId
           WHERE run_id = @runId`,
        )
        .run(mutation);
      if (result.changes !== 1) throw new StorageError("session.not_found", "Run projection not found");
      return;
    }
    case "message.put":
      database
        .prepare(
          `INSERT INTO messages (
             message_id, run_id, role, state, created_at_ms, completed_at_ms
           ) VALUES (
             @messageId, @runId, @role, @state, @createdAtMs, @completedAtMs
           ) ON CONFLICT(message_id) DO UPDATE SET
             state = excluded.state,
             completed_at_ms = excluded.completed_at_ms`,
        )
        .run(mutation);
      return;
    case "messagePart.put":
      database
        .prepare(
          `INSERT INTO message_parts (
             part_id, message_id, part_index, part_type, text_content, data_json
           ) VALUES (
             @partId, @messageId, @partIndex, @partType, @textContent, @dataJson
           ) ON CONFLICT(part_id) DO UPDATE SET
             text_content = excluded.text_content,
             data_json = excluded.data_json`,
        )
        .run({
          ...mutation,
          dataJson: mutation.data === null ? null : canonicalJson(mutation.data),
        });
      return;
    case "providerStep.put":
      database
        .prepare(
          `INSERT INTO provider_steps (
             step_id, run_id, step_index, state, started_at_ms, completed_at_ms,
             response_id, error_category, error_message
           ) VALUES (
             @stepId, @runId, @stepIndex, @state, @startedAtMs, @completedAtMs,
             @responseId, @errorCategory, @errorMessage
           ) ON CONFLICT(step_id) DO UPDATE SET
             state = excluded.state,
             completed_at_ms = excluded.completed_at_ms,
             response_id = excluded.response_id,
             error_category = excluded.error_category,
             error_message = excluded.error_message`,
        )
        .run(mutation);
      return;
    case "toolExecution.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, step_id AS stepId, tool_name AS toolName,
                  arguments_hash AS argumentsHash, effect_class AS effectClass
           FROM tool_executions WHERE call_id = ?`,
        )
        .get(mutation.callId) as
        | {
            runId: string;
            stepId: string;
            toolName: string;
            argumentsHash: string;
            effectClass: string;
          }
        | undefined;
      if (
        existing !== undefined &&
        (existing.runId !== mutation.runId ||
          existing.stepId !== mutation.stepId ||
          existing.toolName !== mutation.toolName ||
          existing.argumentsHash !== mutation.argumentsHash ||
          existing.effectClass !== mutation.effectClass)
      ) {
        throw new StorageError(
          "provider.protocol_error",
          `Tool call ${mutation.callId} was reused with different identity`,
        );
      }
      database
        .prepare(
          `INSERT INTO tool_executions (
             call_id, run_id, step_id, tool_name, arguments_json, arguments_hash,
             effect_class, state, attempt_count, requested_at_ms, started_at_ms,
             completed_at_ms, result_json, error_json
           ) VALUES (
             @callId, @runId, @stepId, @toolName, @argumentsJson, @argumentsHash,
             @effectClass, @state, @attemptCount, @requestedAtMs, @startedAtMs,
             @completedAtMs, @resultJson, @errorJson
           ) ON CONFLICT(call_id) DO UPDATE SET
             state = excluded.state,
             attempt_count = excluded.attempt_count,
             started_at_ms = excluded.started_at_ms,
             completed_at_ms = excluded.completed_at_ms,
             result_json = excluded.result_json,
             error_json = excluded.error_json`,
        )
        .run({
          ...mutation,
          resultJson: mutation.result === null ? null : canonicalJson(mutation.result),
          errorJson: mutation.error === null ? null : canonicalJson(mutation.error),
        });
      return;
    }
    case "approval.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, call_id AS callId, action_digest AS actionDigest
           FROM approvals WHERE approval_id = ?`,
        )
        .get(mutation.approvalId) as
        | { runId: string; callId: string; actionDigest: string }
        | undefined;
      if (existing !== undefined) {
        if (
          existing.runId !== mutation.runId ||
          existing.callId !== mutation.callId ||
          existing.actionDigest !== mutation.actionDigest
        ) {
          throw new StorageError(
            "session.invalid_transition",
            `Approval ${mutation.approvalId} changed identity`,
          );
        }
        return;
      }
      database
        .prepare(
          `INSERT INTO approvals (
             approval_id, run_id, call_id, state, action_digest, requested_at_ms
           ) VALUES (
             @approvalId, @runId, @callId, 'pending', @actionDigest, @requestedAtMs
           )`,
        )
        .run(mutation);
      return;
    }
    case "approval.resolve": {
      const result = database
        .prepare(
          `UPDATE approvals SET
             state = @resolution,
             resolved_at_ms = @resolvedAtMs,
             resolution = @resolution,
             resolved_by_client_id = @resolvedByClientId
           WHERE approval_id = @approvalId AND state = 'pending'`,
        )
        .run(mutation);
      if (result.changes !== 1) {
        throw new StorageError(
          "session.invalid_transition",
          `Approval ${mutation.approvalId} is missing or already resolved`,
        );
      }
      return;
    }
    case "input.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, prompt FROM pending_inputs WHERE input_id = ?`,
        )
        .get(mutation.inputId) as { runId: string; prompt: string } | undefined;
      if (existing !== undefined) {
        if (existing.runId !== mutation.runId || existing.prompt !== mutation.prompt) {
          throw new StorageError(
            "session.invalid_transition",
            `Input ${mutation.inputId} changed identity`,
          );
        }
        return;
      }
      database
        .prepare(
          `INSERT INTO pending_inputs (
             input_id, run_id, state, prompt, requested_at_ms
           ) VALUES (
             @inputId, @runId, 'pending', @prompt, @requestedAtMs
           )`,
        )
        .run(mutation);
      return;
    }
    case "input.resolve": {
      const result = database
        .prepare(
          `UPDATE pending_inputs SET
             state = 'resolved', resolved_at_ms = @resolvedAtMs, value_json = @valueJson
           WHERE input_id = @inputId AND state = 'pending'`,
        )
        .run({ ...mutation, valueJson: canonicalJson(mutation.value) });
      if (result.changes !== 1) {
        throw new StorageError(
          "session.invalid_transition",
          `Input ${mutation.inputId} is missing or already resolved`,
        );
      }
      return;
    }
  }
}
