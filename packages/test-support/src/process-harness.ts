import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type Serializable } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BoundedIpcRetention,
  snapshotBoundedIpcValue,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_MESSAGE_TYPE_MAX_CODE_UNITS,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
  type ProcessIpcDiagnostics,
  type ServerProcessMessage,
} from "./bounded-ipc.js";

export {
  PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS,
  PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_MESSAGE_MAX_DEPTH,
  PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_MESSAGE_MAX_NODES,
  PROCESS_IPC_MESSAGE_MAX_STRING_CODE_UNITS,
  PROCESS_IPC_MESSAGE_TYPE_MAX_CODE_UNITS,
  PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
} from "./bounded-ipc.js";
export type {
  ProcessIpcDiagnostics,
  ProcessIpcTruncationDiagnostics,
  ProcessIpcTruncationReason,
  ServerProcessMessage,
} from "./bounded-ipc.js";

export const PROCESS_OUTPUT_TAIL_MAX_BYTES = 64 * 1024;
export const PROCESS_READINESS_MARKER_MAX_BYTES = 4 * 1024;

export interface ProcessOutputDiagnostics {
  readonly tail: string;
  readonly retainedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
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

function formatIpcDiagnostics(diagnostics: ProcessIpcDiagnostics): string {
  const latest = diagnostics.latestTruncation;
  const latestText = latest === null
    ? "none"
    : `${latest.reason}:${latest.originalType ?? "unknown"}:${latest.sha256}:${JSON.stringify(latest.preview)}`;
  return `ipc=${String(diagnostics.totalMessages)} messages pending=${String(diagnostics.pendingRetainedMessages)}/${String(diagnostics.pendingRetainedEstimatedBytes)}B history=${String(diagnostics.historyRetainedMessages)}/${String(diagnostics.historyRetainedEstimatedBytes)}B rejected=${String(diagnostics.rejectedMessages)} latest=${latestText}`;
}

interface PosixSupervisorOwnership {
  readonly supervisor: ChildProcess;
  readonly controlToken: string;
  releaseAttempt: Promise<void> | null;
  explicitCleanupStarted: boolean;
  reclamationAccepted: boolean;
  anchorEstablished: boolean;
}

const posixSupervisors = new WeakMap<ChildProcess, PosixSupervisorOwnership>();
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

async function stopPosixSupervisorAfterSetupFailure(
  supervisor: ChildProcess,
  ownerPipe?: NodeJS.WritableStream & { destroy(): void },
): Promise<void> {
  ownerPipe?.destroy();
  supervisor.kill("SIGKILL");
  if (!(await waitForDirectProcessGone(supervisor, 1_000))) {
    throw new Error("POSIX owner watchdog survived setup failure");
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
  });
  const ownerPipe = supervisor.stdio[3];
  if (ownerPipe === undefined || ownerPipe === null || !("write" in ownerPipe)) {
    await stopPosixSupervisorAfterSetupFailure(supervisor);
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
    return {
      supervisor,
      controlToken,
      releaseAttempt: null,
      explicitCleanupStarted: false,
      reclamationAccepted: false,
      anchorEstablished: false,
    };
  } catch (error) {
    try {
      await stopPosixSupervisorAfterSetupFailure(supervisor, ownerPipe);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "POSIX owner watchdog setup and cleanup failed",
      );
    }
    throw error;
  }
}

