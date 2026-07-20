import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type Serializable } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ServerProcessMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ServerProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface WindowsJobOwnership {
  readonly name: string;
  readonly activeProcessCount: () => number;
  readonly terminate: () => void;
  readonly close: () => void;
}

const windowsJobs = new WeakMap<ChildProcess, WindowsJobOwnership>();
const windowsGracefulTokens = new WeakMap<ChildProcess, string>();
const WINDOWS_JOB_NAME = "WI_TEST_SUPPORT_WINDOWS_JOB_NAME";
const WINDOWS_JOB_READY_FD = "WI_TEST_SUPPORT_WINDOWS_JOB_READY_FD";
const WINDOWS_JOB_ACKNOWLEDGEMENT_FD = "WI_TEST_SUPPORT_WINDOWS_JOB_ACKNOWLEDGEMENT_FD";
const WINDOWS_GRACEFUL_TOKEN = "WI_TEST_SUPPORT_WINDOWS_GRACEFUL_TOKEN";

function environmentWithValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  value: string,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === name.toLowerCase()) delete result[key];
  }
  result[name] = value;
  return result;
}

async function waitForWindowsJobAssignment(child: ChildProcess): Promise<void> {
  // The preload blocks before fixture code until the parent confirms that the
  // process joined its job, so no descendant can escape through an assignment race.
  const readiness = child.stdio[3];
  const acknowledgement = child.stdio[4];
  if (
    readiness === undefined ||
    readiness === null ||
    !("once" in readiness) ||
    acknowledgement === undefined ||
    acknowledgement === null ||
    !("write" in acknowledgement)
  ) {
    throw new Error("Windows Job Object preload has no handshake pipes");
  }
  let onReady = (): void => undefined;
  let onExit = (): void => undefined;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        onReady = () => resolve();
        onExit = () => reject(new Error("Fixture exited before joining its Windows Job Object"));
        readiness.once("data", onReady);
        child.once("exit", onExit);
      }),
      5_000,
      () => "Fixture did not join its Windows Job Object",
    );
  } finally {
    readiness.off("data", onReady);
    child.off("exit", onExit);
  }
  acknowledgement.write("continue");
}

export async function spawnNodeProcessTree(
  arguments_: readonly string[],
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly ipc?: boolean;
  } = {},
): Promise<ChildProcess> {
  let environment = { ...process.env, ...options.environment };
  let ownership: WindowsJobOwnership | null = null;
  if (process.platform === "win32") {
    const { WindowsProcessJob } = await import("./windows-process-job.js");
    ownership = WindowsProcessJob.create(
      `Local\\wi-test-${String(process.pid)}-${randomUUID()}`,
    );
    const preloadUrl = new URL("./windows-job-preload.js", import.meta.url).href;
    const existingNodeOptions = environment.NODE_OPTIONS?.trim();
    environment = environmentWithValue(
      environment,
      "NODE_OPTIONS",
      `${existingNodeOptions === undefined || existingNodeOptions === "" ? "" : `${existingNodeOptions} `}--import=${preloadUrl}`,
    );
    environment = environmentWithValue(environment, WINDOWS_JOB_NAME, ownership.name);
    environment = environmentWithValue(environment, WINDOWS_JOB_READY_FD, "3");
    environment = environmentWithValue(
      environment,
      WINDOWS_JOB_ACKNOWLEDGEMENT_FD,
      "4",
    );
    environment = environmentWithValue(
      environment,
      WINDOWS_GRACEFUL_TOKEN,
      randomUUID(),
    );
  }

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [...arguments_], {
      env: environment,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        ...(ownership === null ? [] : ["pipe" as const, "pipe" as const]),
        ...(options.ipc === true || ownership !== null ? ["ipc" as const] : []),
      ],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    if (ownership !== null) {
      windowsJobs.set(child, ownership);
      const gracefulToken = environment[WINDOWS_GRACEFUL_TOKEN];
      if (gracefulToken === undefined) throw new Error("Windows graceful control token is missing");
      windowsGracefulTokens.set(child, gracefulToken);
      await waitForWindowsJobAssignment(child);
    }
    return child;
  } catch (error) {
    if (ownership !== null) {
      try {
        ownership.terminate();
      } finally {
        ownership.close();
      }
    }
    try {
      child?.kill("SIGKILL");
    } catch {
      // The failed child may already be gone.
    }
    throw error;
  }
}

