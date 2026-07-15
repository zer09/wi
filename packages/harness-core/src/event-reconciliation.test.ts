import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@wi/protocol";
import type { AppendTransactionInput } from "@wi/storage";

import {
  EventReconciliationIntegrityError,
  reconcileCommittedEventBatch,
} from "./event-reconciliation.js";

const attempted = [
  {
    eventId: "evt_reconcileA",
    eventType: "provider.step.started",
    createdAtMs: 1_000,
    data: {
      eventVersion: 1,
      runId: "run_reconcile",
      stepId: "step_reconcile",
      stepIndex: 0,
    },
  },
  {
    eventId: "evt_reconcileB",
    eventType: "provider.step.completed",
    createdAtMs: 1_001,
    data: { eventVersion: 1, runId: "run_reconcile", stepId: "step_reconcile" },
  },
] satisfies AppendTransactionInput["events"];

function storedEvents(): SessionEvent[] {
  return attempted.map(
    (event, index) =>
      ({
        v: 1,
        kind: "event",
        sessionId: "ses_reconcile",
        sequence: 20 + index,
        ...event,
      }) as SessionEvent,
  );
}

describe("ambiguous event reconciliation", () => {
  it("adopts only an exact contiguous batch in attempted order", () => {
    expect(
      reconcileCommittedEventBatch("ses_reconcile", attempted, storedEvents()),
    ).toEqual({ events: storedEvents(), headSequence: 21 });
    expect(reconcileCommittedEventBatch("ses_reconcile", attempted, [null, null])).toBeNull();
  });

  it.each([
    ["session identity", (events: SessionEvent[]) => ({ ...events[0], sessionId: "ses_other" })],
    ["event type", (events: SessionEvent[]) => ({ ...events[0], eventType: "run.started" })],
    ["creation time", (events: SessionEvent[]) => ({ ...events[0], createdAtMs: 999 })],
    [
      "canonical payload",
      (events: SessionEvent[]) => ({
        ...events[0],
        data: { ...events[0]?.data, stepIndex: 1 },
      }),
    ],
    ["sequence ordering", (events: SessionEvent[]) => ({ ...events[0], sequence: 21 })],
  ] as const)("rejects a same-ID conflict in %s", (_name, conflict) => {
    const events = storedEvents();
    events[0] = conflict(events) as SessionEvent;
    expect(() => reconcileCommittedEventBatch("ses_reconcile", attempted, events)).toThrow(
      EventReconciliationIntegrityError,
    );
  });

  it("rejects a partial batch as an integrity fault", () => {
    const events = storedEvents();
    expect(() =>
      reconcileCommittedEventBatch("ses_reconcile", attempted, [events[0] ?? null, null]),
    ).toThrow(EventReconciliationIntegrityError);
  });
});
