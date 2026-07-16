import type {
  RunState,
  SessionEvent,
  ToolEffectClass,
  ToolExecutionState,
} from "@wi/protocol";
import type {
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  ProviderStepRecord,
  RunMessageRecord,
  RunRecord,
  SessionRecoveryResult,
  ToolExecutionRecord,
} from "@wi/storage";

import {
  EventReconciliationIntegrityError,
  reconcileCommittedEventBatch,
} from "./event-reconciliation.js";
import { assertCurrentToolEffectClass, ToolIdentityError } from "./run-policy.js";

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
  inspectAppendTransaction(input: AppendTransactionInput): Promise<AppendTransactionInspection>;
  getProviderStep(stepId: string): Promise<ProviderStepRecord | null>;
  getToolExecution?(callId: string): Promise<ToolExecutionRecord | null>;
  getToolExecutionsForStep?(stepId: string): Promise<readonly ToolExecutionRecord[]>;
  getStreamingMessagesForStep?(stepId: string): Promise<readonly RunMessageRecord[]>;
  appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult>;
}

export interface RecoveryResult {
  readonly interruptedRunIds: readonly string[];
  readonly preservedRunIds: readonly string[];
  readonly streamingStepIds: readonly string[];
  readonly startedToolCalls: SessionRecoveryResult["startedToolCalls"];
  readonly outcomeUnknownRunIds: readonly string[];
}

