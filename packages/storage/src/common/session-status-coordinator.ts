import { AsyncLocalStorage } from "node:async_hooks";

interface SessionStatusLock {
  tail: Promise<void>;
  queued: number;
}

export class SessionStatusCoordinator {
  readonly #activeSessionIds = new AsyncLocalStorage<ReadonlySet<string>>();
  readonly #locks = new Map<string, SessionStatusLock>();

  private async acquire(sessionId: string): Promise<() => void> {
    let lock = this.#locks.get(sessionId);
    if (lock === undefined) {
      lock = { tail: Promise.resolve(), queued: 0 };
      this.#locks.set(sessionId, lock);
    }
    const predecessor = lock.tail;
    let releaseTail = (): void => undefined;
    lock.tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    lock.queued += 1;
    await predecessor;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      lock.queued -= 1;
      releaseTail();
      if (lock.queued === 0 && this.#locks.get(sessionId) === lock) {
        this.#locks.delete(sessionId);
      }
    };
  }

  async run<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const orderedSessionIds = [...new Set(sessionIds)].sort();
    const activeSessionIds = this.#activeSessionIds.getStore();
    if (activeSessionIds !== undefined) {
      if (orderedSessionIds.every((sessionId) => activeSessionIds.has(sessionId))) {
        return operation();
      }
      throw new Error("A session status operation cannot acquire another session while holding one");
    }

    const releases: (() => void)[] = [];
    try {
      for (const sessionId of orderedSessionIds) {
        releases.push(await this.acquire(sessionId));
      }
      return await this.#activeSessionIds.run(new Set(orderedSessionIds), operation);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}
