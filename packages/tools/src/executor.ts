import type { CanonicalJsonValue } from "@wi/protocol";

import type { ToolExecutionContext } from "./definition.js";
import type { ValidatedToolCall } from "./registry.js";

export interface ToolTimer {
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

const systemTimer: ToolTimer = {
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export class ToolTimeoutError extends Error {
  readonly code = "tool.timeout";

  constructor(readonly timeoutMs: number) {
    super(`Tool execution exceeded ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export class ToolExecutor {
  private readonly timer: ToolTimer;
  private readonly onExecutionStart: ((context: ToolExecutionContext) => void) | undefined;

  constructor(options: {
    readonly timer?: ToolTimer;
    readonly onExecutionStart?: (context: ToolExecutionContext) => void;
  } = {}) {
    this.timer = options.timer ?? systemTimer;
    this.onExecutionStart = options.onExecutionStart;
  }

  async execute(
    call: ValidatedToolCall,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<CanonicalJsonValue> {
    signal.throwIfAborted();
    const scope = new AbortController();
    const onParentAbort = (): void => scope.abort(abortReason(signal));
    signal.addEventListener("abort", onParentAbort, { once: true });
    const timeout = new ToolTimeoutError(call.definition.timeoutMs);
    const cancelTimer = this.timer.schedule(call.definition.timeoutMs, () => scope.abort(timeout));

    try {
      this.onExecutionStart?.(context);
      const execution = Promise.resolve(
        call.definition.execute(call.input, context, scope.signal),
      );
      // Aborting asks the tool to stop; it is not proof that the in-process effect stopped.
      try {
        const result = await execution;
        if (scope.signal.aborted) throw abortReason(scope.signal);
        return result;
      } catch (error) {
        if (scope.signal.aborted) throw abortReason(scope.signal);
        throw error;
      }
    } finally {
      cancelTimer();
      signal.removeEventListener("abort", onParentAbort);
    }
  }
}
