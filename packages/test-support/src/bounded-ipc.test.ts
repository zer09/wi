import { describe, expect, it } from "vitest";

import {
  BoundedIpcRetention,
  PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
  snapshotBoundedIpcValue,
} from "./bounded-ipc.js";

function serializedHistoryBytes(retention: BoundedIpcRetention): number {
  return Buffer.byteLength(JSON.stringify(retention.history));
}

describe("BoundedIpcRetention", () => {
  it("charges at least the complete JSON encoding for escape-heavy strings, keys, and numbers", () => {
    const retention = new BoundedIpcRetention(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
      () => false,
    );
    for (let index = 0; index < 31; index += 1) {
      retention.accept({
        type: `escaped-${String(index)}`,
        [`key-${"\0".repeat(64)}-${String(index)}`]: "\0".repeat(8 * 1_024),
      });
    }
    retention.accept({
      type: "maximum-width-numbers",
      values: Array.from({ length: 1_000 }, () => -1.7976931348623157e308),
    });

    const diagnostics = retention.snapshot();
    expect(diagnostics.rejectedMessages).toBe(0);
    expect(diagnostics.pendingRetainedEstimatedBytes).toBeLessThanOrEqual(
      PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
    );
    expect(diagnostics.historyRetainedEstimatedBytes).toBeLessThanOrEqual(
      PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
    );
    expect(serializedHistoryBytes(retention)).toBeLessThanOrEqual(
      diagnostics.historyRetainedEstimatedBytes,
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects the non-finite number %s instead of retaining or snapshotting it as null",
    (value) => {
      const retention = new BoundedIpcRetention(
        PROCESS_IPC_PENDING_MAX_MESSAGES,
        PROCESS_IPC_HISTORY_MAX_MESSAGES,
        () => false,
      );

      retention.accept({ type: "non-finite", value });

      expect(retention.snapshot()).toMatchObject({
        rejectedMessages: 1,
        latestTruncation: { originalType: "non-finite", reason: "protocol" },
      });
      expect(retention.history).toEqual([
        expect.objectContaining({
          type: "wi.test-support.ipc-truncated",
          originalType: "non-finite",
          reason: "protocol",
        }),
      ]);
      expect(() => snapshotBoundedIpcValue({ type: "non-finite", value })).toThrow(
        /protocol limit/u,
      );
    },
  );

  it("retains a bounded snapshot instead of the accepted callback object", () => {
    const retention = new BoundedIpcRetention(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
      () => false,
    );
    const source = {
      type: "callback-message",
      nested: { value: "small", values: ["first", { value: "second" }] },
    };
    retention.accept(source);
    const before = retention.snapshot();

    source.nested.value = "x".repeat(2 * 1024 * 1024);
    source.nested.values[1] = { value: "changed through callback" };

    expect(retention.take("callback-message")).toEqual({
      type: "callback-message",
      nested: { value: "small", values: ["first", { value: "second" }] },
    });
    expect(retention.history).toEqual([
      {
        type: "callback-message",
        nested: { value: "small", values: ["first", { value: "second" }] },
      },
    ]);
    expect(retention.snapshot()).toEqual({
      ...before,
      pendingRetainedMessages: 0,
      pendingRetainedEstimatedBytes: 0,
    });
  });

  it("isolates retained history from taken and history-returned message mutations", () => {
    const retention = new BoundedIpcRetention(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
      () => false,
    );
    retention.accept({
      type: "nested-message",
      nested: { value: "small", values: ["first", { value: "second" }] },
    });
    const before = retention.snapshot();

    const taken = retention.take("nested-message");
    expect(taken).not.toBeNull();
    const takenNested = taken?.nested as {
      value: string;
      values: Array<string | { value: string }>;
    };
    takenNested.value = "x".repeat(2 * 1024 * 1024);
    (takenNested.values[1] as { value: string }).value = "changed through take";

    const firstHistory = retention.history;
    expect(firstHistory).toEqual([
      {
        type: "nested-message",
        nested: { value: "small", values: ["first", { value: "second" }] },
      },
    ]);
    const historyNested = firstHistory[0]?.nested as {
      value: string;
      values: Array<string | { value: string }>;
    };
    historyNested.value = "changed through history";
    historyNested.values[0] = "changed through history array";

    expect(retention.history).toEqual([
      {
        type: "nested-message",
        nested: { value: "small", values: ["first", { value: "second" }] },
      },
    ]);
    expect(retention.snapshot()).toEqual({
      ...before,
      pendingRetainedMessages: 0,
      pendingRetainedEstimatedBytes: 0,
    });
    expect(serializedHistoryBytes(retention)).toBeLessThanOrEqual(
      retention.snapshot().historyRetainedEstimatedBytes,
    );
  });

  it("isolates latest truncation diagnostics from returned snapshot mutations", () => {
    const retention = new BoundedIpcRetention(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
      () => false,
    );
    retention.accept({ type: "too-large", payload: "x".repeat(32 * 1_024) });
    const first = retention.snapshot();
    expect(first.latestTruncation).not.toBeNull();
    const expectedTruncation = { ...first.latestTruncation };

    const mutable = first.latestTruncation as unknown as Record<string, unknown>;
    mutable.preview = "changed externally";
    mutable.reason = "protocol";
    mutable.observedEstimatedBytes = Number.MAX_SAFE_INTEGER;

    const second = retention.snapshot();
    expect(second.latestTruncation).toEqual(expectedTruncation);
    expect(second).toMatchObject({
      totalMessages: 1,
      rejectedMessages: 1,
      oversizedMessages: 1,
    });
  });

  it("evicts unawaited noise before an awaited control", () => {
    const retention = new BoundedIpcRetention(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
      (type) => type === "awaited-control",
    );
    for (let index = 0; index < 10; index += 1) {
      retention.accept({ type: `before-${String(index)}`, payload: "a".repeat(12 * 1_024) });
    }
    retention.accept({ type: "awaited-control", value: "small" });
    for (let index = 0; index < 30; index += 1) {
      retention.accept({ type: `after-${String(index)}`, payload: "a".repeat(12 * 1_024) });
    }

    expect(retention.snapshot().pendingDroppedMessages).toBeGreaterThan(0);
    expect(retention.take("awaited-control")).toMatchObject({
      type: "awaited-control",
      value: "small",
    });
  });

  it("keeps aggregate limits when every retained type is awaited", () => {
    const retention = new BoundedIpcRetention(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
      () => true,
    );
    for (let index = 0; index < 30; index += 1) {
      retention.accept({
        type: `awaited-${String(index)}`,
        payload: "a".repeat(12 * 1_024),
      });
    }

    const diagnostics = retention.snapshot();
    expect(diagnostics.pendingDroppedMessages).toBeGreaterThan(0);
    expect(diagnostics.pendingRetainedEstimatedBytes).toBeLessThanOrEqual(
      PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
    );
    expect(retention.take("awaited-0")).toBeNull();
    expect(retention.take("awaited-29")).toMatchObject({ type: "awaited-29" });
  });
});
