import { describe, expect, it } from "vitest";

import { StorageError } from "../common/worker-rpc.js";
import { safeCatalogStartupError } from "./startup-error.js";

describe("safeCatalogStartupError", () => {
  it("preserves classification while removing canonical and probe paths", () => {
    const source = "/private/wi-home/catalog.sqlite3";
    const probe = "/tmp/wi-catalog-probe-secret/catalog.sqlite3";
    const error = Object.assign(
      new Error(`EACCES: permission denied, copyfile '${source}' -> '${probe}'`),
      { code: "EACCES" },
    );

    const safe = safeCatalogStartupError(error);

    expect(safe).toMatchObject({
      code: "storage.operational",
      message: "Catalog storage is unavailable",
      retryable: true,
    });
    expect(safe.message).not.toContain(source);
    expect(safe.message).not.toContain(probe);
  });

  it("bounds unexpected startup errors without forwarding their message", () => {
    const safe = safeCatalogStartupError(
      new StorageError("storage.unexpected", "x".repeat(10_000)),
    );

    expect(safe).toMatchObject({
      code: "storage.unexpected",
      message: "Catalog startup failed",
      retryable: false,
    });
  });
});
