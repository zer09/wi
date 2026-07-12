import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const storage = resolve(import.meta.dirname, "../packages/storage");
for (const area of ["catalog", "session"]) {
  const destination = resolve(storage, "dist", area);
  mkdirSync(destination, { recursive: true });
  cpSync(resolve(storage, "src", area, "schema.sql"), resolve(destination, "schema.sql"));
}
