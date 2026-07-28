import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { writeFuzzFailureArtifact } from "../property/support/fuzz-artifact.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const selectorPath = join(root, "scripts", "select-nightly-fuzz-seed.mjs");
const runnerPath = join(root, "scripts", "run-fuzz.mjs");
const workflowPath = join(root, ".github", "workflows", "nightly-fuzz.yml");
const maximumFastCheckSeed = 2_147_483_647;

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  return environment;
}

async function runSelector(options: {
  readonly eventName: "schedule" | "workflow_dispatch";
  readonly runId: string;
  readonly runAttempt: string;
  readonly manualSeed?: string;
}): Promise<ProcessResult & { readonly output: string }> {
  const directory = await mkdtemp(join(tmpdir(), "wi-nightly-seed-test-"));
  const outputPath = join(directory, "github-output.txt");
  try {
    const result = await runProcess(process.execPath, [selectorPath], {
      ...cleanChildEnvironment(),
      GITHUB_EVENT_NAME: options.eventName,
      GITHUB_RUN_ID: options.runId,
      GITHUB_RUN_ATTEMPT: options.runAttempt,
      GITHUB_OUTPUT: outputPath,
      ...(options.manualSeed === undefined ? {} : { WI_MANUAL_FUZZ_SEED: options.manualSeed }),
    });
    return {
      ...result,
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function selectedSeed(result: ProcessResult & { readonly output: string }): number {
  const match = /^seed=(\d+)$/mu.exec(result.output);
  if (match?.[1] === undefined) throw new Error(`Missing selected seed: ${result.output}`);
  return Number(match[1]);
}

function removeArtifact(path: string): void {
  if (existsSync(path)) unlinkSync(path);
  try {
    rmdirSync(join(root, ".artifacts", "fuzz"));
    rmdirSync(join(root, ".artifacts"));
  } catch {
    // Other diagnostics may own the directory; remove only this test's file.
  }
}

describe("nightly fuzz seed workflow", () => {
  it("derives stable diverse valid seeds from recorded run identities", async () => {
    const first = await runSelector({
      eventName: "schedule",
      runId: "30284981725",
      runAttempt: "1",
    });
    const repeated = await runSelector({
      eventName: "schedule",
      runId: "30284981725",
      runAttempt: "1",
    });
    const secondRun = await runSelector({
      eventName: "schedule",
      runId: "30284981726",
      runAttempt: "1",
    });
    const secondAttempt = await runSelector({
      eventName: "schedule",
      runId: "30284981725",
      runAttempt: "2",
    });

    expect([first.code, repeated.code, secondRun.code, secondAttempt.code]).toEqual([0, 0, 0, 0]);
    const seed = selectedSeed(first);
    expect(seed).toBe(selectedSeed(repeated));
    expect(seed).toBeGreaterThanOrEqual(1);
    expect(seed).toBeLessThanOrEqual(maximumFastCheckSeed);
    expect(new Set([seed, selectedSeed(secondRun), selectedSeed(secondAttempt)]).size).toBe(3);
    expect(first.stdout).toContain(`Selected nightly fuzz seed: ${seed} source=run-identity`);
    expect(first.stdout).toContain("run_id=30284981725 run_attempt=1");
  });

  it.each([1, 737_373, maximumFastCheckSeed])(
    "uses valid manual seed %i exactly",
    async (manualSeed) => {
      const result = await runSelector({
        eventName: "workflow_dispatch",
        runId: "30284981725",
        runAttempt: "1",
        manualSeed: String(manualSeed),
      });

      expect(result.code).toBe(0);
      expect(selectedSeed(result)).toBe(manualSeed);
      expect(result.stdout).toContain(`Selected nightly fuzz seed: ${manualSeed} source=manual`);
    },
  );

  it.each(["0", "-1", "1.5", "many", "2147483648", "9007199254740991"])(
    "rejects invalid manual seed %s before publishing an output",
    async (manualSeed) => {
      const result = await runSelector({
        eventName: "workflow_dispatch",
        runId: "30284981725",
        runAttempt: "1",
        manualSeed,
      });

      expect(result.code).toBe(64);
      expect(result.output).toBe("");
      expect(result.stdout).not.toContain("Selected nightly fuzz seed");
      expect(result.stderr).toContain(
        `Manual fuzz seed must be a decimal integer between 1 and ${maximumFastCheckSeed}\n`,
      );
      expect(result.stderr.length).toBeLessThan(512);
    },
  );

  it("wires one selected workflow output into an ordinary failing extended-fuzz step", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:\n    inputs:\n      seed:");
    expect(workflow).toContain("WI_MANUAL_FUZZ_SEED: ${{ inputs.seed }}");
    expect(workflow).toContain("run: node scripts/select-nightly-fuzz-seed.mjs");
    expect(workflow).toContain("WI_FC_SEED: ${{ steps.fuzz-seed.outputs.seed }}");
    expect(workflow).toContain("run: pnpm test:fuzz:extended");
    expect(workflow).not.toContain('WI_FC_SEED: "737373"');
    expect(workflow).not.toContain("continue-on-error:");
    expect(workflow.indexOf("Select reproducible fuzz seed")).toBeLessThan(
      workflow.indexOf("Run extended fuzz profile"),
    );
  });

  it("records the selected seed in the artifact and exact reproduction command", async () => {
    const selection = await runSelector({
      eventName: "schedule",
      runId: "30284981725",
      runAttempt: "1",
    });
    expect(selection.code).toBe(0);
    const seed = selectedSeed(selection);
    const details = fc.check(
      fc.property(fc.constant({ commandId: "cmd_nightlySeedArtifact" }), () => false),
      { seed, numRuns: 1 },
    );
    expect(details.failed).toBe(true);
    const artifact = writeFuzzFailureArtifact({
      suite: "Nightly seed architecture probe",
      test: `records selected workflow seed "$HOME" 'quoted'`,
      testFile: "tests/architecture/nightly-fuzz-workflow.test.ts",
      profile: "extended",
      details,
    });

    try {
      const stored = JSON.parse(readFileSync(artifact.artifactPath, "utf8")) as {
        readonly seed: number;
        readonly reproduction: string;
      };
      expect(stored.seed).toBe(seed);
      expect(stored.reproduction).toContain(`WI_FC_SEED=${seed} `);
      expect(stored.reproduction).toContain(
        `-t 'records selected workflow seed "\\$HOME" '"'"'quoted'"'"''`,
      );
      expect(artifact.reproduction).toBe(stored.reproduction);
    } finally {
      removeArtifact(artifact.artifactPath);
    }
  });

  it("propagates the extended fuzz child's nonzero exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wi-nightly-failure-test-"));
    const fakePnpm = join(directory, "pnpm");
    const logPath = join(directory, "pnpm.log");
    writeFileSync(
      fakePnpm,
      "#!/bin/sh\n" +
        'printf "%s|%s\\n" "$WI_FC_SEED" "$*" >> "$WI_FAKE_PNPM_LOG"\n' +
        'if [ "$1" = "build:test-deps" ]; then exit 0; fi\n' +
        'exit "$WI_FAKE_TEST_EXIT"\n',
      "utf8",
    );
    chmodSync(fakePnpm, 0o700);

    try {
      const result = await runProcess(
        process.execPath,
        [runnerPath, "extended", "--duration=1000", "-t", "selected failure probe"],
        {
          ...cleanChildEnvironment(),
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          WI_FAKE_PNPM_LOG: logPath,
          WI_FAKE_TEST_EXIT: "23",
          WI_FC_SEED: "123456789",
        },
      );

      expect(result.code).toBe(23);
      expect(result.stdout).toContain("Wi extended fuzz profile: duration=1000ms seed=123456789");
      const calls = readFileSync(logPath, "utf8").trim().split("\n");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe("123456789|build:test-deps");
      expect(calls[1]).toContain("123456789|exec vitest run");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
