import { describe, expect, it } from "vitest";
import { JsonLogger, type LogRecord } from "./logger.js";
import { logFatalServerLifecycleFailure } from "./lifecycle.js";

describe("fatal server lifecycle diagnostics", () => {
  it.each([
    ["server_start_failed", {}],
    ["server_shutdown_failed", { signal: "SIGTERM" }],
  ] as const)("correlates %s with a safe diagnostic ID", (event, fields) => {
    const records: LogRecord[] = [];
    const logger = new JsonLogger({
      now: () => 1_000,
      write: (record) => records.push(record),
    });

    logFatalServerLifecycleFailure(
      logger,
      event,
      new Error("Bearer opaque-lifecycle-secret"),
      () => "err_lifecycleFailure",
      fields,
    );

    expect(records).toEqual([
      expect.objectContaining({
        timestampMs: 1_000,
        level: "error",
        event,
        diagnosticId: "err_lifecycleFailure",
        ...fields,
        error: {
          type: "error",
          message: {
            sourceUnit: "utf16_code_units",
            sourceLength: expect.any(Number),
            sampledByteLength: expect.any(Number),
            sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            truncated: expect.any(Boolean),
          },
        },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("opaque-lifecycle-secret");
  });
});
