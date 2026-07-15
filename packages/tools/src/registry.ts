import { canonicalJson, type CanonicalJsonValue } from "@wi/protocol";

import { parseBoundedToolArgumentsJson, ToolArgumentsJsonError } from "./arguments.js";
import {
  eraseToolDefinition,
  type AnyToolDefinition,
  type ToolDefinition,
} from "./definition.js";

export class ToolRegistryError extends Error {
  constructor(
    readonly code: "tool.unknown" | "tool.invalid_arguments" | "tool.duplicate_definition",
    message: string,
  ) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export interface ValidatedToolCall {
  readonly definition: AnyToolDefinition;
  readonly input: unknown;
  readonly argumentsJson: string;
  readonly arguments: CanonicalJsonValue;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, AnyToolDefinition>();

  constructor(definitions: readonly AnyToolDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<TInput>(definition: ToolDefinition<TInput>): void {
    if (this.definitions.has(definition.name)) {
      throw new ToolRegistryError(
        "tool.duplicate_definition",
        `Tool ${definition.name} is already registered`,
      );
    }
    if (definition.executionMode !== "cooperative_in_process") {
      throw new RangeError(`Tool ${definition.name} must use cooperative in-process execution`);
    }
    if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1) {
      throw new RangeError(`Tool ${definition.name} timeout must be a positive safe integer`);
    }
    this.definitions.set(definition.name, eraseToolDefinition(definition));
  }

  get(name: string): AnyToolDefinition | null {
    return this.definitions.get(name) ?? null;
  }

  list(): readonly AnyToolDefinition[] {
    return [...this.definitions.values()];
  }

  validate(name: string, argumentsJson: string): ValidatedToolCall {
    const definition = this.get(name);
    if (definition === null) {
      throw new ToolRegistryError("tool.unknown", `Unknown tool ${name}`);
    }

    let parsed: CanonicalJsonValue;
    try {
      parsed = parseBoundedToolArgumentsJson(argumentsJson).value;
    } catch (error) {
      const reason =
        error instanceof ToolArgumentsJsonError ? error.message : "Tool arguments are not valid JSON";
      throw new ToolRegistryError("tool.invalid_arguments", `Tool ${name}: ${reason}`);
    }
    const decoded = definition.inputSchema.safeParse(parsed);
    if (!decoded.success) {
      throw new ToolRegistryError(
        "tool.invalid_arguments",
        `Tool ${name} arguments do not match its input schema`,
      );
    }

    const canonical = canonicalJson(decoded.data);
    return {
      definition,
      input: decoded.data,
      argumentsJson: canonical,
      arguments: decoded.data as CanonicalJsonValue,
    };
  }
}
