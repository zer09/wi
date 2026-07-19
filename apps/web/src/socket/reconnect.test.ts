import { describe, expect, it } from "vitest";

import { ReconnectPolicy } from "./reconnect.js";

describe("ReconnectPolicy", () => {
  it("applies bounded exponential backoff with deterministic jitter", () => {
    const samples = [0, 0.5, 0.999];
    const policy = new ReconnectPolicy({
      baseDelayMs: 100,
      maximumDelayMs: 250,
      jitterRatio: 0.2,
      random: () => samples.shift() ?? 0.5,
    });

    expect(policy.nextDelayMs()).toBe(80);
    expect(policy.nextDelayMs()).toBe(200);
    expect(policy.nextDelayMs()).toBe(250);
    expect(policy.nextDelayMs()).toBe(250);
  });

  it("resets the attempt after a successful connection", () => {
    const policy = new ReconnectPolicy({
      baseDelayMs: 100,
      maximumDelayMs: 1_000,
      jitterRatio: 0,
      random: () => 0.5,
    });
    expect(policy.nextDelayMs()).toBe(100);
    expect(policy.nextDelayMs()).toBe(200);
    policy.reset();
    expect(policy.nextDelayMs()).toBe(100);
  });
});
