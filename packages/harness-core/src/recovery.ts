import type { RunState, SessionEvent } from "@wi/protocol";
import type {
  AppendTransactionInput,
  ProviderStepRecord,
  RunRecord,
  SessionRecoveryResult,
} from "@wi/storage";

export type RecoveryDecision = "preserve" | "interrupt" | "resume_queued" | "restore_waiting";

export function recoveryDecision(state: RunState): RecoveryDecision {
  switch (state) {
    case "queued":
    case "created":
      return "resume_queued";
    case "running":
    case "cancelling":
      return "interrupt";
    case "waiting_for_user":
      return "restore_waiting";
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return "preserve";
  }
}

export interface RecoveryStorage {
  recover(): Promise<SessionRecoveryResult>;
  getRun(runId: string): Promise<RunRecord | null>;
  getEventById(eventId: string): Promise<SessionEvent | null>;
  getProviderStep(stepId: string): Promise<ProviderStepRecord | null>;
  appendTransaction(input: AppendTransactionInput): Promise<{
    readonly events: readonly SessionEvent[];
    readonly headSequence: number;
  }>;
}

export interface RecoveryResult {
  readonly interruptedRunIds: readonly string[];
  readonly preservedRunIds: readonly string[];
  readonly streamingStepIds: readonly string[];
  readonly startedToolCalls: SessionRecoveryResult["startedToolCalls"];
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export async function recoverSession(options: {
  readonly storage: RecoveryStorage;
  readonly now: () => number;
  readonly eventId: () => string;
  readonly diagnosticId: () => string;
  readonly publishCommitted: (event: SessionEvent) => void;
}): Promise<RecoveryResult> {
  const candidates = await options.storage.recover();
  const interruptedRunIds: string[] = [];
  const preservedRunIds: string[] = [];
  const streamingSteps = new Map<string, ProviderStepRecord>();
  for (const stepId of candidates.interruptedStepIds) {
    const step = await options.storage.getProviderStep(stepId);
    if (step !== null && step.state === "streaming") streamingSteps.set(stepId, step);
  }

  const stepRecovery = (step: ProviderStepRecord, atMs: number) => ({
    event: {
      eventId: options.eventId(),
      eventType: "provider.step.interrupted" as const,
      createdAtMs: atMs,
      data: {
        eventVersion: 1 as const,
        runId: step.runId,
        stepId: step.stepId,
        code: "provider.incomplete" as const,
        message: "Provider streaming could not be safely resumed after restart.",
        diagnosticId: options.diagnosticId(),
      },
    },
    projection: {
      kind: "providerStep.put" as const,
      stepId: step.stepId,
      expectedState: "streaming",
      runId: step.runId,
      stepIndex: step.stepIndex,
      state: "interrupted",
      startedAtMs: step.startedAtMs,
      completedAtMs: atMs,
      responseId: step.responseId,
      errorCategory: "provider.incomplete",
      errorMessage: "Provider streaming could not be safely resumed after restart.",
    },
  });

  for (const runId of candidates.interruptedRunIds) {
    const run = await options.storage.getRun(runId);
    if (run === null || recoveryDecision(run.state) !== "interrupt") {
      if (run !== null) preservedRunIds.push(runId);
      continue;
    }
    const atMs = options.now();
    const runSteps = [...streamingSteps.values()].filter((step) => step.runId === runId);
    const recoveredSteps = runSteps.map((step) => stepRecovery(step, atMs));
    const recoveryEvents = [
      ...recoveredSteps.map((step) => step.event),
      {
        eventId: options.eventId(),
        eventType: "run.interrupted" as const,
        createdAtMs: atMs,
        data: {
          eventVersion: 1 as const,
          runId,
          code: "provider.incomplete" as const,
          message: "Active work could not be safely resumed after restart.",
          diagnosticId: options.diagnosticId(),
        },
      },
    ];
    try {
      const committed = await options.storage.appendTransaction({
        events: recoveryEvents,
        projections: [
          ...recoveredSteps.map((step) => step.projection),
          {
            kind: "run.state",
            runId,
            expectedState: run.state,
            nextState: "interrupted",
            startedAtMs: run.startedAtMs,
            completedAtMs: atMs,
            cancelledAtMs: run.cancelledAtMs,
            failureCategory: "provider.incomplete",
            failureMessage: "Active work could not be safely resumed after restart.",
            activeProviderStepId: run.activeProviderStepId,
          },
          {
            kind: "run.pendingInteractions.cancel",
            runId,
            cancelledAtMs: atMs,
          },
        ],
      });
      for (const event of committed.events) options.publishCommitted(event);
      for (const step of runSteps) streamingSteps.delete(step.stepId);
      interruptedRunIds.push(runId);
    } catch (error) {
      const [current, ...storedEvents] = await Promise.all([
        options.storage.getRun(runId),
        ...recoveryEvents.map((event) => options.storage.getEventById(event.eventId)),
      ]);
      const committedEvents = storedEvents.filter((event): event is SessionEvent => event !== null);
      const eventsMatch = committedEvents.every((event, index) => {
        const expected = recoveryEvents[index];
        return expected !== undefined &&
          event.eventId === expected.eventId &&
          event.eventType === expected.eventType;
      });
      if (
        committedEvents.length === recoveryEvents.length &&
        eventsMatch &&
        current?.state === "interrupted"
      ) {
        for (const event of committedEvents) options.publishCommitted(event);
        for (const step of runSteps) streamingSteps.delete(step.stepId);
        interruptedRunIds.push(runId);
        continue;
      }
      if (
        hasCode(error, "session.invalid_transition") &&
        current !== null &&
        recoveryDecision(current.state) === "preserve"
      ) {
        preservedRunIds.push(runId);
        continue;
      }
      throw error;
    }
  }

  for (const step of streamingSteps.values()) {
    const atMs = options.now();
    const recovered = stepRecovery(step, atMs);
    try {
      const committed = await options.storage.appendTransaction({
        events: [recovered.event],
        projections: [recovered.projection],
      });
      for (const event of committed.events) options.publishCommitted(event);
    } catch (error) {
      const [current, storedEvent] = await Promise.all([
        options.storage.getProviderStep(step.stepId),
        options.storage.getEventById(recovered.event.eventId),
      ]);
      if (
        storedEvent?.eventId === recovered.event.eventId &&
        storedEvent.eventType === recovered.event.eventType &&
        current !== null &&
        current.state !== "streaming"
      ) {
        options.publishCommitted(storedEvent);
        continue;
      }
      if (
        hasCode(error, "session.invalid_transition") &&
        current !== null &&
        current.state !== "streaming"
      ) {
        continue;
      }
      throw error;
    }
  }

  return {
    interruptedRunIds,
    preservedRunIds,
    streamingStepIds: candidates.interruptedStepIds,
    startedToolCalls: candidates.startedToolCalls,
  };
}
