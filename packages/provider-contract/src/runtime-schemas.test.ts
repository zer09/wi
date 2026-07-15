import { describe, expect, it } from "vitest";

import {
  PROVIDER_LIMITS,
  ProviderBoundaryError,
  assertJsonBounds,
  decodeProviderEvent,
  decodeProviderRequest,
  jsonByteLength,
} from "./index.js";

const identity = {
  runId: "run_runtime",
  stepId: "step_runtime",
  stepIndex: 0,
} as const;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: identity.runId,
    stepId: identity.stepId,
    stepIndex: identity.stepIndex,
    providerConfig: {},
    input: [],
    ...overrides,
  };
}

function objectAtJsonBytes(maxBytes: number): { readonly value: string } {
  const empty = { value: "" };
  const overhead = jsonByteLength(empty);
  return { value: "x".repeat(maxBytes - overhead) };
}

function nestedObject(depth: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}

function requestAtByteLimit(): Record<string, unknown> {
  const input = Array.from({ length: 32 }, () => ({
    type: "message" as const,
    role: "user" as const,
    text: "",
  }));
  const value = request({ input });
  let remaining = PROVIDER_LIMITS.requestMaxBytes - jsonByteLength(value);
  for (const item of input) {
    const added = Math.min(remaining, PROVIDER_LIMITS.messageTextMaxBytes);
    item.text = "x".repeat(added);
    remaining -= added;
  }
  if (remaining !== 0) throw new Error("Request fixture cannot reach the exact byte limit");
  return value;
}

function maxEvent(): Record<string, unknown> {
  const suffix = "A".repeat(120);
  return {
    type: "tool_call.completed",
    runId: `run_${suffix}`,
    stepId: `step_${suffix}`,
    stepIndex: Number.MAX_SAFE_INTEGER,
    callId: `call_${suffix}`,
    name: "n".repeat(PROVIDER_LIMITS.toolNameMaxBytes),
    argumentsJson: `"${"x".repeat(PROVIDER_LIMITS.toolArgumentsMaxBytes - 2)}"`,
  };
}

describe("provider runtime request schemas", () => {
  it("rejects a wide proxy array before reading or retaining its children", () => {
    let indexReads = 0;
    const wide = new Proxy(new Array(100_000), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(() =>
      assertJsonBounds(wide, {
        label: "Width probe",
        maxBytes: PROVIDER_LIMITS.requestMaxBytes,
        maxDepth: PROVIDER_LIMITS.requestMaxDepth,
        maxNodes: 32,
      }),
    ).toThrowError("Width probe exceeds 32 values.");
    expect(indexReads).toBe(0);
  });

  it("stops reading wide object properties at the node budget", () => {
    const source = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`value${index}`, index]),
    );
    let propertyReads = 0;
    const wide = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && property.startsWith("value")) propertyReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(() =>
      assertJsonBounds(wide, {
        label: "Width probe",
        maxBytes: PROVIDER_LIMITS.requestMaxBytes,
        maxDepth: PROVIDER_LIMITS.requestMaxDepth,
        maxNodes: 32,
      }),
    ).toThrowError("Width probe exceeds 32 values.");
    expect(propertyReads).toBeLessThanOrEqual(31);
  });

  it("matches JSON byte accounting for escaped strings and keys", () => {
    const value = { 'quote" slash\\ control\n\0 lone\ud800': ["😀", "\b\t\f\r"] };
    const exactBytes = jsonByteLength(value);
    expect(() =>
      assertJsonBounds(value, {
        label: "Escaped probe",
        maxBytes: exactBytes,
        maxDepth: 3,
        maxNodes: 4,
      }),
    ).not.toThrow();
    expect(() =>
      assertJsonBounds(value, {
        label: "Escaped probe",
        maxBytes: exactBytes - 1,
        maxDepth: 3,
        maxNodes: 4,
      }),
    ).toThrow(ProviderBoundaryError);
  });

  it("accepts and rejects the provider configuration byte boundary", () => {
    const exact = objectAtJsonBytes(PROVIDER_LIMITS.providerConfigMaxBytes);
    expect(jsonByteLength(exact)).toBe(PROVIDER_LIMITS.providerConfigMaxBytes);
    expect(() => decodeProviderRequest(request({ providerConfig: exact }))).not.toThrow();
    expect(() =>
      decodeProviderRequest(
        request({ providerConfig: { value: `${exact.value}x` } }),
      ),
    ).toThrow(ProviderBoundaryError);
  });

  it("accepts and rejects the provider configuration depth boundary", () => {
    expect(() =>
      decodeProviderRequest(
        request({ providerConfig: nestedObject(PROVIDER_LIMITS.providerConfigMaxDepth) }),
      ),
    ).not.toThrow();
    expect(() =>
      decodeProviderRequest(
        request({ providerConfig: nestedObject(PROVIDER_LIMITS.providerConfigMaxDepth + 1) }),
      ),
    ).toThrow(ProviderBoundaryError);
  });

  it("accepts and rejects the input item-count boundary", () => {
    const item = { type: "message", role: "user", text: "" } as const;
    expect(() =>
      decodeProviderRequest(
        request({ input: Array.from({ length: PROVIDER_LIMITS.inputItemMaxCount }, () => item) }),
      ),
    ).not.toThrow();
    expect(() =>
      decodeProviderRequest(
        request({ input: Array.from({ length: PROVIDER_LIMITS.inputItemMaxCount + 1 }, () => item) }),
      ),
    ).toThrow(ProviderBoundaryError);
  });

  it("accepts and rejects the total request byte boundary", () => {
    const exact = requestAtByteLimit();
    expect(jsonByteLength(exact)).toBe(PROVIDER_LIMITS.requestMaxBytes);
    expect(() => decodeProviderRequest(exact)).not.toThrow();
    const input = exact.input as { text: string }[];
    const final = input.at(-1);
    if (final === undefined) throw new Error("Request fixture has no final item");
    final.text += "x";
    expect(jsonByteLength(exact)).toBe(PROVIDER_LIMITS.requestMaxBytes + 1);
    expect(() => decodeProviderRequest(exact)).toThrow(ProviderBoundaryError);
  });

  it("measures message text in UTF-8 bytes", () => {
    const exact = "é".repeat(PROVIDER_LIMITS.messageTextMaxBytes / 2);
    expect(() =>
      decodeProviderRequest(
        request({ input: [{ type: "message", role: "user", text: exact }] }),
      ),
    ).not.toThrow();
    expect(() =>
      decodeProviderRequest(
        request({ input: [{ type: "message", role: "user", text: `${exact}x` }] }),
      ),
    ).toThrow(ProviderBoundaryError);
  });

  it.each([
    ["missing run identity", request({ runId: undefined })],
    ["wrong step index type", request({ stepIndex: "0" })],
    ["invalid negative step index", request({ stepIndex: -1 })],
    ["extra request field", request({ extra: true })],
    [
      "contradictory completed tool result",
      request({
        input: [
          {
            type: "tool_result",
            callId: "call_runtime",
            toolName: "echo",
            outcome: "completed",
            result: { text: "ok" },
            error: { message: "also failed" },
          },
        ],
      }),
    ],
  ] as const)("rejects %s", (_name, value) => {
    expect(() => decodeProviderRequest(value)).toThrow(ProviderBoundaryError);
  });
});

