import {
  hashCommandContent,
  type ApprovalResolveCommand,
  type ErrorCode,
  type InputRespondCommand,
  type MessageSubmitCommand,
  type RunCancelCommand,
  type RunState,
  RunStateSchema,
  type SessionEvent,
} from "@wi/protocol";
import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionResult,
  PendingApprovalRecord,
  PendingInputRecord,
  ProviderStepRecord,
  RunRecord,
  SessionRecoveryResult,
} from "@wi/storage";

import { ActorMailbox, MailboxClosedError } from "./actor-mailbox.js";
import { CancellationController } from "./cancellation.js";
import type { CommittedEventHub } from "./event-hub.js";
import { recoverSession } from "./recovery.js";
import {
  isTerminalRunState,
  terminalStateForTask,
  type RunTaskTerminalState,
} from "./run-state.js";
import type { RunScheduler } from "./scheduler.js";
import {
  defaultShutdownWait,
  ShutdownTimeoutError,
  type ShutdownWait,
} from "./shutdown.js";

export class SessionActorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SessionActorError";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export interface SessionActorStorage {
  readonly sessionId: string;
  acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult>;
  appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult>;
  getEventById(eventId: string): Promise<SessionEvent | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  getAcceptedCommand(commandId: string): Promise<AcceptedCommandResult | null>;
  getProviderStep(stepId: string): Promise<ProviderStepRecord | null>;
  getNonterminalRuns(): Promise<readonly RunRecord[]>;
  getPendingApprovals(): Promise<readonly PendingApprovalRecord[]>;
  getPendingInputs(): Promise<readonly PendingInputRecord[]>;
  recover(): Promise<SessionRecoveryResult>;
  close?(): Promise<void>;
}

export interface SessionActorIds {
  readonly runId: () => string;
  readonly eventId: () => string;
  readonly messageId: () => string;
  readonly partId: () => string;
  readonly diagnosticId: () => string;
}

export interface RunTaskContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly scheduler: RunScheduler;
}

export interface RunTaskResult {
  readonly state: RunTaskTerminalState;
  readonly code?: ErrorCode;
  readonly message?: string;
  readonly cancellationFailure?: boolean;
}

export type RunTask = (context: RunTaskContext) => Promise<RunTaskResult | void>;

// Settling confirms that the underlying operation has stopped, even if its result promise
// cannot settle. Rejection reports cleanup failure after stop; it must not mean "still running".
// This keeps permit release tied to real operation termination without poisoning the session.
export type CancelRunTask = (
  context: RunTaskContext,
  reason: unknown,
) => void | Promise<void>;

// Settlement must prove that the execution resource was terminated or quarantined. This hook is
// entered only after graceful cancellation times out and must be bounded by its implementation.
export type ForceStopRunTask = (
  context: RunTaskContext,
  reason: unknown,
) => void | Promise<void>;

interface ActiveRun {
  readonly runId: string;
  readonly generation: number;
  readonly scope: CancellationController;
  record: RunRecord;
  context: RunTaskContext | null;
  confirmStopped: ((result: RunTaskResult) => void) | null;
  cancellation: Promise<void> | null;
  task: Promise<void> | null;
}

export interface SessionActorSnapshot {
  readonly sessionId: string;
  readonly activeRunId: string | null;
  readonly activeRunState: RunState | null;
  readonly queuedRunIds: readonly string[];
  readonly subscriberCount: number;
  readonly pendingApprovalCount: number;
  readonly pendingInputCount: number;
  readonly cancellationCleanupCount: number;
  readonly mailboxQueued: number;
  readonly mailboxRunning: boolean;
  readonly recovering: boolean;
  readonly faulted: boolean;
  readonly closed: boolean;
  readonly idle: boolean;
}

export interface SubmitMessageResult {
  readonly acceptance: AcceptedCommandResult;
  readonly runId: string;
  readonly queued: boolean;
}

export interface CancelRunResult {
  readonly state: RunState;
  readonly acceptance?: AcceptedCommandResult;
}

