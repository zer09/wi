import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PROVIDER_LIMITS,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
} from "@wi/provider-contract";
import type { CanonicalJsonValue, SessionEvent } from "@wi/protocol";
import { SessionStoreManager } from "@wi/storage";
import { ToolExecutor, createBuiltinToolRegistry } from "@wi/tools";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
  type AgentRunLoopIds,
  type SessionActorIds,
} from "../../packages/harness-core/src/index.js";

const homes: string[] = [];
const managers: SessionStoreManager[] = [];
const actors: SessionActor[] = [];
let fixtureNumber = 0;

function next(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}${++value}`;
}

function ids(prefix: string): { readonly actor: SessionActorIds; readonly loop: AgentRunLoopIds } {
  return {
    actor: {
      runId: next(`run_${prefix}`),
      eventId: next(`evt_${prefix}Actor`),
      messageId: next(`msg_${prefix}Actor`),
      partId: next(`part_${prefix}Actor`),
      diagnosticId: next(`err_${prefix}Actor`),
    },
    loop: {
      eventId: next(`evt_${prefix}Loop`),
      stepId: next(`step_${prefix}`),
      messageId: next(`msg_${prefix}Loop`),
      partId: next(`part_${prefix}Loop`),
      approvalId: next(`approval_${prefix}`),
      diagnosticId: next(`err_${prefix}Loop`),
    },
  };
}

class UntrustedProvider implements ProviderAdapter {
  readonly id = "untrusted-test";
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly values: (
      request: ProviderRequest,
      context: ProviderContext,
    ) => readonly unknown[],
  ) {}

  async *stream(
    request: ProviderRequest,
    context: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    signal.throwIfAborted();
    this.requests.push(request);
    for (const value of this.values(request, context)) yield value;
  }
}

async function runBoundaryFixture(options: {
  readonly values: (request: ProviderRequest, context: ProviderContext) => readonly unknown[];
  readonly messageText?: string;
  readonly providerConfig?: CanonicalJsonValue;
}): Promise<{
  readonly runId: string;
  readonly executions: readonly string[];
  readonly provider: UntrustedProvider;
  readonly events: readonly SessionEvent[];
}> {
  const number = ++fixtureNumber;
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-provider-boundary-"));
  homes.push(homeDirectory);
  const manager = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: {
      sessionId: () => `ses_providerBoundary${number}`,
      eventId: () => `evt_providerBoundarySession${number}`,
    },
    sessionWorkers: { size: 1 },
  });
  managers.push(manager);
  const created = await manager.createSession({
    v: 1,
    kind: "command",
    commandId: `cmd_providerBoundaryCreate${number}`,
    method: "session.create",
    params: {},
  });
  const session = await manager.openSession(created.session.sessionId);
  const provider = new UntrustedProvider(options.values);
  const executions: string[] = [];
  const generated = ids(`providerBoundary${number}`);
  const loop = new AgentRunLoop({
    storage: session,
    provider,
    registry: createBuiltinToolRegistry(),
    executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
    ids: generated.loop,
  });
  let signalTerminal = (): void => {};
  const terminal = new Promise<void>((resolve) => {
    signalTerminal = resolve;
  });
  const published: SessionEvent[] = [];
  const hub = new CommittedEventHub();
  hub.subscribe(session.sessionId, (event) => {
    published.push(event);
    if (
      event.eventType === "run.failed" ||
      event.eventType === "run.interrupted" ||
      event.eventType === "run.completed" ||
      event.eventType === "run.cancelled"
    ) {
      signalTerminal();
    }
  });
  let now = 2_000;
  const actor = await SessionActor.create({
    storage: session,
    eventHub: hub,
    scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
    ids: generated.actor,
    now: () => ++now,
    runTask: loop.task,
    currentToolEffectClass: loop.currentToolEffectClass,
    cancelRunTask: loop.cancel,
    forceStopRunTask: () => ({ status: "terminated" }),
    createRunProviderSnapshot: () => ({
      providerId: provider.id,
      providerConfig: options.providerConfig ?? {},
    }),
    runTaskOwnsSchedulerPermits: true,
    resumeRestoredRuns: true,
  });
  actors.push(actor);
  const submitted = await actor.submitMessage({
    v: 1,
    kind: "command",
    commandId: `cmd_providerBoundarySubmit${number}`,
    sessionId: session.sessionId,
    method: "message.submit",
    params: { text: options.messageText ?? "provider boundary" },
  });
  await terminal;
  await expect(session.getRun(submitted.runId)).resolves.toMatchObject({
    state: "failed",
    failureCategory: "provider.protocol_error",
    activeProviderStepId: null,
  });
  return {
    runId: submitted.runId,
    executions,
    provider,
    events: await session.getEventsAfter(0),
  };
}

afterEach(async () => {
  await Promise.allSettled(actors.splice(0).map((actor) => actor.shutdown()));
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Milestone 4 provider runtime boundary", () => {
  it.each([
    ["unknown event type", (request: ProviderRequest) => [{ type: "unknown", runId: request.runId }]],
    ["missing identity", () => [{ type: "response.started", responseId: "response_missing" }]],
    [
      "wrong field type",
      (request: ProviderRequest) => [
        { type: "response.started", ...request, responseId: 42 },
      ],
    ],
    [
      "extra field",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_extra",
          extra: true,
        },
      ],
    ],
    [
      "invalid step index",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: -1,
          responseId: "response_badIndex",
        },
      ],
    ],
    [
      "invalid retry data",
      (request: ProviderRequest) => [
        {
          type: "response.failed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          category: "terminal",
          message: "terminal cannot retry",
          retryable: true,
        },
      ],
    ],
    [
      "malformed terminal",
      (request: ProviderRequest) => [
        {
          type: "response.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
        },
      ],
    ],
    [
      "oversized text delta",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_oversizedDelta",
        },
        {
          type: "text.delta",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          delta: "x".repeat(PROVIDER_LIMITS.textDeltaMaxBytes + 1),
        },
      ],
    ],
    [
      "malformed tool call followed by completion",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_malformedTool",
        },
        {
          type: "tool_call.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          callId: "call_malformedBoundary",
          name: "echo",
          argumentsJson: 42,
        },
        {
          type: "response.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_malformedTool",
        },
      ],
    ],
  ] as const)("rejects %s before any tool effect", async (_name, values) => {
    const value = await runBoundaryFixture({ values });
    expect(value.executions).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.tool_call.staged"),
    ).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "tool.execution.started"),
    ).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.step.failed"),
    ).toHaveLength(1);
  });

  it("rejects oversized request history before invoking the provider", async () => {
    const value = await runBoundaryFixture({
      values: () => [],
      messageText: "x".repeat(PROVIDER_LIMITS.messageTextMaxBytes + 1),
    });
    expect(value.provider.requests).toEqual([]);
    expect(value.executions).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.step.started"),
    ).toEqual([]);
  });

  it("rejects oversized provider configuration before invoking the provider", async () => {
    const value = await runBoundaryFixture({
      values: () => [],
      providerConfig: { value: "x".repeat(PROVIDER_LIMITS.providerConfigMaxBytes) },
    });
    expect(value.provider.requests).toEqual([]);
    expect(value.executions).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.step.started"),
    ).toEqual([]);
  });
});
