import { describe, expect, it } from "vitest";

import { CommandIdSchema, createId, createIdGenerator } from "./ids.js";

describe("ID helpers", () => {
  it("uses the injected source deterministically", () => {
    const values = ["first", "second"];
    const source = () => values.shift() ?? "exhausted";
    const nextCommandId = createIdGenerator("command", source);

    expect(nextCommandId()).toBe("cmd_first");
    expect(nextCommandId()).toBe("cmd_second");
  });

  it("validates generated and decoded IDs", () => {
    expect(createId("command", () => "valid_01")).toBe("cmd_valid_01");
    expect(CommandIdSchema.safeParse("cmd_valid_01").success).toBe(true);
    expect(CommandIdSchema.safeParse("ses_valid_01").success).toBe(false);
    expect(() => createId("command", () => "contains spaces")).toThrow();
  });
});
