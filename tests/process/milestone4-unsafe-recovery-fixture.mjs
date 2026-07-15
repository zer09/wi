import { FakeProviderAdapter } from "@wi/provider-fake";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
} from "../../packages/harness-core/dist/index.js";
import { SessionStoreManager } from "@wi/storage";
import { ToolExecutor, ToolRegistry, createEchoTool } from "@wi/tools";

const [homeDirectory, sessionId, mode] = process.argv.slice(2);
if (homeDirectory === undefined || sessionId === undefined || mode === undefined) process.exit(64);
if (mode !== "recover-crash" && mode !== "inspect") process.exit(65);

const manager = new SessionStoreManager({
  homeDirectory,
  sessionWorkers: { size: 1 },
});
const session = await manager.openSession(sessionId);
let crashed = false;
const actorStorage =
  mode === "recover-crash"
    ? new Proxy(session, {
        get(target, property) {
          if (property === "appendTransaction") {
            return async (input) => {
              const result = await target.appendTransaction(input);
              if (
                !crashed &&
                input.events.some((event) => event.eventType === "tool.execution.outcome_unknown") &&
                input.events.some((event) => event.eventType === "run.interrupted")
              ) {
                crashed = true;
                process.exit(91);
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
  name: "unsafe_process",
  effectClass: "non_idempotent",
});
const provider = new FakeProviderAdapter();
const executions = [];
let identifier = 0;
const next = (prefix) => () => `${prefix}${++identifier}`;
const loop = new AgentRunLoop({
  storage: actorStorage,
  provider,
  registry,
  executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
  ids: {
    eventId: next("evt_processRecoveryLoop"),
    stepId: next("step_processRecovery"),
    messageId: next("msg_processRecovery"),
    partId: next("part_processRecovery"),
    approvalId: next("approval_processRecovery"),
    diagnosticId: next("err_processRecoveryLoop"),
  },
});
const actor = await SessionActor.create({
  storage: actorStorage,
  eventHub: new CommittedEventHub(),
  scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
  ids: {
    runId: next("run_processRecoveryActor"),
    eventId: next("evt_processRecoveryActor"),
    messageId: next("msg_processRecoveryActor"),
    partId: next("part_processRecoveryActor"),
    diagnosticId: next("err_processRecoveryActor"),
  },
  now: () => 5_000 + identifier,
  runTask: loop.task,
  currentToolEffectClass: loop.currentToolEffectClass,
  cancelRunTask: loop.cancel,
  forceStopRunTask: () => ({ status: "terminated" }),
  runTaskOwnsSchedulerPermits: true,
  resumeRestoredRuns: true,
});

if (mode === "recover-crash") process.exit(92);
const run = await session.getRun("run_processUnsafe");
const tool = await session.getToolExecution("call_processUnsafe");
const events = await session.getEventsAfter(0);
process.stdout.write(
  `${JSON.stringify({
    runState: run?.state ?? null,
    toolState: tool?.state ?? null,
    effectClass: tool?.effectClass ?? null,
    attemptCount: tool?.attemptCount ?? null,
    providerRequests: provider.requests.length,
    executions: executions.length,
    headSequence: events.at(-1)?.sequence ?? 0,
    outcomeUnknownEvents: events.filter(
      (event) =>
        event.eventType === "tool.execution.outcome_unknown" &&
        event.data.callId === "call_processUnsafe",
    ).length,
    interruptedEvents: events.filter(
      (event) =>
        event.eventType === "run.interrupted" && event.data.runId === "run_processUnsafe",
    ).length,
  })}\n`,
);
await actor.shutdown();
await manager.close();
