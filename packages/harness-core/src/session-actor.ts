import {
  hashCommandContent,
  type ApprovalResolveCommand,
  type CanonicalJsonValue,
  type ErrorCode,
  type InputRespondCommand,
  type MessageSubmitCommand,
  type RunCancelCommand,
  type RunState,
  RunStateSchema,
  type SessionEvent,
  type ToolEffectClass,
} from "@wi/protocol";
import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionResult,
  PendingApprovalRecord,
  PendingInputRecord,
  ProviderStepRecord,
  RunMessageRecord,
  RunRecord,
  SessionRecoveryResult,
  ToolExecutionRecord,
} from "@wi/storage";

import { ActorMailbox, MailboxClosedError } from "./actor-mailbox.js";
import { CancellationController } from "./cancellation.js";
import type { CommittedEventHub } from "./event-hub.js";
import {
  EventReconciliationIntegrityError,
  reconcileCommittedEventBatch,
} from "./event-reconciliation.js";
import { recoverSession } from "./recovery.js";
import { assertCurrentToolEffectClass } from "./run-policy.js";
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

export class SessionActorHandoffError extends Error {
  constructor() {
    super("Session actor is handing durable work to a replacement actor");
    this.name = "SessionActorHandoffError";
  }
}

export function isSessionActorHandoffSignal(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof SessionActorHandoffError;
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
  getToolExecution?(callId: string): Promise<ToolExecutionRecord | null>;
  getToolExecutionsForStep?(stepId: string): Promise<readonly ToolExecutionRecord[]>;
  getStreamingMessagesForStep?(stepId: string): Promise<readonly RunMessageRecord[]>;
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

export interface RunTaskCommitOptions {
  /** Cancellation cleanup may persist interruption/discard state after run.cancel is committed. */
  readonly allowWhileCancelling?: boolean;
}

export interface RunTaskContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly scheduler: RunScheduler;
  readonly now: () => number;
  readonly commitTransaction: (
    input: AppendTransactionInput,
    options?: RunTaskCommitOptions,
  ) => Promise<AppendTransactionResult>;
  readonly waitForApproval: (approvalId: string) => Promise<void>;
}

export interface RunProviderSnapshot {
  readonly providerId: string;
  readonly providerConfig: CanonicalJsonValue;
}

export type CreateRunProviderSnapshot = (
  command: MessageSubmitCommand,
) => RunProviderSnapshot;

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

export interface RunTaskIsolation {
  readonly status: "terminated" | "detached" | "quarantined";
  readonly cleanup?: Promise<void>;
}

// This synchronous result is proof that the execution resource is already isolated. Optional
// best-effort cleanup happens after isolation and cannot retain the scheduler permit.
export type ForceStopRunTask = (
  context: RunTaskContext,
  reason: unknown,
) => RunTaskIsolation;

function assertRunTaskIsolation(value: unknown): asserts value is RunTaskIsolation {
  if (value === null || typeof value !== "object" || "then" in value) {
    throw new SessionActorError(
      "session.invalid_isolation_proof",
      "Forced run-task isolation must return synchronous proof",
    );
  }
  if (
    !("status" in value) ||
    (value.status !== "terminated" &&
      value.status !== "detached" &&
      value.status !== "quarantined")
  ) {
    throw new SessionActorError(
      "session.invalid_isolation_proof",
      "Forced run-task isolation returned an invalid status",
    );
  }
  if (
    "cleanup" in value &&
    value.cleanup !== undefined &&
    (value.cleanup === null ||
      typeof value.cleanup !== "object" ||
      !("then" in value.cleanup) ||
      typeof value.cleanup.then !== "function")
  ) {
    throw new SessionActorError(
      "session.invalid_isolation_proof",
      "Forced run-task isolation cleanup must be a promise",
    );
  }
}

