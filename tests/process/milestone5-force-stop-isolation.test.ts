import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(
  new URL("./milestone5-force-stop-isolation-fixture.mjs", import.meta.url),
);
const children = new Set<ChildProcess>();
const homes = new Set<string>();

type ProbeMode = "provider" | "tool";
interface SemaphoreSnapshot {
  readonly active: number;
  readonly accepting: boolean;
}
interface ProbeMessage {
  readonly type: string;
  readonly mode: ProbeMode;
  readonly runId?: string;
  readonly eventType?: string;
  readonly sequence?: number;
  readonly activityCount?: number;
  readonly fulfilled?: boolean;
  readonly errorName?: string | null;
  readonly errorMessage?: string | null;
  readonly runState?: string | null;
  readonly serverAddress?: unknown;
  readonly resourceHandleActive?: boolean;
  readonly scheduler?: {
    readonly provider: SemaphoreSnapshot;
    readonly tool: SemaphoreSnapshot;
  };
  readonly unhandledRejections?: readonly string[];
}

function within<T>(operation: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message())), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function probeHarness(child: ChildProcess): {
  readonly all: readonly ProbeMessage[];
  readonly stderr: () => string;
  readonly waitFor: (type: string, timeoutMs: number) => Promise<ProbeMessage>;
} {
  const inbox: ProbeMessage[] = [];
  const all: ProbeMessage[] = [];
  const wake = new Set<() => void>();
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("message", (value: unknown) => {
    const message = value as ProbeMessage;
    inbox.push(message);
    all.push(message);
    for (const resolve of wake) resolve();
    wake.clear();
  });

  return {
    all,
    stderr: () => stderr,
    waitFor: async (type, timeoutMs) => {
      const take = async (): Promise<ProbeMessage> => {
        while (true) {
          const index = inbox.findIndex((message) => message.type === type);
          if (index >= 0) return inbox.splice(index, 1)[0] as ProbeMessage;
          await new Promise<void>((resolve) => wake.add(resolve));
        }
      };
      return within(take(), timeoutMs, () =>
        `H2 ${type} message did not arrive. stderr=${stderr}`,
      );
    },
  };
}

afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  children.clear();
  await Promise.all([...homes].map((home) => rm(home, { recursive: true, force: true })));
  homes.clear();
});

describe("Milestone 5 force-stop isolation probes", () => {
  it.each(["provider", "tool"] as const)(
    "fails closed for a noncooperative %s resource without claiming isolation",
    async (mode) => {
      const homeDirectory = await mkdtemp(join(tmpdir(), `wi-h2-${mode}-probe-`));
      homes.add(homeDirectory);
      const child = fork(fixturePath, [homeDirectory, mode], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.add(child);
      const harness = probeHarness(child);
      const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
      );

      const started = await harness.waitFor("resource_started", 8_000);
      const heldPermit = mode === "provider" ? started.scheduler?.provider : started.scheduler?.tool;
      expect(heldPermit?.active).toBe(1);
      child.send("shutdown");

      const abortObserved = await harness.waitFor("abort_observed", 2_000);
      const abortPermit =
        mode === "provider"
          ? abortObserved.scheduler?.provider
          : abortObserved.scheduler?.tool;
      expect(abortPermit?.active).toBe(1);

      const postAbort = await harness.waitFor("post_abort_work", 2_000);
      expect(postAbort.resourceHandleActive).toBe(true);
      const postAbortPermit =
        mode === "provider" ? postAbort.scheduler?.provider : postAbort.scheduler?.tool;
      expect(postAbortPermit?.active).toBe(1);

      const exit = await within(closed, 8_000, () =>
        `H2 ${mode} probe did not fail closed. stderr=${harness.stderr()}`,
      );
      children.delete(child);
      expect(exit).toEqual({ code: 1, signal: null });
      expect(harness.all.some((message) => message.type === "run_terminal")).toBe(false);
      expect(harness.all.some((message) => message.type === "post_terminal_work")).toBe(false);
      expect(harness.all.some((message) => message.type === "close_result")).toBe(false);
      expect(harness.all.some((message) => message.type === "unhandled_rejection")).toBe(false);
      expect(harness.stderr()).not.toMatch(/Error|Unhandled|AUDIT_/u);
    },
    25_000,
  );
});
