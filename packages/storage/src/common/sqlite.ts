import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export const MINIMUM_SQLITE_VERSION = "3.51.3";

function versionParts(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

export function sqliteVersionAtLeast(actual: string, minimum = MINIMUM_SQLITE_VERSION): boolean {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

export interface OpenWorkerDatabaseOptions {
  readonly fileMustExist?: boolean;
  readonly beforeConfigure?: () => void;
}

export function openWorkerDatabase(
  path: string,
  options: OpenWorkerDatabaseOptions = {},
): Database.Database {
  if (options.fileMustExist !== true) mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { fileMustExist: options.fileMustExist === true });
  try {
    // The constructor only acquires SQLite's handle. Catalog startup uses this
    // boundary to verify the selected pathname before recovery-capable PRAGMAs.
    options.beforeConfigure?.();
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("trusted_schema = OFF");

    const version = database.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    if (!sqliteVersionAtLeast(version.version)) {
      throw new Error(
        `SQLite ${version.version} is below required minimum ${MINIMUM_SQLITE_VERSION}`,
      );
    }
    return database;
  } catch (error) {
    if (database.open) database.close();
    throw error;
  }
}

export function closeWorkerDatabase(database: Database.Database): void {
  if (database.open) database.close();
}
