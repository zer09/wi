/**
 * Provider-neutral runtime boundary limits. Every `MaxBytes` value is measured in UTF-8;
 * request/config/event sizes include their complete JSON encoding. Container depth counts the
 * root object or array as depth 1. Decoders preflight depth and node count before Zod parsing.
 */
export const PROVIDER_LIMITS = {
  providerConfigMaxBytes: 48 * 1024,
  providerConfigMaxDepth: 32,
  providerConfigMaxNodes: 4_096,
  inputItemMaxCount: 256,
  requestMaxBytes: 512 * 1024,
  requestMaxDepth: 34,
  requestMaxNodes: 16_384,
  messageTextMaxBytes: 16 * 1024,
  textDeltaMaxBytes: 16 * 1024,
  toolNameMaxBytes: 256,
  toolArgumentsMaxBytes: 48 * 1024,
  failureMessageMaxBytes: 8 * 1024,
  responseIdMaxBytes: 256,
  eventMaxBytes: 49_907,
  eventMaxDepth: 1,
  eventMaxNodes: 32,
} as const;

const encoder = new TextEncoder();

export class ProviderBoundaryError extends Error {
  readonly code = "provider.protocol_error";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderBoundaryError";
  }
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function assertUtf8ByteLimit(value: string, maxBytes: number, label: string): void {
  if (value.length > maxBytes || utf8ByteLength(value) > maxBytes) {
    throw new ProviderBoundaryError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  }
}

export function jsonByteLength(value: unknown): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new ProviderBoundaryError("Provider value is not serializable JSON.", { cause: error });
  }
  if (encoded === undefined) {
    throw new ProviderBoundaryError("Provider value is not serializable JSON.");
  }
  return utf8ByteLength(encoded);
}

export function assertJsonBounds(
  value: unknown,
  options: {
    readonly label: string;
    readonly maxBytes: number;
    readonly maxDepth: number;
    readonly maxNodes: number;
  },
): void {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly ancestors: readonly object[];
  }[] = [{ value, depth: 1, ancestors: [] }];
  let nodes = 0;
  let minimumBytes = 0;

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    nodes += 1;
    if (nodes > options.maxNodes) {
      throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxNodes} values.`);
    }
    const current = entry.value;
    if (typeof current === "string") {
      if (current.length > options.maxBytes) {
        throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxBytes} UTF-8 bytes.`);
      }
      minimumBytes += utf8ByteLength(current);
    } else if (current !== null && typeof current === "object") {
      if (entry.depth > options.maxDepth) {
        throw new ProviderBoundaryError(
          `${options.label} exceeds nesting depth ${options.maxDepth}.`,
        );
      }
      if (entry.ancestors.includes(current)) {
        throw new ProviderBoundaryError(`${options.label} contains a cycle.`);
      }
      const ancestors = [...entry.ancestors, current];
      if (Array.isArray(current)) {
        for (let index = current.length - 1; index >= 0; index -= 1) {
          pending.push({
            value: current[index],
            depth: entry.depth + 1,
            ancestors,
          });
        }
      } else {
        for (const [key, child] of Object.entries(current)) {
          minimumBytes += utf8ByteLength(key);
          pending.push({ value: child, depth: entry.depth + 1, ancestors });
        }
      }
    }
    if (minimumBytes > options.maxBytes) {
      throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxBytes} UTF-8 bytes.`);
    }
  }

  if (jsonByteLength(value) > options.maxBytes) {
    throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxBytes} UTF-8 bytes.`);
  }
}
