import { describe, expect, it } from "vitest";

import { canonicalJson, canonicalJsonBytes, canonicalJsonHash } from "./canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: [3, 2, 1], a: { y: true, x: null } })).toBe(
      '{"a":{"x":null,"y":true},"z":[3,2,1]}',
    );
    expect(new TextDecoder().decode(canonicalJsonBytes({ b: 2, a: 1 }))).toBe(
      '{"a":1,"b":2}',
    );
  });

  it("produces a stable SHA-256 digest", async () => {
    await expect(canonicalJsonHash({ b: 2, a: 1 })).resolves.toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    Symbol("unsupported"),
    () => undefined,
    new Date(0),
    new Map(),
    { value: undefined },
  ])("rejects unsupported value %#", (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects cycles and sparse arrays", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array.from({ length: 2 }) as unknown[];
    delete sparse[0];

    expect(() => canonicalJson(cyclic)).toThrow("cycles");
    expect(() => canonicalJson(sparse)).toThrow("sparse");
  });
});
