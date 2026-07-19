import { describe, expect, it } from "vitest";
import { createBrowserSessionState } from "@wi/client-state";
import {
  MAXIMUM_BOOTSTRAP_SESSIONS,
  type BrowserSessionSummary,
} from "@wi/protocol";

import {
  createBrowserSessionIndex,
  initialSessionIdFromLocation,
  projectSessionSummary,
  upsertSessionSummary,
} from "./session-index.js";

function summary(
  sessionId: string,
  updatedAtMs: number,
  status: BrowserSessionSummary["status"] = "ready",
): BrowserSessionSummary {
  return {
    sessionId,
    title: sessionId,
    status,
    createdAtMs: 1,
    updatedAtMs,
    lastEventSequence: 1,
    lastRunState: null,
    lastMessagePreview: null,
    requiresAttention: false,
    pendingApprovalCount: 0,
    pendingInputCount: 0,
  };
}

describe("browser session index", () => {
  it("preserves valid omitted, unknown, and unavailable URL targets", () => {
    const sessions = [
      summary("ses_readyTarget", 3),
      summary("ses_unavailableTarget", 2, "unavailable"),
    ];

    expect(
      initialSessionIdFromLocation("http://localhost/?session=ses_omittedTarget", sessions),
    ).toBe("ses_omittedTarget");
    expect(
      initialSessionIdFromLocation("http://localhost/?session=ses_unknownTarget", sessions),
    ).toBe("ses_unknownTarget");
    expect(
      initialSessionIdFromLocation("http://localhost/?session=ses_unavailableTarget", sessions),
    ).toBe("ses_unavailableTarget");
  });

  it("falls back only for an invalid target and handles an empty catalog", () => {
    const sessions = [summary("ses_readyFallback", 2)];
    expect(initialSessionIdFromLocation("http://localhost/?session=invalid", sessions)).toBe(
      "ses_readyFallback",
    );
    expect(initialSessionIdFromLocation("http://localhost/", [])).toBeNull();
  });

  it("keeps replay-only projection updates in bootstrap order", () => {
    const first = summary("ses_newer", 300);
    const second = summary("ses_older", 200);
    const index = createBrowserSessionIndex([first, second], false);
    const state = {
      ...createBrowserSessionState(second.sessionId),
      title: second.title,
      lastAppliedSequence: 1,
    };
    const replayOnly = projectSessionSummary(second, state);
    expect(replayOnly).not.toBeNull();
    const replayed = upsertSessionSummary(index, replayOnly as BrowserSessionSummary, second.sessionId);
    expect(replayed.summaries.map((candidate) => candidate.sessionId)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
    expect(replayed.summaries[1]?.updatedAtMs).toBe(200);
  });

  it("reorders only from the maximum newly applied durable event timestamp", () => {
    const first = summary("ses_newer", 300);
    const second = summary("ses_older", 200);
    const index = createBrowserSessionIndex([first, second], false);
    const state = {
      ...createBrowserSessionState(second.sessionId),
      title: second.title,
      lastAppliedSequence: 2,
    };
    const projected = projectSessionSummary(second, state, 400);
    expect(projected).not.toBeNull();
    const updated = upsertSessionSummary(
      index,
      projected as BrowserSessionSummary,
      second.sessionId,
    );
    expect(updated.summaries.map((candidate) => candidate.sessionId)).toEqual([
      second.sessionId,
      first.sessionId,
    ]);
    expect(updated.summaries[0]?.updatedAtMs).toBe(400);

    const olderEvent = projectSessionSummary(projected as BrowserSessionSummary, state, 250);
    expect(olderEvent?.updatedAtMs).toBe(400);
  });

  it("does not invent a summary for an omitted target before a durable event", () => {
    expect(projectSessionSummary(undefined, createBrowserSessionState("ses_omitted"))).toBeNull();
  });

  it("keeps local creation bounded, marks the index partial, and preserves the selection", () => {
    const sessions = Array.from({ length: MAXIMUM_BOOTSTRAP_SESSIONS }, (_, index) =>
      summary(`ses_bounded${String(index).padStart(4, "0")}`, MAXIMUM_BOOTSTRAP_SESSIONS - index),
    );
    const index = createBrowserSessionIndex(sessions, false);
    const selected = summary("ses_newlyAccepted", 0);
    const updated = upsertSessionSummary(index, selected, selected.sessionId, true);

    expect(updated.summaries).toHaveLength(MAXIMUM_BOOTSTRAP_SESSIONS);
    expect(updated.truncated).toBe(true);
    expect(updated.summaries.some((candidate) => candidate.sessionId === selected.sessionId)).toBe(
      true,
    );
    expect(updated.summaries.some((candidate) => candidate.sessionId === "ses_bounded0999")).toBe(
      false,
    );
  });

  it("retains a selected deep-linked summary when a newer bounded upsert arrives", () => {
    const sessions = Array.from({ length: MAXIMUM_BOOTSTRAP_SESSIONS }, (_, index) =>
      summary(`ses_retained${String(index).padStart(4, "0")}`, MAXIMUM_BOOTSTRAP_SESSIONS - index),
    );
    const selectedSessionId = "ses_deepLinkedOldest";
    const withSelected = upsertSessionSummary(
      createBrowserSessionIndex(sessions, true),
      summary(selectedSessionId, 0),
      selectedSessionId,
    );
    const updated = upsertSessionSummary(
      withSelected,
      summary("ses_newerArrival", MAXIMUM_BOOTSTRAP_SESSIONS + 1),
      selectedSessionId,
    );

    expect(updated.summaries).toHaveLength(MAXIMUM_BOOTSTRAP_SESSIONS);
    expect(updated.truncated).toBe(true);
    expect(updated.summaries.some((candidate) => candidate.sessionId === selectedSessionId)).toBe(
      true,
    );
  });
});
