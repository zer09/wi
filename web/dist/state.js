import { ProtocolError, cursorFor, validateCursor, validateEventView, validateHistoryView, validateUuid, } from './api.js';
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function eventFingerprint(value) {
    return canonical(validateEventView(value));
}
export function createConversation(sessionId) {
    return {
        session_id: validateUuid(sessionId), applied_cursor: cursorFor(sessionId, '0'), metadata: null,
        runs: new Map(), fingerprints: new Map(), event_sequences: new Map(),
    };
}
// Maps are copied only along the changed path. No object reachable from the input is mutated.
function withEntry(entries, key, value) {
    const next = new Map(entries);
    next.set(key, value);
    return next;
}
function conflict() { throw new ProtocolError('identity_mismatch'); }
function invalid() { throw new ProtocolError('invalid_schema'); }
function active(run) {
    return run.finished === null && run.result === null && run.interrupted === null;
}
function activeTurn(run) {
    if (run.started_sequence === null || run.active_turn_number === null)
        invalid();
    return run.turns.get(run.active_turn_number);
}
function requireOutputs(run, outcome) {
    if (outcome.type === 'completed' && [...run.tools.values()].some(tool => tool.result === null))
        invalid();
}
export function applyEvent(state, value, through) {
    const event = validateEventView(value);
    if (event.session_id !== state.session_id)
        conflict();
    const previous = validateCursor(state.applied_cursor, state.session_id, through);
    validateCursor(cursorFor(event.session_id, event.sequence), state.session_id, through);
    const fingerprint = canonical(event);
    const known = state.fingerprints.get(event.sequence);
    if (known !== undefined) {
        if (known !== fingerprint)
            conflict();
        return state;
    }
    if (BigInt(event.sequence) !== BigInt(previous.sequence) + 1n)
        throw new ProtocolError('invalid_cursor');
    if (state.event_sequences.has(event.event_id))
        conflict();
    const reduced = reduceEvent(state, event);
    // Publish the cursor and identity ledger only after the entire reducer succeeds.
    return {
        ...reduced, applied_cursor: cursorFor(state.session_id, event.sequence),
        fingerprints: withEntry(state.fingerprints, event.sequence, fingerprint),
        event_sequences: withEntry(state.event_sequences, event.event_id, event.sequence),
    };
}
function reduceEvent(state, event) {
    switch (event.kind) {
        case 'session.created':
            if (state.metadata !== null)
                conflict();
            return { ...state, metadata: { ...event.data, created_at_ms: event.created_at_ms, updated_at_ms: event.created_at_ms } };
        case 'session.renamed':
            if (state.metadata === null)
                invalid();
            return { ...state, metadata: { ...state.metadata, title: event.data.title, updated_at_ms: event.created_at_ms } };
        case 'run.accepted': {
            if (event.run_id === null || state.metadata === null || state.runs.has(event.run_id)
                || [...state.runs.values()].some(active))
                conflict();
            const run = {
                run_id: event.run_id, accepted_sequence: event.sequence, accepted: event.data,
                started_sequence: null, turns: new Map(), active_turn_number: null, responses: new Map(),
                response_observations: [], tools: new Map(), finished: null, result: null, interrupted: null,
            };
            return { ...state, runs: withEntry(state.runs, run.run_id, run) };
        }
    }
    if (event.run_id === null)
        conflict();
    const run = state.runs.get(event.run_id);
    if (run === undefined)
        conflict();
    if (run.result !== null || run.interrupted !== null || (run.finished !== null && event.kind !== 'run.result'))
        invalid();
    if (event.kind === 'checkpoint')
        return state;
    let next;
    switch (event.kind) {
        case 'run.started':
            if (run.started_sequence !== null)
                invalid();
            next = { ...run, started_sequence: event.sequence };
            break;
        case 'turn.started': {
            if (run.started_sequence === null || run.active_turn_number !== null || event.data.turn_id === null)
                invalid();
            if (run.turns.has(event.data.number)
                || [...run.turns.values()].some(turn => turn.started.data.turn_id === event.data.turn_id))
                conflict();
            const turn = {
                first_sequence: event.sequence, started: { sequence: event.sequence, data: event.data }, finished: null,
                request_id: null, response_id: null, response_terminal: false,
            };
            next = { ...run, active_turn_number: event.data.number, turns: withEntry(run.turns, event.data.number, turn) };
            break;
        }
        case 'turn.finished': {
            const turn = activeTurn(run);
            if (event.data.number !== turn.started.data.number || event.data.turn_id !== turn.started.data.turn_id
                || event.data.response_id !== turn.response_id)
                conflict();
            next = { ...run, active_turn_number: null,
                turns: withEntry(run.turns, event.data.number, { ...turn, finished: { sequence: event.sequence, data: event.data } }) };
            break;
        }
        case 'run.finished':
            if (run.started_sequence === null || run.active_turn_number !== null)
                invalid();
            requireOutputs(run, event.data.outcome);
            next = { ...run, finished: { sequence: event.sequence, data: event.data } };
            break;
        case 'run.result':
            if (run.finished === null) {
                if (event.data.events_complete)
                    invalid();
                requireOutputs(run, event.data.outcome);
            }
            else if (canonical(run.finished.data.outcome) !== canonical(event.data.outcome))
                conflict();
            next = { ...run, result: { sequence: event.sequence, data: event.data } };
            break;
        case 'run.interrupted':
            next = { ...run, interrupted: { sequence: event.sequence, data: event.data } };
            break;
        case 'response.failed':
        case 'response.closed': {
            const turn = activeTurn(run);
            if (turn.response_terminal)
                invalid();
            const number = turn.started.data.number;
            next = { ...run,
                turns: withEntry(run.turns, number, { ...turn, response_terminal: true }),
                response_observations: [...run.response_observations,
                    { kind: event.kind, sequence: event.sequence, turn_id: turn.started.data.turn_id, data: event.data }] };
            // These DTOs have no response ID. Never attach a pre-identity failure to an older turn.
            const response = run.responses.get(number);
            if (response !== undefined) {
                let changed;
                if (event.kind === 'response.failed')
                    changed = { ...response, failure: { sequence: event.sequence, data: event.data } };
                else
                    changed = { ...response, closed_sequence: event.sequence };
                next = { ...next, responses: withEntry(run.responses, number, changed) };
            }
            break;
        }
        case 'tool.started':
        case 'tool.finished':
        case 'tool.reused':
        case 'tool.result':
            next = reduceTool(run, event);
            break;
        case 'response.started':
        case 'response.status':
        case 'response.item.started':
        case 'response.item.finished':
        case 'response.delta':
        case 'response.finished':
            next = reduceResponse(run, event);
            break;
    }
    return { ...state, runs: withEntry(state.runs, run.run_id, next) };
}
function reduceTool(run, event) {
    if (run.started_sequence === null)
        invalid();
    // Runtime tool events identify the current request. Stored results keep the original request.
    if (event.kind !== 'tool.result') {
        const turn = activeTurn(run);
        if (event.data.request_id === null)
            invalid();
        if (turn.request_id !== null && turn.request_id !== event.data.request_id)
            conflict();
        run = { ...run, turns: withEntry(run.turns, turn.started.data.number, { ...turn, request_id: event.data.request_id }) };
    }
    let tool = run.tools.get(event.data.call_id);
    if (event.kind === 'tool.started') {
        if (tool !== undefined)
            invalid();
        tool = {
            call_id: event.data.call_id, first_sequence: event.sequence, tool_name: event.data.tool_name,
            turn_number: activeTurn(run).started.data.number, started: { sequence: event.sequence, data: event.data },
            finished: null, result: null, reuses: [],
        };
    }
    else {
        if (tool === undefined)
            invalid();
        if (event.kind !== 'tool.result' && tool.tool_name !== event.data.tool_name)
            conflict();
        switch (event.kind) {
            case 'tool.finished':
                if (tool.finished !== null)
                    invalid();
                if (tool.started.data.request_id !== event.data.request_id || tool.turn_number !== run.active_turn_number
                    || (tool.result !== null && tool.result.data.is_error !== event.data.is_error))
                    conflict();
                tool = { ...tool, finished: { sequence: event.sequence, data: event.data } };
                break;
            case 'tool.result':
                if (tool.result !== null)
                    invalid();
                if (tool.started.data.request_id !== event.data.request_id
                    || (tool.finished !== null && tool.finished.data.is_error !== event.data.is_error))
                    conflict();
                tool = { ...tool, result: { sequence: event.sequence, data: event.data } };
                break;
            case 'tool.reused':
                if (tool.result === null)
                    invalid();
                // Reuse refers to old output from a different request, not another original execution.
                if (tool.result.data.request_id === event.data.request_id)
                    conflict();
                tool = { ...tool, reuses: [...tool.reuses, { sequence: event.sequence, data: event.data }] };
                break;
        }
    }
    return { ...run, tools: withEntry(run.tools, tool.call_id, tool) };
}
function reduceResponse(run, event) {
    const turn = activeTurn(run);
    if (turn.response_terminal)
        invalid();
    const id = event.data.response_id;
    if (turn.response_id !== null && turn.response_id !== id)
        conflict();
    const number = turn.started.data.number;
    let response = run.responses.get(number) ?? {
        response_id: id, first_sequence: event.sequence, started_sequence: null, status: null,
        items: new Map(), authoritative: null, failure: null, closed_sequence: null,
    };
    switch (event.kind) {
        case 'response.started':
            if (response.started_sequence !== null)
                invalid();
            response = { ...response, started_sequence: event.sequence };
            break;
        case 'response.status':
            response = { ...response, status: event.data.status };
            break;
        case 'response.finished':
            response = { ...response, authoritative: event.data, items: new Map(), status: event.data.outcome.status };
            break;
        case 'response.delta':
        case 'response.item.started':
        case 'response.item.finished': {
            const index = event.data.output_index;
            const previous = response.items.get(index);
            let itemId;
            if (event.kind === 'response.delta')
                itemId = event.data.item_id;
            else
                itemId = event.data.item.item_id;
            if (previous?.item_id != null && itemId !== null && previous.item_id !== itemId)
                conflict();
            itemId ??= previous?.item_id ?? null;
            if (itemId !== null && [...response.items].some(([key, item]) => key !== index && item.item_id === itemId))
                conflict();
            let item;
            if (event.kind === 'response.delta') {
                item = previous ?? { item_id: itemId, snapshot: null, snapshot_kind: null, parts: [] };
                const { kind, content_index, summary_index, delta } = event.data;
                const position = item.parts.findIndex(part => part.kind === kind && part.content_index === content_index && part.summary_index === summary_index);
                const parts = [...item.parts];
                if (position === -1) {
                    const part = { kind, content_index, summary_index, text: delta };
                    const before = parts.findIndex(existing => comparePart(existing, part) > 0);
                    parts.splice(before === -1 ? parts.length : before, 0, part);
                }
                else
                    parts[position] = { ...parts[position], text: parts[position].text + delta };
                item = { ...item, item_id: itemId, parts };
            }
            else {
                item = { item_id: itemId, snapshot: event.data.item, snapshot_kind: event.kind, parts: snapshotParts(event.data.item) };
            }
            response = { ...response, items: withEntry(response.items, index, item) };
            break;
        }
    }
    return { ...run, responses: withEntry(run.responses, number, response),
        turns: withEntry(run.turns, number, { ...turn, response_id: id, response_terminal: event.kind === 'response.finished' }) };
}
function snapshotParts(item) {
    let content = 0n;
    let summary = 0n;
    const parts = item.content.map(block => {
        if (block.kind === 'reasoning_summary')
            return { ...block, content_index: null, summary_index: (summary++).toString() };
        return { ...block, content_index: (content++).toString(), summary_index: null };
    });
    if (item.function_call !== null)
        parts.push({ kind: 'function_arguments', content_index: null, summary_index: null, text: item.function_call.arguments });
    return parts;
}
export function createHistory(sessionId) {
    return { conversation: createConversation(sessionId), through_sequence: null, complete: false, attach_cursor: null };
}
const HISTORY_LIMIT = 32;
export function historyRequest(state) {
    if (state.complete)
        invalid();
    return { after: state.conversation.applied_cursor, through: state.through_sequence, limit: HISTORY_LIMIT };
}
export function applyHistoryPage(state, value) {
    if (state.complete)
        invalid();
    const page = validateHistoryView(value);
    if (page.events.length > HISTORY_LIMIT)
        invalid();
    if (state.through_sequence === null && page.through_sequence === '0')
        throw new ProtocolError('invalid_cursor');
    const sid = state.conversation.session_id;
    if (page.session_id !== sid || (state.through_sequence !== null && state.through_sequence !== page.through_sequence))
        conflict();
    const head = page.through_sequence;
    const before = validateCursor(state.conversation.applied_cursor, sid, head);
    const after = validateCursor(page.next_after, sid, head);
    let sequence = before.sequence;
    for (const event of page.events) {
        if (BigInt(event.sequence) !== BigInt(sequence) + 1n)
            throw new ProtocolError('invalid_cursor');
        sequence = event.sequence;
    }
    if (after.sequence !== sequence || page.has_more !== (BigInt(sequence) < BigInt(head))
        || (page.has_more && page.events.length === 0))
        throw new ProtocolError('invalid_cursor');
    let conversation = state.conversation;
    for (const event of page.events)
        conversation = applyEvent(conversation, event, head);
    return { conversation, through_sequence: head, complete: !page.has_more, attach_cursor: page.has_more ? null : cursorFor(sid, head) };
}
export function createEpochs() { return { connection: 0n, selection: 0n, connected: false, session_id: null }; }
export function changeConnection(state, connected) {
    return { connection: state.connection + 1n, selection: state.selection + 1n, connected, session_id: null };
}
export function selectSessionEpoch(state, sessionId) {
    if (!state.connected)
        invalid();
    return { ...state, selection: state.selection + 1n, session_id: sessionId === null ? null : validateUuid(sessionId) };
}
export function captureEpoch(state) {
    return { connection: state.connection, selection: state.selection, session_id: state.session_id };
}
export function isCurrentEpoch(state, token) {
    return state.connected && state.connection === token.connection && state.selection === token.selection && state.session_id === token.session_id;
}
const labels = {
    text: 'Text', refusal: 'Refusal', reasoning_summary: 'Reasoning summary', reasoning_text: 'Reasoning text',
    function_arguments: 'Function arguments', custom_tool_input: 'Custom tool input (display only)',
    authoritative_text: 'Authoritative text fallback', unsupported: 'Unsupported content', tool_result: 'Tool result',
};
function compareDecimal(a, b) {
    if (BigInt(a) < BigInt(b))
        return -1;
    if (BigInt(a) > BigInt(b))
        return 1;
    return 0;
}
function comparePart(a, b) {
    // Summary and content indices belong to separate arrays. Summary precedes content.
    if ((a.summary_index !== null) !== (b.summary_index !== null))
        return a.summary_index !== null ? -1 : 1;
    const summary = compareDecimal(a.summary_index ?? '0', b.summary_index ?? '0');
    if (summary !== 0)
        return summary;
    return compareDecimal(a.content_index ?? '0', b.content_index ?? '0');
}
function itemSections(item, index, provisional) {
    const base = { output_index: index, item_id: item.item_id, function_call: item.snapshot?.function_call ?? null, is_error: null, provisional };
    const sections = item.parts.map(part => ({ ...base, ...part, label: labels[part.kind] }));
    if (item.snapshot?.unsupported_content || item.parts.some(part => part.kind === 'custom_tool_input')) {
        sections.push({ ...base, kind: 'unsupported', label: labels.unsupported, text: labels.unsupported, content_index: null, summary_index: null });
    }
    return sections;
}
function responseSections(response) {
    const authoritative = response.authoritative;
    if (authoritative === null) {
        return [...response.items].sort(([a], [b]) => compareDecimal(a, b)).flatMap(([index, item]) => itemSections(item, index, true));
    }
    let sections = authoritative.items.flatMap((snapshot, index) => itemSections({
        item_id: snapshot.item_id, snapshot, snapshot_kind: null, parts: snapshotParts(snapshot),
    }, index.toString(), false));
    const message = (section) => section.kind === 'text' || section.kind === 'refusal';
    const answers = sections.filter(message).map(section => section.text);
    const text = authoritative.text;
    const represented = answers.some(answer => answer.includes(text)) || answers.join('').includes(text) || answers.join('\n').includes(text);
    if (text !== '' && !represented) {
        // Replace covered blocks instead of repeating an answer in the normalized fallback.
        // Keep blocks absent from the fallback, including refusals and all reasoning.
        const first = sections.findIndex(message);
        const insert = first === -1 ? sections.length : first;
        const fallback = {
            kind: 'authoritative_text', label: labels.authoritative_text, text, output_index: null, item_id: null,
            content_index: null, summary_index: null, function_call: null, is_error: null, provisional: false,
        };
        sections = sections.flatMap((section, index) => {
            const kept = message(section) && section.text !== '' && text.includes(section.text) ? [] : [section];
            return index === insert ? [fallback, ...kept] : kept;
        });
        if (first === -1)
            sections.push(fallback);
    }
    return sections;
}
export function selectDisplay(state) {
    return [...state.runs.values()].sort((a, b) => compareDecimal(a.accepted_sequence, b.accepted_sequence)).map(run => {
        let execution = run.started_sequence === null ? 'accepted' : 'running';
        if (run.finished !== null)
            execution = run.finished.data.outcome.type;
        if (run.result !== null)
            execution = run.result.data.outcome.type;
        if (run.interrupted !== null)
            execution = 'interrupted';
        const entries = [...run.responses.values()].map(response => ({ kind: 'response', response, sections: responseSections(response) }));
        for (const tool of run.tools.values()) {
            const sections = [];
            if (tool.result !== null)
                sections.push({
                    kind: 'tool_result', label: labels.tool_result, text: tool.result.data.output, is_error: tool.result.data.is_error,
                    output_index: null, item_id: null, content_index: null, summary_index: null, function_call: null, provisional: false,
                });
            entries.push({ kind: 'tool', tool, sections });
        }
        entries.sort((a, b) => compareDecimal(a.kind === 'response' ? a.response.first_sequence : a.tool.first_sequence, b.kind === 'response' ? b.response.first_sequence : b.tool.first_sequence));
        return { run, user_text: run.accepted.user_text, execution, result_recorded: run.result !== null, entries };
    });
}
