import type { ServerMessage } from "@wi/protocol";

type ProtocolErrorMessage = Extract<ServerMessage, { readonly kind: "protocol.error" }>;

export type ReplayRecoveryAction = "none" | "reset" | "retry";

export function replayRecoveryAction(message: ProtocolErrorMessage): ReplayRecoveryAction {
  if (!message.recoverable || message.sessionId === undefined) return "none";
  switch (message.code) {
    case "replay.cursor_ahead":
      return "reset";
    case "replay.disconnected":
    case "replay.query_failed":
    case "replay.sequence_gap":
    case "replay.subscriber_overflow":
      return "retry";
    default:
      return "none";
  }
}
