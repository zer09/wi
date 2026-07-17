import { canonicalJsonBytes, type CommandMessage } from "@wi/protocol";
import {
  SESSION_EVENT_PAGE_BOUNDS,
  WORKER_RPC_PAYLOAD_BOUNDS,
} from "@wi/storage";

/**
 * Leaves room for the largest bounded event identity/timestamp envelope and worker-RPC fields.
 * Variable command content is measured as complete canonical JSON, including escaping.
 */
export const DURABLE_EVENT_ENVELOPE_RESERVE_BYTES = 4 * 1_024;

// message.submit and input.respond each place their variable value in at most two RPC fields.
const MAXIMUM_STORAGE_RPC_PAYLOAD_COPIES = 2;
const STORAGE_RPC_DURABLE_PAYLOAD_CAPACITY = Math.floor(
  WORKER_RPC_PAYLOAD_BOUNDS.maximumUnits / MAXIMUM_STORAGE_RPC_PAYLOAD_COPIES,
);

export interface DurableCommandCapacities {
  readonly outboundSingleMessageBytes: number;
  readonly replayLiveSingleEventBytes: number;
  readonly replayPageSingleEventBytes: number;
}

export function maximumDurableCommandPayloadBytes(
  capacities: DurableCommandCapacities,
): number {
  const durableEventCapacity = Math.min(
    capacities.outboundSingleMessageBytes,
    capacities.replayLiveSingleEventBytes,
    capacities.replayPageSingleEventBytes,
    SESSION_EVENT_PAGE_BOUNDS.maximumSingleEventBytes,
    STORAGE_RPC_DURABLE_PAYLOAD_CAPACITY,
  );
  if (durableEventCapacity <= DURABLE_EVENT_ENVELOPE_RESERVE_BYTES) {
    throw new RangeError(
      "WebSocket durable event capacity must exceed the server-owned event envelope reserve",
    );
  }
  return durableEventCapacity - DURABLE_EVENT_ENVELOPE_RESERVE_BYTES;
}

export function durableCommandPayloadBytes(command: CommandMessage): number {
  switch (command.method) {
    case "session.create":
      return canonicalJsonBytes(command.params.title ?? "").byteLength;
    case "message.submit":
      return canonicalJsonBytes(command.params.text).byteLength;
    case "input.respond":
      return canonicalJsonBytes(command.params.value).byteLength;
    case "run.cancel":
    case "approval.resolve":
      return 0;
  }
}
