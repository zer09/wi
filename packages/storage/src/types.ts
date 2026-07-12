import { z } from "zod";

import {
  CanonicalJsonValueSchema,
  CommandIdSchema,
  CommandMethodSchema,
  EventIdSchema,
  MessageIdSchema,
  PartIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  RunStateSchema,
  SessionEventSchema,
  SessionEventTypeSchema,
  SessionIdSchema,
  TimestampMsSchema,
} from "@wi/protocol";

export const CATALOG_SCHEMA_VERSION = 1;
export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_FORMAT_VERSION = 1;

export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NullableStringSchema = z.union([z.string(), z.null()]);
export const NullableTimestampSchema = z.union([TimestampMsSchema, z.null()]);
export const SessionStatusSchema = z.enum(["ready", "missing", "unavailable"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ProjectRecordSchema = z.strictObject({
  projectId: ProjectIdSchema,
  name: z.string().min(1),
  rootPath: z.string().min(1),
  rootRealpath: z.string().min(1),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  config: CanonicalJsonValueSchema,
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const SessionSummarySchema = z.strictObject({
  sessionId: SessionIdSchema,
  projectId: z.union([ProjectIdSchema, z.null()]),
  dbRelativePath: z.string().min(1),
  title: z.string(),
  status: SessionStatusSchema,
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  lastEventSequence: z.number().int().nonnegative().safe(),
  lastRunState: z.union([RunStateSchema, z.null()]),
  lastMessagePreview: NullableStringSchema,
  requiresAttention: z.boolean(),
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  sessionSchemaVersion: z.number().int().positive().safe(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionCreationRequestSchema = z.strictObject({
  title: z.string(),
  projectId: z.union([ProjectIdSchema, z.null()]),
});
export type SessionCreationRequest = z.infer<typeof SessionCreationRequestSchema>;

export const GlobalCommandRecordSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.literal("session.create"),
  payloadHash: HashSchema,
  state: z.enum(["creating", "accepted"]),
  reservedSessionId: SessionIdSchema,
  reservedEventId: EventIdSchema,
  request: SessionCreationRequestSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  acceptedAtMs: NullableTimestampSchema,
  updatedAtMs: TimestampMsSchema,
});
export type GlobalCommandRecord = z.infer<typeof GlobalCommandRecordSchema>;

export const GlobalCommandReservationSchema = z.strictObject({
  command: GlobalCommandRecordSchema,
  duplicate: z.boolean(),
});
export type GlobalCommandReservation = z.infer<typeof GlobalCommandReservationSchema>;

export const SessionCatalogProjectionSchema = z.strictObject({
  updatedAtMs: TimestampMsSchema,
  lastRunState: z.union([RunStateSchema, z.null()]),
  lastMessagePreview: NullableStringSchema,
});
export type SessionCatalogProjection = z.infer<typeof SessionCatalogProjectionSchema>;

export const SessionManifestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  projectId: z.union([ProjectIdSchema, z.null()]),
  createdAtMs: TimestampMsSchema,
  schemaVersion: z.number().int().positive().safe(),
  formatVersion: z.number().int().positive().safe(),
  title: z.string(),
  lastEventSequence: z.number().int().nonnegative().safe(),
});
export type SessionManifest = z.infer<typeof SessionManifestSchema>;

export const NewSessionEventSchema = z.strictObject({
  eventId: EventIdSchema,
  eventType: SessionEventTypeSchema,
  createdAtMs: TimestampMsSchema,
  data: z.unknown(),
  itemId: z.string().nullable().optional(),
});
export type NewSessionEvent = z.infer<typeof NewSessionEventSchema>;

export const RunProjectionSchema = z.strictObject({
  kind: z.literal("run.put"),
  runId: RunIdSchema,
  state: RunStateSchema,
  providerId: z.string().min(1),
  providerConfig: CanonicalJsonValueSchema,
  createdAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  cancelledAtMs: NullableTimestampSchema,
  failureCategory: NullableStringSchema,
  failureMessage: NullableStringSchema,
  activeProviderStepId: NullableStringSchema,
});

export const RunStateProjectionSchema = z.strictObject({
  kind: z.literal("run.state"),
  runId: RunIdSchema,
  state: RunStateSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  cancelledAtMs: NullableTimestampSchema,
  failureCategory: NullableStringSchema,
  failureMessage: NullableStringSchema,
  activeProviderStepId: NullableStringSchema,
});

export const MessageProjectionSchema = z.strictObject({
  kind: z.literal("message.put"),
  messageId: MessageIdSchema,
  runId: z.union([RunIdSchema, z.null()]),
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.string().min(1),
  createdAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
});

export const MessagePartProjectionSchema = z.strictObject({
  kind: z.literal("messagePart.put"),
  partId: PartIdSchema,
  messageId: MessageIdSchema,
  partIndex: z.number().int().nonnegative().safe(),
  partType: z.string().min(1),
  textContent: NullableStringSchema,
  data: z.union([CanonicalJsonValueSchema, z.null()]),
});

export const ProviderStepProjectionSchema = z.strictObject({
  kind: z.literal("providerStep.put"),
  stepId: z.string().min(1),
  runId: RunIdSchema,
  stepIndex: z.number().int().nonnegative().safe(),
  state: z.string().min(1),
  startedAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
  responseId: NullableStringSchema,
  errorCategory: NullableStringSchema,
  errorMessage: NullableStringSchema,
});

export const ToolExecutionProjectionSchema = z.strictObject({
  kind: z.literal("toolExecution.put"),
  callId: z.string().min(1),
  runId: RunIdSchema,
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  argumentsJson: z.string(),
  argumentsHash: HashSchema,
  effectClass: z.enum(["pure", "local_transactional", "idempotent_external", "non_idempotent"]),
  state: z.string().min(1),
  attemptCount: z.number().int().nonnegative().safe(),
  requestedAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  error: z.union([CanonicalJsonValueSchema, z.null()]),
});

export const ApprovalProjectionSchema = z.strictObject({
  kind: z.literal("approval.put"),
  approvalId: z.string().min(1),
  runId: RunIdSchema,
  callId: z.string().min(1),
  state: z.literal("pending"),
  actionDigest: HashSchema,
  requestedAtMs: TimestampMsSchema,
});

export const ApprovalResolutionProjectionSchema = z.strictObject({
  kind: z.literal("approval.resolve"),
  approvalId: z.string().min(1),
  resolution: z.enum(["approved", "denied"]),
  resolvedAtMs: TimestampMsSchema,
  resolvedByClientId: z.string().min(1),
});

export const PendingInputProjectionSchema = z.strictObject({
  kind: z.literal("input.put"),
  inputId: z.string().min(1),
  runId: RunIdSchema,
  state: z.literal("pending"),
  prompt: z.string(),
  requestedAtMs: TimestampMsSchema,
});

export const InputResolutionProjectionSchema = z.strictObject({
  kind: z.literal("input.resolve"),
  inputId: z.string().min(1),
  resolvedAtMs: TimestampMsSchema,
  value: CanonicalJsonValueSchema,
});

export const ProjectionMutationSchema = z.discriminatedUnion("kind", [
  RunProjectionSchema,
  RunStateProjectionSchema,
  MessageProjectionSchema,
  MessagePartProjectionSchema,
  ProviderStepProjectionSchema,
  ToolExecutionProjectionSchema,
  ApprovalProjectionSchema,
  ApprovalResolutionProjectionSchema,
  PendingInputProjectionSchema,
  InputResolutionProjectionSchema,
]);
export type ProjectionMutation = z.infer<typeof ProjectionMutationSchema>;

export const AppendTransactionInputSchema = z.strictObject({
  events: z.array(NewSessionEventSchema).min(1),
  projections: z.array(ProjectionMutationSchema).default([]),
  testFailpoint: z.enum(["crash_before_commit", "crash_after_commit"]).optional(),
});
export type AppendTransactionInput = z.input<typeof AppendTransactionInputSchema>;

export const AcceptCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: CommandMethodSchema,
  payloadHash: HashSchema,
  result: CanonicalJsonValueSchema,
  acceptedAtMs: TimestampMsSchema,
  runId: z.union([RunIdSchema, z.null()]),
  transaction: AppendTransactionInputSchema,
});
export type AcceptCommandInput = z.input<typeof AcceptCommandInputSchema>;

export const AcceptedCommandResultSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: CommandMethodSchema,
  payloadHash: HashSchema,
  acceptedSequence: z.union([z.number().int().positive().safe(), z.null()]),
  runId: z.union([RunIdSchema, z.null()]),
  result: CanonicalJsonValueSchema,
  acceptedAtMs: TimestampMsSchema,
  duplicate: z.boolean(),
  events: z.array(SessionEventSchema),
});
export type AcceptedCommandResult = z.infer<typeof AcceptedCommandResultSchema>;

