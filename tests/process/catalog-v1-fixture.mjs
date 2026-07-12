import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);

const database = new Database(join(homeDirectory, "catalog.sqlite3"));
try {
  const schema = await readFile(
    new URL("../../packages/storage/src/catalog/schema-v1.sql", import.meta.url),
    "utf8",
  );
  database.exec(schema);
  database.pragma("user_version = 1");
  database
    .prepare(
      `INSERT INTO catalog_commands (
         command_id, command_method, payload_hash, state, reserved_session_id,
         reserved_event_id, request_json, result_json, accepted_at_ms, updated_at_ms
       ) VALUES (?, 'session.create', ?, 'accepted', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "cmd_v1Migrated",
      "a".repeat(64),
      "ses_v1Migrated",
      "evt_v1Migrated",
      '{"projectId":null,"title":"Migrated"}',
      '{"sessionId":"ses_v1Migrated"}',
      1_000,
      1_000,
    );
} finally {
  database.close();
}
