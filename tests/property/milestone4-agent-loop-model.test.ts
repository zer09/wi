import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  FakeProviderAdapter,
  FakeProviderController,
  fakeProviderGateLabel,
  type FakeProviderConfiguration,
} from "@wi/provider-fake";
import type { SessionEvent } from "@wi/protocol";
import { SessionStoreManager, type SessionClient } from "@wi/storage";
import { ToolExecutor, createBuiltinToolRegistry } from "@wi/tools";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
  type AgentRunLoopIds,
  type SessionActorIds,
} from "../../packages/harness-core/src/index.js";

const propertySeed = Number.parseInt(process.env.WI_M4_AGENT_FC_SEED ?? "404405", 10);
const propertyPath = process.env.WI_M4_AGENT_FC_PATH;
let caseNumber = 0;

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}${++value}`;
}

function generatedIds(prefix: string): { actor: SessionActorIds; loop: AgentRunLoopIds } {
  return {
    actor: {
      runId: sequence(`run_${prefix}`),
      eventId: sequence(`evt_${prefix}Actor`),
      messageId: sequence(`msg_${prefix}Actor`),
      partId: sequence(`part_${prefix}Actor`),
      diagnosticId: sequence(`err_${prefix}Actor`),
    },
    loop: {
      eventId: sequence(`evt_${prefix}Loop`),
      stepId: sequence(`step_${prefix}`),
      messageId: sequence(`msg_${prefix}Loop`),
      partId: sequence(`part_${prefix}Loop`),
      approvalId: sequence(`approval_${prefix}`),
      diagnosticId: sequence(`err_${prefix}Loop`),
    },
  };
}

class EventMonitor {
  private readonly events: SessionEvent[] = [];
  private readonly waiters = new Set<{
    readonly predicate: (event: SessionEvent) => boolean;
    readonly resolve: (event: SessionEvent) => void;
  }>();

  readonly record = (event: SessionEvent): void => {
    this.events.push(event);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(event)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  };

  waitFor(predicate: (event: SessionEvent) => boolean): Promise<SessionEvent> {
    const existing = this.events.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<SessionEvent>((resolve) => {
      this.waiters.add({ predicate, resolve });
    });
  }
}

function terminalFor(runId: string): (event: SessionEvent) => boolean {
  return (event) =>
    "runId" in event.data &&
    event.data.runId === runId &&
    (event.eventType === "run.completed" ||
      event.eventType === "run.failed" ||
      event.eventType === "run.cancelled" ||
      event.eventType === "run.interrupted");
}

type GeneratedTrace =
  | { readonly kind: "cross_step_duplicate" }
  | { readonly kind: "partial_stream"; readonly cancel: boolean }
  | {
      readonly kind: "approval";
      readonly action: "approved" | "denied" | "cancelled";
      readonly reconstructAfterApproval: boolean;
    }
  | { readonly kind: "retry" }
  | { readonly kind: "promotion_failure" };

const generatedTrace = fc.oneof(
  fc.constant<GeneratedTrace>({ kind: "cross_step_duplicate" }),
  fc.record({
    kind: fc.constant("partial_stream" as const),
    cancel: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("approval" as const),
    action: fc.constantFrom("approved" as const, "denied" as const, "cancelled" as const),
    reconstructAfterApproval: fc.boolean(),
  }),
  fc.constant<GeneratedTrace>({ kind: "retry" }),
  fc.constant<GeneratedTrace>({ kind: "promotion_failure" }),
);

function scenarioFor(trace: GeneratedTrace): FakeProviderConfiguration {
  if (trace.kind === "cross_step_duplicate") return { scenario: "duplicate-call-id-later-step" };
  if (trace.kind === "partial_stream") return { scenario: "partial-tool-call-without-terminal" };
  if (trace.kind === "approval") return { scenario: "approval-round-trip" };
  if (trace.kind === "retry") return { scenario: "transient-failure-before-output" };
  return { scenario: "echo-tool-round-trip" };
}

async function runTrace(trace: GeneratedTrace): Promise<void> {
  const number = ++caseNumber;
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-property-agent-"));
  const manager = new SessionStoreManager({
    homeDirectory,
    ids: {
      sessionId: () => `ses_propertyAgent${number}`,
      eventId: () => `evt_propertyAgentCreated${number}`,
    },
    now: () => 1_000,
    sessionWorkers: { size: 1, allowTestOperations: true },
  });
  const actors: SessionActor[] = [];
  let releaseBlocker: (() => void) | null = null;
  let blocker: Promise<void> | null = null;

  try {
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: `cmd_propertyAgentCreate${number}`,
      method: "session.create",
      params: {},
    });
    const rawSession = await manager.openSession(created.session.sessionId);
    let rejectedPromotion = false;
    const session = trace.kind === "promotion_failure"
      ? new Proxy(rawSession, {
          get(target, property) {
            if (property === "appendTransaction") {
              return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                if (
                  !rejectedPromotion &&
                  input.events.some((event) => event.eventType === "provider.step.completed")
                ) {
                  rejectedPromotion = true;
                  throw new Error("Generated promotion failure");
                }
                return target.appendTransaction(input);
              };
            }
            const member = Reflect.get(target, property) as unknown;
            return typeof member === "function" ? member.bind(target) : member;
          },
        }) as SessionClient
      : rawSession;
    const configuration = scenarioFor(trace);
    const provider = new FakeProviderAdapter({ controller: new FakeProviderController() });
    const controller = provider.controller;
    const executions: string[] = [];
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });

    if (
      trace.kind === "approval" &&
      trace.action === "approved" &&
      trace.reconstructAfterApproval
    ) {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releaseBlocker = release;
      blocker = scheduler.withToolPermit(undefined, async () => gate);
    }

    const createActor = async (
      actorSession: SessionClient,
      prefix: string,
    ): Promise<{ actor: SessionActor; monitor: EventMonitor }> => {
      const ids = generatedIds(prefix);
      let now = 2_000;
      const loop = new AgentRunLoop({
        storage: actorSession,
        provider,
        registry: createBuiltinToolRegistry(),
        executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
        ids: ids.loop,
      });
      const monitor = new EventMonitor();
      const hub = new CommittedEventHub();
      hub.subscribe(actorSession.sessionId, monitor.record);
      const actor = await SessionActor.create({
        storage: actorSession,
        eventHub: hub,
        scheduler,
        ids: ids.actor,
        now: () => ++now,
        runTask: loop.task,
        cancelRunTask: loop.cancel,
        forceStopRunTask: () => ({ status: "terminated" }),
        createRunProviderSnapshot: () => ({
          providerId: "fake",
          providerConfig: { scenario: configuration.scenario },
        }),
        runTaskOwnsSchedulerPermits: true,
        resumeRestoredRuns: true,
      });
      actors.push(actor);
      return { actor, monitor };
    };

    let activeSession = session;
    let active = await createActor(activeSession, `propertyAgent${number}`);
    const submitted = await active.actor.submitMessage({
      v: 1,
      kind: "command",
      commandId: `cmd_propertyAgentSubmit${number}`,
      sessionId: activeSession.sessionId,
      method: "message.submit",
      params: { text: "Generated Milestone 4 trace" },
    });

    if (trace.kind === "partial_stream") {
      const label = fakeProviderGateLabel(submitted.runId, "partial");
      await controller.waitUntilBlocked(label);
      if (trace.cancel) {
        await active.actor.cancelRun({
          v: 1,
          kind: "command",
          commandId: `cmd_propertyAgentCancel${number}`,
          sessionId: activeSession.sessionId,
          method: "run.cancel",
          params: { runId: submitted.runId },
        });
      } else {
        controller.release(label);
      }
    } else if (trace.kind === "approval") {
      await active.monitor.waitFor(
        (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
      );
      const [approval] = await activeSession.getPendingApprovals();
      if (approval === undefined) throw new Error("Generated approval disappeared");
      if (trace.action === "cancelled") {
        await active.actor.cancelRun({
          v: 1,
          kind: "command",
          commandId: `cmd_propertyApprovalCancel${number}`,
          sessionId: activeSession.sessionId,
          method: "run.cancel",
          params: { runId: submitted.runId },
        });
      } else {
        await active.actor.resolveApproval(
          {
            v: 1,
            kind: "command",
            commandId: `cmd_propertyApprovalResolve${number}`,
            sessionId: activeSession.sessionId,
            method: "approval.resolve",
            params: { approvalId: approval.approvalId, resolution: trace.action },
          },
          "client_property",
        );
        if (trace.reconstructAfterApproval && trace.action === "approved") {
          await active.actor.handoff();
          activeSession = await manager.openSession(activeSession.sessionId);
          active = await createActor(activeSession, `propertyAgentReplacement${number}`);
          releaseBlocker?.();
          if (blocker !== null) await blocker;
        }
      }
    }

    await active.monitor.waitFor(terminalFor(submitted.runId));
    const run = await activeSession.getRun(submitted.runId);
    if (run === null) throw new Error("Generated run disappeared");

    if (trace.kind === "cross_step_duplicate") {
      expect(run.state).toBe("completed");
      expect(executions).toEqual(["call_laterStepDuplicate"]);
      expect(provider.requests).toHaveLength(3);
    } else if (trace.kind === "partial_stream") {
      expect(run.state).toBe(trace.cancel ? "cancelled" : "interrupted");
      expect(executions).toEqual([]);
      await expect(activeSession.getToolExecution("call_partialWithoutTerminal")).resolves
        .toMatchObject({ state: "discarded", attemptCount: 0 });
    } else if (trace.kind === "approval") {
      expect(run.state).toBe(trace.action === "cancelled" ? "cancelled" : "completed");
      expect(executions).toHaveLength(trace.action === "approved" ? 1 : 0);
    } else if (trace.kind === "retry") {
      expect(run.state).toBe("completed");
      expect(provider.requests).toHaveLength(2);
    } else {
      expect(rejectedPromotion).toBe(true);
      expect(run).toMatchObject({ state: "failed", failureCategory: "provider.protocol_error" });
      expect(executions).toEqual([]);
    }
  } finally {
    releaseBlocker?.();
    if (blocker !== null) await blocker.catch(() => undefined);
    await Promise.allSettled(actors.map((actor) => actor.shutdown()));
    await manager.close().catch(() => undefined);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

describe("Milestone 4 generated production traces", () => {
  it(
    "matches the reference outcome across provider, ledger, approval, cancel, commit, and recovery traces",
    async () => {
      try {
        await fc.assert(fc.asyncProperty(generatedTrace, runTrace), {
          numRuns: 30,
          seed: propertySeed,
          ...(propertyPath === undefined ? {} : { path: propertyPath }),
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `Reproduce with: WI_M4_AGENT_FC_SEED=${propertySeed} ` +
            "WI_M4_AGENT_FC_PATH=<path> pnpm test:property -- milestone4-agent-loop-model",
          { cause: error },
        );
      }
    },
    30_000,
  );
});
