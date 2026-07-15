import { canonicalJson, type CanonicalJsonValue } from "@wi/protocol";

export const TOOL_ARGUMENT_LIMITS = {
  maxBytes: 64 * 1024,
  maxDepth: 32,
  maxStringBytes: 16 * 1024,
  maxCollectionEntries: 256,
  maxValues: 2_048,
} as const;

const encoder = new TextEncoder();

export class ToolArgumentsJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentsJsonError";
  }
}

function assertBoundedText(argumentsJson: string): void {
  // This cheap code-unit check prevents allocating another huge buffer just to measure bytes.
  if (argumentsJson.length > TOOL_ARGUMENT_LIMITS.maxBytes) {
    throw new ToolArgumentsJsonError("Tool arguments exceed the byte limit");
  }
  if (encoder.encode(argumentsJson).byteLength > TOOL_ARGUMENT_LIMITS.maxBytes) {
    throw new ToolArgumentsJsonError("Tool arguments exceed the byte limit");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringCodeUnits = 0;
  for (const character of argumentsJson) {
    if (inString) {
      if (escaped) {
        escaped = false;
        stringCodeUnits += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        stringCodeUnits += 1;
        continue;
      }
      if (character === '"') {
        inString = false;
        continue;
      }
      stringCodeUnits += character.length;
      if (stringCodeUnits > TOOL_ARGUMENT_LIMITS.maxStringBytes) {
        throw new ToolArgumentsJsonError("Tool argument string exceeds the string limit");
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      stringCodeUnits = 0;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > TOOL_ARGUMENT_LIMITS.maxDepth) {
        throw new ToolArgumentsJsonError("Tool arguments exceed the nesting limit");
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

function assertBoundedValue(value: CanonicalJsonValue): void {
  const pending: CanonicalJsonValue[] = [value];
  let valueCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    valueCount += 1;
    if (valueCount > TOOL_ARGUMENT_LIMITS.maxValues) {
      throw new ToolArgumentsJsonError("Tool arguments exceed the value-count limit");
    }
    if (typeof current === "string") {
      if (encoder.encode(current).byteLength > TOOL_ARGUMENT_LIMITS.maxStringBytes) {
        throw new ToolArgumentsJsonError("Tool argument string exceeds the string limit");
      }
      continue;
    }
    if (current === null || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      if (current.length > TOOL_ARGUMENT_LIMITS.maxCollectionEntries) {
        throw new ToolArgumentsJsonError("Tool argument array exceeds the collection limit");
      }
      pending.push(...current);
      continue;
    }

    const entries = Object.entries(current);
    if (entries.length > TOOL_ARGUMENT_LIMITS.maxCollectionEntries) {
      throw new ToolArgumentsJsonError("Tool argument object exceeds the collection limit");
    }
    for (const [key, child] of entries) {
      if (encoder.encode(key).byteLength > TOOL_ARGUMENT_LIMITS.maxStringBytes) {
        throw new ToolArgumentsJsonError("Tool argument key exceeds the string limit");
      }
      pending.push(child);
    }
  }
}

export function parseBoundedToolArgumentsJson(argumentsJson: string): {
  readonly value: CanonicalJsonValue;
  readonly argumentsJson: string;
} {
  assertBoundedText(argumentsJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new ToolArgumentsJsonError("Tool arguments are not valid JSON");
  }

  const value = parsed as CanonicalJsonValue;
  assertBoundedValue(value);
  let normalized: string;
  try {
    normalized = canonicalJson(value);
  } catch {
    throw new ToolArgumentsJsonError("Tool arguments are not canonical JSON values");
  }
  return { value, argumentsJson: normalized };
}
