import { ProtocolError, parseJson, validateClosedView, validateCursor, validateErrorView, validateEventView, validateUuid, } from './api.js';
// The callback receives each valid record before parsing continues. A bad suffix cannot
// hide a good prefix from the caller. Only the later reducer may advance an applied cursor.
export class WiSseParser {
    onRecord;
    sessionId;
    decoder = new TextDecoder('utf-8', { fatal: true });
    line = '';
    skipLF = false;
    event;
    id;
    data = [];
    ended = false;
    constructor(sessionId, onRecord) {
        this.onRecord = onRecord;
        this.sessionId = validateUuid(sessionId);
    }
    get done() { return this.ended; }
    push(bytes) {
        if (this.ended)
            return;
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
            if (!this.ended && start < bytes.length)
                this.consume(this.decode(bytes.subarray(start)));
        }
        catch (error) {
            this.stop();
            if (error instanceof ProtocolError)
                throw error;
            throw new ProtocolError('consumer_failed');
        }
    }
    finish() {
        if (this.ended)
            return;
        try {
            let tail;
            try {
                tail = this.decoder.decode();
            }
            catch {
                throw new ProtocolError('invalid_utf8');
            }
            this.consume(tail);
            // EOF does not dispatch an unterminated frame and does not finish a run.
        }
        finally {
            this.stop();
        }
    }
    decode(bytes) {
        try {
            return this.decoder.decode(bytes, { stream: true });
        }
        catch {
            throw new ProtocolError('invalid_utf8');
        }
    }
    consume(text) {
        for (const character of text) {
            if (this.ended)
                return;
            if (this.skipLF) {
                this.skipLF = false;
                if (character === '\n')
                    continue;
            }
            if (character === '\r' || character === '\n') {
                const line = this.line;
                this.line = '';
                this.skipLF = character === '\r';
                this.acceptLine(line);
            }
            else {
                this.line += character;
            }
        }
    }
    acceptLine(line) {
        if (line === '') {
            this.dispatch();
            return;
        }
        if (line.startsWith(':'))
            return;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' '))
            value = value.slice(1);
        switch (field) {
            case 'event':
                this.event = value;
                break;
            case 'id':
                this.id = value;
                break;
            case 'data':
                this.data.push(value);
                break;
            // Unknown fields, including retry, have no execution or reconnect behavior.
        }
    }
    dispatch() {
        const event = this.event;
        const id = this.id;
        const data = this.data;
        this.event = undefined;
        this.id = undefined;
        this.data = [];
        if (event === undefined && id === undefined && data.length === 0)
            return;
        if (data.length === 0)
            throw new ProtocolError('invalid_sse');
        const value = parseJson(data.join('\n'));
        let record;
        switch (event) {
            case 'wi.event': {
                const cursor = validateCursor(id, this.sessionId);
                const view = validateEventView(value);
                if (view.session_id !== this.sessionId || view.sequence !== cursor.sequence) {
                    throw new ProtocolError('identity_mismatch');
                }
                record = { kind: 'event', id: id, event: view };
                break;
            }
            case 'wi.error':
                if (id !== undefined)
                    throw new ProtocolError('invalid_sse');
                record = { kind: 'error', error: validateErrorView(value) };
                this.stop();
                break;
            case 'wi.closed':
                if (id !== undefined)
                    throw new ProtocolError('invalid_sse');
                record = { kind: 'closed', closed: validateClosedView(value) };
                this.stop();
                break;
            default: throw new ProtocolError('invalid_sse');
        }
        this.onRecord(record);
    }
    stop() {
        this.ended = true;
        this.line = '';
        this.event = undefined;
        this.id = undefined;
        this.data = [];
    }
}
