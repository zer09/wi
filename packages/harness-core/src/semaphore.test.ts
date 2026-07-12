import { describe, expect, it } from "vitest";

import { RunScheduler } from "./scheduler.js";
import {
  FifoSemaphore,
  SemaphoreAbortedError,
  SemaphoreClosedError,
} from "./semaphore.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function capacityTest(kind: "provider" | "tool"): Promise<void> {
  const scheduler = new RunScheduler({ providerCapacity: 2, toolCapacity: 3 });
  const limit = kind === "provider" ? 2 : 3;
  const gates = Array.from({ length: 8 }, deferred);
  let active = 0;
  let maximum = 0;
  const run = kind === "provider"
    ? scheduler.withProviderPermit.bind(scheduler)
    : scheduler.withToolPermit.bind(scheduler);
  const tasks = gates.map((gate) =>
    run(undefined, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active -= 1;
    }),
  );
  expect(scheduler.state[kind].active).toBe(limit);
  for (const gate of gates) gate.resolve();
  await Promise.all(tasks);
  expect(maximum).toBe(limit);
  expect(scheduler.state[kind]).toMatchObject({ active: 0, available: limit, queued: 0 });
}

describe("FifoSemaphore and RunScheduler", () => {
  it("bounds global provider capacity", async () => capacityTest("provider"));

  it("bounds global tool capacity", async () => capacityTest("tool"));

  it("queues deterministically in FIFO order", async () => {
    const semaphore = new FifoSemaphore(1);
    const firstRelease = await semaphore.acquire();
    const order: number[] = [];
    const second = semaphore.acquire().then((release) => {
      order.push(2);
      release();
    });
    const third = semaphore.acquire().then((release) => {
      order.push(3);
      release();
    });
    firstRelease();
    await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
  });

  it.each(["head", "middle"] as const)(
    "removes a cancelled waiter at the queue %s without consuming capacity",
    async (position) => {
      const semaphore = new FifoSemaphore(1);
      const release = await semaphore.acquire();
      const controller = new AbortController();
      const before = position === "middle" ? semaphore.acquire() : null;
      const cancelled = semaphore.acquire(controller.signal);
      const after = semaphore.acquire();
      expect(semaphore.state.queued).toBe(position === "head" ? 2 : 3);
      controller.abort();
      await expect(cancelled).rejects.toBeInstanceOf(SemaphoreAbortedError);
      expect(semaphore.state.queued).toBe(position === "head" ? 1 : 2);
      release();
      if (before !== null) {
        const beforeRelease = await before;
        beforeRelease();
      }
      const afterRelease = await after;
      afterRelease();
      expect(semaphore.state).toMatchObject({ active: 0, available: 1, queued: 0 });
    },
  );

  it("releases exactly once when a task throws", async () => {
    const semaphore = new FifoSemaphore(1);
    await expect(
      semaphore.withPermit(undefined, async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    expect(semaphore.state).toEqual({
      capacity: 1,
      active: 0,
      available: 1,
      queued: 0,
      accepting: true,
    });
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.state.available).toBe(1);
  });

  it("retains an active permit until cancelled work acknowledges cancellation", async () => {
    const semaphore = new FifoSemaphore(1);
    const controller = new AbortController();
    const finish = deferred();
    const taskStarted = deferred();
    const running = semaphore.withPermit(controller.signal, async () => {
      taskStarted.resolve();
      await finish.promise;
    });
    await taskStarted.promise;
    expect(semaphore.state.active).toBe(1);
    controller.abort();
    expect(semaphore.state).toMatchObject({ active: 1, available: 0, queued: 0 });
    finish.resolve();
    await running;
    expect(semaphore.state).toMatchObject({ active: 0, available: 1, queued: 0 });
  });

  it("waits for active scheduler work during shutdown", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const finish = deferred();
    const taskStarted = deferred();
    const running = scheduler.withProviderPermit(undefined, async () => {
      taskStarted.resolve();
      await finish.promise;
    });
    await taskStarted.promise;
    let shutdownFinished = false;
    const shutdown = scheduler.shutdown().then(() => {
      shutdownFinished = true;
    });
    expect(shutdownFinished).toBe(false);
    finish.resolve();
    await Promise.all([running, shutdown]);
    expect(shutdownFinished).toBe(true);
    expect(scheduler.state.provider).toMatchObject({ active: 0, accepting: false });
  });

  it("bounds scheduler shutdown without releasing a still-active permit", async () => {
    const scheduler = new RunScheduler({
      providerCapacity: 1,
      toolCapacity: 1,
      shutdownWait: async () => false,
    });
    const finish = deferred();
    const running = scheduler.withProviderPermit(undefined, async () => finish.promise);
    expect(scheduler.provider.state.active).toBe(1);

    await expect(scheduler.shutdown()).rejects.toMatchObject({ name: "ShutdownTimeoutError" });
    expect(scheduler.state.provider).toMatchObject({ active: 1, accepting: false });
    finish.resolve();
    await running;
    expect(scheduler.state.provider.active).toBe(0);
  });

  it("rejects queued and future acquisition during shutdown without stealing active permits", async () => {
    const semaphore = new FifoSemaphore(1);
    const release = await semaphore.acquire();
    const queued = semaphore.acquire();
    semaphore.shutdown();
    const drained = semaphore.drain();
    await expect(queued).rejects.toBeInstanceOf(SemaphoreClosedError);
    await expect(semaphore.acquire()).rejects.toBeInstanceOf(SemaphoreClosedError);
    expect(semaphore.state).toMatchObject({ active: 1, queued: 0, accepting: false });
    release();
    await drained;
    expect(semaphore.state).toMatchObject({ active: 0, available: 1 });
  });
});
