import { describe, expect, it } from "vitest";

import { ERROR_CODES, ErrorCodeSchema, PROTOCOL_ERROR_CODES } from "./errors.js";

describe("error taxonomy", () => {
  it("accepts every canonical error code", () => {
    for (const code of ERROR_CODES) expect(ErrorCodeSchema.parse(code)).toBe(code);
  });

  it("keeps control-plane error codes within the canonical taxonomy", () => {
    expect(PROTOCOL_ERROR_CODES.every((code) => ERROR_CODES.includes(code))).toBe(true);
    expect(PROTOCOL_ERROR_CODES).toContain("storage.corrupt");
    expect(ErrorCodeSchema.safeParse("unknown.error").success).toBe(false);
  });
});
