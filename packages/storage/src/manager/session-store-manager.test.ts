import { describe, expect, it } from "vitest";

import {
  boundDiscoveryDiagnostic,
  DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
} from "../session/discovery-limits.js";
import { retainNonValidDiscoveryClassification } from "./session-store-manager.js";

describe("catalog discovery retention bounds", () => {
  it("bounds worker-originated discovery diagnostics", () => {
    const oversized = "x".repeat(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS + 1_000);
    const bounded = boundDiscoveryDiagnostic(
      oversized,
      DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
    );

    expect(bounded).toHaveLength(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS);
    expect(bounded.endsWith("…")).toBe(true);
  });

  it("retains only compact classifications for 10,000 corrupt sessions", () => {
    const maximumMessage = "x".repeat(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS);
    const retained = new Map(
      Array.from({ length: 10_000 }, (_, index) => {
        const sessionId = `ses_memoryBound${String(index)}`;
        return [
          sessionId,
          retainNonValidDiscoveryClassification({
            kind: "corrupt",
            sessionId,
            code: "storage.corrupt",
            message: maximumMessage,
          }),
        ] as const;
      }),
    );
    const serialized = JSON.stringify([...retained]);

    expect(retained.size).toBe(10_000);
    expect(serialized.length).toBeLessThan(1_000_000);
    expect(serialized).not.toContain(maximumMessage);
    expect(new Set([...retained.values()].map((value) => JSON.stringify(value)))).toEqual(
      new Set([JSON.stringify({ kind: "corrupt" })]),
    );
  });
});
