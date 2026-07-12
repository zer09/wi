import { readFileSync } from "node:fs";

import type { Migration } from "../common/migrations.js";
import { CATALOG_SCHEMA_VERSION } from "../types.js";

export const catalogMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
  },
];

export { CATALOG_SCHEMA_VERSION };
