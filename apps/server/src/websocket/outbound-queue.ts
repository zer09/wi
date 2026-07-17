import { ServerMessageSchema, type ServerMessage } from "@wi/protocol";

export const SLOW_CONSUMER_CLOSE_CODE = 4409;

export interface OutboundQueueLimits {
  readonly maximumMessages: number;
  readonly maximumBytes: number;
  readonly maximumSingleMessageBytes: number;
}

export interface OutboundTransport {
  send(data: string, callback: (error?: Error | null) => void): void;
  close(code: number, reason: string): void;
}

interface QueueEntry {
  readonly data: string;
  readonly bytes: number;
}

export interface OutboundEnqueueWaitOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface OutboundQueueState {
  readonly messages: number;
  readonly bytes: number;
  readonly sending: boolean;
  readonly closed: boolean;
  readonly closeReason: "slow_consumer" | "transport_error" | "stopped" | null;
}

export class OutboundQueue {
  private readonly entries: QueueEntry[] = [];
  private bytes = 0;
  private sending = false;
  private closed = false;
  private closeReason: OutboundQueueState["closeReason"] = null;
  private readonly idleWaiters = new Set<() => void>();
  private readonly capacityWaiters = new Set<() => void>();

  constructor(
    private readonly transport: OutboundTransport,
    private readonly limits: OutboundQueueLimits,
    private readonly onTransportError: (error: unknown) => void = () => undefined,
    private readonly onForcedClose: (
      reason: "slow_consumer" | "transport_error",
    ) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(limits.maximumMessages) || limits.maximumMessages < 1) {
      throw new RangeError("Outbound message limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limits.maximumBytes) || limits.maximumBytes < 1) {
      throw new RangeError("Outbound byte limit must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(limits.maximumSingleMessageBytes) ||
      limits.maximumSingleMessageBytes < 1 ||
      limits.maximumSingleMessageBytes > limits.maximumBytes
    ) {
      throw new RangeError("Outbound single-message limit must fit within the byte limit");
    }
  }

  get state(): OutboundQueueState {
    return {
      messages: this.entries.length,
      bytes: this.bytes,
      sending: this.sending,
      closed: this.closed,
      closeReason: this.closeReason,
    };
  }

  private encode(message: ServerMessage): QueueEntry {
    const validated = ServerMessageSchema.parse(message);
    const data = JSON.stringify(validated);
    return { data, bytes: Buffer.byteLength(data) };
  }

  private canEnqueue(entry: QueueEntry): boolean {
    return (
      this.entries.length < this.limits.maximumMessages &&
      this.bytes <= this.limits.maximumBytes - entry.bytes
    );
  }

  private push(entry: QueueEntry): void {
    this.entries.push(entry);
    this.bytes += entry.bytes;
    this.pump();
  }

  enqueue(message: ServerMessage): boolean {
    if (this.closed) return false;
    const entry = this.encode(message);
    if (entry.bytes > this.limits.maximumSingleMessageBytes || !this.canEnqueue(entry)) {
      // Durable event frames carry sequence identity, so dropping or merging one would create a
      // replay gap. With no sequence-preserving delta batch in v1, disconnect is the only safe path.
      this.failSlowConsumer();
      return false;
    }
    this.push(entry);
    return true;
  }

  async enqueueWhenAvailable(
    message: ServerMessage,
    options: OutboundEnqueueWaitOptions,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new RangeError("Outbound capacity wait timeout must be a positive safe integer");
    }
    if (this.closed) return false;
    const entry = this.encode(message);
    if (entry.bytes > this.limits.maximumSingleMessageBytes) {
      this.failSlowConsumer();
      return false;
    }
    const deadline = Date.now() + options.timeoutMs;
    while (!this.closed) {
      options.signal?.throwIfAborted();
      if (this.canEnqueue(entry)) {
        this.push(entry);
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await this.waitForCapacity(remaining, options.signal))) {
        if (!this.closed) this.failSlowConsumer();
        return false;
      }
    }
    return false;
  }

  private waitForCapacity(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (available: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.capacityWaiters.delete(notify);
        signal?.removeEventListener("abort", abort);
        resolve(available);
      };
      const notify = (): void => finish(true);
      const abort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.capacityWaiters.delete(notify);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new DOMException("Outbound wait aborted", "AbortError"));
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      this.capacityWaiters.add(notify);
      signal?.addEventListener("abort", abort, { once: true });
      if (this.closed) notify();
    });
  }

  private notifyCapacity(): void {
    for (const notify of this.capacityWaiters) notify();
    this.capacityWaiters.clear();
  }

  private failSlowConsumer(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = "slow_consumer";
    this.entries.length = 0;
    this.bytes = 0;
    this.notifyCapacity();
    try {
      this.onForcedClose("slow_consumer");
    } finally {
      this.transport.close(SLOW_CONSUMER_CLOSE_CODE, "slow consumer");
      this.resolveIdle();
    }
  }

  private failTransport(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = "transport_error";
    this.entries.length = 0;
    this.bytes = 0;
    this.notifyCapacity();
    try {
      this.onTransportError(error);
    } finally {
      try {
        this.onForcedClose("transport_error");
      } finally {
        this.transport.close(1011, "transport error");
        this.resolveIdle();
      }
    }
  }

  private pump(): void {
    if (this.closed || this.sending) return;
    const entry = this.entries[0];
    if (entry === undefined) {
      this.resolveIdle();
      return;
    }
    this.sending = true;
    try {
      this.transport.send(entry.data, (error) => {
        this.sending = false;
        if (this.closed) {
          this.resolveIdle();
          return;
        }
        if (error !== undefined && error !== null) {
          this.failTransport(error);
          return;
        }
        const sent = this.entries.shift();
        if (sent !== undefined) this.bytes -= sent.bytes;
        this.notifyCapacity();
        this.pump();
      });
    } catch (error) {
      this.sending = false;
      this.failTransport(error);
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = "stopped";
    this.entries.length = 0;
    this.bytes = 0;
    this.notifyCapacity();
    this.resolveIdle();
  }

  drain(): Promise<void> {
    if (this.entries.length === 0 && !this.sending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private resolveIdle(): void {
    if (!this.closed && (this.entries.length > 0 || this.sending)) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
