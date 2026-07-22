import { describe, expect, it, vi } from "vitest";

import { SessionStatusCoordinator } from "./session-status-coordinator.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("SessionStatusCoordinator", () => {
  it("serializes one session without blocking another session", async () => {
    const coordinator = new SessionStatusCoordinator();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const sameSessionStarted = vi.fn();
    const first = coordinator.run(["ses_A"], async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstStarted.promise;

    const sameSession = coordinator.run(["ses_A"], async () => {
      sameSessionStarted();
      return "same";
    });
    const otherSession = coordinator.run(["ses_B"], async () => "other");

    await expect(otherSession).resolves.toBe("other");
    expect(sameSessionStarted).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(sameSession).resolves.toBe("same");
  });

  it("allows a nested operation only for the session already held", async () => {
    const coordinator = new SessionStatusCoordinator();

    await expect(
      coordinator.run(["ses_A"], () => coordinator.run(["ses_A"], async () => "nested")),
    ).resolves.toBe("nested");
    await expect(
      coordinator.run(["ses_A"], () => coordinator.run(["ses_B"], async () => "invalid")),
    ).rejects.toThrow("cannot acquire another session");
  });
});
