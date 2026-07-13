import { EventHubIntegrityError } from "./event-hub.js";
import type { SessionActor } from "./session-actor.js";
import {
  defaultShutdownWait,
  ShutdownTimeoutError,
  type ShutdownWait,
} from "./shutdown.js";

export interface SessionActorLease {
  readonly actor: SessionActor;
  readonly release: () => void;
}

type CreateSessionActor = (
  sessionId: string,
  onActivity: () => void,
  onFault: (error: unknown) => void,
) => Promise<SessionActor>;

interface RegistryEntry {
  readonly sessionId: string;
  actorPromise: Promise<SessionActor>;
  actor: SessionActor | undefined;
  actorVersion: number;
  references: number;
  resolveReferencesDrained: (() => void) | null;
  lastActivityMs: number;
  activityVersion: number;
  fault: unknown | null;
  retirement: Promise<void> | null;
  eviction: Promise<void> | null;
}

export interface SessionRegistryEntryState {
  readonly sessionId: string;
  readonly references: number;
  readonly lastActivityMs: number;
  readonly activityVersion: number;
  readonly constructing: boolean;
  readonly evicting: boolean;
  readonly faulted: boolean;
  readonly retiring: boolean;
  readonly actorIdle: boolean;
}

export class SessionRegistryUnavailableError extends Error {
  readonly code = "session.unavailable";

  constructor(readonly sessionId: string, cause: unknown) {
    super(`Session ${sessionId} is unavailable after its actor faulted`, { cause });
    this.name = "SessionRegistryUnavailableError";
  }
}

