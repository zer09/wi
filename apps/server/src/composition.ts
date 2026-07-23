import { randomUUID } from "node:crypto";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
  SessionActorRegistry,
  type CreateRunProviderSnapshot,
} from "@wi/harness-core";
import { createId, type MessageSubmitCommand } from "@wi/protocol";
import {
  FakeProviderAdapter,
  type FakeProviderConfiguration,
} from "@wi/provider-fake";
import {
  SessionStoreManager,
  validateSessionStoreManagerOptions,
  type RecoveryCandidateCursor,
  type SessionStoreManagerOptions,
} from "@wi/storage";
import {
  createBuiltinToolRegistry,
  ToolExecutor,
  type ToolRegistry,
} from "@wi/tools";
import {
  JsonLogger,
  nonThrowingLogger,
  type Logger,
} from "./logging/logger.js";
import type { TestFailpointController } from "./testing/failpoints.js";
import { CommandRouter } from "./websocket/command-router.js";

function randomIdSource(): string {
  return randomUUID().replaceAll("-", "");
}

function id(kind: Parameters<typeof createId>[0]): string {
  return createId(kind, randomIdSource);
}

type RuntimeStorageOptions = Omit<SessionStoreManagerOptions, "homeDirectory" | "now">;

interface ValidatedRuntimeLimits {
  readonly providerCapacity: number;
  readonly toolCapacity: number;
  readonly actorIdleTimeoutMs: number;
  readonly actorEvictionIntervalMs: number;
}

function validateRuntimeLimits(options: WiRuntimeOptions): ValidatedRuntimeLimits {
  const providerCapacity = options.providerCapacity ?? 4;
  const toolCapacity = options.toolCapacity ?? 4;
  const actorIdleTimeoutMs = options.actorIdleTimeoutMs ?? 60_000;
  const actorEvictionIntervalMs = options.actorEvictionIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(providerCapacity) || providerCapacity < 1) {
    throw new RangeError("Provider capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(toolCapacity) || toolCapacity < 1) {
    throw new RangeError("Tool capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(actorIdleTimeoutMs) || actorIdleTimeoutMs < 0) {
    throw new RangeError("Actor idle timeout must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(actorEvictionIntervalMs) || actorEvictionIntervalMs < 1) {
    throw new RangeError("Actor eviction interval must be a positive safe integer");
  }
  return {
    providerCapacity,
    toolCapacity,
    actorIdleTimeoutMs,
    actorEvictionIntervalMs,
  };
}

export interface WiRuntimeOptions {
  readonly homeDirectory: string;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly provider?: FakeProviderAdapter;
  readonly providerConfiguration?: FakeProviderConfiguration;
  readonly selectProviderConfiguration?: (
    command: MessageSubmitCommand,
  ) => FakeProviderConfiguration;
  readonly toolRegistry?: ToolRegistry;
  readonly toolExecutor?: ToolExecutor;
  readonly providerCapacity?: number;
  readonly toolCapacity?: number;
  readonly actorIdleTimeoutMs?: number;
  readonly actorEvictionIntervalMs?: number;
  readonly shutdownDeadlineMs?: number;
  readonly storage?: RuntimeStorageOptions;
  readonly testFailpoints?: TestFailpointController;
}

function parseStorageOptions(value: unknown): RuntimeStorageOptions | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Wi runtime storage options must be an object");
  }
  for (const key of ["homeDirectory", "now"] as const) {
    if (Object.hasOwn(value, key)) {
      throw new TypeError(`Wi runtime storage option ${key} is reserved`);
    }
  }
  return value as RuntimeStorageOptions;
}

