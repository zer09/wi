import { FifoSemaphore, type SemaphoreState } from "./semaphore.js";
import {
  defaultShutdownWait,
  ShutdownTimeoutError,
  type ShutdownWait,
} from "./shutdown.js";

export interface SchedulerState {
  readonly provider: SemaphoreState;
  readonly tool: SemaphoreState;
}

export class RunScheduler {
  readonly provider: FifoSemaphore;
  readonly tool: FifoSemaphore;
  private readonly shutdownWait: ShutdownWait;

  constructor(options: {
    readonly providerCapacity: number;
    readonly toolCapacity: number;
    readonly shutdownWait?: ShutdownWait;
  }) {
    this.provider = new FifoSemaphore(options.providerCapacity);
    this.tool = new FifoSemaphore(options.toolCapacity);
    this.shutdownWait = options.shutdownWait ?? defaultShutdownWait;
  }

  get state(): SchedulerState {
    return { provider: this.provider.state, tool: this.tool.state };
  }

  withProviderPermit<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    return this.provider.withPermit(signal, task);
  }

  withToolPermit<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    return this.tool.withPermit(signal, task);
  }

  async shutdown(): Promise<void> {
    this.provider.shutdown();
    this.tool.shutdown();
    const drained = Promise.all([this.provider.drain(), this.tool.drain()]).then(() => undefined);
    if (!(await this.shutdownWait(drained))) {
      throw new ShutdownTimeoutError("Run scheduler");
    }
    await drained;
  }
}
