import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@wi/protocol";

import { replayRecoveryAction } from "./replay-recovery.js";

type ProtocolErrorMessage = Extract<ServerMessage, { readonly kind: "protocol.error" }>;

function protocolError(
  code: ProtocolErrorMessage["code"],
  recoverable: boolean,
  sessionId: string | null = "ses_recovery",
): ProtocolErrorMessage {
  return {
    v: 1,
    kind: "protocol.error",
    code,
    message: "Safe replay error.",
    diagnosticId: "err_recovery",
    recoverable,
    ...(sessionId === null ? {} : { sessionId }),
  };
}

describe("replay recovery classification", () => {
  it.each([
    "replay.disconnected",
    "replay.query_failed",
    "replay.sequence_gap",
    "replay.subscriber_overflow",
  ] as const)("retries recoverable %s failures", (code) => {
    expect(replayRecoveryAction(protocolError(code, true))).toBe("retry");
  });

  it("rebuilds an in-memory projection when its cursor is ahead", () => {
    expect(replayRecoveryAction(protocolError("replay.cursor_ahead", true))).toBe("reset");
  });

  it("never retries fatal conflicts or uncorrelated errors", () => {
    expect(replayRecoveryAction(protocolError("replay.sequence_conflict", false))).toBe("none");
    expect(replayRecoveryAction(protocolError("replay.query_failed", true, null))).toBe(
      "none",
    );
  });
});
