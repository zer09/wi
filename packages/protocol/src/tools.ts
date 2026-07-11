import { z } from "zod";

export const ToolEffectClassSchema = z.enum([
  "pure",
  "local_transactional",
  "idempotent_external",
  "non_idempotent",
]);

export const ToolExecutionStateSchema = z.enum([
  "staged",
  "requested",
  "awaiting_approval",
  "approved",
  "started",
  "completed",
  "failed",
  "denied",
  "cancelled",
  "outcome_unknown",
  "discarded",
]);

export const ApprovalResolutionSchema = z.enum(["approved", "denied"]);

export type ToolEffectClass = z.infer<typeof ToolEffectClassSchema>;
export type ToolExecutionState = z.infer<typeof ToolExecutionStateSchema>;
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;
