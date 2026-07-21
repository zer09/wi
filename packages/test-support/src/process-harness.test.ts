import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BoundedProcessOutput, processTreeSignalPlan } from "./process-harness.js";

describe("bounded process output", () => {
  it("retains the newest bytes across ring wrap without changing the full hash", () => {
    const output = new BoundedProcessOutput(5);
    output.append(Buffer.from("abc"));
    output.append(Buffer.from("def"));

    expect(output.snapshot()).toEqual({
      tail: "bcdef",
      retainedBytes: 5,
      totalBytes: 6,
      truncated: true,
      sha256: createHash("sha256").update("abcdef").digest("hex"),
    });
  });

  it("copies only the capped tail from one oversized chunk", () => {
    const output = new BoundedProcessOutput(4);
    output.append(Buffer.from("0123456789"));

    expect(output.snapshot()).toMatchObject({
      tail: "6789",
      retainedBytes: 4,
      totalBytes: 10,
      truncated: true,
    });
  });
});

describe("process tree signal planning", () => {
  it("signals the detached POSIX process group", () => {
    expect(processTreeSignalPlan("linux", 1234, "SIGTERM")).toEqual({
      kind: "process-group",
      pid: -1234,
      signal: "SIGTERM",
    });
  });

  it("separates graceful Windows control from Job Object escalation", () => {
    expect(processTreeSignalPlan("win32", 1234, "SIGTERM")).toEqual({
      kind: "windows-control",
      signal: "SIGTERM",
    });
    expect(processTreeSignalPlan("win32", 1234, "SIGINT")).toEqual({
      kind: "windows-control",
      signal: "SIGINT",
    });
    expect(processTreeSignalPlan("win32", 1234, "SIGKILL")).toEqual({
      kind: "windows-job",
    });
  });
});
