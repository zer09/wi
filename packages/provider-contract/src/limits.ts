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
  toolCallMaxCountPerStep: 256,
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

interface JsonBounds {
  readonly label: string;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

function jsonStringByteLength(value: string, options: JsonBounds): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
      const next = value.charCodeAt(index + 1);
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > options.maxBytes) {
      throw new ProviderBoundaryError(
        `${options.label} exceeds ${options.maxBytes} UTF-8 bytes.`,
      );
    }
  }
  return bytes;
}

export function cloneJsonWithinBounds(value: unknown, options: JsonBounds): unknown {
  let nodes = 0;
  let bytes = 0;

  const addBytes = (count: number): void => {
    bytes += count;
    if (bytes > options.maxBytes) {
      throw new ProviderBoundaryError(
        `${options.label} exceeds ${options.maxBytes} UTF-8 bytes.`,
      );
    }
  };

  const visit = (current: unknown, depth: number, ancestors: readonly object[]): unknown => {
    nodes += 1;
    if (nodes > options.maxNodes) {
      throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxNodes} values.`);
    }
    if (current === null) {
      addBytes(4);
      return null;
    }
    switch (typeof current) {
      case "string":
        addBytes(jsonStringByteLength(current, options));
        return current;
      case "boolean":
        addBytes(current ? 4 : 5);
        return current;
      case "number": {
        if (!Number.isFinite(current)) {
          throw new ProviderBoundaryError(`${options.label} contains a non-finite number.`);
        }
        const encoded = JSON.stringify(current);
        if (encoded === undefined) {
          throw new ProviderBoundaryError(`${options.label} is not serializable JSON.`);
        }
        addBytes(encoded.length);
        return current;
      }
      case "object":
        break;
      default:
        throw new ProviderBoundaryError(`${options.label} is not serializable JSON.`);
    }

    if (depth > options.maxDepth) {
      throw new ProviderBoundaryError(
        `${options.label} exceeds nesting depth ${options.maxDepth}.`,
      );
    }
    if (ancestors.includes(current)) {
      throw new ProviderBoundaryError(`${options.label} contains a cycle.`);
    }
    const nextAncestors = [...ancestors, current];
    if (Array.isArray(current)) {
      const length = current.length;
      const remainingNodes = options.maxNodes - nodes;
      if (!Number.isSafeInteger(length) || length < 0 || length > remainingNodes) {
        throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxNodes} values.`);
      }
      addBytes(2 + Math.max(0, length - 1));
      const clone: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) {
        clone[index] = visit(current[index], depth + 1, nextAncestors);
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProviderBoundaryError(`${options.label} contains a non-JSON object.`);
    }
    addBytes(2);
    const clone = Object.create(null) as Record<string, unknown>;
    let propertyCount = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      // Check the remaining budget before reading a getter or retaining another child.
      if (nodes >= options.maxNodes) {
        throw new ProviderBoundaryError(`${options.label} exceeds ${options.maxNodes} values.`);
      }
      if (propertyCount > 0) addBytes(1);
      addBytes(jsonStringByteLength(key, options) + 1);
      propertyCount += 1;
      clone[key] = visit(
        (current as Record<string, unknown>)[key],
        depth + 1,
        nextAncestors,
      );
    }
    return clone;
  };

  return visit(value, 1, []);
}

export function assertJsonBounds(value: unknown, options: JsonBounds): void {
  cloneJsonWithinBounds(value, options);
}
