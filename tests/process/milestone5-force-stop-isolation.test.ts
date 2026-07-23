import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { WiRuntime } from "../../apps/server/src/composition.js";
import {
  RealServerHarness,
  type RealServerProcess,
  type ServerProcessMessage,
} from "@wi/test-support";

const fixturePath = fileURLToPath(
  new URL("./milestone5-force-stop-isolation-fixture.mjs", import.meta.url),
);
const harnesses = new Set<RealServerHarness>();

type ProbeMode = "provider" | "tool";
interface SemaphoreSnapshot {
  readonly active: number;
  readonly accepting: boolean;
}
interface ProbeMessage extends ServerProcessMessage {
  readonly mode: ProbeMode;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly eventType?: string;
  readonly sequence?: number;
  readonly activityCount?: number;
  readonly fulfilled?: boolean;
  readonly errorName?: string | null;
  readonly errorMessage?: string | null;
  readonly runState?: string | null;
  readonly serverAddress?: unknown;
  readonly resourceHandleActive?: boolean;
  readonly scheduler?: {
    readonly provider: SemaphoreSnapshot;
    readonly tool: SemaphoreSnapshot;
  };
  readonly unhandledRejections?: readonly string[];
}

function probeMessage(value: ServerProcessMessage): ProbeMessage {
  return value as ProbeMessage;
}

async function waitForRecoveredRun(
  runtime: WiRuntime,
  sessionId: string,
  runId: string,
): Promise<void> {
  const session = await runtime.storage.openSession(sessionId);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await session.getRun(runId);
    if (run !== null && ["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Recovered run ${runId} did not become terminal`);
}

async function verifyPureToolRestart(
  processHandle: RealServerProcess,
  homeDirectory: string,
  started: ProbeMessage,
): Promise<void> {
  const sessionId = started.sessionId;
  const runId = started.runId;
  if (sessionId === undefined || runId === undefined) {
    throw new Error("Tool probe did not report its durable identities");
  }
  const runtime = new WiRuntime({ homeDirectory });
  try {
    await runtime.ready();
    await waitForRecoveredRun(runtime, sessionId, runId);
    const session = await runtime.storage.openSession(sessionId);
    const run = await session.getRun(runId);
    const events = await session.getEventsAfter(0);
    const requested = events.find((event) => event.eventType === "tool.call.requested");
    if (requested?.eventType !== "tool.call.requested") {
      throw new Error("Recovered tool call has no durable request event");
    }
    const execution = await session.getToolExecution(requested.data.callId);
    expect(run?.state).toBe("completed");
    expect(execution).toMatchObject({
      state: "completed",
      effectClass: "pure",
      attemptCount: 2,
    });
    expect(
      events.filter((event) => event.eventType === "tool.execution.outcome_unknown"),
    ).toHaveLength(0);
    expect(processHandle.receivedMessages.some((message) => message.type === "close_result"))
      .toBe(false);
  } finally {
    await runtime.close();
  }
}

afterEach(async () => {
  await Promise.all([...harnesses].map((harness) => harness.cleanup()));
  harnesses.clear();
});

describe("Milestone 5 force-stop isolation probes", () => {
  it.each(["provider", "tool"] as const)(
    "fails closed for a noncooperative %s resource without claiming isolation",
    async (mode) => {
      const harness = await RealServerHarness.create(`wi-h2-${mode}-probe-`);
      harnesses.add(harness);
      const processHandle = await harness.start({
        fixturePath,
        arguments: [mode],
        waitForReady: false,
      });

      const started = probeMessage(await processHandle.waitForMessage("resource_started", 8_000));
      const heldPermit = mode === "provider" ? started.scheduler?.provider : started.scheduler?.tool;
      expect(heldPermit?.active).toBe(1);
      if (mode === "tool") await processHandle.signal("SIGTERM");
      else processHandle.send("shutdown");

      const abortObserved = probeMessage(
        await processHandle.waitForMessage("abort_observed", 2_000),
      );
      const abortPermit =
        mode === "provider"
          ? abortObserved.scheduler?.provider
          : abortObserved.scheduler?.tool;
      expect(abortPermit?.active).toBe(1);

      const postAbort = probeMessage(
        await processHandle.waitForMessage("post_abort_work", 2_000),
      );
      expect(postAbort.resourceHandleActive).toBe(true);
      const postAbortPermit =
        mode === "provider" ? postAbort.scheduler?.provider : postAbort.scheduler?.tool;
      expect(postAbortPermit?.active).toBe(1);

      const exit = await processHandle.waitForExit(8_000);
      expect(exit).toMatchObject({ code: 1, signal: null });
      expect(processHandle.receivedMessages.some((message) => message.type === "run_terminal"))
        .toBe(false);
      expect(
        processHandle.receivedMessages.some((message) => message.type === "post_terminal_work"),
      ).toBe(false);
      expect(processHandle.receivedMessages.some((message) => message.type === "close_result"))
        .toBe(false);
      expect(
        processHandle.receivedMessages.some((message) => message.type === "unhandled_rejection"),
      ).toBe(false);
      expect(exit.stderr).not.toMatch(/Error|Unhandled|AUDIT_/u);

      if (mode === "tool") {
        await verifyPureToolRestart(processHandle, harness.homeDirectory, started);
      }
    },
    30_000,
  );
});
