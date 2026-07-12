import { resolve, sep } from "node:path";

import { SessionIdSchema } from "@wi/protocol";

export function sessionDatabaseRelativePath(sessionId: string): string {
  const validSessionId = SessionIdSchema.parse(sessionId);
  const suffix = validSessionId.slice("ses_".length);
  const prefix = suffix.slice(0, 2).padEnd(2, "_");
  return `sessions/${prefix}/${validSessionId}/session.sqlite3`;
}

export function resolveStoragePath(homeDirectory: string, relativePath: string): string {
  const home = resolve(homeDirectory);
  const absolute = resolve(home, relativePath);
  if (absolute !== home && !absolute.startsWith(`${home}${sep}`)) {
    throw new Error("Storage path escapes WI_HOME");
  }
  return absolute;
}

export function stableSessionWorkerIndex(sessionId: string, poolSize: number): number {
  SessionIdSchema.parse(sessionId);
  if (!Number.isSafeInteger(poolSize) || poolSize < 1) {
    throw new RangeError("Session worker pool size must be a positive safe integer");
  }

  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(sessionId)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % poolSize;
}
