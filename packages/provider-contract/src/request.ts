import type { CanonicalJsonValue } from "@wi/protocol";

export interface ProviderMessageInput {
  readonly type: "message";
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export interface ProviderToolResultInput {
  readonly type: "tool_result";
  readonly callId: string;
  readonly toolName: string;
  readonly outcome: "completed" | "failed" | "denied" | "cancelled";
  readonly result: CanonicalJsonValue | null;
  readonly error: CanonicalJsonValue | null;
}

export type ProviderInputItem = ProviderMessageInput | ProviderToolResultInput;

export interface ProviderRequest {
  readonly runId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly providerConfig: CanonicalJsonValue;
  readonly input: readonly ProviderInputItem[];
}

export interface ProviderContext {
  readonly sessionId: string;
  /** Zero for the first attempt; incremented only by a permitted pre-output retry. */
  readonly attempt: number;
  readonly now: () => number;
}
