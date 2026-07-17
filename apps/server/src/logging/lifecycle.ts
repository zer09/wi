import { nonThrowingLogger, type Logger } from "./logger.js";

export type FatalServerLifecycleEvent = "server_start_failed" | "server_shutdown_failed";

export function logFatalServerLifecycleFailure(
  logger: Logger,
  event: FatalServerLifecycleEvent,
  error: unknown,
  diagnosticId: () => string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  nonThrowingLogger(logger).error(event, error, {
    ...fields,
    diagnosticId: diagnosticId(),
  });
}
