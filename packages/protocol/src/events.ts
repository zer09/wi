import { z } from "zod";

import { CanonicalJsonValueSchema } from "./canonical-json.js";
import { ErrorCodeSchema } from "./errors.js";
import { EventSequenceSchema, ProtocolVersionSchema, TimestampMsSchema } from "./envelope.js";
import {
  ApprovalIdSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  InputIdSchema,
  MessageIdSchema,
  PartIdSchema,
  ProjectIdSchema,
  ProviderStepIdSchema,
  RunIdSchema,
  SessionIdSchema,
  ToolCallIdSchema,
} from "./ids.js";
import { ApprovalResolutionSchema, ToolEffectClassSchema } from "./tools.js";

export const SESSION_EVENT_TYPES = [
  "session.created",
  "user.message.appended",
  "run.created",
  "run.started",
  "run.waiting_for_user",
  "run.cancel.requested",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "provider.step.started",
  "provider.text.delta",
  "provider.tool_call.staged",
  "provider.step.completed",
  "provider.step.interrupted",
  "provider.step.failed",
  "assistant.message.completed",
  "tool.call.requested",
  "tool.approval.requested",
  "tool.approval.resolved",
  "tool.execution.started",
  "tool.execution.completed",
  "tool.execution.failed",
  "tool.execution.outcome_unknown",
  "input.requested",
  "input.resolved",
] as const;

export const SessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const RunStateSchema = z.enum([
  "created",
  "queued",
  "running",
  "waiting_for_user",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunState = z.infer<typeof RunStateSchema>;

const EventBaseSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("event"),
  sessionId: SessionIdSchema,
  sequence: EventSequenceSchema,
  eventId: EventIdSchema,
  createdAtMs: TimestampMsSchema,
});

const VersionSchema = z.literal(1);
const runData = { eventVersion: VersionSchema, runId: RunIdSchema } as const;
const stepData = {
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
} as const;
const toolData = {
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
} as const;

function eventMessage<TType extends SessionEventType, TData extends z.ZodType>(
  eventType: TType,
  data: TData,
) {
  return EventBaseSchema.extend({
    eventType: z.literal(eventType),
    data,
  });
}

export const SessionCreatedEventSchema = eventMessage(
  "session.created",
  z.strictObject({
    eventVersion: VersionSchema,
    title: z.string(),
    projectId: ProjectIdSchema.optional(),
  }),
);

export const UserMessageAppendedEventSchema = eventMessage(
  "user.message.appended",
  z.strictObject({
    eventVersion: VersionSchema,
    messageId: MessageIdSchema,
    runId: RunIdSchema,
    text: z.string(),
  }),
);

export const RunCreatedEventSchema = eventMessage("run.created", z.strictObject(runData));
export const RunStartedEventSchema = eventMessage("run.started", z.strictObject(runData));
export const RunWaitingForUserEventSchema = eventMessage(
  "run.waiting_for_user",
  z.discriminatedUnion("reason", [
    z.strictObject({
      ...runData,
      reason: z.literal("approval"),
      approvalId: ApprovalIdSchema,
    }),
    z.strictObject({
      ...runData,
      reason: z.literal("input"),
      inputId: InputIdSchema,
    }),
  ]),
);
export const RunCancelRequestedEventSchema = eventMessage(
  "run.cancel.requested",
  z.strictObject(runData),
);
export const RunCancelledEventSchema = eventMessage("run.cancelled", z.strictObject(runData));
export const RunCompletedEventSchema = eventMessage("run.completed", z.strictObject(runData));
export const RunFailedEventSchema = eventMessage(
  "run.failed",
  z.strictObject({
    ...runData,
    code: ErrorCodeSchema,
    message: z.string(),
    diagnosticId: DiagnosticIdSchema,
  }),
);
export const RunInterruptedEventSchema = eventMessage(
  "run.interrupted",
  z.strictObject({
    ...runData,
    code: ErrorCodeSchema,
    message: z.string(),
    diagnosticId: DiagnosticIdSchema,
  }),
);

