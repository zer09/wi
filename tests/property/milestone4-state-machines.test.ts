import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ToolExecutionState } from "@wi/protocol";
import {
  ToolExecutor,
  ToolRegistry,
  createBuiltinToolRegistry,
  isAllowedToolTransition,
  isTerminalToolState,
} from "@wi/tools";
import {
  canRetryProviderStep,
  providerStepAllowsToolPromotion,
  sameToolCallIdentity,
} from "../../packages/harness-core/src/run-policy.js";
import { RunScheduler } from "../../packages/harness-core/src/scheduler.js";

const propertySeed = Number.parseInt(process.env.WI_M4_FC_SEED ?? "404404", 10);
const propertyPath = process.env.WI_M4_FC_PATH;
const propertyOptions = {
  numRuns: 1_000,
  seed: propertySeed,
  ...(propertyPath === undefined ? {} : { path: propertyPath }),
} as const;

function propertyFailure(error: unknown): Error {
  return new Error(
    `${error instanceof Error ? error.message : String(error)}\n` +
      `Reproduce with: WI_M4_FC_SEED=${propertySeed} WI_M4_FC_PATH=<path> ` +
      "pnpm test:property -- milestone4-state-machines",
    { cause: error },
  );
}

function assertProperty(property: Parameters<typeof fc.assert>[0]): void {
  try {
    fc.assert(property, propertyOptions);
  } catch (error) {
    throw propertyFailure(error);
  }
}

async function assertAsyncProperty(property: Parameters<typeof fc.assert>[0]): Promise<void> {
  try {
    await fc.assert(property, { ...propertyOptions, numRuns: 50 });
  } catch (error) {
    throw propertyFailure(error);
  }
}

const toolStates = [
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
] as const satisfies readonly ToolExecutionState[];

describe("Milestone 4 state-machine properties", () => {
  it("never permits a terminal tool state to regress", () => {
    assertProperty(
      fc.property(
        fc.constantFrom(...toolStates),
        fc.constantFrom(...toolStates),
        (current, next) => {
          if (isTerminalToolState(current)) {
            expect(isAllowedToolTransition(current, next)).toBe(false);
          }
        },
      ),
    );
  });

  it("allows tool promotion only for successful provider completion", () => {
    assertProperty(
      fc.property(
        fc.constantFrom("created", "streaming", "completed", "failed", "cancelled", "interrupted"),
        (state) => {
          expect(providerStepAllowsToolPromotion(state)).toBe(state === "completed");
        },
      ),
    );
  });

  it("deduplicates identical call identity and rejects every changed identity", () => {
    assertProperty(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 20 }),
        (firstText, secondText, changeTool, incomingStepId) => {
          const existing = {
            runId: "run_property",
            stepId: "step_property",
            toolName: "echo",
            argumentsJson: JSON.stringify({ text: firstText }),
            argumentsHash: `hash:${firstText}`,
            effectClass: "pure" as const,
          };
          const incoming = {
            ...existing,
            stepId: incomingStepId,
            toolName: changeTool ? "guarded_echo" : "echo",
            argumentsJson: JSON.stringify({ text: secondText }),
            argumentsHash: `hash:${secondText}`,
          };
          const same = firstText === secondText && !changeTool;
          expect(sameToolCallIdentity(existing, incoming)).toBe(same);
        },
      ),
    );
  });

  it("retries only a transient pre-semantic, pre-tool, non-cancelled attempt within budget", () => {
    assertProperty(
      fc.property(
        fc.record({
          transient: fc.boolean(),
          semanticOutputCommitted: fc.boolean(),
          completedToolCallAccepted: fc.boolean(),
          toolStarted: fc.boolean(),
          cancelled: fc.boolean(),
          attempt: fc.nat({ max: 3 }),
          budget: fc.nat({ max: 3 }),
        }),
        (facts) => {
          const retry = canRetryProviderStep(facts);
          if (retry) {
            expect(facts).toMatchObject({
              transient: true,
              semanticOutputCommitted: false,
              completedToolCallAccepted: false,
              toolStarted: false,
              cancelled: false,
            });
            expect(facts.attempt).toBeLessThan(facts.budget);
          }
        },
      ),
    );
  });

  it("keeps the real tool semaphore occupied for generated asynchronous abort cleanup", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(fc.string({ maxLength: 30 }), async (text) => {
        let signalStarted = (): void => {};
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        let releaseCleanup = (): void => {};
        const cleanup = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        const echo = createBuiltinToolRegistry().get("echo");
        if (echo === null) throw new Error("Echo definition missing");
        const registry = new ToolRegistry();
        registry.register({
          ...echo,
          name: "property_cleanup",
          execute: async (_input, _context, signal) => {
            signalStarted();
            if (!signal.aborted) {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            await cleanup;
            throw signal.reason;
          },
        });
        const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
        const controller = new AbortController();
        const executor = new ToolExecutor();
        const first = scheduler.withToolPermit(controller.signal, () =>
          executor.execute(
            registry.validate("property_cleanup", JSON.stringify({ text })),
            {
              sessionId: "ses_propertyCleanup",
              runId: "run_propertyCleanup",
              stepId: "step_propertyCleanup",
              callId: "call_propertyCleanup",
              now: () => 1,
            },
            controller.signal,
          ),
        );
        await started;
        controller.abort(new Error("generated cancellation"));
        const second = scheduler.withToolPermit(undefined, async () => undefined);
        await Promise.resolve();
        expect(scheduler.state.tool).toMatchObject({ active: 1, queued: 1 });

        releaseCleanup();
        await first.then(
          () => {
            throw new Error("Cancelled tool unexpectedly succeeded");
          },
          () => undefined,
        );
        await second;
        expect(scheduler.state.tool).toMatchObject({ active: 0, queued: 0, available: 1 });
      }),
    );
  });

  it("keeps generated approval, execution, and cancellation traces inside the tool state machine", () => {
    const commands = [
      "approve",
      "deny",
      "cancel",
      "start",
      "complete",
      "fail",
    ] as const;
    assertProperty(
      fc.property(fc.array(fc.constantFrom(...commands), { maxLength: 30 }), (trace) => {
        let state: ToolExecutionState = "awaiting_approval";
        let approvalResolution: "approved" | "denied" | null = null;
        let terminal: ToolExecutionState | null = null;

        for (const command of trace) {
          let next: ToolExecutionState;
          if (command === "approve") next = "approved";
          else if (command === "deny") next = "denied";
          else if (command === "cancel") next = "cancelled";
          else if (command === "start") next = "started";
          else if (command === "complete") next = "completed";
          else next = "failed";
          if (!isAllowedToolTransition(state, next)) continue;

          if (command === "approve" || command === "deny") {
            expect(approvalResolution).toBeNull();
            approvalResolution = command === "approve" ? "approved" : "denied";
          }
          state = next;
          if (isTerminalToolState(state)) {
            expect(terminal).toBeNull();
            terminal = state;
          }
        }
        expect(state).toBe(terminal ?? state);
      }),
    );
  });
});
