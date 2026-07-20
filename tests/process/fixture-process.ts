import type { ChildProcess } from "node:child_process";

import { spawnNodeProcessTree, terminateProcessTree } from "@wi/test-support";

export interface FixtureProcessResult {
  readonly pid: number | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class FixtureProcessTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly result: FixtureProcessResult,
  ) {
    super(`Fixture process ${result.pid ?? "unknown"} exceeded ${timeoutMs}ms.`);
    this.name = "FixtureProcessTimeoutError";
  }
}

export class FixtureProcessReadinessTimeoutError extends Error {
  constructor(
    readonly marker: string,
    readonly timeoutMs: number,
    readonly result: FixtureProcessResult,
  ) {
    super(`Fixture process ${result.pid ?? "unknown"} did not print its readiness marker within ${timeoutMs}ms.`);
    this.name = "FixtureProcessReadinessTimeoutError";
  }
}

export interface FixtureProcessRunOptions {
  readonly startTimeoutAfterStdout?: string;
  readonly readinessTimeoutMs?: number;
}

export class FixtureProcessRunner {
  private readonly children = new Set<ChildProcess>();
  private readonly terminations = new Map<ChildProcess, Promise<void>>();

  constructor(
    private readonly defaultTimeoutMs = 10_000,
    private readonly terminationGraceMs = 250,
  ) {}

  get activeCount(): number {
    return this.children.size;
  }

  async run(
    command: string,
    arguments_: readonly string[],
    timeoutMs = this.defaultTimeoutMs,
    environment?: NodeJS.ProcessEnv,
    options: FixtureProcessRunOptions = {},
  ): Promise<FixtureProcessResult> {
    if (command !== process.execPath) {
      throw new Error("FixtureProcessRunner accepts only the current Node.js executable");
    }
    const child = await spawnNodeProcessTree(
      arguments_,
      environment === undefined ? {} : { environment },
    );
    this.children.add(child);
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    let timedOut = false;
    let readinessTimedOut = false;
    let readinessObserved = false;
    let timer: NodeJS.Timeout | null = null;
    const readinessMarker = options.startTimeoutAfterStdout;
    const armRunTimeout = (): void => {
      timer = setTimeout(() => {
        timedOut = true;
        void this.terminate(child);
      }, timeoutMs);
      timer.unref();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (
        readinessMarker !== undefined &&
        !readinessObserved &&
        stdout.includes(readinessMarker)
      ) {
        readinessObserved = true;
        if (timer !== null) clearTimeout(timer);
        armRunTimeout();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
      void this.terminate(child);
    });

    const closed = new Promise<FixtureProcessResult>((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ pid: child.pid ?? null, code, signal, stdout, stderr });
      });
    });
    if (readinessMarker === undefined) {
      armRunTimeout();
    } else {
      const readinessTimeoutMs = options.readinessTimeoutMs ?? 5_000;
      timer = setTimeout(() => {
        readinessTimedOut = true;
        void this.terminate(child);
      }, readinessTimeoutMs);
      timer.unref();
    }

    try {
      const result = await closed;
      if (spawnError !== null) throw spawnError;
      if (readinessTimedOut) {
        throw new FixtureProcessReadinessTimeoutError(
          readinessMarker ?? "",
          options.readinessTimeoutMs ?? 5_000,
          result,
        );
      }
      if (timedOut) throw new FixtureProcessTimeoutError(timeoutMs, result);
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
      // Leader exit does not prove its detached group or Job Object is empty.
      await this.terminate(child);
    }
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.children].map((child) => this.terminate(child)));
  }

  private terminate(child: ChildProcess): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing !== undefined) return existing;

    const termination = terminateProcessTree(child, this.terminationGraceMs).then(() => {
      // Drop ownership only after the whole process boundary is verified empty.
      this.children.delete(child);
    });
    this.terminations.set(child, termination);
    void termination.then(
      () => this.terminations.delete(child),
      () => this.terminations.delete(child),
    );
    return termination;
  }
}
