import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSupportedServerPlatform, parseServerConfig } from "./config.js";

describe("assertSupportedServerPlatform", () => {
  it("accepts Linux and rejects unsupported operating systems", () => {
    expect(() => assertSupportedServerPlatform("linux")).not.toThrow();
    expect(() => assertSupportedServerPlatform("win32")).toThrow(
      "Wi v0.1 supports Linux only",
    );
    expect(() => assertSupportedServerPlatform("darwin")).toThrow(
      "Wi v0.1 supports Linux only",
    );
  });
});

describe("parseServerConfig", () => {
  it("uses loopback, the default port, and the default Wi home", () => {
    expect(parseServerConfig({})).toEqual({
      host: "127.0.0.1",
      port: 4317,
      wiHome: resolve(homedir(), ".wi"),
      catalogRepair: "auto",
      shutdownDeadlineMs: 15_000,
      sessionDiscoveryLimit: 1_000,
    });
  });

  it("uses loopback and resolves the configured Wi home once", () => {
    expect(parseServerConfig({ WI_HOME: "var/wi", WI_PORT: "5000" })).toEqual({
      host: "127.0.0.1",
      port: 5000,
      wiHome: resolve("var/wi"),
      catalogRepair: "auto",
      shutdownDeadlineMs: 15_000,
      sessionDiscoveryLimit: 1_000,
    });
  });

  it("accepts port zero for an operating-system-assigned loopback port", () => {
    expect(parseServerConfig({ WI_PORT: "0" }).port).toBe(0);
  });

  it("exposes a bounded production session discovery override", () => {
    expect(
      parseServerConfig({ WI_SESSION_DISCOVERY_LIMIT: "2500" }).sessionDiscoveryLimit,
    ).toBe(2_500);
    for (const value of ["0", "10001", "1.5", "many"]) {
      expect(() => parseServerConfig({ WI_SESSION_DISCOVERY_LIMIT: value })).toThrow(
        "WI_SESSION_DISCOVERY_LIMIT must be an integer between 1 and 10000",
      );
    }
  });

  it("enables explicit catalog repair without accepting a path", () => {
    expect(parseServerConfig({ WI_CATALOG_REPAIR: "1" })).toMatchObject({
      catalogRepair: "force",
    });
    expect(() => parseServerConfig({ WI_CATALOG_REPAIR: "/tmp/catalog" })).toThrow(
      "WI_CATALOG_REPAIR must be 1",
    );
  });

  it("validates the one server-owned shutdown deadline", () => {
    expect(parseServerConfig({ WI_SHUTDOWN_DEADLINE_MS: "900" }).shutdownDeadlineMs).toBe(900);
    expect(() => parseServerConfig({ WI_SHUTDOWN_DEADLINE_MS: "99" })).toThrow(
      "WI_SHUTDOWN_DEADLINE_MS must be an integer between 100 and 120000",
    );
  });

  it("rejects an empty Wi home", () => {
    expect(() => parseServerConfig({ WI_HOME: "  " })).toThrow("WI_HOME must not be empty");
  });

  it.each(["-1", "65536", "1.5", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => parseServerConfig({ WI_PORT: port })).toThrow(
      "WI_PORT must be an integer between 0 and 65535",
    );
  });
});
