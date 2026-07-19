import { describe, expect, it } from "vitest";

import { BootstrapResponseSchema } from "./bootstrap.js";

describe("browser bootstrap schema", () => {
  it("accepts browser-safe session summaries", () => {
    expect(
      BootstrapResponseSchema.parse({
        v: 1,
        websocketPath: "/ws",
        websocketProtocol: "wi.v1",
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
});
