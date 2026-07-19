import { ClientMessageSchema, type CommandMessage } from "@wi/protocol";

// Keep a full 4 KiB below the server's default 64 KiB inbound frame ceiling.
export const MAXIMUM_BROWSER_COMMAND_BYTES = 60 * 1_024;

export class BrowserCommandTooLargeError extends Error {
  readonly code = "protocol.message_too_large";

  constructor(
    readonly byteLength: number,
    readonly maximumBytes = MAXIMUM_BROWSER_COMMAND_BYTES,
  ) {
    super(
      `This command is ${byteLength} UTF-8 bytes; the browser limit is ${maximumBytes}. ` +
        "Shorten the message or response and try again.",
    );
    this.name = "BrowserCommandTooLargeError";
  }
}

export function serializedCommandBytes(command: CommandMessage): number {
  const parsed = ClientMessageSchema.parse(command);
  if (parsed.kind !== "command") throw new TypeError("Expected a command message");
  return new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
}

export function assertBrowserCommandSize(command: CommandMessage): void {
  const byteLength = serializedCommandBytes(command);
  if (byteLength > MAXIMUM_BROWSER_COMMAND_BYTES) {
    throw new BrowserCommandTooLargeError(byteLength);
  }
}
