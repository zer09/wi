import { z } from "zod";

import { RunStateSchema } from "./events.js";
import { SequenceSchema, TimestampMsSchema } from "./envelope.js";
import { SessionIdSchema } from "./ids.js";

export const MAXIMUM_BOOTSTRAP_SESSIONS = 1_000;

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
  sessions: z.array(BrowserSessionSummarySchema).max(MAXIMUM_BOOTSTRAP_SESSIONS),
  sessionsTruncated: z.boolean(),
});

export type BrowserSessionSummary = z.infer<typeof BrowserSessionSummarySchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
