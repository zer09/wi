import { z } from "zod";

import {
  CanonicalJsonValueSchema,
  ProviderStepIdSchema,
  RunIdSchema,
  ToolCallIdSchema,
} from "@wi/protocol";

import {
  PROVIDER_LIMITS,
  ProviderBoundaryError,
  assertJsonBounds,
  utf8ByteLength,
} from "./limits.js";

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

export const ProviderMessageInputSchema = z.strictObject({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "system"]),
  text: boundedString("Provider message text", PROVIDER_LIMITS.messageTextMaxBytes),
});
export type ProviderMessageInput = z.infer<typeof ProviderMessageInputSchema>;

export const ProviderToolResultInputSchema = z
  .strictObject({
    type: z.literal("tool_result"),
    callId: ToolCallIdSchema,
    toolName: boundedString("Provider tool name", PROVIDER_LIMITS.toolNameMaxBytes, 1),
    outcome: z.enum(["completed", "failed", "denied", "cancelled"]),
    result: z.union([CanonicalJsonValueSchema, z.null()]),
    error: z.union([CanonicalJsonValueSchema, z.null()]),
  })
  .superRefine((value, context) => {
    if (value.outcome === "completed" && value.error !== null) {
      context.addIssue({
        code: "custom",
        message: "A completed provider tool result cannot also contain an error.",
      });
    }
    if (value.outcome !== "completed" && value.result !== null) {
      context.addIssue({
        code: "custom",
        message: "A non-completed provider tool result cannot also contain a result.",
      });
    }
    if (value.outcome !== "completed" && value.error === null) {
      context.addIssue({
        code: "custom",
        message: "A non-completed provider tool result requires an error.",
      });
    }
  });
export type ProviderToolResultInput = z.infer<typeof ProviderToolResultInputSchema>;

export const ProviderInputItemSchema = z.discriminatedUnion("type", [
  ProviderMessageInputSchema,
  ProviderToolResultInputSchema,
]);
export type ProviderInputItem = z.infer<typeof ProviderInputItemSchema>;

export const ProviderStepIndexSchema = z.number().int().nonnegative().safe();

export const ProviderRequestSchema = z
  .strictObject({
    runId: RunIdSchema,
    stepId: ProviderStepIdSchema,
    stepIndex: ProviderStepIndexSchema,
    providerConfig: CanonicalJsonValueSchema,
    input: z.array(ProviderInputItemSchema).max(PROVIDER_LIMITS.inputItemMaxCount),
  })
  .superRefine((value, context) => {
    try {
      assertJsonBounds(value.providerConfig, {
        label: "Provider configuration",
        maxBytes: PROVIDER_LIMITS.providerConfigMaxBytes,
        maxDepth: PROVIDER_LIMITS.providerConfigMaxDepth,
        maxNodes: PROVIDER_LIMITS.providerConfigMaxNodes,
      });
      assertJsonBounds(value, {
        label: "Provider request",
        maxBytes: PROVIDER_LIMITS.requestMaxBytes,
        maxDepth: PROVIDER_LIMITS.requestMaxDepth,
        maxNodes: PROVIDER_LIMITS.requestMaxNodes,
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Provider request exceeds its limits.",
      });
    }
  });
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

export interface ProviderContext {
  readonly sessionId: string;
  /** Zero for the first attempt; incremented only by a permitted pre-output retry. */
  readonly attempt: number;
  readonly now: () => number;
}

export function decodeProviderInputItem(value: unknown): ProviderInputItem {
  assertJsonBounds(value, {
    label: "Provider input item",
    maxBytes: PROVIDER_LIMITS.requestMaxBytes,
    maxDepth: PROVIDER_LIMITS.requestMaxDepth,
    maxNodes: PROVIDER_LIMITS.requestMaxNodes,
  });
  const decoded = ProviderInputItemSchema.safeParse(value);
  if (!decoded.success) {
    throw new ProviderBoundaryError("Provider input item does not match the runtime contract.", {
      cause: decoded.error,
    });
  }
  return decoded.data;
}

export function decodeProviderRequest(value: unknown): ProviderRequest {
  assertJsonBounds(value, {
    label: "Provider request",
    maxBytes: PROVIDER_LIMITS.requestMaxBytes,
    maxDepth: PROVIDER_LIMITS.requestMaxDepth,
    maxNodes: PROVIDER_LIMITS.requestMaxNodes,
  });
  if (value !== null && typeof value === "object" && "providerConfig" in value) {
    assertJsonBounds((value as { readonly providerConfig?: unknown }).providerConfig, {
      label: "Provider configuration",
      maxBytes: PROVIDER_LIMITS.providerConfigMaxBytes,
      maxDepth: PROVIDER_LIMITS.providerConfigMaxDepth,
      maxNodes: PROVIDER_LIMITS.providerConfigMaxNodes,
    });
  }
  const decoded = ProviderRequestSchema.safeParse(value);
  if (!decoded.success) {
    throw new ProviderBoundaryError("Provider request does not match the runtime contract.", {
      cause: decoded.error,
    });
  }
  return decoded.data;
}
