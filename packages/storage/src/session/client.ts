import type { SessionEvent } from "@wi/protocol";

import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  BoundedProviderRequestData,
  BoundedProviderRequestDataInput,
  InputRecord,
  PendingApprovalRecord,
  PendingInputRecord,
  ProviderStepRecord,
  RunMessageRecord,
  RunRecord,
  ToolExecutionRecord,
  SessionCatalogProjection,
  SessionEventPage,
  SessionEventPageInput,
  SessionManifest,
  SessionRecoveryResult,
} from "../types.js";
import type { SessionWorkerPool } from "./worker-pool.js";

export class SessionClient {
  readonly #pool: SessionWorkerPool;
  readonly #beforeUse: (() => Promise<void>) | undefined;
  readonly #afterCommit:
    | ((events: readonly SessionEvent[], headSequence: number) => void)
    | undefined;
  readonly #beforeCommit:
    | ((input: AcceptCommandInput | AppendTransactionInput) => Promise<void>)
    | undefined;

  constructor(
    pool: SessionWorkerPool,
    readonly sessionId: string,
    beforeUse?: () => Promise<void>,
    afterCommit?: (events: readonly SessionEvent[], headSequence: number) => void,
    beforeCommit?: (input: AcceptCommandInput | AppendTransactionInput) => Promise<void>,
  ) {
    this.#pool = pool;
    this.#beforeUse = beforeUse;
    this.#afterCommit = afterCommit;
    this.#beforeCommit = beforeCommit;
  }

  private async prepare(): Promise<void> {
    await this.#beforeUse?.();
  }

  private observeCommit(events: readonly SessionEvent[], headSequence: number): void {
    try {
      this.#afterCommit?.(events, headSequence);
    } catch {
      // The session commit is already durable; later reconciliation can repair observation.
    }
  }

  async getManifest(): Promise<SessionManifest> {
    await this.prepare();
    return this.#pool.getManifest(this.sessionId);
  }

  async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    await this.#beforeCommit?.(input);
    const result = await this.#pool.acceptCommand(this.sessionId, input);
    this.observeCommit(result.events, result.acceptedSequence ?? 0);
    return result;
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult> {
    await this.#beforeCommit?.(input);
    const result = await this.#pool.appendTransaction(this.sessionId, input);
    this.observeCommit(result.events, result.headSequence);
    return result;
  }

  async inspectAppendTransaction(
    input: AppendTransactionInput,
  ): Promise<AppendTransactionInspection> {
    await this.prepare();
    return this.#pool.inspectAppendTransaction(this.sessionId, input);
  }

  async getEventsAfter(
    afterSequence: number,
    throughSequence?: number,
  ): Promise<readonly SessionEvent[]> {
    await this.prepare();
    return this.#pool.getEventsAfter(this.sessionId, afterSequence, throughSequence);
  }

  async getEventPageAfter(
    input: SessionEventPageInput,
    signal?: AbortSignal,
  ): Promise<SessionEventPage> {
    signal?.throwIfAborted();
    await this.prepare();
    signal?.throwIfAborted();
    return this.#pool.getEventPageAfter(this.sessionId, input, signal);
  }

  async getHeadSequence(signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    await this.prepare();
    signal?.throwIfAborted();
    return this.#pool.getHeadSequence(this.sessionId, signal);
  }

  async getEventById(eventId: string): Promise<SessionEvent | null> {
    await this.prepare();
    return this.#pool.getEventById(this.sessionId, eventId);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    await this.prepare();
    return this.#pool.getRun(this.sessionId, runId);
  }

  async getRunProviderMatch(
    runId: string,
    expectedProviderId: string,
  ): Promise<"missing" | "match" | "mismatch"> {
    await this.prepare();
    return this.#pool.getRunProviderMatch(this.sessionId, runId, expectedProviderId);
  }

  async getBoundedProviderRequestData(
    input: BoundedProviderRequestDataInput,
  ): Promise<BoundedProviderRequestData> {
    await this.prepare();
    return this.#pool.getBoundedProviderRequestData(this.sessionId, input);
  }

  async getAcceptedCommand(commandId: string): Promise<AcceptedCommandResult | null> {
    await this.prepare();
    return this.#pool.getAcceptedCommand(this.sessionId, commandId);
  }

  async getProviderStep(stepId: string): Promise<ProviderStepRecord | null> {
    await this.prepare();
    return this.#pool.getProviderStep(this.sessionId, stepId);
  }

  async getProviderStepsForRun(runId: string): Promise<readonly ProviderStepRecord[]> {
    await this.prepare();
    return this.#pool.getProviderStepsForRun(this.sessionId, runId);
  }

  async getRecentProviderStepsForRun(
    runId: string,
    limit: number,
  ): Promise<readonly ProviderStepRecord[]> {
    await this.prepare();
    return this.#pool.getRecentProviderStepsForRun(this.sessionId, runId, limit);
  }

  async getToolExecution(callId: string): Promise<ToolExecutionRecord | null> {
    await this.prepare();
    return this.#pool.getToolExecution(this.sessionId, callId);
  }

  async getToolExecutionsForStep(stepId: string): Promise<readonly ToolExecutionRecord[]> {
    await this.prepare();
    return this.#pool.getToolExecutionsForStep(this.sessionId, stepId);
  }

  async getToolExecutionsForRun(runId: string): Promise<readonly ToolExecutionRecord[]> {
    await this.prepare();
    return this.#pool.getToolExecutionsForRun(this.sessionId, runId);
  }

  async getRunMessages(runId: string): Promise<readonly RunMessageRecord[]> {
    await this.prepare();
    return this.#pool.getRunMessages(this.sessionId, runId);
  }

  async getStreamingMessagesForStep(stepId: string): Promise<readonly RunMessageRecord[]> {
    await this.prepare();
    return this.#pool.getStreamingMessagesForStep(this.sessionId, stepId);
  }

  async getNonterminalRuns(): Promise<readonly RunRecord[]> {
    await this.prepare();
    return this.#pool.getNonterminalRuns(this.sessionId);
  }

  async getCatalogProjection(): Promise<SessionCatalogProjection> {
    await this.prepare();
    return this.#pool.getCatalogProjection(this.sessionId);
  }

  async getPendingApprovals(): Promise<readonly PendingApprovalRecord[]> {
    await this.prepare();
    return this.#pool.getPendingApprovals(this.sessionId);
  }

  async getPendingInputs(): Promise<readonly PendingInputRecord[]> {
    await this.prepare();
    return this.#pool.getPendingInputs(this.sessionId);
  }

  async getInput(inputId: string): Promise<InputRecord | null> {
    await this.prepare();
    return this.#pool.getInput(this.sessionId, inputId);
  }

  async getPendingInputCount(): Promise<number> {
    await this.prepare();
    return this.#pool.getPendingInputCount(this.sessionId);
  }

  async recover(): Promise<SessionRecoveryResult> {
    await this.prepare();
    return this.#pool.recover(this.sessionId);
  }

  close(): Promise<void> {
    return this.#pool.closeSession(this.sessionId);
  }
}
