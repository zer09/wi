import { z } from "zod";

export const ERROR_CODES = [
  "protocol.invalid_json",
  "protocol.invalid_message",
  "protocol.unsupported_version",
  "protocol.message_too_large",
  "protocol.command_id_conflict",
  "storage.busy",
  "storage.corrupt",
  "storage.migration_failed",
  "storage.disk_full",
  "storage.worker_failed",
  "session.not_found",
  "session.run_already_active",
  "session.invalid_transition",
  "provider.transient_before_output",
  "provider.transport_after_output",
  "provider.protocol_error",
  "provider.incomplete",
  "provider.cancelled",
  "tool.unknown",
  "tool.invalid_arguments",
  "tool.approval_denied",
  "tool.timeout",
  "tool.execution_failed",
  "tool.outcome_unknown",
  "websocket.unauthorized",
  "websocket.invalid_origin",
  "websocket.slow_consumer",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const PROTOCOL_ERROR_CODES = [
  "protocol.invalid_json",
  "protocol.invalid_message",
  "protocol.unsupported_version",
  "protocol.message_too_large",
] as const;

export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
