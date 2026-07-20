import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_PORT = 4317;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 15_000;
const DEFAULT_SESSION_DISCOVERY_LIMIT = 1_000;

export interface ServerConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly wiHome: string;
  readonly catalogRepair: "auto" | "force";
  readonly shutdownDeadlineMs: number;
  readonly sessionDiscoveryLimit: number;
}

export function parseServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const configuredHome = environment.WI_HOME;
  if (configuredHome !== undefined && configuredHome.trim() === "") {
    throw new Error("WI_HOME must not be empty");
  }

  const portText = environment.WI_PORT;
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("WI_PORT must be an integer between 0 and 65535");
  }

  const shutdownText = environment.WI_SHUTDOWN_DEADLINE_MS;
  const shutdownDeadlineMs = shutdownText === undefined ? DEFAULT_SHUTDOWN_DEADLINE_MS : Number(shutdownText);
  if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 100 || shutdownDeadlineMs > 120_000) {
    throw new Error("WI_SHUTDOWN_DEADLINE_MS must be an integer between 100 and 120000");
  }

  const sessionLimitText = environment.WI_SESSION_DISCOVERY_LIMIT;
  const sessionDiscoveryLimit = sessionLimitText === undefined
    ? DEFAULT_SESSION_DISCOVERY_LIMIT
    : Number(sessionLimitText);
  if (
    !Number.isSafeInteger(sessionDiscoveryLimit) ||
    sessionDiscoveryLimit < 1 ||
    sessionDiscoveryLimit > 10_000
  ) {
    throw new Error("WI_SESSION_DISCOVERY_LIMIT must be an integer between 1 and 10000");
  }

  const repairText = environment.WI_CATALOG_REPAIR;
  if (repairText !== undefined && repairText !== "1") {
    throw new Error("WI_CATALOG_REPAIR must be 1 when provided");
  }

  return {
    host: "127.0.0.1",
    port,
    wiHome: resolve(configuredHome ?? resolve(homedir(), ".wi")),
    catalogRepair: repairText === "1" ? "force" : "auto",
    shutdownDeadlineMs,
    sessionDiscoveryLimit,
  };
}
