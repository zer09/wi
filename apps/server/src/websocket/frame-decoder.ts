import {
  ClientMessageSchema,
  type ClientMessage,
  type ProtocolErrorCode,
} from "@wi/protocol";

export const MINIMUM_WI_V1_CLIENT_FRAME_DEPTH = 3;

export interface FrameLimits {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
}

export class FrameDecodeError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

function assertDepth(text: string, maximumDepth: number): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maximumDepth) {
        throw new FrameDecodeError(
          "protocol.invalid_message",
          "The message exceeds the maximum JSON nesting depth.",
          false,
        );
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) break;
    }
  }
}

export function decodeClientFrame(
  bytes: Uint8Array,
  isBinary: boolean,
  limits: FrameLimits,
): ClientMessage {
  if (bytes.byteLength > limits.maximumBytes) {
    throw new FrameDecodeError(
      "protocol.message_too_large",
      "The message exceeds the configured byte limit.",
      true,
    );
  }
  if (isBinary) {
    throw new FrameDecodeError(
      "protocol.invalid_message",
      "Binary WebSocket messages are not supported.",
      true,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FrameDecodeError(
      "protocol.invalid_message",
      "The message is not valid UTF-8.",
      true,
    );
  }
  assertDepth(text, limits.maximumDepth);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new FrameDecodeError(
      "protocol.invalid_json",
      "The message is not valid JSON.",
      false,
    );
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const version = (parsed as Record<string, unknown>).v;
    if (version !== undefined && version !== 1) {
      throw new FrameDecodeError(
        "protocol.unsupported_version",
        "The protocol version is not supported.",
        false,
      );
    }
  }
  const decoded = ClientMessageSchema.safeParse(parsed);
  if (!decoded.success) {
    throw new FrameDecodeError(
      "protocol.invalid_message",
      "The message does not match the Wi protocol.",
      false,
    );
  }
  return decoded.data;
}
