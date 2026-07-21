import { fileURLToPath, URL } from "node:url";

import { spawnNodeProcessTree } from "@wi/test-support";

if (process.platform !== "linux" || typeof process.send !== "function") process.exit(64);

const descendantFixturePath = fileURLToPath(
  new URL("./process-harness-descendant-fixture.mjs", import.meta.url),
);
const child = await spawnNodeProcessTree(
  [descendantFixturePath, "leader-live"],
  { ipc: true },
);
const ready = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => {
    reject(new Error(`Nested fixture exited before readiness: code=${String(code)} signal=${String(signal)}`));
  });
  child.once("message", resolve);
});
if (
  ready === null ||
  typeof ready !== "object" ||
  !("pid" in ready) ||
  typeof ready.pid !== "number" ||
  !("descendantPid" in ready) ||
  typeof ready.descendantPid !== "number"
) {
  process.exit(65);
}
await new Promise((resolve, reject) => {
  process.send(
    {
      type: "ready",
      leaderPid: ready.pid,
      descendantPid: ready.descendantPid,
    },
    (error) => error === null ? resolve() : reject(error),
  );
});

// Deliberately bypass all harness cleanup. Closing the inherited owner pipe must
// make the nested supervisor reclaim the fixture group.
process.exit(0);
