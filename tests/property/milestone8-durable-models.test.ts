import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJsonHash, type SessionEvent } from "@wi/protocol";
import {
  SessionStoreManager,
  type AcceptCommandInput,
  type ProjectionMutation,
} from "@wi/storage";
import { recoverSession } from "../../packages/harness-core/src/recovery.js";
import {
  assertMilestone8Property,
  milestone8OperationCount,
  milestone8Path,
  milestone8Seed,
} from "./support/milestone8.js";

const PROPERTY_COUNT = 9;
const DURABLE_HISTORY_LENGTH = milestone8OperationCount;
const DURABLE_HISTORY_PARAMETERS: fc.Parameters<unknown> = {
  seed: milestone8Seed,
  numRuns: 1,
  ...(milestone8Path === undefined ? {} : { path: milestone8Path }),
};
const TEST_FILE = "tests/property/milestone8-durable-models.test.ts";
const COMMAND_TEST_NAME = "matches generated global and session command histories against durable SQLite";
const EVENT_STORE_TEST_NAME = "matches generated event-store histories against durable SQLite";
const TOOL_LEDGER_TEST_NAME = "matches generated tool-ledger histories against durable SQLite";

function sequenceId(prefix: "ses" | "evt"): () => string {
  let next = 1;
  return () => `${prefix}_m8Durable${next++}`;
}

const commandCase = fc.record({
  sameContent: fc.boolean(),
  delivery: fc.constantFrom("normal" as const, "lost_ack" as const, "reconnect" as const),
  tabCount: fc.integer({ min: 2, max: 4 }),
});

const eventStoreCase = fc.record({
  operation: fc.constantFrom(
    "append" as const,
    "catalog_lag" as const,
    "rollback" as const,
    "reconcile" as const,
    "equal_head_conflict" as const,
  ),
  readWidth: fc.integer({ min: 0, max: 8 }),
});

const toolCase = fc.record({
  effectClass: fc.constantFrom("pure" as const, "non_idempotent" as const),
  toolName: fc.constantFrom("echo", "calculator", "lookup"),
  value: fc.integer(),
});

function durableHistory<T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T[]> {
  const history = fc.array(arbitrary, {
    minLength: DURABLE_HISTORY_LENGTH,
    maxLength: DURABLE_HISTORY_LENGTH,
  });
  // One bounded shrink replay keeps artifact creation below the test timeout.
  return fc.limitShrink(history, 1);
}

function sessionCommand(caseNumber: number, variant: number): AcceptCommandInput {
  const hashCharacter = variant === 0 ? "a" : "b";
  return {
    commandId: `cmd_m8DurableSession${caseNumber}`,
    commandMethod: "message.submit",
    payloadHash: hashCharacter.repeat(64),
    result: { caseNumber, variant },
    acceptedAtMs: 10_000 + caseNumber,
    runId: null,
    transaction: {
      events: [
        {
          eventId: `evt_m8DurableCommand${caseNumber}Variant${variant}`,
          eventType: "run.created",
          createdAtMs: 10_000 + caseNumber,
          data: { eventVersion: 1, runId: `run_m8DurableCommand${caseNumber}Variant${variant}` },
        },
      ],
      projections: [],
    },
  };
}

type CommandCase = {
  readonly sameContent: boolean;
  readonly delivery: "normal" | "lost_ack" | "reconnect";
  readonly tabCount: number;
};

