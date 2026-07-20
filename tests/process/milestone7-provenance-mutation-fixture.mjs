import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";

const [databasePath, mutation, value] = process.argv.slice(2);
if (databasePath === undefined || mutation === undefined || value === undefined) process.exit(64);

const database = new Database(databasePath);
try {
  switch (mutation) {
    case "result-session":
      database.prepare("UPDATE creation_provenance SET result_json = ? WHERE singleton = 1")
        .run(JSON.stringify({ sessionId: value }));
      break;
    case "payload-hash":
      database.prepare("UPDATE creation_provenance SET payload_hash = ? WHERE singleton = 1").run(value);
      break;
    case "event-id":
      database.prepare("UPDATE creation_provenance SET event_id = ? WHERE singleton = 1").run(value);
      break;
    case "accepted-at":
      database.prepare("UPDATE creation_provenance SET accepted_at_ms = ? WHERE singleton = 1")
        .run(Number(value));
      break;
    case "command-id":
      database.prepare("UPDATE creation_provenance SET command_id = ? WHERE singleton = 1").run(value);
      break;
    case "user-version":
      database.pragma(`user_version = ${Number(value)}`);
      break;
    case "read-user-version":
      process.stdout.write(`${String(database.pragma("user_version", { simple: true }))}\n`);
      break;
    case "catalog-session-stale":
      database.prepare(
        `UPDATE sessions SET
           project_id = NULL,
           db_relative_path = ?,
           title = 'Stale catalog title',
           status = 'missing',
           created_at_ms = 777,
           updated_at_ms = 777,
           last_event_sequence = 0,
           last_run_state = NULL,
           last_message_preview = NULL,
           requires_attention = 1,
           pending_approval_count = 4,
           pending_input_count = 5,
           session_schema_version = 1,
           recovery_candidate = 0
         WHERE session_id = ?`,
      ).run(`sessions/zz/${value}/session.sqlite3`, value);
      break;
    case "catalog-session-path":
      database.prepare("UPDATE sessions SET db_relative_path = ? WHERE session_id = ?")
        .run(`sessions/zz/${value}/session.sqlite3`, value);
      break;
    case "catalog-seed-maximum": {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) process.exit(66);
      const insert = database.prepare(
        `INSERT INTO sessions (
           session_id, project_id, db_relative_path, title, status,
           created_at_ms, updated_at_ms, last_event_sequence, last_run_state,
           last_message_preview, requires_attention, pending_approval_count,
           pending_input_count, session_schema_version, recovery_candidate,
           unavailable_reason
         ) VALUES (?, NULL, ?, '', 'ready', 1, 1, 0, NULL, NULL, 0, 0, 0, 4, 0, NULL)`,
      );
      database.transaction(() => {
        for (let index = 0; index < count; index += 1) {
          const unique = `a${String(index).padStart(5, "0")}`;
          const sessionId = `ses_${unique}${"x".repeat(120 - unique.length)}`;
          insert.run(sessionId, `sessions/a0/${sessionId}/session.sqlite3`);
        }
      })();
      break;
    }
    default:
      process.exit(65);
  }
} finally {
  database.close();
}
