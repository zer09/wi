import { z } from "zod";

import {
  ProviderStepIdSchema,
  RunIdSchema,
  ToolCallIdSchema,
} from "@wi/protocol";

import {
  PROVIDER_LIMITS,
  ProviderBoundaryError,
  assertJsonBounds,
  cloneJsonWithinBounds,
  utf8ByteLength,
} from "./limits.js";
import { ProviderStepIndexSchema } from "./request.js";

function boundedString(label: string, maxBytes: number, minimum = 0) {
  return z.string().min(minimum).superRefine((value, context) => {
    if (utf8ByteLength(value) > maxBytes) {
      context.addIssue({
        code: "custom",
        message: `${label} exceeds ${maxBytes} UTF-8 bytes.`,
      });
    }
  });
}

const ProviderEventIdentitySchema = z.strictObject({
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  stepIndex: ProviderStepIndexSchema,
});

export const ProviderResponseStartedEventSchema = ProviderEventIdentitySchema.extend({
  type: z.literal("response.started"),
  responseId: boundedString("Provider response ID", PROVIDER_LIMITS.responseIdMaxBytes, 1),
});
export type ProviderResponseStartedEvent = z.infer<typeof ProviderResponseStartedEventSchema>;

export const ProviderTextDeltaEventSchema = ProviderEventIdentitySchema.extend({
  type: z.literal("text.delta"),
  delta: boundedString("Provider text delta", PROVIDER_LIMITS.textDeltaMaxBytes),
});
export type ProviderTextDeltaEvent = z.infer<typeof ProviderTextDeltaEventSchema>;

export const ProviderToolCallCompletedEventSchema = ProviderEventIdentitySchema.extend({
  type: z.literal("tool_call.completed"),
  callId: ToolCallIdSchema,
  name: boundedString("Provider tool name", PROVIDER_LIMITS.toolNameMaxBytes, 1),
  argumentsJson: boundedString(
    "Provider tool arguments envelope",
    PROVIDER_LIMITS.toolArgumentsMaxBytes,
  ),
});
export type ProviderToolCallCompletedEvent = z.infer<
  typeof ProviderToolCallCompletedEventSchema
>;

export const ProviderResponseCompletedEventSchema = ProviderEventIdentitySchema.extend({
  type: z.literal("response.completed"),
  responseId: boundedString("Provider response ID", PROVIDER_LIMITS.responseIdMaxBytes, 1),
});
export type ProviderResponseCompletedEvent = z.infer<typeof ProviderResponseCompletedEventSchema>;

export const ProviderResponseFailedEventSchema = ProviderEventIdentitySchema.extend({
  type: z.literal("response.failed"),
  category: z.enum(["transient", "transport", "terminal", "protocol"]),
  message: boundedString("Provider failure message", PROVIDER_LIMITS.failureMessageMaxBytes),
  retryable: z.boolean(),
}).superRefine((value, context) => {
  if ((value.category === "terminal" || value.category === "protocol") && value.retryable) {
    context.addIssue({
      code: "custom",
      message: `Provider failure category ${value.category} cannot be retryable.`,
    });
  }
});
export type ProviderResponseFailedEvent = z.infer<typeof ProviderResponseFailedEventSchema>;

const ProviderEventDiscriminatedSchema = z.discriminatedUnion("type", [
  ProviderResponseStartedEventSchema,
  ProviderTextDeltaEventSchema,
  ProviderToolCallCompletedEventSchema,
  ProviderResponseCompletedEventSchema,
  ProviderResponseFailedEventSchema,
]);

export const ProviderEventSchema = ProviderEventDiscriminatedSchema.superRefine(
  (value, context) => {
    try {
      assertJsonBounds(value, {
        label: "Provider event",
        maxBytes: PROVIDER_LIMITS.eventMaxBytes,
        maxDepth: PROVIDER_LIMITS.eventMaxDepth,
        maxNodes: PROVIDER_LIMITS.eventMaxNodes,
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Provider event exceeds its limits.",
      });
    }
  },
);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export function decodeProviderEvent(value: unknown): ProviderEvent {
  const bounded = cloneJsonWithinBounds(value, {
    label: "Provider event",
    maxBytes: PROVIDER_LIMITS.eventMaxBytes,
    maxDepth: PROVIDER_LIMITS.eventMaxDepth,
    maxNodes: PROVIDER_LIMITS.eventMaxNodes,
  });
  const decoded = ProviderEventSchema.safeParse(bounded);
  if (!decoded.success) {
    throw new ProviderBoundaryError("Provider event does not match the runtime contract.", {
      cause: decoded.error,
    });
  }
  return decoded.data;
}
