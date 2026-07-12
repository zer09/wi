import { readFileSync } from "node:fs";

import type { Migration } from "../common/migrations.js";
import { CATALOG_SCHEMA_VERSION } from "../types.js";

export const catalogMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: readFileSync(new URL("./schema-v1.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    sql: `
      ALTER TABLE catalog_commands ADD COLUMN failure_code TEXT;
      ALTER TABLE catalog_commands ADD COLUMN failure_message TEXT;
      ALTER TABLE catalog_commands ADD COLUMN diagnostic_id TEXT;
      ALTER TABLE catalog_commands ADD COLUMN quarantined_relative_path TEXT;
    `,
  },
];

export { CATALOG_SCHEMA_VERSION };
