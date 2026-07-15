import { appendFile, readFile } from "node:fs/promises";

import { FakeProviderAdapter } from "@wi/provider-fake";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
} from "../../packages/harness-core/dist/index.js";
import { SessionStoreManager } from "@wi/storage";
import { ToolExecutor, ToolRegistry, createEchoTool } from "@wi/tools";

const [homeDirectory, sessionId, mode, window, executionLog, providerLog] = process.argv.slice(2);
if (
  homeDirectory === undefined ||
  sessionId === undefined ||
  mode === undefined ||
  window === undefined ||
  executionLog === undefined ||
  providerLog === undefined
) {
  process.exit(64);
}
const windows = new Set(["staged", "promoted", "pure-started", "unsafe-started", "result"]);
if (!windows.has(window)) process.exit(65);
if (mode !== "crash" && mode !== "restart1" && mode !== "restart2") process.exit(66);

function scenarioForWindow() {
  return window === "staged" ? "partial-tool-call-without-terminal" : "echo-tool-round-trip";
}

function failpointEventType() {
  switch (window) {
    case "staged":
      return "provider.tool_call.staged";
    case "promoted":
      return "tool.call.requested";
    case "pure-started":
    case "unsafe-started":
      return "tool.execution.started";
    case "result":
      return "tool.execution.completed";
    default:
      throw new Error("Unknown process failpoint window");
  }
}

async function lineCount(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((line) => line.length > 0).length;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return 0;
    throw error;
  }
}

class LoggingProvider {
  id = "fake";
  requests = [];
  #delegate = new FakeProviderAdapter();

  async *stream(request, context, signal) {
    this.requests.push(request);
    await appendFile(
      providerLog,
      `${JSON.stringify({ runId: request.runId, stepIndex: request.stepIndex })}\n`,
      "utf8",
    );
    yield* this.#delegate.stream(request, context, signal);
  }
}

const manager = new SessionStoreManager({
  homeDirectory,
  sessionWorkers: { size: 1 },
});
const session = await manager.openSession(sessionId);
let failpointTriggered = false;
const storage =
  mode === "crash"
    ? new Proxy(session, {
        get(target, property) {
          if (property === "appendTransaction") {
            return async (input) => {
              const result = await target.appendTransaction(input);
              if (
                !failpointTriggered &&
                input.events.some((event) => event.eventType === failpointEventType())
              ) {
                failpointTriggered = true;
                process.exit(100 + ["staged", "promoted", "pure-started", "unsafe-started", "result"].indexOf(window));
              }
              return result;
            };
          }
          const member = Reflect.get(target, property);
          return typeof member === "function" ? member.bind(target) : member;
        },
      })
    : session;

const registry = new ToolRegistry();
registry.register({
  ...createEchoTool(),
  effectClass: window === "unsafe-started" ? "non_idempotent" : "pure",
  execute: async (input, context) => {
    await appendFile(executionLog, `${context.callId}\n`, "utf8");
    return { text: input.text };
  },
});
const provider = new LoggingProvider();
let id = 0;
const processName = `${mode.replaceAll("-", "")}${window.replaceAll("-", "")}`;
const next = (prefix) => () => `${prefix}${processName}${++id}`;
const loop = new AgentRunLoop({
  storage,
  provider,
  registry,
  executor: new ToolExecutor(),
  ids: {
    eventId: next("evt_processLoop"),
    stepId: next("step_process"),
    messageId: next("msg_process"),
    partId: next("part_process"),
    approvalId: next("approval_process"),
    diagnosticId: next("err_processLoop"),
  },
});
const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
let signalTerminal = () => {};
const terminal = new Promise((resolve) => {
  signalTerminal = resolve;
});
const hub = new CommittedEventHub();
hub.subscribe(sessionId, (event) => {
  if (
    event.eventType === "run.completed" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled" ||
    event.eventType === "run.interrupted"
  ) {
    signalTerminal();
  }
});
const actor = await SessionActor.create({
  storage,
  eventHub: hub,
  scheduler,
  ids: {
    runId: next("run_process"),
    eventId: next("evt_processActor"),
    messageId: next("msg_processActor"),
    partId: next("part_processActor"),
    diagnosticId: next("err_processActor"),
  },
  now: () => 10_000 + id,
  runTask: loop.task,
  currentToolEffectClass: loop.currentToolEffectClass,
  cancelRunTask: loop.cancel,
  forceStopRunTask: () => ({ status: "terminated" }),
  createRunProviderSnapshot: () => ({
    providerId: "fake",
    providerConfig: { scenario: scenarioForWindow() },
  }),
  runTaskOwnsSchedulerPermits: true,
  resumeRestoredRuns: true,
});

let runId = "run_processCrashTarget";
if (mode === "crash") {
  const submitted = await actor.submitMessage({
    v: 1,
    kind: "command",
    commandId: "cmd_processCrashSubmit",
    sessionId,
    method: "message.submit",
    params: { text: `process ${window}` },
  });
  runId = submitted.runId;
  await terminal;
  process.exit(90);
}

const nonterminal = await session.getNonterminalRuns();
const recoveredRun = nonterminal[0] ?? null;
if (recoveredRun !== null) runId = recoveredRun.runId;
let run = await session.getRun(runId);
if (run === null) {
  const events = await session.getEventsAfter(0);
  const runEvent = events.find((event) => event.eventType === "run.created");
  if (runEvent?.eventType !== "run.created") throw new Error("Process run identity is missing");
  runId = runEvent.data.runId;
  run = await session.getRun(runId);
}
if (run === null) throw new Error("Process run disappeared");
if (!["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
  await terminal;
  run = await session.getRun(runId);
  if (run === null) throw new Error("Settled process run disappeared");
}
await actor.flush();
const events = await session.getEventsAfter(0);
const tools = await session.getToolExecutionsForRun(runId);
const [tool] = tools;
const result = {
  runId,
  runState: run.state,
  runFailureCategory: run.failureCategory,
  activeProviderStepId: run.activeProviderStepId,
  toolState: tool?.state ?? null,
  effectClass: tool?.effectClass ?? null,
  attemptCount: tool?.attemptCount ?? null,
  providerRequests: await lineCount(providerLog),
  executions: await lineCount(executionLog),
  headSequence: events.at(-1)?.sequence ?? 0,
  terminalEvents: events.filter(
    (event) =>
      "runId" in event.data &&
      event.data.runId === runId &&
      ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.eventType),
  ).length,
  stagedEvents: events.filter(
    (event) => event.eventType === "provider.tool_call.staged" && event.data.runId === runId,
  ).length,
  startedEvents: events.filter(
    (event) => event.eventType === "tool.execution.started" && event.data.runId === runId,
  ).length,
  completedToolEvents: events.filter(
    (event) => event.eventType === "tool.execution.completed" && event.data.runId === runId,
  ).length,
  outcomeUnknownEvents: events.filter(
    (event) => event.eventType === "tool.execution.outcome_unknown" && event.data.runId === runId,
  ).length,
  completedAssistantEvents: events.filter(
    (event) => event.eventType === "assistant.message.completed" && event.data.runId === runId,
  ).length,
  scheduler: scheduler.state,
};
await actor.shutdown();
await scheduler.shutdown();
await manager.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
