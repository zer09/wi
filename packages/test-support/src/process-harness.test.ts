import { describe, expect, it } from "vitest";

import { processTreeSignalPlan } from "./process-harness.js";

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
