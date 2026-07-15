import type { CanonicalJsonValue, ToolEffectClass } from "@wi/protocol";
import type { ZodType } from "zod";

export type ToolApprovalPolicy = "never" | "always";
export type ToolExecutionMode = "cooperative_in_process";

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly now: () => number;
}

export interface ToolDefinition<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly effectClass: ToolEffectClass;
  readonly approval: ToolApprovalPolicy;
  /**
   * V0.1 tools run in-process and must settle promptly after their signal aborts.
   * timeoutMs requests cooperative cancellation; it is not proof of hard isolation.
   */
  readonly executionMode: ToolExecutionMode;
  readonly timeoutMs: number;
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ) => Promise<CanonicalJsonValue>;
}

export interface AnyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<unknown>;
  readonly effectClass: ToolEffectClass;
  readonly approval: ToolApprovalPolicy;
  readonly executionMode: ToolExecutionMode;
  readonly timeoutMs: number;
  readonly execute: (
    input: unknown,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ) => Promise<CanonicalJsonValue>;
}

export function eraseToolDefinition<TInput>(
  definition: ToolDefinition<TInput>,
): AnyToolDefinition {
  return {
    ...definition,
    inputSchema: definition.inputSchema as ZodType<unknown>,
    execute: (input, context, signal) =>
      definition.execute(input as TInput, context, signal),
  };
}
