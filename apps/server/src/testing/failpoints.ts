import type { Logger } from "../logging/logger.js";

export const TEST_FAILPOINTS = [
  "after_command_event_insert_before_commit",
  "after_command_commit_before_ack",
  "after_event_commit_before_publish",
  "after_tool_requested_commit",
  "after_tool_started_commit",
  "after_tool_result_commit_before_provider_continue",
  "after_provider_text_commit",
  "after_run_terminal_commit",
  "after_session_create_before_catalog_ready",
  "after_catalog_session_repair",
  "after_catalog_replacement_before_repair",
] as const;

export type TestFailpointName = (typeof TEST_FAILPOINTS)[number];

export interface TestFailpointController {
  readonly name: TestFailpointName;
  readonly exitCode: number;
  is(name: TestFailpointName): boolean;
  hit(name: TestFailpointName, fields?: Readonly<Record<string, unknown>>): void;
}

export function createTestFailpointController(
  environment: Readonly<Record<string, string | undefined>>,
  logger?: Logger,
): TestFailpointController | null {
  const configured = environment.WI_TEST_FAILPOINT;
  if (configured === undefined) return null;
  if (environment.NODE_ENV !== "test" || environment.WI_ALLOW_TEST_FAILPOINTS !== "1") {
    throw new Error(
      "WI_TEST_FAILPOINT requires NODE_ENV=test and WI_ALLOW_TEST_FAILPOINTS=1",
    );
  }
  const index = TEST_FAILPOINTS.indexOf(configured as TestFailpointName);
  if (index < 0) throw new Error(`Unknown test failpoint: ${configured}`);
  const name = TEST_FAILPOINTS[index] as TestFailpointName;
  const exitCode = 90 + index;
  let triggered = false;
  return {
    name,
    exitCode,
    is: (candidate) => candidate === name,
    hit: (candidate, fields = {}) => {
      if (candidate !== name || triggered) return;
      triggered = true;
      try {
        logger?.warn("test_failpoint_triggered", {
          testOnly: true,
          failpoint: name,
          exitCode,
          ...fields,
        });
      } finally {
        process.exit(exitCode);
      }
    },
  };
}
