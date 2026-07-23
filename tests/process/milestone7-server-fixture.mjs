import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestFailpointController,
  JsonLogger,
  WiRuntime,
  WiServer,
} from "../../apps/server/dist/index.js";
import { sessionWorkerPoolForTest } from "../../packages/storage/dist/testing.js";
import { ToolExecutor } from "../../packages/tools/dist/index.js";

const [homeDirectory, scenario = "plain-text", repairMode = "auto"] = process.argv.slice(2);
if (homeDirectory === undefined || typeof process.send !== "function") process.exit(64);

const logger = new JsonLogger();
const testFailpoints = createTestFailpointController(process.env, logger);
const blockReplay = process.env.WI_M7_BLOCK_REPLAY === "1";
const blockCatalogObservation = process.env.WI_M7_BLOCK_CATALOG_OBSERVATION === "1";
const blockStorageRequest = process.env.WI_M7_BLOCK_STORAGE_REQUEST === "1";
const retainBlocksOnShutdown = process.env.WI_M7_RETAIN_BLOCKS_ON_SHUTDOWN === "1";
const blockCommandSessionId = process.env.WI_M7_BLOCK_COMMAND_SESSION_ID;
let commandBlockUsed = false;
let releaseCommand = () => {};
const commandGate = new Promise((resolve) => {
  releaseCommand = resolve;
});
let releaseReplay = () => {};
const replayGate = new Promise((resolve) => {
  releaseReplay = resolve;
});
let releaseCatalogObservation = () => {};
const catalogObservationGate = new Promise((resolve) => {
  releaseCatalogObservation = resolve;
});
const runtime = new WiRuntime({
  homeDirectory,
  logger,
  providerConfiguration: { scenario },
  ...(blockStorageRequest || retainBlocksOnShutdown ? { shutdownDeadlineMs: 1_000 } : {}),
  toolExecutor: new ToolExecutor({
    onExecutionStart: ({ callId }) => {
      appendFileSync(join(homeDirectory, "milestone7-tool-executions.log"), `${callId}\n`, "utf8");
    },
  }),
  testFailpoints: testFailpoints ?? undefined,
  storage: {
    catalogRepair: repairMode,
    ...(blockStorageRequest
      ? {
          sessionWorkers: {
            allowTestOperations: true,
            defaultRequestTimeoutMs: 60_000,
            closeTimeoutMs: 60_000,
          },
        }
      : {}),
    ...(blockCatalogObservation
      ? {
          catalogProjectionWriter: async (catalog, update, signal) => {
            process.send?.({ type: "catalog-observation-blocked", sessionId: update.sessionId });
            await catalogObservationGate;
            signal.throwIfAborted();
            await catalog.updateSessionProjection(update);
          },
        }
      : {}),
  },
});
const server = new WiServer({
  runtime,
  port: 0,
  gateway:
    testFailpoints === null && !blockReplay && blockCommandSessionId === undefined
      ? undefined
      : {
          ...(testFailpoints === null && blockCommandSessionId === undefined
            ? {}
            : {
                commandHooks: {
                  beforeRoute: async (command) => {
                    if (
                      commandBlockUsed ||
                      blockCommandSessionId === undefined ||
                      command.sessionId !== blockCommandSessionId
                    ) {
                      return;
                    }
                    commandBlockUsed = true;
                    process.send?.({
                      type: "command-blocked",
                      sessionId: command.sessionId,
                      commandId: command.commandId,
                    });
                    await commandGate;
                  },
                  afterRouteBeforeSend: (command, accepted) => {
                    testFailpoints?.hit("after_command_commit_before_ack", {
                      commandId: command.commandId,
                      sessionId:
                        command.sessionId ??
                        (accepted.result !== null &&
                        typeof accepted.result === "object" &&
                        "sessionId" in accepted.result
                          ? accepted.result.sessionId
                          : undefined),
                    });
                  },
                },
              }),
          ...(blockReplay
            ? {
                replayHooks: {
                  afterHistoricalRead: async (sessionId) => {
                    process.send?.({ type: "replay-blocked", sessionId });
                    await replayGate;
                  },
                },
              }
            : {}),
        },
});
await server.start();
const readyReport = {
  origin: server.origin,
  pid: process.pid,
  repair: runtime.storage.catalogRepairStatus(),
};
process.send({ type: "ready", ...readyReport });

let closing = false;
function closeServer() {
  if (closing) return;
  closing = true;
  if (!retainBlocksOnShutdown) {
    releaseCommand();
    releaseReplay();
    releaseCatalogObservation();
  }
  void server.close().then(
    () => {
      process.send?.({ type: "closed" });
      process.exit(0);
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}

process.on("message", (message) => {
  if (
    message !== null &&
    typeof message === "object" &&
    message.type === "release-command"
  ) {
    releaseCommand();
    return;
  }
  if (
    blockStorageRequest &&
    message !== null &&
    typeof message === "object" &&
    message.type === "block-storage" &&
    typeof message.sessionId === "string"
  ) {
    void runtime.storage.openSession(message.sessionId).then((session) =>
      sessionWorkerPoolForTest(runtime.storage).blockWorkerForTest(session.sessionId),
    ).then(
      () => process.send?.({ type: "storage-request-blocked", sessionId: message.sessionId }),
      (error) => {
        if (closing) return;
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      },
    );
    return;
  }
  if (message !== null && typeof message === "object" && message.type === "report-ready") {
    process.send?.({ type: "ready-report", ...readyReport });
    return;
  }
  if (message === "shutdown") closeServer();
});
process.once("SIGTERM", closeServer);
process.once("SIGINT", closeServer);