async function waitForPosixFixtureGate(
  child: ChildProcess,
  failAfterAnchorForTest: boolean,
): Promise<void> {
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
  const ownership = posixSupervisors.get(child);
  if (ownership === undefined) throw new Error("POSIX fixture has no owner watchdog");
  // Readiness is emitted only after the preload-created anchor joins the group.
  ownership.anchorEstablished = true;
  if (failAfterAnchorForTest) {
    throw new Error("Injected POSIX ownership setup failure after anchor creation");
  }
  if (child.pid === undefined) throw new Error("POSIX fixture has no process ID");
  if (!ownership.supervisor.connected) {
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

async function waitForDirectProcessGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return true;
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function verifyPosixSupervisorRelease(
  child: ChildProcess,
  ownership: PosixSupervisorOwnership,
): Promise<void> {
  if (!(await waitForProcessTreeGone(child, 1_000))) {
    throw new Error(`Fixture process group ${String(child.pid)} remained after watchdog release`);
  }
  if (!(await waitForDirectProcessGone(ownership.supervisor, 1_000))) {
    throw new Error("POSIX owner watchdog remained after release");
  }
}

async function signalDetachedProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (groupError) {
    try {
      child.kill(signal);
    } catch {
      // The process group and leader are already gone.
      if ((groupError as NodeJS.ErrnoException).code !== "ESRCH") throw groupError;
    }
  }
}

async function safelyEscalatePosixSupervisorRelease(
  child: ChildProcess,
  ownership: PosixSupervisorOwnership,
): Promise<void> {
  // Stop the stale watchdog while the anchor still reserves the group identity.
  // Only then may this process reclaim that exact still-owned group itself.
  if (
    ownership.supervisor.exitCode === null &&
    ownership.supervisor.signalCode === null
  ) {
    ownership.supervisor.kill("SIGKILL");
  }
  if (!(await waitForDirectProcessGone(ownership.supervisor, 1_000))) {
    throw new Error("POSIX owner watchdog survived release escalation");
  }
  if (!ownership.reclamationAccepted) {
    await signalDetachedProcessGroup(child, "SIGKILL");
  }
  if (!(await waitForProcessTreeGone(child, 1_000))) {
    const detail = ownership.reclamationAccepted
      ? "remained after its watchdog accepted reclamation"
      : "survived watchdog escalation";
    throw new Error(`Fixture process group ${String(child.pid)} ${detail}`);
  }
}

async function performPosixSupervisorRelease(
  child: ChildProcess,
  ownership: PosixSupervisorOwnership,
): Promise<void> {
  const supervisor = ownership.supervisor;
  if (
    supervisor.exitCode !== null ||
    supervisor.signalCode !== null ||
    !supervisor.connected
  ) {
    await safelyEscalatePosixSupervisorRelease(child, ownership);
    return;
  }

  let onClose = (): void => undefined;
  let onDisconnect = (): void => undefined;
  let onError = (error: Error): void => {
    void error;
  };
  let onMessage = (message: unknown): void => {
    void message;
  };
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        onClose = () => resolve();
        // A normal watchdog self-termination disconnects IPC before its close
        // event. Keep waiting for verified process exit; a disconnected live
        // watchdog times out and is safely escalated by the next attempt.
        onDisconnect = () => undefined;
        onError = (error: Error) => reject(error);
        onMessage = (message: unknown) => {
          if (
            message === null ||
            typeof message !== "object" ||
            !("type" in message) ||
            !("token" in message) ||
            message.token !== ownership.controlToken
          ) {
            return;
          }
          if (message.type === "wi.test-support.posix-release-accepted") {
            // After this authenticated handoff, only the watchdog may have
            // signalled the anchor. Numeric fallback is no longer safe.
            ownership.reclamationAccepted = true;
          } else if (message.type === "wi.test-support.posix-release-error") {
            reject(new Error("POSIX owner watchdog rejected release"));
          }
        };
        supervisor.once("close", onClose);
        supervisor.once("disconnect", onDisconnect);
        supervisor.once("error", onError);
        supervisor.on("message", onMessage);
        try {
          supervisor.send(
            {
              type: "wi.test-support.posix-release",
              token: ownership.controlToken,
            },
            (error) => {
              if (error !== null && error !== undefined) reject(error);
            },
          );
        } catch (error) {
          reject(error);
        }
      }),
      2_000,
      () => "POSIX owner watchdog did not release its fixture group",
    );
  } finally {
    supervisor.off("close", onClose);
    supervisor.off("disconnect", onDisconnect);
    supervisor.off("error", onError);
    supervisor.off("message", onMessage);
  }
  await verifyPosixSupervisorRelease(child, ownership);
}

