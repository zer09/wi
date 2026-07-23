import type { SessionWorkerPool } from "../session/worker-pool.js";
const sessionWorkerPools = new WeakMap<object, SessionWorkerPool>();

export function registerSessionWorkerPoolForTest(
  manager: object,
  sessions: SessionWorkerPool,
): void {
  if (process.env.NODE_ENV === "test") sessionWorkerPools.set(manager, sessions);
}

export function sessionWorkerPoolForTest(manager: object): SessionWorkerPool {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Session worker test access requires NODE_ENV=test");
  }
  const sessions = sessionWorkerPools.get(manager);
  if (sessions === undefined) {
    throw new Error("Session worker test access was not enabled for this manager");
  }
  return sessions;
}
