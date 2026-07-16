import type { ProviderStepState, ToolEffectClass } from "@wi/protocol";
import type { ToolExecutionRecord } from "@wi/storage";

export class ToolIdentityError extends Error {
  readonly code = "provider.protocol_error";

  constructor(message: string) {
    super(message);
    this.name = "ToolIdentityError";
  }
}

export function assertCurrentToolEffectClass(
  tool: Pick<ToolExecutionRecord, "callId" | "toolName" | "effectClass">,
  currentEffectClass: ToolEffectClass | null,
): void {
  if (tool.effectClass === null) {
    throw new ToolIdentityError(`Tool call ${tool.callId} has no durable effect classification.`);
  }
  if (currentEffectClass === null) {
    throw new ToolIdentityError(
      `Tool call ${tool.callId} references missing definition ${tool.toolName}.`,
    );
  }
  if (currentEffectClass !== tool.effectClass) {
    throw new ToolIdentityError(
      `Tool call ${tool.callId} effect class changed from ${tool.effectClass} to ${currentEffectClass}.`,
    );
  }
}

export interface StagedToolCallIdentity {
  readonly runId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly argumentsHash: string;
  readonly effectClass: ToolEffectClass | null;
}

// ADR-0008 identity excludes the occurrence step; the ledger row keeps its original step as provenance.
export function sameToolCallIdentity(
  existing: Pick<
    ToolExecutionRecord,
    "runId" | "toolName" | "argumentsJson" | "argumentsHash" | "effectClass"
  >,
  incoming: StagedToolCallIdentity,
): boolean {
  return existing.runId === incoming.runId &&
    existing.toolName === incoming.toolName &&
    existing.argumentsJson === incoming.argumentsJson &&
    existing.argumentsHash === incoming.argumentsHash &&
    (existing.effectClass === null || existing.effectClass === incoming.effectClass);
}

export function providerStepAllowsToolPromotion(state: ProviderStepState): boolean {
  return state === "completed";
}

export interface ProviderRetryFacts {
  readonly transient: boolean;
  readonly semanticOutputCommitted: boolean;
  readonly completedToolCallAccepted: boolean;
  readonly toolStarted: boolean;
  readonly cancelled: boolean;
  readonly attempt: number;
  readonly budget: number;
}

export function canRetryProviderStep(facts: ProviderRetryFacts): boolean {
  return facts.transient &&
    !facts.semanticOutputCommitted &&
    !facts.completedToolCallAccepted &&
    !facts.toolStarted &&
    !facts.cancelled &&
    facts.attempt < facts.budget;
}