export class SessionActorRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly createActor: CreateSessionActor;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly beforeEvict: ((sessionId: string) => void | Promise<void>) | undefined;
  private readonly shutdownWait: ShutdownWait;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: {
    readonly createActor: CreateSessionActor;
    readonly now: () => number;
    readonly idleTimeoutMs: number;
    readonly beforeEvict?: (sessionId: string) => void | Promise<void>;
    readonly shutdownWait?: ShutdownWait;
  }) {
    if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 0) {
      throw new RangeError("Actor idle timeout must be a nonnegative safe integer");
    }
    this.createActor = options.createActor;
    this.now = options.now;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.beforeEvict = options.beforeEvict;
    this.shutdownWait = options.shutdownWait ?? defaultShutdownWait;
  }

  private newEntry(sessionId: string): RegistryEntry {
    const entry: RegistryEntry = {
      sessionId,
      actorPromise: new Promise<SessionActor>(() => undefined),
      actor: undefined,
      actorVersion: 0,
      references: 0,
      resolveReferencesDrained: null,
      lastActivityMs: this.now(),
      activityVersion: 0,
      fault: null,
      retirement: null,
      eviction: null,
    };
    this.startConstruction(entry, true);
    return entry;
  }

  private startConstruction(entry: RegistryEntry, removeOnFailure: boolean): void {
    const version = ++entry.actorVersion;
    const creating = Promise.resolve().then(() =>
      this.createActor(
        entry.sessionId,
        () => this.touchEntry(entry),
        (error) => this.actorFaulted(entry, version, error),
      ),
    );
    entry.actorPromise = creating.then(
      (actor) => {
        entry.actor = actor;
        return actor;
      },
      (error: unknown) => {
        if (
          removeOnFailure &&
          this.entries.get(entry.sessionId) === entry &&
          entry.retirement === null
        ) {
          this.entries.delete(entry.sessionId);
        }
        throw error;
      },
    );
  }

  private touchEntry(entry: RegistryEntry): void {
    if (this.entries.get(entry.sessionId) !== entry) return;
    entry.lastActivityMs = this.now();
    entry.activityVersion += 1;
  }

  private actorFaulted(entry: RegistryEntry, version: number, error: unknown): void {
    if (
      this.closed ||
      this.entries.get(entry.sessionId) !== entry ||
      entry.actorVersion !== version
    ) {
      return;
    }
    if (entry.fault === null) entry.fault = error;
    this.touchEntry(entry);
    if (entry.retirement !== null) return;

    const referencesDrained =
      entry.references === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            entry.resolveReferencesDrained = resolve;
          });
    entry.retirement = this.retireFaultedActor(entry, referencesDrained);
    // Retirement is also observed by acquire/close. This prevents an unhandled rejection when
    // neither happens before a quarantined session is diagnosed.
    void entry.retirement.catch(() => undefined);
  }

  private async retireFaultedActor(
    entry: RegistryEntry,
    referencesDrained: Promise<void>,
  ): Promise<void> {
    try {
      await referencesDrained;
      const oldActor = await entry.actorPromise;
      await oldActor.shutdown();
      if (this.closed || this.entries.get(entry.sessionId) !== entry) return;
      if (entry.fault instanceof EventHubIntegrityError) {
        // Rebuilding would erase evidence that committed live history became inconsistent.
        throw entry.fault;
      }

      entry.actor = undefined;
      entry.fault = null;
      this.startConstruction(entry, false);
      const replacement = await entry.actorPromise;
      if (this.closed || this.entries.get(entry.sessionId) !== entry) {
        await replacement.shutdown();
        return;
      }
      if (entry.fault !== null) {
        await replacement.shutdown();
        throw entry.fault;
      }
      entry.retirement = null;
    } catch (error) {
      if (entry.fault === null) entry.fault = error;
      if (error instanceof SessionRegistryUnavailableError) throw error;
      throw new SessionRegistryUnavailableError(entry.sessionId, error);
    }
  }

  private releaseReference(entry: RegistryEntry): void {
    entry.references -= 1;
    if (entry.references < 0) throw new Error("Actor reference count became negative");
    if (entry.references === 0 && entry.resolveReferencesDrained !== null) {
      const resolve = entry.resolveReferencesDrained;
      entry.resolveReferencesDrained = null;
      resolve();
    }
    this.touchEntry(entry);
  }

  private async awaitRetirement(entry: RegistryEntry): Promise<void> {
    const retirement = entry.retirement;
    if (retirement === null) return;
    try {
      await retirement;
    } catch (error) {
      if (error instanceof SessionRegistryUnavailableError) throw error;
      throw new SessionRegistryUnavailableError(entry.sessionId, error);
    }
  }

  async acquire(sessionId: string): Promise<SessionActorLease> {
    if (this.closed) throw new Error("Session actor registry is closed");
    let entry = this.entries.get(sessionId);
    if (entry?.retirement !== null && entry?.retirement !== undefined) {
      await this.awaitRetirement(entry);
      return this.acquire(sessionId);
    }
    if (entry?.eviction !== null && entry?.eviction !== undefined) {
      try {
        await entry.eviction;
      } catch (error) {
        throw new Error("Session actor eviction failed during acquire", { cause: error });
      }
      return this.acquire(sessionId);
    }
    if (entry === undefined) {
      entry = this.newEntry(sessionId);
      this.entries.set(sessionId, entry);
    }
    entry.references += 1;
    this.touchEntry(entry);
    let actor: SessionActor;
    try {
      actor = await entry.actorPromise;
    } catch (error) {
      this.releaseReference(entry);
      if (entry.retirement !== null) {
        await this.awaitRetirement(entry);
        return this.acquire(sessionId);
      }
      throw error;
    }
    if (entry.retirement !== null) {
      this.releaseReference(entry);
      await this.awaitRetirement(entry);
      return this.acquire(sessionId);
    }
    if (this.closed || this.entries.get(sessionId) !== entry || entry.eviction !== null) {
      this.releaseReference(entry);
      throw new Error("Session actor registry closed during acquire");
    }

    let released = false;
    return {
      actor,
      release: () => {
        if (released) return;
        released = true;
        this.releaseReference(entry);
      },
    };
  }

  states(): readonly SessionRegistryEntryState[] {
    return [...this.entries.values()].map((entry) => ({
      sessionId: entry.sessionId,
      references: entry.references,
      lastActivityMs: entry.lastActivityMs,
      activityVersion: entry.activityVersion,
      constructing: entry.actor === undefined,
      evicting: entry.eviction !== null,
      faulted: entry.fault !== null,
      retiring: entry.retirement !== null,
      actorIdle: entry.actor?.isIdle() ?? false,
    }));
  }

  async evictIdle(): Promise<readonly string[]> {
    const evicted: string[] = [];
    for (const entry of [...this.entries.values()]) {
      const actor = entry.actor;
      if (
        actor === undefined ||
        entry.eviction !== null ||
        entry.retirement !== null ||
        entry.references !== 0 ||
        !actor.isIdle() ||
        this.now() - entry.lastActivityMs < this.idleTimeoutMs
      ) {
        continue;
      }
      const version = entry.activityVersion;
      await this.beforeEvict?.(entry.sessionId);
      if (
        this.entries.get(entry.sessionId) !== entry ||
        entry.references !== 0 ||
        entry.activityVersion !== version ||
        entry.retirement !== null ||
        !actor.isIdle()
      ) {
        continue;
      }

      entry.eviction = actor.shutdown();
      // A rejected eviction stays on the entry because the old actor may still own live work.
      await entry.eviction;
      if (this.entries.get(entry.sessionId) === entry && entry.references === 0) {
        this.entries.delete(entry.sessionId);
        evicted.push(entry.sessionId);
      }
    }
    return evicted;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    for (const entry of this.entries.values()) entry.resolveReferencesDrained?.();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    const completion = this.completeClose();
    if (!(await this.shutdownWait(completion))) {
      // Actors that finish constructing later still run their cleanup in completeClose.
      void completion.catch(() => undefined);
      throw new ShutdownTimeoutError("Session actor registry");
    }
    await completion;
  }

  private async completeClose(): Promise<void> {
    const shutdowns = await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        if (entry.retirement !== null) {
          await entry.retirement;
          return;
        }
        const actor = await entry.actorPromise;
        await actor.shutdown();
      }),
    );
    const errors = shutdowns.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more session actors failed to shut down");
    }
    this.entries.clear();
  }
}
