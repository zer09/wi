import type { ProviderEvent } from "./events.js";
import type { ProviderContext, ProviderRequest } from "./request.js";

export interface ProviderAdapter {
  readonly id: string;

  stream(
    request: ProviderRequest,
    context: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
