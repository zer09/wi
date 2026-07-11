import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerConfig } from "./config.js";

describe("parseServerConfig", () => {
  it("uses loopback, the default port, and the default Wi home", () => {
    expect(parseServerConfig({})).toEqual({
      host: "127.0.0.1",
      port: 4317,
      wiHome: resolve(homedir(), ".wi"),
    });
  });

  it("uses loopback and resolves the configured Wi home once", () => {
    expect(parseServerConfig({ WI_HOME: "var/wi", WI_PORT: "5000" })).toEqual({
      host: "127.0.0.1",
      port: 5000,
      wiHome: resolve("var/wi"),
    });
  });

  it("rejects an empty Wi home", () => {
    expect(() => parseServerConfig({ WI_HOME: "  " })).toThrow("WI_HOME must not be empty");
  });

  it.each(["0", "65536", "1.5", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => parseServerConfig({ WI_PORT: port })).toThrow(
      "WI_PORT must be an integer between 1 and 65535",
    );
  });
});
