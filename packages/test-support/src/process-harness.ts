import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type Serializable } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerProcessMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export const PROCESS_OUTPUT_TAIL_MAX_BYTES = 64 * 1024;
export const PROCESS_IPC_PENDING_MAX_MESSAGES = 128;
export const PROCESS_IPC_HISTORY_MAX_MESSAGES = 256;
export const PROCESS_READINESS_MARKER_MAX_BYTES = 4 * 1024;

export interface ProcessOutputDiagnostics {
  readonly tail: string;
  readonly retainedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export interface ProcessIpcDiagnostics {
  readonly totalMessages: number;
  readonly pendingRetainedMessages: number;
  readonly historyRetainedMessages: number;
  readonly pendingTruncated: boolean;
  readonly historyTruncated: boolean;
}

export interface ServerProcessDiagnostics {
  readonly stdout: ProcessOutputDiagnostics;
  readonly stderr: ProcessOutputDiagnostics;
  readonly ipc: ProcessIpcDiagnostics;
}

export interface ServerProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Bounded diagnostic tail retained for backward-compatible callers. */
  readonly stdout: string;
  /** Bounded diagnostic tail retained for backward-compatible callers. */
  readonly stderr: string;
  readonly stdoutDiagnostics: ProcessOutputDiagnostics;
  readonly stderrDiagnostics: ProcessOutputDiagnostics;
  readonly ipcDiagnostics: ProcessIpcDiagnostics;
}

export class BoundedProcessOutput {
  private readonly bytes: Buffer;
  private readonly hash = createHash("sha256");
  private start = 0;
  private length = 0;
  private total = 0;

  constructor(private readonly maximumBytes = PROCESS_OUTPUT_TAIL_MAX_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("Process output limit must be a positive safe integer");
    }
    this.bytes = Buffer.alloc(maximumBytes);
  }

  append(value: Uint8Array): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.hash.update(chunk);
    this.total += chunk.length;
    if (chunk.length >= this.maximumBytes) {
      chunk.copy(this.bytes, 0, chunk.length - this.maximumBytes);
      this.start = 0;
      this.length = this.maximumBytes;
      return;
    }

    const writePosition = (this.start + this.length) % this.maximumBytes;
    const firstLength = Math.min(chunk.length, this.maximumBytes - writePosition);
    chunk.copy(this.bytes, writePosition, 0, firstLength);
    if (firstLength < chunk.length) chunk.copy(this.bytes, 0, firstLength);
    const overflow = Math.max(0, this.length + chunk.length - this.maximumBytes);
    this.start = (this.start + overflow) % this.maximumBytes;
    this.length = Math.min(this.maximumBytes, this.length + chunk.length);
  }

  snapshot(): ProcessOutputDiagnostics {
    let tailBytes: Buffer;
    if (this.length === 0) {
      tailBytes = Buffer.alloc(0);
    } else if (this.start + this.length <= this.maximumBytes) {
      tailBytes = Buffer.from(this.bytes.subarray(this.start, this.start + this.length));
    } else {
      const first = this.bytes.subarray(this.start);
      const second = this.bytes.subarray(0, this.length - first.length);
      tailBytes = Buffer.concat([first, second], this.length);
    }
    return {
      tail: tailBytes.toString("utf8"),
      retainedBytes: this.length,
      totalBytes: this.total,
      truncated: this.total > this.length,
      sha256: this.hash.copy().digest("hex"),
    };
  }
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

interface WindowsJobOwnership {
  readonly name: string;
  readonly activeProcessCount: () => number;
  readonly terminate: () => void;
  readonly close: () => void;
}

interface PosixSupervisorOwnership {
  readonly supervisor: ChildProcess;
  readonly controlToken: string;
  release: Promise<void> | null;
}

