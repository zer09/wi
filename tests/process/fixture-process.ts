import { spawn, type ChildProcess } from "node:child_process";

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

export class FixtureProcessRunner {
  private readonly children = new Set<ChildProcess>();
  private readonly closedChildren = new WeakSet<ChildProcess>();
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
  ): Promise<FixtureProcessResult> {
    const child = spawn(command, [...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
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
        this.closedChildren.add(child);
        resolve({ pid: child.pid ?? null, code, signal, stdout, stderr });
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void this.terminate(child);
    }, timeoutMs);
    timer.unref();

    try {
      const result = await closed;
      if (spawnError !== null) throw spawnError;
      if (timedOut) throw new FixtureProcessTimeoutError(timeoutMs, result);
      return result;
    } finally {
      clearTimeout(timer);
      this.children.delete(child);
    }
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.children].map((child) => this.terminate(child)));
  }

  private terminate(child: ChildProcess): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing !== undefined) return existing;
    if (this.closedChildren.has(child)) {
      this.children.delete(child);
      return Promise.resolve();
    }

    const termination = new Promise<void>((resolve) => {
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, this.terminationGraceMs);
      escalation.unref();
      child.once("close", () => {
        clearTimeout(escalation);
        this.closedChildren.add(child);
        this.children.delete(child);
        resolve();
      });
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    this.terminations.set(child, termination);
    void termination.finally(() => this.terminations.delete(child));
    return termination;
  }
}
