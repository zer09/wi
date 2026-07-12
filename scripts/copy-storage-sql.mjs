import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const storage = resolve(import.meta.dirname, "../packages/storage");
for (const area of ["catalog", "session"]) {
  const source = resolve(storage, "src", area);
  const destination = resolve(storage, "dist", area);
  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(source).filter((name) => name.endsWith(".sql"))) {
    cpSync(resolve(source, file), resolve(destination, file));
  }
}
