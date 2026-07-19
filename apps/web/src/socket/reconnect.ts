export interface ReconnectPolicyOptions {
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

export class ReconnectPolicy {
  private readonly baseDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private attempt = 0;

  constructor(options: ReconnectPolicyOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maximumDelayMs = options.maximumDelayMs ?? 10_000;
    this.jitterRatio = options.jitterRatio ?? 0.25;
    this.random = options.random ?? Math.random;
    if (!Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 1) {
      throw new RangeError("Reconnect base delay must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.maximumDelayMs) ||
      this.maximumDelayMs < this.baseDelayMs
    ) {
      throw new RangeError("Reconnect maximum delay must be an integer at least as large as base delay");
    }
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new RangeError("Reconnect jitter ratio must be between zero and one");
    }
  }

  nextDelayMs(): number {
    const exponential = Math.min(
      this.maximumDelayMs,
      this.baseDelayMs * 2 ** Math.min(this.attempt, 30),
    );
    this.attempt += 1;
    const sample = this.random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError("Reconnect random source must return a value in [0, 1)");
    }
    const factor = 1 + (sample * 2 - 1) * this.jitterRatio;
    return Math.min(this.maximumDelayMs, Math.max(1, Math.round(exponential * factor)));
  }

  reset(): void {
    this.attempt = 0;
  }
}
