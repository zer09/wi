import { createReadStream, fstatSync } from "node:fs";

const OWNER_FD = 3;
const CONTROL_TOKEN_NAME = "WI_TEST_SUPPORT_POSIX_CONTROL_TOKEN";
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 1_000;

if (process.platform === "win32" || typeof process.send !== "function") process.exit(64);

const controlToken = process.env[CONTROL_TOKEN_NAME];
delete process.env[CONTROL_TOKEN_NAME];
if (controlToken === undefined || controlToken.length === 0) process.exit(65);

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !groupExists(pid);
}

async function reclaimGroup(pid: number, immediate: boolean): Promise<boolean> {
  if (!immediate) {
    signalGroup(pid, "SIGTERM");
    if (await waitForGroupGone(pid, TERM_GRACE_MS)) return true;
  }
  signalGroup(pid, "SIGKILL");
  return waitForGroupGone(pid, KILL_GRACE_MS);
}

let fixturePid: number | null = null;
let settling = false;

function stopWatchdog(): never {
  process.removeAllListeners();
  process.kill(process.pid, "SIGKILL");
  throw new Error("POSIX owner watchdog did not stop");
}

function reclaimAndStop(immediate: boolean): void {
  if (settling) return;
  settling = true;
  if (fixturePid === null) stopWatchdog();
  void reclaimGroup(fixturePid, immediate).then((gone) => {
    if (gone) stopWatchdog();
    // Fail closed: retain the watchdog rather than claim a live group is gone.
    setInterval(() => undefined, 1_000);
  });
}

try {
  fstatSync(OWNER_FD);
} catch {
  process.exit(66);
}

const owner = createReadStream("", { fd: OWNER_FD, autoClose: false });
owner.once("end", () => reclaimAndStop(true));
owner.once("error", () => reclaimAndStop(true));
owner.resume();

process.on("message", (message: unknown) => {
  if (
    message === null ||
    typeof message !== "object" ||
    !("token" in message) ||
    message.token !== controlToken ||
    !("type" in message)
  ) {
    return;
  }
  if (
    message.type === "wi.test-support.posix-register" &&
    "pid" in message &&
    typeof message.pid === "number" &&
    Number.isSafeInteger(message.pid) &&
    message.pid > 0 &&
    fixturePid === null &&
    groupExists(message.pid)
  ) {
    fixturePid = message.pid;
    process.send?.({ type: "wi.test-support.posix-registered", token: controlToken });
    return;
  }
  if (message.type === "wi.test-support.posix-release" && fixturePid !== null) {
    reclaimAndStop(false);
  }
});

process.send({ type: "wi.test-support.posix-ready", token: controlToken });