const windowsJobs = new WeakMap<ChildProcess, WindowsJobOwnership>();
const windowsGracefulTokens = new WeakMap<ChildProcess, string>();
const posixSupervisors = new WeakMap<ChildProcess, PosixSupervisorOwnership>();
const WINDOWS_JOB_NAME = "WI_TEST_SUPPORT_WINDOWS_JOB_NAME";
const WINDOWS_JOB_READY_FD = "WI_TEST_SUPPORT_WINDOWS_JOB_READY_FD";
const WINDOWS_JOB_ACKNOWLEDGEMENT_FD = "WI_TEST_SUPPORT_WINDOWS_JOB_ACKNOWLEDGEMENT_FD";
const WINDOWS_GRACEFUL_TOKEN = "WI_TEST_SUPPORT_WINDOWS_GRACEFUL_TOKEN";
const POSIX_CONTROL_TOKEN = "WI_TEST_SUPPORT_POSIX_CONTROL_TOKEN";
const POSIX_READY_FD = "WI_TEST_SUPPORT_POSIX_READY_FD";
const POSIX_ACKNOWLEDGEMENT_FD = "WI_TEST_SUPPORT_POSIX_ACKNOWLEDGEMENT_FD";

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

async function waitForPosixSupervisorMessage(
  supervisor: ChildProcess,
  type: string,
  controlToken: string,
): Promise<void> {
  let onMessage = (message: unknown): void => {
    void message;
  };
  let onExit = (): void => undefined;
  let onError = (error: Error): void => {
    void error;
  };
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        onMessage = (message: unknown) => {
          if (
            message !== null &&
            typeof message === "object" &&
            "type" in message &&
            message.type === type &&
            "token" in message &&
            message.token === controlToken
          ) {
            resolve();
          }
        };
        onExit = () => reject(new Error("POSIX owner watchdog exited during setup"));
        onError = (error: Error) => reject(error);
        supervisor.on("message", onMessage);
        supervisor.once("exit", onExit);
        supervisor.once("error", onError);
      }),
      5_000,
      () => `POSIX owner watchdog did not report ${type}`,
    );
  } finally {
    supervisor.off("message", onMessage);
    supervisor.off("exit", onExit);
    supervisor.off("error", onError);
  }
}

async function startPosixSupervisor(): Promise<PosixSupervisorOwnership> {
  const controlToken = randomUUID();
  const supervisorPath = fileURLToPath(
    new URL("./posix-process-supervisor.js", import.meta.url),
  );
  const environment = environmentWithValue(
    { ...process.env },
    POSIX_CONTROL_TOKEN,
    controlToken,
  );
  const supervisor = spawn(process.execPath, [supervisorPath], {
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "pipe", "ipc"],
    detached: true,
    windowsHide: true,
  });
  const ownerPipe = supervisor.stdio[3];
  if (ownerPipe === undefined || ownerPipe === null || !("write" in ownerPipe)) {
    supervisor.kill("SIGKILL");
    throw new Error("POSIX owner watchdog has no ownership pipe");
  }
  // SIGKILL closes watchdog channels without a stream-level handshake.
  ownerPipe.on("error", () => undefined);
  supervisor.channel?.on("error", () => undefined);
  try {
    await waitForPosixSupervisorMessage(
      supervisor,
      "wi.test-support.posix-ready",
      controlToken,
    );
    return { supervisor, controlToken, release: null };
  } catch (error) {
    ownerPipe.destroy();
    supervisor.kill("SIGKILL");
    throw error;
  }
}

