import { describe, expect, it } from "vitest";

import { TextDeltaCoalescer, type CoalescerClock } from "./text-delta-coalescer.js";

class ManualClock implements CoalescerClock {
  current = 0;
  callback: (() => void) | null = null;

  readonly now = (): number => this.current;

  readonly schedule = (_delayMs: number, callback: () => void): (() => void) => {
    this.callback = callback;
    return () => {
      if (this.callback === callback) this.callback = null;
    };
  };

  advance(milliseconds: number): void {
    this.current += milliseconds;
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

describe("TextDeltaCoalescer", () => {
  it("flushes at the size threshold and on a semantic boundary", async () => {
    const flushed: string[] = [];
    const coalescer = new TextDeltaCoalescer({
      maxChars: 4,
      maxDelayMs: 100,
      onFlush: async (text) => {
        flushed.push(text);
      },
    });

    await coalescer.push("ab");
    expect(flushed).toEqual([]);
    await coalescer.push("cd");
    expect(flushed).toEqual(["abcd"]);
    await coalescer.push("tail");
    await coalescer.flush();
    expect(flushed).toEqual(["abcd", "tail"]);
    await coalescer.close();
  });

  it("uses an injected clock rather than sleeping", async () => {
    const clock = new ManualClock();
    const flushed: string[] = [];
    const coalescer = new TextDeltaCoalescer({
      maxChars: 100,
      maxDelayMs: 10,
      clock,
      onFlush: async (text) => {
        flushed.push(text);
      },
    });

    await coalescer.push("timed");
    clock.advance(10);
    await coalescer.flush();
    expect(flushed).toEqual(["timed"]);
    await coalescer.close();
  });
});
