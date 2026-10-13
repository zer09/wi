import {
  ProtocolError, parseJson, validateClosedView, validateCursor, validateErrorView, validateEventView, validateUuid,
  type ClosedView, type ErrorView, type EventView,
} from './api.js';

import { validateConversationChanges, type ConversationChanges } from './display-api.js';

export type WiSseRecord =
  | { readonly kind: 'event'; readonly id: string; readonly event: EventView }
  | { readonly kind: 'error'; readonly error: ErrorView }
  | { readonly kind: 'closed'; readonly closed: ClosedView };

// The callback receives each valid record before parsing continues. A bad suffix cannot
// hide a good prefix from the caller. Only the later reducer may advance an applied cursor.
class SseFrames<R> {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private skipLF = false;
  private event: string | undefined;
  private id: string | undefined;
  private data: string[] = [];
  private ended = false;

  constructor(private readonly onRecord: (record: R) => void,
    private readonly validateFrame: (event: string | undefined, id: string | undefined, value: unknown) => { record: R; terminal: boolean }) {}

  get done(): boolean { return this.ended; }

  push(bytes: Uint8Array): void {
    if (this.ended) return;
    try {
      // Decode through one line ending at a time. Decoding the entire network chunk
      // could throw on a later bad byte before delivering earlier complete frames.
      let start = 0;
      for (let index = 0; index < bytes.length && !this.ended; index += 1) {
        if (bytes[index] === 10 || bytes[index] === 13) {
          this.consume(this.decode(bytes.subarray(start, index + 1)));
          start = index + 1;
        }
      }
      if (!this.ended && start < bytes.length) this.consume(this.decode(bytes.subarray(start)));
    } catch (error) {
      this.stop();
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError('consumer_failed');
    }
  }

  finish(): void {
    if (this.ended) return;
    try {
      let tail: string;
      try { tail = this.decoder.decode(); } catch { throw new ProtocolError('invalid_utf8'); }
      this.consume(tail);
      // EOF does not dispatch an unterminated frame and does not finish a run.
    } finally {
      this.stop();
    }
  }

  private decode(bytes: Uint8Array): string {
    try { return this.decoder.decode(bytes, { stream: true }); } catch { throw new ProtocolError('invalid_utf8'); }
  }

  private consume(text: string): void {
    for (const character of text) {
      if (this.ended) return;
      if (this.skipLF) {
        this.skipLF = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        const line = this.line;
        this.line = '';
        this.skipLF = character === '\r';
        this.acceptLine(line);
      } else {
        this.line += character;
      }
    }
  }

  private acceptLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.event = value; break;
      case 'id': this.id = value; break;
      case 'data': this.data.push(value); break;
      // Unknown fields, including retry, have no execution or reconnect behavior.
    }
  }

  private dispatch(): void {
    const event = this.event;
    const id = this.id;
    const data = this.data;
    this.event = undefined;
    this.id = undefined;
    this.data = [];
    if (event === undefined && id === undefined && data.length === 0) return;
    if (data.length === 0) throw new ProtocolError('invalid_sse');
    const value = parseJson(data.join('\n'));
    const { record, terminal } = this.validateFrame(event, id, value);
    if (terminal) this.stop();
    this.onRecord(record);
  }

  private stop(): void {
    this.ended = true;
    this.line = '';
    this.event = undefined;
    this.id = undefined;
    this.data = [];
  }
}

function ending(event: string | undefined, id: string | undefined, value: unknown): Exclude<WiSseRecord, { kind: 'event' }> {
  if (id !== undefined) throw new ProtocolError('invalid_sse');
  if (event === 'wi.error') return { kind: 'error', error: validateErrorView(value) };
  if (event === 'wi.closed') return { kind: 'closed', closed: validateClosedView(value) };
  throw new ProtocolError('invalid_sse');
}

export class WiSseParser extends SseFrames<WiSseRecord> {
  constructor(sessionId: string, onRecord: (record: WiSseRecord) => void) {
    const sid = validateUuid(sessionId);
    super(onRecord, (event, id, value) => {
      if (event !== 'wi.event') return { record: ending(event, id, value), terminal: true };
      const cursor = validateCursor(id, sid), view = validateEventView(value);
      if (view.session_id !== sid || view.sequence !== cursor.sequence) throw new ProtocolError('identity_mismatch');
      return { record: { kind: 'event', id: id as string, event: view }, terminal: false };
    });
  }
}

export type ConversationSseRecord =
  | { readonly kind: 'conversation'; readonly id: string; readonly changes: ConversationChanges }
  | Exclude<WiSseRecord, { kind: 'event' }>;

export class WiConversationSseParser extends SseFrames<ConversationSseRecord> {
  constructor(sessionId: string, onRecord: (record: ConversationSseRecord) => void) {
    const sid = validateUuid(sessionId);
    super(onRecord, (event, id, value) => {
      if (event !== 'wi.conversation') return { record: ending(event, id, value), terminal: true };
      if (id === undefined) throw new ProtocolError('invalid_sse');
      const changes = validateConversationChanges(value, sid);
      if (id !== changes.next_after) throw new ProtocolError('identity_mismatch');
      return { record: { kind: 'conversation', id, changes }, terminal: false };
    });
  }
}
