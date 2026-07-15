export interface CoalescerClock {
  readonly now: () => number;
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

const systemClock: CoalescerClock = {
  now: () => Date.now(),
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export class TextDeltaCoalescer {
  private readonly maxChars: number;
  private readonly maxDelayMs: number;
  private readonly clock: CoalescerClock;
  private readonly onFlush: (text: string) => Promise<void>;
  private buffer = "";
  private bufferedAtMs: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private tail = Promise.resolve();
  private failure: unknown | null = null;
  private closed = false;

  constructor(options: {
    readonly maxChars: number;
    readonly maxDelayMs: number;
    readonly onFlush: (text: string) => Promise<void>;
    readonly clock?: CoalescerClock;
  }) {
    if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) {
      throw new RangeError("Text coalescer size threshold must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxDelayMs) || options.maxDelayMs < 1) {
      throw new RangeError("Text coalescer time threshold must be a positive safe integer");
    }
    this.maxChars = options.maxChars;
    this.maxDelayMs = options.maxDelayMs;
    this.onFlush = options.onFlush;
    this.clock = options.clock ?? systemClock;
  }

  private throwFailure(): void {
    if (this.failure !== null) throw this.failure;
  }

  private queueFlush(): Promise<void> {
    if (this.buffer.length === 0) return this.tail;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const text = this.buffer;
    this.buffer = "";
    this.bufferedAtMs = null;
    this.tail = this.tail.then(() => this.onFlush(text));
    return this.tail;
  }

  private startTimer(): void {
    if (this.cancelTimer !== null) return;
    this.cancelTimer = this.clock.schedule(this.maxDelayMs, () => {
      this.cancelTimer = null;
      void this.queueFlush().catch((error: unknown) => {
        this.failure = error;
      });
    });
  }

  async push(delta: string): Promise<void> {
    if (this.closed) throw new Error("Text coalescer is closed");
    this.throwFailure();
    if (delta.length === 0) return;
    const now = this.clock.now();
    this.bufferedAtMs ??= now;
    this.buffer += delta;
    if (
      this.buffer.length >= this.maxChars ||
      now - this.bufferedAtMs >= this.maxDelayMs
    ) {
      await this.queueFlush();
      this.throwFailure();
      return;
    }
    this.startTimer();
  }

  async flush(): Promise<void> {
    this.throwFailure();
    await this.queueFlush();
    this.throwFailure();
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.tail;
      this.throwFailure();
      return;
    }
    this.closed = true;
    await this.flush();
  }
}
