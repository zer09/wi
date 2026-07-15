import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolExecutor, ToolTimeoutError, type ToolTimer } from "./executor.js";
import { isAllowedToolTransition, isTerminalToolState } from "./ledger.js";
import { ToolRegistry, ToolRegistryError } from "./registry.js";
import { createBuiltinToolRegistry } from "./index.js";

describe("tool registry and executor", () => {
  it("owns schemas, effects, and approval policy", () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get("echo")).toMatchObject({
      effectClass: "pure",
      approval: "never",
      executionMode: "cooperative_in_process",
    });
    expect(registry.get("guarded_echo")).toMatchObject({
      effectClass: "pure",
      approval: "always",
      executionMode: "cooperative_in_process",
    });
    expect(registry.get("delay")).toMatchObject({
      effectClass: "pure",
      approval: "never",
      executionMode: "cooperative_in_process",
    });
    expect(() => registry.validate("missing", "{}")).toThrow(ToolRegistryError);
    expect(() => registry.validate("echo", "{}"))
      .toThrow("input schema");
  });

  it.each([
    ["oversized", `{"text":"${"x".repeat(70_000)}"}`],
    ["deeply nested", `${"[".repeat(40)}0${"]".repeat(40)}`],
    ["overlong string", `{"text":"${"x".repeat(17_000)}"}`],
    ["oversized collection", JSON.stringify(Array.from({ length: 257 }, () => 0))],
  ])("rejects %s arguments before schema validation", (_case, argumentsJson) => {
    const registry = createBuiltinToolRegistry();
    expect(() => registry.validate("echo", argumentsJson)).toThrow(ToolRegistryError);
    try {
      registry.validate("echo", argumentsJson);
    } catch (error) {
      expect(error).toMatchObject({ code: "tool.invalid_arguments" });
    }
  });

  it("executes deterministic echo through an injected counter", async () => {
    const registry = createBuiltinToolRegistry();
    const starts: string[] = [];
    const executor = new ToolExecutor({ onExecutionStart: ({ callId }) => starts.push(callId) });
    const call = registry.validate("echo", '{"text":"hello"}');

    await expect(
      executor.execute(
        call,
        {
          sessionId: "ses_tool",
          runId: "run_tool",
          stepId: "step_tool",
          callId: "call_tool",
          now: () => 1,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "hello" });
    expect(starts).toEqual(["call_tool"]);
  });

  it("does not settle cancellation until asynchronous tool cleanup finishes", async () => {
    let signalStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseCleanup = (): void => {};
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let underlyingActive = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "controlled_cleanup",
      description: "Waits for explicit cancellation cleanup",
      inputSchema: z.strictObject({}),
      effectClass: "pure",
      approval: "never",
      executionMode: "cooperative_in_process",
      timeoutMs: 60_000,
      execute: async (_input, _context, signal) => {
        underlyingActive = true;
        signalStarted();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        await cleanup;
        underlyingActive = false;
        throw signal.reason;
      },
    });
    const executor = new ToolExecutor();
    const parent = new AbortController();
    const execution = executor.execute(
      registry.validate("controlled_cleanup", "{}"),
      {
        sessionId: "ses_cleanup",
        runId: "run_cleanup",
        stepId: "step_cleanup",
        callId: "call_cleanup",
        now: () => 1,
      },
      parent.signal,
    );
    await started;

    parent.abort(new Error("cancel controlled tool"));
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(underlyingActive).toBe(true);

    releaseCleanup();
    await expect(execution).rejects.toThrow("cancel controlled tool");
    expect(underlyingActive).toBe(false);
  });

  it("the asynchronous built-in delay settles cooperatively on timeout", async () => {
    let fireTimeout = (): void => {};
    const timer: ToolTimer = {
      schedule: (_delayMs, callback) => {
        fireTimeout = callback;
        return () => undefined;
      },
    };
    let signalWaiterStarted = (): void => {};
    const waiterStarted = new Promise<void>((resolve) => {
      signalWaiterStarted = resolve;
    });
    const registry = createBuiltinToolRegistry({
      delayWaiter: {
        wait: async (_input, signal) => {
          signalWaiterStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const execution = new ToolExecutor({ timer }).execute(
      registry.validate("delay", '{"key":"timeout","milliseconds":1000}'),
      {
        sessionId: "ses_delayTimeout",
        runId: "run_delayTimeout",
        stepId: "step_delayTimeout",
        callId: "call_delayTimeout",
        now: () => 1,
      },
      new AbortController().signal,
    );
    await waiterStarted;

    fireTimeout();
    await expect(execution).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("treats timeout as cooperative cancellation and never claims early isolation", async () => {
    let fireTimeout = (): void => {};
    const timer: ToolTimer = {
      schedule: (_delayMs, callback) => {
        fireTimeout = callback;
        return () => undefined;
      },
    };
    let signalStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseTool = (): void => {};
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolSignal: AbortSignal | undefined;
    const echo = createBuiltinToolRegistry().get("echo");
    if (echo === null) throw new Error("Echo definition missing");
    const registry = new ToolRegistry();
    registry.register({
      ...echo,
      name: "non_cooperative_timeout",
      timeoutMs: 10,
      execute: async (_input, _context, signal) => {
        toolSignal = signal;
        signalStarted();
        await toolGate;
        return { released: true };
      },
    });
    const execution = new ToolExecutor({ timer }).execute(
      registry.validate("non_cooperative_timeout", '{"text":"timeout"}'),
      {
        sessionId: "ses_timeout",
        runId: "run_timeout",
        stepId: "step_timeout",
        callId: "call_timeout",
        now: () => 1,
      },
      new AbortController().signal,
    );
    await started;

    fireTimeout();
    expect(toolSignal?.aborted).toBe(true);
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseTool();
    await expect(execution).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("declares terminal non-regression and only the pure recovery edge", () => {
    expect(isAllowedToolTransition("staged", "requested")).toBe(true);
    expect(isAllowedToolTransition("started", "requested")).toBe(true);
    expect(isAllowedToolTransition("completed", "requested")).toBe(false);
    expect(isTerminalToolState("completed")).toBe(true);
    expect(isTerminalToolState("started")).toBe(false);
  });

  it("rejects duplicate definitions", () => {
    const registry = new ToolRegistry();
    const echo = createBuiltinToolRegistry().get("echo");
    if (echo === null) throw new Error("Echo definition missing");
    // Erased definitions remain valid registry inputs at package boundaries.
    registry.register(echo);
    expect(() => registry.register(echo)).toThrow("already registered");
  });
});
