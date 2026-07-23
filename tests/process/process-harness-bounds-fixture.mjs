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
} else if (mode === "ipc-payloads") {
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let index = 0; index < messageCount; index += 1) {
    await send({ type: "aggregate-noise", index, payload: "a".repeat(12 * 1024) });
  }
  for (let index = 0; index < 31; index += 1) {
    await send({ type: "escaped-noise", index, payload: "\0".repeat(8 * 1024) });
  }
  let deep = { value: "leaf" };
  for (let depth = 0; depth < 80; depth += 1) deep = { child: deep };
  await send({ type: "deep-noise", deep });
  await send({
    type: "node-heavy-noise",
    values: Array.from({ length: 5_000 }, (_, index) => index),
  });
  await send({
    type: "key-heavy-noise",
    ...Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${String(index)}`, index])),
  });
  await send({ type: "nested-string-noise", nested: { value: "n".repeat(16 * 1024 + 1) } });
  await send({
    type: "oversized-noise",
    payload: `${"x".repeat(outputBytes)}OVERSIZED-TERMINAL-MARKER`,
  });
  await send({ type: "encoded-byte-noise", payload: "\0".repeat(16 * 1024) });
  await send({ type: 42, payload: "invalid type" });
  await send({ type: "t".repeat(129), payload: "overlong type" });
  await send({ type: "control-ready", descendantPid: descendant.pid, value: "small" });
} else if (mode === "ipc-alias") {
  await send({
    type: "alias-ready",
    descendantPid: descendant.pid,
    nested: { value: "small", values: ["first", { value: "second" }] },
  });
  await send({ type: "alias-too-large", payload: "x".repeat(32 * 1024) });
} else if (mode === "ipc-controls") {
  await send({ type: "control-fixture-ready", descendantPid: descendant.pid });
  let receivedControls = 0;
  process.on("message", (message) => {
    if (message === "shutdown") {
      receivedControls += 1;
      void send({ type: "string-control-received" });
    } else if (message?.type === "small-control") {
      receivedControls += 1;
      void send({ type: "object-control-received" });
    } else if (message?.type === "stateful-proxy-control") {
      receivedControls += 1;
      void send({
        type: "dynamic-control-received",
        bytes: Buffer.byteLength(JSON.stringify(message)),
        value: message.value,
      });
    } else if (message?.type === "stateful-array-control") {
      receivedControls += 1;
      void send({
        type: "array-control-received",
        bytes: Buffer.byteLength(JSON.stringify(message)),
        value: message.value,
      });
    } else if (message?.type === "non-finite-control") {
      receivedControls += 1;
      void send({ type: "non-finite-control-received", value: message.value });
    } else if (message?.type === "report-control-count") {
      void send({ type: "control-count", receivedControls });
    }
  });
} else {
  throw new Error(`Unknown fixture mode: ${String(mode)}`);
}

setInterval(() => {}, 1_000);
