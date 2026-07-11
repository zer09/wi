import { z } from "zod";

import { canonicalJsonHash } from "./canonical-json.js";
import { CanonicalJsonValueSchema } from "./canonical-json.js";
import { ProtocolVersionSchema, SequenceSchema, TimestampMsSchema } from "./envelope.js";
import {
  ApprovalIdSchema,
  ClientIdSchema,
  CommandIdSchema,
  InputIdSchema,
  ProjectIdSchema,
  RequestIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from "./ids.js";
import { ApprovalResolutionSchema } from "./tools.js";

export const COMMAND_METHODS = [
  "session.create",
  "message.submit",
  "run.cancel",
  "approval.resolve",
  "input.respond",
] as const;

export const CommandMethodSchema = z.enum(COMMAND_METHODS);
export type CommandMethod = z.infer<typeof CommandMethodSchema>;

const SessionCreateParamsSchema = z.strictObject({
  projectId: ProjectIdSchema.optional(),
  title: z.string().optional(),
});

const MessageSubmitParamsSchema = z.strictObject({
  text: z.string(),
});

const RunCancelParamsSchema = z.strictObject({
  runId: RunIdSchema,
});

const ApprovalResolveParamsSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  resolution: ApprovalResolutionSchema,
});

const InputRespondParamsSchema = z.strictObject({
  inputId: InputIdSchema,
  value: CanonicalJsonValueSchema,
});

const CommandBaseSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("command"),
  commandId: CommandIdSchema,
});

export const SessionCreateCommandSchema = CommandBaseSchema.extend({
  method: z.literal("session.create"),
  params: SessionCreateParamsSchema,
});

export const MessageSubmitCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("message.submit"),
  params: MessageSubmitParamsSchema,
});

export const RunCancelCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("run.cancel"),
  params: RunCancelParamsSchema,
});

export const ApprovalResolveCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("approval.resolve"),
  params: ApprovalResolveParamsSchema,
});

export const InputRespondCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("input.respond"),
  params: InputRespondParamsSchema,
});

export const CommandMessageSchema = z.discriminatedUnion("method", [
  SessionCreateCommandSchema,
  MessageSubmitCommandSchema,
  RunCancelCommandSchema,
  ApprovalResolveCommandSchema,
  InputRespondCommandSchema,
]);

export const ResumeCursorSchema = z.strictObject({
  sessionId: SessionIdSchema,
  afterSequence: SequenceSchema,
});

export const HelloMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("hello"),
  clientId: ClientIdSchema,
  resume: z.array(ResumeCursorSchema),
});

export const SubscribeMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("subscribe"),
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  afterSequence: SequenceSchema,
});

export const UnsubscribeMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("unsubscribe"),
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
});

export const ClientHeartbeatMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("heartbeat"),
  clientTimeMs: TimestampMsSchema,
});

export const ClientMessageSchema = z.union([
  HelloMessageSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  CommandMessageSchema,
  ClientHeartbeatMessageSchema,
]);

export type SessionCreateCommand = z.infer<typeof SessionCreateCommandSchema>;
export type MessageSubmitCommand = z.infer<typeof MessageSubmitCommandSchema>;
export type RunCancelCommand = z.infer<typeof RunCancelCommandSchema>;
export type ApprovalResolveCommand = z.infer<typeof ApprovalResolveCommandSchema>;
export type InputRespondCommand = z.infer<typeof InputRespondCommandSchema>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;
export type ClientHeartbeatMessage = z.infer<typeof ClientHeartbeatMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export async function hashCommandContent(command: CommandMessage): Promise<string> {
  const content: Record<string, unknown> = {
    method: command.method,
    params: command.params,
  };
  if ("sessionId" in command) content.sessionId = command.sessionId;
  return canonicalJsonHash(content);
}
