import { resolve, sep } from "node:path";

import { SessionIdSchema } from "@wi/protocol";

export function sessionPrefixFromId(sessionId: string): string {
  const validSessionId = SessionIdSchema.parse(sessionId);
  return validSessionId.slice("ses_".length).slice(0, 2).padEnd(2, "_");
}

export function isValidSessionPrefix(prefix: string): boolean {
  // Mirrors the ID suffix grammar: the first character cannot be punctuation,
  // while later suffix characters may include a hyphen.
  return /^[A-Za-z0-9][A-Za-z0-9_-]$/u.test(prefix) || /^[A-Za-z0-9]_$/u.test(prefix);
}

export function sessionDatabaseRelativePath(sessionId: string): string {
  const validSessionId = SessionIdSchema.parse(sessionId);
  return `sessions/${sessionPrefixFromId(validSessionId)}/${validSessionId}/session.sqlite3`;
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