interface StartedToolDecision {
  readonly tool: ToolExecutionRecord;
  readonly compatible: boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

async function reconcileRecoveryEvents(options: {
  readonly sessionId: string;
  readonly storage: RecoveryStorage;
  readonly transaction: AppendTransactionInput;
}): Promise<AppendTransactionResult | null> {
  const inspection = await options.storage.inspectAppendTransaction(options.transaction);
  return reconcileCommittedEventBatch(
    options.sessionId,
    options.transaction.events,
    inspection.storedEvents,
    inspection.headSequence,
    inspection.projectionsApplied,
  );
}

function publishCommitted(
  committed: AppendTransactionResult,
  publish: (event: SessionEvent) => void,
): void {
  for (const event of committed.events) publish(event);
}

export async function recoverSession(options: {
  readonly sessionId: string;
  readonly storage: RecoveryStorage;
  readonly now: () => number;
  readonly eventId: () => string;
  readonly diagnosticId: () => string;
  readonly publishCommitted: (event: SessionEvent) => void;
  readonly resumeToolLoop?: boolean;
  readonly currentToolEffectClass?: (toolName: string) => ToolEffectClass | null;
}): Promise<RecoveryResult> {
  const candidates = await options.storage.recover();
  const interruptedRunIds: string[] = [];
  const preservedRunIds: string[] = [];
  const streamingSteps = new Map<string, ProviderStepRecord>();
  for (const stepId of candidates.interruptedStepIds) {
    const step = await options.storage.getProviderStep(stepId);
    if (step !== null && step.state === "streaming") streamingSteps.set(stepId, step);
  }

  const startedToolsByRun = new Map<string, StartedToolDecision[]>();
  if (candidates.startedToolCalls.length > 0 && options.storage.getToolExecution === undefined) {
    throw new EventReconciliationIntegrityError(
      "Started tool recovery requires durable ledger reads",
    );
  }
  for (const candidate of candidates.startedToolCalls) {
    const tool = await options.storage.getToolExecution?.(candidate.callId);
    if (tool === null || tool === undefined || tool.state !== "started") continue;
    let compatible = true;
    try {
      assertCurrentToolEffectClass(
        tool,
        options.currentToolEffectClass?.(tool.toolName) ?? null,
      );
    } catch (error) {
      if (!(error instanceof ToolIdentityError)) throw error;
      compatible = false;
    }
    const tools = startedToolsByRun.get(tool.runId) ?? [];
    tools.push({ tool, compatible });
    startedToolsByRun.set(tool.runId, tools);
  }
  for (const tools of startedToolsByRun.values()) {
    tools.sort((left, right) => left.tool.callId.localeCompare(right.tool.callId));
  }
  const outcomeUnknownRunIds = new Set(candidates.outcomeUnknownRunIds);
  const recoveryRunIds = [
    ...new Set([...candidates.interruptedRunIds, ...candidates.outcomeUnknownRunIds]),
  ].sort();

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

  for (const runId of recoveryRunIds) {
    const run = await options.storage.getRun(runId);
    if (run === null) continue;
    const decision = recoveryDecision(run.state);
    const hasOutcomeUnknown = outcomeUnknownRunIds.has(runId);
    const mustInterrupt =
      decision === "interrupt" || (hasOutcomeUnknown && decision !== "preserve");
    if (!mustInterrupt) {
      preservedRunIds.push(runId);
      continue;
    }

    const runSteps = [...streamingSteps.values()].filter((step) => step.runId === runId);
    const startedTools = startedToolsByRun.get(runId) ?? [];
    const canRetryEveryStartedTool = startedTools.every(
      ({ tool, compatible }) => compatible && tool.effectClass === "pure",
    );
    const canResume =
      options.resumeToolLoop === true &&
      run.state === "running" &&
      runSteps.length === 0 &&
      !hasOutcomeUnknown &&
      canRetryEveryStartedTool;

    if (canResume) {
      if (startedTools.length > 0) {
        const atMs = options.now();
        const transaction: AppendTransactionInput = {
          events: startedTools.map(({ tool }) => ({
            eventId: options.eventId(),
            eventType: "tool.execution.recovered",
            createdAtMs: atMs,
            data: {
              eventVersion: 1,
              runId: tool.runId,
              callId: tool.callId,
              attemptCount: tool.attemptCount,
            },
          })),
          projections: startedTools.map(({ tool }) => ({
            kind: "toolExecution.put" as const,
            callId: tool.callId,
            expectedState: "started" as const,
            runId: tool.runId,
            stepId: tool.stepId,
            toolName: tool.toolName,
            argumentsJson: tool.argumentsJson,
            argumentsHash: tool.argumentsHash,
            effectClass: tool.effectClass,
            state: "requested" as const,
            attemptCount: tool.attemptCount,
            requestedAtMs: tool.requestedAtMs,
            startedAtMs: null,
            completedAtMs: null,
            result: null,
            error: null,
          })),
        };
        let committed: AppendTransactionResult;
        try {
          committed = await options.storage.appendTransaction(transaction);
        } catch (operationError) {
          const reconciled = await reconcileRecoveryEvents({
            sessionId: options.sessionId,
            storage: options.storage,
            transaction,
          });
          if (reconciled === null) throw operationError;
          const currentTools = await Promise.all(
            startedTools.map(({ tool }) => options.storage.getToolExecution?.(tool.callId)),
          );
          if (currentTools.some((tool) => tool?.state !== "requested")) {
            throw new EventReconciliationIntegrityError(
              "Recovered pure-tool events do not match durable ledger projections",
            );
          }
          committed = reconciled;
        }
        publishCommitted(committed, options.publishCommitted);
      }
      preservedRunIds.push(runId);
      continue;
    }

    const atMs = options.now();
    const recoveredSteps = await Promise.all(runSteps.map((step) => stepRecovery(step, atMs)));
    const incompatibleTool = startedTools.some(({ compatible }) => !compatible);
    const ambiguousEffect =
      hasOutcomeUnknown || startedTools.some(({ tool }) => tool.effectClass !== "pure");
    let interruptionCode:
      | "provider.incomplete"
      | "provider.protocol_error"
      | "tool.outcome_unknown" = "provider.incomplete";
    let interruptionMessage = "Active work could not be safely resumed after restart.";
    if (ambiguousEffect) {
      interruptionCode = "tool.outcome_unknown";
      interruptionMessage = "A non-idempotent tool outcome could not be proven after restart.";
    } else if (incompatibleTool) {
      interruptionCode = "provider.protocol_error";
      interruptionMessage =
        "A durable tool call no longer matches its registered effect classification.";
    }

    const toolEvents: AppendTransactionInput["events"] = [];
    const toolProjections: NonNullable<AppendTransactionInput["projections"]> = [];
    const expectedToolStates = new Map<string, ToolExecutionState>();
    for (const { tool, compatible } of startedTools) {
      // Past effect ambiguity comes from the durable class, even if today's definition changed.
      const outcomeUnknown = tool.effectClass !== "pure";
      let code:
        | "provider.protocol_error"
        | "provider.incomplete"
        | "tool.outcome_unknown" = "provider.protocol_error";
      let message = "The registered tool effect class changed after this call was persisted.";
      let state: ToolExecutionState = "failed";
      if (outcomeUnknown) {
        code = "tool.outcome_unknown";
        message = "A non-idempotent tool stopped before its outcome was committed.";
        state = "outcome_unknown";
      } else if (compatible) {
        code = "provider.incomplete";
        message = "A pure tool was not retried because its run must be interrupted.";
      }
      expectedToolStates.set(tool.callId, state);
      toolEvents.push(
        outcomeUnknown
          ? {
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
            }
          : {
              eventId: options.eventId(),
              eventType: "tool.execution.failed",
              createdAtMs: atMs,
              data: {
                eventVersion: 1,
                runId: tool.runId,
                callId: tool.callId,
                code,
                message,
                diagnosticId: options.diagnosticId(),
              },
            },
      );
      toolProjections.push({
        kind: "toolExecution.put",
        callId: tool.callId,
        expectedState: "started",
        runId: tool.runId,
        stepId: tool.stepId,
        toolName: tool.toolName,
        argumentsJson: tool.argumentsJson,
        argumentsHash: tool.argumentsHash,
        effectClass: tool.effectClass,
        state,
        attemptCount: tool.attemptCount,
        requestedAtMs: tool.requestedAtMs,
        startedAtMs: tool.startedAtMs,
        completedAtMs: atMs,
        result: null,
        error: { code, message },
      });
    }

    const recoveryEvents: AppendTransactionInput["events"] = [
      ...recoveredSteps.map((step) => step.event),
      ...toolEvents,
      {
        eventId: options.eventId(),
        eventType: "run.interrupted",
        createdAtMs: atMs,
        data: {
          eventVersion: 1,
          runId,
          code: interruptionCode,
          message: interruptionMessage,
          diagnosticId: options.diagnosticId(),
        },
      },
    ];
    const transaction: AppendTransactionInput = {
      events: recoveryEvents,
      projections: [
        ...recoveredSteps.flatMap((step) => step.projections),
        ...toolProjections,
        ...(decision === "resume_queued"
          ? [
              {
                // Normalize this impossible persisted state only inside the atomic interruption.
                kind: "run.state" as const,
                runId,
                expectedState: run.state,
                nextState: "running" as const,
                startedAtMs: run.startedAtMs ?? atMs,
                completedAtMs: null,
                cancelledAtMs: run.cancelledAtMs,
                failureCategory: null,
                failureMessage: null,
                activeProviderStepId: run.activeProviderStepId,
              },
            ]
          : []),
        {
          kind: "run.state",
          runId,
          expectedState: decision === "resume_queued" ? "running" : run.state,
          nextState: "interrupted",
          startedAtMs: run.startedAtMs ?? atMs,
          completedAtMs: atMs,
          cancelledAtMs: run.cancelledAtMs,
          failureCategory: interruptionCode,
          failureMessage: interruptionMessage,
          activeProviderStepId: null,
        },
        { kind: "run.pendingInteractions.cancel", runId, cancelledAtMs: atMs },
      ],
    };

    try {
      const committed = await options.storage.appendTransaction(transaction);
      publishCommitted(committed, options.publishCommitted);
      for (const step of runSteps) streamingSteps.delete(step.stepId);
      interruptedRunIds.push(runId);
    } catch (operationError) {
      const current = await options.storage.getRun(runId);
      let reconciled: AppendTransactionResult | null = null;
      try {
        reconciled = await reconcileRecoveryEvents({
          sessionId: options.sessionId,
          storage: options.storage,
          transaction,
        });
      } catch (error) {
        if (error instanceof EventReconciliationIntegrityError) throw error;
        throw operationError;
      }
      if (reconciled !== null && current?.state === "interrupted") {
        const currentTools = await Promise.all(
          [...expectedToolStates].map(async ([callId, expectedState]) => ({
            expectedState,
            tool: await options.storage.getToolExecution?.(callId),
          })),
        );
        if (currentTools.some(({ tool, expectedState }) => tool?.state !== expectedState)) {
          throw new EventReconciliationIntegrityError(
            "Unsafe recovery events do not match durable ledger projections",
          );
        }
        publishCommitted(reconciled, options.publishCommitted);
        for (const step of runSteps) streamingSteps.delete(step.stepId);
        interruptedRunIds.push(runId);
        continue;
      }
      if (
        hasCode(operationError, "session.invalid_transition") &&
        current !== null &&
        recoveryDecision(current.state) === "preserve"
      ) {
        preservedRunIds.push(runId);
        continue;
      }
      throw operationError;
    }
  }

  for (const step of streamingSteps.values()) {
    const atMs = options.now();
    const recovered = await stepRecovery(step, atMs);
    const transaction: AppendTransactionInput = {
      events: [recovered.event],
      projections: recovered.projections,
    };
    try {
      const committed = await options.storage.appendTransaction(transaction);
      publishCommitted(committed, options.publishCommitted);
    } catch (operationError) {
      const [current, reconciled] = await Promise.all([
        options.storage.getProviderStep(step.stepId),
        reconcileRecoveryEvents({
          sessionId: options.sessionId,
          storage: options.storage,
          transaction,
        }),
      ]);
      if (reconciled !== null && current !== null && current.state !== "streaming") {
        publishCommitted(reconciled, options.publishCommitted);
        continue;
      }
      if (
        hasCode(operationError, "session.invalid_transition") &&
        current !== null &&
        current.state !== "streaming"
      ) {
        continue;
      }
      throw operationError;
    }
  }

  return {
    interruptedRunIds,
    preservedRunIds,
    streamingStepIds: candidates.interruptedStepIds,
    startedToolCalls: candidates.startedToolCalls,
    outcomeUnknownRunIds: candidates.outcomeUnknownRunIds,
  };
}
