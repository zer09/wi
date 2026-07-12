import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { RunState, SessionEventType } from "@wi/protocol";
import { SessionStoreManager, type AppendTransactionInput } from "@wi/storage";

const propertySeed = Number.parseInt(process.env.WI_FC_SEED ?? "626262", 10);
const propertyPath = process.env.WI_FC_PATH;
const propertyOptions = {
  numRuns: 15,
  seed: propertySeed,
  ...(propertyPath === undefined ? {} : { path: propertyPath }),
} as const;

const runStates = [
  "created",
  "queued",
  "running",
  "waiting_for_user",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly RunState[];

const allowedNextStates: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ["queued", "running"],
  queued: ["running"],
  running: ["waiting_for_user", "cancelling", "completed", "failed", "interrupted"],
  waiting_for_user: ["running", "cancelling", "failed", "interrupted"],
  cancelling: ["cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

type RunModelOperation =
  | { readonly kind: "valid"; readonly selector: number }
  | { readonly kind: "attempt"; readonly expectedState: RunState; readonly nextState: RunState };

const runModelOperation = fc.oneof(
  fc.record({ kind: fc.constant("valid" as const), selector: fc.nat() }),
  fc.record({
    kind: fc.constant("attempt" as const),
    expectedState: fc.constantFrom(...runStates),
    nextState: fc.constantFrom(...runStates),
  }),
);

function transitionInput(
  sequence: number,
  expectedState: RunState,
  nextState: RunState,
): AppendTransactionInput {
  let eventType: SessionEventType;
  switch (nextState) {
    case "running":
      eventType = "run.started";
      break;
    case "waiting_for_user":
      eventType = "run.waiting_for_user";
      break;
    case "cancelling":
      eventType = "run.cancel.requested";
      break;
    case "completed":
      eventType = "run.completed";
      break;
    case "failed":
      eventType = "run.failed";
      break;
    case "cancelled":
      eventType = "run.cancelled";
      break;
    case "interrupted":
      eventType = "run.interrupted";
      break;
    default:
      // Invalid attempts still need a valid canonical event so projection rollback is exercised.
      eventType = "run.started";
      break;
  }
  const failure =
    nextState === "failed" || nextState === "interrupted"
      ? { code: "session.invalid_transition" as const, message: "model", diagnosticId: "err_model" }
      : {};
  const waiting =
    nextState === "waiting_for_user"
      ? { reason: "input" as const, inputId: "input_model" }
      : {};
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(nextState);
  return {
    events: [
      {
        eventId: `evt_runModel${sequence}`,
        eventType,
        createdAtMs: 2_000 + sequence,
        data: { eventVersion: 1, runId: "run_model", ...failure, ...waiting },
      },
    ],
    projections: [
      {
        kind: "run.state",
        runId: "run_model",
        expectedState,
        nextState,
        startedAtMs: 2_000,
        completedAtMs: terminal ? 2_000 + sequence : null,
        cancelledAtMs: nextState === "cancelled" ? 2_000 + sequence : null,
        failureCategory: nextState === "failed" || nextState === "interrupted" ? "model" : null,
        failureMessage: nextState === "failed" || nextState === "interrupted" ? "model" : null,
        activeProviderStepId: null,
      },
    ],
  };
}

async function checkHistory(operations: readonly RunModelOperation[]): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-run-state-property-"));
  const storage = new SessionStoreManager({
    homeDirectory,
    ids: { sessionId: () => "ses_runModel", eventId: () => "evt_runModelCreated" },
    now: () => 1_000,
    sessionWorkers: { size: 1 },
  });
  try {
    const created = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_runModelCreate",
      method: "session.create",
      params: { title: "Run model" },
    });
    const session = await storage.openSession(created.session.sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_runModelProjection",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId: "run_model" },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_model",
          state: "created",
          providerId: "fake",
          providerConfig: { scenario: "model" },
          createdAtMs: 2_000,
          startedAtMs: null,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
      ],
    });

    let currentState: RunState = "created";
    let sequence = 1;
    for (const operation of operations) {
      const validNextStates: readonly RunState[] = allowedNextStates[currentState];
      const expectedState: RunState =
        operation.kind === "valid" ? currentState : operation.expectedState;
      const nextState: RunState =
        operation.kind === "valid"
          ? (validNextStates[operation.selector % Math.max(1, validNextStates.length)] ?? currentState)
          : operation.nextState;
      const shouldAccept =
        expectedState === currentState && allowedNextStates[currentState].includes(nextState);
      const head = await session.getHeadSequence();
      const append = session.appendTransaction(
        transitionInput(sequence, expectedState, nextState),
      );

      if (shouldAccept) {
        await expect(append).resolves.toMatchObject({ headSequence: head + 1 });
        currentState = nextState;
        await expect(session.getRun("run_model")).resolves.toMatchObject({ state: currentState });
      } else {
        await expect(append).rejects.toMatchObject({ code: "session.invalid_transition" });
        await expect(session.getHeadSequence()).resolves.toBe(head);
        await expect(session.getRun("run_model")).resolves.toMatchObject({ state: currentState });
      }
      sequence += 1;
    }
  } finally {
    await Promise.allSettled([storage.close()]);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function assertRunStateProperty(): Promise<void> {
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(runModelOperation, { minLength: 1, maxLength: 10 }),
        checkHistory,
      ),
      propertyOptions,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const minimizedPath = /path: "([^"]*)"/i.exec(message)?.[1];
    const pathArgument = minimizedPath === undefined ? "" : ` WI_FC_PATH=${minimizedPath}`;
    throw new Error(
      `storage run state model > matches valid and invalid generated CAS histories\n${message}\nReproduction command: WI_FC_SEED=${propertySeed}${pathArgument} pnpm test:property`,
      { cause: error },
    );
  }
}

describe("storage run state model", () => {
  it("matches valid and invalid generated CAS histories", assertRunStateProperty, 60_000);
});