describe("provider runtime event schemas", () => {
  it("accepts and rejects text-delta, tool-name, arguments, and failure byte boundaries", () => {
    const exactDelta = "é".repeat(PROVIDER_LIMITS.textDeltaMaxBytes / 2);
    expect(() =>
      decodeProviderEvent({ type: "text.delta", ...identity, delta: exactDelta }),
    ).not.toThrow();
    expect(() =>
      decodeProviderEvent({ type: "text.delta", ...identity, delta: `${exactDelta}x` }),
    ).toThrow(ProviderBoundaryError);

    const exactName = "n".repeat(PROVIDER_LIMITS.toolNameMaxBytes);
    const exactArguments = `"${"x".repeat(PROVIDER_LIMITS.toolArgumentsMaxBytes - 2)}"`;
    expect(() =>
      decodeProviderEvent({
        type: "tool_call.completed",
        ...identity,
        callId: "call_runtime",
        name: exactName,
        argumentsJson: exactArguments,
      }),
    ).not.toThrow();
    expect(() =>
      decodeProviderEvent({
        type: "tool_call.completed",
        ...identity,
        callId: "call_runtime",
        name: `${exactName}x`,
        argumentsJson: "{}",
      }),
    ).toThrow(ProviderBoundaryError);
    expect(() =>
      decodeProviderEvent({
        type: "tool_call.completed",
        ...identity,
        callId: "call_runtime",
        name: "echo",
        argumentsJson: `${exactArguments}x`,
      }),
    ).toThrow(ProviderBoundaryError);

    const exactFailure = "f".repeat(PROVIDER_LIMITS.failureMessageMaxBytes);
    expect(() =>
      decodeProviderEvent({
        type: "response.failed",
        ...identity,
        category: "transport",
        message: exactFailure,
        retryable: true,
      }),
    ).not.toThrow();
    expect(() =>
      decodeProviderEvent({
        type: "response.failed",
        ...identity,
        category: "transport",
        message: `${exactFailure}x`,
        retryable: true,
      }),
    ).toThrow(ProviderBoundaryError);
  });

  it("accepts the exact event byte/depth limit and rejects one beyond", () => {
    const exact = maxEvent();
    expect(jsonByteLength(exact)).toBe(PROVIDER_LIMITS.eventMaxBytes);
    expect(() => decodeProviderEvent(exact)).not.toThrow();
    const argumentsJson = String(exact.argumentsJson);
    exact.argumentsJson = `${argumentsJson}x`;
    expect(() => decodeProviderEvent(exact)).toThrow(ProviderBoundaryError);

    expect(() =>
      decodeProviderEvent({ type: "response.started", ...identity, responseId: "response_runtime" }),
    ).not.toThrow();
    expect(() =>
      decodeProviderEvent({
        type: "response.started",
        ...identity,
        responseId: "response_runtime",
        nested: { unexpected: true },
      }),
    ).toThrow(ProviderBoundaryError);
  });

  it.each([
    ["unknown event type", { type: "unknown", ...identity }],
    ["missing identity", { type: "response.completed", responseId: "response_runtime" }],
    ["wrong identity type", { type: "response.completed", ...identity, stepIndex: "0", responseId: "response_runtime" }],
    ["extra field", { type: "response.completed", ...identity, responseId: "response_runtime", extra: true }],
    ["malformed terminal", { type: "response.completed", ...identity }],
    [
      "contradictory retry data",
      {
        type: "response.failed",
        ...identity,
        category: "terminal",
        message: "terminal",
        retryable: true,
      },
    ],
    [
      "wrong retry type",
      {
        type: "response.failed",
        ...identity,
        category: "transient",
        message: "transient",
        retryable: "yes",
      },
    ],
  ] as const)("rejects %s", (_name, value) => {
    expect(() => decodeProviderEvent(value)).toThrow(ProviderBoundaryError);
  });
});
