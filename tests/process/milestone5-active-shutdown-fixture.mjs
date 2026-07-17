import { setTimeout as delay } from "node:timers/promises";
import { WiRuntime, WiServer } from "../../apps/server/dist/index.js";
import {
  FakeProviderAdapter,
  fakeProviderGateLabel,
} from "../../packages/provider-fake/dist/index.js";
import { SessionStoreManager } from "../../packages/storage/dist/index.js";
import WebSocket from "ws";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);

const provider = new FakeProviderAdapter();
const runtime = new WiRuntime({
  homeDirectory,
  provider,
  providerConfiguration: { scenario: "provider-never-completes-until-aborted" },
});
const server = new WiServer({ runtime, port: 0 });
await server.start();

const bootstrap = await globalThis.fetch(`${server.origin}/bootstrap`);
const setCookie = bootstrap.headers.get("set-cookie");
if (setCookie === null) throw new Error("Bootstrap cookie is missing");
const socket = new WebSocket(`${server.origin.replace("http:", "ws:")}/ws`, "wi.v1", {
  origin: server.origin,
  headers: { Cookie: setCookie.split(";", 1)[0] },
});
const inbox = [];
const waiters = new Set();
socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  inbox.push(message);
  for (const wake of waiters) wake();
  waiters.clear();
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

async function take(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return inbox.splice(index, 1)[0];
    await Promise.race([
      new Promise((resolve) => waiters.add(resolve)),
      delay(Math.max(1, deadline - Date.now())),
    ]);
  }
  throw new Error(`Timed out waiting for server message: ${JSON.stringify(inbox)}`);
}

socket.send(JSON.stringify({ v: 1, kind: "hello", clientId: "client_processActive", resume: [] }));
await take((message) => message.kind === "welcome");
socket.send(
  JSON.stringify({
    v: 1,
    kind: "command",
    commandId: "cmd_processActiveCreate",
    method: "session.create",
    params: { title: "Process active shutdown" },
  }),
);
const created = await take(
  (message) => message.kind === "command.accepted" && message.commandId === "cmd_processActiveCreate",
);
if (typeof created.sessionId !== "string") throw new Error("Session creation returned no ID");
socket.send(
  JSON.stringify({
    v: 1,
    kind: "command",
    commandId: "cmd_processActiveSubmit",
    sessionId: created.sessionId,
    method: "message.submit",
    params: { text: "Remain active until SIGTERM." },
  }),
);
const submitted = await take(
  (message) => message.kind === "command.accepted" && message.commandId === "cmd_processActiveSubmit",
);
if (typeof submitted.runId !== "string") throw new Error("Message submission returned no run ID");
await provider.controller.waitUntilBlocked(fakeProviderGateLabel(submitted.runId, "never"));

let shuttingDown = false;
const timeout = globalThis.setTimeout(() => process.exit(70), 15_000);
process.once("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      const socketClosed = new Promise((resolve) => socket.once("close", resolve));
      await server.close();
      await Promise.race([socketClosed, delay(2_000)]);
      const inspector = new SessionStoreManager({ homeDirectory });
      await inspector.ready();
      const session = await inspector.openSession(created.sessionId);
      const run = await session.getRun(submitted.runId);
      await inspector.close();
      globalThis.clearTimeout(timeout);
      const summary = {
        fulfilled: true,
        address: server.address,
        socketClosed: socket.readyState === WebSocket.CLOSED,
        runState: run?.state ?? null,
      };
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      process.exitCode =
        summary.address === null &&
        summary.socketClosed &&
        summary.runState === "interrupted"
          ? 0
          : 7;
    } catch (error) {
      globalThis.clearTimeout(timeout);
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 8;
    }
  })();
});
process.stdout.write("active-run-blocked\n");
