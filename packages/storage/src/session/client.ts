import type { SessionEvent } from "@wi/protocol";

import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionResult,
  PendingApprovalRecord,
  RunRecord,
  SessionCatalogProjection,
  SessionManifest,
  SessionRecoveryResult,
} from "../types.js";
import type { SessionWorkerPool } from "./worker-pool.js";

export class SessionClient {
  constructor(
    private readonly pool: SessionWorkerPool,
    readonly sessionId: string,
    private readonly beforeUse?: () => Promise<void>,
    private readonly afterCommit?: (
      events: readonly SessionEvent[],
      headSequence: number,
    ) => void,
  ) {}

  private async prepare(): Promise<void> {
    await this.beforeUse?.();
  }

  private observeCommit(events: readonly SessionEvent[], headSequence: number): void {
    try {
      this.afterCommit?.(events, headSequence);
    } catch {
      // The session commit is already durable; later reconciliation can repair observation.
    }
  }

  async getManifest(): Promise<SessionManifest> {
    await this.prepare();
    return this.pool.getManifest(this.sessionId);
  }

  async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    const result = await this.pool.acceptCommand(this.sessionId, input);
    this.observeCommit(result.events, result.acceptedSequence ?? 0);
    return result;
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult> {
    const result = await this.pool.appendTransaction(this.sessionId, input);
    this.observeCommit(result.events, result.headSequence);
    return result;
  }

  async getEventsAfter(
    afterSequence: number,
    throughSequence?: number,
  ): Promise<readonly SessionEvent[]> {
    await this.prepare();
    return this.pool.getEventsAfter(this.sessionId, afterSequence, throughSequence);
  }

  async getHeadSequence(): Promise<number> {
    await this.prepare();
    return this.pool.getHeadSequence(this.sessionId);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    await this.prepare();
    return this.pool.getRun(this.sessionId, runId);
  }

  async getCatalogProjection(): Promise<SessionCatalogProjection> {
    await this.prepare();
    return this.pool.getCatalogProjection(this.sessionId);
  }

  async getPendingApprovals(): Promise<readonly PendingApprovalRecord[]> {
    await this.prepare();
    return this.pool.getPendingApprovals(this.sessionId);
  }

  async getPendingInputCount(): Promise<number> {
    await this.prepare();
    return this.pool.getPendingInputCount(this.sessionId);
  }

  async recover(): Promise<SessionRecoveryResult> {
    await this.prepare();
    return this.pool.recover(this.sessionId);
  }

  close(): Promise<void> {
    return this.pool.closeSession(this.sessionId);
  }
}
