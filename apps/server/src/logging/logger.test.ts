import { once } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { JsonLogger, nonThrowingLogger, type Logger } from "./logger.js";

class BackpressuredStream extends Writable {
  readonly chunks: string[] = [];
  private callbacks: Array<() => void> = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    this.callbacks.push(callback);
  }

  release(): void {
    this.callbacks.shift()?.();
  }
}

describe("nonThrowingLogger", () => {
  it("isolates every logger method and does not wrap an adapter twice", () => {
    const attempted: string[] = [];
    const failure = (event: string): never => {
      attempted.push(event);
      throw new Error(`injected ${event} logging failure`);
    };
    const logger: Logger = {
      debug: (event) => failure(event),
      info: (event) => failure(event),
      warn: (event) => failure(event),
      error: (event) => failure(event),
    };
    const safe = nonThrowingLogger(logger);

    expect(() => safe.debug("debug_event", { value: 1 })).not.toThrow();
    expect(() => safe.info("info_event", { value: 2 })).not.toThrow();
    expect(() => safe.warn("warn_event", { value: 3 })).not.toThrow();
    expect(() => safe.error("error_event", new Error("detail"), { value: 4 })).not.toThrow();
    expect(attempted).toEqual(["debug_event", "info_event", "warn_event", "error_event"]);
    expect(nonThrowingLogger(safe)).toBe(safe);
  });
});

describe("JsonLogger production sink", () => {
  it("drops while backpressured, resumes on drain, and disables itself after EPIPE", async () => {
    const stream = new BackpressuredStream();
    const logger = new JsonLogger({ now: () => 1_000, stream });

    logger.info("first");
    logger.info("dropped_while_blocked");
    expect(stream.chunks).toHaveLength(1);
    expect(stream.chunks[0]).toContain('"event":"first"');

    const drained = once(stream, "drain");
    stream.release();
    await drained;
    logger.info("after_drain");
    expect(stream.chunks).toHaveLength(2);
    expect(stream.chunks[1]).toContain('"event":"after_drain"');

    expect(() =>
      stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    logger.info("dropped_after_failure");
    expect(stream.chunks).toHaveLength(2);
    stream.release();
    stream.destroy();
  });

  it("rejects ambiguous custom sink configuration", () => {
    const stream = new BackpressuredStream();
    expect(
      () => new JsonLogger({ stream, write: () => undefined }),
    ).toThrow(/either write or stream/u);
    stream.destroy();
  });
});
