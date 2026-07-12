import { describe, expect, it } from "vitest";

import type { RunState } from "@wi/protocol";
import { assertAllowedRunTransition, isAllowedRunTransition } from "./run-transitions.js";

const allowed = [
  ["created", "queued"],
  ["created", "running"],
  ["queued", "running"],
  ["running", "waiting_for_user"],
  ["running", "cancelling"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "interrupted"],
  ["waiting_for_user", "running"],
  ["waiting_for_user", "cancelling"],
  ["waiting_for_user", "failed"],
  ["waiting_for_user", "interrupted"],
  ["cancelling", "cancelled"],
  ["cancelling", "interrupted"],
] as const satisfies readonly (readonly [RunState, RunState])[];

const terminalStates = ["completed", "failed", "cancelled", "interrupted"] as const;

describe("run transition model", () => {
  it.each(allowed)("allows %s -> %s", (expectedState, nextState) => {
    expect(isAllowedRunTransition(expectedState, nextState)).toBe(true);
    expect(() => assertAllowedRunTransition(expectedState, nextState)).not.toThrow();
  });

  it.each(terminalStates)("does not let terminal state %s transition", (terminal) => {
    for (const nextState of [
      "created",
      "queued",
      "running",
      "waiting_for_user",
      "cancelling",
      ...terminalStates,
    ] as const) {
      expect(isAllowedRunTransition(terminal, nextState)).toBe(false);
    }
  });

  it("rejects stale and unsupported transitions with a typed error", () => {
    expect(() => assertAllowedRunTransition("created", "completed")).toThrow(
      expect.objectContaining({ code: "session.invalid_transition" }),
    );
    expect(() => assertAllowedRunTransition("running", "created")).toThrow(
      expect.objectContaining({ code: "session.invalid_transition" }),
    );
  });
});
