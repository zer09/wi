export class SemaphoreAbortedError extends Error {
  constructor() {
    super("Semaphore acquisition was aborted");
    this.name = "SemaphoreAbortedError";
  }
}

export class SemaphoreClosedError extends Error {
  constructor() {
    super("Semaphore is closed");
    this.name = "SemaphoreClosedError";
  }
}

export interface SemaphoreState {
  readonly capacity: number;
  readonly active: number;
  readonly available: number;
  readonly queued: number;
  readonly accepting: boolean;
}

interface Waiter {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
}

export class FifoSemaphore {
  readonly capacity: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private drainWaiters: (() => void)[] = [];
  private accepting = true;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Semaphore capacity must be a positive safe integer");
    }
    this.capacity = capacity;
  }

  get state(): SemaphoreState {
    return {
      capacity: this.capacity,
      active: this.active,
      available: this.capacity - this.active,
      queued: this.waiters.length,
      accepting: this.accepting,
    };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (!this.accepting) return Promise.reject(new SemaphoreClosedError());
    if (signal?.aborted === true) return Promise.reject(new SemaphoreAbortedError());
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(new SemaphoreAbortedError());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < this.capacity) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted === true) {
        waiter.reject(new SemaphoreAbortedError());
        continue;
      }

      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        if (this.active < 0) throw new Error("Semaphore permit count became negative");
        this.dispatch();
        this.settleDrainWaiters();
      });
    }
  }

  shutdown(): void {
    if (!this.accepting) return;
    this.accepting = false;
    const error = new SemaphoreClosedError();
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    this.settleDrainWaiters();
  }

  private settleDrainWaiters(): void {
    if (this.active !== 0 || this.waiters.length !== 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  drain(): Promise<void> {
    if (this.active === 0 && this.waiters.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  async withPermit<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted === true) throw new SemaphoreAbortedError();
      return await task();
    } finally {
      release();
    }
  }
}
