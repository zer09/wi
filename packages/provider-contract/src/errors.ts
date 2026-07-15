export type ProviderErrorCategory =
  | "transient"
  | "transport"
  | "terminal"
  | "protocol";

export class ProviderAdapterError extends Error {
  constructor(
    readonly category: ProviderErrorCategory,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderAdapterError";
  }
}

export class ProviderProtocolError extends ProviderAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol", message, false, options);
    this.name = "ProviderProtocolError";
  }
}