export class RealServerProcess {
  private readonly messages: ServerProcessMessage[] = [];
  private readonly allMessages: ServerProcessMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private stdoutText = "";
  private stderrText = "";
  private readonly closed: Promise<ServerProcessExit>;

  private constructor(readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.stdoutText += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    child.on("message", (value: unknown) => {
      if (value === null || typeof value !== "object" || !("type" in value)) return;
      const message = value as ServerProcessMessage;
      this.messages.push(message);
      this.allMessages.push(message);
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
    this.closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal, stdout: this.stdoutText, stderr: this.stderrText });
        for (const wake of this.waiters) wake();
        this.waiters.clear();
      });
    });
  }

  static async start(options: {
    readonly fixturePath: string;
    readonly arguments?: readonly string[];
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly readyTimeoutMs?: number;
    readonly waitForReady?: boolean;
  }): Promise<RealServerProcess> {
    const child = await spawnNodeProcessTree(
      [options.fixturePath, ...(options.arguments ?? [])],
      {
        environment: { ...process.env, ...options.environment },
        ipc: true,
      },
    );
    const processHandle = new RealServerProcess(child);
    try {
      if (options.waitForReady !== false) {
        await processHandle.waitForMessage("ready", options.readyTimeoutMs ?? 10_000);
      }
      return processHandle;
    } catch (error) {
      await processHandle.terminate();
      throw error;
    }
  }

  send(message: Serializable): void {
    if (this.child.connected) this.child.send(message);
  }

  async waitForMessage(type: string, timeoutMs = 10_000): Promise<ServerProcessMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const index = this.messages.findIndex((message) => message.type === type);
      if (index >= 0) return this.messages.splice(index, 1)[0] as ServerProcessMessage;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        const exit = await this.closed;
        throw new Error(
          `Server exited before ${type}: code=${String(exit.code)} signal=${String(exit.signal)} stderr=${exit.stderr}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for server message ${type}. stderr=${this.stderrText}`);
      }
      let wake = (): void => undefined;
      try {
        await withTimeout(
          new Promise<void>((resolve) => {
            wake = resolve;
            this.waiters.add(wake);
          }),
          remaining,
          () => `Timed out waiting for server message ${type}. stderr=${this.stderrText}`,
        );
      } finally {
        this.waiters.delete(wake);
      }
    }
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    await signalProcessTree(this.child, signal);
  }

  waitForExit(timeoutMs = 10_000): Promise<ServerProcessExit> {
    return withTimeout(this.closed, timeoutMs, () =>
      `Server process ${String(this.child.pid)} did not exit. stderr=${this.stderrText}`,
    );
  }

  get receivedMessages(): readonly ServerProcessMessage[] {
    return [...this.allMessages];
  }

  async terminate(): Promise<void> {
    await terminateProcessTree(this.child);
  }
}

export class RealServerHarness {
  readonly homeDirectory: string;
  private readonly processes = new Set<RealServerProcess>();

  private constructor(homeDirectory: string) {
    this.homeDirectory = homeDirectory;
  }

  static async create(prefix = "wi-process-"): Promise<RealServerHarness> {
    return new RealServerHarness(await mkdtemp(join(tmpdir(), prefix)));
  }

  async start(options: Omit<Parameters<typeof RealServerProcess.start>[0], "arguments"> & {
    readonly arguments?: readonly string[];
  }): Promise<RealServerProcess> {
    const processHandle = await RealServerProcess.start({
      ...options,
      arguments: [this.homeDirectory, ...(options.arguments ?? [])],
    });
    this.processes.add(processHandle);
    return processHandle;
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.processes].map((processHandle) => processHandle.terminate()));
    this.processes.clear();
    await rm(this.homeDirectory, { recursive: true, force: true });
  }
}

