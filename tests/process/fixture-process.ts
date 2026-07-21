import type { ChildProcess } from "node:child_process";

import {
  BoundedProcessOutput,
  PROCESS_READINESS_MARKER_MAX_BYTES,
  spawnNodeProcessTree,
  terminateProcessTree,
  type ProcessOutputDiagnostics,
} from "@wi/test-support";

export interface FixtureProcessResult {
  readonly pid: number | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Bounded diagnostic tail. */
  readonly stdout: string;
  /** Bounded diagnostic tail. */
  readonly stderr: string;
  readonly stdoutDiagnostics: ProcessOutputDiagnostics;
  readonly stderrDiagnostics: ProcessOutputDiagnostics;
}

export class FixtureProcessTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly result: FixtureProcessResult,
  ) {
    super(
      `Fixture process ${result.pid ?? "unknown"} exceeded ${timeoutMs}ms. ${formatResultDiagnostics(result)}`,
    );
    this.name = "FixtureProcessTimeoutError";
  }
}

export class FixtureProcessReadinessTimeoutError extends Error {
  constructor(
    readonly marker: string,
    readonly timeoutMs: number,
    readonly result: FixtureProcessResult,
  ) {
    super(
      `Fixture process ${result.pid ?? "unknown"} did not print its readiness marker within ${timeoutMs}ms. ${formatResultDiagnostics(result)}`,
    );
    this.name = "FixtureProcessReadinessTimeoutError";
  }
}

export interface FixtureProcessRunOptions {
  readonly startTimeoutAfterStdout?: string;
  readonly readinessTimeoutMs?: number;
}

function formatOutputDiagnostics(
  stream: "stdout" | "stderr",
  diagnostics: ProcessOutputDiagnostics,
): string {
  const retention = diagnostics.truncated
    ? `${String(diagnostics.retainedBytes)}-byte tail truncated after ${String(diagnostics.totalBytes)} total bytes`
    : `${String(diagnostics.totalBytes)} total bytes`;
  return `${stream}=${diagnostics.tail} (${retention}, sha256=${diagnostics.sha256})`;
}

function formatResultDiagnostics(result: FixtureProcessResult): string {
  return `${formatOutputDiagnostics("stdout", result.stdoutDiagnostics)} ${formatOutputDiagnostics("stderr", result.stderrDiagnostics)}`;
}

class StreamingMarkerMatcher {
  private readonly marker: Buffer;
  private readonly fallback: Int32Array;
  private matchedBytes = 0;

  constructor(marker: string) {
    this.marker = Buffer.from(marker);
    if (this.marker.length > PROCESS_READINESS_MARKER_MAX_BYTES) {
      throw new Error(
        `Fixture readiness marker exceeds ${String(PROCESS_READINESS_MARKER_MAX_BYTES)} bytes`,
      );
    }
    this.fallback = new Int32Array(this.marker.length);
    for (let index = 1; index < this.marker.length; index += 1) {
      let candidate = this.fallback[index - 1] ?? 0;
      while (candidate > 0 && this.marker[index] !== this.marker[candidate]) {
        candidate = this.fallback[candidate - 1] ?? 0;
      }
      if (this.marker[index] === this.marker[candidate]) candidate += 1;
      this.fallback[index] = candidate;
    }
  }

  push(chunk: Uint8Array): boolean {
    if (this.marker.length === 0) return true;
    for (const byte of chunk) {
      while (this.matchedBytes > 0 && byte !== this.marker[this.matchedBytes]) {
        this.matchedBytes = this.fallback[this.matchedBytes - 1] ?? 0;
      }
      if (byte === this.marker[this.matchedBytes]) this.matchedBytes += 1;
      if (this.matchedBytes === this.marker.length) {
        this.matchedBytes = this.fallback[this.matchedBytes - 1] ?? 0;
        return true;
      }
    }
    return false;
  }
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
    const readinessMarker = options.startTimeoutAfterStdout;
    const readinessMatcher = readinessMarker === undefined
      ? null
      : new StreamingMarkerMatcher(readinessMarker);
    const child = await spawnNodeProcessTree(
      arguments_,
      environment === undefined ? {} : { environment },
    );
    this.children.add(child);
    const stdoutOutput = new BoundedProcessOutput();
    const stderrOutput = new BoundedProcessOutput();
    let spawnError: Error | null = null;
    let timedOut = false;
    let readinessTimedOut = false;
    let readinessObserved = false;
    let timer: NodeJS.Timeout | null = null;
    const armRunTimeout = (): void => {
      timer = setTimeout(() => {
        timedOut = true;
        void this.terminate(child);
      }, timeoutMs);
      timer.unref();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutOutput.append(chunk);
      if (
        readinessMatcher !== null &&
        !readinessObserved &&
        readinessMatcher.push(chunk)
      ) {
        readinessObserved = true;
        if (timer !== null) clearTimeout(timer);
        armRunTimeout();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput.append(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
      void this.terminate(child);
    });

    const closed = new Promise<FixtureProcessResult>((resolve) => {
      child.once("close", (code, signal) => {
        const stdoutDiagnostics = stdoutOutput.snapshot();
        const stderrDiagnostics = stderrOutput.snapshot();
        resolve({
          pid: child.pid ?? null,
          code,
          signal,
          stdout: stdoutDiagnostics.tail,
          stderr: stderrDiagnostics.tail,
          stdoutDiagnostics,
          stderrDiagnostics,
        });
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
      // Leader exit does not prove its detached process group is empty.
      await this.terminate(child);
    }
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.children].map((child) => this.terminate(child)));
  }

  private terminate(child: ChildProcess): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing !== undefined) return existing;
    // A timeout callback can finish cleanup before run() reaches its finally block.
    // Successful cleanup already removed ownership; only failed cleanup stays retryable.
    if (!this.children.has(child)) return Promise.resolve();

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
