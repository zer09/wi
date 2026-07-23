import { readFile, rm } from "node:fs/promises";
import { URL } from "node:url";

import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";
import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
} from "@wi/storage";

const [homeDirectory, mode] = process.argv.slice(2);
if (homeDirectory === undefined || mode === undefined) process.exit(64);

const sessionId = "ses_v1Populated";
const databasePath = resolveStoragePath(
  homeDirectory,
  sessionDatabaseRelativePath(sessionId),
);

if (mode === "inspect-readonly") {
  const database = new Database(databasePath, { readonly: true });
  try {
    const userVersion = database.pragma("user_version", { simple: true });
    const manifest = database
      .prepare("SELECT schema_version AS schemaVersion FROM manifest WHERE singleton = 1")
      .get();
    const provenance = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'creation_provenance'",
      )
      .get();
    process.exit(userVersion === 1 && manifest?.schemaVersion === 1 && provenance === undefined ? 0 : 92);
  } finally {
    database.close();
  }
}

if (mode === "inspect-conflict") {
  const database = new Database(databasePath, { readonly: true });
  try {
    const userVersion = database.pragma("user_version", { simple: true });
    const manifest = database
      .prepare("SELECT schema_version AS schemaVersion FROM manifest WHERE singleton = 1")
      .get();
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_call_occurrences'",
      )
      .get();
    const conflictingIndex = database
      .prepare(
        "SELECT tbl_name AS tableName FROM sqlite_master " +
          "WHERE type = 'index' AND name = 'tool_call_occurrences_call_idx'",
      )
      .get();
    const rolledBack =
      userVersion === 1 &&
      manifest?.schemaVersion === 1 &&
      table === undefined &&
      conflictingIndex?.tableName === "tool_executions";
    process.exit(rolledBack ? 0 : 91);
  } finally {
    database.close();
  }
}

// Use the normal manager only to create the catalog entry. The session database itself is
// replaced below with a database constructed directly from the retained v1 schema.
const storage = new SessionStoreManager({
  homeDirectory,
  now: () => 1_000,
  ids: {
    sessionId: () => sessionId,
    eventId: () => "evt_v1SessionCreated",
  },
  sessionWorkers: { size: 1, allowTestOperations: true },
});
try {
  await storage.createSession({
    v: 1,
    kind: "command",
    commandId: "cmd_v1SessionCreate",
    method: "session.create",
    params: { title: "Populated session v1" },
  });
} finally {
  await storage.close();
}

await rm(databasePath, { force: true });
await rm(`${databasePath}-wal`, { force: true });
await rm(`${databasePath}-shm`, { force: true });
const schemaV1 = await readFile(
  new URL("../../packages/storage/src/session/schema.sql", import.meta.url),
  "utf8",
);
const database = new Database(databasePath);
try {
  database.exec(schemaV1);
  database.pragma("user_version = 1");
  database
    .prepare(
      `INSERT INTO manifest (
         singleton, session_id, project_id, created_at_ms, schema_version,
         format_version, title, last_event_sequence
       ) VALUES (1, ?, NULL, 1000, 1, 1, 'Populated session v1', 4)`,
    )
    .run(sessionId);

  const insertEvent = database.prepare(
    `INSERT INTO events (
       event_id, event_type, event_version, created_at_ms, run_id, item_id, payload_json
     ) VALUES (?, ?, 1, ?, ?, NULL, ?)`,
  );
  insertEvent.run(
    "evt_v1SessionCreated",
    "session.created",
    1_000,
    null,
    JSON.stringify({ eventVersion: 1, title: "Populated session v1" }),
  );
  insertEvent.run(
    "evt_v1RunCreated",
    "run.created",
    2_000,
    "run_v1Populated",
    JSON.stringify({ eventVersion: 1, runId: "run_v1Populated" }),
  );
  insertEvent.run(
    "evt_v1StepCompleted",
    "provider.step.completed",
    2_001,
    "run_v1Populated",
    JSON.stringify({
      eventVersion: 1,
      runId: "run_v1Populated",
      stepId: "step_v1Original",
    }),
  );
  insertEvent.run(
    "evt_v1ToolCompleted",
    "tool.execution.completed",
    2_002,
    "run_v1Populated",
    JSON.stringify({
      eventVersion: 1,
      runId: "run_v1Populated",
      callId: "call_v1Existing",
      result: { text: "retained" },
    }),
  );

  database
    .prepare(
      `INSERT INTO runs (
         run_id, state, provider_id, provider_config_json, created_at_ms,
         started_at_ms, completed_at_ms, cancelled_at_ms, failure_category,
         failure_message, active_provider_step_id
       ) VALUES (?, 'completed', 'fake', ?, 2000, 2000, 2002, NULL, NULL, NULL, NULL)`,
    )
    .run("run_v1Populated", JSON.stringify({ scenario: "plain-text" }));
  database
    .prepare(
      `INSERT INTO provider_steps (
         step_id, run_id, step_index, state, started_at_ms, completed_at_ms,
         response_id, error_category, error_message
       ) VALUES (?, ?, 0, 'completed', 2000, 2001, ?, NULL, NULL)`,
    )
    .run("step_v1Original", "run_v1Populated", "response_v1Original");
  database
    .prepare(
      `INSERT INTO tool_executions (
         call_id, run_id, step_id, tool_name, arguments_json, arguments_hash,
         effect_class, state, attempt_count, requested_at_ms, started_at_ms,
         completed_at_ms, result_json, error_json
       ) VALUES (?, ?, ?, 'echo', ?, ?, 'pure', 'completed', 1, 2001, 2001, 2002, ?, NULL)`,
    )
    .run(
      "call_v1Existing",
      "run_v1Populated",
      "step_v1Original",
      JSON.stringify({ text: "retained" }),
      "a".repeat(64),
      JSON.stringify({ text: "retained" }),
    );

  if (mode === "conflict") {
    // Migration v2 creates its table first, then collides with this retained index name.
    // Transactional rollback must remove that newly created table.
    database.exec(
      "CREATE INDEX tool_call_occurrences_call_idx ON tool_executions(call_id)",
    );
  } else if (mode !== "valid") {
    process.exit(65);
  }
} finally {
  database.close();
}