export class SessionActor {
  readonly sessionId: string;
  readonly mailbox = new ActorMailbox();
  private readonly storage: SessionActorStorage;
  private readonly eventHub: CommittedEventHub;
  private readonly scheduler: RunScheduler;
  private readonly ids: SessionActorIds;
  private readonly now: () => number;
  private readonly runTask: RunTask;
  private readonly cancelRunTask: CancelRunTask;
  private readonly forceStopRunTask: ForceStopRunTask;
  private readonly cancellationWait: ShutdownWait;
  private readonly onActivity: (() => void) | undefined;
  private readonly shutdownWait: ShutdownWait;
  private readonly queuedRuns: RunRecord[] = [];
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();
  private readonly pendingInputs = new Map<string, PendingInputRecord>();
  private readonly subscribers = new Set<string>();
  // A run may terminalize first, so the actor retains cleanup until shutdown can safely drain it.
  private readonly cancellationCleanups = new Set<Promise<void>>();
  private activeRun: ActiveRun | null = null;
  private generation = 0;
  private recovering = true;
  private fault: unknown | null = null;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;

  private constructor(options: {
    readonly storage: SessionActorStorage;
    readonly eventHub: CommittedEventHub;
    readonly scheduler: RunScheduler;
    readonly ids: SessionActorIds;
    readonly now: () => number;
    readonly runTask: RunTask;
    readonly cancelRunTask: CancelRunTask;
    readonly forceStopRunTask: ForceStopRunTask;
    readonly cancellationWait?: ShutdownWait;
    readonly onActivity?: () => void;
    readonly shutdownWait?: ShutdownWait;
  }) {
    this.sessionId = options.storage.sessionId;
    this.storage = options.storage;
    this.eventHub = options.eventHub;
    this.scheduler = options.scheduler;
    this.ids = options.ids;
    this.now = options.now;
    this.runTask = options.runTask;
    this.cancelRunTask = options.cancelRunTask;
    this.forceStopRunTask = options.forceStopRunTask;
    this.cancellationWait = options.cancellationWait ?? defaultShutdownWait;
    this.onActivity = options.onActivity;
    this.shutdownWait = options.shutdownWait ?? defaultShutdownWait;
  }