export const ProviderStepStartedEventSchema = eventMessage(
  "provider.step.started",
  z.strictObject({ ...stepData, stepIndex: z.number().int().nonnegative().safe() }),
);
export const ProviderTextDeltaEventSchema = eventMessage(
  "provider.text.delta",
  z.strictObject({
    ...stepData,
    messageId: MessageIdSchema,
    partId: PartIdSchema,
    text: z.string(),
  }),
);
export const ProviderToolCallStagedEventSchema = eventMessage(
  "provider.tool_call.staged",
  z.strictObject({
    ...stepData,
    callId: ToolCallIdSchema,
    name: z.string().min(1),
    argumentsJson: z.string(),
  }),
);
export const ProviderStepCompletedEventSchema = eventMessage(
  "provider.step.completed",
  z.strictObject(stepData),
);
export const ProviderStepInterruptedEventSchema = eventMessage(
  "provider.step.interrupted",
  z.strictObject({
    ...stepData,
    code: ErrorCodeSchema,
    message: z.string(),
    diagnosticId: DiagnosticIdSchema,
  }),
);
export const ProviderStepFailedEventSchema = eventMessage(
  "provider.step.failed",
  z.strictObject({
    ...stepData,
    code: ErrorCodeSchema,
    message: z.string(),
    diagnosticId: DiagnosticIdSchema,
  }),
);

export const AssistantMessageCompletedEventSchema = eventMessage(
  "assistant.message.completed",
  z.strictObject({ ...runData, messageId: MessageIdSchema }),
);

export const ToolCallRequestedEventSchema = eventMessage(
  "tool.call.requested",
  z.strictObject({
    ...stepData,
    callId: ToolCallIdSchema,
    name: z.string().min(1),
    argumentsJson: z.string(),
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectClass: ToolEffectClassSchema,
  }),
);
export const ToolApprovalRequestedEventSchema = eventMessage(
  "tool.approval.requested",
  z.strictObject({
    ...toolData,
    approvalId: ApprovalIdSchema,
    toolName: z.string().min(1),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string(),
  }),
);
export const ToolApprovalResolvedEventSchema = eventMessage(
  "tool.approval.resolved",
  z.strictObject({
    ...toolData,
    approvalId: ApprovalIdSchema,
    resolution: ApprovalResolutionSchema,
  }),
);
export const ToolExecutionStartedEventSchema = eventMessage(
  "tool.execution.started",
  z.strictObject(toolData),
);
export const ToolExecutionCompletedEventSchema = eventMessage(
  "tool.execution.completed",
  z.strictObject({ ...toolData, result: CanonicalJsonValueSchema }),
);
export const ToolExecutionFailedEventSchema = eventMessage(
  "tool.execution.failed",
  z.strictObject({
    ...toolData,
    code: ErrorCodeSchema,
    message: z.string(),
    diagnosticId: DiagnosticIdSchema,
  }),
);
export const ToolExecutionOutcomeUnknownEventSchema = eventMessage(
  "tool.execution.outcome_unknown",
  z.strictObject({
    ...toolData,
    code: z.literal("tool.outcome_unknown"),
    message: z.string(),
    diagnosticId: DiagnosticIdSchema,
  }),
);

export const InputRequestedEventSchema = eventMessage(
  "input.requested",
  z.strictObject({
    ...runData,
    inputId: InputIdSchema,
    prompt: z.string(),
  }),
);
export const InputResolvedEventSchema = eventMessage(
  "input.resolved",
  z.strictObject({
    ...runData,
    inputId: InputIdSchema,
    value: CanonicalJsonValueSchema,
  }),
);

export const SessionEventSchema = z.discriminatedUnion("eventType", [
  SessionCreatedEventSchema,
  UserMessageAppendedEventSchema,
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunWaitingForUserEventSchema,
  RunCancelRequestedEventSchema,
  RunCancelledEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunInterruptedEventSchema,
  ProviderStepStartedEventSchema,
  ProviderTextDeltaEventSchema,
  ProviderToolCallStagedEventSchema,
  ProviderStepCompletedEventSchema,
  ProviderStepInterruptedEventSchema,
  ProviderStepFailedEventSchema,
  AssistantMessageCompletedEventSchema,
  ToolCallRequestedEventSchema,
  ToolApprovalRequestedEventSchema,
  ToolApprovalResolvedEventSchema,
  ToolExecutionStartedEventSchema,
  ToolExecutionCompletedEventSchema,
  ToolExecutionFailedEventSchema,
  ToolExecutionOutcomeUnknownEventSchema,
  InputRequestedEventSchema,
  InputResolvedEventSchema,
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
