import { fileURLToPath, URL } from "node:url";

import { spawnNodeProcessTree } from "@wi/test-support";

if (process.platform !== "win32" || typeof process.send !== "function") process.exit(64);

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
  !("descendantPid" in ready) ||
  typeof ready.descendantPid !== "number" ||
  child.pid === undefined
) {
  process.exit(65);
}
await new Promise((resolve, reject) => {
  process.send(
    {
      type: "ready",
      leaderPid: child.pid,
      descendantPid: ready.descendantPid,
    },
    (error) => error === null ? resolve() : reject(error),
  );
});

// Deliberately bypass all harness cleanup. Windows must reclaim the nested job
// solely because the owner's last Job Object handle closes during process exit.
process.exit(0);
