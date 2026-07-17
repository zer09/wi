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
  readonly storage?: RuntimeStorageOptions;
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
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: WiRuntimeOptions) {
    const limits = validateRuntimeLimits(options);
    const storageOptions = parseStorageOptions(options.storage);
    const now = options.now ?? Date.now;
    validateSessionStoreManagerOptions({
      ...storageOptions,
      homeDirectory: options.homeDirectory,
      now,
    });
    this.evictionIntervalMs = limits.actorEvictionIntervalMs;
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
          forceStopRunTask: () => ({ status: "detached" }),
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

  async ready(): Promise<void> {
    await this.storage.ready();
    if (this.evictionTimer === null) {
      this.evictionTimer = setInterval(() => {
        void this.actors.evictIdle().catch((error: unknown) => {
          const diagnosticId = this.diagnosticId();
          this.logger.error("actor_eviction_failed", error, { diagnosticId });
        });
      }, this.evictionIntervalMs);
      this.evictionTimer.unref();
    }
  }

  stopAcceptingCommands(): void {
    this.commandRouter.stopAccepting();
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.stopAcceptingCommands();
    if (this.evictionTimer !== null) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.actors.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.scheduler.shutdown();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.storage.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Wi runtime shutdown failed");
  }
}
