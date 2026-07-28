import { readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_MILESTONE8_RUNS,
  parseMilestone8RunCount,
} from "./support/milestone8.js";

const RUN_COUNT_ERROR = `WI_FC_NUM_RUNS must be an integer between 1 and ${MAXIMUM_MILESTONE8_RUNS}`;
const originalRunCount = process.env.WI_FC_NUM_RUNS;

function fuzzArtifactNames(): string[] {
  try {
    return readdirSync(join(process.cwd(), ".artifacts", "fuzz")).sort();
  } catch {
    return [];
  }
}

afterEach(() => {
  if (originalRunCount === undefined) delete process.env.WI_FC_NUM_RUNS;
  else process.env.WI_FC_NUM_RUNS = originalRunCount;
  vi.resetModules();
});

describe("Milestone 8 run-count bounds", () => {
  it("uses the documented default when WI_FC_NUM_RUNS is unset", () => {
    expect(parseMilestone8RunCount(undefined)).toBe(1_000);
  });

  it.each([
    ["minimum", "1", 1],
    ["normal default", "1000", 1_000],
    ["exact maximum", String(MAXIMUM_MILESTONE8_RUNS), MAXIMUM_MILESTONE8_RUNS],
  ])("accepts the %s", (_description, raw, expected) => {
    expect(parseMilestone8RunCount(raw)).toBe(expected);
  });

  it.each([
    ["maximum plus one", String(MAXIMUM_MILESTONE8_RUNS + 1)],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["nonnumeric", "many"],
    ["Number.MAX_SAFE_INTEGER", String(Number.MAX_SAFE_INTEGER)],
  ])("rejects %s with one bounded actionable error", (_description, raw) => {
    expect(() => parseMilestone8RunCount(raw)).toThrow(new RangeError(RUN_COUNT_ERROR));
  });

  it("rejects over-limit module initialization before dependent suite work", async () => {
    const artifactsBefore = fuzzArtifactNames();
    process.env.WI_FC_NUM_RUNS = String(MAXIMUM_MILESTONE8_RUNS + 1);
    vi.resetModules();

    await expect(import("./support/milestone8.js")).rejects.toThrow(
      new RangeError(RUN_COUNT_ERROR),
    );

    // A rejected ESM dependency prevents importer bodies from constructing their
    // arbitraries or entering predicates that create SQLite homes and workers.
    expect(fuzzArtifactNames()).toEqual(artifactsBefore);
  });
});
