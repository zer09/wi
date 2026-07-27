import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  ClientMessageSchema,
  SessionEventSchema,
  type SessionEvent,
} from "@wi/protocol";
import {
  RunScheduler,
  type FifoSemaphore,
} from "../../packages/harness-core/src/index.js";
import { reconcileCommittedEventBatch } from "../../packages/harness-core/src/event-reconciliation.js";
import type { WiRuntime } from "../../apps/server/src/composition.js";
import {
  BrowserConnection,
  type ConnectionLimits,
} from "../../apps/server/src/websocket/connection.js";
import {
  decodeClientFrame,
  FrameDecodeError,
} from "../../apps/server/src/websocket/frame-decoder.js";
import { JsonLogger, type LogRecord } from "../../apps/server/src/logging/logger.js";
import { assertMilestone8Property } from "./support/milestone8.js";

const PROPERTY_COUNT = 9;
const TEST_FILE = "tests/property/milestone8-hardening.test.ts";
const frameLimits = { maximumBytes: 16 * 1_024, maximumDepth: 8 } as const;
const allowedDecodeCodes = new Set([
  "protocol.invalid_json",
  "protocol.invalid_message",
  "protocol.message_too_large",
  "protocol.unsupported_version",
]);
const openConnections = new Set<BrowserConnection>();

function assertTypedDecode(bytes: Uint8Array, isBinary = false): void {
  try {
    const decoded = decodeClientFrame(bytes, isBinary, frameLimits);
    expect(ClientMessageSchema.safeParse(decoded).success).toBe(true);
  } catch (error) {
    expect(error).toBeInstanceOf(FrameDecodeError);
    const decodeError = error as FrameDecodeError;
    expect(allowedDecodeCodes.has(decodeError.code)).toBe(true);
    expect(decodeError.message.length).toBeLessThanOrEqual(512);
    if (decodeError.code === "protocol.message_too_large") expect(decodeError.fatal).toBe(true);
  }
}

const unusualText = fc
  .array(
    fc.constantFrom("\u0000", "e\u0301", "👩🏽‍💻", "\ud800", "\udfff", " ", " ", "\\", '"'),
    { maxLength: 24 },
  )
  .map((parts) => parts.join(""));

function validCommandFrame(text: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 1,
    kind: "command",
    commandId: "cmd_m8LargeValid",
    sessionId: "ses_m8LargeValid",
    method: "message.submit",
    params: { text },
  }));
}

const emptyValidFrameBytes = validCommandFrame("").byteLength;
const largeValidFrame = fc
  .tuple(
    unusualText,
    fc.constantFrom(
      frameLimits.maximumBytes - 128,
      frameLimits.maximumBytes - 1,
      frameLimits.maximumBytes,
      frameLimits.maximumBytes + 1,
      frameLimits.maximumBytes + 128,
    ),
  )
  .map(([prefix, targetBytes]) => {
    const encodedPrefixBytes = Buffer.byteLength(JSON.stringify(prefix), "utf8") - 2;
    const paddingBytes = targetBytes - emptyValidFrameBytes - encodedPrefixBytes;
    if (paddingBytes < 0) throw new Error("Generated large-string prefix exceeded its frame budget");
    const bytes = validCommandFrame(`${prefix}${"x".repeat(paddingBytes)}`);
    if (bytes.byteLength !== targetBytes) throw new Error("Generated valid frame missed its byte target");
    return { bytes, targetBytes };
  });

