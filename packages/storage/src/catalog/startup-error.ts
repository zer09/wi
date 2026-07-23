import { StorageError, toStorageError } from "../common/worker-rpc.js";

const SAFE_CATALOG_STARTUP_MESSAGES: Readonly<Record<string, string>> = {
  "storage.busy": "Catalog storage changed during startup",
  "storage.corrupt": "Catalog validation failed",
  "storage.disk_full": "Catalog storage has insufficient space",
  "storage.migration_failed": "Catalog migration failed",
  "storage.operational": "Catalog storage is unavailable",
};

export function safeCatalogStartupError(error: unknown): StorageError {
  const classified = toStorageError(
    error,
    "storage.migration_failed",
    "Catalog migration failed",
  );
  return new StorageError(
    classified.code,
    SAFE_CATALOG_STARTUP_MESSAGES[classified.code] ?? "Catalog startup failed",
    classified.retryable,
  );
}
