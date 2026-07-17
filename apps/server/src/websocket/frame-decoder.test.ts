import { describe, expect, it } from "vitest";
import { decodeClientFrame, FrameDecodeError } from "./frame-decoder.js";

const limits = { maximumBytes: 1_024, maximumDepth: 8 };

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("decodeClientFrame", () => {
  it("decodes a strict valid client message", () => {
    expect(
      decodeClientFrame(
        bytes('{"v":1,"kind":"hello","clientId":"client_decoder","resume":[]}'),
        false,
        limits,
      ),
    ).toEqual({ v: 1, kind: "hello", clientId: "client_decoder", resume: [] });
  });

  it.each([
    ["invalid JSON", "{", "protocol.invalid_json"],
    [
      "unsupported version",
      '{"v":2,"kind":"hello","clientId":"client_decoder","resume":[]}',
      "protocol.unsupported_version",
    ],
    ["unknown kind", '{"v":1,"kind":"unknown"}', "protocol.invalid_message"],
    [
      "unknown command method",
      '{"v":1,"kind":"command","commandId":"cmd_decoder","method":"unknown","params":{}}',
      "protocol.invalid_message",
    ],
  ])("rejects %s", (_label, input, code) => {
    expect(() => decodeClientFrame(bytes(input), false, limits)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects bytes before parsing when the frame is oversized", () => {
    expect(() =>
      decodeClientFrame(bytes("x".repeat(1_025)), false, limits),
    ).toThrowError(
      expect.objectContaining({ code: "protocol.message_too_large", fatal: true }),
    );
  });

  it("rejects invalid UTF-8 and binary frames", () => {
    expect(() => decodeClientFrame(Uint8Array.of(0xc3, 0x28), false, limits)).toThrowError(
      expect.objectContaining({ code: "protocol.invalid_message", fatal: true }),
    );
    expect(() => decodeClientFrame(bytes("{}"), true, limits)).toThrowError(
      expect.objectContaining({ code: "protocol.invalid_message", fatal: true }),
    );
  });

  it("rejects excessive nesting before JSON.parse", () => {
    expect(() => decodeClientFrame(bytes("[[[[[[[[[0]]]]]]]]]"), false, limits)).toThrow(
      FrameDecodeError,
    );
  });
});
