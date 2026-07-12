import { describe, expect, it, vi } from "vitest";

import type { SessionActor } from "./session-actor.js";
import { SessionActorRegistry, type SessionActorLease } from "./session-registry.js";

class FakeRegistryActor {
  idle = true;
  shutdownCalls = 0;
  shutdownError: Error | undefined;

  isIdle(): boolean {
    return this.idle;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.shutdownError !== undefined) throw this.shutdownError;
  }
}

function asActor(actor: FakeRegistryActor): SessionActor {
  return actor as unknown as SessionActor;
}

describe("SessionActorRegistry", () => {
  it("constructs exactly one actor for concurrent same-session acquire", async () => {
    let resolveActor!: (actor: SessionActor) => void;
    const gate = new Promise<SessionActor>((resolve) => {
      resolveActor = resolve;
    });
    const createActor = vi.fn(() => gate);
    const registry = new SessionActorRegistry({ createActor, now: () => 0, idleTimeoutMs: 10 });
    const first = registry.acquire("ses_registry");
    const second = registry.acquire("ses_registry");
    const actor = new FakeRegistryActor();
    resolveActor(asActor(actor));
    const [left, right] = await Promise.all([first, second]);
    expect(createActor).toHaveBeenCalledTimes(1);
    expect(left.actor).toBe(right.actor);
    expect(registry.states()[0]?.references).toBe(2);
    left.release();
    left.release();
    right.release();
    await registry.close();
  });

  it("allows different sessions to construct concurrently", async () => {
    const constructing: string[] = [];
    const registry = new SessionActorRegistry({
      createActor: async (sessionId) => {
        constructing.push(sessionId);
        return asActor(new FakeRegistryActor());
      },
      now: () => 0,
      idleTimeoutMs: 10,
    });
    const leases = await Promise.all([registry.acquire("ses_left"), registry.acquire("ses_right")]);
    expect(constructing.sort()).toEqual(["ses_left", "ses_right"]);
    for (const lease of leases) lease.release();
    await registry.close();
  });

  it("evicts only after every actor blocker and retained reference is absent", async () => {
    let now = 0;
    const actor = new FakeRegistryActor();
    const registry = new SessionActorRegistry({
      createActor: async () => asActor(actor),
      now: () => now,
      idleTimeoutMs: 10,
    });
    const lease = await registry.acquire("ses_registry");
    now = 20;
    await expect(registry.evictIdle()).resolves.toEqual([]);
    lease.release();
    actor.idle = false;
    now = 40;
    await expect(registry.evictIdle()).resolves.toEqual([]);
    actor.idle = true;
    now = 60;
    await expect(registry.evictIdle()).resolves.toEqual(["ses_registry"]);
    expect(actor.shutdownCalls).toBe(1);
  });

  it("abandons eviction when activity acquires a reference during the race", async () => {
    let now = 0;
    const actor = new FakeRegistryActor();
    let racedLease: SessionActorLease | undefined;
    const registry = new SessionActorRegistry({
      createActor: async () => asActor(actor),
      now: () => now,
      idleTimeoutMs: 10,
      beforeEvict: async () => {
        racedLease = await registry.acquire("ses_registry");
      },
    });
    const initial = await registry.acquire("ses_registry");
    initial.release();
    now = 20;
    await expect(registry.evictIdle()).resolves.toEqual([]);
    expect(actor.shutdownCalls).toBe(0);
    racedLease?.release();
    await registry.close();
  });

  it("abandons eviction when actor activity begins during the decision", async () => {
    let now = 0;
    const actor = new FakeRegistryActor();
    let activity = (): void => {};
    const registry = new SessionActorRegistry({
      createActor: async (_sessionId, onActivity) => {
        activity = onActivity;
        return asActor(actor);
      },
      now: () => now,
      idleTimeoutMs: 10,
      beforeEvict: () => {
        actor.idle = false;
        activity();
      },
    });
    const lease = await registry.acquire("ses_registry");
    lease.release();
    now = 20;
    await expect(registry.evictIdle()).resolves.toEqual([]);
    expect(actor.shutdownCalls).toBe(0);
    await registry.close();
  });

  it("rejects an acquire whose construction loses the registry-close race", async () => {
    let resolveActor!: (actor: SessionActor) => void;
    const gate = new Promise<SessionActor>((resolve) => {
      resolveActor = resolve;
    });
    const actor = new FakeRegistryActor();
    const registry = new SessionActorRegistry({
      createActor: () => gate,
      now: () => 0,
      idleTimeoutMs: 10,
    });
    const acquiring = registry.acquire("ses_registry");
    const closing = registry.close();
    resolveActor(asActor(actor));
    await expect(acquiring).rejects.toThrow("closed during acquire");
    await closing;
    expect(actor.shutdownCalls).toBe(1);
  });

  it("bounds close while actor construction is blocked", async () => {
    let resolveActor!: (actor: SessionActor) => void;
    const gate = new Promise<SessionActor>((resolve) => {
      resolveActor = resolve;
    });
    const actor = new FakeRegistryActor();
    const registry = new SessionActorRegistry({
      createActor: () => gate,
      now: () => 0,
      idleTimeoutMs: 10,
      shutdownWait: async () => false,
    });
    const acquiring = registry.acquire("ses_registry");

    await expect(registry.close()).rejects.toMatchObject({ name: "ShutdownTimeoutError" });
    resolveActor(asActor(actor));
    await expect(acquiring).rejects.toThrow("closed during acquire");
  });

  it("quarantines a poisoned entry when eviction shutdown fails", async () => {
    let now = 0;
    const failed = new FakeRegistryActor();
    failed.shutdownError = new Error("close failed");
    const createActor = vi.fn(async () => asActor(failed));
    const registry = new SessionActorRegistry({
      createActor,
      now: () => now,
      idleTimeoutMs: 5,
    });
    const first = await registry.acquire("ses_registry");
    first.release();
    now = 10;
    await expect(registry.evictIdle()).rejects.toThrow("close failed");
    await expect(registry.acquire("ses_registry")).rejects.toThrow(
      "eviction failed during acquire",
    );
    expect(createActor).toHaveBeenCalledTimes(1);
    expect(registry.states()[0]).toMatchObject({ evicting: true });
    await expect(registry.close()).rejects.toThrow("failed to shut down");
    await expect(registry.close()).rejects.toThrow("failed to shut down");
  });

  it("reconstructs from the factory after eviction and reacquire", async () => {
    let now = 0;
    const actors: FakeRegistryActor[] = [];
    const registry = new SessionActorRegistry({
      createActor: async () => {
        const actor = new FakeRegistryActor();
        actors.push(actor);
        return asActor(actor);
      },
      now: () => now,
      idleTimeoutMs: 5,
    });
    const first = await registry.acquire("ses_registry");
    first.release();
    now = 10;
    await registry.evictIdle();
    const second = await registry.acquire("ses_registry");
    expect(actors).toHaveLength(2);
    expect(second.actor).not.toBe(first.actor);
    second.release();
    await registry.close();
  });
});
