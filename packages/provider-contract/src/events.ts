interface ProviderEventIdentity {
  readonly runId: string;
  readonly stepId: string;
  readonly stepIndex: number;
}

export interface ProviderResponseStartedEvent extends ProviderEventIdentity {
  readonly type: "response.started";
  readonly responseId: string;
}

export interface ProviderTextDeltaEvent extends ProviderEventIdentity {
  readonly type: "text.delta";
  readonly delta: string;
}

export interface ProviderToolCallCompletedEvent extends ProviderEventIdentity {
  readonly type: "tool_call.completed";
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ProviderResponseCompletedEvent extends ProviderEventIdentity {
  readonly type: "response.completed";
  readonly responseId: string;
}

export interface ProviderResponseFailedEvent extends ProviderEventIdentity {
  readonly type: "response.failed";
  readonly category: "transient" | "transport" | "terminal" | "protocol";
  readonly message: string;
  readonly retryable: boolean;
}

export type ProviderEvent =
  | ProviderResponseStartedEvent
  | ProviderTextDeltaEvent
  | ProviderToolCallCompletedEvent
  | ProviderResponseCompletedEvent
  | ProviderResponseFailedEvent;
