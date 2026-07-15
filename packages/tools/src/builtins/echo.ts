import { z } from "zod";

import type { ToolDefinition } from "../definition.js";

export const EchoInputSchema = z.strictObject({ text: z.string() });
export type EchoInput = z.infer<typeof EchoInputSchema>;

export function createEchoTool(): ToolDefinition<EchoInput> {
  return {
    name: "echo",
    description: "Return the supplied text without side effects.",
    inputSchema: EchoInputSchema,
    effectClass: "pure",
    approval: "never",
    executionMode: "cooperative_in_process",
    timeoutMs: 5_000,
    execute: async (input) => ({ text: input.text }),
  };
}
