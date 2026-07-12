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
  ) {}

  private async prepare(): Promise<void> {
    await this.beforeUse?.();
  }

  async getManifest(): Promise<SessionManifest> {
    await this.prepare();
    return this.pool.getManifest(this.sessionId);
  }

  async acceptCommandWithCommitStatus(
    input: AcceptCommandInput,
  ): Promise<AcceptedCommandResult & { readonly catalogUpdated: boolean }> {
    await this.prepare();
    const observed = await this.pool.acceptCommandWithCommitStatus(this.sessionId, input);
    return { ...observed.result, catalogUpdated: observed.catalogUpdated };
  }

  async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    const { catalogUpdated, ...result } = await this.acceptCommandWithCommitStatus(input);
    void catalogUpdated;
    return result;
  }

  async appendTransactionWithCommitStatus(
    input: AppendTransactionInput,
  ): Promise<AppendTransactionResult & { readonly catalogUpdated: boolean }> {
    await this.prepare();
    const observed = await this.pool.appendTransactionWithCommitStatus(this.sessionId, input);
    return { ...observed.result, catalogUpdated: observed.catalogUpdated };
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult> {
    const { catalogUpdated, ...result } = await this.appendTransactionWithCommitStatus(input);
    void catalogUpdated;
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