const targetedFrame = fc.oneof(
  fc.uint8Array({ maxLength: 2_048 }).map((bytes) => ({ bytes, isBinary: false })),
  fc.uint8Array({ maxLength: 2_048 }).map((bytes) => ({ bytes, isBinary: true })),
  fc.integer({ min: 1, max: 16 }).map((depth) => ({
    bytes: new TextEncoder().encode(`${"[".repeat(depth)}0${"]".repeat(depth)}`),
    isBinary: false,
  })),
  unusualText.map((text) => ({
    bytes: new TextEncoder().encode(JSON.stringify({
      v: 1,
      kind: "command",
      commandId: "cmd_m8Unicode",
      sessionId: "ses_m8Unicode",
      method: "message.submit",
      params: { text },
    })),
    isBinary: false,
  })),
  fc.constantFrom(
    '{"v":2,"kind":"heartbeat","clientTimeMs":1}',
    '{"v":1,"kind":"unknown"}',
    '{"v":1,"kind":"command","commandId":"cmd_m8","method":"unknown","params":{}}',
    '{"v":1,"kind":"heartbeat","clientTimeMs":1,"clientTimeMs":2}',
    '{"v":1,"kind":"command","commandId":"cmd_m8","sessionId":"ses_m8","method":"message.submit","params":{"text":1}}',
    '{"v":1,"kind":"heartbeat"',
  ).map((text) => ({ bytes: new TextEncoder().encode(text), isBinary: false })),
);

class MemorySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string, callback?: (error?: Error | null) => void): void {
    this.sent.push(data);
    callback?.(null);
  }

  close(code = 1_000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }

  terminate(): void {
    this.close(1_006);
  }

  ping(): void {}
}

const connectionLimits: ConnectionLimits = {
  frame: frameLimits,
  outbound: {
    maximumMessages: 64,
    maximumBytes: 256 * 1_024,
    maximumSingleMessageBytes: 64 * 1_024,
  },
  maximumPendingInboundMessages: 64,
  maximumPendingInboundBytes: 256 * 1_024,
  maximumProtocolViolations: 2_000,
  maximumSubscriptions: 8,
  replayLiveEvents: 64,
  replayLiveBytes: 256 * 1_024,
  replaySingleEventBytes: 64 * 1_024,
  replayPageEvents: 64,
  replayPageBytes: 256 * 1_024,
  replayPageSingleEventBytes: 64 * 1_024,
  replayQueueWaitTimeoutMs: 1_000,
  maximumDurableCommandPayloadBytes: 64 * 1_024,
};