export class WiRuntime {
  readonly logger: Logger;
  readonly storage: SessionStoreManager;
  readonly eventHub: CommittedEventHub;
  readonly scheduler: RunScheduler;
  readonly actors: SessionActorRegistry;
  readonly provider: FakeProviderAdapter;
  readonly commandRouter: CommandRouter;
  readonly diagnosticId = (): string => id("diagnostic");
  readonly now: () => number;
  private readonly evictionIntervalMs: number;
  private readonly shutdownDeadlineMs: number;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private readyPromise: Promise<void> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: WiRuntimeOptions) {
    if (
      options.testFailpoints !== undefined &&
      (process.env.NODE_ENV !== "test" || process.env.WI_ALLOW_TEST_FAILPOINTS !== "1")
    ) {
      throw new Error(
        "Runtime test failpoints require NODE_ENV=test and WI_ALLOW_TEST_FAILPOINTS=1",
      );
    }
    const limits = validateRuntimeLimits(options);
    const storageOptions = parseStorageOptions(options.storage);
    const now = options.now ?? Date.now;
    validateSessionStoreManagerOptions({
      ...storageOptions,
      homeDirectory: options.homeDirectory,
      now,
    });
    this.evictionIntervalMs = limits.actorEvictionIntervalMs;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? 15_000;
    if (!Number.isSafeInteger(this.shutdownDeadlineMs) || this.shutdownDeadlineMs < 100) {
      throw new RangeError("Shutdown deadline must be a safe integer of at least 100ms");
    }
    this.now = now;
    this.logger = nonThrowingLogger(
      options.logger ?? new JsonLogger({ now: this.now }),
    );
    this.provider = options.provider ?? new FakeProviderAdapter();
    this.eventHub = new CommittedEventHub();
    this.scheduler = new RunScheduler({
      providerCapacity: limits.providerCapacity,
      toolCapacity: limits.toolCapacity,
    });
    const toolRegistry = options.toolRegistry ?? createBuiltinToolRegistry();
    const toolExecutor = options.toolExecutor ?? new ToolExecutor();
    const defaultProviderConfiguration = options.providerConfiguration ?? {
      scenario: "plain-text",
    };
    const createRunProviderSnapshot: CreateRunProviderSnapshot = (command) => {
      const configuration =
        options.selectProviderConfiguration?.(command) ?? defaultProviderConfiguration;
      return {
        providerId: this.provider.id,
        providerConfig: {
          scenario: configuration.scenario,
          ...(configuration.roundTripTool === undefined
            ? {}
            : { roundTripTool: configuration.roundTripTool }),
        },
      };
    };
    const sessionWorkerOptions = storageOptions?.sessionWorkers;
    const catalogWorkerOptions = storageOptions?.catalogWorker;
    const configuredCatalogObservationError = storageOptions?.onCatalogObservationError;
    this.storage = new SessionStoreManager({
      ...storageOptions,
      homeDirectory: options.homeDirectory,
      now: this.now,
      ...(options.testFailpoints === undefined
        ? {}
        : {
            testFailpoints: {
              hit: (name, fields) => options.testFailpoints?.hit(name, fields),
            },
          }),
      onCatalogObservationError: async (failure) => {
        const { error, ...fields } = failure;
        try {
          this.logger.error("storage_catalog_observation_failed", error, fields);
        } catch {
          // Logging cannot affect a session write that already committed.
        }
        try {
          await configuredCatalogObservationError?.(failure);
        } catch {
          // A caller's diagnostic hook cannot affect the committed session result.
        }
      },
      catalogWorker: {
        ...catalogWorkerOptions,
        onWorkerReplacement: (replacementCount) => {
          const diagnosticId = this.diagnosticId();
          this.logger.warn("storage_worker_replaced", {
            diagnosticId,
            workerId: "catalog",
            replacementCount,
          });
          try {
            catalogWorkerOptions?.onWorkerReplacement?.(replacementCount);
          } catch {
            // A caller's diagnostic hook cannot affect worker replacement.
          }
        },
      },
      sessionWorkers: {
        ...sessionWorkerOptions,
        ...(options.testFailpoints?.is("after_command_event_insert_before_commit") === true
          ? { allowTestOperations: true }
          : {}),
        onWorkerReplacement: (workerIndex, replacementCount) => {
          const diagnosticId = this.diagnosticId();
          this.logger.warn("storage_worker_replaced", {
            diagnosticId,
            workerId: `session-${workerIndex}`,
            replacementCount,
          });
          try {
            sessionWorkerOptions?.onWorkerReplacement?.(workerIndex, replacementCount);
          } catch {
            // A caller's diagnostic hook cannot affect worker replacement.
          }
        },
        onSessionError: async (sessionId, error) => {
          const diagnosticId = this.diagnosticId();
          this.logger.error("storage_session_operation_failed", error, {
            diagnosticId,
            sessionId,
          });
          await sessionWorkerOptions?.onSessionError?.(sessionId, error);
        },
      },
    });

    this.actors = new SessionActorRegistry({
      now: this.now,
      idleTimeoutMs: limits.actorIdleTimeoutMs,
      createActor: async (sessionId, onActivity, onFault) => {
        const session = await this.storage.openSession(sessionId);
        const runLoop = new AgentRunLoop({
          storage: session,
          provider: this.provider,
          registry: toolRegistry,
          executor: toolExecutor,
          ids: {
            eventId: () => id("event"),
            stepId: () => id("providerStep"),
            messageId: () => id("message"),
            partId: () => id("part"),
            approvalId: () => id("approval"),
            diagnosticId: this.diagnosticId,
          },
          onFailureDiagnostic: (diagnostic) => {
            const { error, operation, ...fields } = diagnostic;
            this.logger.error(`${operation}_operation_failed`, error, fields);
          },
        });
        return SessionActor.create({
          storage: session,
          eventHub: this.eventHub,
          scheduler: this.scheduler,
          ids: {
            runId: () => id("run"),
            eventId: () => id("event"),
            messageId: () => id("message"),
            partId: () => id("part"),
            diagnosticId: this.diagnosticId,
          },
          now: this.now,
          runTask: runLoop.task,
          createRunProviderSnapshot,
          runTaskOwnsSchedulerPermits: true,
          resumeRestoredRuns: true,
          currentToolEffectClass: runLoop.currentToolEffectClass,
          cancelRunTask: runLoop.cancel,
          forceStopRunTask: (context) => {
            const diagnosticId = this.diagnosticId();
            this.logger.error(
              "run_task_isolation_unavailable",
              new Error("An in-process run task exceeded its cancellation deadline"),
              {
                diagnosticId,
                sessionId: context.sessionId,
                runId: context.runId,
              },
            );
            // In-process work has no smaller hard isolation boundary in v0.1.
            process.exit(1);
          },
          onActivity,
          onRecoveryFailureDiagnostic: (diagnostic) => {
            const { error, ...fields } = diagnostic;
            this.logger.error("session_recovery_interrupted", error, fields);
          },
          onToolFailureDiagnostic: (diagnostic) => {
            const { error, ...fields } = diagnostic;
            this.logger.error("tool_operation_failed", error, fields);
          },
          onRunFailureDiagnostic: (diagnostic) => {
            const { error, ...fields } = diagnostic;
            this.logger.error("run_task_failed", error, fields);
          },
          ...(options.testFailpoints === undefined
            ? {}
            : {
                testFailpoints: {
                  matches: (name, fields) =>
                    options.testFailpoints?.matches(name, fields) === true,
                  takeRunIdForCommand: (targetSessionId, commandId) =>
                    options.testFailpoints?.takeRunIdForCommand(
                      targetSessionId,
                      commandId,
                    ) ?? null,
                  hit: (name, fields) => options.testFailpoints?.hit(name, fields),
                },
              }),
          onFault: (error) => {
            const diagnosticId = this.diagnosticId();
            this.logger.error("session_actor_fault", error, { diagnosticId, sessionId });
            onFault(error);
          },
        });
      },
      beforeEvict: (sessionId) => {
        this.eventHub.releaseSession(sessionId);
      },
    });
    this.commandRouter = new CommandRouter(
      this.storage,
      this.actors,
      this.eventHub,
      this.logger,
      this.diagnosticId,
    );
  }

  ready(): Promise<void> {
    if (this.readyPromise !== null) return this.readyPromise;
    this.readyPromise = this.finishReady();
    return this.readyPromise;
  }

  private async finishReady(): Promise<void> {
    try {
      await this.storage.ready();
      if (this.closing) return;
      // Recovery ownership belongs to the backend. Read and adopt one bounded
      // page at a time so startup can stop promptly without retaining the catalog.
      let recoveryCursor: RecoveryCandidateCursor | null = null;
      do {
        if (this.closing) return;
        const page = await this.storage.listRecoveryCandidatePage(recoveryCursor);
        if (this.closing) return;
        for (const sessionId of page.sessionIds) {
          if (this.closing) return;
          try {
            const lease = await this.actors.acquire(sessionId);
            lease.release();
          } catch (error) {
            if (this.closing) return;
            this.logger.error("startup_recovery_candidate_failed", error, {
              diagnosticId: this.diagnosticId(),
              sessionId,
            });
          }
        }
        recoveryCursor = page.nextCursor;
      } while (recoveryCursor !== null);
      if (this.closing) return;
      this.evictionTimer = setInterval(() => {
        void this.actors.evictIdle().catch((error: unknown) => {
          const diagnosticId = this.diagnosticId();
          this.logger.error("actor_eviction_failed", error, { diagnosticId });
        });
      }, this.evictionIntervalMs);
      this.evictionTimer.unref();
    } catch (error) {
      // Server-owned shutdown cancels startup. A storage/actor close caused by
      // that shutdown is not an independent startup failure.
      if (this.closing) return;
      throw error;
    }
  }

  stopAcceptingCommands(): void {
    this.commandRouter.stopAccepting();
  }

  getShutdownDeadlineMs(): number {
    return this.shutdownDeadlineMs;
  }

  close(deadlineAtMs = Date.now() + this.shutdownDeadlineMs): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.stopAcceptingCommands();
    if (this.evictionTimer !== null) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.closePromise = this.finishClose(deadlineAtMs);
    return this.closePromise;
  }

  private async finishClose(deadlineAtMs: number): Promise<void> {
    const startedAt = Date.now();
    const errors: unknown[] = [];
    const diagnostics: Array<{ component: string; phase: string; elapsedMs: number; remainingMs: number; classification: string; error: string }> = [];
    const run = async (phase: string, operation: () => Promise<void>): Promise<void> => {
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) {
        const error = new Error(`Shutdown deadline elapsed before ${phase}`);
        errors.push(error);
        diagnostics.push({ component: phase === "storage" ? "storage" : "runtime", phase, elapsedMs: Date.now() - startedAt, remainingMs: 0, classification: "deadline_elapsed", error: error.message });
        if (phase === "storage") {
          // Storage owns hard worker boundaries; invoke it even after expiry so
          // it can terminate workers rather than abandoning cleanup entirely.
          try {
            await operation();
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${phase} exceeded shutdown deadline`)), remaining);
            timer.unref();
          }),
        ]);
      } catch (error) {
        errors.push(error);
        diagnostics.push({
          component: phase === "storage" ? "storage" : "runtime",
          phase,
          elapsedMs: Date.now() - startedAt,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          classification: Date.now() >= deadlineAtMs ? "timeout" : "failure",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    await run("actors", () => this.actors.close());
    await run("scheduler", () => this.scheduler.shutdown());
    await run("storage", () => this.storage.close(deadlineAtMs));
    if (diagnostics.length > 0) {
      this.logger.error("server_shutdown_diagnostic", new AggregateError(errors), {
        diagnosticId: this.diagnosticId(),
        shutdownDeadlineMs: this.shutdownDeadlineMs,
        deadlineAtMs,
        elapsedMs: Date.now() - startedAt,
        classification: "server_shutdown_failure",
        diagnostics,
      });
      throw new AggregateError(errors, "Wi runtime shutdown failed");
    }
  }
}