interface ApprovalWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

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
  private readonly createRunProviderSnapshot: CreateRunProviderSnapshot;
  private readonly runTaskOwnsSchedulerPermits: boolean;
  private readonly resumeRestoredRuns: boolean;
  private readonly currentToolEffectClass:
    | ((toolName: string) => ToolEffectClass | null)
    | undefined;
  private readonly cancelRunTask: CancelRunTask;
  private readonly forceStopRunTask: ForceStopRunTask;
  private readonly cancellationWait: ShutdownWait;
  private readonly onActivity: (() => void) | undefined;
  private readonly onFault: ((error: unknown) => void) | undefined;
  private readonly shutdownWait: ShutdownWait;
  private readonly queuedRuns: RunRecord[] = [];
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();
  private readonly pendingInputs = new Map<string, PendingInputRecord>();
  private readonly approvalWaiters = new Map<string, Set<ApprovalWaiter>>();
  private readonly subscribers = new Set<string>();
  // A run may terminalize first, so the actor retains cleanup until shutdown can safely drain it.
  private readonly cancellationCleanups = new Set<Promise<void>>();
  private activeRun: ActiveRun | null = null;
  private generation = 0;
  private recovering = true;
  private fault: unknown | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(options: {
    readonly storage: SessionActorStorage;
    readonly eventHub: CommittedEventHub;
    readonly scheduler: RunScheduler;
    readonly ids: SessionActorIds;
    readonly now: () => number;
    readonly runTask: RunTask;
    readonly createRunProviderSnapshot?: CreateRunProviderSnapshot;
    readonly runTaskOwnsSchedulerPermits?: boolean;
    readonly resumeRestoredRuns?: boolean;
    readonly currentToolEffectClass?: (toolName: string) => ToolEffectClass | null;
    readonly cancelRunTask: CancelRunTask;
    readonly forceStopRunTask: ForceStopRunTask;
    readonly cancellationWait?: ShutdownWait;
    readonly onActivity?: () => void;
    readonly onFault?: (error: unknown) => void;
    readonly shutdownWait?: ShutdownWait;
  }) {
    this.sessionId = options.storage.sessionId;
    this.storage = options.storage;
    this.eventHub = options.eventHub;
    this.scheduler = options.scheduler;
    this.ids = options.ids;
    this.now = options.now;
    this.runTask = options.runTask;
    this.createRunProviderSnapshot =
      options.createRunProviderSnapshot ??
      (() => ({ providerId: "milestone-3-task", providerConfig: { milestone: 3 } }));
    this.runTaskOwnsSchedulerPermits = options.runTaskOwnsSchedulerPermits === true;
    this.resumeRestoredRuns = options.resumeRestoredRuns === true;
    this.currentToolEffectClass = options.currentToolEffectClass;
    this.cancelRunTask = options.cancelRunTask;
    this.forceStopRunTask = options.forceStopRunTask;
    this.cancellationWait = options.cancellationWait ?? defaultShutdownWait;
    this.onActivity = options.onActivity;
    this.onFault = options.onFault;
    this.shutdownWait = options.shutdownWait ?? defaultShutdownWait;
  }

  static async create(options: {
    readonly storage: SessionActorStorage;
    readonly eventHub: CommittedEventHub;
    readonly scheduler: RunScheduler;
    readonly ids: SessionActorIds;
    readonly now: () => number;
    readonly runTask: RunTask;
    readonly createRunProviderSnapshot?: CreateRunProviderSnapshot;
    readonly runTaskOwnsSchedulerPermits?: boolean;
    readonly resumeRestoredRuns?: boolean;
    readonly currentToolEffectClass?: (toolName: string) => ToolEffectClass | null;
    readonly cancelRunTask: CancelRunTask;
    readonly forceStopRunTask: ForceStopRunTask;
    readonly cancellationWait?: ShutdownWait;
    readonly onActivity?: () => void;
    readonly onFault?: (error: unknown) => void;
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

  private publishOrThrow(events: readonly SessionEvent[]): void {
    try {
      for (const event of events) this.eventHub.publishCommitted(event);
    } catch (error) {
      // The write is already committed. Quarantine this actor instead of reporting rollback
      // or allowing later commands to mutate a session with an inconsistent live stream.
      this.recordFault(error);
      throw error;
    }
  }

  private publish(events: readonly SessionEvent[]): boolean {
    try {
      for (const event of events) this.eventHub.publishCommitted(event);
      return true;
    } catch (error) {
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
    const firstFault = this.fault === null;
    if (firstFault) this.fault = error;
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, error);
    if (firstFault) this.onFault?.(error);
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
      if (accepted.runId !== input.runId) {
        if (input.commandMethod === "message.submit" && accepted.runId !== null) {
          // A duplicate message predates this retry, so its fresh proposed event IDs never applied.
          return accepted;
        }
        const identityError = new SessionActorError(
          "session.invalid_transition",
          `Accepted command ${input.commandId} has an inconsistent run identity`,
        );
        this.recordFault(identityError);
        throw identityError;
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

  private settleApprovalWaiters(approvalId: string): void {
    const waiters = this.approvalWaiters.get(approvalId);
    if (waiters === undefined) return;
    this.approvalWaiters.delete(approvalId);
    for (const waiter of waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  private waitForApproval(approvalId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // Resolution may commit between the run loop's ledger read and waiter registration.
    if (!this.pendingApprovals.has(approvalId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiters = this.approvalWaiters.get(approvalId) ?? new Set<ApprovalWaiter>();
      const waiter: ApprovalWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.approvalWaiters.delete(approvalId);
          reject(signal.reason ?? new DOMException("Approval wait aborted", "AbortError"));
        },
      };
      waiters.add(waiter);
      this.approvalWaiters.set(approvalId, waiters);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private applyProjectionMemory(input: AppendTransactionInput): void {
    for (const projection of input.projections ?? []) {
      const active = this.activeRun;
      if (projection.kind === "run.state" && active?.runId === projection.runId) {
        active.record = {
          ...active.record,
          state: projection.nextState,
          startedAtMs: projection.startedAtMs,
          completedAtMs: projection.completedAtMs,
          cancelledAtMs: projection.cancelledAtMs,
          failureCategory: projection.failureCategory,
          failureMessage: projection.failureMessage,
          activeProviderStepId: projection.activeProviderStepId,
        };
      } else if (
        projection.kind === "run.activeProviderStep" &&
        active?.runId === projection.runId
      ) {
        active.record = {
          ...active.record,
          activeProviderStepId: projection.activeProviderStepId,
        };
      } else if (projection.kind === "approval.put") {
        this.pendingApprovals.set(projection.approvalId, {
          approvalId: projection.approvalId,
          runId: projection.runId,
          callId: projection.callId,
          state: "pending",
          actionDigest: projection.actionDigest,
          requestedAtMs: projection.requestedAtMs,
        });
      } else if (projection.kind === "approval.resolve") {
        this.pendingApprovals.delete(projection.approvalId);
      } else if (projection.kind === "input.put") {
        this.pendingInputs.set(projection.inputId, {
          inputId: projection.inputId,
          runId: projection.runId,
          state: "pending",
          prompt: projection.prompt,
          requestedAtMs: projection.requestedAtMs,
        });
      } else if (projection.kind === "input.resolve") {
        this.pendingInputs.delete(projection.inputId);
      } else if (projection.kind === "run.pendingInteractions.cancel") {
        for (const [approvalId, approval] of this.pendingApprovals) {
          if (approval.runId === projection.runId) {
            this.pendingApprovals.delete(approvalId);
            this.settleApprovalWaiters(approvalId);
          }
        }
        for (const [inputId, input] of this.pendingInputs) {
          if (input.runId === projection.runId) this.pendingInputs.delete(inputId);
        }
      }
    }
  }

  private async commitTaskTransaction(
    runId: string,
    generation: number,
    input: AppendTransactionInput,
    options: RunTaskCommitOptions = {},
  ): Promise<AppendTransactionResult> {
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      const active = this.activeRun;
      if (active === null || active.runId !== runId || active.generation !== generation) {
        throw new SessionActorError("session.invalid_transition", "Run task is stale");
      }
      if (
        (active.scope.signal.aborted || active.record.state === "cancelling") &&
        options.allowWhileCancelling !== true
      ) {
        throw new SessionActorError("provider.cancelled", "Run cancellation prevents this mutation");
      }

      let committed: AppendTransactionResult;
      try {
        committed = await this.storage.appendTransaction(input);
      } catch (operationError) {
        let storedEvents: (SessionEvent | null)[];
        try {
          storedEvents = await Promise.all(
            input.events.map((event) => this.storage.getEventById(event.eventId)),
          );
        } catch {
          this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        try {
          const reconciled = reconcileCommittedEventBatch(
            this.sessionId,
            input.events,
            storedEvents,
          );
          if (reconciled === null) throw operationError;
          committed = reconciled;
        } catch (error) {
          if (error instanceof EventReconciliationIntegrityError) this.recordFault(error);
          else this.faultUnresolvedAmbiguousWrite(operationError);
          throw error;
        }

        let current: RunRecord | null;
        try {
          current = await this.storage.getRun(runId);
        } catch {
          this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        if (current === null) {
          const integrityError = new EventReconciliationIntegrityError(
            `Reconciled task transaction has no run ${runId}`,
          );
          this.recordFault(integrityError);
          throw integrityError;
        }
        active.record = current;
      }
      this.publishOrThrow(committed.events);
      this.applyProjectionMemory(input);
      this.touch();
      return committed;
    });
  }

  private async initialize(): Promise<void> {
    try {
      await recoverSession({
        sessionId: this.sessionId,
        storage: this.storage,
        now: this.now,
        eventId: this.ids.eventId,
        diagnosticId: this.ids.diagnosticId,
        publishCommitted: (event) => this.publishOrThrow([event]),
        resumeToolLoop: this.resumeRestoredRuns,
        ...(this.currentToolEffectClass === undefined
          ? {}
          : { currentToolEffectClass: this.currentToolEffectClass }),
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

    if (this.activeRun !== null && this.resumeRestoredRuns) {
      this.launchTask(this.activeRun);
    } else if (this.activeRun === null && this.queuedRuns.length > 0) {
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
      const providerSnapshot = this.createRunProviderSnapshot(command);
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
              providerId: providerSnapshot.providerId,
              providerConfig: providerSnapshot.providerConfig,
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
      now: this.now,
      commitTransaction: (input, options) =>
        this.commitTaskTransaction(active.runId, active.generation, input, options),
      waitForApproval: (approvalId) => this.waitForApproval(approvalId, active.scope.signal),
    };
    let confirmStopped!: (result: RunTaskResult) => void;
    const stopped = new Promise<RunTaskResult>((resolve) => {
      confirmStopped = resolve;
    });
    active.context = context;
    active.confirmStopped = confirmStopped;
    const task = (): Promise<RunTaskResult | void> =>
      Promise.race([this.runTask(context), stopped]);
    const scheduled = this.runTaskOwnsSchedulerPermits
      ? task()
      : this.scheduler.withProviderPermit(active.scope.signal, task);
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
        (result) => {
          // Handoff leaves durable state for recovery instead of inventing a terminal run.
          if (!isSessionActorHandoffSignal(active.scope.signal)) {
            this.postTaskOutcome(active.runId, active.generation, result);
          }
        },
        (error: unknown) => {
          if (isSessionActorHandoffSignal(active.scope.signal)) return;
          this.postTaskOutcome(active.runId, active.generation, {
            state: active.scope.cancelled ? "interrupted" : "failed",
            code: active.scope.cancelled ? "provider.cancelled" : "provider.protocol_error",
            message: error instanceof Error ? error.message : "Run task failed",
          });
        },
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

    const isolation: unknown = this.forceStopRunTask(context, reason);
    assertRunTaskIsolation(isolation);
    if (isolation.cleanup !== undefined) {
      void Promise.resolve(isolation.cleanup).catch(() => {
        // Isolation already succeeded; later best-effort cleanup cannot affect run or permit state.
      });
    }
    confirmStopped({
      state: "interrupted",
      code: "provider.cancelled",
      message: `Run task exceeded its cancellation deadline and its execution resource was ${isolation.status}.`,
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
      if (approval.runId === runId) {
        this.pendingApprovals.delete(approvalId);
        this.settleApprovalWaiters(approvalId);
      }
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
        if (this.runTaskOwnsSchedulerPermits && identity.duplicate.runId !== null) {
          const current = await this.storage.getRun(identity.duplicate.runId);
          if (current !== null && this.activeRun?.runId === current.runId) {
            this.activeRun.record = current;
          }
          this.settleApprovalWaiters(command.params.approvalId);
        }
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
      const resolvedEvent = {
        eventId: this.ids.eventId(),
        eventType: "tool.approval.resolved" as const,
        createdAtMs: atMs,
        data: {
          eventVersion: 1 as const,
          runId: approval.runId,
          callId: approval.callId,
          approvalId: approval.approvalId,
          resolution: command.params.resolution,
        },
      };

      let transaction: AcceptCommandInput["transaction"];
      if (this.runTaskOwnsSchedulerPermits) {
        const tool = await this.storage.getToolExecution?.(approval.callId);
        if (tool === null || tool === undefined || tool.effectClass === null) {
          throw new SessionActorError(
            "session.invalid_transition",
            `Approval ${approval.approvalId} has no classified tool execution`,
          );
        }
        if (tool.state !== "awaiting_approval") {
          throw new SessionActorError(
            "approval.already_resolved",
            `Approval ${approval.approvalId} tool is already resolved`,
          );
        }
        assertCurrentToolEffectClass(
          tool,
          this.currentToolEffectClass?.(tool.toolName) ?? null,
        );
        const denied = command.params.resolution === "denied";
        const denialMessage = "The user denied this tool call.";
        transaction = {
          events: [
            resolvedEvent,
            ...(denied
              ? [
                  {
                    eventId: this.ids.eventId(),
                    eventType: "tool.execution.failed" as const,
                    createdAtMs: atMs,
                    data: {
                      eventVersion: 1 as const,
                      runId: approval.runId,
                      callId: approval.callId,
                      code: "tool.approval_denied" as const,
                      message: denialMessage,
                      diagnosticId: this.ids.diagnosticId(),
                    },
                  },
                ]
              : []),
            {
              eventId: this.ids.eventId(),
              eventType: "run.started",
              createdAtMs: atMs,
              data: { eventVersion: 1, runId: approval.runId },
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
            {
              kind: "toolExecution.put",
              callId: tool.callId,
              expectedState: "awaiting_approval",
              runId: tool.runId,
              stepId: tool.stepId,
              toolName: tool.toolName,
              argumentsJson: tool.argumentsJson,
              argumentsHash: tool.argumentsHash,
              effectClass: tool.effectClass,
              state: denied ? "denied" : "approved",
              attemptCount: tool.attemptCount,
              requestedAtMs: tool.requestedAtMs,
              startedAtMs: tool.startedAtMs,
              completedAtMs: denied ? atMs : tool.completedAtMs,
              result: tool.result,
              error: denied
                ? { code: "tool.approval_denied", message: denialMessage }
                : tool.error,
            },
            {
              kind: "run.state",
              runId: approval.runId,
              expectedState: "waiting_for_user",
              nextState: "running",
              startedAtMs: this.activeRun.record.startedAtMs,
              completedAtMs: null,
              cancelledAtMs: null,
              failureCategory: null,
              failureMessage: null,
              activeProviderStepId: this.activeRun.record.activeProviderStepId,
            },
          ],
        };
      } else {
        transaction = {
          events: [resolvedEvent],
          projections: [
            {
              kind: "approval.resolve",
              approvalId: approval.approvalId,
              resolution: command.params.resolution,
              resolvedAtMs: atMs,
              resolvedByClientId: clientId,
            },
          ],
        };
      }

      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { approvalId: approval.approvalId, resolution: command.params.resolution },
        acceptedAtMs: atMs,
        runId: approval.runId,
        transaction,
      });
      this.publish(acceptance.events);
      this.applyProjectionMemory(transaction);
      this.pendingApprovals.delete(approval.approvalId);
      if (this.runTaskOwnsSchedulerPermits) this.settleApprovalWaiters(approval.approvalId);
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
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose(
      new Error("Session actor is shutting down"),
      `Session actor ${this.sessionId}`,
    );
    return this.closePromise;
  }

  handoff(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose(
      new SessionActorHandoffError(),
      `Session actor handoff ${this.sessionId}`,
    );
    return this.closePromise;
  }

  private async finishClose(reason: unknown, component: string): Promise<void> {
    const completion = this.completeClose(reason);
    if (!(await this.shutdownWait(completion))) {
      // The caller can now escalate without waiting forever. Keep late cleanup contained.
      void completion.catch(() => undefined);
      throw new ShutdownTimeoutError(component);
    }
    await completion;
  }

  private async completeClose(reason: unknown): Promise<void> {
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, reason);
    // Drain commands accepted before close. One may be committing run.started, so inspect
    // activeRun again after the barrier and stop the newly installed task as well.
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
