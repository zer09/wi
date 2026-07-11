import { z } from "zod";

export const ProviderStepStateSchema = z.enum([
  "created",
  "streaming",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type ProviderStepState = z.infer<typeof ProviderStepStateSchema>;