function releasePosixSupervisor(child: ChildProcess): Promise<void> {
  const ownership = posixSupervisors.get(child);
  if (ownership === undefined) return Promise.resolve();
  if (ownership.releaseAttempt !== null) return ownership.releaseAttempt;

  const attempt = performPosixSupervisorRelease(child, ownership).then(
    () => {
      ownership.supervisor.stdio[3]?.destroy();
      if (posixSupervisors.get(child) === ownership) posixSupervisors.delete(child);
    },
    (error: unknown) => {
      if (ownership.releaseAttempt === attempt) ownership.releaseAttempt = null;
      throw error;
    },
  );
  ownership.releaseAttempt = attempt;
  return attempt;
}

async function cleanupFailedPosixSetup(
  child: ChildProcess | null,
  ownership: PosixSupervisorOwnership,
): Promise<void> {
  ownership.explicitCleanupStarted = true;
  if (child === null) {
    ownership.supervisor.stdio[3]?.destroy();
    ownership.supervisor.kill("SIGKILL");
    if (!(await waitForDirectProcessGone(ownership.supervisor, 1_000))) {
      throw new Error("POSIX owner watchdog survived failed fixture setup");
    }
    return;
  }

  if (ownership.anchorEstablished) {
    // Once readiness proves the anchor exists, the exact group remains safe to reclaim.
    await safelyEscalatePosixSupervisorRelease(child, ownership);
  } else {
    // Before anchor readiness there can be no application descendants. Close the
    // preload gates and wait for the direct child; never signal an unanchored PGID.
    child.stdio[3]?.destroy();
    child.stdio[4]?.destroy();
    ownership.supervisor.stdio[3]?.destroy();
    ownership.supervisor.kill("SIGKILL");
    if (!(await waitForDirectProcessGone(ownership.supervisor, 1_000))) {
      throw new Error("POSIX owner watchdog survived failed fixture setup");
    }
  }
  if (!(await waitForDirectProcessGone(child, 1_000))) {
    throw new Error("Fixture leader survived failed ownership setup");
  }
  ownership.supervisor.stdio[3]?.destroy();
  if (posixSupervisors.get(child) === ownership) posixSupervisors.delete(child);
}

export async function spawnNodeProcessTree(
  arguments_: readonly string[],
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly ipc?: boolean;
  } = {},
): Promise<ChildProcess> {
  if (process.platform !== "linux") {
    throw new Error("The Wi v0.1 process harness supports Linux only");
  }
  let environment = { ...process.env, ...options.environment };
  const posixOwnership = await startPosixSupervisor();
  const preloadUrl = new URL("./posix-owner-preload.js", import.meta.url).href;
  const existingNodeOptions = environment.NODE_OPTIONS?.trim();
  environment = environmentWithValue(
    environment,
    "NODE_OPTIONS",
    `${existingNodeOptions === undefined || existingNodeOptions === "" ? "" : `${existingNodeOptions} `}--import=${preloadUrl}`,
  );
  environment = environmentWithValue(environment, POSIX_READY_FD, "3");
  environment = environmentWithValue(environment, POSIX_ACKNOWLEDGEMENT_FD, "4");

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [...arguments_], {
      env: environment,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        ...(options.ipc === true ? ["ipc" as const] : []),
      ],
      detached: true,
    });
    posixSupervisors.set(child, posixOwnership);
    await waitForPosixFixtureGate(
      child,
      environment.WI_TEST_SUPPORT_POSIX_PRELOAD_TEST_MODE === "fail-after-anchor",
    );
    const managedChild = child;
    posixOwnership.supervisor.once("close", () => {
      if (posixOwnership.releaseAttempt !== null) return;
      // Route unexpected watchdog death through the same anchored escalation.
      void releasePosixSupervisor(managedChild).catch(() => undefined);
    });
    managedChild.once("close", () => {
      if (posixOwnership.explicitCleanupStarted) return;
      void releasePosixSupervisor(managedChild).catch(() => undefined);
    });
    return child;
  } catch (error) {
    try {
      await cleanupFailedPosixSetup(child, posixOwnership);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "POSIX fixture ownership setup and cleanup failed",
      );
    }
    throw error;
  }
}

