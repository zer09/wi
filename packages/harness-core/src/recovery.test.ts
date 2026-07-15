import { describe, expect, it } from "vitest";

import type { ProviderStepState, SessionEvent } from "@wi/protocol";
import type { RunRecord, SessionRecoveryResult } from "@wi/storage";

import { recoverSession, recoveryDecision, type RecoveryStorage } from "./recovery.js";

describe("startup recovery", () => {
  it.each([
    ["queued", "resume_queued"],
    ["running", "interrupt"],
    ["cancelling", "interrupt"],
    ["waiting_for_user", "restore_waiting"],
    ["completed", "preserve"],
    ["failed", "preserve"],
    ["cancelled", "preserve"],
    ["interrupted", "preserve"],
  ] as const)("maps %s to %s", (state, decision) => {
    expect(recoveryDecision(state)).toBe(decision);
  });

  it("cancels pending interactions in the same transaction that terminalizes recovery", async () => {
    let current = run("run_cancellingRecovery", "cancelling");
    let pendingInteractionsCancelled = false;
    const storage: RecoveryStorage = {
      recover: async () => ({
        interruptedRunIds: [current.runId],
        interruptedStepIds: [],
        startedToolCalls: [],
      }),
      getRun: async () => current,
      getEventById: async () => null,
      getProviderStep: async () => null,
      appendTransaction: async (input) => {
        const runState = input.projections?.find((projection) => projection.kind === "run.state");
        pendingInteractionsCancelled =
          input.projections?.some(
            (projection) =>
              projection.kind === "run.pendingInteractions.cancel" &&
              projection.runId === current.runId,
          ) === true;
        if (runState?.kind !== "run.state") throw new Error("missing run transition");
        current = { ...current, state: runState.nextState };
        const events = input.events.map(
          (event, index): SessionEvent =>
            ({
              v: 1,
              kind: "event",
              sessionId: "ses_cancellingRecovery",
              sequence: index + 1,
              eventId: event.eventId,
              eventType: event.eventType,
              createdAtMs: event.createdAtMs,
              data: event.data,
            }) as SessionEvent,
        );
        return { events, headSequence: events.length };
      },
    };

    await recoverSession({
      sessionId: "ses_cancellingRecovery",
      storage,
      now: () => 10,
      eventId: () => "evt_cancellingRecovery",
      diagnosticId: () => "err_cancellingRecovery",
      publishCommitted: () => undefined,
    });

    expect(current.state).toBe("interrupted");
    expect(pendingInteractionsCancelled).toBe(true);
  });

  it("ignores a stale concurrent provider-step recovery after another recovery wins", async () => {
    const interrupted = run("run_stale", "interrupted");
    let providerRead = 0;
    const storage: RecoveryStorage = {
      recover: async () => ({
        interruptedRunIds: ["run_stale"],
        interruptedStepIds: ["step_stale"],
        startedToolCalls: [],
      }),
      getRun: async () => interrupted,
      getEventById: async () => null,
      getProviderStep: async () => {
        providerRead += 1;
        return {
          stepId: "step_stale",
          runId: "run_stale",
          stepIndex: 0,
          state: providerRead === 1 ? "streaming" : "interrupted",
          startedAtMs: 2,
          completedAtMs: providerRead === 1 ? null : 3,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        };
      },
      appendTransaction: async () => {
        throw Object.assign(new Error("stale"), { code: "session.invalid_transition" });
      },
    };
    const published: SessionEvent[] = [];
    await expect(
      recoverSession({
        sessionId: "ses_staleRecovery",
        storage,
        now: () => 10,
        eventId: () => "evt_staleRecovery",
        diagnosticId: () => "err_staleRecovery",
        publishCommitted: (event) => published.push(event),
      }),
    ).resolves.toMatchObject({ interruptedRunIds: [], preservedRunIds: ["run_stale"] });
    expect(providerRead).toBe(2);
    expect(published).toEqual([]);
  });

  it("reconciles recovery that committed before its worker response was lost", async () => {
    let current = run("run_ambiguousRecovery", "running");
    const storedEvents = new Map<string, SessionEvent>();
    let sequence = 0;
    let loseResponse = true;
    const storage: RecoveryStorage = {
      recover: async () => ({
        interruptedRunIds: current.state === "running" ? [current.runId] : [],
        interruptedStepIds: [],
        startedToolCalls: [],
      }),
      getRun: async () => current,
      getEventById: async (eventId) => storedEvents.get(eventId) ?? null,
      getProviderStep: async () => null,
      appendTransaction: async (input) => {
        const transition = input.projections?.find((projection) => projection.kind === "run.state");
        if (transition?.kind !== "run.state") throw new Error("missing run transition");
        current = { ...current, state: transition.nextState };
        const events = input.events.map(
          (value): SessionEvent =>
            ({
              v: 1,
              kind: "event",
              sessionId: "ses_ambiguousRecovery",
              sequence: ++sequence,
              eventId: value.eventId,
              eventType: value.eventType,
              createdAtMs: value.createdAtMs,
              data: value.data,
            }) as SessionEvent,
        );
        for (const event of events) storedEvents.set(event.eventId, event);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("worker response lost after commit");
        }
        return { events, headSequence: sequence };
      },
    };
    const published: SessionEvent[] = [];
    const options = {
      sessionId: "ses_ambiguousRecovery",
      storage,
      now: () => 10,
      eventId: () => "evt_ambiguousRecovery",
      diagnosticId: () => "err_ambiguousRecovery",
      publishCommitted: (event: SessionEvent) => published.push(event),
    };

    await expect(recoverSession(options)).resolves.toMatchObject({
      interruptedRunIds: ["run_ambiguousRecovery"],
    });
    await expect(recoverSession(options)).resolves.toMatchObject({ interruptedRunIds: [] });
    expect(current.state).toBe("interrupted");
    expect(published.map((event) => event.eventId)).toEqual(["evt_ambiguousRecovery"]);
  });

  it("interrupts running work once while preserving terminal and waiting state", async () => {
    const runs = new Map<string, RunRecord>([
      ["run_running", run("run_running", "running")],
      ["run_waiting", run("run_waiting", "waiting_for_user")],
      ["run_completed", run("run_completed", "completed")],
    ]);
    let sequence = 0;
    let stepState: ProviderStepState = "streaming";
    const candidates: SessionRecoveryResult = {
      interruptedRunIds: ["run_running"],
      interruptedStepIds: ["step_streaming"],
      startedToolCalls: [],
    };
    const storage: RecoveryStorage = {
      recover: async () => ({
        ...candidates,
        interruptedRunIds: [...runs.values()]
          .filter((value) => value.state === "running" || value.state === "cancelling")
          .map((value) => value.runId),
      }),
      getRun: async (runId) => runs.get(runId) ?? null,
      getEventById: async () => null,
      getProviderStep: async (stepId) =>
        stepId === "step_streaming"
          ? {
              stepId,
              runId: "run_running",
              stepIndex: 0,
              state: stepState,
              startedAtMs: 2,
              completedAtMs: stepState === "streaming" ? null : 10,
              responseId: null,
              errorCategory: stepState === "streaming" ? null : "provider.incomplete",
              errorMessage: null,
            }
          : null,
      appendTransaction: async (input) => {
        const stepMutation = input.projections?.find(
          (value) => value.kind === "providerStep.put",
        );
        if (stepMutation?.kind === "providerStep.put") stepState = stepMutation.state;
        const mutation = input.projections?.find((value) => value.kind === "run.state");
        if (mutation?.kind !== "run.state") throw new Error("missing transition");
        const current = runs.get(mutation.runId);
        if (current === undefined || current.state !== mutation.expectedState) {
          throw Object.assign(new Error("stale"), { code: "session.invalid_transition" });
        }
        runs.set(mutation.runId, { ...current, state: mutation.nextState });
        const events = input.events.map((value) => ({
          v: 1 as const,
          kind: "event" as const,
          sessionId: "ses_recovery",
          sequence: ++sequence,
          eventId: value.eventId,
          eventType: value.eventType,
          createdAtMs: value.createdAtMs,
          data: value.data,
        } as SessionEvent));
        return { events, headSequence: sequence };
      },
    };
    const published: number[] = [];
    let eventNumber = 0;
    const options = {
      sessionId: "ses_recovery",
      storage,
      now: () => 10,
      eventId: () => `evt_recovery${++eventNumber}`,
      diagnosticId: () => `err_recovery${eventNumber}`,
      publishCommitted: (event: SessionEvent) => published.push(event.sequence),
    };

    await expect(recoverSession(options)).resolves.toMatchObject({
      interruptedRunIds: ["run_running"],
      streamingStepIds: ["step_streaming"],
    });
    await expect(recoverSession(options)).resolves.toMatchObject({ interruptedRunIds: [] });
    expect(runs.get("run_running")?.state).toBe("interrupted");
    expect(runs.get("run_waiting")?.state).toBe("waiting_for_user");
    expect(runs.get("run_completed")?.state).toBe("completed");
    expect(stepState).toBe("interrupted");
    expect(published).toEqual([1, 2]);
  });
});

function run(runId: string, state: RunRecord["state"]): RunRecord {
  return {
    runId,
    state,
    providerId: "fake",
    providerConfig: {},
    createdAtMs: 1,
    startedAtMs: state === "running" ? 2 : null,
    completedAtMs: state === "completed" ? 3 : null,
    cancelledAtMs: null,
    failureCategory: null,
    failureMessage: null,
    activeProviderStepId: state === "running" ? "step_streaming" : null,
  };
}
