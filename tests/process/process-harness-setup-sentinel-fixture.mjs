import { writeFile } from "node:fs/promises";

const [sentinelPath] = process.argv.slice(2);
if (sentinelPath === undefined) process.exit(64);
await writeFile(sentinelPath, "fixture-ran");
globalThis.setInterval(() => undefined, 1_000);
