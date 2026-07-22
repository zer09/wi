import { describe, expect, it } from "vitest";

import {
  BoundedIpcRetention,
  PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
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
