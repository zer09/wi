import { z } from "zod";

import type { ToolDefinition } from "../definition.js";

export const DelayInputSchema = z.strictObject({
  key: z.string().min(1),
  milliseconds: z.number().int().nonnegative().max(60_000),
});
export type DelayInput = z.infer<typeof DelayInputSchema>;

export interface DelayWaiter {
  readonly wait: (input: DelayInput, signal: AbortSignal) => Promise<void>;
}

export const systemDelayWaiter: DelayWaiter = {
  wait: (input, signal) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const handle = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, input.milliseconds);
      const onAbort = (): void => {
        clearTimeout(handle);
        reject(signal.reason ?? new DOMException("The delay was aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

export function createDelayTool(waiter: DelayWaiter = systemDelayWaiter): ToolDefinition<DelayInput> {
  return {
    name: "delay",
    description: "Wait for a bounded, cancellable delay.",
    inputSchema: DelayInputSchema,
    effectClass: "pure",
    approval: "never",
    executionMode: "cooperative_in_process",
    timeoutMs: 65_000,
    execute: async (input, _context, signal) => {
      await waiter.wait(input, signal);
      return { key: input.key, milliseconds: input.milliseconds };
    },
  };
}
