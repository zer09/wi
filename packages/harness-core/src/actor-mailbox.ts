import { AsyncLocalStorage } from "node:async_hooks";

export class MailboxClosedError extends Error {
  constructor() {
    super("Actor mailbox is closed");
    this.name = "MailboxClosedError";
  }
}

export class MailboxReentryError extends Error {
  constructor() {
    super("Actor mailbox handlers cannot enqueue back into the same mailbox");
    this.name = "MailboxReentryError";
  }
}

interface MailboxHandlerContext {
  readonly mailbox: ActorMailbox;
  active: boolean;
}

const activeMailboxHandler = new AsyncLocalStorage<MailboxHandlerContext>();

export interface MailboxState {
  readonly accepting: boolean;
  readonly running: boolean;
  readonly queued: number;
  readonly idle: boolean;
}

interface MailboxEntry<T> {
  readonly handler: () => T | Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
}

export class ActorMailbox {
  private readonly queue: MailboxEntry<unknown>[] = [];
  private accepting = true;
  private running = false;
  private drainWaiters: (() => void)[] = [];

  get state(): MailboxState {
    return {
      accepting: this.accepting,
      running: this.running,
      queued: this.queue.length,
      idle: !this.running && this.queue.length === 0,
    };
  }

  enqueue<T>(handler: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new MailboxClosedError());
    const context = activeMailboxHandler.getStore();
    if (this.running && context?.mailbox === this && context.active) {
      return Promise.reject(new MailboxReentryError());
    }
    return this.enqueueEntry(handler);
  }

  // External task callbacks use this deferred path. It intentionally returns void, so calling it
  // from a handler cannot create an awaited queue cycle; the post runs after that handler returns.
  post(handler: () => void | Promise<void>, onError: (error: unknown) => void): void {
    if (!this.accepting) {
      try {
        onError(new MailboxClosedError());
      } catch {
        // Error reporting cannot reopen or poison a closed mailbox.
      }
      return;
    }
    this.queue.push({
      handler,
      resolve: () => undefined,
      reject: onError,
    } as MailboxEntry<unknown>);
    this.pump();
  }

  private enqueueEntry<T>(handler: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ handler, resolve, reject } as MailboxEntry<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const entry = this.queue.shift();
    if (entry === undefined) {
      this.settleDrainWaiters();
      return;
    }

    this.running = true;
    const context: MailboxHandlerContext = { mailbox: this, active: true };
    void Promise.resolve().then(() => activeMailboxHandler.run(context, entry.handler)).then(
      (value) => {
        context.active = false;
        this.running = false;
        entry.resolve(value);
        this.pump();
      },
      (error: unknown) => {
        context.active = false;
        this.running = false;
        try {
          entry.reject(error);
        } catch {
          // A posted handler's diagnostic callback is outside the mailbox state machine.
        } finally {
          this.pump();
        }
      },
    );
  }

  private settleDrainWaiters(): void {
    if (this.running || this.queue.length > 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  shutdown(options: { readonly drain?: boolean } = {}): Promise<void> {
    this.accepting = false;
    if (options.drain === false) {
      const error = new MailboxClosedError();
      for (const entry of this.queue.splice(0)) {
        try {
          entry.reject(error);
        } catch {
          // Reject every queued entry even if one posted diagnostic callback fails.
        }
      }
    }
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
}
