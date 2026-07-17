import { randomUUID } from "node:crypto";
import { createId } from "@wi/protocol";
import { WiRuntime } from "./composition.js";
import { parseServerConfig } from "./config.js";
import { WiServer } from "./http/server.js";
import { logFatalServerLifecycleFailure } from "./logging/lifecycle.js";
import { JsonLogger, nonThrowingLogger } from "./logging/logger.js";

const logger = nonThrowingLogger(new JsonLogger());
const diagnosticId = (): string =>
  createId("diagnostic", () => randomUUID().replaceAll("-", ""));
let server: WiServer | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server_shutdown_started", { signal });
  try {
    await server?.close();
    logger.info("server_shutdown_completed", { signal });
  } catch (error) {
    logFatalServerLifecycleFailure(
      logger,
      "server_shutdown_failed",
      error,
      diagnosticId,
      { signal },
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  try {
    const config = parseServerConfig(process.env);
    const runtime = new WiRuntime({ homeDirectory: config.wiHome, logger });
    server = new WiServer({ runtime, host: config.host, port: config.port });
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    await server.start();
  } catch (error) {
    logFatalServerLifecycleFailure(logger, "server_start_failed", error, diagnosticId);
    process.exitCode = 1;
  }
}

await main();
