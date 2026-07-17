import { WiRuntime } from "../../apps/server/dist/index.js";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);

const cases = [
  ["providerCapacity", { providerCapacity: 0 }],
  ["toolCapacity", { toolCapacity: 0 }],
  ["actorIdleTimeoutMs", { actorIdleTimeoutMs: -1 }],
  ["actorEvictionIntervalMs", { actorEvictionIntervalMs: 0 }],
  ["reservedStorageHome", { storage: { homeDirectory: "/tmp/forbidden" } }],
  ["reservedStorageClock", { storage: { now: () => 0 } }],
  [
    "catalogObservationShutdownTimeoutMs",
    { storage: { catalogObservationShutdownTimeoutMs: 0 } },
  ],
  ["sessionWorkerSize", { storage: { sessionWorkers: { size: 0 } } }],
  [
    "sessionWorkerHandles",
    { storage: { sessionWorkers: { maxOpenHandlesPerWorker: 0 } } },
  ],
  [
    "sessionWorkerRequestTimeout",
    { storage: { sessionWorkers: { defaultRequestTimeoutMs: 0 } } },
  ],
  [
    "sessionWorkerCloseTimeout",
    { storage: { sessionWorkers: { closeTimeoutMs: 0 } } },
  ],
  [
    "catalogWorkerRequestTimeout",
    { storage: { catalogWorker: { defaultRequestTimeoutMs: 0 } } },
  ],
  [
    "catalogWorkerCloseTimeout",
    { storage: { catalogWorker: { closeTimeoutMs: 0 } } },
  ],
];

const rejected = [];
for (const [name, options] of cases) {
  try {
    const runtime = new WiRuntime({ homeDirectory, ...options });
    await runtime.close();
    throw new Error(`Invalid runtime option ${name} was accepted`);
  } catch (error) {
    if (error instanceof Error && error.message === `Invalid runtime option ${name} was accepted`) {
      throw error;
    }
    rejected.push(name);
  }
}

process.stdout.write(`${JSON.stringify({ rejected })}\n`);
