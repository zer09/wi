import { ProtocolError, object, text, boolean, literal, enumeration, nullable, array, tagged, version, runState, validateU64, validateUuid, validateSessionView, validateOutcomeView, validateSummaryView, validateReceiptView, validateRunView, validateReceiptIdentity, validateNoticeView, taskWarning, apiPath, } from './api.js';
function invalid() { throw new ProtocolError('invalid_schema'); }
function identity() { throw new ProtocolError('identity_mismatch'); }
function positive(value) {
    const result = validateU64(value);
    if (result === '0')
        throw new ProtocolError('invalid_decimal');
    return result;
}
export function utf8Bytes(value) {
    // TextEncoder replaces lone surrogates. Reject them instead of changing recorded bytes.
    for (const scalar of value) {
        const code = scalar.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff)
            throw new ProtocolError('invalid_utf8');
    }
    return new TextEncoder().encode(value);
}
export function validateEntryId(value) {
    const id = text(value), parts = id.split(':');
    if (parts.length !== 3 || parts[0] !== 'e')
        throw new ProtocolError('invalid_identity');
    positive(parts[1]);
    validateU64(parts[2]);
    return id;
}
function fieldId(value) {
    const id = text(value);
    if (id !== 'text' && !/^[0-9a-f]{64}$/.test(id))
        throw new ProtocolError('invalid_identity');
    return id;
}
export function validateOrderKey(value) {
    const key = text(value);
    if (key === '0')
        return key;
    const parts = key.split(':');
    const component = /^(?:0|1[0-9a-f]{16})$/;
    if (parts.length !== 5 || !component.test(parts[0]) || !component.test(parts[2]) || !component.test(parts[3])
        || !/^[0-9a-f]{16}$/.test(parts[1]) || !/^[0-9a-f]{16}$/.test(parts[4]))
        invalid();
    const rank = BigInt(`0x${parts[4]}`);
    const groups = [0n, 1n, 1n, 2n, 3n, 4n, 5n, 6n, 7n];
    if (rank > 8n || BigInt(`0x${parts[1]}`) !== groups[Number(rank)])
        invalid();
    return key;
}
const prefixes = { block: 'g11b.', activity: 'g11s.', content: 'g11c.', live: 'g11l.' };
export function parseDisplayCursor(value, kind, sessionId) {
    try {
        const token = text(value), prefix = prefixes[kind];
        if (token.length > 4096 || !token.startsWith(prefix))
            invalid();
        const encoded = token.slice(prefix.length);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded))
            invalid();
        const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
        if (btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== encoded)
            invalid();
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const fields = JSON.parse(json);
        const lengths = { block: 3, activity: 5, content: 8, live: 6 };
        if (!Array.isArray(fields) || fields.length !== lengths[kind] || fields[0] !== 1 || JSON.stringify(fields) !== json)
            invalid();
        const sid = validateUuid(fields[1]);
        if (sessionId !== undefined && sid !== validateUuid(sessionId))
            identity();
        if (kind === 'block')
            return { token, kind, session_id: sid, sequence: positive(fields[2]) };
        if (kind === 'activity')
            return {
                token, kind, session_id: sid, run_id: validateUuid(fields[2]), sequence: positive(fields[3]), slot: validateU64(fields[4]),
            };
        if (kind === 'content') {
            const entry = validateEntryId(fields[3]), first = BigInt(entry.split(':')[1]);
            const epoch = positive(fields[4]), generation = positive(fields[6]);
            if (BigInt(epoch) < first || BigInt(generation) < first)
                invalid();
            return { token, kind, session_id: sid, run_id: validateUuid(fields[2]), entry_id: entry,
                sequence: entry.split(':')[1], content_epoch: epoch, field_id: fieldId(fields[5]), generation, upper_byte: validateU64(fields[7]) };
        }
        const sequence = positive(fields[2]), rank = enumeration('0', '1', '2', '3')(fields[3]);
        const run = text(fields[4]), entry = text(fields[5]);
        if (rank === '0' || rank === '3') {
            if (run !== '' || entry !== '')
                invalid();
        }
        else {
            validateUuid(run);
            if (rank === '1') {
                if (entry !== '')
                    invalid();
            }
            else if (BigInt(validateEntryId(entry).split(':')[1]) > BigInt(sequence))
                invalid();
        }
        return { token, kind, session_id: sid, sequence, rank, run_id: run, entry_id: entry };
    }
    catch {
        throw new ProtocolError('invalid_cursor');
    }
}
function cursor(kind) { return (value) => parseDisplayCursor(value, kind).token; }
function bounded(value, limit) {
    if (utf8Bytes(JSON.stringify(value)).length > limit)
        invalid();
}
const fieldShape = object({
    field_id: fieldId, order_key: validateOrderKey,
    kind: enumeration('text', 'refusal', 'reasoning_summary', 'reasoning_text', 'function_name', 'function_arguments', 'tool_name', 'tool_result', 'authoritative_text', 'unsupported', 'notice'),
    generation: positive, total_bytes: validateU64, from_byte: validateU64, to_byte: validateU64,
    text, has_earlier: boolean, has_later: boolean,
});
export function validateFieldFragment(value) {
    const f = fieldShape(value), from = BigInt(f.from_byte), to = BigInt(f.to_byte), total = BigInt(f.total_bytes);
    if (from > to || to > total || BigInt(utf8Bytes(f.text).length) !== to - from
        || f.has_earlier !== (from > 0n) || f.has_later !== (to < total))
        invalid();
    return f;
}
const entryShape = object({
    run_id: validateUuid, entry_id: validateEntryId, position: object({ sequence: positive, slot: validateU64 }),
    revision: positive, content_epoch: positive, kind: enumeration('human', 'assistant', 'tool', 'reuse', 'notice'),
    recorded_state: enumeration('accepted', 'in_progress', 'completed', 'incomplete', 'failed', 'cancelled', 'interrupted', 'unknown'),
    provisional: boolean, reference: nullable(object({ run_id: validateUuid, entry_id: validateEntryId })),
    result_recorded: nullable(boolean), finish_recorded: nullable(boolean), is_error: nullable(boolean),
    fields: array(validateFieldFragment), earlier_content: nullable(cursor('content')), content_complete: boolean,
});
export function comparePosition(a, b) {
    for (const key of ['sequence', 'slot']) {
        if (BigInt(a[key]) < BigInt(b[key]))
            return -1;
        if (BigInt(a[key]) > BigInt(b[key]))
            return 1;
    }
    return 0;
}
export function validateEntryView(value) {
    const e = entryShape(value), first = BigInt(e.position.sequence), revision = BigInt(e.revision);
    if (e.entry_id !== `e:${e.position.sequence}:${e.position.slot}` || BigInt(e.content_epoch) < first
        || revision < BigInt(e.content_epoch) || e.fields.length > 64)
        invalid();
    if ((e.kind === 'reuse') !== (e.reference !== null))
        invalid();
    if (e.reference !== null) {
        const [, sequence, slot] = e.reference.entry_id.split(':');
        if (e.reference.run_id !== e.run_id || comparePosition({ sequence, slot }, e.position) >= 0)
            identity();
    }
    if (e.kind !== 'tool' && e.kind !== 'reuse'
        && (e.result_recorded !== null || e.finish_recorded !== null || e.is_error !== null))
        invalid();
    if (e.kind === 'human' && (e.fields.length !== 1 || e.fields[0].field_id !== 'text'
        || e.fields[0].order_key !== '0' || e.fields[0].kind !== 'text'))
        invalid();
    const ids = new Set();
    for (const [i, f] of e.fields.entries()) {
        if (ids.has(f.field_id) || BigInt(f.generation) < first || BigInt(f.generation) > revision
            || (e.kind !== 'human' && f.order_key === '0') || (i > 0 && e.fields[i - 1].order_key >= f.order_key)
            || (e.content_complete && (f.has_earlier || f.has_later)))
            invalid();
        ids.add(f.field_id);
    }
    if (e.content_complete && e.earlier_content !== null)
        invalid();
    if (e.earlier_content !== null) {
        const c = parseDisplayCursor(e.earlier_content, 'content');
        if (c.run_id !== e.run_id || c.entry_id !== e.entry_id || c.content_epoch !== e.content_epoch
            || BigInt(c.generation) > revision)
            identity();
        const f = e.fields.find(f => f.field_id === c.field_id);
        if (f && (f.generation !== c.generation || BigInt(c.upper_byte) > BigInt(f.total_bytes)))
            invalid();
    }
    bounded(e, 32768);
    return e;
}
const blockShape = object({
    run_id: validateUuid, accepted_sequence: positive, revision: positive, state: runState, result_recorded: boolean,
    outcome: nullable(validateOutcomeView), summary: nullable(validateSummaryView), events_complete: nullable(boolean),
    sink_error: nullable(enumeration('full', 'closed', 'failed')), human: validateEntryView,
});
export function validateBlockView(value) {
    const b = blockShape(value);
    if (BigInt(b.revision) < BigInt(b.accepted_sequence) || b.human.kind !== 'human' || b.human.run_id !== b.run_id
        || b.human.position.sequence !== b.accepted_sequence || b.human.position.slot !== '0'
        || BigInt(b.human.revision) > BigInt(b.revision))
        identity();
    return b;
}
function entryAt(e, b, sid, head) {
    if (e.run_id !== b.run_id || BigInt(e.revision) > BigInt(head))
        identity();
    if (e.kind === 'human') {
        if (e.entry_id !== b.human.entry_id || e.revision !== b.human.revision || e.content_epoch !== b.human.content_epoch)
            identity();
    }
    else if (comparePosition(e.position, b.human.position) <= 0)
        identity();
    if (e.earlier_content !== null)
        parseDisplayCursor(e.earlier_content, 'content', sid);
}
function blockAt(b, sid, head) {
    if (BigInt(b.revision) > BigInt(head))
        identity();
    entryAt(b.human, b, sid, head);
}
const pageShape = object({
    api_version: version, conversation_version: version, session_id: validateUuid, snapshot_head: positive,
    session: validateSessionView, block: nullable(validateBlockView), entries: array(validateEntryView),
    earlier_activity: nullable(cursor('activity')), previous_block: nullable(cursor('block')), live_after: nullable(cursor('live')),
});
export function validateConversationPage(value, query = { kind: 'latest' }, sessionId) {
    const p = pageShape(value), sid = p.session_id;
    if ((sessionId !== undefined && sid !== validateUuid(sessionId)) || p.session.session_id !== sid
        || p.session.head_sequence !== p.snapshot_head || p.entries.length > 64)
        identity();
    if ((query.kind === 'latest') !== (p.live_after !== null))
        invalid();
    if (p.live_after !== null) {
        const c = parseDisplayCursor(p.live_after, 'live', sid);
        if (c.rank !== '3' || c.sequence !== p.snapshot_head)
            invalid();
    }
    if (query.kind === 'before') {
        const c = parseDisplayCursor(query.cursor, 'block', sid);
        if (p.block && BigInt(p.block.accepted_sequence) >= BigInt(c.sequence))
            identity();
    }
    if (query.kind === 'within') {
        const c = parseDisplayCursor(query.cursor, 'activity', sid);
        if (!p.block || p.block.run_id !== c.run_id || p.entries.some(e => comparePosition(e.position, { sequence: c.sequence, slot: c.slot }) >= 0))
            identity();
    }
    if (p.block === null) {
        if (p.entries.length || p.earlier_activity !== null || p.previous_block !== null)
            invalid();
    }
    else {
        const b = p.block;
        blockAt(b, sid, p.snapshot_head);
        for (const [i, e] of p.entries.entries()) {
            entryAt(e, b, sid, p.snapshot_head);
            if (e.kind === 'human' || (i > 0 && comparePosition(p.entries[i - 1].position, e.position) >= 0))
                invalid();
        }
        if (p.previous_block !== null && parseDisplayCursor(p.previous_block, 'block', sid).sequence !== b.accepted_sequence)
            identity();
        if (p.earlier_activity !== null) {
            const c = parseDisplayCursor(p.earlier_activity, 'activity', sid), first = p.entries[0];
            if (!first || c.run_id !== b.run_id || c.sequence !== first.position.sequence || c.slot !== first.position.slot)
                identity();
        }
    }
    bounded(p, 524288);
    return p;
}
const entryPageShape = object({
    api_version: version, conversation_version: version, session_id: validateUuid, snapshot_head: positive,
    block: validateBlockView, entry: validateEntryView,
});
export function validateEntryPage(value, expected) {
    const p = entryPageShape(value);
    if (expected && (p.session_id !== validateUuid(expected.session_id) || p.entry.run_id !== validateUuid(expected.run_id)
        || p.entry.entry_id !== validateEntryId(expected.entry_id)))
        identity();
    blockAt(p.block, p.session_id, p.snapshot_head);
    entryAt(p.entry, p.block, p.session_id, p.snapshot_head);
    bounded(p, 524288);
    return p;
}
const changeShape = tagged('kind', {
    'session.upsert': object({ kind: literal('session.upsert'), session: validateSessionView }),
    'block.upsert': object({ kind: literal('block.upsert'), block: validateBlockView }),
    'entry.upsert': object({ kind: literal('entry.upsert'), block: validateBlockView, entry: validateEntryView }),
});
const changesShape = object({
    api_version: version, conversation_version: version, session_id: validateUuid, observed_head: positive,
    changes: array(changeShape), next_after: cursor('live'),
});
export function compareLiveKeys(a, b) {
    for (const key of ['sequence', 'rank']) {
        if (BigInt(a[key]) < BigInt(b[key]))
            return -1;
        if (BigInt(a[key]) > BigInt(b[key]))
            return 1;
    }
    for (const key of ['run_id', 'entry_id']) {
        if (a[key] < b[key])
            return -1;
        if (a[key] > b[key])
            return 1;
    }
    return 0;
}
export function displayChangeKey(change) {
    // SessionView exposes the snapshot head, not the private metadata revision.
    if (change.kind === 'session.upsert')
        return null;
    if (change.kind === 'block.upsert')
        return { sequence: change.block.revision, rank: '1', run_id: change.block.run_id, entry_id: '' };
    return { sequence: change.entry.revision, rank: '2', run_id: change.entry.run_id, entry_id: change.entry.entry_id };
}
export function validateConversationChanges(value, sessionId) {
    const batch = changesShape(value), sid = batch.session_id;
    if (sessionId !== undefined && sid !== validateUuid(sessionId))
        identity();
    if (batch.changes.length > 64)
        invalid();
    for (const change of batch.changes) {
        if (change.kind === 'session.upsert') {
            if (change.session.session_id !== sid || change.session.head_sequence !== batch.observed_head)
                identity();
        }
        else {
            blockAt(change.block, sid, batch.observed_head);
            if (change.kind === 'entry.upsert')
                entryAt(change.entry, change.block, sid, batch.observed_head);
        }
    }
    const c = parseDisplayCursor(batch.next_after, 'live', sid);
    if (BigInt(c.sequence) > BigInt(batch.observed_head))
        invalid();
    if (c.rank === '3') {
        if (c.sequence !== batch.observed_head)
            invalid();
    }
    else {
        const last = batch.changes.at(-1);
        if (!last)
            invalid();
        if (last.kind === 'session.upsert') {
            if (c.rank !== '0')
                invalid();
        }
        else if (last.kind === 'block.upsert') {
            if (c.rank !== '1' || c.run_id !== last.block.run_id || c.sequence !== last.block.revision)
                identity();
        }
        else if (c.rank !== '2' || c.run_id !== last.entry.run_id || c.entry_id !== last.entry.entry_id || c.sequence !== last.entry.revision)
            identity();
    }
    let previous = null;
    let metadataSeen = false;
    for (const change of batch.changes) {
        const key = displayChangeKey(change);
        if (key === null) {
            if (metadataSeen)
                invalid();
            metadataSeen = true;
            continue;
        }
        // Keep comparing known keys across metadata. Never sort or repair a bad prefix.
        if ((previous !== null && compareLiveKeys(key, previous) <= 0) || compareLiveKeys(key, c) > 0)
            invalid();
        previous = key;
    }
    bounded(batch, 524288);
    return batch;
}
export function displayPath(route) {
    const base = apiPath({ kind: 'session', session_id: route.session_id });
    switch (route.kind) {
        case 'conversation': {
            if (route.query.kind === 'latest')
                return `${base}/conversation`;
            if (route.query.kind !== 'before' && route.query.kind !== 'within')
                throw new ProtocolError('invalid_request');
            const kind = route.query.kind === 'before' ? 'block' : 'activity';
            parseDisplayCursor(route.query.cursor, kind, route.session_id);
            return `${base}/conversation?${route.query.kind}=${encodeURIComponent(route.query.cursor)}`;
        }
        case 'entry': return `${base}/conversation/entries/${validateUuid(route.run_id)}/${encodeURIComponent(validateEntryId(route.entry_id))}`;
        case 'content':
            parseDisplayCursor(route.cursor, 'content', route.session_id);
            return `${base}/conversation/content?cursor=${encodeURIComponent(route.cursor)}`;
        case 'display_events':
            parseDisplayCursor(route.after, 'live', route.session_id);
            return `${base}/conversation/events?after=${encodeURIComponent(route.after)}`;
        case 'reconcile': return `${base}/runs/reconcile`;
        default: throw new ProtocolError('invalid_request');
    }
}
const displayAcceptanceShape = object({
    api_version: version, receipt: validateReceiptView, duplicate: boolean,
    warning_code: nullable(taskWarning), notices: array(validateNoticeView),
});
// Acceptance is server-proved. The display client checks identity, not raw receipt arithmetic.
export function validateDisplayTaskAccepted(value, command) {
    const reply = displayAcceptanceShape(value);
    validateReceiptIdentity(reply.receipt, command);
    return reply;
}
const reconciliationShape = tagged('state', {
    accepted: object({ api_version: version, state: literal('accepted'), acceptance: validateReceiptView, run: validateRunView }),
    not_found: object({ api_version: version, state: literal('not_found'), acceptance: literal(null), run: literal(null) }),
});
export function validateTaskReconciliation(value, command) {
    const sid = validateUuid(command.session_id), oid = validateUuid(command.operation_id), rid = validateUuid(command.run_id);
    text(command.text);
    const result = reconciliationShape(value);
    if (result.state === 'accepted' && (result.acceptance.session_id !== sid || result.acceptance.operation_id !== oid
        || result.acceptance.run_id !== rid || result.run.run_id !== rid || result.run.user_text !== command.text))
        identity();
    return result;
}