  static async create(options: {
    readonly storage: SessionActorStorage;
    readonly eventHub: CommittedEventHub;
    readonly scheduler: RunScheduler;
    readonly ids: SessionActorIds;
    readonly now: () => number;
    readonly runTask: RunTask;
    readonly cancelRunTask: CancelRunTask;
    readonly forceStopRunTask: ForceStopRunTask;
    readonly cancellationWait?: ShutdownWait;
    readonly onActivity?: () => void;
    readonly shutdownWait?: ShutdownWait;
  }): Promise<SessionActor> {
    const actor = new SessionActor(options);
    try {
      await actor.initialize();
      return actor;
    } catch (error) {
      try {
        await actor.shutdown();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Session actor ${actor.sessionId} initialization and cleanup failed`,
        );
      }
      throw error;
    }
  }

  private publish(events: readonly SessionEvent[]): boolean {
    try {
      for (const event of events) this.eventHub.publishCommitted(event);
      return true;
    } catch (error) {
      // The write is already committed. Quarantine this actor instead of reporting rollback
      // or allowing later commands to mutate a session with an inconsistent live stream.
      this.recordFault(error);
      return false;
    }
  }

  private touch(): void {
    this.onActivity?.();
  }

  private rejectUnavailable<T>(): Promise<T> | null {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (this.fault !== null) {
      return Promise.reject(
        new SessionActorError("session.unavailable", `Session ${this.sessionId} actor is faulted`),
      );
    }
    return null;
  }

  private assertNotFaulted(): void {
    if (this.fault !== null) {
      throw new SessionActorError(
        "session.unavailable",
        `Session ${this.sessionId} actor is faulted`,
      );
    }
  }

  private recordFault(error: unknown): void {
    if (this.fault === null) this.fault = error;
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, error);
    this.touch();
  }

  private postFault(error: unknown): void {
    this.mailbox.post(
      () => this.recordFault(error),
      (mailboxError: unknown) => {
        if (!(mailboxError instanceof MailboxClosedError)) this.recordFault(mailboxError);
      },
    );
  }

  private acceptedRunState(acceptance: AcceptedCommandResult, fallback: RunState): RunState {
    const result = acceptance.result;
    if (result !== null && typeof result === "object" && !Array.isArray(result) && "state" in result) {
      const parsed = RunStateSchema.safeParse(result.state);
      if (parsed.success) return parsed.data;
    }
    return fallback;
  }

  private faultUnresolvedAmbiguousWrite(error: unknown): void {
    if (hasErrorCode(error, "storage.ambiguous_outcome")) this.recordFault(error);
  }

  private async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    try {
      return await this.storage.acceptCommand(input);
    } catch (operationError) {
      let accepted: AcceptedCommandResult | null;
      try {
        accepted = await this.storage.getAcceptedCommand(input.commandId);
      } catch {
        // The durable result is unknown, so later commands must wait for actor reconstruction.
        this.faultUnresolvedAmbiguousWrite(operationError);
        throw operationError;
      }
      if (
        accepted === null ||
        accepted.commandMethod !== input.commandMethod ||
        accepted.payloadHash !== input.payloadHash
      ) {
        throw operationError;
      }

      const events: SessionEvent[] = [];
      for (const expected of input.transaction.events) {
        let event: SessionEvent | null;
        try {
          event = await this.storage.getEventById(expected.eventId);
        } catch {
          this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        if (event === null || event.eventType !== expected.eventType) {
          if (accepted.runId === input.runId) this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        events.push(event);
      }
      return { ...accepted, events };
    }
  }

  private async acceptNoopCancellation(
    command: RunCancelCommand,
    payloadHash: string,
    run: RunRecord,
  ): Promise<CancelRunResult> {
    const acceptance = await this.acceptCommand({
      commandId: command.commandId,
      commandMethod: command.method,
      payloadHash,
      result: { runId: run.runId, state: run.state },
      acceptedAtMs: this.now(),
      runId: run.runId,
      transaction: { events: [], projections: [] },
    });
    this.publish(acceptance.events);
    return { state: this.acceptedRunState(acceptance, run.state), acceptance };
  }

  private async commandIdentity(
    command: RunCancelCommand | ApprovalResolveCommand | InputRespondCommand,
  ): Promise<{ readonly payloadHash: string; readonly duplicate: AcceptedCommandResult | null }> {
    const payloadHash = await hashCommandContent(command);
    const duplicate = await this.storage.getAcceptedCommand(command.commandId);
    if (
      duplicate !== null &&
      (duplicate.commandMethod !== command.method || duplicate.payloadHash !== payloadHash)
    ) {
      throw new SessionActorError(
        "protocol.command_id_conflict",
        `Command ${command.commandId} was reused with different content`,
      );
    }
    return { payloadHash, duplicate };
  }

  private async initialize(): Promise<void> {
    try {
      await recoverSession({
        storage: this.storage,
        now: this.now,
        eventId: this.ids.eventId,
        diagnosticId: this.ids.diagnosticId,
        publishCommitted: (event) => this.eventHub.publishCommitted(event),
      });
      const [runs, approvals, inputs] = await Promise.all([
        this.storage.getNonterminalRuns(),
        this.storage.getPendingApprovals(),
        this.storage.getPendingInputs(),
      ]);
      for (const approval of approvals) this.pendingApprovals.set(approval.approvalId, approval);
      for (const input of inputs) this.pendingInputs.set(input.inputId, input);

      const active = runs.filter(
        (run) => run.state === "running" || run.state === "waiting_for_user" || run.state === "cancelling",
      );
      if (active.length > 1) {
        throw new SessionActorError(
          "session.run_already_active",
          `Session ${this.sessionId} has more than one durable active run`,
        );
      }
      const restored = active[0];
      if (restored !== undefined) {
        this.activeRun = {
          runId: restored.runId,
          generation: ++this.generation,
          scope: new CancellationController(),
          record: restored,
          context: null,
          confirmStopped: null,
          cancellation: null,
          task: null,
        };
      }
      for (const run of runs) {
        if (run.runId !== restored?.runId) this.queuedRuns.push(run);
      }
    } finally {
      this.recovering = false;
    }

    if (this.activeRun === null && this.queuedRuns.length > 0) {
      await this.mailbox.enqueue(async () => this.startNextRun());
    }
  }

  get snapshot(): SessionActorSnapshot {
    const mailbox = this.mailbox.state;
    const idle =
      this.activeRun === null &&
      this.queuedRuns.length === 0 &&
      this.subscribers.size === 0 &&
      this.pendingApprovals.size === 0 &&
      this.pendingInputs.size === 0 &&
      this.cancellationCleanups.size === 0 &&
      mailbox.idle &&
      !this.recovering &&
      this.fault === null &&
      !this.closed;
    return {
      sessionId: this.sessionId,
      activeRunId: this.activeRun?.runId ?? null,
      activeRunState: this.activeRun?.record.state ?? null,
      queuedRunIds: this.queuedRuns.map((run) => run.runId),
      subscriberCount: this.subscribers.size,
      pendingApprovalCount: this.pendingApprovals.size,
      pendingInputCount: this.pendingInputs.size,
      cancellationCleanupCount: this.cancellationCleanups.size,
      mailboxQueued: mailbox.queued,
      mailboxRunning: mailbox.running,
      recovering: this.recovering,
      faulted: this.fault !== null,
      closed: this.closed,
      idle,
    };
  }

  isIdle(): boolean {
    return this.snapshot.idle;
  }

  submitMessage(command: MessageSubmitCommand): Promise<SubmitMessageResult> {
    const unavailable = this.rejectUnavailable<SubmitMessageResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const runId = this.ids.runId();
      const messageId = this.ids.messageId();
      const createdAtMs = this.now();
      const wasQueued = this.activeRun !== null || this.queuedRuns.length > 0;
      const payloadHash = await hashCommandContent(command);
      const input: AcceptCommandInput = {
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash,
        result: { runId, queued: wasQueued },
        acceptedAtMs: createdAtMs,
        runId,
        transaction: {
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "user.message.appended",
              createdAtMs,
              data: { eventVersion: 1, messageId, runId, text: command.params.text },
            },
            {
              eventId: this.ids.eventId(),
              eventType: "run.created",
              createdAtMs,
              data: { eventVersion: 1, runId },
            },
          ],
          projections: [
            {
              kind: "run.put",
              runId,
              state: "queued",
              providerId: "milestone-3-task",
              providerConfig: { milestone: 3 },
              createdAtMs,
              startedAtMs: null,
              completedAtMs: null,
              cancelledAtMs: null,
              failureCategory: null,
              failureMessage: null,
              activeProviderStepId: null,
            },
            {
              kind: "message.put",
              messageId,
              runId,
              role: "user",
              state: "completed",
              createdAtMs,
              completedAtMs: createdAtMs,
            },
            {
              kind: "messagePart.put",
              partId: this.ids.partId(),
              messageId,
              partIndex: 0,
              partType: "text",
              textContent: command.params.text,
              data: null,
            },
          ],
        },
      };
      const acceptance = await this.acceptCommand(input);
      this.publish(acceptance.events);
      const acceptedRunId = acceptance.runId;
      if (acceptedRunId === null) {
        throw new SessionActorError("session.invalid_transition", "Accepted message has no run ID");
      }
      const knownRun =
        this.activeRun?.runId === acceptedRunId ||
        this.queuedRuns.some((record) => record.runId === acceptedRunId);
      if (!knownRun) {
        const record = await this.storage.getRun(acceptedRunId);
        if (record === null) throw new SessionActorError("session.not_found", "Accepted run disappeared");
        if (!isTerminalRunState(record.state)) this.queuedRuns.push(record);
      }
      if (this.activeRun === null) {
        try {
          await this.startNextRun();
        } catch (error) {
          // Acceptance is already durable. Fault explicitly instead of rejecting the accepted
          // command or leaving an apparently healthy queue with no future wake-up.
          this.recordFault(error);
        }
      }
      const queuedResult =
        typeof acceptance.result === "object" && acceptance.result !== null
          ? (acceptance.result as { readonly queued?: unknown })
          : {};
      const acceptedQueued =
        typeof queuedResult.queued === "boolean" ? queuedResult.queued : wasQueued;
      return { acceptance, runId: acceptedRunId, queued: acceptedQueued };
    });
  }

  private async startNextRun(): Promise<void> {
    if (
      this.activeRun !== null ||
      this.queuedRuns.length === 0 ||
      this.closed ||
      this.fault !== null
    ) {
      return;
    }
    const queued = this.queuedRuns[0];
    if (queued === undefined) return;
    const startedAtMs = this.now();
    const startEvent = {
      eventId: this.ids.eventId(),
      eventType: "run.started" as const,
      createdAtMs: startedAtMs,
      data: { eventVersion: 1 as const, runId: queued.runId },
    };
    let committed: AppendTransactionResult;
    let startedRecord: RunRecord;
    try {
      committed = await this.storage.appendTransaction({
        events: [startEvent],
        projections: [
          {
            kind: "run.state",
            runId: queued.runId,
            expectedState: queued.state,
            nextState: "running",
            startedAtMs,
            completedAtMs: null,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: queued.activeProviderStepId,
          },
        ],
      });
      startedRecord = { ...queued, state: "running", startedAtMs };
    } catch (operationError) {
      let current: RunRecord | null;
      let event: SessionEvent | null;
      try {
        [current, event] = await Promise.all([
          this.storage.getRun(queued.runId),
          this.storage.getEventById(startEvent.eventId),
        ]);
      } catch {
        this.faultUnresolvedAmbiguousWrite(operationError);
        throw operationError;
      }
      if (current === null || current.state !== "running" || event === null) {
        const definitelyNotCommitted = current?.state === queued.state && event === null;
        if (!definitelyNotCommitted) this.faultUnresolvedAmbiguousWrite(operationError);
        throw operationError;
      }
      committed = { events: [event], headSequence: event.sequence };
      startedRecord = current;
    }
    const published = this.publish(committed.events);
    this.queuedRuns.shift();
    const active: ActiveRun = {
      runId: queued.runId,
      generation: ++this.generation,
      scope: new CancellationController(),
      record: startedRecord,
      context: null,
      confirmStopped: null,
      cancellation: null,
      task: null,
    };
    this.activeRun = active;
    this.touch();
    if (this.closed) {
      await this.finishRun(active.runId, active.generation, {
        state: "interrupted",
        code: "provider.cancelled",
        message: "Run start completed while the actor was shutting down.",
      });
      return;
    }
    if (!published) return;
    this.launchTask(active);
  }

  private launchTask(active: ActiveRun): void {
    const context: RunTaskContext = {
      sessionId: this.sessionId,
      runId: active.runId,
      generation: active.generation,
      signal: active.scope.signal,
      scheduler: this.scheduler,
    };
    let confirmStopped!: (result: RunTaskResult) => void;
    const stopped = new Promise<RunTaskResult>((resolve) => {
      confirmStopped = resolve;
    });
    active.context = context;
    active.confirmStopped = confirmStopped;
    const scheduled = this.scheduler.withProviderPermit(active.scope.signal, () =>
      Promise.race([this.runTask(context), stopped]),
    );
    active.task = scheduled
      .then((result): RunTaskResult => {
        if (active.scope.cancelled && active.record.state === "running") {
          return {
            state: "interrupted",
            code: "provider.cancelled",
            message: "Run task stopped during actor shutdown.",
          };
        }
        return result ?? { state: "completed" };
      })
      .then(
        (result) => this.postTaskOutcome(active.runId, active.generation, result),
        (error: unknown) =>
          this.postTaskOutcome(active.runId, active.generation, {
            state: active.scope.cancelled ? "interrupted" : "failed",
            code: active.scope.cancelled ? "provider.cancelled" : "provider.protocol_error",
            message: error instanceof Error ? error.message : "Run task failed",
          }),
      )
      .catch((error: unknown) => this.postFault(error));
  }

  private stopActiveTask(active: ActiveRun, reason: unknown): void {
    active.scope.cancel(reason);
    if (active.context === null || active.confirmStopped === null || active.cancellation !== null) {
      return;
    }
    const context = active.context;
    const confirmStopped = active.confirmStopped;
    const gracefulStop = Promise.resolve()
      .then(() => this.cancelRunTask(context, reason))
      .then(
        () => ({ stopped: true as const, cleanupError: null }),
        (cleanupError: unknown) => ({ stopped: true as const, cleanupError }),
      );
    const cancellation = this.finishTaskCancellation(
      context,
      reason,
      gracefulStop,
      confirmStopped,
    ).catch((error: unknown) => this.postFault(error));
    active.cancellation = cancellation;
    this.cancellationCleanups.add(cancellation);
    void cancellation.then(() => {
      this.cancellationCleanups.delete(cancellation);
      this.touch();
    });
  }

  private async finishTaskCancellation(
    context: RunTaskContext,
    reason: unknown,
    gracefulStop: Promise<{ readonly stopped: true; readonly cleanupError: unknown | null }>,
    confirmStopped: (result: RunTaskResult) => void,
  ): Promise<void> {
    const stoppedBeforeDeadline = await this.cancellationWait(
      gracefulStop.then(() => undefined),
    );
    if (stoppedBeforeDeadline) {
      const result = await gracefulStop;
      if (result.cleanupError === null) {
        confirmStopped({
          state: "interrupted",
          code: "provider.cancelled",
          message: "Run task cancellation completed.",
        });
        return;
      }
      confirmStopped({
        state: "interrupted",
        code: "provider.cancelled",
        message:
          result.cleanupError instanceof Error
            ? `Run task stopped with a cancellation cleanup error: ${result.cleanupError.message}`
            : "Run task stopped with a cancellation cleanup error.",
        cancellationFailure: true,
      });
      return;
    }

    await this.forceStopRunTask(context, reason);
    confirmStopped({
      state: "interrupted",
      code: "provider.cancelled",
      message: "Run task exceeded its cancellation deadline and its execution resource was isolated.",
      cancellationFailure: true,
    });
  }

  private async applyTaskOutcome(
    runId: string,
    generation: number,
    result: RunTaskResult,
  ): Promise<void> {
    try {
      await this.finishRun(runId, generation, result);
    } catch (error) {
      // Fault the actor before the mailbox can run another command.
      this.recordFault(error);
    }
  }

  private postTaskOutcome(runId: string, generation: number, result: RunTaskResult): void {
    this.mailbox.post(
      () => this.applyTaskOutcome(runId, generation, result),
      (error: unknown) => {
        if (!(error instanceof MailboxClosedError)) this.recordFault(error);
      },
    );
  }

  notifyTaskOutcome(
    runId: string,
    generation: number,
    result: RunTaskResult,
  ): Promise<void> {
    return this.mailbox.enqueue(() => this.applyTaskOutcome(runId, generation, result));
  }

  private async finishRun(
    runId: string,
    generation: number,
    result: RunTaskResult,
  ): Promise<void> {
    const active = this.activeRun;
    if (active === null || active.runId !== runId || active.generation !== generation) return;
    // Once durable state is ambiguous, reconstruction must decide the outcome.
    if (this.fault !== null) return;
    const terminal =
      result.cancellationFailure === true && active.record.state === "cancelling"
        ? "interrupted"
        : terminalStateForTask(active.record.state, result.state);
    if (terminal === null) return;
    const atMs = this.now();
    const errorCode = result.code ?? (terminal === "interrupted" ? "provider.incomplete" : "provider.protocol_error");
    const message = result.message ?? (terminal === "interrupted" ? "Run was interrupted." : "Run task failed.");
    const event =
      terminal === "failed" || terminal === "interrupted"
        ? {
            eventId: this.ids.eventId(),
            eventType: terminal === "failed" ? ("run.failed" as const) : ("run.interrupted" as const),
            createdAtMs: atMs,
            data: {
              eventVersion: 1 as const,
              runId,
              code: errorCode,
              message,
              diagnosticId: this.ids.diagnosticId(),
            },
          }
        : {
            eventId: this.ids.eventId(),
            eventType: terminal === "completed" ? ("run.completed" as const) : ("run.cancelled" as const),
            createdAtMs: atMs,
            data: { eventVersion: 1 as const, runId },
          };
    const transaction: AppendTransactionInput = {
      events: [event],
      projections: [
        {
          kind: "run.state",
          runId,
          expectedState: active.record.state,
          nextState: terminal,
          startedAtMs: active.record.startedAtMs,
          completedAtMs: terminal === "cancelled" ? active.record.completedAtMs : atMs,
          cancelledAtMs: terminal === "cancelled" ? atMs : active.record.cancelledAtMs,
          failureCategory: terminal === "failed" || terminal === "interrupted" ? errorCode : null,
          failureMessage: terminal === "failed" || terminal === "interrupted" ? message : null,
          activeProviderStepId: active.record.activeProviderStepId,
        },
        {
          kind: "run.pendingInteractions.cancel",
          runId,
          cancelledAtMs: atMs,
        },
      ],
    };
    let committed: AppendTransactionResult | null = null;
    let terminalRecord: RunRecord | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        committed = await this.storage.appendTransaction(transaction);
        terminalRecord = {
          ...active.record,
          state: terminal,
          completedAtMs: terminal === "cancelled" ? active.record.completedAtMs : atMs,
          cancelledAtMs: terminal === "cancelled" ? atMs : active.record.cancelledAtMs,
          failureCategory: terminal === "failed" || terminal === "interrupted" ? errorCode : null,
          failureMessage: terminal === "failed" || terminal === "interrupted" ? message : null,
        };
        break;
      } catch (error) {
        lastError = error;
        const current = await this.storage.getRun(runId);
        if (current !== null && isTerminalRunState(current.state)) {
          const recoveredEvent = await this.storage.getEventById(event.eventId);
          committed = {
            events: recoveredEvent === null ? [] : [recoveredEvent],
            headSequence: recoveredEvent?.sequence ?? 0,
          };
          terminalRecord = current;
          break;
        }
        if (current === null || current.state !== active.record.state || attempt === 1) throw error;
      }
    }
    if (committed === null || terminalRecord === null) throw lastError;
    this.publish(committed.events);
    active.record = terminalRecord;
    for (const [approvalId, approval] of this.pendingApprovals) {
      if (approval.runId === runId) this.pendingApprovals.delete(approvalId);
    }
    for (const [inputId, input] of this.pendingInputs) {
      if (input.runId === runId) this.pendingInputs.delete(inputId);
    }
    this.activeRun = null;
    this.touch();
    await this.startNextRun();
  }

  cancelRun(command: RunCancelCommand): Promise<CancelRunResult> {
    const unavailable = this.rejectUnavailable<CancelRunResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const identity = await this.commandIdentity(command);
      if (identity.duplicate !== null) {
        const current = await this.storage.getRun(command.params.runId);
        if (
          current !== null &&
          this.activeRun?.runId === current.runId &&
          current.state === "cancelling"
        ) {
          this.activeRun.record = current;
          this.stopActiveTask(this.activeRun, new Error("Run cancellation requested"));
        }
        return {
          state: this.acceptedRunState(identity.duplicate, "cancelling"),
          acceptance: identity.duplicate,
        };
      }
      const active = this.activeRun;
      if (active === null || active.runId !== command.params.runId) {
        const run = await this.storage.getRun(command.params.runId);
        if (run === null) throw new SessionActorError("session.not_found", "Run was not found");
        return this.acceptNoopCancellation(command, identity.payloadHash, run);
      }
      if (active.record.state === "cancelling") {
        return this.acceptNoopCancellation(command, identity.payloadHash, active.record);
      }
      if (active.record.state !== "running" && active.record.state !== "waiting_for_user") {
        return this.acceptNoopCancellation(command, identity.payloadHash, active.record);
      }

      const atMs = this.now();
      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { runId: active.runId, state: "cancelling" },
        acceptedAtMs: atMs,
        runId: active.runId,
        transaction: {
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "run.cancel.requested",
              createdAtMs: atMs,
              data: { eventVersion: 1, runId: active.runId },
            },
          ],
          projections: [
            {
              kind: "run.state",
              runId: active.runId,
              expectedState: active.record.state,
              nextState: "cancelling",
              startedAtMs: active.record.startedAtMs,
              completedAtMs: active.record.completedAtMs,
              cancelledAtMs: active.record.cancelledAtMs,
              failureCategory: active.record.failureCategory,
              failureMessage: active.record.failureMessage,
              activeProviderStepId: active.record.activeProviderStepId,
            },
          ],
        },
      });
      this.publish(acceptance.events);
      active.record = { ...active.record, state: "cancelling" };
      this.stopActiveTask(active, new Error("Run cancellation requested"));
      if (active.task === null) {
        void this.postTaskOutcome(active.runId, active.generation, {
          state: "interrupted",
          code: "provider.cancelled",
          message: "Run was cancelled.",
        });
      }
      return { state: "cancelling", acceptance };
    });
  }

  resolveApproval(command: ApprovalResolveCommand, clientId: string): Promise<AcceptedCommandResult> {
    const unavailable = this.rejectUnavailable<AcceptedCommandResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const identity = await this.commandIdentity(command);
      if (identity.duplicate !== null) {
        this.pendingApprovals.delete(command.params.approvalId);
        return identity.duplicate;
      }
      const approval = this.pendingApprovals.get(command.params.approvalId);
      if (approval === undefined) {
        throw new SessionActorError(
          "approval.already_resolved",
          `Approval ${command.params.approvalId} is missing or already resolved`,
        );
      }
      if (
        this.activeRun?.runId !== approval.runId ||
        this.activeRun.record.state !== "waiting_for_user"
      ) {
        throw new SessionActorError(
          "session.invalid_transition",
          `Approval ${approval.approvalId} does not belong to the active waiting run`,
        );
      }
      const atMs = this.now();
      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { approvalId: approval.approvalId, resolution: command.params.resolution },
        acceptedAtMs: atMs,
        runId: approval.runId,
        transaction: {
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "tool.approval.resolved",
              createdAtMs: atMs,
              data: {
                eventVersion: 1,
                runId: approval.runId,
                callId: approval.callId,
                approvalId: approval.approvalId,
                resolution: command.params.resolution,
              },
            },
          ],
          projections: [
            {
              kind: "approval.resolve",
              approvalId: approval.approvalId,
              resolution: command.params.resolution,
              resolvedAtMs: atMs,
              resolvedByClientId: clientId,
            },
          ],
        },
      });
      this.publish(acceptance.events);
      this.pendingApprovals.delete(approval.approvalId);
      return acceptance;
    });
  }

  respondToInput(command: InputRespondCommand): Promise<AcceptedCommandResult> {
    const unavailable = this.rejectUnavailable<AcceptedCommandResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const identity = await this.commandIdentity(command);
      if (identity.duplicate !== null) {
        this.pendingInputs.delete(command.params.inputId);
        return identity.duplicate;
      }
      const input = this.pendingInputs.get(command.params.inputId);
      if (input === undefined) {
        throw new SessionActorError(
          "input.already_resolved",
          `Input ${command.params.inputId} is missing or already resolved`,
        );
      }
      if (this.activeRun?.runId !== input.runId || this.activeRun.record.state !== "waiting_for_user") {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${input.inputId} does not belong to the active waiting run`,
        );
      }
      const atMs = this.now();
      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { inputId: input.inputId },
        acceptedAtMs: atMs,
        runId: input.runId,
        transaction: {
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "input.resolved",
              createdAtMs: atMs,
              data: {
                eventVersion: 1,
                runId: input.runId,
                inputId: input.inputId,
                value: command.params.value,
              },
            },
          ],
          projections: [
            {
              kind: "input.resolve",
              inputId: input.inputId,
              resolvedAtMs: atMs,
              value: command.params.value,
            },
          ],
        },
      });
      this.publish(acceptance.events);
      this.pendingInputs.delete(input.inputId);
      return acceptance;
    });
  }

  subscriberConnected(subscriberId: string): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (subscriberId.length === 0) return Promise.reject(new TypeError("Subscriber ID is required"));
    return this.mailbox.enqueue(() => {
      this.subscribers.add(subscriberId);
      this.touch();
    });
  }

  subscriberDisconnected(subscriberId: string): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (subscriberId.length === 0) return Promise.reject(new TypeError("Subscriber ID is required"));
    return this.mailbox.enqueue(() => {
      this.subscribers.delete(subscriberId);
      this.touch();
    });
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    return this.mailbox.enqueue(() => undefined);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    const completion = this.completeShutdown();
    if (!(await this.shutdownWait(completion))) {
      // The caller can now escalate without waiting forever. Keep late cleanup contained.
      void completion.catch(() => undefined);
      throw new ShutdownTimeoutError(`Session actor ${this.sessionId}`);
    }
    await completion;
  }

  private async completeShutdown(): Promise<void> {
    const reason = new Error("Session actor is shutting down");
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, reason);
    // Drain commands accepted before shutdown. One may be committing run.started, so inspect
    // activeRun again after the barrier and cancel the newly installed task as well.
    await this.mailbox.enqueue(() => undefined);
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, reason);
    const activeTask = this.activeRun?.task ?? null;
    if (activeTask !== null) await activeTask;
    while (this.cancellationCleanups.size > 0) {
      await Promise.all(this.cancellationCleanups);
    }
    await this.mailbox.shutdown();
    try {
      await this.storage.close?.();
    } finally {
      this.eventHub.releaseSession(this.sessionId);
    }
  }
}