async function checkCommandHistory(
  operations: readonly CommandCase[],
  identify: (value: unknown) => void,
): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m8-command-core-"));
  const storage = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: { sessionId: sequenceId("ses"), eventId: sequenceId("evt") },
    sessionWorkers: { size: 1, maxOpenHandlesPerWorker: 4 },
  });
  let caseNumber = 0;
  let acceptedSessionCommands = 0;

  try {
    const base = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_m8DurableBase",
      method: "session.create",
      params: { title: "Milestone 8 durable command model" },
    });

    for (const operation of operations) {
      caseNumber += 1;
        const original = sessionCommand(caseNumber, 0);
        const retry = sessionCommand(caseNumber, operation.sameContent ? 0 : 1);
        identify({
          sessionId: base.session.sessionId,
          commands: [
            { commandId: original.commandId },
            { commandId: `cmd_m8DurableGlobal${caseNumber}` },
          ],
        });
        const sessionOutcomes = await Promise.all(
          Array.from({ length: operation.tabCount }, async (_value, tab) => {
            const input = tab === 0 ? original : retry;
            const client = operation.delivery === "reconnect"
              ? await storage.openSession(base.session.sessionId)
              : null;
            try {
              const value = client === null
                ? await storage.acceptCommand(base.session.sessionId, input)
                : await client.acceptCommand(input);
              return { status: "fulfilled" as const, input, value };
            } catch (error) {
              return { status: "rejected" as const, input, error };
            }
          }),
        );
        const acceptedOutcomes = sessionOutcomes.filter(
          (outcome) => outcome.status === "fulfilled" && !outcome.value.duplicate,
        );
        expect(acceptedOutcomes).toHaveLength(1);
        const acceptedOutcome = acceptedOutcomes[0];
        if (acceptedOutcome?.status !== "fulfilled") throw new Error("Generated command had no winner");
        const winner = acceptedOutcome.input;
        acceptedSessionCommands += 1;

        for (const outcome of sessionOutcomes) {
          if (outcome.input.payloadHash === winner.payloadHash) {
            expect(outcome.status).toBe("fulfilled");
            if (outcome.status === "fulfilled") {
              expect(outcome.value).toMatchObject({
                acceptedSequence: acceptedOutcome.value.acceptedSequence,
                result: winner.result,
              });
            }
          } else {
            expect(outcome.status).toBe("rejected");
            if (outcome.status === "rejected") {
              expect(outcome.error).toMatchObject({ code: "protocol.command_id_conflict" });
            }
          }
        }
        if (operation.delivery === "lost_ack") {
          await expect(storage.acceptCommand(base.session.sessionId, winner)).resolves.toMatchObject({
            duplicate: true,
            acceptedSequence: acceptedOutcome.value.acceptedSequence,
            result: winner.result,
            events: [],
          });
        }

        const storedSessionCommand = await (
          await storage.openSession(base.session.sessionId)
        ).getAcceptedCommand(original.commandId);
        expect(storedSessionCommand).toMatchObject({
          acceptedSequence: acceptedOutcome.value.acceptedSequence,
          payloadHash: winner.payloadHash,
          result: winner.result,
        });

        const commandId = `cmd_m8DurableGlobal${caseNumber}`;
        const originalHash = "c".repeat(64);
        const retryHash = (operation.sameContent ? "c" : "d").repeat(64);
        const reservation = {
          commandId,
          payloadHash: originalHash,
          reservedSessionId: `ses_m8DurableGlobal${caseNumber}`,
          reservedEventId: `evt_m8DurableGlobal${caseNumber}`,
          request: { title: `Global ${caseNumber}`, projectId: null },
          updatedAtMs: 20_000 + caseNumber,
        };
        const globalOutcomes = await Promise.all(
          Array.from({ length: operation.tabCount }, async (_value, tab) => {
            const input = tab === 0
              ? reservation
              : {
                  ...reservation,
                  payloadHash: retryHash,
                  request: {
                    ...reservation.request,
                    title: operation.sameContent
                      ? reservation.request.title
                      : `${reservation.request.title} changed`,
                  },
                };
            try {
              return {
                status: "fulfilled" as const,
                input,
                value: await storage.catalog.reserveGlobalCommand(input),
              };
            } catch (error) {
              return { status: "rejected" as const, input, error };
            }
          }),
        );
        const globalWinners = globalOutcomes.filter(
          (outcome) => outcome.status === "fulfilled" && !outcome.value.duplicate,
        );
        expect(globalWinners).toHaveLength(1);
        const globalWinner = globalWinners[0];
        if (globalWinner?.status !== "fulfilled") throw new Error("Generated global command had no winner");
        for (const outcome of globalOutcomes) {
          if (outcome.input.payloadHash === globalWinner.input.payloadHash) {
            expect(outcome.status).toBe("fulfilled");
          } else {
            expect(outcome.status).toBe("rejected");
            if (outcome.status === "rejected") {
              expect(outcome.error).toMatchObject({ code: "protocol.command_id_conflict" });
            }
          }
        }

        const completion = {
          commandId,
          payloadHash: globalWinner.input.payloadHash,
          result: { caseNumber },
          acceptedAtMs: 30_000 + caseNumber,
        };
        const completed = await Promise.all(
          Array.from(
            { length: operation.tabCount },
            () => storage.catalog.completeGlobalCommand(completion),
          ),
        );
        const accepted = completed[0];
        if (accepted === undefined) throw new Error("Generated global command did not complete");
      for (const item of completed) expect(item).toEqual(accepted);
      await expect(storage.catalog.getGlobalCommand(commandId)).resolves.toEqual(accepted);
    }

    await storage.drainCatalogObservations();
    const events = await (await storage.openSession(base.session.sessionId)).getEventsAfter(0);
    expect(events).toHaveLength(acceptedSessionCommands + 1);
  } finally {
    await storage.close().catch(() => undefined);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function runCommandIdempotencyModel(): Promise<void> {
  let lastIdentifiers: unknown;
  const property = fc.asyncProperty(durableHistory(commandCase), (operations) =>
    checkCommandHistory(operations, (value) => {
      lastIdentifiers = value;
    })
  );
  await assertMilestone8Property({
    suite: "durable command idempotency model",
    test: COMMAND_TEST_NAME,
    testFile: TEST_FILE,
    propertyCount: PROPERTY_COUNT,
    identifiers: () => lastIdentifiers,
    property,
    parameters: DURABLE_HISTORY_PARAMETERS,
  });
}

type EventStoreCase = {
  readonly operation: "append" | "catalog_lag" | "rollback" | "reconcile" | "equal_head_conflict";
  readonly readWidth: number;
};

async function checkEventStoreHistory(
  operations: readonly EventStoreCase[],
  identify: (value: unknown) => void,
): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m8-event-core-"));
  const laggedCatalogHeads = new Set<number>();
  let catalogLagFailures = 0;
  const storage = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: { sessionId: sequenceId("ses"), eventId: sequenceId("evt") },
    sessionWorkers: { size: 1, maxOpenHandlesPerWorker: 2, allowTestOperations: true },
    catalogProjectionWriter: async (catalog, update) => {
      if (laggedCatalogHeads.delete(update.lastEventSequence)) {
        catalogLagFailures += 1;
        throw new Error("generated catalog lag");
      }
      await catalog.updateSessionProjection(update);
    },
  });
  let caseNumber = 0;

  try {
    const created = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_m8DurableEventBase",
      method: "session.create",
      params: { title: "Milestone 8 durable event model" },
    });
    const sessionId = created.session.sessionId;
    expect(sessionId).toBe("ses_m8Durable1");
    const expectedEvents: SessionEvent[] = [
      {
        v: 1,
        kind: "event",
        sessionId,
        sequence: 1,
        eventId: "evt_m8Durable1",
        eventType: "session.created",
        createdAtMs: 1_000,
        data: { eventVersion: 1, title: "Milestone 8 durable event model" },
      },
    ];
    expect(created.events).toEqual(expectedEvents);

    for (const operation of operations) {
      caseNumber += 1;
      identify({
        sessionId,
        runId: `run_m8DurableEvent${caseNumber}`,
      });
      const session = await storage.openSession(sessionId);
      const beforeHead = await session.getHeadSequence();
      expect(beforeHead).toBe(expectedEvents.length);
      const lagFailuresBefore = catalogLagFailures;
      if (operation.operation === "catalog_lag") laggedCatalogHeads.add(expectedEvents.length + 1);
      const requestedEvent = {
        eventId: `evt_m8DurableEvent${caseNumber}`,
        eventType: "run.created" as const,
        createdAtMs: 40_000 + caseNumber,
        data: { eventVersion: 1 as const, runId: `run_m8DurableEvent${caseNumber}` },
      };
      const expectedEvent: SessionEvent = {
        v: 1,
        kind: "event",
        sessionId,
        sequence: expectedEvents.length + 1,
        ...requestedEvent,
      };
      const appended = await storage.appendTransaction(sessionId, {
          events: [requestedEvent],
          projections: [],
        });
        await storage.drainCatalogObservations();

      expect(appended.headSequence).toBe(expectedEvent.sequence);
      expect(appended.events).toEqual([expectedEvent]);
      expectedEvents.push(expectedEvent);
      await expect(session.getEventsAfter(beforeHead, expectedEvent.sequence)).resolves.toEqual([
        expectedEvent,
      ]);
      const suffixStart = Math.max(0, expectedEvent.sequence - operation.readWidth);
      const suffix = await session.getEventsAfter(suffixStart, expectedEvent.sequence);
      expect(suffix).toEqual(
        expectedEvents.filter((event) => event.sequence > suffixStart),
      );

        if (operation.operation === "catalog_lag") {
          expect(laggedCatalogHeads.has(appended.headSequence)).toBe(false);
          expect(catalogLagFailures).toBeGreaterThan(lagFailuresBefore);
        } else if (operation.operation === "rollback") {
          await expect(
            storage.appendTransaction(sessionId, {
              events: [
                {
                  eventId: `evt_m8DurableRollback${caseNumber}`,
                  eventType: "run.started",
                  createdAtMs: 50_000 + caseNumber,
                  data: { eventVersion: 1, runId: `run_m8Missing${caseNumber}` },
                },
              ],
              projections: [
                {
                  kind: "run.state",
                  runId: `run_m8Missing${caseNumber}`,
                  expectedState: "created",
                  nextState: "running",
                  startedAtMs: 50_000 + caseNumber,
                  completedAtMs: null,
                  cancelledAtMs: null,
                  failureCategory: null,
                  failureMessage: null,
                  activeProviderStepId: null,
                },
              ],
            }),
          ).rejects.toMatchObject({ code: "session.not_found" });
          await expect(session.getHeadSequence()).resolves.toBe(appended.headSequence);
        } else if (operation.operation === "reconcile") {
          await expect(storage.reconciler.reconcileSession(sessionId)).resolves.toMatchObject({
            lastEventSequence: expectedEvents.length,
            status: "ready",
          });
        } else if (operation.operation === "equal_head_conflict") {
          const before = await storage.catalog.getSession(sessionId);
          if (before === null) throw new Error("Generated catalog session disappeared");
          await expect(
            storage.catalog.updateSessionProjection({
              sessionId,
              updatedAtMs: before.updatedAtMs + 1,
              lastEventSequence: before.lastEventSequence,
              lastRunState: before.lastRunState,
              lastMessagePreview: before.lastMessagePreview,
              requiresAttention: before.requiresAttention,
              pendingApprovalCount: before.pendingApprovalCount,
              pendingInputCount: before.pendingInputCount,
              recoveryNeeded: before.recoveryCandidate,
            }),
          ).rejects.toMatchObject({ code: "storage.catalog_projection_conflict" });
          await expect(storage.catalog.getSession(sessionId)).resolves.toEqual(before);
        }
    }

    const completeReplay = await (await storage.openSession(sessionId)).getEventsAfter(0);
    expect(completeReplay).toEqual(expectedEvents);
    await expect(storage.reconciler.reconcileSession(sessionId)).resolves.toMatchObject({
      lastEventSequence: expectedEvents.length,
      status: "ready",
    });
  } finally {
    await storage.close().catch(() => undefined);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function runEventStoreModel(): Promise<void> {
  let lastIdentifiers: unknown;
  const property = fc.asyncProperty(durableHistory(eventStoreCase), (operations) =>
    checkEventStoreHistory(operations, (value) => {
      lastIdentifiers = value;
    })
  );
  await assertMilestone8Property({
    suite: "durable event-store model",
    test: EVENT_STORE_TEST_NAME,
    testFile: TEST_FILE,
    propertyCount: PROPERTY_COUNT,
    identifiers: () => lastIdentifiers,
    property,
    parameters: DURABLE_HISTORY_PARAMETERS,
  });
}

type ToolExecutionProjection = Extract<ProjectionMutation, { readonly kind: "toolExecution.put" }>;

function toolProjection(options: {
  readonly callId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly argumentsHash: string;
  readonly effectClass: "pure" | "non_idempotent";
  readonly state: "requested" | "started" | "completed" | "outcome_unknown";
  readonly expectedState?: "requested" | "started" | "completed" | "outcome_unknown";
  readonly requestedAtMs: number;
  readonly value: number;
}): ToolExecutionProjection {
  const started = options.state !== "requested";
  const terminal = options.state === "completed" || options.state === "outcome_unknown";
  return {
    kind: "toolExecution.put",
    ...(options.expectedState === undefined ? {} : { expectedState: options.expectedState }),
    callId: options.callId,
    runId: options.runId,
    stepId: options.stepId,
    toolName: options.toolName,
    argumentsJson: options.argumentsJson,
    argumentsHash: options.argumentsHash,
    effectClass: options.effectClass,
    state: options.state,
    attemptCount: started ? 1 : 0,
    requestedAtMs: options.requestedAtMs,
    startedAtMs: started ? options.requestedAtMs + 1 : null,
    completedAtMs: terminal ? options.requestedAtMs + 2 : null,
    result: options.state === "completed" ? { value: options.value } : null,
    error: options.state === "outcome_unknown"
      ? { code: "tool.outcome_unknown", message: "Generated non-idempotent outcome is unknown." }
      : null,
  };
}

type ToolCase = {
  readonly effectClass: "pure" | "non_idempotent";
  readonly toolName: string;
  readonly value: number;
};

async function checkToolLedgerHistory(
  operations: readonly ToolCase[],
  identify: (value: unknown) => void,
): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m8-tool-core-"));
  const storage = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: { sessionId: sequenceId("ses"), eventId: sequenceId("evt") },
    sessionWorkers: { size: 1, maxOpenHandlesPerWorker: 2 },
  });
  let caseNumber = 0;

  try {
    const created = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_m8DurableToolBase",
      method: "session.create",
      params: { title: "Milestone 8 durable tool model" },
    });
    const session = await storage.openSession(created.session.sessionId);

    for (const operation of operations) {
      caseNumber += 1;
        const runId = `run_m8DurableTool${caseNumber}`;
        const stepId = `step_m8DurableTool${caseNumber}`;
        const callId = `call_m8DurableTool${caseNumber}`;
        identify({
          sessionId: created.session.sessionId,
          runId,
          callId,
        });
        const requestedAtMs = 60_000 + caseNumber * 10;
        const argumentsValue = { value: operation.value };
        const argumentsJson = JSON.stringify(argumentsValue);
        const argumentsHash = await canonicalJsonHash(argumentsValue);
        const effectClass = operation.effectClass;
        const baseProjection = {
          callId,
          runId,
          stepId,
          toolName: operation.toolName,
          argumentsJson,
          argumentsHash,
          effectClass,
          requestedAtMs,
          value: operation.value,
        } as const;

        await session.appendTransaction({
          events: [
            {
              eventId: `evt_m8DurableTool${caseNumber}RunCreated`,
              eventType: "run.created",
              createdAtMs: requestedAtMs - 3,
              data: { eventVersion: 1, runId },
            },
            {
              eventId: `evt_m8DurableTool${caseNumber}RunStarted`,
              eventType: "run.started",
              createdAtMs: requestedAtMs - 2,
              data: { eventVersion: 1, runId },
            },
            {
              eventId: `evt_m8DurableTool${caseNumber}StepCompleted`,
              eventType: "provider.step.completed",
              createdAtMs: requestedAtMs - 1,
              data: { eventVersion: 1, runId, stepId },
            },
            {
              eventId: `evt_m8DurableTool${caseNumber}Requested`,
              eventType: "tool.call.requested",
              createdAtMs: requestedAtMs,
              data: {
                eventVersion: 1,
                runId,
                stepId,
                callId,
                name: operation.toolName,
                argumentsJson,
                argumentsHash,
                effectClass,
              },
            },
          ],
          projections: [
            {
              kind: "run.put",
              runId,
              state: "running",
              providerId: "fake",
              providerConfig: { scenario: "milestone8-durable-tool" },
              createdAtMs: requestedAtMs - 3,
              startedAtMs: requestedAtMs - 2,
              completedAtMs: null,
              cancelledAtMs: null,
              failureCategory: null,
              failureMessage: null,
              activeProviderStepId: null,
            },
            {
              kind: "providerStep.put",
              stepId,
              runId,
              stepIndex: 0,
              state: "completed",
              startedAtMs: requestedAtMs - 2,
              completedAtMs: requestedAtMs - 1,
              responseId: `response_m8DurableTool${caseNumber}`,
              errorCategory: null,
              errorMessage: null,
            },
            toolProjection({ ...baseProjection, state: "requested" }),
            {
              kind: "toolCallOccurrence.put",
              runId,
              stepId,
              callId,
              occurredAtMs: requestedAtMs,
            },
          ],
        });

        await session.appendTransaction({
          events: [
            {
              eventId: `evt_m8DurableTool${caseNumber}Started`,
              eventType: "tool.execution.started",
              createdAtMs: requestedAtMs + 1,
              data: { eventVersion: 1, runId, callId },
            },
          ],
          projections: [
            toolProjection({
              ...baseProjection,
              state: "started",
              expectedState: "requested",
            }),
          ],
        });

        let recoveryEvent = 0;
        const recovery = await recoverSession({
          sessionId: created.session.sessionId,
          storage: session,
          now: () => requestedAtMs + 2,
          eventId: () => `evt_m8DurableTool${caseNumber}Recovery${++recoveryEvent}`,
          diagnosticId: () => `err_m8DurableTool${caseNumber}Recovery`,
          publishCommitted: () => undefined,
          resumeToolLoop: true,
          currentToolEffectClass: (toolName) =>
            toolName === operation.toolName ? effectClass : null,
        });
        const expectedRecoveredState = effectClass === "pure" ? "requested" : "outcome_unknown";
        if (effectClass === "pure") {
          expect(recovery.preservedRunIds).toContain(runId);
          expect(recovery.interruptedRunIds).not.toContain(runId);
        } else {
          expect(recovery.interruptedRunIds).toContain(runId);
          expect(recovery.preservedRunIds).not.toContain(runId);
        }

        const stable = await session.getToolExecution(callId);
        if (stable === null) throw new Error("Recovered generated tool disappeared");
        expect(stable).toMatchObject({
          callId,
          toolName: operation.toolName,
          argumentsHash,
          effectClass,
          state: expectedRecoveredState,
          attemptCount: 1,
        });
        if (effectClass === "pure") {
          await session.appendTransaction({
            events: [
              {
                eventId: `evt_m8DurableTool${caseNumber}RunInterrupted`,
                eventType: "run.interrupted",
                createdAtMs: requestedAtMs + 3,
                data: {
                  eventVersion: 1,
                  runId,
                  code: "provider.incomplete",
                  message: "Generated recovered run settled after its recovery assertion.",
                  diagnosticId: `err_m8DurableTool${caseNumber}Settled`,
                },
              },
            ],
            projections: [
              {
                kind: "run.state",
                runId,
                expectedState: "running",
                nextState: "interrupted",
                startedAtMs: requestedAtMs - 2,
                completedAtMs: requestedAtMs + 3,
                cancelledAtMs: null,
                failureCategory: "provider.incomplete",
                failureMessage: "Generated recovered run settled after its recovery assertion.",
                activeProviderStepId: null,
              },
            ],
          });
        }
        const stableProjection: ToolExecutionProjection = {
          kind: "toolExecution.put",
          expectedState: stable.state,
          callId: stable.callId,
          runId: stable.runId,
          stepId: stable.stepId,
          toolName: stable.toolName,
          argumentsJson: stable.argumentsJson,
          argumentsHash: stable.argumentsHash,
          effectClass: stable.effectClass,
          state: stable.state,
          attemptCount: stable.attemptCount,
          requestedAtMs: stable.requestedAtMs,
          startedAtMs: stable.startedAtMs,
          completedAtMs: stable.completedAtMs,
          result: stable.result,
          error: stable.error,
        };

        const acceptedAtMs = requestedAtMs + 4;
        await expect(
          session.acceptCommand({
            commandId: `cmd_m8DurableTool${caseNumber}Repeat`,
            commandMethod: "message.submit",
            payloadHash: "e".repeat(64),
            result: { repeated: true },
            acceptedAtMs,
            runId,
            transaction: { events: [], projections: [stableProjection] },
          }),
        ).resolves.toMatchObject({ duplicate: false, events: [] });

        await expect(
          session.acceptCommand({
            commandId: `cmd_m8DurableTool${caseNumber}IdentityConflict`,
            commandMethod: "message.submit",
            payloadHash: "f".repeat(64),
            result: { changed: true },
            acceptedAtMs: acceptedAtMs + 1,
            runId,
            transaction: {
              events: [],
              projections: [
                {
                  ...stableProjection,
                  toolName: `${operation.toolName}_changed`,
                },
              ],
            },
          }),
        ).rejects.toMatchObject({ code: "provider.protocol_error" });

        await expect(
          session.acceptCommand({
            commandId: `cmd_m8DurableTool${caseNumber}Regression`,
            commandMethod: "message.submit",
            payloadHash: "0".repeat(64),
            result: { regressed: true },
            acceptedAtMs: acceptedAtMs + 2,
            runId,
            transaction: {
              events: [],
              projections: [
                toolProjection({
                  ...baseProjection,
                  state: effectClass === "pure" ? "completed" : "started",
                  expectedState: expectedRecoveredState,
                }),
              ],
            },
          }),
        ).rejects.toMatchObject({ code: "session.invalid_transition" });

      await expect(session.getToolExecution(callId)).resolves.toEqual(stable);
    }
  } finally {
    await storage.close().catch(() => undefined);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function runToolLedgerModel(): Promise<void> {
  let lastIdentifiers: unknown;
  const property = fc.asyncProperty(durableHistory(toolCase), (operations) =>
    checkToolLedgerHistory(operations, (value) => {
      lastIdentifiers = value;
    })
  );
  await assertMilestone8Property({
    suite: "durable tool-ledger model",
    test: TOOL_LEDGER_TEST_NAME,
    testFile: TEST_FILE,
    propertyCount: PROPERTY_COUNT,
    identifiers: () => lastIdentifiers,
    property,
    parameters: DURABLE_HISTORY_PARAMETERS,
  });
}

describe.concurrent("Milestone 8 durable production models", () => {
  it(COMMAND_TEST_NAME, runCommandIdempotencyModel, 120_000);
  it(EVENT_STORE_TEST_NAME, runEventStoreModel, 120_000);
  it(TOOL_LEDGER_TEST_NAME, runToolLedgerModel, 120_000);
});
