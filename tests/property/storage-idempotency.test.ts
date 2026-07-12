import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SessionStoreManager } from "@wi/storage";

const propertySeed = Number.parseInt(process.env.WI_FC_SEED ?? "424242", 10);
const propertyPath = process.env.WI_FC_PATH;
const propertyOptions = {
  numRuns: 20,
  seed: propertySeed,
  ...(propertyPath === undefined ? {} : { path: propertyPath }),
} as const;
const operation = fc.record({
  slot: fc.integer({ min: 0, max: 3 }),
  variant: fc.integer({ min: 0, max: 2 }),
});

interface CommandOperation {
  readonly slot: number;
  readonly variant: number;
}

function sequenceId(prefix: "ses" | "evt"): () => string {
  let next = 1;
  return () => `${prefix}_property${next++}`;
}

function sessionCommandInput(slot: number, variant: number) {
  const hashCharacter = ["a", "b", "c"][variant];
  if (hashCharacter === undefined) throw new Error("Generated an unsupported command variant");
  return {
    commandId: `cmd_propertySession${slot}`,
    commandMethod: "message.submit" as const,
    payloadHash: hashCharacter.repeat(64),
    result: { slot, variant },
    acceptedAtMs: 2_000 + variant,
    runId: null,
    transaction: {
      events: [
        {
          eventId: `evt_propertySession${slot}Variant${variant}`,
          eventType: "run.created" as const,
          createdAtMs: 2_000 + variant,
          data: {
            eventVersion: 1 as const,
            runId: `run_propertySession${slot}Variant${variant}`,
          },
        },
      ],
      projections: [],
    },
  };
}

function globalCommand(slot: number, variant: number) {
  return {
    v: 1 as const,
    kind: "command" as const,
    commandId: `cmd_propertyGlobal${slot}`,
    method: "session.create" as const,
    params: { title: `Global ${slot} variant ${variant}` },
  };
}

async function checkStorageModel(
  sessionOperations: readonly CommandOperation[],
  globalOperations: readonly CommandOperation[],
): Promise<void> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-property-"));
  const storage = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: {
      sessionId: sequenceId("ses"),
      eventId: sequenceId("evt"),
    },
    sessionWorkers: { size: 1, maxOpenHandlesPerWorker: 4 },
  });

  try {
    const base = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_propertyBase",
      method: "session.create",
      params: { title: "Property base" },
    });
    const sessionModel = new Map<
      number,
      { variant: number; acceptedSequence: number; result: unknown }
    >();
    let expectedHead = 1;

    for (const item of sessionOperations) {
      const input = sessionCommandInput(item.slot, item.variant);
      const existing = sessionModel.get(item.slot);
      if (existing === undefined) {
        expectedHead += 1;
        const accepted = await storage.acceptCommand(base.session.sessionId, input);
        expect(accepted).toMatchObject({
          duplicate: false,
          acceptedSequence: expectedHead,
          result: input.result,
        });
        sessionModel.set(item.slot, {
          variant: item.variant,
          acceptedSequence: expectedHead,
          result: input.result,
        });
      } else if (existing.variant === item.variant) {
        const duplicate = await storage.acceptCommand(base.session.sessionId, input);
        expect(duplicate).toMatchObject({
          duplicate: true,
          acceptedSequence: existing.acceptedSequence,
          result: existing.result,
        });
        expect(duplicate.events).toEqual([]);
      } else {
        await expect(storage.acceptCommand(base.session.sessionId, input)).rejects.toMatchObject({
          code: "protocol.command_id_conflict",
        });
      }
    }

    const events = await (await storage.openSession(base.session.sessionId)).getEventsAfter(0);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: expectedHead }, (_, index) => index + 1),
    );

    const globalModel = new Map<number, { variant: number; sessionId: string }>();
    for (const item of globalOperations) {
      const command = globalCommand(item.slot, item.variant);
      const existing = globalModel.get(item.slot);
      if (existing === undefined) {
        const created = await storage.createSession(command);
        expect(created.duplicate).toBe(false);
        globalModel.set(item.slot, {
          variant: item.variant,
          sessionId: created.session.sessionId,
        });
      } else if (existing.variant === item.variant) {
        const duplicate = await storage.createSession(command);
        expect(duplicate).toMatchObject({
          duplicate: true,
          session: { sessionId: existing.sessionId },
        });
        expect(duplicate.events).toEqual([]);
      } else {
        await expect(storage.createSession(command)).rejects.toMatchObject({
          code: "protocol.command_id_conflict",
        });
      }
    }

    expect(await storage.catalog.listSessions()).toHaveLength(1 + globalModel.size);
    await expect(storage.catalog.getSession(base.session.sessionId)).resolves.toMatchObject({
      lastEventSequence: expectedHead,
    });
  } finally {
    await Promise.allSettled([storage.close()]);
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function assertStorageProperty(): Promise<void> {
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operation, { minLength: 1, maxLength: 12 }),
        fc.array(operation, { minLength: 1, maxLength: 12 }),
        checkStorageModel,
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

describe("storage command idempotency properties", () => {
  it(
    "matches a model for arbitrary duplicate and conflicting command sequences",
    assertStorageProperty,
    60_000,
  );
});
