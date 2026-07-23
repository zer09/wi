import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@wi/protocol";
import { SessionStoreManager } from "@wi/storage";
import { sessionWorkerPoolForTest } from "../../packages/storage/dist/testing.js";

const propertySeed = Number.parseInt(process.env.WI_FC_SEED ?? "515151", 10);
const propertyPath = process.env.WI_FC_PATH;
const propertyOptions = {
  numRuns: 15,
  seed: propertySeed,
  ...(propertyPath === undefined ? {} : { path: propertyPath }),
} as const;

const eventStoreOperation = fc.oneof(
  fc.constant({ kind: "append" } as const),
  fc.constant({ kind: "lagAppend" } as const),
  fc.record({
    kind: fc.constant("read" as const),
    afterSequence: fc.integer({ min: 0, max: 12 }),
    width: fc.integer({ min: 0, max: 12 }),
  }),
  fc.constant({ kind: "restart" } as const),
  fc.constant({ kind: "reconcile" } as const),
  fc.constant({ kind: "rollback" } as const),
);

type EventStoreOperation =
  | { readonly kind: "append" | "lagAppend" | "restart" | "reconcile" | "rollback" }
  | { readonly kind: "read"; readonly afterSequence: number; readonly width: number };

function runAppend(eventNumber: number) {
  const runId = `run_propertyEvent${eventNumber}`;
  return {
    events: [
      {
        eventId: `evt_propertyEvent${eventNumber}`,
        eventType: "run.created" as const,
        createdAtMs: 2_000 + eventNumber,
        data: { eventVersion: 1 as const, runId },
      },
    ],
    projections: [
      {
        kind: "run.put" as const,
        runId,
        state: "created" as const,
        providerId: "fake",
        providerConfig: { scenario: "property" },
        createdAtMs: 2_000 + eventNumber,
        startedAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: null,
      },
    ],
  };
}

async function checkEventStoreModel(operations: readonly EventStoreOperation[]): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-event-store-property-"));
  let allowCatalogProjection = true;
  let eventNumber = 1;

  const openManager = (): SessionStoreManager =>
    new SessionStoreManager({
      homeDirectory,
      now: () => 1_000,
      ids: {
        sessionId: () => "ses_propertyEventStore",
        eventId: () => "evt_propertyEventStoreCreated",
      },
      sessionWorkers: {
        size: 1,
        maxOpenHandlesPerWorker: 2,
        allowTestOperations: true,
      },
      catalogProjectionWriter: async (catalog, update) => {
        if (!allowCatalogProjection) throw new Error("injected catalog lag");
        await catalog.updateSessionProjection(update);
      },
    });

  let storage = openManager();
  try {
    const created = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_propertyEventStoreCreate",
      method: "session.create",
      params: { title: "Event-store property" },
    });
    const sessionId = created.session.sessionId;
    const model: SessionEvent[] = [...created.events];

    for (const operation of operations) {
      switch (operation.kind) {
        case "append":
        case "lagAppend": {
          allowCatalogProjection = operation.kind !== "lagAppend";
          try {
            const result = await storage.appendTransaction(sessionId, runAppend(eventNumber));
            expect(result.headSequence).toBe(model.length + 1);
            expect(result.events).toHaveLength(1);
            model.push(...result.events);
            expect(result.catalogObservationScheduled).toBe(true);
            await storage.drainCatalogObservations();
            if (operation.kind === "lagAppend") {
              await expect(storage.catalog.getSession(sessionId)).resolves.not.toMatchObject({
                lastEventSequence: result.headSequence,
              });
            }
            eventNumber += 1;
          } finally {
            allowCatalogProjection = true;
          }
          break;
        }
        case "read": {
          const throughSequence = Math.max(
            operation.afterSequence,
            Math.min(model.length, operation.afterSequence + operation.width),
          );
          const actual = await (
            await storage.openSession(sessionId)
          ).getEventsAfter(operation.afterSequence, throughSequence);
          const expected = model.filter(
            (event) =>
              event.sequence > operation.afterSequence && event.sequence <= throughSequence,
          );
          expect(actual).toEqual(expected);
          break;
        }
        case "restart": {
          await storage.close();
          storage = openManager();
          await storage.ready();
          const actual = await (await storage.openSession(sessionId)).getEventsAfter(0);
          expect(actual).toEqual(model);
          break;
        }
        case "reconcile": {
          await expect(storage.reconciler.reconcileSession(sessionId)).resolves.toMatchObject({
            lastEventSequence: model.length,
            status: "ready",
          });
          break;
        }
        case "rollback": {
          const failedEventNumber = eventNumber;
          eventNumber += 1;
          await expect(
            storage.appendTransaction(sessionId, {
              events: runAppend(failedEventNumber).events,
              projections: [
                {
                  kind: "run.state",
                  runId: `run_missing${failedEventNumber}`,
                  expectedState: "created",
                  nextState: "running",
                  startedAtMs: 3_000 + failedEventNumber,
                  completedAtMs: null,
                  cancelledAtMs: null,
                  failureCategory: null,
                  failureMessage: null,
                  activeProviderStepId: null,
                },
              ],
            }),
          ).rejects.toMatchObject({ code: "session.not_found" });
          await expect((await storage.openSession(sessionId)).getHeadSequence()).resolves.toBe(
            model.length,
          );
          break;
        }
      }
    }

    const finalEvents = await (await storage.openSession(sessionId)).getEventsAfter(0);
    expect(finalEvents).toEqual(model);
    expect(finalEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: model.length }, (_, index) => index + 1),
    );
    await expect(storage.reconciler.reconcileSession(sessionId)).resolves.toMatchObject({
      lastEventSequence: model.length,
      status: "ready",
    });
    await expect(sessionWorkerPoolForTest(storage).testMutateEvent(sessionId, "update", 1)).rejects.toThrow(
      "session events are immutable",
    );
    await expect(sessionWorkerPoolForTest(storage).testMutateEvent(sessionId, "delete", 1)).rejects.toThrow(
      "session events are immutable",
    );
  } finally {
    await Promise.allSettled([storage.close()]);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function assertEventStoreProperty(): Promise<void> {
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(eventStoreOperation, { minLength: 1, maxLength: 10 }),
        checkEventStoreModel,
      ),
      propertyOptions,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const minimizedPath = /path: "([^"]*)"/i.exec(message)?.[1];
    const pathArgument = minimizedPath === undefined ? "" : ` WI_FC_PATH=${minimizedPath}`;
    throw new Error(
      `${message}\nReproduction command: WI_FC_SEED=${propertySeed}${pathArgument} pnpm test:property`,
      { cause: error },
    );
  }
}

describe("storage event-store properties", () => {
  it(
    "matches append, read, restart, rollback, lag, and reconciliation operations",
    assertEventStoreProperty,
    120_000,
  );
});
