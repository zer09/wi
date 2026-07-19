import { describe, expect, it } from "vitest";

import { BootstrapResponseSchema } from "./bootstrap.js";

const commandLimits = {
  v: 1,
  maximumFrameBytes: 65_536,
  maximumDurablePayloadBytes: 258_048,
  maximumRawInputCodeUnits: 65_536,
  maximumRawInputUtf8Bytes: 65_536,
  maximumJsonDepth: 30,
  maximumJsonNodes: 9_936,
} as const;

describe("browser bootstrap schema", () => {
  it("accepts browser-safe session summaries", () => {
    expect(
      BootstrapResponseSchema.parse({
        v: 1,
        websocketPath: "/ws",
        websocketProtocol: "wi.v1",
        commandLimits,
        sessions: [
          {
            sessionId: "ses_bootstrap",
            title: "Bootstrap session",
            status: "ready",
            createdAtMs: 1,
            updatedAtMs: 2,
            lastEventSequence: 3,
            lastRunState: "completed",
            lastMessagePreview: "done",
            requiresAttention: false,
            pendingApprovalCount: 0,
            pendingInputCount: 0,
          },
        ],
        sessionsTruncated: false,
      }).sessions[0]?.sessionId,
    ).toBe("ses_bootstrap");
  });

  it("rejects storage implementation details", () => {
    const result = BootstrapResponseSchema.safeParse({
      v: 1,
      websocketPath: "/ws",
      websocketProtocol: "wi.v1",
      commandLimits,
      sessions: [
        {
          sessionId: "ses_bootstrap",
          title: "Bootstrap session",
          status: "ready",
          createdAtMs: 1,
          updatedAtMs: 2,
          lastEventSequence: 0,
          lastRunState: null,
          lastMessagePreview: null,
          requiresAttention: false,
          pendingApprovalCount: 0,
          pendingInputCount: 0,
          dbRelativePath: "sessions/private.sqlite3",
        },
      ],
      sessionsTruncated: false,
    });

    expect(result.success).toBe(false);
  });

  it("requires a strict versioned browser command contract", () => {
    const base = {
      v: 1,
      websocketPath: "/ws",
      websocketProtocol: "wi.v1",
      sessions: [],
      sessionsTruncated: false,
    };
    expect(BootstrapResponseSchema.safeParse({ ...base, commandLimits }).success).toBe(true);
    expect(
      BootstrapResponseSchema.safeParse({
        ...base,
        commandLimits: { ...commandLimits, v: 2 },
      }).success,
    ).toBe(false);
    expect(
      BootstrapResponseSchema.safeParse({
        ...base,
        commandLimits: { ...commandLimits, unexpected: true },
      }).success,
    ).toBe(false);
  });
});
