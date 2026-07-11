import { describe, expect, it } from "vitest";

import { ERROR_CODES, ErrorCodeSchema, PROTOCOL_ERROR_CODES } from "./errors.js";

describe("error taxonomy", () => {
  it("accepts every canonical error code", () => {
    for (const code of ERROR_CODES) expect(ErrorCodeSchema.parse(code)).toBe(code);
  });

  it("keeps connection-level protocol errors to the protocol subset", () => {
    expect(PROTOCOL_ERROR_CODES.every((code) => ERROR_CODES.includes(code))).toBe(true);
    expect(ErrorCodeSchema.safeParse("unknown.error").success).toBe(false);
  });
});
