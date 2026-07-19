import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  type BrowserCommandLimits,
  type CommandMessage,
} from "@wi/protocol";

import {
  assertBrowserCommandSize,
  assertRawInputSize,
  BrowserCommandLimitError,
  parseCanonicalJsonInput,
  serializedCommandBytes,
} from "./command-size.js";

const LIMITS: BrowserCommandLimits = {
  v: 1,
  maximumFrameBytes: 512,
  maximumDurablePayloadBytes: 256,
  maximumRawInputCodeUnits: 100,
  maximumRawInputUtf8Bytes: 100,
  maximumJsonDepth: 2,
  maximumJsonNodes: 8,
};

describe("browser command preflight", () => {
  it("rejects raw code-unit and UTF-8 excess before retaining input", () => {
    expect(() => assertRawInputSize("x".repeat(101), LIMITS, "Message")).toThrow(
      BrowserCommandLimitError,
    );
    expect(() => assertRawInputSize("🔥".repeat(26), LIMITS, "Message")).toThrow(
      /UTF-8 bytes/u,
    );
    expect(() => assertRawInputSize("🔥".repeat(25), LIMITS, "Message")).not.toThrow();
  });

  it("rejects raw, depth, and node excess before JSON.parse", () => {
    const parse = vi.fn<(value: string) => unknown>();
    expect(() => parseCanonicalJsonInput(JSON.stringify("x".repeat(100)), LIMITS, parse)).toThrow(
      BrowserCommandLimitError,
    );
    expect(() => parseCanonicalJsonInput("[[[0]]]", LIMITS, parse)).toThrow(/nesting/u);
    expect(() => parseCanonicalJsonInput("[0,0,0,0,0,0,0,0]", LIMITS, parse)).toThrow(/nodes/u);
    expect(parse).not.toHaveBeenCalled();
  });

  it("accepts exact depth and node limits before canonical validation", () => {
    const limits = { ...LIMITS, maximumJsonNodes: 4 };
    expect(parseCanonicalJsonInput('{"a":[0]}', limits)).toEqual({ a: [0] });
  });

  it("measures escaping and Unicode using complete UTF-8 JSON", () => {
    const command: CommandMessage = {
      v: 1,
      kind: "command",
      commandId: "cmd_unicodePreflight",
      sessionId: "ses_unicodePreflight",
      method: "message.submit",
      params: { text: 'line\n"🔥' },
    };
    expect(serializedCommandBytes(command)).toBe(
      new TextEncoder().encode(JSON.stringify(command)).byteLength,
    );

    const exactPayloadBytes = canonicalJsonBytes(command.params.text).byteLength;
    const exactLimits = {
      ...LIMITS,
      maximumFrameBytes: 1_000,
      maximumDurablePayloadBytes: exactPayloadBytes,
    };
    expect(() => assertBrowserCommandSize(command, exactLimits)).not.toThrow();
    expect(() =>
      assertBrowserCommandSize(
        { ...command, params: { text: `${command.params.text}x` } },
        exactLimits,
      ),
    ).toThrow(/durable command payload/u);
  });

  it("preflights direct socket values before recursive protocol validation", () => {
    const command = {
      v: 1,
      kind: "command",
      commandId: "cmd_deepDirect",
      sessionId: "ses_deepDirect",
      method: "input.respond",
      params: { inputId: "input_deepDirect", value: [[[0]]] },
    } as const;
    expect(() => assertBrowserCommandSize(command, LIMITS)).toThrow(/nesting/u);
  });
});
