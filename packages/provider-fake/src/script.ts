import type {
  ProviderContext,
  ProviderEvent,
  ProviderRequest,
} from "@wi/provider-contract";

export const FAKE_PROVIDER_SCENARIOS = [
  "plain-text",
  "echo-tool-round-trip",
  "approval-round-trip",
  "slow-stream",
  "cancel-before-output",
  "transient-failure-before-output",
  "failure-after-visible-output",
  "partial-tool-call-without-terminal",
  "provider-cleanup-probe",
  "duplicate-call-id-same-arguments",
  "duplicate-call-id-later-step",
  "duplicate-call-id-different-arguments",
  "oversized-tool-arguments",
  "deeply-nested-tool-arguments",
  "multi-operation-transient-recovery",
  "tool-result-then-continuation-failure",
  "stream-closes-without-terminal",
  "provider-never-completes-until-aborted",
] as const;

export type FakeProviderScenario = (typeof FAKE_PROVIDER_SCENARIOS)[number];

export interface FakeProviderConfiguration {
  readonly scenario: FakeProviderScenario;
  /** Server-owned deterministic variation used to exercise the delay tool. */
  readonly roundTripTool?: "echo" | "delay" | "unknown" | "invalid_echo";
}

export interface FakeProviderStep {
  readonly stream: (
    request: ProviderRequest,
    context: ProviderContext,
    controller: FakeProviderController,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
}

export interface FakeProviderScript {
  readonly scenario: FakeProviderScenario;
  readonly steps: readonly FakeProviderStep[];
}

interface GateWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export class FakeProviderController {
  private readonly gates = new Map<string, Set<GateWaiter>>();
  private readonly blockedWaiters = new Map<string, Set<() => void>>();
  readonly abortedLabels = new Set<string>();

  waitUntilBlocked(label: string): Promise<void> {
    if ((this.gates.get(label)?.size ?? 0) > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.blockedWaiters.get(label) ?? new Set<() => void>();
      waiters.add(resolve);
      this.blockedWaiters.set(label, waiters);
    });
  }

  wait(label: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const gate = this.gates.get(label) ?? new Set<GateWaiter>();
      const waiter: GateWaiter = {
        resolve: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          gate.delete(waiter);
          resolve();
        },
        reject,
        signal,
        onAbort: () => {
          gate.delete(waiter);
          this.abortedLabels.add(label);
          reject(signal.reason ?? new DOMException("Fake provider aborted", "AbortError"));
        },
      };
      gate.add(waiter);
      this.gates.set(label, gate);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      for (const notify of this.blockedWaiters.get(label) ?? []) notify();
      this.blockedWaiters.delete(label);
    });
  }

  release(label: string): void {
    const gate = this.gates.get(label);
    if (gate === undefined) return;
    this.gates.delete(label);
    for (const waiter of gate) waiter.resolve();
  }
}

export function fakeProviderGateLabel(
  runId: string,
  gate: "slow" | "before-output" | "partial" | "cleanup" | "never",
): string {
  return `${runId}:${gate}`;
}
