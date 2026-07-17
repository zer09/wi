import { clearTimeout, setTimeout } from "node:timers";
import { WiRuntime, WiServer } from "../../apps/server/dist/index.js";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);

const runtime = new WiRuntime({ homeDirectory });
const actualReady = runtime.ready.bind(runtime);
let releaseStartup = () => {};
const startupGate = new Promise((resolve) => {
  releaseStartup = resolve;
});
runtime.ready = async () => {
  process.stdout.write("startup-blocked\n");
  await startupGate;
  await actualReady();
};

const server = new WiServer({ runtime, port: 0 });
let starting = Promise.resolve();
let shuttingDown = false;
const timeout = setTimeout(() => process.exit(70), 10_000);

process.once("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const closing = server.close();
  releaseStartup();
  void Promise.allSettled([starting, closing]).then((results) => {
    clearTimeout(timeout);
    const fulfilled = results.every((result) => result.status === "fulfilled");
    const address = server.address;
    process.stdout.write(`${JSON.stringify({ fulfilled, address })}\n`);
    process.exitCode = fulfilled && address === null ? 0 : 7;
  });
});

starting = server.start();