export const AppendTransactionResultSchema = z.strictObject({
  events: z.array(SessionEventSchema),
  headSequence: z.number().int().positive().safe(),
});
export type AppendTransactionResult = z.infer<typeof AppendTransactionResultSchema>;

export const RunRecordSchema = z.strictObject({
  runId: RunIdSchema,
  state: RunStateSchema,
  providerId: z.string().min(1),
  providerConfig: CanonicalJsonValueSchema,
  createdAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  cancelledAtMs: NullableTimestampSchema,
  failureCategory: NullableStringSchema,
  failureMessage: NullableStringSchema,
  activeProviderStepId: NullableStringSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const PendingApprovalRecordSchema = z.strictObject({
  approvalId: z.string().min(1),
  runId: RunIdSchema,
  callId: z.string().min(1),
  state: z.literal("pending"),
  actionDigest: HashSchema,
  requestedAtMs: TimestampMsSchema,
});
export type PendingApprovalRecord = z.infer<typeof PendingApprovalRecordSchema>;

export const StartedToolRecoveryRecordSchema = z.strictObject({
  callId: z.string().min(1),
  effectClass: z.enum(["pure", "local_transactional", "idempotent_external", "non_idempotent"]),
});

export const SessionRecoveryResultSchema = z.strictObject({
  interruptedRunIds: z.array(RunIdSchema),
  interruptedStepIds: z.array(z.string().min(1)),
  startedToolCalls: z.array(StartedToolRecoveryRecordSchema),
});
export type SessionRecoveryResult = z.infer<typeof SessionRecoveryResultSchema>;
