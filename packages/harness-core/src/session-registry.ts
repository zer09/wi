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

interface RegistryEntry {
  readonly sessionId: string;
  actorPromise: Promise<SessionActor>;
  actor: SessionActor | undefined;
  references: number;
  lastActivityMs: number;
  activityVersion: number;
  eviction: Promise<void> | null;
}

export interface SessionRegistryEntryState {
  readonly sessionId: string;
  readonly references: number;
  readonly lastActivityMs: number;
  readonly activityVersion: number;
  readonly constructing: boolean;
  readonly evicting: boolean;
  readonly actorIdle: boolean;
}

export class SessionActorRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly createActor: (
    sessionId: string,
    onActivity: () => void,
  ) => Promise<SessionActor>;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly beforeEvict: ((sessionId: string) => void | Promise<void>) | undefined;
  private readonly shutdownWait: ShutdownWait;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: {
    readonly createActor: (sessionId: string, onActivity: () => void) => Promise<SessionActor>;
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
    const creating = this.createActor(sessionId, () => this.touch(sessionId));
    const entry: RegistryEntry = {
      sessionId,
      actorPromise: creating,
      actor: undefined,
      references: 0,
      lastActivityMs: this.now(),
      activityVersion: 0,
      eviction: null,
    };
    entry.actorPromise = creating.then(
      (actor) => {
        entry.actor = actor;
        return actor;
      },
      (error: unknown) => {
        if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
        throw error;
      },
    );
    return entry;
  }

  private touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    entry.lastActivityMs = this.now();
    entry.activityVersion += 1;
  }

  async acquire(sessionId: string): Promise<SessionActorLease> {
    if (this.closed) throw new Error("Session actor registry is closed");
    let entry = this.entries.get(sessionId);
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
    this.touch(sessionId);
    let actor: SessionActor;
    try {
      actor = await entry.actorPromise;
    } catch (error) {
      entry.references -= 1;
      throw error;
    }
    if (this.closed || this.entries.get(sessionId) !== entry || entry.eviction !== null) {
      entry.references -= 1;
      throw new Error("Session actor registry closed during acquire");
    }

    let released = false;
    return {
      actor,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(sessionId);
        if (current !== entry) return;
        current.references -= 1;
        if (current.references < 0) throw new Error("Actor reference count became negative");
        this.touch(sessionId);
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
    const actors = await Promise.allSettled(
      [...this.entries.values()].map((entry) => entry.actorPromise),
    );
    const shutdowns = await Promise.allSettled(
      actors.flatMap((result) => (result.status === "fulfilled" ? [result.value.shutdown()] : [])),
    );
    const errors = [
      ...actors.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ...shutdowns.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more session actors failed to shut down");
    }
    this.entries.clear();
  }
}
