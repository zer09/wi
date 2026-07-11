import { z } from "zod";

import { CanonicalJsonValueSchema } from "./canonical-json.js";
import { ProtocolErrorCodeSchema, ErrorCodeSchema } from "./errors.js";
import {
  EventSequenceSchema,
  ProtocolVersionSchema,
  SequenceSchema,
  TimestampMsSchema,
} from "./envelope.js";
import { SessionEventSchema } from "./events.js";
import {
  CommandIdSchema,
  ConnectionIdSchema,
  DiagnosticIdSchema,
  RequestIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from "./ids.js";

export const WelcomeMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("welcome"),
  connectionId: ConnectionIdSchema,
  serverTimeMs: TimestampMsSchema,
  heartbeatIntervalMs: z.number().int().positive().safe(),
});

export const CommandAcceptedMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("command.accepted"),
  commandId: CommandIdSchema,
  sessionId: SessionIdSchema.optional(),
  acceptedSequence: EventSequenceSchema.optional(),
  runId: RunIdSchema.optional(),
  result: CanonicalJsonValueSchema,
  duplicate: z.boolean(),
});

export const CommandRejectedMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("command.rejected"),
  commandId: CommandIdSchema,
  code: ErrorCodeSchema,
  message: z.string(),
  diagnosticId: DiagnosticIdSchema,
  recoverable: z.boolean(),
});

export const ReplayCompleteMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("replay.complete"),
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  throughSequence: SequenceSchema,
});

export const ProtocolErrorMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("protocol.error"),
  requestId: RequestIdSchema.optional(),
  code: ProtocolErrorCodeSchema,
  message: z.string(),
  diagnosticId: DiagnosticIdSchema,
  recoverable: z.boolean(),
});

export const ServerHeartbeatMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("heartbeat"),
  serverTimeMs: TimestampMsSchema,
});

export const ServerMessageSchema = z.union([
  WelcomeMessageSchema,
  CommandAcceptedMessageSchema,
  CommandRejectedMessageSchema,
  SessionEventSchema,
  ReplayCompleteMessageSchema,
  ProtocolErrorMessageSchema,
  ServerHeartbeatMessageSchema,
]);

export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type CommandAcceptedMessage = z.infer<typeof CommandAcceptedMessageSchema>;
export type CommandRejectedMessage = z.infer<typeof CommandRejectedMessageSchema>;
export type ReplayCompleteMessage = z.infer<typeof ReplayCompleteMessageSchema>;
export type ProtocolErrorMessage = z.infer<typeof ProtocolErrorMessageSchema>;
export type ServerHeartbeatMessage = z.infer<typeof ServerHeartbeatMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
