import { describe, expect, it } from "vitest";

import {
  ActorMailbox,
  MailboxClosedError,
  MailboxReentryError,
} from "./actor-mailbox.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("ActorMailbox", () => {
  it("preserves accepted order and executes no handlers concurrently", async () => {
    const mailbox = new ActorMailbox();
    const order: number[] = [];
    let active = 0;
    let maximum = 0;
    const entries = [1, 2, 3].map((value) =>
      mailbox.enqueue(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        order.push(value);
        active -= 1;
      }),
    );
    await Promise.all(entries);
    expect(order).toEqual([1, 2, 3]);
    expect(maximum).toBe(1);
    expect(mailbox.state).toMatchObject({ idle: true, queued: 0, running: false });
  });

  it("rejects awaited handler reentry without deadlocking later work or shutdown", async () => {
    const mailbox = new ActorMailbox();
    const observed: string[] = [];
    const outer = mailbox.enqueue(async () => {
      observed.push("outer");
      await expect(mailbox.enqueue(() => observed.push("nested"))).rejects.toBeInstanceOf(
        MailboxReentryError,
      );
    });
    const later = mailbox.enqueue(() => observed.push("later"));

    await expect(outer).resolves.toBeUndefined();
    await expect(later).resolves.toBe(2);
    await expect(mailbox.shutdown()).resolves.toBeUndefined();
    expect(observed).toEqual(["outer", "later"]);
  });

  it("rejects shutdown awaited by its active handler without closing the mailbox", async () => {
    const mailbox = new ActorMailbox();
    const reentrant = mailbox.enqueue(async () => {
      await mailbox.shutdown();
    });

    await expect(reentrant).rejects.toBeInstanceOf(MailboxReentryError);
    expect(mailbox.state.accepting).toBe(true);
    await expect(mailbox.enqueue(() => "continued")).resolves.toBe("continued");
    await expect(mailbox.shutdown()).resolves.toBeUndefined();
  });

  it("allows a non-awaitable deferred post from an active handler", async () => {
    const mailbox = new ActorMailbox();
    const observed: string[] = [];
    const posted = deferred<void>();
    await mailbox.enqueue(() => {
      observed.push("outer");
      mailbox.post(
        () => {
          observed.push("posted");
          posted.resolve();
        },
        (error) => {
          throw error;
        },
      );
    });
    await posted.promise;
    expect(observed).toEqual(["outer", "posted"]);
  });

  it("continues after a posted handler and its error reporter both throw", async () => {
    const mailbox = new ActorMailbox();
    const reported = deferred<void>();
    mailbox.post(
      async () => {
        throw new Error("posted handler failed");
      },
      () => {
        reported.resolve();
        throw new Error("posted error reporter failed");
      },
    );
    const later = mailbox.enqueue(() => 42);

    await reported.promise;
    await expect(later).resolves.toBe(42);
    expect(mailbox.state.idle).toBe(true);
    await expect(mailbox.shutdown()).resolves.toBeUndefined();
  });

  it("contains asynchronously rejected error reporters before and after shutdown", async () => {
    const mailbox = new ActorMailbox();
    const reported = deferred<void>();
    let handlerError: unknown;
    mailbox.post(
      async () => {
        throw new Error("posted handler failed asynchronously");
      },
      async (error) => {
        handlerError = error;
        reported.resolve();
        throw new Error("posted async error reporter failed");
      },
    );

    await reported.promise;
    await expect(mailbox.enqueue(() => 42)).resolves.toBe(42);
    await expect(mailbox.shutdown()).resolves.toBeUndefined();

    const closedReported = deferred<void>();
    let closedError: unknown;
    mailbox.post(
      () => undefined,
      async (error) => {
        closedError = error;
        closedReported.resolve();
        throw new Error("closed async error reporter failed");
      },
    );
    await closedReported.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(handlerError).toEqual(new Error("posted handler failed asynchronously"));
    expect(closedError).toBeInstanceOf(MailboxClosedError);
    expect(mailbox.state.idle).toBe(true);
  });

  it("continues after a failed command without an unhandled tail rejection", async () => {
    const mailbox = new ActorMailbox();
    const failed = mailbox.enqueue(() => {
      throw new Error("handled failure");
    });
    const next = mailbox.enqueue(() => "continued");
    await expect(failed).rejects.toThrow("handled failure");
    await expect(next).resolves.toBe("continued");
  });

  it("reports deterministic queue state and rejects new work after draining shutdown", async () => {
    const mailbox = new ActorMailbox();
    const gate = deferred<void>();
    const first = mailbox.enqueue(async () => gate.promise);
    const second = mailbox.enqueue(() => 2);
    expect(mailbox.state).toMatchObject({ running: true, queued: 1, idle: false });
    const shutdown = mailbox.shutdown();
    await expect(mailbox.enqueue(() => 3)).rejects.toBeInstanceOf(MailboxClosedError);
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe(2);
    await expect(shutdown).resolves.toBeUndefined();
  });
});
