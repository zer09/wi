import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_PORT = 4317;

export interface ServerConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly wiHome: string;
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
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WI_PORT must be an integer between 1 and 65535");
  }

  return {
    host: "127.0.0.1",
    port,
    wiHome: resolve(configuredHome ?? resolve(homedir(), ".wi")),
  };
}
