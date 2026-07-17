import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@wi/protocol";
import {
  OutboundQueue,
  SLOW_CONSUMER_CLOSE_CODE,
  type OutboundTransport,
} from "./outbound-queue.js";

class ControlledTransport implements OutboundTransport {
  readonly sent: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(data: string, callback: (error?: Error | null) => void): void {
    this.sent.push(data);
    this.callbacks.push(callback);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  completeNext(error?: Error | null): void {
    const callback = this.callbacks.shift();
    if (callback === undefined) throw new Error("No controlled send is pending");
    callback(error);
  }
}

function heartbeat(serverTimeMs: number): ServerMessage {
  return { v: 1, kind: "heartbeat", serverTimeMs };
}

function terminalEvent(sequence: number): ServerMessage {
  return {
    v: 1,
    kind: "event",
    sessionId: "ses_queue",
    sequence,
    eventId: `evt_queue${sequence}`,
    eventType: "run.completed",
    createdAtMs: sequence,
    data: { eventVersion: 1, runId: "run_queue" },
  };
}

describe("OutboundQueue", () => {
  it("accounts for the in-flight message and drains in FIFO order", async () => {
    const transport = new ControlledTransport();
    const queue = new OutboundQueue(transport, {
      maximumMessages: 3,
      maximumBytes: 1_024,
      maximumSingleMessageBytes: 512,
    });

    expect(queue.enqueue(heartbeat(1))).toBe(true);
    expect(queue.enqueue(heartbeat(2))).toBe(true);
    expect(queue.state.messages).toBe(2);
    expect(transport.sent).toHaveLength(1);

    transport.completeNext();
    expect(transport.sent).toHaveLength(2);
    transport.completeNext();
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(queue.state).toMatchObject({ messages: 0, bytes: 0, closed: false });
  });

  it("closes before exceeding a configured bound", () => {
    const transport = new ControlledTransport();
    const queue = new OutboundQueue(transport, {
      maximumMessages: 2,
      maximumBytes: 1_024,
      maximumSingleMessageBytes: 512,
    });

    expect(queue.enqueue(heartbeat(1))).toBe(true);
    expect(queue.enqueue(heartbeat(2))).toBe(true);
    expect(queue.enqueue(heartbeat(3))).toBe(false);
    expect(queue.state).toMatchObject({
      messages: 0,
      bytes: 0,
      closed: true,
      closeReason: "slow_consumer",
    });
    expect(transport.closes).toEqual([
      { code: SLOW_CONSUMER_CLOSE_CODE, reason: "slow consumer" },
    ]);
  });

  it("never silently discards non-droppable terminal events", () => {
    const transport = new ControlledTransport();
    const queue = new OutboundQueue(transport, {
      maximumMessages: 1,
      maximumBytes: 1_024,
      maximumSingleMessageBytes: 512,
    });

    expect(queue.enqueue(terminalEvent(1))).toBe(true);
    expect(queue.enqueue(terminalEvent(2))).toBe(false);
    expect(queue.state.closeReason).toBe("slow_consumer");
    expect(transport.closes[0]?.code).toBe(SLOW_CONSUMER_CLOSE_CODE);
  });

  it("waits for capacity without misclassifying a draining transport", async () => {
    const transport = new ControlledTransport();
    const queue = new OutboundQueue(transport, {
      maximumMessages: 1,
      maximumBytes: 1_024,
      maximumSingleMessageBytes: 512,
    });

    expect(queue.enqueue(heartbeat(1))).toBe(true);
    const waiting = queue.enqueueWhenAvailable(heartbeat(2), { timeoutMs: 1_000 });
    transport.completeNext();
    await expect(waiting).resolves.toBe(true);
    expect(queue.state).toMatchObject({ messages: 1, closed: false });
    transport.completeNext();
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("disconnects a subscriber that cannot drain before its capacity deadline", async () => {
    const transport = new ControlledTransport();
    const queue = new OutboundQueue(transport, {
      maximumMessages: 1,
      maximumBytes: 1_024,
      maximumSingleMessageBytes: 512,
    });

    expect(queue.enqueue(heartbeat(1))).toBe(true);
    await expect(
      queue.enqueueWhenAvailable(heartbeat(2), { timeoutMs: 5 }),
    ).resolves.toBe(false);
    expect(queue.state.closeReason).toBe("slow_consumer");
    expect(transport.closes).toEqual([
      { code: SLOW_CONSUMER_CLOSE_CODE, reason: "slow consumer" },
    ]);
  });

  it("maps asynchronous transport failure to a connection close", () => {
    const transport = new ControlledTransport();
    const observed: unknown[] = [];
    const queue = new OutboundQueue(
      transport,
      {
        maximumMessages: 2,
        maximumBytes: 1_024,
        maximumSingleMessageBytes: 512,
      },
      (error) => observed.push(error),
    );
    queue.enqueue(heartbeat(1));
    const failure = new Error("injected send failure");
    transport.completeNext(failure);
    expect(observed).toEqual([failure]);
    expect(queue.state.closeReason).toBe("transport_error");
    expect(transport.closes).toEqual([{ code: 1011, reason: "transport error" }]);
  });
});