async function waitForPosixFixtureGate(child: ChildProcess): Promise<void> {
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
    throw new Error("POSIX owner preload has no handshake pipes");
  }
  // The fixture closes these one-use pipes without an application handshake.
  readiness.on("error", () => undefined);
  acknowledgement.on("error", () => undefined);
  let onReady = (): void => undefined;
  let onExit = (): void => undefined;
  let onError = (error: Error): void => {
    void error;
  };
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        onReady = () => resolve();
        onExit = () => reject(new Error("Fixture exited before POSIX ownership was established"));
        onError = (error: Error) => reject(error);
        readiness.once("data", onReady);
        child.once("exit", onExit);
        child.once("error", onError);
      }),
      5_000,
      () => "Fixture did not reach the POSIX ownership gate",
    );
  } finally {
    readiness.off("data", onReady);
    child.off("exit", onExit);
    child.off("error", onError);
  }
  if (child.pid === undefined) throw new Error("POSIX fixture has no process ID");
  const ownership = posixSupervisors.get(child);
  if (ownership === undefined || !ownership.supervisor.connected) {
    throw new Error("POSIX fixture has no live owner watchdog");
  }
  const registered = waitForPosixSupervisorMessage(
    ownership.supervisor,
    "wi.test-support.posix-registered",
    ownership.controlToken,
  );
  ownership.supervisor.send({
    type: "wi.test-support.posix-register",
    token: ownership.controlToken,
    pid: child.pid,
  });
  await registered;
  acknowledgement.write("continue");
}

