import { z } from "zod";

import {
  ApprovalIdSchema,
  CanonicalJsonValueSchema,
  CommandIdSchema,
  CommandMethodSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  MessageIdSchema,
  PartIdSchema,
  ProjectIdSchema,
  ProviderStepIdSchema,
  ProviderStepStateSchema,
  RunIdSchema,
  RunStateSchema,
  SessionEventSchema,
  SessionEventTypeSchema,
  SessionIdSchema,
  TimestampMsSchema,
  ToolCallIdSchema,
  ToolEffectClassSchema,
  ToolExecutionStateSchema,
} from "@wi/protocol";

export const CATALOG_SCHEMA_VERSION = 2;
export const SESSION_SCHEMA_VERSION = 2;
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
  state: z.enum(["creating", "accepted", "failed"]),
  reservedSessionId: SessionIdSchema,
  reservedEventId: EventIdSchema,
  request: SessionCreationRequestSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  acceptedAtMs: NullableTimestampSchema,
  failureCode: NullableStringSchema,
  failureMessage: NullableStringSchema,
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]),
  quarantinedRelativePath: NullableStringSchema,
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

export const SessionCatalogObservationSchema = z.strictObject({
  headSequence: z.number().int().nonnegative().safe(),
  projection: SessionCatalogProjectionSchema,
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
});
export type SessionCatalogObservation = z.infer<typeof SessionCatalogObservationSchema>;

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
  expectedState: RunStateSchema,
  nextState: RunStateSchema,
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

export const RunActiveProviderStepProjectionSchema = z.strictObject({
  kind: z.literal("run.activeProviderStep"),
  runId: RunIdSchema,
  expectedActiveProviderStepId: z.union([ProviderStepIdSchema, z.null()]),
  activeProviderStepId: z.union([ProviderStepIdSchema, z.null()]),
});

export const ProviderStepProjectionSchema = z.strictObject({
  kind: z.literal("providerStep.put"),
  stepId: ProviderStepIdSchema,
  expectedState: ProviderStepStateSchema.optional(),
  runId: RunIdSchema,
  stepIndex: z.number().int().nonnegative().safe(),
  state: ProviderStepStateSchema,
  startedAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
  responseId: NullableStringSchema,
  errorCategory: NullableStringSchema,
  errorMessage: NullableStringSchema,
});

export const ProviderStepRecordSchema = z.strictObject({
  stepId: ProviderStepIdSchema,
  runId: RunIdSchema,
  stepIndex: z.number().int().nonnegative().safe(),
  state: ProviderStepStateSchema,
  startedAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
  responseId: NullableStringSchema,
  errorCategory: NullableStringSchema,
  errorMessage: NullableStringSchema,
});
export type ProviderStepRecord = z.infer<typeof ProviderStepRecordSchema>;

export const ToolExecutionProjectionSchema = z.strictObject({
  kind: z.literal("toolExecution.put"),
  callId: ToolCallIdSchema,
  expectedState: ToolExecutionStateSchema.optional(),
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  toolName: z.string().min(1),
  argumentsJson: z.string(),
  argumentsHash: HashSchema,
  effectClass: z.union([ToolEffectClassSchema, z.null()]),
  state: ToolExecutionStateSchema,
  attemptCount: z.number().int().nonnegative().safe(),
  requestedAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  error: z.union([CanonicalJsonValueSchema, z.null()]),
});

export const ToolCallOccurrenceProjectionSchema = z.strictObject({
  kind: z.literal("toolCallOccurrence.put"),
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  callId: ToolCallIdSchema,
  occurredAtMs: TimestampMsSchema,
});

export const ToolExecutionRecordSchema = ToolExecutionProjectionSchema.omit({
  kind: true,
  expectedState: true,
});
export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecordSchema>;

export const ApprovalProjectionSchema = z.strictObject({
  kind: z.literal("approval.put"),
  approvalId: ApprovalIdSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  state: z.literal("pending"),
  actionDigest: HashSchema,
  requestedAtMs: TimestampMsSchema,
});

export const ApprovalResolutionProjectionSchema = z.strictObject({
  kind: z.literal("approval.resolve"),
  approvalId: ApprovalIdSchema,
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

export const PendingInteractionsCancellationProjectionSchema = z.strictObject({
  kind: z.literal("run.pendingInteractions.cancel"),
  runId: RunIdSchema,
  cancelledAtMs: TimestampMsSchema,
});

export const ProjectionMutationSchema = z.discriminatedUnion("kind", [
  RunProjectionSchema,
  RunStateProjectionSchema,
  MessageProjectionSchema,
  MessagePartProjectionSchema,
  RunActiveProviderStepProjectionSchema,
  ProviderStepProjectionSchema,
  ToolExecutionProjectionSchema,
  ToolCallOccurrenceProjectionSchema,
  ApprovalProjectionSchema,
  ApprovalResolutionProjectionSchema,
  PendingInputProjectionSchema,
  InputResolutionProjectionSchema,
  PendingInteractionsCancellationProjectionSchema,
]);
export type ProjectionMutation = z.infer<typeof ProjectionMutationSchema>;

const TransactionProjectionFields = {
  projections: z.array(ProjectionMutationSchema).default([]),
  testFailpoint: z.enum(["crash_before_commit", "crash_after_commit"]).optional(),
} as const;

export const AppendTransactionInputSchema = z.strictObject({
  events: z.array(NewSessionEventSchema).min(1),
  ...TransactionProjectionFields,
});
export type AppendTransactionInput = z.input<typeof AppendTransactionInputSchema>;

// An idempotent command may be a durable no-op, such as cancelling an already terminal run.
// Its acceptance still commits even though it does not invent a session event.
export const AcceptCommandTransactionInputSchema = z.strictObject({
  events: z.array(NewSessionEventSchema),
  ...TransactionProjectionFields,
});

export const AcceptCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: CommandMethodSchema,
  payloadHash: HashSchema,
  result: CanonicalJsonValueSchema,
  acceptedAtMs: TimestampMsSchema,
  runId: z.union([RunIdSchema, z.null()]),
  transaction: AcceptCommandTransactionInputSchema,
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
  approvalId: ApprovalIdSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  state: z.literal("pending"),
  actionDigest: HashSchema,
  requestedAtMs: TimestampMsSchema,
});
export type PendingApprovalRecord = z.infer<typeof PendingApprovalRecordSchema>;

export const PendingInputRecordSchema = z.strictObject({
  inputId: z.string().min(1),
  runId: RunIdSchema,
  state: z.literal("pending"),
  prompt: z.string(),
  requestedAtMs: TimestampMsSchema,
});
export type PendingInputRecord = z.infer<typeof PendingInputRecordSchema>;

export const RunMessageRecordSchema = z.strictObject({
  messageId: MessageIdSchema,
  runId: RunIdSchema,
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.string().min(1),
  text: z.string(),
  createdAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
});
export type RunMessageRecord = z.infer<typeof RunMessageRecordSchema>;

export const StartedToolRecoveryRecordSchema = z.strictObject({
  callId: ToolCallIdSchema,
  effectClass: ToolEffectClassSchema,
});

export const SessionRecoveryResultSchema = z.strictObject({
  interruptedRunIds: z.array(RunIdSchema),
  interruptedStepIds: z.array(z.string().min(1)),
  startedToolCalls: z.array(StartedToolRecoveryRecordSchema),
});
export type SessionRecoveryResult = z.infer<typeof SessionRecoveryResultSchema>;
