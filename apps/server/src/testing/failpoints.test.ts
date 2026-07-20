import { describe, expect, it } from "vitest";

import { createTestFailpointController, TEST_FAILPOINTS } from "./failpoints.js";

describe("test-only failpoint controls", () => {
  it("is inert without an explicit failpoint", () => {
    expect(createTestFailpointController({ NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" }))
      .toBeNull();
  });

  it.each([
    { WI_TEST_FAILPOINT: TEST_FAILPOINTS[0] },
    { NODE_ENV: "test", WI_TEST_FAILPOINT: TEST_FAILPOINTS[0] },
    { WI_ALLOW_TEST_FAILPOINTS: "1", WI_TEST_FAILPOINT: TEST_FAILPOINTS[0] },
  ])("rejects activation unless both test gates are present", (environment) => {
    expect(() => createTestFailpointController(environment)).toThrow(
      "requires NODE_ENV=test and WI_ALLOW_TEST_FAILPOINTS=1",
    );
  });

  it("rejects names outside the closed inventory", () => {
    expect(() =>
      createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "browser_supplied_name",
      }),
    ).toThrow("Unknown test failpoint");
  });

  it("assigns stable deterministic exit codes", () => {
    for (const [index, name] of TEST_FAILPOINTS.entries()) {
      const controller = createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: name,
      });
      expect(controller).toMatchObject({ name, exitCode: 90 + index });
      expect(controller?.is(name)).toBe(true);
    }
  });
});
