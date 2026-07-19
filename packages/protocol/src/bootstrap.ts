import { z } from "zod";

import { RunStateSchema } from "./events.js";
import { SequenceSchema, TimestampMsSchema } from "./envelope.js";
import { SessionIdSchema } from "./ids.js";

export const MAXIMUM_BOOTSTRAP_SESSIONS = 1_000;

export const BrowserCommandLimitsSchema = z.strictObject({
  v: z.literal(1),
  maximumFrameBytes: z.number().int().positive().max(1_024 * 1_024),
  maximumDurablePayloadBytes: z.number().int().positive().max(1_000_000),
  maximumRawInputCodeUnits: z.number().int().positive().max(1_000_000),
  maximumRawInputUtf8Bytes: z.number().int().positive().max(1_000_000),
  maximumJsonDepth: z.number().int().nonnegative().max(64),
  maximumJsonNodes: z.number().int().positive().max(20_000),
});

export const BrowserSessionSummarySchema = z.strictObject({
  sessionId: SessionIdSchema,
  title: z.string().max(512),
  status: z.enum(["ready", "unavailable"]),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  lastEventSequence: SequenceSchema,
  lastRunState: z.union([RunStateSchema, z.null()]),
  lastMessagePreview: z.union([z.string().max(512), z.null()]),
  requiresAttention: z.boolean(),
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
});

export const BootstrapResponseSchema = z.strictObject({
  v: z.literal(1),
  websocketPath: z.literal("/ws"),
  websocketProtocol: z.literal("wi.v1"),
  commandLimits: BrowserCommandLimitsSchema,
  sessions: z.array(BrowserSessionSummarySchema).max(MAXIMUM_BOOTSTRAP_SESSIONS),
  sessionsTruncated: z.boolean(),
});

export type BrowserCommandLimits = z.infer<typeof BrowserCommandLimitsSchema>;
export type BrowserSessionSummary = z.infer<typeof BrowserSessionSummarySchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
