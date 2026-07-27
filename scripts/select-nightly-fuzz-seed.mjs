import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const MAXIMUM_FAST_CHECK_SEED = 2_147_483_647;
const maximumSeed = BigInt(MAXIMUM_FAST_CHECK_SEED);
const positiveDecimal = /^[1-9]\d*$/u;

function recordedPositiveDecimal(name, raw) {
  if (raw === undefined || raw.length > 32 || !positiveDecimal.test(raw)) {
    throw new RangeError(`${name} must be a positive decimal integer of at most 32 digits`);
  }
  return BigInt(raw);
}

function boundedSeed(name, raw) {
  const message = `${name} must be a decimal integer between 1 and ${MAXIMUM_FAST_CHECK_SEED}`;
  if (raw === undefined || raw.length > 10 || !positiveDecimal.test(raw)) throw new RangeError(message);
  const value = BigInt(raw);
  if (value > maximumSeed) throw new RangeError(message);
  return value;
}

function scheduledSeed(runId, runAttempt) {
  const identity = `wi-nightly-fuzz-v1\0${runId}\0${runAttempt}`;
  const digest = createHash("sha256").update(identity).digest();
  return Number((digest.readBigUInt64BE(0) % maximumSeed) + 1n);
}

function selectSeed(environment) {
  const eventName = environment.GITHUB_EVENT_NAME;
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    throw new Error("GITHUB_EVENT_NAME must be schedule or workflow_dispatch");
  }

  const runId = recordedPositiveDecimal("GITHUB_RUN_ID", environment.GITHUB_RUN_ID);
  const runAttempt = recordedPositiveDecimal("GITHUB_RUN_ATTEMPT", environment.GITHUB_RUN_ATTEMPT);
  const manualSeed = environment.WI_MANUAL_FUZZ_SEED;
  if (eventName === "workflow_dispatch" && manualSeed !== undefined && manualSeed !== "") {
    return {
      seed: Number(boundedSeed("Manual fuzz seed", manualSeed)),
      source: "manual",
      runId: String(runId),
      runAttempt: String(runAttempt),
    };
  }

  return {
    seed: scheduledSeed(String(runId), String(runAttempt)),
    source: "run-identity",
    runId: String(runId),
    runAttempt: String(runAttempt),
  };
}

try {
  const selected = selectSeed(process.env);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath === "") {
    throw new Error("GITHUB_OUTPUT must identify the GitHub Actions output file");
  }
  appendFileSync(outputPath, `seed=${selected.seed}\n`, { encoding: "utf8" });
  process.stdout.write(
    `Selected nightly fuzz seed: ${selected.seed} source=${selected.source} ` +
      `run_id=${selected.runId} run_attempt=${selected.runAttempt}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Nightly fuzz seed selection failed";
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
