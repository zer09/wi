import type { ErrorCode } from "@wi/protocol";

export function safeRunFailureMessage(code: ErrorCode): string {
  if (code === "provider.transient_before_output") {
    return "The provider could not complete the request before producing output.";
  }
  if (code === "provider.transport_after_output") {
    return "The provider connection failed after output began.";
  }
  if (code === "provider.protocol_error") return "The provider returned an invalid response.";
  if (code === "provider.incomplete") return "The provider response ended before completion.";
  if (code === "provider.cancelled") return "The provider operation was cancelled.";
  if (code.startsWith("storage.")) return "A storage operation failed while processing the run.";
  if (code === "session.not_found") return "The requested run is unavailable.";
  if (code === "tool.outcome_unknown") return "A tool outcome could not be confirmed.";
  if (code.startsWith("tool.")) return "A tool operation failed.";
  return "The run could not be completed safely.";
}
