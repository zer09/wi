import type { SessionEvent, RunState } from "@wi/protocol";
import type {
  AppendTransactionInput,
  ProviderStepRecord,
  RunMessageRecord,
  RunRecord,
  SessionRecoveryResult,
  ToolExecutionRecord,
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
  getToolExecution?(callId: string): Promise<ToolExecutionRecord | null>;
  getToolExecutionsForStep?(stepId: string): Promise<readonly ToolExecutionRecord[]>;
  getStreamingMessagesForStep?(stepId: string): Promise<readonly RunMessageRecord[]>;
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

async function appendAndPublish(options: {
  readonly storage: RecoveryStorage;
  readonly transaction: AppendTransactionInput;
  readonly publishCommitted: (event: SessionEvent) => void;
}): Promise<void> {
  const committed = await options.storage.appendTransaction(options.transaction);
  for (const event of committed.events) options.publishCommitted(event);
}

export async function recoverSession(options: {
  readonly storage: RecoveryStorage;
  readonly now: () => number;
  readonly eventId: () => string;
  readonly diagnosticId: () => string;
  readonly publishCommitted: (event: SessionEvent) => void;
  readonly resumeToolLoop?: boolean;
}): Promise<RecoveryResult> {
  const candidates = await options.storage.recover();
  const interruptedRunIds: string[] = [];
  const preservedRunIds: string[] = [];
  const streamingSteps = new Map<string, ProviderStepRecord>();
  for (const stepId of candidates.interruptedStepIds) {
    const step = await options.storage.getProviderStep(stepId);
    if (step !== null && step.state === "streaming") streamingSteps.set(stepId, step);
  }
  const runsWithStreamingSteps = new Set([...streamingSteps.values()].map((step) => step.runId));
  const unsafeToolRunIds = new Set<string>();

  if (options.resumeToolLoop === true && options.storage.getToolExecution !== undefined) {
    for (const candidate of candidates.startedToolCalls) {
      const tool = await options.storage.getToolExecution(candidate.callId);
      if (tool === null || tool.state !== "started" || tool.effectClass === null) continue;
      const atMs = options.now();
      if (tool.effectClass === "pure" && !runsWithStreamingSteps.has(tool.runId)) {
        await appendAndPublish({
          storage: options.storage,
          publishCommitted: options.publishCommitted,
          transaction: {
            events: [
              {
                eventId: options.eventId(),
                eventType: "tool.execution.recovered",
                createdAtMs: atMs,
                data: {
                  eventVersion: 1,
                  runId: tool.runId,
                  callId: tool.callId,
                  attemptCount: tool.attemptCount,
                },
              },
            ],
            projections: [
              {
                kind: "toolExecution.put",
                callId: tool.callId,
                expectedState: "started",
                runId: tool.runId,
                stepId: tool.stepId,
                toolName: tool.toolName,
                argumentsJson: tool.argumentsJson,
                argumentsHash: tool.argumentsHash,
                effectClass: tool.effectClass,
                state: "requested",
                attemptCount: tool.attemptCount,
                requestedAtMs: tool.requestedAtMs,
                startedAtMs: null,
                completedAtMs: null,
                result: null,
                error: null,
              },
            ],
          },
        });
      } else {
        unsafeToolRunIds.add(tool.runId);
        const message = "A non-idempotent tool stopped before its outcome was committed.";
        await appendAndPublish({
          storage: options.storage,
          publishCommitted: options.publishCommitted,
          transaction: {
            events: [
              {
                eventId: options.eventId(),
                eventType: "tool.execution.outcome_unknown",
                createdAtMs: atMs,
                data: {
                  eventVersion: 1,
                  runId: tool.runId,
                  callId: tool.callId,
                  code: "tool.outcome_unknown",
                  message,
                  diagnosticId: options.diagnosticId(),
                },
              },
            ],
            projections: [
              {
                kind: "toolExecution.put",
                callId: tool.callId,
                expectedState: "started",
                runId: tool.runId,
                stepId: tool.stepId,
                toolName: tool.toolName,
                argumentsJson: tool.argumentsJson,
                argumentsHash: tool.argumentsHash,
                effectClass: tool.effectClass,
                state: "outcome_unknown",
                attemptCount: tool.attemptCount,
                requestedAtMs: tool.requestedAtMs,
                startedAtMs: tool.startedAtMs,
                completedAtMs: atMs,
                result: null,
                error: { code: "tool.outcome_unknown", message },
              },
            ],
          },
        });
      }
    }
  }

  const stepRecovery = async (step: ProviderStepRecord, atMs: number) => {
    const [stepTools, streamingMessages] = await Promise.all([
      options.storage.getToolExecutionsForStep?.(step.stepId),
      options.storage.getStreamingMessagesForStep?.(step.stepId),
    ]);
    const staged = stepTools?.filter((tool) => tool.state === "staged") ?? [];
    return {
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
      projections: [
        {
          kind: "providerStep.put" as const,
          stepId: step.stepId,
          expectedState: "streaming" as const,
          runId: step.runId,
          stepIndex: step.stepIndex,
          state: "interrupted" as const,
          startedAtMs: step.startedAtMs,
          completedAtMs: atMs,
          responseId: step.responseId,
          errorCategory: "provider.incomplete",
          errorMessage: "Provider streaming could not be safely resumed after restart.",
        },
        ...staged.map((tool) => ({
          kind: "toolExecution.put" as const,
          callId: tool.callId,
          expectedState: "staged" as const,
          runId: tool.runId,
          stepId: tool.stepId,
          toolName: tool.toolName,
          argumentsJson: tool.argumentsJson,
          argumentsHash: tool.argumentsHash,
          effectClass: tool.effectClass,
          state: "discarded" as const,
          attemptCount: tool.attemptCount,
          requestedAtMs: tool.requestedAtMs,
          startedAtMs: tool.startedAtMs,
          completedAtMs: atMs,
          result: tool.result,
          error: { code: "provider.incomplete", message: "Provider step was interrupted." },
        })),
        ...(streamingMessages ?? []).map((message) => ({
          kind: "message.put" as const,
          messageId: message.messageId,
          runId: message.runId,
          role: message.role,
          state: "interrupted",
          createdAtMs: message.createdAtMs,
          completedAtMs: atMs,
        })),
      ],
    };
  };

  for (const runId of candidates.interruptedRunIds) {
    const run = await options.storage.getRun(runId);
    if (run === null || recoveryDecision(run.state) !== "interrupt") {
      if (run !== null) preservedRunIds.push(runId);
      continue;
    }
    const runSteps = [...streamingSteps.values()].filter((step) => step.runId === runId);
    if (
      options.resumeToolLoop === true &&
      run.state === "running" &&
      runSteps.length === 0 &&
      !unsafeToolRunIds.has(runId)
    ) {
      preservedRunIds.push(runId);
      continue;
    }

    const atMs = options.now();
    const recoveredSteps = await Promise.all(runSteps.map((step) => stepRecovery(step, atMs)));
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
          ...recoveredSteps.flatMap((step) => step.projections),
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
            activeProviderStepId: null,
          },
          { kind: "run.pendingInteractions.cancel", runId, cancelledAtMs: atMs },
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
      if (committedEvents.length === recoveryEvents.length && current?.state === "interrupted") {
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
    const recovered = await stepRecovery(step, atMs);
    try {
      const committed = await options.storage.appendTransaction({
        events: [recovered.event],
        projections: recovered.projections,
      });
      for (const event of committed.events) options.publishCommitted(event);
    } catch (error) {
      const [current, storedEvent] = await Promise.all([
        options.storage.getProviderStep(step.stepId),
        options.storage.getEventById(recovered.event.eventId),
      ]);
      if (storedEvent !== null && current !== null && current.state !== "streaming") {
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