export type ProcessTreeSignalPlan =
  | { readonly kind: "process-group"; readonly pid: number; readonly signal: NodeJS.Signals }
  | { readonly kind: "windows-control"; readonly signal: "SIGTERM" | "SIGINT" }
  | { readonly kind: "windows-job" };

export function processTreeSignalPlan(
  platform: NodeJS.Platform,
  pid: number,
  signal: NodeJS.Signals,
): ProcessTreeSignalPlan {
  if (platform === "win32") {
    if (signal === "SIGTERM" || signal === "SIGINT") {
      return { kind: "windows-control", signal };
    }
    return { kind: "windows-job" };
  }
  return { kind: "process-group", pid: -pid, signal };
}

export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.pid === undefined) return;
  const windowsJob = windowsJobs.get(child);
  const plan = processTreeSignalPlan(process.platform, child.pid, signal);
  if (plan.kind === "windows-control") {
    const token = windowsGracefulTokens.get(child);
    if (windowsJob === undefined || token === undefined || !child.connected) {
      throw new Error("Windows graceful process signaling requires authenticated IPC ownership");
    }
    await new Promise<void>((resolve, reject) => {
      child.send(
        {
          type: "wi.test-support.graceful-signal",
          token,
          signal: plan.signal,
        },
        (error) => error === null ? resolve() : reject(error),
      );
    });
    return;
  }
  if (plan.kind === "windows-job") {
    if (windowsJob === undefined) {
      throw new Error("Windows process tree signaling requires Job Object ownership");
    }
    windowsJob.terminate();
    return;
  }
  try {
    process.kill(plan.pid, plan.signal);
  } catch (groupError) {
    try {
      child.kill(signal);
    } catch {
      // The process group and leader are already gone.
      if ((groupError as NodeJS.ErrnoException).code !== "ESRCH") throw groupError;
    }
  }
}

async function waitForProcessTreeGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leaderGone = child.exitCode !== null || child.signalCode !== null;
    if (process.platform === "win32") {
      const windowsJob = windowsJobs.get(child);
      if (windowsJob === undefined) return false;
      if (windowsJob.activeProcessCount() === 0) return true;
    } else if (child.pid === undefined) {
      return leaderGone;
    } else {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export async function terminateProcessTree(
  child: ChildProcess,
  terminationGraceMs = 1_000,
): Promise<void> {
  // POSIX groups and Windows Job Objects can outlive their direct leader. Always
  // signal and verify the owned boundary, not merely the leader's close event.
  const windowsJob = windowsJobs.get(child);
  if (process.platform === "win32" && windowsJob === undefined) {
    throw new Error("Windows process tree cleanup requires Job Object ownership");
  }
  const errors: unknown[] = [];
  try {
    await signalProcessTree(child, "SIGTERM");
  } catch (error) {
    if (windowsJob === undefined) {
      errors.push(error);
    } else {
      // Cleanup still owns the Job Object if the leader closed or disconnected
      // before accepting graceful control, so escalate without losing the tree.
      try {
        windowsJob.terminate();
      } catch (escalationError) {
        errors.push(escalationError);
      }
    }
  }
  const terminated = await waitForProcessTreeGone(child, terminationGraceMs);
  if (!terminated) {
    try {
      await signalProcessTree(child, "SIGKILL");
    } catch (error) {
      errors.push(error);
    }
    if (!(await waitForProcessTreeGone(child, terminationGraceMs))) {
      errors.push(new Error(`Server process tree ${String(child.pid)} did not disappear`));
    }
  }
  if (windowsJob !== undefined) {
    try {
      if (windowsJob.activeProcessCount() === 0) {
        windowsJob.close();
        windowsJobs.delete(child);
        windowsGracefulTokens.delete(child);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Server process cleanup failed");
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message())), timeoutMs);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
