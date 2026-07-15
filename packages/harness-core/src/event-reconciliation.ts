import { canonicalJson, type SessionEvent } from "@wi/protocol";
import type { AppendTransactionInput, AppendTransactionResult } from "@wi/storage";

export class EventReconciliationIntegrityError extends Error {
  readonly code = "storage.corrupt";

  constructor(message: string) {
    super(message);
    this.name = "EventReconciliationIntegrityError";
  }
}

export function reconcileCommittedEventBatch(
  sessionId: string,
  expectedEvents: AppendTransactionInput["events"],
  storedEvents: readonly (SessionEvent | null)[],
): AppendTransactionResult | null {
  if (expectedEvents.length === 0 || storedEvents.length !== expectedEvents.length) {
    throw new EventReconciliationIntegrityError("Ambiguous event batch has an invalid size");
  }

  const foundCount = storedEvents.filter((event) => event !== null).length;
  if (foundCount === 0) return null;
  if (foundCount !== expectedEvents.length) {
    throw new EventReconciliationIntegrityError(
      "Only part of an atomic event batch exists after an ambiguous write",
    );
  }

  const committed = storedEvents as readonly SessionEvent[];
  const firstSequence = committed[0]?.sequence;
  if (firstSequence === undefined) {
    throw new EventReconciliationIntegrityError("Ambiguous event batch has no first sequence");
  }

  for (let index = 0; index < expectedEvents.length; index += 1) {
    const expected = expectedEvents[index];
    const stored = committed[index];
    if (expected === undefined || stored === undefined) {
      throw new EventReconciliationIntegrityError("Ambiguous event batch changed size");
    }
    if (
      stored.sessionId !== sessionId ||
      stored.eventId !== expected.eventId ||
      stored.eventType !== expected.eventType ||
      stored.createdAtMs !== expected.createdAtMs ||
      canonicalJson(stored.data) !== canonicalJson(expected.data)
    ) {
      throw new EventReconciliationIntegrityError(
        `Stored event ${expected.eventId} does not match the attempted event`,
      );
    }
    if (stored.sequence !== firstSequence + index) {
      throw new EventReconciliationIntegrityError(
        "Ambiguous event batch is not contiguous in attempted order",
      );
    }
  }

  return {
    events: [...committed],
    headSequence: committed.at(-1)?.sequence ?? firstSequence,
  };
}
