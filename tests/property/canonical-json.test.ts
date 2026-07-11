import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonHash,
} from "../../packages/protocol/src/canonical-json.js";

const propertyOptions = { numRuns: 250 } as const;

function permuteObjectKeys(
  value: unknown,
  priorities: readonly number[],
  cursor: { index: number },
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => permuteObjectKeys(child, priorities, cursor));
  }
  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value).map(([key, child], originalIndex) => {
    const priority = priorities[cursor.index] ?? originalIndex;
    cursor.index += 1;
    return { key, child: permuteObjectKeys(child, priorities, cursor), priority, originalIndex };
  });
  entries.sort(
    (left, right) => left.priority - right.priority || left.originalIndex - right.originalIndex,
  );
  return Object.fromEntries(entries.map(({ key, child }) => [key, child]));
}

function nestUnsupportedValue(value: unknown, path: readonly ("array" | string)[]): unknown {
  return path.reduceRight<unknown>((nested, segment) => {
    if (segment === "array") return [null, nested];
    return { supported: true, [segment]: nested };
  }, value);
}

describe("canonical JSON properties", () => {
  it("round-trips every supported JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const encoded = canonicalJson(value);
        expect(canonicalJson(JSON.parse(encoded) as unknown)).toBe(encoded);
        expect(new TextDecoder().decode(canonicalJsonBytes(value))).toBe(encoded);
      }),
      propertyOptions,
    );
  });

  it("is invariant to object-key permutations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.jsonValue(),
        fc.array(fc.integer(), { maxLength: 200 }),
        async (value, priorities) => {
          const permuted = permuteObjectKeys(value, priorities, { index: 0 });
          expect(canonicalJson(permuted)).toBe(canonicalJson(value));
          expect(await canonicalJsonHash(permuted)).toBe(await canonicalJsonHash(value));
        },
      ),
      propertyOptions,
    );
  });

  it("always rejects unsupported values", () => {
    const unsupportedLeaf = fc.oneof(
      fc.constant(undefined),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
      fc.bigInt(),
      fc.string().map((description) => Symbol(description)),
      fc.string().map((result) => () => result),
      fc.date(),
      fc.constant(new Map()),
    );
    const pathSegment = fc.oneof(fc.constant("array" as const), fc.string());

    fc.assert(
      fc.property(
        unsupportedLeaf,
        fc.array(pathSegment, { maxLength: 12 }),
        (value, path) => {
          expect(() => canonicalJson(nestUnsupportedValue(value, path))).toThrow(TypeError);
        },
      ),
      propertyOptions,
    );
  });
});