async function waitForInbound(connection: BrowserConnection): Promise<void> {
  while (connection.snapshot.pendingInboundMessages !== 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const invalidRoutedFrame = fc
  .record({
    mutation: fc.constantFrom(
      "version",
      "kind",
      "top_extra",
      "command_id_type",
      "command_session",
      "command_method",
      "session_create_project",
      "session_create_title",
      "message_param_type",
      "message_param_extra",
      "cancel_param_type",
      "approval_id_type",
      "approval_resolution",
      "input_id_type",
      "input_param_extra",
      "hello_client",
      "resume_session",
      "resume_sequence",
      "resume_extra",
      "subscribe_request",
      "subscribe_session",
      "subscribe_sequence",
      "unsubscribe_request",
      "unsubscribe_session",
      "unsubscribe_extra",
      "heartbeat_time",
    ),
    suffix: fc.string({ maxLength: 64 }),
  })
  .map(({ mutation, suffix }) => {
    const secret = `AUDIT_FUZZ_SECRET${suffix}`;
    if (mutation === "version") return JSON.stringify({ v: 2, kind: "heartbeat", clientTimeMs: 1 });
    if (mutation === "kind") return JSON.stringify({ v: 1, kind: "unknown", secret });
    if (mutation === "top_extra") {
      return JSON.stringify({ v: 1, kind: "heartbeat", clientTimeMs: 1, extra: secret });
    }
    if (mutation === "heartbeat_time") {
      return JSON.stringify({ v: 1, kind: "heartbeat", clientTimeMs: secret });
    }
    if (mutation === "command_id_type") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: 1,
        sessionId: "ses_m8Route",
        method: "message.submit",
        params: { text: secret },
      });
    }
    if (mutation === "command_session") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: 1,
        method: "message.submit",
        params: { text: secret },
      });
    }
    if (mutation === "command_method") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "unknown",
        params: { text: secret },
      });
    }
    if (mutation === "session_create_project" || mutation === "session_create_title") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        method: "session.create",
        params: mutation === "session_create_project"
          ? { projectId: 1, title: secret }
          : { title: 1 },
      });
    }
    if (mutation === "message_param_type") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "message.submit",
        params: { text: 1 },
      });
    }
    if (mutation === "message_param_extra") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "message.submit",
        params: { text: "ok", extra: secret },
      });
    }
    if (mutation === "cancel_param_type") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "run.cancel",
        params: { runId: 1 },
      });
    }
    if (mutation === "approval_id_type" || mutation === "approval_resolution") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "approval.resolve",
        params: {
          approvalId: mutation === "approval_id_type" ? 1 : "approval_m8Route",
          resolution: mutation === "approval_resolution" ? secret : "approved",
        },
      });
    }
    if (mutation === "input_id_type") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "input.respond",
        params: { inputId: 1, value: secret },
      });
    }
    if (mutation === "input_param_extra") {
      return JSON.stringify({
        v: 1,
        kind: "command",
        commandId: "cmd_m8Route",
        sessionId: "ses_m8Route",
        method: "input.respond",
        params: { inputId: "input_m8Route", value: "ok", extra: secret },
      });
    }
    if (mutation === "hello_client") {
      return JSON.stringify({ v: 1, kind: "hello", clientId: 1, resume: [] });
    }
    if (mutation === "resume_session" || mutation === "resume_sequence") {
      return JSON.stringify({
        v: 1,
        kind: "hello",
        clientId: "client_m8Route",
        resume: [
          mutation === "resume_session"
            ? { sessionId: 1, afterSequence: 0 }
            : { sessionId: "ses_m8Route", afterSequence: -1 },
        ],
      });
    }
    if (mutation === "resume_extra") {
      return JSON.stringify({
        v: 1,
        kind: "hello",
        clientId: "client_m8Route",
        resume: [{ sessionId: "ses_m8Route", afterSequence: 0, extra: secret }],
      });
    }
    if (mutation.startsWith("subscribe_")) {
      return JSON.stringify({
        v: 1,
        kind: "subscribe",
        requestId: mutation === "subscribe_request" ? 1 : "request_m8Route",
        sessionId: mutation === "subscribe_session" ? 1 : "ses_m8Route",
        afterSequence: mutation === "subscribe_sequence" ? -1 : 0,
      });
    }
    return JSON.stringify({
      v: 1,
      kind: "unsubscribe",
      requestId: mutation === "unsubscribe_request" ? 1 : "request_m8Route",
      sessionId: mutation === "unsubscribe_session" ? 1 : "ses_m8Route",
      ...(mutation === "unsubscribe_extra" ? { extra: secret } : {}),
    });
  });

