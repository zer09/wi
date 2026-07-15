import type {
  ProviderEvent,
  ProviderRequest,
  ProviderToolResultInput,
} from "@wi/provider-contract";

import {
  fakeProviderGateLabel,
  type FakeProviderConfiguration,
  type FakeProviderScript,
  type FakeProviderStep,
} from "./script.js";

function identity(request: ProviderRequest) {
  return {
    runId: request.runId,
    stepId: request.stepId,
    stepIndex: request.stepIndex,
  } as const;
}

function responseId(request: ProviderRequest): string {
  return `response_${request.runId}_${request.stepIndex}`;
}

function toolResult(request: ProviderRequest): ProviderToolResultInput | undefined {
  return request.input.find(
    (item): item is ProviderToolResultInput => item.type === "tool_result",
  );
}

function step(
  stream: FakeProviderStep["stream"],
): FakeProviderStep {
  return { stream };
}

async function* started(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
  yield { type: "response.started", ...identity(request), responseId: responseId(request) };
}

function single(
  configuration: FakeProviderConfiguration,
  stream: FakeProviderStep["stream"],
): FakeProviderScript {
  return { scenario: configuration.scenario, steps: [step(stream)] };
}

export function createFakeProviderScript(
  configuration: FakeProviderConfiguration,
): FakeProviderScript {
  switch (configuration.scenario) {
    case "plain-text":
      return single(configuration, async function* (request) {
        yield* started(request);
        yield { type: "text.delta", ...identity(request), delta: "Plain fake response." };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "echo-tool-round-trip":
      return single(configuration, async function* (request) {
        yield* started(request);
        if (request.stepIndex === 0) {
          let callId = "call_echoRoundTrip";
          let name = "echo";
          let argumentsJson = '{"text":"hello"}';
          if (configuration.roundTripTool === "delay") {
            callId = "call_delayRoundTrip";
            name = "delay";
            argumentsJson = '{"key":"controlled","milliseconds":1000}';
          } else if (configuration.roundTripTool === "unknown") {
            callId = "call_unknownRoundTrip";
            name = "missing_tool";
            argumentsJson = "{}";
          } else if (configuration.roundTripTool === "invalid_echo") {
            callId = "call_invalidEchoRoundTrip";
            argumentsJson = '{"wrong":true}';
          }
          yield {
            type: "tool_call.completed",
            ...identity(request),
            callId,
            name,
            argumentsJson,
          };
        } else {
          const result = toolResult(request);
          yield {
            type: "text.delta",
            ...identity(request),
            delta: result?.outcome === "completed" ? "Tool round trip completed." : "Tool round trip failed.",
          };
        }
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "approval-round-trip":
      return single(configuration, async function* (request) {
        yield* started(request);
        if (request.stepIndex === 0) {
          yield {
            type: "tool_call.completed",
            ...identity(request),
            callId: "call_guardedEchoRoundTrip",
            name: "guarded_echo",
            argumentsJson: '{"text":"guarded"}',
          };
        } else {
          const result = toolResult(request);
          yield {
            type: "text.delta",
            ...identity(request),
            delta: result?.outcome === "denied" ? "Guarded echo was denied." : "Guarded echo completed.",
          };
        }
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "slow-stream":
      return single(configuration, async function* (request, _context, controller, signal) {
        yield* started(request);
        yield { type: "text.delta", ...identity(request), delta: "Slow " };
        await controller.wait(fakeProviderGateLabel(request.runId, "slow"), signal);
        yield { type: "text.delta", ...identity(request), delta: "fake response." };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "cancel-before-output":
      return single(configuration, async function* (request, _context, controller, signal) {
        yield* started(request);
        await controller.wait(fakeProviderGateLabel(request.runId, "before-output"), signal);
        yield { type: "text.delta", ...identity(request), delta: "Released response." };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "transient-failure-before-output":
      return single(configuration, async function* (request, context) {
        yield* started(request);
        if (context.attempt === 0) {
          yield {
            type: "response.failed",
            ...identity(request),
            category: "transient",
            message: "Injected transient failure before output.",
            retryable: true,
          };
          return;
        }
        yield { type: "text.delta", ...identity(request), delta: "Retry succeeded." };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "failure-after-visible-output":
      return single(configuration, async function* (request) {
        yield* started(request);
        yield { type: "text.delta", ...identity(request), delta: "Visible partial output." };
        yield {
          type: "response.failed",
          ...identity(request),
          category: "transport",
          message: "Injected failure after visible output.",
          retryable: true,
        };
      });
    case "partial-tool-call-without-terminal":
      return single(configuration, async function* (request, _context, controller, signal) {
        yield* started(request);
        yield {
          type: "tool_call.completed",
          ...identity(request),
          callId: "call_partialWithoutTerminal",
          name: "echo",
          argumentsJson: '{"text":"looks complete"}',
        };
        await controller.wait(fakeProviderGateLabel(request.runId, "partial"), signal);
      });
    case "provider-cleanup-probe":
      return single(configuration, async function* (request, _context, controller, signal) {
        yield* started(request);
        yield {
          type: "tool_call.completed",
          ...identity(request),
          callId: "call_providerCleanupProbe",
          name: "echo",
          argumentsJson: '{"text":"must not execute"}',
        };
        try {
          await controller.wait(fakeProviderGateLabel(request.runId, "partial"), signal);
        } catch (error) {
          await controller.wait(
            fakeProviderGateLabel(request.runId, "cleanup"),
            new AbortController().signal,
          );
          throw error;
        }
      });
    case "duplicate-call-id-same-arguments":
      return single(configuration, async function* (request) {
        yield* started(request);
        if (request.stepIndex === 0) {
          const call = {
            type: "tool_call.completed" as const,
            ...identity(request),
            callId: "call_duplicateSame",
            name: "echo",
            argumentsJson: '{"text":"once"}',
          };
          yield call;
          yield call;
        } else {
          yield { type: "text.delta", ...identity(request), delta: "Duplicate call reused once." };
        }
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "duplicate-call-id-later-step":
      return single(configuration, async function* (request) {
        yield* started(request);
        if (request.stepIndex <= 1) {
          yield {
            type: "tool_call.completed",
            ...identity(request),
            callId: "call_laterStepDuplicate",
            name: "echo",
            argumentsJson: '{"text":"reuse later"}',
          };
        } else {
          yield {
            type: "text.delta",
            ...identity(request),
            delta: "Later-step duplicate result reused.",
          };
        }
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "duplicate-call-id-different-arguments":
      return single(configuration, async function* (request) {
        yield* started(request);
        yield {
          type: "tool_call.completed",
          ...identity(request),
          callId: "call_duplicateDifferent",
          name: "echo",
          argumentsJson: '{"text":"first"}',
        };
        yield {
          type: "tool_call.completed",
          ...identity(request),
          callId: "call_duplicateDifferent",
          name: "echo",
          argumentsJson: '{"text":"changed"}',
        };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "oversized-tool-arguments":
      return single(configuration, async function* (request) {
        yield* started(request);
        yield {
          type: "tool_call.completed",
          ...identity(request),
          callId: "call_oversizedArguments",
          name: "echo",
          argumentsJson: `{"text":"${"x".repeat(70_000)}"}`,
        };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "deeply-nested-tool-arguments":
      return single(configuration, async function* (request) {
        yield* started(request);
        yield {
          type: "tool_call.completed",
          ...identity(request),
          callId: "call_deepArguments",
          name: "echo",
          argumentsJson: `${"[".repeat(40)}0${"]".repeat(40)}`,
        };
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "multi-operation-transient-recovery":
      return single(configuration, async function* (request) {
        yield* started(request);
        if (request.stepIndex === 0 || request.stepIndex === 2) {
          yield {
            type: "response.failed",
            ...identity(request),
            category: "transient",
            message: "Injected transient failure for a logical provider operation.",
            retryable: true,
          };
          return;
        }
        if (request.stepIndex === 1) {
          yield {
            type: "tool_call.completed",
            ...identity(request),
            callId: "call_multiOperation",
            name: "echo",
            argumentsJson: '{"text":"operation boundary"}',
          };
        } else {
          yield { type: "text.delta", ...identity(request), delta: "Continuation retry succeeded." };
        }
        yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
      });
    case "tool-result-then-continuation-failure":
      return single(configuration, async function* (request) {
        yield* started(request);
        if (request.stepIndex === 0) {
          yield {
            type: "tool_call.completed",
            ...identity(request),
            callId: "call_committedBeforeContinuationFailure",
            name: "echo",
            argumentsJson: '{"text":"committed"}',
          };
          yield { type: "response.completed", ...identity(request), responseId: responseId(request) };
          return;
        }
        yield { type: "text.delta", ...identity(request), delta: "Visible continuation output." };
        yield {
          type: "response.failed",
          ...identity(request),
          category: "transport",
          message: "Injected continuation failure after committed tool result.",
          retryable: true,
        };
      });
    case "stream-closes-without-terminal":
      return single(configuration, async function* (request) {
        yield* started(request);
      });
    case "provider-never-completes-until-aborted":
      return single(configuration, async function* (request, _context, controller, signal) {
        yield* started(request);
        await controller.wait(fakeProviderGateLabel(request.runId, "never"), signal);
      });
  }
}
