import type { ToolDefinition } from "../definition.js";
import { EchoInputSchema, type EchoInput } from "./echo.js";

export function createGuardedEchoTool(): ToolDefinition<EchoInput> {
  return {
    name: "guarded_echo",
    description: "Return the supplied text after explicit user approval.",
    inputSchema: EchoInputSchema,
    effectClass: "pure",
    approval: "always",
    executionMode: "cooperative_in_process",
    timeoutMs: 5_000,
    execute: async (input) => ({ text: input.text }),
  };
}
