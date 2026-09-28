import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEvent, applyHistoryPage, captureEpoch, changeConnection, createConversation, createEpochs,
  createHistory, eventFingerprint, historyRequest, isCurrentEpoch, selectDisplay, selectSessionEpoch,
} from '../dist/state.js';
import { ProtocolError } from '../dist/api.js';
import * as fixtures from './wire-fixtures.mjs';

// Wire guards allow nullable fields; reducer histories use the storage-valid lifecycle.
const f = { ...fixtures, eventData: {
  ...fixtures.eventData,
  'turn.started': { turn_id: 'turn-1', number: '1' },
  'turn.finished': { ...fixtures.eventData['turn.finished'], turn_id: 'turn-1', number: '1' },
  'tool.started': { ...fixtures.eventData['tool.started'], request_id: 'request' },
  'tool.result': { ...fixtures.eventData['tool.result'], request_id: 'request' },
  'tool.reused': { ...fixtures.eventData['tool.reused'], request_id: 'next request' },
} };

const rid2 = '01234567-89ab-4cde-8fab-0123456789ac';
function uuid(sequence) {
  const hex = BigInt(sequence).toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function wire(kind, sequence, data = f.eventData[kind], runId = f.rid, sid = f.sid) {
  return { ...f.event(kind, sequence, sid), event_id: uuid(sequence), data: structuredClone(data), run_id: kind.startsWith('session.') ? null : runId };
}
function script() {
  let state = createConversation(f.sid);
  const events = [];
  return {
    get state() { return state; }, events,
    emit(kind, data = f.eventData[kind], runId = f.rid) {
      const sequence = (BigInt(state.applied_cursor.split(':')[1]) + 1n).toString();
      const event = wire(kind, sequence, data, runId);
      state = applyEvent(state, event);
      events.push(event);
      return event;
    },
  };
}
function accepted() {
  const s = script();
  s.emit('session.created');
  s.emit('run.accepted');
  return s;
}
function running() {
  const s = accepted();
  s.emit('run.started');
  s.emit('turn.started');
  return s;
}
function startTurn(s, number = '2', runId = f.rid) {
  s.emit('turn.started', { turn_id: `turn-${number}`, number }, runId);
}
function finishTurn(s, number = '1', responseId = 'response') {
  s.emit('turn.finished', { ...f.eventData['turn.finished'], turn_id: `turn-${number}`, number, response_id: responseId });
}
function message(text, itemId = 'item') {
  return { item_id: itemId, kind: 'message', function_call: null, content: [{ kind: 'text', text }], unsupported_content: false };
}
function response(items, text = '', id = 'response', provenance = 'native_terminal') {
  return { ...structuredClone(f.response), response_id: id, outcome: { status: 'completed' }, items, text, output_provenance: provenance };
}
function delta(text, fields = {}) {
  return { response_id: 'response', item_id: 'item', output_index: '0', content_index: '0', summary_index: null, kind: 'text', delta: text, ...fields };
}
function sections(s, runIndex = 0) { return selectDisplay(s.state ?? s)[runIndex].entries.flatMap(entry => entry.sections); }
function texts(s, runIndex = 0) { return sections(s, runIndex).map(section => section.text); }
function page(events, head, next = events.at(-1)?.sequence ?? '0', more = BigInt(next) < BigInt(head), sid = f.sid) {
  return { api_version: 1, session_id: sid, through_sequence: head, next_after: `${sid}:${next}`, has_more: more, events };
}
function protocol(callback, category) {
  assert.throws(callback, error => error instanceof ProtocolError && error.category === category && error.message === `protocol.${category}`);
}
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  return value;
}
function freeze(value) {
  if (value instanceof Map) {
    for (const entry of value.values()) freeze(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
  }
  return Object.freeze(value);
}

test('created and renamed metadata stay empty; checkpoints add no message', () => {
  const s = script();
  assert.equal(s.state.applied_cursor, `${f.sid}:0`);
  assert.deepEqual(selectDisplay(s.state), []);
  s.emit('session.created');
  s.emit('session.renamed', { title: '  new\r\n雪  ' });
  assert.deepEqual(selectDisplay(s.state), []);
  assert.equal(s.state.metadata.title, '  new\r\n雪  ');
  assert.equal(s.state.metadata.workspace, null);
  assert.equal(s.state.metadata.created_at_ms, '9007199254740993');
  s.emit('run.accepted');
  const before = selectDisplay(s.state);
  s.emit('checkpoint');
  assert.deepEqual(selectDisplay(s.state), before);
  assert.equal(s.state.applied_cursor, `${f.sid}:4`);
});

test('all EventView kinds are applied in valid turns with distinct lifecycle and recording metadata', () => {
  const s = running();
  for (const kind of ['session.renamed', 'checkpoint', 'response.started', 'response.status', 'response.delta',
    'response.item.started', 'response.item.finished', 'response.finished', 'tool.started', 'tool.result', 'tool.finished']) {
    let data = f.eventData[kind];
    // One real item identity remains at one output index until authoritative replacement.
    if (kind.startsWith('response.item.')) data = { ...data, output_index: '18446744073709551615' };
    s.emit(kind, data);
  }
  finishTurn(s);
  startTurn(s);
  s.emit('tool.reused');
  s.emit('response.failed');
  finishTurn(s, '2', null);
  startTurn(s, '3');
  s.emit('response.closed');
  finishTurn(s, '3', null);
  s.emit('run.finished');
  s.emit('run.result');
  s.emit('run.accepted', f.eventData['run.accepted'], rid2);
  s.emit('run.interrupted', f.eventData['run.interrupted'], rid2);
  assert.deepEqual(new Set(s.events.map(event => event.kind)), new Set(Object.keys(f.eventData)));
  const run = s.state.runs.get(f.rid);
  assert.deepEqual(run.finished.data, f.eventData['run.finished']);
  assert.deepEqual(run.result.data, f.result);
  assert.equal(run.response_observations.length, 2);
  assert.equal(run.turns.get('1').started.data.turn_id, 'turn-1');
  assert.equal(run.turns.get('1').finished.data.response_id, 'response');
  assert.equal(run.tools.get('call').reuses.length, 1);
  assert.equal(selectDisplay(s.state)[1].execution, 'interrupted');
});

test('recursive key order is canonical but array order and exact string bytes are not normalized', () => {
  const s = running();
  const event = s.emit('response.finished', response([message(f.exactText), message('other', 'second')], f.exactText));
  const reordered = reverseKeys(event);
  assert.equal(eventFingerprint(event), eventFingerprint(reordered));
  assert.strictEqual(applyEvent(s.state, reordered), s.state);
  const arrays = structuredClone(event);
  arrays.data.items.reverse();
  protocol(() => applyEvent(s.state, arrays), 'identity_mismatch');
  const bytes = structuredClone(event);
  bytes.data.items[0].content[0].text = f.exactText.replace('\r\n', '\n');
  protocol(() => applyEvent(s.state, bytes), 'identity_mismatch');
  protocol(() => applyEvent(s.state, { ...event, event_id: f.eid }), 'identity_mismatch');
});

test('duplicate acceptance and checkpoint delivery return the same state without duplicate user text', () => {
  const s = accepted();
  const checkpoint = s.emit('checkpoint');
  for (const event of [...s.events, checkpoint]) assert.strictEqual(applyEvent(s.state, event), s.state);
  assert.equal(selectDisplay(s.state).length, 1);
  assert.equal(selectDisplay(s.state)[0].user_text, f.exactText);
  protocol(() => applyEvent(s.state, wire('run.accepted', '4')), 'identity_mismatch');
});

test('gaps, old unknown sequences, future heads, cross-session and invalid records preserve the applied prefix', () => {
  const s = accepted();
  const before = structuredClone(s.state);
  protocol(() => applyEvent(s.state, wire('checkpoint', '4')), 'invalid_cursor');
  protocol(() => applyEvent(s.state, wire('checkpoint', '3'), '2'), 'invalid_cursor');
  protocol(() => applyEvent(s.state, wire('checkpoint', '3', {}, f.rid, f.otherSid)), 'identity_mismatch');
  protocol(() => applyEvent(s.state, { ...wire('checkpoint', '3'), sequence: '03' }), 'invalid_decimal');
  protocol(() => applyEvent(s.state, { ...wire('checkpoint', '3'), event_id: 'not-an-id' }), 'invalid_identity');
  protocol(() => applyEvent(s.state, { ...wire('checkpoint', '3'), kind: 'private.native' }), 'invalid_schema');
  protocol(() => applyEvent(s.state, { ...wire('checkpoint', '3'), api_version: 2 }), 'unsupported_version');
  protocol(() => applyEvent(s.state, wire('checkpoint', '3', {}, rid2)), 'identity_mismatch');
  const unknown = { ...s.state, fingerprints: new Map() };
  protocol(() => applyEvent(unknown, s.events[0]), 'invalid_cursor');
  assert.deepEqual(s.state, before);
});

test('event IDs cannot be reused at a later sequence even with identical checkpoint data', () => {
  const s = accepted();
  const checkpoint = s.emit('checkpoint');
  protocol(() => applyEvent(s.state, { ...checkpoint, sequence: '4' }), 'identity_mismatch');
  assert.equal(s.state.event_sequences.get(checkpoint.event_id), '3');
  assert.equal(s.state.applied_cursor, `${f.sid}:3`);
});

test('reducer failure leaves cursor and both identity ledgers unchanged and does not poison retry', () => {
  const s = accepted();
  const before = structuredClone(s.state);
  protocol(() => applyEvent(s.state, wire('tool.reused', '3')), 'invalid_schema');
  assert.deepEqual(s.state, before);
  const next = applyEvent(s.state, wire('run.started', '3'));
  assert.equal(next.applied_cursor, `${f.sid}:3`);
  assert.equal(next.fingerprints.size, 3);
  assert.equal(next.event_sequences.get(uuid('3')), '3');
  assert.equal(s.state.fingerprints.size, 2);
});

test('BigInt cursor arithmetic crosses 2^53 and reaches i64 max without numeric rounding', () => {
  const s = accepted();
  // Seed only the arithmetic boundary; this does not claim replay of quadrillions of records.
  for (const previous of ['9007199254740992', '9223372036854775806']) {
    const sequence = (BigInt(previous) + 1n).toString();
    const seed = { ...s.state, applied_cursor: `${f.sid}:${previous}` };
    const next = applyEvent(seed, wire('checkpoint', sequence), sequence);
    assert.equal(next.applied_cursor, `${f.sid}:${sequence}`);
    assert.strictEqual(applyEvent(next, wire('checkpoint', sequence)), next);
    protocol(() => applyEvent(seed, wire('checkpoint', (BigInt(previous) + 2n).toString())), previous.startsWith('922') ? 'invalid_decimal' : 'invalid_cursor');
  }
});

test('inputs, prior states and display reads are not mutated or aliased to incoming DTOs', () => {
  const state = applyEvent(createConversation(f.sid), wire('session.created', '1'));
  const before = structuredClone(state);
  const input = wire('run.accepted', '2');
  const next = applyEvent(freeze(state), freeze(input));
  assert.deepEqual(state, before);
  const started = applyEvent(next, wire('run.started', '3'));
  const turn = applyEvent(started, wire('turn.started', '4'));
  const item = wire('response.finished', '5', response([message('saved')], 'saved'));
  const final = applyEvent(turn, item);
  item.data.items[0].content[0].text = 'changed externally';
  assert.deepEqual(texts(final), ['saved']);
  const copy = structuredClone(final);
  selectDisplay(freeze(final));
  assert.deepEqual(final, copy);
});

test('four fixed-head pages exclude intervening writes; after H attaches every later event once', () => {
  const s = running();
  while (s.events.length < 99) s.emit('checkpoint');
  const captured = '99';
  let history = createHistory(f.sid);
  assert.deepEqual(historyRequest(history), { after: `${f.sid}:0`, through: null, limit: 32 });
  function fixturePage(request) {
    const head = request.through ?? s.events.at(-1).sequence;
    const after = BigInt(request.after.split(':')[1]);
    const events = s.events.filter(event => BigInt(event.sequence) > after && BigInt(event.sequence) <= BigInt(head)).slice(0, request.limit);
    return page(events, head);
  }
  history = applyHistoryPage(history, fixturePage(historyRequest(history)));
  assert.equal(history.through_sequence, captured);
  s.emit('session.renamed', { title: 'after H' });
  s.emit('checkpoint');
  let pages = 1;
  while (!history.complete) {
    assert.equal(historyRequest(history).through, captured);
    history = applyHistoryPage(history, fixturePage(historyRequest(history)));
    pages++;
    if (pages === 2) s.emit('response.started');
  }
  assert.equal(pages, 4);
  assert.equal(history.attach_cursor, `${f.sid}:99`);
  assert.equal(history.conversation.applied_cursor, `${f.sid}:99`);
  assert.equal(history.conversation.fingerprints.size, 99);
  assert.equal(history.conversation.metadata.title, f.exactText);
  s.emit('response.delta', delta('after attach'));
  let observed = history.conversation;
  for (const event of s.events.filter(event => BigInt(event.sequence) > 99n)) {
    observed = applyEvent(observed, event);
    assert.strictEqual(applyEvent(observed, reverseKeys(event)), observed);
  }
  assert.equal(observed.metadata.title, 'after H');
  assert.equal(observed.fingerprints.size, 103);
  assert.deepEqual(texts(observed), ['after attach']);
  protocol(() => historyRequest(history), 'invalid_schema');
  protocol(() => applyHistoryPage(history, page([], '99', '99')), 'invalid_schema');
});

test('page session, head, next_after, order, progress and has_more must agree atomically', () => {
  const s = accepted();
  s.emit('checkpoint');
  s.emit('checkpoint');
  const history = applyHistoryPage(createHistory(f.sid), page(s.events.slice(0, 2), '4'));
  const remaining = s.events.slice(2);
  const badPages = [
    [page(remaining, '5'), 'identity_mismatch'],
    [page(remaining, '4', '4', false, f.otherSid), 'identity_mismatch'],
    [page(remaining, '4', '3', false), 'invalid_cursor'],
    [page(remaining, '4', '4', true), 'invalid_cursor'],
    [page(remaining.slice(0, 1), '4', '3', false), 'invalid_cursor'],
    [page([], '4', '2', true), 'invalid_cursor'],
    [page([...remaining].reverse(), '4', '4', false), 'invalid_cursor'],
    [page([remaining[0], remaining[0]], '4', '3', true), 'invalid_cursor'],
    [page([remaining[1]], '4'), 'invalid_cursor'],
    [page(remaining, '4', '5', false), 'invalid_cursor'],
    [page([s.events[1], ...remaining], '4'), 'invalid_cursor'],
    [page([wire('checkpoint', '5')], '4', '4', false), 'invalid_cursor'],
  ];
  const before = structuredClone(history);
  for (const [bad, category] of badPages) {
    protocol(() => applyHistoryPage(freeze(history), bad), category);
    assert.deepEqual(history, before);
  }
  const complete = applyHistoryPage(history, page(remaining, '4'));
  assert.equal(complete.conversation.applied_cursor, `${f.sid}:4`);
});

test('a later reducer failure rejects a whole page without publishing its good prefix or H', () => {
  const s = accepted();
  const bad = [wire('checkpoint', '3'), wire('tool.reused', '4')];
  const first = createHistory(f.sid);
  protocol(() => applyHistoryPage(first, page([...s.events, ...bad], '4')), 'invalid_schema');
  assert.equal(first.through_sequence, null);
  assert.equal(first.conversation.applied_cursor, `${f.sid}:0`);
  const loaded = applyHistoryPage(first, page(s.events, '4'));
  protocol(() => applyHistoryPage(loaded, page(bad, '4')), 'invalid_schema');
  assert.equal(loaded.conversation.applied_cursor, `${f.sid}:2`);
  assert.equal(loaded.conversation.fingerprints.size, 2);
});

test('initial history needs a positive head; a metadata-only session still has no messages', () => {
  const empty = createHistory(f.sid);
  protocol(() => applyHistoryPage(empty, page([], '1', '0', false)), 'invalid_cursor');
  protocol(() => applyHistoryPage(empty, page([], '1', '0', true)), 'invalid_cursor');
  protocol(() => applyHistoryPage(empty, page([], '0')), 'invalid_cursor');
  const done = applyHistoryPage(empty, page([wire('session.created', '1')], '1'));
  assert.equal(done.complete, true);
  assert.equal(done.attach_cursor, `${f.sid}:1`);
  assert.deepEqual(selectDisplay(done.conversation), []);
});

test('session switching, full reload and disconnect/reconnect fence late page, event and reply callbacks', () => {
  let epochs = changeConnection(createEpochs(), true);
  epochs = selectSessionEpoch(epochs, f.sid);
  const a = captureEpoch(epochs);
  const pending = { session_id: f.sid, accepted: false };
  epochs = selectSessionEpoch(epochs, f.otherSid);
  const b = captureEpoch(epochs);
  let visible = createHistory(f.otherSid);
  const original = visible;
  const callbacks = [
    () => { if (isCurrentEpoch(epochs, a)) visible = applyHistoryPage(visible, page([wire('session.created', '1')], '1')); },
    () => { if (isCurrentEpoch(epochs, a)) visible = { ...visible, conversation: applyEvent(visible.conversation, wire('session.created', '1')) }; },
    () => { pending.accepted = true; if (isCurrentEpoch(epochs, a)) visible = createHistory(f.sid); },
  ];
  for (const callback of callbacks) callback();
  assert.strictEqual(visible, original);
  assert.deepEqual(pending, { session_id: f.sid, accepted: true });
  assert.equal(isCurrentEpoch(epochs, b), true);
  epochs = selectSessionEpoch(epochs, f.otherSid);
  assert.equal(isCurrentEpoch(epochs, b), false);
  const reload = captureEpoch(epochs);
  epochs = changeConnection(epochs, false);
  assert.equal(isCurrentEpoch(epochs, reload), false);
  assert.equal(isCurrentEpoch(epochs, captureEpoch(epochs)), false);
  epochs = selectSessionEpoch(changeConnection(epochs, true), f.otherSid);
  assert.equal(isCurrentEpoch(epochs, reload), false);
  assert.equal(isCurrentEpoch(epochs, a), false);
});

test('epoch counters remain exact above 2^53; selecting a session never retains another conversation', () => {
  const prior = { connection: 9007199254740992n, selection: 9007199254740992n, connected: true, session_id: f.sid };
  const next = selectSessionEpoch(prior, f.sid);
  assert.equal(next.selection, 9007199254740993n);
  assert.equal(isCurrentEpoch(next, captureEpoch(prior)), false);
  assert.equal(changeConnection(next, false).connection, 9007199254740993n);
  protocol(() => selectSessionEpoch(createEpochs(), f.sid), 'invalid_schema');
  const s = running();
  s.emit('response.delta', delta('A only'));
  const selected = createConversation(f.otherSid);
  assert.deepEqual(selectDisplay(selected), []);
  assert.equal(selected.applied_cursor, `${f.otherSid}:0`);
});

test('runs follow accepted sequence, not UUID order; canonical user text appears once', () => {
  const s = accepted();
  s.emit('run.interrupted');
  s.emit('run.accepted', { ...f.eventData['run.accepted'], user_text: ' second\n' }, rid2);
  const display = selectDisplay(s.state);
  assert.deepEqual(display.map(run => run.run.run_id), [f.rid, rid2]);
  assert.deepEqual(display.map(run => run.user_text), [f.exactText, ' second\n']);
  assert.deepEqual(display[0].run.accepted.available_skills, ['project:synthetic']);
});

test('provisional output, content, summary and kind keys stay independent and use BigInt order', () => {
  const s = running();
  s.emit('response.delta', delta('high', { output_index: '18446744073709551615', item_id: 'high' }));
  s.emit('response.delta', delta('c2', { content_index: '9007199254740993' }));
  s.emit('response.delta', delta('c1', { content_index: '9007199254740992' }));
  s.emit('response.delta', delta(' +', { content_index: '9007199254740992' }));
  s.emit('response.delta', delta('refusal', { content_index: '9007199254740992', kind: 'refusal' }));
  s.emit('response.delta', delta('summary2', { content_index: null, summary_index: '2', kind: 'reasoning_summary' }));
  s.emit('response.delta', delta('summary1', { content_index: null, summary_index: '1', kind: 'reasoning_summary' }));
  s.emit('response.delta', delta('reason', { content_index: '3', kind: 'reasoning_text' }));
  assert.deepEqual(texts(s), ['summary1', 'summary2', 'reason', 'c1 +', 'refusal', 'c2', 'high']);
  assert.equal(s.state.runs.get(f.rid).responses.get('1').items.size, 2);
  assert.equal(sections(s).at(-1).output_index, '18446744073709551615');
});

test('item snapshots replace deltas; later deltas extend only their slot; final response replaces everything', () => {
  const s = running();
  s.emit('response.started');
  s.emit('response.delta', delta('old provisional'));
  s.emit('response.delta', delta('other provisional', { output_index: '8', item_id: 'other' }));
  s.emit('response.item.started', { response_id: 'response', output_index: '0', item: message('snapshot') });
  assert.deepEqual(texts(s), ['snapshot', 'other provisional']);
  s.emit('response.delta', delta(' + delta'));
  assert.deepEqual(texts(s), ['snapshot + delta', 'other provisional']);
  s.emit('response.item.finished', { response_id: 'response', output_index: '0', item: message('item done') });
  assert.deepEqual(texts(s), ['item done', 'other provisional']);
  s.emit('response.finished', response([message('final')], 'final'));
  assert.deepEqual(texts(s), ['final']);
  assert.equal(s.state.runs.get(f.rid).responses.get('1').items.size, 0);
  assert.equal(sections(s)[0].provisional, false);
  protocol(() => applyEvent(s.state, wire('response.delta', (BigInt(s.events.length) + 1n).toString(), delta('late'))), 'invalid_schema');
});

test('response item identity conflicts fail without moving the cursor', () => {
  const s = running();
  s.emit('response.delta', delta('saved'));
  const before = structuredClone(s.state);
  protocol(() => applyEvent(s.state, wire('response.delta', '6', delta('bad', { item_id: 'different' }))), 'identity_mismatch');
  protocol(() => applyEvent(s.state, wire('response.delta', '6', delta('bad', { output_index: '1' }))), 'identity_mismatch');
  protocol(() => applyEvent(s.state, wire('response.item.finished', '6', { response_id: 'response', output_index: '0', item: message('bad', 'different') })), 'identity_mismatch');
  assert.deepEqual(s.state, before);
});

test('response IDs and tool call IDs are isolated across runs', () => {
  const s = running();
  s.emit('response.finished', response([message('first')], 'first'));
  const start = { ...f.eventData['tool.started'], call_id: '__proto__' };
  s.emit('tool.started', start);
  s.emit('tool.result', { call_id: '__proto__', request_id: 'request', output: 'one', is_error: false });
  finishTurn(s);
  s.emit('run.finished');
  s.emit('run.accepted', f.eventData['run.accepted'], rid2);
  s.emit('run.started', {}, rid2);
  startTurn(s, '1', rid2);
  s.emit('response.finished', response([message('second')], 'second'), rid2);
  s.emit('tool.started', start, rid2);
  s.emit('tool.result', { call_id: '__proto__', request_id: 'request', output: 'two', is_error: true }, rid2);
  assert.deepEqual(texts(s, 0), ['first', 'one']);
  assert.deepEqual(texts(s, 1), ['second', 'two']);
  assert.equal(s.state.runs.get(rid2).tools.get('__proto__').result.data.is_error, true);
});

test('multiple responses and tools retain accepted observation order without UUID sorting', () => {
  const s = running();
  s.emit('response.finished', response([message('z answer')], 'z answer', 'z'));
  s.emit('tool.started');
  s.emit('tool.result');
  finishTurn(s, '1', 'z');
  startTurn(s);
  s.emit('response.finished', response([message('a answer')], 'a answer', 'a'));
  const entries = selectDisplay(s.state)[0].entries;
  assert.deepEqual(entries.map(entry => entry.kind), ['response', 'tool', 'response']);
  assert.equal(entries[0].response.response_id, 'z');
  assert.equal(entries[2].response.response_id, 'a');
});

test('native and recovered authoritative views retain actual provenance, items, outcomes and usage', () => {
  for (const provenance of ['native_terminal', 'validated_output_item_done']) {
    const s = running();
    s.emit('response.delta', delta('provisional'));
    const final = response([message(f.exactText)], f.exactText, 'response', provenance);
    final.outcome = { status: 'incomplete', reason: 'max_output_tokens' };
    s.emit('response.finished', final);
    assert.deepEqual(s.state.runs.get(f.rid).responses.get('1').authoritative, final);
    assert.equal(sections(s)[0].text, f.exactText);
    assert.equal(sections(s).length, 1);
    assert.equal(selectDisplay(s.state)[0].execution, 'running');
  }
});

test('authoritative ItemView blocks retain exact output and block order including refusals and reasoning', () => {
  const s = running();
  const items = [
    { ...message('unused'), content: [{ kind: 'refusal', text: 'refuse\r\n' }, { kind: 'text', text: f.exactText }] },
    { item_id: 'reason', kind: 'reasoning', function_call: null, unsupported_content: false,
      content: [{ kind: 'reasoning_text', text: 'reasoning first' }, { kind: 'reasoning_summary', text: 'summary next' }] },
    { item_id: 'function', kind: 'function_call', function_call: f.functionCall, content: [], unsupported_content: false },
  ];
  s.emit('response.finished', response(items, f.exactText));
  assert.deepEqual(texts(s), ['refuse\r\n', f.exactText, 'reasoning first', 'summary next', f.exactText]);
  assert.deepEqual(sections(s).map(section => section.kind), ['refusal', 'text', 'reasoning_text', 'reasoning_summary', 'function_arguments']);
  assert.deepEqual(sections(s).map(section => section.output_index), ['0', '0', '1', '1', '2']);
  assert.deepEqual(sections(s).at(-1).function_call, f.functionCall);
});

test('normalized text is one labelled fallback only when not represented by message blocks', () => {
  const fixtures = [
    [[], 'normalized\r\n', ['normalized\r\n'], 1],
    [[message('answer')], 'answer', ['answer'], 0],
    [[message('a'), message('b', 'second')], 'ab', ['a', 'b'], 0],
    [[message('a'), message('b', 'second')], 'a\nb', ['a', 'b'], 0],
    [[message('answer')], 'answer\nextra', ['answer\nextra'], 1],
    [[message('answer and more')], 'answer', ['answer and more'], 0],
    [[message('blocks only')], 'different normalized info', ['different normalized info', 'blocks only'], 1],
    [[{ ...message(''), content: [{ kind: 'refusal', text: 'refusal' }] }], 'refusal', ['refusal'], 0],
  ];
  for (const [items, text, expected, count] of fixtures) {
    const s = running();
    s.emit('response.finished', response(items, text));
    assert.deepEqual(texts(s), expected);
    const fallbacks = sections(s).filter(section => section.kind === 'authoritative_text');
    assert.equal(fallbacks.length, count);
    if (count) assert.equal(fallbacks[0].label, 'Authoritative text fallback');
  }
});

test('reasoning does not suppress fallback; unsupported markers remain visible with exact supported text', () => {
  const s = running();
  const reason = { item_id: 'reason', kind: 'reasoning', function_call: null, content: [{ kind: 'reasoning_text', text: 'same bytes' }], unsupported_content: false };
  const unknown = { item_id: 'unknown', kind: 'unknown', function_call: null, content: [], unsupported_content: true };
  s.emit('response.finished', response([reason, unknown], 'same bytes'));
  assert.deepEqual(texts(s), ['same bytes', 'Unsupported content', 'same bytes']);
  assert.deepEqual(sections(s).map(section => section.kind), ['reasoning_text', 'unsupported', 'authoritative_text']);
  const mixed = running();
  mixed.emit('response.finished', response([{ ...message(f.exactText), unsupported_content: true }], f.exactText));
  assert.deepEqual(texts(mixed), [f.exactText, 'Unsupported content']);
});

test('function arguments and custom tool deltas stay inert exact strings, even when invalid JSON', () => {
  const s = running();
  s.emit('response.delta', delta('{"x":', { kind: 'function_arguments', content_index: null }));
  s.emit('response.delta', delta('not JSON\r\n雪', { kind: 'function_arguments', content_index: null }));
  assert.deepEqual(texts(s), ['{"x":not JSON\r\n雪']);
  const item = { item_id: 'item', kind: 'function_call', content: [], unsupported_content: false, function_call: { ...f.functionCall, arguments: '{', complete: false } };
  s.emit('response.item.started', { response_id: 'response', output_index: '0', item });
  s.emit('response.delta', delta('unparsed}', { kind: 'function_arguments', content_index: null }));
  assert.deepEqual(texts(s), ['{unparsed}']);
  s.emit('response.delta', delta(f.exactText, { item_id: 'custom', output_index: '1', content_index: null, kind: 'custom_tool_input' }));
  assert.deepEqual(texts(s), ['{unparsed}', f.exactText, 'Unsupported content']);
  assert.equal(sections(s)[1].label, 'Custom tool input (display only)');
});

test('tool finish fabricates no result; result bytes and matching is_error flags win over content shape', () => {
  const s = running();
  s.emit('tool.started');
  s.emit('tool.finished');
  assert.deepEqual(texts(s), []);
  assert.equal(s.state.runs.get(f.rid).tools.get('call').result, null);
  const output = '{"error":"still success"}\r\n雪🙂\r\t\u0000e\u0301\n';
  s.emit('tool.result', { call_id: 'call', request_id: 'request', output, is_error: false });
  finishTurn(s, '1', null);
  startTurn(s);
  s.emit('tool.reused', { ...f.eventData['tool.reused'], request_id: 'next request' });
  finishTurn(s, '2', null);
  startTurn(s, '3');
  s.emit('tool.reused', { ...f.eventData['tool.reused'], request_id: 'third request' });
  assert.deepEqual(texts(s), [output]);
  assert.equal(sections(s)[0].is_error, false);
  const tool = s.state.runs.get(f.rid).tools.get('call');
  assert.equal(tool.finished.data.is_error, false);
  assert.equal(tool.reuses.length, 2);
  assert.equal(tool.result.data.request_id, 'request');
  s.emit('tool.started', { ...f.eventData['tool.started'], call_id: 'error', request_id: 'third request' });
  s.emit('tool.result', { call_id: 'error', request_id: 'third request', output: 'ordinary text', is_error: true });
  assert.equal(sections(s).at(-1).is_error, true);
});

test('tool reuse requires the earlier result in this run; duplicate results and conflicting names fail atomically', () => {
  const s = running();
  s.emit('tool.started');
  s.emit('tool.result');
  finishTurn(s, '1', null);
  startTurn(s);
  protocol(() => applyEvent(s.state, wire('tool.result', '9', { ...f.eventData['tool.result'], output: 'changed' })), 'invalid_schema');
  protocol(() => applyEvent(s.state, wire('tool.reused', '9', { ...f.eventData['tool.reused'], tool_name: 'changed' })), 'identity_mismatch');
  assert.equal(s.state.applied_cursor, `${f.sid}:8`);
  s.emit('run.result');
  s.emit('run.accepted', f.eventData['run.accepted'], rid2);
  s.emit('run.started', {}, rid2);
  startTurn(s, '1', rid2);
  protocol(() => applyEvent(s.state, wire('tool.reused', '13', f.eventData['tool.reused'], rid2)), 'invalid_schema');
  assert.equal(s.state.runs.get(rid2).tools.size, 0);
});

test('response failure or closure preserves partial output and uncertainty without finishing a run', () => {
  for (const terminal of ['response.failed', 'response.closed']) {
    const s = running();
    s.emit('response.started');
    s.emit('response.delta', delta('partial\r\n'));
    if (terminal === 'response.failed') s.emit(terminal, { code: 'transport_error', upstream_outcome: 'unknown' });
    else s.emit(terminal);
    const run = s.state.runs.get(f.rid);
    assert.deepEqual(texts(s), ['partial\r\n']);
    if (terminal === 'response.failed') assert.equal(run.responses.get('1').failure.data.upstream_outcome, 'unknown');
    else assert.equal(run.responses.get('1').closed_sequence, '7');
    assert.equal(run.finished, null);
    assert.equal(run.result, null);
    assert.equal(selectDisplay(s.state)[0].execution, 'running');
  }
});

test('failure before response identity stays on the run instead of contaminating the previous response', () => {
  const s = running();
  s.emit('response.finished', response([message('done response')], 'done response'));
  finishTurn(s);
  startTurn(s);
  s.emit('response.failed', { code: 'transport_error', upstream_outcome: 'not_submitted' });
  const run = s.state.runs.get(f.rid);
  assert.equal(run.responses.size, 1);
  assert.equal(run.responses.get('1').failure, null);
  assert.equal(run.responses.get('1').closed_sequence, null);
  assert.equal(run.response_observations[0].data.upstream_outcome, 'not_submitted');
});

test('response completion, run terminal and result recording are separate; run.result never appends an answer', () => {
  const s = running();
  s.emit('response.finished', response([message('answer')], 'answer'));
  assert.equal(selectDisplay(s.state)[0].execution, 'running');
  assert.equal(selectDisplay(s.state)[0].result_recorded, false);
  finishTurn(s);
  s.emit('run.finished', { outcome: { type: 'completed' }, summary: f.summary });
  assert.equal(selectDisplay(s.state)[0].execution, 'completed');
  assert.equal(selectDisplay(s.state)[0].result_recorded, false);
  const before = texts(s);
  s.emit('run.result', { outcome: { type: 'completed' }, summary: f.summary, events_complete: true, sink_error: null });
  assert.equal(selectDisplay(s.state)[0].result_recorded, true);
  assert.deepEqual(texts(s), before);
  assert.equal(texts(s).filter(text => text === 'answer').length, 1);
  assert.notEqual(s.state.runs.get(f.rid).finished.sequence, s.state.runs.get(f.rid).result.sequence);
});

test('incomplete event recording can have a result without run.finished and retains the partial response', () => {
  const s = running();
  s.emit('response.delta', delta('partial'));
  s.emit('run.result', f.result);
  const run = s.state.runs.get(f.rid);
  assert.equal(run.finished, null);
  assert.equal(run.result.data.events_complete, false);
  assert.equal(run.result.data.sink_error, 'full');
  assert.equal(selectDisplay(s.state)[0].execution, 'failed');
  assert.equal(selectDisplay(s.state)[0].result_recorded, true);
  assert.deepEqual(texts(s), ['partial']);
});

test('stored interruption preserves partial tools and response without fabricating completion or a result', () => {
  const s = running();
  s.emit('response.delta', delta('uncertain partial'));
  s.emit('tool.started');
  s.emit('tool.result');
  s.emit('run.interrupted');
  const run = s.state.runs.get(f.rid);
  const display = selectDisplay(s.state)[0];
  assert.equal(display.execution, 'interrupted');
  assert.equal(display.result_recorded, false);
  assert.equal(run.finished, null);
  assert.equal(run.result, null);
  assert.equal(run.interrupted.data.reason, 'process_restart');
  assert.deepEqual(texts(s), ['uncertain partial', f.eventData['tool.result'].output]);
  const before = structuredClone(s.state);
  const epochs = changeConnection(createEpochs(), false);
  assert.equal(epochs.connected, false);
  assert.deepEqual(s.state, before);
});