async function routingIsolation(frame: string): Promise<void> {
  const socket = new MemorySocket();
  const records: LogRecord[] = [];
  let routes = 0;
  let diagnostic = 0;
  const runtime = {
    diagnosticId: () => `err_m8Route${++diagnostic}`,
    now: () => 1,
    commandRouter: {
      route: async () => {
        routes += 1;
        return {
          v: 1,
          kind: "command.accepted",
          commandId: "cmd_m8Unexpected",
          result: null,
          duplicate: false,
        } as const;
      },
    },
  } as unknown as WiRuntime;
  const request = { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
  const connection = new BrowserConnection(
    socket as unknown as WebSocket,
    request,
    runtime,
    new JsonLogger({ now: () => 1, write: (record) => records.push(record) }),
    connectionLimits,
    { intervalMs: 60_000, helloTimeoutMs: 60_000 },
  );
  openConnections.add(connection);
  socket.emit(
    "message",
    Buffer.from('{"v":1,"kind":"hello","clientId":"client_m8Route","resume":[]}'),
    false,
  );
  await waitForInbound(connection);
  socket.emit("message", Buffer.from(frame), false);
  await waitForInbound(connection);

  expect(routes).toBe(0);
  const protocolRecord = records.find((record) => record.event === "websocket_protocol_error");
  expect(protocolRecord?.payload).toMatchObject({
    sourceUnit: "bytes",
    sourceLength: Buffer.byteLength(frame),
    sampledByteLength: expect.any(Number),
    sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    truncated: expect.any(Boolean),
  });
  expect(JSON.stringify(records)).not.toContain("AUDIT_FUZZ_SECRET");
  await connection.shutdown();
  openConnections.delete(connection);
}

afterEach(async () => {
  await Promise.allSettled([...openConnections].map((connection) => connection.shutdown()));
  openConnections.clear();
});

describe("Milestone 8 mandatory property and fuzz hardening", () => {
  it("classifies arbitrary bounded JSON trees as typed success or bounded typed error", async () => {
    await assertMilestone8Property({
      suite: "protocol fuzzing",
      test: "classifies arbitrary bounded JSON trees as typed success or bounded typed error",
      testFile: TEST_FILE,
      propertyCount: PROPERTY_COUNT,
      property: fc.property(fc.jsonValue({ maxDepth: 6, noUnicodeString: false }), (value) => {
        assertTypedDecode(new TextEncoder().encode(JSON.stringify(value)));
      }),
    });
  }, 30_000);

  it("accepts exact-limit valid JSON strings and rejects only over-limit envelopes", async () => {
    await assertMilestone8Property({
      suite: "protocol fuzzing",
      test: "accepts exact-limit valid JSON strings and rejects only over-limit envelopes",
      testFile: TEST_FILE,
      propertyCount: PROPERTY_COUNT,
      property: fc.property(largeValidFrame, ({ bytes, targetBytes }) => {
        if (targetBytes <= frameLimits.maximumBytes) {
          expect(ClientMessageSchema.safeParse(decodeClientFrame(bytes, false, frameLimits)).success).toBe(true);
          return;
        }
        expect(() => decodeClientFrame(bytes, false, frameLimits)).toThrowError(FrameDecodeError);
        try {
          decodeClientFrame(bytes, false, frameLimits);
        } catch (error) {
          expect(error).toMatchObject({ code: "protocol.message_too_large", fatal: true });
        }
      }),
    });
  }, 30_000);

  it("classifies malformed bytes, depth, size, Unicode, versions, and corrupt envelopes", async () => {
    await assertMilestone8Property({
      suite: "protocol fuzzing",
      test: "classifies malformed bytes, depth, size, Unicode, versions, and corrupt envelopes",
      testFile: TEST_FILE,
      propertyCount: PROPERTY_COUNT,
      property: fc.property(targetedFrame, fc.integer({ min: -1, max: 1 }), (frame, delta) => {
        assertTypedDecode(frame.bytes, frame.isBinary);
        const boundary = new Uint8Array(frameLimits.maximumBytes + delta);
        try {
          decodeClientFrame(boundary, false, frameLimits);
        } catch (error) {
          expect(error).toBeInstanceOf(FrameDecodeError);
          if (delta > 0) {
            expect(error).toMatchObject({ code: "protocol.message_too_large", fatal: true });
          }
        }
      }),
    });
  }, 30_000);

  it("never routes generated invalid raw frames and logs only bounded fingerprints", async () => {
    await assertMilestone8Property({
      suite: "protocol fuzzing",
      test: "never routes generated invalid raw frames and logs only bounded fingerprints",
      testFile: TEST_FILE,
      propertyCount: PROPERTY_COUNT,
      property: fc.asyncProperty(invalidRoutedFrame, routingIsolation),
    });
  }, 30_000);

  it("classifies committed event batches against append-only reconciliation rules", async () => {
    const corruption = fc.constantFrom(
      "none" as const,
      "absent" as const,
      "partial" as const,
      "identity" as const,
      "sequence" as const,
      "head" as const,
      "projection" as const,
    );
    await assertMilestone8Property({
      suite: "event-store model",
      test: "classifies committed event batches against append-only reconciliation rules",
      testFile: TEST_FILE,
      propertyCount: PROPERTY_COUNT,
      property: fc.property(fc.integer({ min: 1, max: 8 }), corruption, (count, fault) => {
        const expected = Array.from({ length: count }, (_, index) => ({
          eventId: `evt_m8Store${index}`,
          eventType: "run.created" as const,
          createdAtMs: index + 1,
          data: { eventVersion: 1 as const, runId: `run_m8Store${index}` },
        }));
        let stored: Array<SessionEvent | null> = expected.map((item, index) =>
          SessionEventSchema.parse({
            v: 1,
            kind: "event",
            sessionId: "ses_m8Store",
            sequence: index + 1,
            ...item,
          }),
        );
        if (fault === "absent") stored = stored.map(() => null);
        else if (fault === "partial") stored[0] = null;
        else if (fault === "identity") {
          const first = stored[0];
          if (first !== null && first !== undefined) {
            stored[0] = { ...first, eventId: "evt_m8Changed" };
          }
        } else if (fault === "sequence") {
          const first = stored[0];
          if (first !== null && first !== undefined) stored[0] = { ...first, sequence: 2 };
        }
        const head = fault === "head" ? count + 1 : count;
        const projectionsApplied = fault !== "projection";
        if (fault === "none") {
          const result = reconcileCommittedEventBatch(
            "ses_m8Store",
            expected,
            stored,
            head,
            projectionsApplied,
          );
          expect(result?.events).toEqual(stored);
          expect(result?.headSequence).toBe(count);
        } else if (fault === "absent" || stored.every((item) => item === null)) {
          expect(
            reconcileCommittedEventBatch(
              "ses_m8Store",
              expected,
              stored,
              head,
              projectionsApplied,
            ),
          ).toBeNull();
        } else {
          expect(() =>
            reconcileCommittedEventBatch(
              "ses_m8Store",
              expected,
              stored,
              head,
              projectionsApplied,
            ),
          ).toThrowError(expect.objectContaining({ code: "storage.corrupt" }));
        }
      }),
    });
  }, 30_000);

  it("bounds scheduler concurrency, preserves FIFO, removes cancellations, and restores permits", async () => {
    await assertMilestone8Property({
      suite: "scheduler model",
      test: "bounds scheduler concurrency, preserves FIFO, removes cancellations, and restores permits",
      testFile: TEST_FILE,
      propertyCount: PROPERTY_COUNT,
      property: fc.asyncProperty(
        fc.constantFrom("provider" as const, "tool" as const),
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.record({ cancelQueued: fc.boolean(), fail: fc.boolean() }),
          { minLength: 1, maxLength: 24 },
        ),
        async (kind, capacity, outcomes) => {
          const scheduler = new RunScheduler({
            providerCapacity: kind === "provider" ? capacity : 1,
            toolCapacity: kind === "tool" ? capacity : 1,
          });
          const semaphore: FifoSemaphore = scheduler[kind];
          const gates = outcomes.map(() => {
            let resolve = (): void => {};
            const promise = new Promise<void>((settle) => {
              resolve = settle;
            });
            return { promise, resolve };
          });
          const controllers = outcomes.map(() => new AbortController());
          const started: number[] = [];
          let active = 0;
          let maximum = 0;
          const tasks = outcomes.map((outcome, index) =>
            semaphore.withPermit(controllers[index]?.signal, async () => {
              started.push(index);
              active += 1;
              maximum = Math.max(maximum, active);
              try {
                await gates[index]?.promise;
                if (outcome.fail) throw new Error(`generated task failure ${index}`);
              } finally {
                active -= 1;
              }
            }),
          );
          await Promise.resolve();
          outcomes.forEach((outcome, index) => {
            if (index >= capacity && outcome.cancelQueued) controllers[index]?.abort();
          });
          for (const gate of gates) gate.resolve();
          await Promise.allSettled(tasks);

          expect(maximum).toBeLessThanOrEqual(capacity);
          expect(started).toEqual(
            outcomes.flatMap((outcome, index) =>
              index >= capacity && outcome.cancelQueued ? [] : [index],
            ),
          );
          expect(semaphore.state).toMatchObject({
            active: 0,
            available: capacity,
            queued: 0,
          });
          await scheduler.shutdown();
        },
      ),
    });
  }, 30_000);
});
