import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as fc from "fast-check";

const ARTIFACT_PREVIEW_CODE_UNITS = 16_384;

function artifactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function counterexampleText(value: unknown): {
  readonly preview: string;
  readonly sha256: string;
  readonly truncated: boolean;
} {
  const encoded = fc.stringify(value);
  const truncated = encoded.length > ARTIFACT_PREVIEW_CODE_UNITS;
  return {
    preview: truncated ? encoded.slice(0, ARTIFACT_PREVIEW_CODE_UNITS) : encoded,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    truncated,
  };
}

function collectIdentifiers(value: unknown): Readonly<Record<string, readonly string[]>> {
  const found = new Map<string, Set<string>>();
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0 && visited < 4_096) {
    const current = pending.pop();
    visited += 1;
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current.slice(0, 128));
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (/^(session|run|call|command)Id$/u.test(key) && typeof child === "string") {
        const values = found.get(key) ?? new Set<string>();
        if (values.size < 32) values.add(child.slice(0, 256));
        found.set(key, values);
      } else {
        pending.push(child);
      }
    }
  }
  return Object.fromEntries([...found].map(([key, values]) => [key, [...values]]));
}

export interface FuzzFailureArtifact {
  readonly artifactPath: string;
  readonly counterexample: ReturnType<typeof counterexampleText>;
  readonly identifiers: Readonly<Record<string, readonly string[]>>;
  readonly reproduction: string;
}

export function writeFuzzFailureArtifact(options: {
  readonly suite: string;
  readonly test: string;
  readonly testFile: string;
  readonly profile: string;
  readonly details: fc.RunDetails<unknown>;
  readonly identifiers?: unknown;
  readonly seedEnvironment?: string;
  readonly pathEnvironment?: string;
}): FuzzFailureArtifact {
  const path = options.details.counterexamplePath ?? "";
  const seedEnvironment = options.seedEnvironment ?? "WI_FC_SEED";
  const pathEnvironment = options.pathEnvironment ?? "WI_FC_PATH";
  const reproduction =
    `${seedEnvironment}=${options.details.seed} ${pathEnvironment}=${path} ` +
    `pnpm exec vitest run --workspace vitest.workspace.ts --project property ` +
    `${options.testFile} -t ${JSON.stringify(options.test)}`;
  const artifactDirectory = join(process.cwd(), ".artifacts", "fuzz");
  const artifactPath = join(
    artifactDirectory,
    `${artifactName(options.suite)}--${artifactName(options.test)}.json`,
  );
  const counterexample = counterexampleText(options.details.counterexample);
  const identifiers = collectIdentifiers([
    options.details.counterexample,
    options.identifiers,
  ]);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        suite: options.suite,
        test: options.test,
        profile: options.profile,
        seed: options.details.seed,
        path,
        counterexample,
        identifiers,
        numRuns: options.details.numRuns,
        numShrinks: options.details.numShrinks,
        reproduction,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(artifactPath, 0o600);
  return { artifactPath, counterexample, identifiers, reproduction };
}
