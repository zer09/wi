import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wi/protocol";

import { projectTimeline } from "./timeline.js";

function event(value: SessionEvent): SessionEvent {
  return value;
}

describe("timeline projection", () => {
  it("groups assistant deltas and marks retained partial output interrupted", () => {
    const events = [
      event({
        v: 1,
        kind: "event",
        sessionId: "ses_timeline",
        sequence: 1,
        eventId: "evt_deltaOne",
        eventType: "provider.text.delta",
        createdAtMs: 1,
        data: {
          eventVersion: 1,
          runId: "run_timeline",
          stepId: "step_timeline",
          messageId: "msg_timeline",
          partId: "part_timeline",
          text: "<img src=x onerror=alert(1)>",
        },
      }),
      event({
        v: 1,
        kind: "event",
        sessionId: "ses_timeline",
        sequence: 2,
        eventId: "evt_deltaTwo",
        eventType: "provider.text.delta",
        createdAtMs: 2,
        data: {
          eventVersion: 1,
          runId: "run_timeline",
          stepId: "step_timeline",
          messageId: "msg_timeline",
          partId: "part_timeline",
          text: " partial",
        },
      }),
      event({
        v: 1,
        kind: "event",
        sessionId: "ses_timeline",
        sequence: 3,
        eventId: "evt_interrupted",
        eventType: "provider.step.interrupted",
        createdAtMs: 3,
        data: {
          eventVersion: 2,
          runId: "run_timeline",
          stepId: "step_timeline",
          code: "provider.incomplete",
          message: "The provider response was interrupted.",
          diagnosticId: "err_timeline",
        },
      }),
    ];

    expect(projectTimeline(events)).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "<img src=x onerror=alert(1)> partial",
        state: "interrupted",
        sequence: 2,
      }),
    ]);
  });
});
