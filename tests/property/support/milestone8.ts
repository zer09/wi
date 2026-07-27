import * as fc from "fast-check";

import { writeFuzzFailureArtifact } from "./fuzz-artifact.js";

const DEFAULT_SEED = 737_373;
const MAXIMUM_FAST_CHECK_SEED = 2_147_483_647;
const DEFAULT_RUNS = 1_000;

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || (name === "WI_FC_SEED" && value > MAXIMUM_FAST_CHECK_SEED)) {
    throw new RangeError(
      name === "WI_FC_SEED"
        ? `${name} must be between 1 and ${MAXIMUM_FAST_CHECK_SEED}`
        : `${name} must be a positive safe integer`,
    );
  }
  return value;
}

export const milestone8Seed = integerEnvironment("WI_FC_SEED", DEFAULT_SEED);
export const milestone8Path = process.env.WI_FC_PATH;
export const milestone8Profile = process.env.WI_FUZZ_PROFILE ?? "property";
export const milestone8OperationCount = integerEnvironment("WI_FC_NUM_RUNS", DEFAULT_RUNS);

export function milestone8Parameters(propertyCount: number): fc.Parameters<unknown> {
  const common = {
    seed: milestone8Seed,
    ...(milestone8Path === undefined ? {} : { path: milestone8Path }),
  };
  if (milestone8Profile === "property") {
    return { ...common, numRuns: milestone8OperationCount };
  }
  const durationMs = integerEnvironment("WI_FUZZ_DURATION_MS", 60_000);
  return {
    ...common,
    numRuns: 2_147_483_647,
    interruptAfterTimeLimit: Math.max(100, Math.floor(durationMs / propertyCount)),
    markInterruptAsFailure: false,
  };
}

export async function assertMilestone8Property<Ts>(options: {
  readonly suite: string;
  readonly test: string;
  readonly property: fc.IRawProperty<Ts>;
  readonly propertyCount: number;
  readonly testFile: string;
  readonly identifiers?: () => unknown;
  readonly parameters?: fc.Parameters<unknown>;
}): Promise<void> {
  const details = await fc.check(
    options.property,
    options.parameters ?? milestone8Parameters(options.propertyCount),
  );
  if (!details.failed) return;
  // A timed profile ending while an async case is still running is a clean budget stop,
  // not a reproducible invariant failure.
  if (details.interrupted && details.counterexample === null) return;

  const artifact = writeFuzzFailureArtifact({
    suite: options.suite,
    test: options.test,
    testFile: options.testFile,
    profile: milestone8Profile,
    details,
    identifiers: options.identifiers?.(),
  });

  const detailMessage =
    details.errorInstance instanceof Error
      ? details.errorInstance.message
      : String(details.errorInstance ?? "Property failed");
  throw new Error(
    `${options.suite} > ${options.test}\n${detailMessage}\n` +
      `Seed: ${details.seed}\nPath: ${details.counterexamplePath ?? ""}\n` +
      `Counterexample: ${artifact.counterexample.preview}\n` +
      `Identifiers: ${JSON.stringify(artifact.identifiers)}\n` +
      `Artifact: ${artifact.artifactPath}\nReproduction command: ${artifact.reproduction}`,
    { cause: details.errorInstance },
  );
}
