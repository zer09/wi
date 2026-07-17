import { setTimeout as delay } from "node:timers/promises";
import { WiRuntime, WiServer } from "../../apps/server/dist/index.js";
import { FakeProviderAdapter } from "../../packages/provider-fake/dist/index.js";
import { SessionStoreManager } from "../../packages/storage/dist/index.js";
import { DelayInputSchema, ToolRegistry } from "../../packages/tools/dist/index.js";

const [homeDirectory, mode] = process.argv.slice(2);
if (homeDirectory === undefined || (mode !== "provider" && mode !== "tool")) process.exit(64);
if (typeof process.send !== "function") process.exit(65);

const send = (type, fields = {}) => process.send?.({ type, mode, ...fields });
const unhandledRejections = [];
process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  unhandledRejections.push(message);
  send("unhandled_rejection", { message });
});

let releaseResource = () => {};
const resourceBlocker = new Promise((resolve) => {
  releaseResource = resolve;
});
let activityCount = 0;
let abortSeen = false;
let postAbortReported = false;
let terminalSeen = false;
let postTerminalReported = false;
let resourceInterval = null;
let runtime;

function schedulerState() {
  return runtime.scheduler.state;
}

function startNonCooperativeResource(runId, signal) {
  signal.addEventListener(
    "abort",
    () => {
      abortSeen = true;
      send("abort_observed", { runId, scheduler: schedulerState() });
    },
    { once: true },
  );
  resourceInterval = globalThis.setInterval(() => {
    activityCount += 1;
    if (abortSeen && !postAbortReported) {
      postAbortReported = true;
      send("post_abort_work", {
        runId,
        activityCount,
        resourceHandleActive: resourceInterval !== null,
        scheduler: schedulerState(),
      });
    }
    if (terminalSeen && !postTerminalReported) {
      postTerminalReported = true;
      send("post_terminal_work", {
        runId,
        activityCount,
        scheduler: schedulerState(),
      });
    }
  }, 10);
  send("resource_started", { runId, scheduler: schedulerState() });
}

class NonCooperativeProvider extends FakeProviderAdapter {
  async *stream(request, _context, signal) {
    this.requests.push(request);
    startNonCooperativeResource(request.runId, signal);
    yield {
      type: "response.started",
      runId: request.runId,
      stepId: request.stepId,
      stepIndex: request.stepIndex,
      responseId: `response_${request.runId}_${request.stepIndex}`,
    };
    await resourceBlocker;
    yield {
      type: "response.completed",
      runId: request.runId,
      stepId: request.stepId,
      stepIndex: request.stepIndex,
      responseId: `response_${request.runId}_${request.stepIndex}`,
    };
  }
}

const toolRegistry = new ToolRegistry();
if (mode === "tool") {
  toolRegistry.register({
    name: "delay",
    description: "H2 noncooperative tool probe.",
    inputSchema: DelayInputSchema,
    effectClass: "pure",
    approval: "never",
    executionMode: "cooperative_in_process",
    timeoutMs: 60_000,
    execute: async (_input, context, signal) => {
      startNonCooperativeResource(context.runId, signal);
      await resourceBlocker;
      return { released: true };
    },
  });
}

runtime = new WiRuntime({
  homeDirectory,
  provider: mode === "provider" ? new NonCooperativeProvider() : new FakeProviderAdapter(),
  providerConfiguration:
    mode === "provider"
      ? { scenario: "plain-text" }
      : { scenario: "echo-tool-round-trip", roundTripTool: "delay" },
  ...(mode === "tool" ? { toolRegistry } : {}),
  providerCapacity: 1,
  toolCapacity: 1,
});
const server = new WiServer({ runtime, port: 0 });
await server.start();

const created = await runtime.storage.createSession({
  v: 1,
  kind: "command",
  commandId: `cmd_h2_${mode}_create`,
  method: "session.create",
  params: { title: `H2 ${mode} force-stop probe` },
});
const sessionId = created.session.sessionId;
let runId = null;
const terminalSubscription = runtime.eventHub.subscribe(sessionId, (event) => {
  if (
    event.data?.runId !== runId ||
    !["run.interrupted", "run.cancelled", "run.failed"].includes(event.eventType)
  ) {
    return;
  }
  terminalSeen = true;
  send("run_terminal", {
    runId,
    eventType: event.eventType,
    sequence: event.sequence,
    activityCount,
    scheduler: schedulerState(),
  });
});

const accepted = await runtime.commandRouter.route(
  {
    v: 1,
    kind: "command",
    commandId: `cmd_h2_${mode}_submit`,
    sessionId,
    method: "message.submit",
    params: { text: `Start the H2 ${mode} probe.` },
  },
  "client_h2_probe",
);
runId = accepted.runId ?? null;
if (runId === null) throw new Error("H2 probe did not create a run");

let shutdownStarted = false;
process.on("message", (message) => {
  if (message !== "shutdown" || shutdownStarted) return;
  shutdownStarted = true;
  send("shutdown_started", { runId, scheduler: schedulerState() });
  void (async () => {
    let fulfilled = true;
    let errorName = null;
    let errorMessage = null;
    try {
      await server.close();
    } catch (error) {
      fulfilled = false;
      errorName = error instanceof Error ? error.name : typeof error;
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const inspector = new SessionStoreManager({ homeDirectory });
    await inspector.ready();
    const session = await inspector.openSession(sessionId);
    const run = await session.getRun(runId);
    await inspector.close();
    send("close_result", {
      fulfilled,
      errorName,
      errorMessage,
      runState: run?.state ?? null,
      serverAddress: server.address,
      activityCount,
      resourceHandleActive: resourceInterval !== null,
      scheduler: schedulerState(),
      unhandledRejections: [...unhandledRejections],
    });
  })();
});

process.on("SIGTERM", () => {
  if (resourceInterval !== null) globalThis.clearInterval(resourceInterval);
  resourceInterval = null;
  terminalSubscription.unsubscribe();
  releaseResource();
  void delay(0).then(() => process.exit(0));
});

const watchdog = globalThis.setTimeout(() => {
  send("watchdog", { scheduler: schedulerState(), activityCount });
  process.exit(70);
}, 30_000);
watchdog.unref();
