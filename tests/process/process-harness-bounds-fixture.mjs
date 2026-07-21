import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { setInterval, setTimeout } from "node:timers";

const mode = process.argv[2];
const outputBytes = Number.parseInt(process.argv[3] ?? "0", 10);
const messageCount = Number.parseInt(process.argv[4] ?? "0", 10);

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
  stdio: "ignore",
});

function write(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function send(message) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function") {
      reject(new Error("IPC is unavailable"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

await write(process.stdout, Buffer.alloc(outputBytes, "o"));
await write(process.stderr, Buffer.alloc(outputBytes, "e"));

if (mode === "fixture-runner") {
  await write(process.stdout, "READY-");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await write(process.stdout, `MARKER\nstdout-tail descendant=${String(descendant.pid)}\n`);
  await write(process.stderr, "stderr-tail retained diagnostic\n");
} else if (mode === "real-server") {
  for (let index = 0; index < messageCount; index += 1) {
    await send({ type: "noise", index });
  }
  await send({ type: "ready", descendantPid: descendant.pid });
  await write(process.stdout, "stdout-tail retained diagnostic\n");
  await write(process.stderr, "stderr-tail retained diagnostic\n");
} else {
  throw new Error(`Unknown fixture mode: ${String(mode)}`);
}

setInterval(() => {}, 1_000);
