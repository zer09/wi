import { describe, expect, it } from "vitest";

import type { ProviderEvent, ProviderRequest } from "@wi/provider-contract";

import {
  FakeProviderAdapter,
  parseFakeProviderConfiguration,
} from "./adapter.js";
import { fakeProviderGateLabel } from "./script.js";

const request: ProviderRequest = {
  runId: "run_fakeContract",
  stepId: "step_fakeContract",
  stepIndex: 0,
  providerConfig: { scenario: "plain-text" },
  input: [],
};

async function collect(adapter: FakeProviderAdapter, value: ProviderRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.stream(
    value,
    { sessionId: "ses_fakeContract", attempt: 0, now: () => 1 },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe("FakeProviderAdapter", () => {
  it("requires explicit server-owned scenario configuration", () => {
    expect(() => parseFakeProviderConfiguration({})).toThrow("selected explicitly");
    expect(() => parseFakeProviderConfiguration({ scenario: "plain-text", extra: true })).toThrow(
      "unknown field",
    );
  });

  it("emits normalized events carrying immutable request identity", async () => {
    const events = await collect(new FakeProviderAdapter(), request);
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "text.delta",
      "response.completed",
    ]);
    expect(
      events.every(
        (event) =>
          event.runId === request.runId &&
          event.stepId === request.stepId &&
          event.stepIndex === request.stepIndex,
      ),
    ).toBe(true);
  });

  it("observes AbortSignal while blocked without a real sleep", async () => {
    const adapter = new FakeProviderAdapter();
    const controller = new AbortController();
    const label = fakeProviderGateLabel(request.runId, "never");
    const consuming = (async () => {
      for await (const event of adapter.stream(
        {
          ...request,
          providerConfig: { scenario: "provider-never-completes-until-aborted" },
        },
        { sessionId: "ses_fakeContract", attempt: 0, now: () => 1 },
        controller.signal,
      )) {
        expect(event.type).toBe("response.started");
      }
    })();
    await adapter.controller.waitUntilBlocked(label);
    controller.abort(new Error("test cancellation"));

    await expect(consuming).rejects.toThrow("test cancellation");
    expect(adapter.controller.abortedLabels.has(label)).toBe(true);
  });
});