export class RealServerProcess {
  private readonly awaitedMessageTypes = new Map<string, number>();
  private readonly ipcRetention = new BoundedIpcRetention(
    PROCESS_IPC_PENDING_MAX_MESSAGES,
    PROCESS_IPC_HISTORY_MAX_MESSAGES,
    (type) => this.awaitedMessageTypes.has(type),
  );
  private readonly waiters = new Set<() => void>();
  private readonly stdoutOutput = new BoundedProcessOutput();
  private readonly stderrOutput = new BoundedProcessOutput();
  private readonly closed: Promise<ServerProcessExit>;

  private constructor(readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutOutput.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrOutput.append(chunk);
    });
    child.on("message", (value: unknown) => {
      // Node object IPC deserializes before this callback. Reject over-limit values
      // immediately and retain only a bounded summary; see the architecture docs.
      this.ipcRetention.accept(value);
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
    const snapshot = snapshotBoundedIpcValue(message);
    if (this.child.connected) this.child.send(snapshot);
  }

  async waitForMessage(type: string, timeoutMs = 10_000): Promise<ServerProcessMessage> {
    if (type.length === 0 || type.length > PROCESS_IPC_MESSAGE_TYPE_MAX_CODE_UNITS) {
      throw new RangeError("Server message type exceeds the process IPC limit");
    }
    const deadline = Date.now() + timeoutMs;
    this.awaitedMessageTypes.set(type, (this.awaitedMessageTypes.get(type) ?? 0) + 1);
    try {
      while (true) {
        const message = this.ipcRetention.take(type);
        if (message !== null) return message;
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          const exit = await this.closed;
          throw new Error(
            `Server exited before ${type}: code=${String(exit.code)} signal=${String(exit.signal)} ${formatOutputDiagnostics("stderr", exit.stderrDiagnostics)} ${formatIpcDiagnostics(exit.ipcDiagnostics)}`,
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for server message ${type}. ${formatOutputDiagnostics("stderr", this.stderrOutput.snapshot())} ${formatIpcDiagnostics(this.ipcRetention.snapshot())}`,
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
              `Timed out waiting for server message ${type}. ${formatOutputDiagnostics("stderr", this.stderrOutput.snapshot())} ${formatIpcDiagnostics(this.ipcRetention.snapshot())}`,
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
      `Server process ${String(this.child.pid)} did not exit. ${formatOutputDiagnostics("stderr", this.stderrOutput.snapshot())} ${formatIpcDiagnostics(this.ipcRetention.snapshot())}`,
    );
  }

  get diagnostics(): ServerProcessDiagnostics {
    return {
      stdout: this.stdoutOutput.snapshot(),
      stderr: this.stderrOutput.snapshot(),
      ipc: this.ipcRetention.snapshot(),
    };
  }

  get receivedMessages(): readonly ServerProcessMessage[] {
    return this.ipcRetention.history;
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

export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (posixSupervisors.has(child)) {
    // Keep the anchor alive until the watchdog has durably accepted cleanup.
    // The watchdog reclaims descendants after the signalled leader settles.
    child.kill(signal);
    return;
  }
  await signalDetachedProcessGroup(child, signal);
}

async function waitForProcessTreeGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leaderGone = child.exitCode !== null || child.signalCode !== null;
    if (child.pid === undefined) return leaderGone;
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export async function terminateProcessTree(
  child: ChildProcess,
  terminationGraceMs = 1_000,
): Promise<void> {
  const ownership = posixSupervisors.get(child);
  if (ownership !== undefined) {
    ownership.explicitCleanupStarted = true;
    // The watchdog must accept and finish reclamation before the anchor can
    // disappear. A rejected release retains both ownership and group identity.
    try {
      await releasePosixSupervisor(child);
    } catch (error) {
      throw new AggregateError([error], "Server process cleanup failed");
    }
    return;
  }
  // Unowned detached children still require direct group signalling.
  const errors: unknown[] = [];
  try {
    await signalProcessTree(child, "SIGTERM");
  } catch (error) {
    errors.push(error);
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
