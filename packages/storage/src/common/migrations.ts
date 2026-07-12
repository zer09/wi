import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export function applyMigrations(
  database: Database.Database,
  migrations: readonly Migration[],
  targetVersion: number,
): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  if (currentVersion > targetVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${targetVersion}`,
    );
  }

  const pending = migrations.filter((migration) => migration.version > currentVersion);
  let expectedVersion = currentVersion + 1;
  for (const migration of pending) {
    if (migration.version !== expectedVersion) {
      throw new Error(`Missing migration ${expectedVersion}`);
    }
    expectedVersion += 1;
  }

  database.transaction(() => {
    for (const migration of pending) {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    }
  })();

  const finalVersion = database.pragma("user_version", { simple: true }) as number;
  if (finalVersion !== targetVersion) {
    throw new Error(`Database migrated to ${finalVersion}, expected ${targetVersion}`);
  }
}