function releasePosixSupervisor(child: ChildProcess): Promise<void> {
  const ownership = posixSupervisors.get(child);
  if (ownership === undefined) return Promise.resolve();
  if (ownership.release !== null) return ownership.release;
  ownership.release = withTimeout(
    new Promise<void>((resolve, reject) => {
      const supervisor = ownership.supervisor;
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
        resolve();
        return;
      }
      supervisor.once("close", () => resolve());
      supervisor.once("error", reject);
      if (!supervisor.connected) {
        reject(new Error("POSIX owner watchdog disconnected before release"));
        return;
      }
      supervisor.send({
        type: "wi.test-support.posix-release",
        token: ownership.controlToken,
      });
    }),
    2_000,
    () => "POSIX owner watchdog did not release its fixture group",
  ).then(() => {
    posixSupervisors.delete(child);
  });
  return ownership.release;
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
  let posixOwnership: PosixSupervisorOwnership | null = null;
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
  } else {
    posixOwnership = await startPosixSupervisor();
    const preloadUrl = new URL("./posix-owner-preload.js", import.meta.url).href;
    const existingNodeOptions = environment.NODE_OPTIONS?.trim();
    environment = environmentWithValue(
      environment,
      "NODE_OPTIONS",
      `${existingNodeOptions === undefined || existingNodeOptions === "" ? "" : `${existingNodeOptions} `}--import=${preloadUrl}`,
    );
    environment = environmentWithValue(environment, POSIX_READY_FD, "3");
    environment = environmentWithValue(environment, POSIX_ACKNOWLEDGEMENT_FD, "4");
  }

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [...arguments_], {
      env: environment,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        ...(ownership === null && posixOwnership === null
          ? []
          : ["pipe" as const, "pipe" as const]),
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
    } else if (posixOwnership !== null) {
      posixSupervisors.set(child, posixOwnership);
      await waitForPosixFixtureGate(child);
      const managedChild = child;
      const managedOwnership = posixOwnership;
      managedOwnership.supervisor.once("close", () => {
        if (managedOwnership.release !== null || managedChild.pid === undefined) return;
        try {
          process.kill(-managedChild.pid, "SIGKILL");
        } catch {
          // The fixture group may already have completed naturally.
        }
      });
      managedChild.once("close", () => {
        void releasePosixSupervisor(managedChild).catch(() => undefined);
      });
    }
    return child;
  } catch (error) {
    if (ownership !== null) {
      try {
        ownership.terminate();
      } finally {
        ownership.close();
      }
    } else if (posixOwnership !== null) {
      if (child?.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The gated fixture may already be gone.
        }
      }
      posixOwnership.supervisor.stdio[3]?.destroy();
      posixOwnership.supervisor.kill("SIGKILL");
      if (child !== null) posixSupervisors.delete(child);
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
  private readonly messageHistory: ServerProcessMessage[] = [];
  private readonly awaitedMessageTypes = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private readonly stdoutOutput = new BoundedProcessOutput();
  private readonly stderrOutput = new BoundedProcessOutput();
  private totalMessages = 0;
  private pendingMessagesTruncated = false;
  private messageHistoryTruncated = false;
  private readonly closed: Promise<ServerProcessExit>;

  private constructor(readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutOutput.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrOutput.append(chunk);
    });
    child.on("message", (value: unknown) => {
      if (value === null || typeof value !== "object" || !("type" in value)) return;
      const message = value as ServerProcessMessage;
      this.totalMessages += 1;
      this.messages.push(message);
      if (this.messages.length > PROCESS_IPC_PENDING_MAX_MESSAGES) {
        const unawaitedIndex = this.messages.findIndex(
          (candidate) => !this.awaitedMessageTypes.has(candidate.type),
        );
        this.messages.splice(unawaitedIndex >= 0 ? unawaitedIndex : 0, 1);
        this.pendingMessagesTruncated = true;
      }
      this.messageHistory.push(message);
      if (this.messageHistory.length > PROCESS_IPC_HISTORY_MAX_MESSAGES) {
        this.messageHistory.shift();
        this.messageHistoryTruncated = true;
      }
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
    this.closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        const diagnostics = this.diagnostics;
        resolve({
          code,
          signal,
          stdout: diagnostics.stdout.tail,
          stderr: diagnostics.stderr.tail,
          stdoutDiagnostics: diagnostics.stdout,
          stderrDiagnostics: diagnostics.stderr,
          ipcDiagnostics: diagnostics.ipc,
        });
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
    this.awaitedMessageTypes.set(type, (this.awaitedMessageTypes.get(type) ?? 0) + 1);
    try {
      while (true) {
        const index = this.messages.findIndex((message) => message.type === type);
        if (index >= 0) return this.messages.splice(index, 1)[0] as ServerProcessMessage;
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          const exit = await this.closed;
          throw new Error(
            `Server exited before ${type}: code=${String(exit.code)} signal=${String(exit.signal)} ${formatOutputDiagnostics("stderr", exit.stderrDiagnostics)}`,
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for server message ${type}. ${formatOutputDiagnostics("stderr", this.stderrOutput.snapshot())}`,
          );
        }
        let wake = (): void => undefined;
        try {
          await withTimeout(
            new Promise<void>((resolve) => {
              wake = resolve;
              this.waiters.add(wake);
            }),
            remaining,
            () =>
              `Timed out waiting for server message ${type}. ${formatOutputDiagnostics("stderr", this.stderrOutput.snapshot())}`,
          );
        } finally {
          this.waiters.delete(wake);
        }
      }
    } finally {
      const remainingWaiters = (this.awaitedMessageTypes.get(type) ?? 1) - 1;
      if (remainingWaiters === 0) this.awaitedMessageTypes.delete(type);
      else this.awaitedMessageTypes.set(type, remainingWaiters);
    }
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    await signalProcessTree(this.child, signal);
  }

  waitForExit(timeoutMs = 10_000): Promise<ServerProcessExit> {
    return withTimeout(this.closed, timeoutMs, () =>
      `Server process ${String(this.child.pid)} did not exit. ${formatOutputDiagnostics("stderr", this.stderrOutput.snapshot())}`,
    );
  }

  get diagnostics(): ServerProcessDiagnostics {
    return {
      stdout: this.stdoutOutput.snapshot(),
      stderr: this.stderrOutput.snapshot(),
      ipc: {
        totalMessages: this.totalMessages,
        pendingRetainedMessages: this.messages.length,
        historyRetainedMessages: this.messageHistory.length,
        pendingTruncated: this.pendingMessagesTruncated,
        historyTruncated: this.messageHistoryTruncated,
      },
    };
  }

  get receivedMessages(): readonly ServerProcessMessage[] {
    return [...this.messageHistory];
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
  } else {
    try {
      await releasePosixSupervisor(child);
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
