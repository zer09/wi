import { spawn } from "node:child_process";

const [mode] = process.argv.slice(2);
if (
  mode !== "leader-live" &&
  mode !== "leader-exits" &&
  mode !== "leader-exits-empty"
) {
  process.exit(65);
}

if (mode === "leader-exits-empty") {
  const ready = { type: "ready", pid: process.pid };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  if (typeof process.send === "function") process.send(ready);
  globalThis.setTimeout(() => process.exit(0), 25);
} else {
  const descendant = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ],
    { stdio: "ignore" },
  );
  if (descendant.pid === undefined) process.exit(66);
  const ready = { type: "ready", pid: process.pid, descendantPid: descendant.pid };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  if (typeof process.send === "function") process.send(ready);

  if (mode === "leader-exits") process.exit(0);
  process.on("SIGTERM", () => {});
  globalThis.setInterval(() => {}, 1_000);
}
