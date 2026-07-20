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
let shutdownDeadlineMs = 15_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server_shutdown_started", { signal });
  const watchdog = setTimeout(() => {
    logger.error("server_shutdown_watchdog", new Error("Shutdown exceeded hard deadline"), { signal });
    process.exit(1);
  }, shutdownDeadlineMs + 2_000);
  watchdog.unref();
  try {
    await server?.close();
    logger.info("server_shutdown_completed", { signal });
    clearTimeout(watchdog);
    // Worker-thread handles must not keep a successfully closed signal path
    // resident after all durable close phases have completed.
    process.exit(0);
  } catch (error) {
    logFatalServerLifecycleFailure(
      logger,
      "server_shutdown_failed",
      error,
      diagnosticId,
      { signal },
    );
    process.exitCode = 1;
    // Keep the watchdog armed after a bounded close failure: timed-out work may
    // still retain handles. A nonzero forced exit is preferable to a hung signal
    // shutdown that only happened to set exitCode.
    setTimeout(() => process.exit(1), 0).unref();
  }
}

async function main(): Promise<void> {
  try {
    const config = parseServerConfig(process.env);
    shutdownDeadlineMs = config.shutdownDeadlineMs;
    const runtime = new WiRuntime({
      homeDirectory: config.wiHome,
      logger,
      shutdownDeadlineMs: config.shutdownDeadlineMs,
      storage: {
        catalogRepair: config.catalogRepair,
        sessionDiscoveryLimit: config.sessionDiscoveryLimit,
      },
    });
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
