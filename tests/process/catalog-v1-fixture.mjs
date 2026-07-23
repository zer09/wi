import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

import { CatalogClient } from "@wi/storage";

import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";

const [homeDirectory, mode = "retained-v1"] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);
if (
  mode !== "retained-v1" &&
  mode !== "corrupt-with-sidecars" &&
  mode !== "valid-with-sidecars"
) process.exit(65);

if (mode === "valid-with-sidecars") {
  const sourceHome = join(homeDirectory, "valid-catalog-source");
  await mkdir(sourceHome);
  const catalog = new CatalogClient({ homeDirectory: sourceHome, allowRepair: true });
  await catalog.getStartupState();
  await catalog.completeRepair();
  await catalog.close();

  const sourcePath = join(sourceHome, "catalog.sqlite3");
  const catalogPath = join(homeDirectory, "catalog.sqlite3");
  const database = new Database(sourcePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    database
      .prepare(
        `INSERT INTO projects (
           project_id, name, root_path, root_realpath, created_at_ms, updated_at_ms, config_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "project_catalogSidecarFixture",
        "Catalog sidecar fixture",
        "/tmp/catalog-sidecar-fixture",
        "/tmp/catalog-sidecar-fixture",
        1_000,
        1_000,
        "{}",
      );
    for (const suffix of ["", "-wal", "-shm"]) {
      await copyFile(`${sourcePath}${suffix}`, `${catalogPath}${suffix}`);
    }
  } finally {
    database.close();
  }
} else if (mode === "corrupt-with-sidecars") {
  const sourcePath = join(homeDirectory, "catalog-sidecar-source.sqlite3");
  const catalogPath = join(homeDirectory, "catalog.sqlite3");
  const database = new Database(sourcePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    database.exec(
      "CREATE TABLE catalog_meta (key TEXT PRIMARY KEY); INSERT INTO catalog_meta VALUES ('malformed');",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await copyFile(`${sourcePath}${suffix}`, `${catalogPath}${suffix}`);
    }
    await writeFile(catalogPath, "not a sqlite database");
  } finally {
    database.close();
  }
} else {
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
}
