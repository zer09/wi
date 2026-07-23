import { clearTimeout, setTimeout } from "node:timers";
import { WiRuntime, WiServer } from "../../apps/server/dist/index.js";

const [homeDirectory, mode = "storage-ready"] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);
if (
  mode !== "storage-ready" &&
  mode !== "candidate-pages" &&
  mode !== "candidate-page-blocked"
) {
  process.exit(65);
}

const runtime = new WiRuntime({ homeDirectory });
let releaseStartup = () => {};
const startupGate = new Promise((resolve) => {
  releaseStartup = resolve;
});
let pageCalls = 0;
let adoptedCandidates = 0;

if (mode === "storage-ready") {
  const actualStorageReady = runtime.storage.ready.bind(runtime.storage);
  runtime.storage.ready = async () => {
    await actualStorageReady();
    process.stdout.write("startup-blocked\n");
    await startupGate;
  };
} else {
  const firstPageIds = Array.from(
    { length: 1_000 },
    (_value, index) => `ses_startupCandidate${String(index).padStart(4, "0")}`,
  );
  const finalSessionId = "ses_startupCandidateFinal";
  const firstCursor = { updatedAtMs: 1, sessionId: "ses_startupCandidate0999" };
  runtime.storage.listRecoveryCandidatePage = async (cursor) => {
    pageCalls += 1;
    if (cursor === null) {
      return { sessionIds: firstPageIds, nextCursor: firstCursor };
    }
    if (mode === "candidate-page-blocked") {
      process.stdout.write("candidate-page-blocked\n");
      await startupGate;
    }
    return { sessionIds: [finalSessionId], nextCursor: null };
  };
  runtime.actors.acquire = async () => {
    adoptedCandidates += 1;
    if (adoptedCandidates === 1_001) process.stdout.write("candidates-adopted\n");
    return { release: () => undefined };
  };
}

const server = new WiServer({ runtime, port: 0 });
let starting = Promise.resolve();
let shuttingDown = false;
const timeout = setTimeout(() => process.exit(70), 10_000);

process.once("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const closing = server.close();
  void closing.then(releaseStartup, releaseStartup);
  void Promise.allSettled([starting, closing]).then((results) => {
    clearTimeout(timeout);
    const fulfilled = results.every((result) => result.status === "fulfilled");
    const address = server.address;
    process.stdout.write(
      `${JSON.stringify({ fulfilled, address, mode, pageCalls, adoptedCandidates })}\n`,
    );
    process.exit(fulfilled && address === null ? 0 : 7);
  });
});

starting = server.start();
