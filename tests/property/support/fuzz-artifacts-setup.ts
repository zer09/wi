import { relative } from "node:path";

import * as fc from "fast-check";
import { afterEach, beforeEach } from "vitest";

import { writeFuzzFailureArtifact } from "./fuzz-artifact.js";

beforeEach((context) => {
  const testFile = relative(process.cwd(), context.task.file.filepath);
  const test = context.task.name;
  const milestone4AgentLoop = testFile.endsWith("milestone4-agent-loop-model.test.ts");
  const milestone4StateMachines = testFile.endsWith("milestone4-state-machines.test.ts");
  let seedEnvironment = "WI_FC_SEED";
  let pathEnvironment = "WI_FC_PATH";
  if (milestone4AgentLoop) {
    seedEnvironment = "WI_M4_AGENT_FC_SEED";
    pathEnvironment = "WI_M4_AGENT_FC_PATH";
  } else if (milestone4StateMachines) {
    seedEnvironment = "WI_M4_FC_SEED";
    pathEnvironment = "WI_M4_FC_PATH";
  }

  fc.configureGlobal({
    reporter: (details) => {
      if (!details.failed) return;
      const artifact = writeFuzzFailureArtifact({
        suite: `timed companion ${testFile}`,
        test,
        testFile,
        profile: process.env.WI_FUZZ_PROFILE ?? "property",
        details,
        seedEnvironment,
        pathEnvironment,
      });
      throw new Error(
        `${fc.defaultReportMessage(details)}\n` +
          `Artifact: ${artifact.artifactPath}\n` +
          `Reproduction command: ${artifact.reproduction}`,
        { cause: details.errorInstance },
      );
    },
  });
});

afterEach(() => {
  fc.resetConfigureGlobal();
});
