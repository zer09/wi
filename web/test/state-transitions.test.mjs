import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError } from '../dist/api.js';
import {
  applyEvent, applyHistoryPage, createConversation, createHistory, eventFingerprint, historyRequest, selectDisplay,
} from '../dist/state.js';
import * as f from './wire-fixtures.mjs';

const rid2 = '01234567-89ab-4cde-8fab-0123456789ac';
const started = { turn_id: 'turn-1', number: '1' };
const finished = { ...f.eventData['turn.finished'], ...started, response_id: null };
const tool = { call_id: 'call', tool_name: 'synthetic', request_id: 'original' };
const result = { ...f.eventData['tool.result'], request_id: 'original' };
const finish = { ...tool, is_error: false };
const reuse = { ...tool, request_id: 'current' };
const nextTurn = ['turn.started', { turn_id: 'turn-2', number: '2' }];
const defaults = {
  ...f.eventData, 'turn.started': started, 'turn.finished': finished,
  'tool.started': tool, 'tool.result': result, 'tool.finished': finish, 'tool.reused': reuse,
};
const accepted = ['session.created', 'run.accepted'];
const running = [...accepted, 'run.started'];
const open = [...running, 'turn.started'];
const closed = [...open, 'turn.finished'];
const original = [...open, 'tool.started'];
const recorded = [...original, 'tool.result'];
const later = [...recorded, 'turn.finished', nextTurn];
const rename = ['session.renamed', { title: 'corrected' }];
const responseKinds = Object.keys(defaults).filter(kind => kind.startsWith('response.'));
const idKinds = responseKinds.filter(kind => !['response.failed', 'response.closed'].includes(kind));

function wire(spec, sequence) {
  const [kind, data = defaults[kind], run = f.rid] = typeof spec === 'string' ? [spec] : spec;
  return {
    ...f.event(kind, sequence), event_id: `00000000-0000-0000-0000-${BigInt(sequence).toString(16).padStart(12, '0')}`,
    run_id: kind.startsWith('session.') ? null : run, data: structuredClone(data),
  };
}
function trace(specs) {
  let state = createConversation(f.sid);
  for (const [index, spec] of specs.entries()) {
    const event = wire(spec, (index + 1).toString());
    state = applyEvent(state, event);
    assert.strictEqual(applyEvent(state, structuredClone(event)), state, 'same-sequence transport replay');
  }
  return state;
}
function rejectAndRetry(label, prefix, bad, good, category = 'invalid_schema') {
  const state = trace(prefix);
  const before = structuredClone(state);
  const fingerprints = state.fingerprints;
  const eventIds = state.event_sequences;
  const sequence = (BigInt(state.applied_cursor.split(':')[1]) + 1n).toString();
  assert.throws(() => applyEvent(state, wire(bad, sequence)), error =>
    error instanceof ProtocolError && error.category === category && error.message === `protocol.${category}`, label);
  assert.deepEqual(state, before, `${label}: unchanged state/cursor/ledgers`);
  assert.strictEqual(state.fingerprints, fingerprints);
  assert.strictEqual(state.event_sequences, eventIds);
  const corrected = wire(good, sequence);
  assert.equal(state.event_sequences.has(corrected.event_id), false);
  const next = applyEvent(state, corrected);
  assert.equal(next.applied_cursor, `${f.sid}:${sequence}`, `${label}: corrected retry`);
  assert.equal(next.fingerprints.get(sequence), eventFingerprint(corrected));
  assert.equal(next.event_sequences.get(corrected.event_id), sequence);
  assert.equal(next.fingerprints.size, fingerprints.size + 1);
  assert.equal(next.event_sequences.size, eventIds.size + 1);
  assert.strictEqual(applyEvent(next, corrected), next);
  assert.deepEqual(state, before, `${label}: retry also leaves input unchanged`);
}
function run(state, id = f.rid) { return state.runs.get(id); }
function responseEntries(state) { return selectDisplay(state)[0].entries.filter(entry => entry.kind === 'response'); }
function endTurn(number, responseId = null) {
  return ['turn.finished', { ...finished, turn_id: `turn-${number}`, number: String(number), response_id: responseId }];
}

test('tool originals require one start, one result and one finish with matching original identity and flags', () => {
  const rows = [
    ['result without start', open, 'tool.result', 'tool.started'],
    ['finish without start', open, 'tool.finished', 'tool.started'],
    ['reuse without start', open, 'tool.reused', 'tool.started'],
    ['reuse without result', [...original, 'turn.finished', nextTurn], 'tool.reused', 'tool.result'],
    ['null start request', open, ['tool.started', { ...tool, request_id: null }], 'tool.started'],
    ['duplicate start', original, 'tool.started', 'tool.result'],
    ['duplicate start after result', recorded, 'tool.started', 'tool.finished'],
    ['duplicate start after finish', [...original, 'tool.finished'], 'tool.started', 'tool.result'],
    ['duplicate result', recorded, 'tool.result', 'tool.finished'],
    ['different duplicate result', recorded, ['tool.result', { ...result, output: 'different' }], 'tool.finished'],
    ['duplicate finish', [...original, 'tool.finished'], 'tool.finished', 'tool.result'],
    ['wrong result request', original, ['tool.result', { ...result, request_id: 'wrong' }], 'tool.result', 'identity_mismatch'],
    ['null result request', original, ['tool.result', { ...result, request_id: null }], 'tool.result', 'identity_mismatch'],
    ['wrong finish request', original, ['tool.finished', { ...finish, request_id: 'wrong' }], 'tool.finished', 'identity_mismatch'],
    ['null finish request', original, ['tool.finished', { ...finish, request_id: null }], 'tool.finished'],
    ['wrong finish name', original, ['tool.finished', { ...finish, tool_name: 'wrong' }], 'tool.finished', 'identity_mismatch'],
    ['finish disagrees with result', recorded, ['tool.finished', { ...finish, is_error: true }], 'tool.finished', 'identity_mismatch'],
    ['result disagrees with finish', [...original, 'tool.finished'], ['tool.result', { ...result, is_error: true }], 'tool.result', 'identity_mismatch'],
    ['finish belongs to original turn', [...original, 'turn.finished', nextTurn], 'tool.finished', 'checkpoint', 'identity_mismatch'],
  ];
  for (const row of rows) rejectAndRetry(...row);
});

test('tool events bind the active turn request; reuse uses the current request, never the original request', () => {
  const bound = [...later, ['tool.started', { ...tool, call_id: 'second', request_id: 'current' }]];
  const rows = [
    ['start before run start', accepted, 'tool.started', 'run.started'],
    ['start outside turn', running, 'tool.started', 'turn.started'],
    ['finish outside turn', [...recorded, 'turn.finished'], 'tool.finished', nextTurn],
    ['reuse outside turn', [...recorded, 'turn.finished'], 'tool.reused', nextTurn],
    ['second start changes turn request', original, ['tool.started', { ...tool, call_id: 'second', request_id: 'wrong' }], ['tool.started', { ...tool, call_id: 'second' }], 'identity_mismatch'],
    ['null reuse request', later, ['tool.reused', { ...reuse, request_id: null }], 'tool.reused'],
    ['reuse of original request', later, ['tool.reused', tool], 'tool.reused', 'identity_mismatch'],
    ['reuse changes bound request', bound, ['tool.reused', { ...reuse, request_id: 'wrong' }], 'tool.reused', 'identity_mismatch'],
    ['reuse name differs', later, ['tool.reused', { ...reuse, tool_name: 'wrong' }], 'tool.reused', 'identity_mismatch'],
    ['reuse call differs', later, ['tool.reused', { ...reuse, call_id: 'missing' }], 'tool.reused'],
    ['reuse binds later start', [...later, 'tool.reused'], ['tool.started', { ...tool, call_id: 'second' }], ['tool.started', { ...tool, call_id: 'second', request_id: 'current' }], 'identity_mismatch'],
  ];
  for (const row of rows) rejectAndRetry(...row);
});

test('result/finish orders, missing finish, later result and multiple reuses retain one exact original output', () => {
  for (const isError of [false, true]) {
    for (const order of [['tool.result', 'tool.finished'], ['tool.finished', 'tool.result'], ['tool.result']]) {
      const events = order.map(kind => [kind, { ...defaults[kind], is_error: isError }]);
      const state = trace([...original, ...events, 'turn.finished', nextTurn, 'tool.reused', 'tool.reused', endTurn(2),
        ['turn.started', { turn_id: 'turn-3', number: '3' }], ['tool.reused', { ...reuse, request_id: 'third' }]]);
      const saved = run(state).tools.get('call');
      assert.equal(saved.started.data.request_id, 'original');
      assert.equal(saved.result.data.request_id, 'original');
      assert.equal(saved.result.data.output, result.output);
      assert.equal(saved.result.data.is_error, isError);
      assert.deepEqual(saved.reuses.map(entry => entry.data.request_id), ['current', 'current', 'third']);
      assert.equal(saved.finished?.data.request_id ?? null, order.includes('tool.finished') ? 'original' : null);
      assert.equal(selectDisplay(state)[0].entries.filter(entry => entry.kind === 'tool').length, 1);
      assert.deepEqual(selectDisplay(state)[0].entries.flatMap(entry => entry.sections).map(section => section.text), [result.output]);
    }
  }
  // Stored result delivery is not a runtime event of the newer turn.
  for (const tail of [
    ['turn.finished', 'tool.result'],
    ['turn.finished', nextTurn, ['tool.started', { ...tool, call_id: 'second', request_id: 'current' }], 'tool.result', 'tool.reused'],
  ]) assert.equal(run(trace([...original, ...tail])).tools.get('call').result.data.request_id, 'original');
});

test('tool call IDs are isolated across runs; another run cannot borrow an earlier result', () => {
  const prefix = [...recorded, 'turn.finished', 'run.finished', ['run.accepted', defaults['run.accepted'], rid2],
    ['run.started', {}, rid2], ['turn.started', started, rid2]];
  rejectAndRetry('cross-run reuse', prefix, ['tool.reused', reuse, rid2], ['tool.started', tool, rid2]);
  const state = trace([...prefix, ['tool.started', tool, rid2], ['tool.result', { ...result, output: 'second run' }, rid2]]);
  assert.equal(run(state).tools.get('call').result.data.output, result.output);
  assert.equal(run(state, rid2).tools.get('call').result.data.output, 'second run');
});

test('run and turn lifecycle rejects missing starts, overlap, duplicate identities and mismatched finishes', () => {
  const rows = [
    ['run missing acceptance', ['session.created'], 'run.started', 'run.accepted', 'identity_mismatch'],
    ['accepted run overlap', accepted, ['run.accepted', defaults['run.accepted'], rid2], 'run.started', 'identity_mismatch'],
    ['running run overlap', running, ['run.accepted', defaults['run.accepted'], rid2], 'turn.started', 'identity_mismatch'],
    ['duplicate run start', running, 'run.started', 'turn.started'],
    ['turn before run start', accepted, 'turn.started', 'run.started'],
    ['turn finish before run start', accepted, 'turn.finished', 'run.started'],
    ['run finish before start', accepted, 'run.finished', 'run.started'],
    ['turn finish without turn', running, 'turn.finished', 'turn.started'],
    ['null turn ID', running, ['turn.started', { ...started, turn_id: null }], 'turn.started'],
    ['overlapping turns', open, nextTurn, 'turn.finished'],
    ['duplicate turn start', open, 'turn.started', 'turn.finished'],
    ['repeated turn ID', closed, ['turn.started', { ...started, number: '2' }], nextTurn, 'identity_mismatch'],
    ['repeated turn number', closed, ['turn.started', { ...started, turn_id: 'turn-2' }], nextTurn, 'identity_mismatch'],
    ['wrong finished ID', open, ['turn.finished', { ...finished, turn_id: 'wrong' }], 'turn.finished', 'identity_mismatch'],
    ['null finished ID', open, ['turn.finished', { ...finished, turn_id: null }], 'turn.finished', 'identity_mismatch'],
    ['wrong finished number', open, ['turn.finished', { ...finished, number: '2' }], 'turn.finished', 'identity_mismatch'],
    ['duplicate turn finish', closed, 'turn.finished', nextTurn],
    ['run finish with open turn', open, 'run.finished', 'turn.finished'],
  ];
  for (const row of rows) rejectAndRetry(...row);
});

test('run finish requires no open turn, not consecutive numbers or an invented minimum turn count', () => {
  for (const prefix of [running, closed, [...closed, ['turn.started', { turn_id: 'high', number: '18446744073709551615' }],
    ['turn.finished', { ...finished, turn_id: 'high', number: '18446744073709551615' }]]]) {
    const state = trace([...prefix, 'run.finished', 'run.result']);
    assert.equal(selectDisplay(state)[0].result_recorded, true);
  }
});

test('only incomplete recording permits result fallback from accepted or running, including an open turn', () => {
  for (const prefix of [accepted, running, open, closed]) {
    rejectAndRetry('complete recording cannot skip run.finished', prefix,
      ['run.result', { ...f.result, events_complete: true }], 'run.result');
    for (const outcome of [{ type: 'completed' }, f.outcome, { type: 'cancelled_locally' }]) {
      const state = trace([...prefix, ['run.result', { ...f.result, outcome }], ['run.accepted', defaults['run.accepted'], rid2]]);
      assert.equal(selectDisplay(state)[0].execution, outcome.type);
      assert.equal(run(state).finished, null);
      assert.equal(run(state).result.data.events_complete, false);
      assert.equal(selectDisplay(state)[1].execution, 'accepted');
    }
  }
});

test('run results match terminal outcome but need not repeat the terminal summary', () => {
  const prefix = [...closed, 'run.finished'];
  for (const outcome of [{ type: 'completed' }, { type: 'failed', code: 'transport_error' }, { type: 'cancelled_locally' }]) {
    rejectAndRetry('result outcome mismatch', prefix, ['run.result', { ...f.result, outcome }], 'run.result', 'identity_mismatch');
  }
  for (const eventsComplete of [true, false]) {
    const changed = { ...f.result, events_complete: eventsComplete, summary: { ...f.summary, turns_finished: '9' } };
    const state = trace([...prefix, ['run.accepted', defaults['run.accepted'], rid2], ['run.started', {}, rid2],
      ['turn.started', started, rid2], ['run.result', changed]]);
    assert.deepEqual(run(state).result.data, changed);
    assert.equal(selectDisplay(state)[1].execution, 'running');
  }
});

test('run.finished allows only one matching result; fallback and interruption reject every later same-run record', () => {
  for (const [label, terminal] of [
    ['finished', [...closed, 'run.finished']],
    ['recorded', [...closed, 'run.finished', 'run.result']],
    ['fallback', [...open, 'run.result']],
    ['interrupted', [...open, 'run.interrupted']],
  ]) {
    for (const kind of Object.keys(defaults).filter(kind => !kind.startsWith('session.'))) {
      if (label === 'finished' && kind === 'run.result') continue;
      rejectAndRetry(`${label}: later ${kind}`, terminal, kind, rename, kind === 'run.accepted' ? 'identity_mismatch' : 'invalid_schema');
    }
    const state = trace([...terminal, ['run.accepted', defaults['run.accepted'], rid2]]);
    assert.equal(selectDisplay(state)[1].execution, 'accepted');
  }
});

test('interruption from accepted or running preserves the prefix and never invents a result', () => {
  for (const prefix of [accepted, running, open, closed]) {
    const state = trace([...prefix, 'run.interrupted']);
    assert.equal(selectDisplay(state)[0].execution, 'interrupted');
    assert.equal(run(state).result, null);
    assert.equal(run(state).finished, null);
  }
});

test('completed outcomes cannot bypass missing tool output; failed outcomes retain partial tools', () => {
  for (const [prefix, kind] of [[original, 'run.result'], [[...original, 'turn.finished'], 'run.finished']]) {
    rejectAndRetry('completed run requires recorded output', prefix,
      [kind, { ...defaults[kind], outcome: { type: 'completed' } }], kind);
  }
});

test('response events need an active turn; the first ID-bearing event binds that turn', () => {
  for (const kind of responseKinds) {
    rejectAndRetry(`${kind} before run start`, accepted, kind, 'run.started');
    rejectAndRetry(`${kind} without turn`, running, kind, 'turn.started');
    rejectAndRetry(`${kind} after closed turn`, closed, kind, nextTurn);
  }
  for (const kind of idKinds) {
    const state = trace([...open, kind, endTurn(1, 'response')]);
    assert.equal(run(state).turns.get('1').response_id, 'response');
    assert.equal(run(state).responses.size, 1);
    assert.equal(responseEntries(state)[0].response.response_id, 'response');
  }
});

test('status, deltas and item snapshots may precede one matching response.started', () => {
  for (const kind of idKinds.filter(kind => !['response.started', 'response.finished'].includes(kind))) {
    const prefix = [...open, kind];
    const state = trace([...prefix, 'response.started', 'response.finished', endTurn(1, 'response')]);
    assert.equal(responseEntries(state)[0].response.started_sequence, String(prefix.length + 1));
    assert.deepEqual(responseEntries(state)[0].response.authoritative, f.response);
    rejectAndRetry('second response.started', [...prefix, 'response.started'], 'response.started', 'response.finished');
  }
  rejectAndRetry('duplicate initial response.started', [...open, 'response.started'], 'response.started', 'response.finished');
});

test('response identity cannot change within a turn, including a late response.started', () => {
  for (const first of ['response.started', 'response.status', 'response.delta', 'response.item.started', 'response.item.finished']) {
    for (const kind of idKinds) {
      rejectAndRetry(`${first} then changed ${kind}`, [...open, first],
        [kind, { ...defaults[kind], response_id: 'wrong' }], 'response.finished', 'identity_mismatch');
    }
  }
});

test('terminal response events reject all repeated or post-terminal response events, even before identity', () => {
  for (const first of [[], ['response.delta']]) {
    for (const terminal of ['response.finished', 'response.failed', 'response.closed']) {
      for (const kind of responseKinds) {
        const responseId = first.length || terminal === 'response.finished' ? 'response' : null;
        rejectAndRetry(`${first.length ? 'bound' : 'unbound'} ${terminal} then ${kind}`,
          [...open, ...first, terminal], kind, endTurn(1, responseId));
      }
    }
  }
});

test('turn.finished response ID must equal the bound identity, including null', () => {
  for (const prefix of [open, [...open, 'response.failed'], [...open, 'response.closed']]) {
    rejectAndRetry('unbound turn cannot name response', prefix, endTurn(1, 'response'), endTurn(1), 'identity_mismatch');
  }
  for (const kind of idKinds) {
    for (const id of [null, 'wrong']) {
      rejectAndRetry(`${kind}: finished identity differs`, [...open, kind], endTurn(1, id), endTurn(1, 'response'), 'identity_mismatch');
    }
  }
});

test('response instances are per turn, even when provider response IDs repeat in one run', () => {
  const answer = text => ['response.finished', { ...f.response, text, items: [{ ...f.item, content: [{ kind: 'text', text }] }] }];
  const state = trace([...open, answer('first'), endTurn(1, 'response'), nextTurn,
    'response.delta', 'response.started', answer('second'), endTurn(2, 'response'), 'run.finished', 'run.result']);
  const entries = responseEntries(state);
  assert.equal(run(state).responses.size, 2);
  assert.deepEqual(entries.map(entry => entry.response.response_id), ['response', 'response']);
  assert.notEqual(entries[0].response.first_sequence, entries[1].response.first_sequence);
  assert.deepEqual(entries.flatMap(entry => entry.sections).map(section => section.text), ['first', 'second']);
  assert.equal(entries.every(entry => entry.sections.every(section => !section.provisional)), true);
});

test('failures and closures attach only to the active turn and leave prior response instances unchanged', () => {
  for (const terminal of ['response.failed', 'response.closed']) {
    for (const identified of [false, true]) {
      const state = trace([...open, 'response.finished', endTurn(1, 'response'), nextTurn,
        ...(identified ? ['response.delta'] : []), terminal, endTurn(2, identified ? 'response' : null)]);
      const entries = responseEntries(state);
      assert.equal(entries.length, identified ? 2 : 1);
      assert.equal(entries[0].response.failure, null);
      assert.equal(entries[0].response.closed_sequence, null);
      assert.equal(run(state).response_observations.length, 1);
      assert.equal(run(state).response_observations[0].turn_id, 'turn-2');
      if (identified) {
        const current = entries[1].response;
        assert.equal(current.authoritative, null);
        assert.equal(current.failure !== null, terminal === 'response.failed');
        assert.equal(current.closed_sequence !== null, terminal === 'response.closed');
        assert.equal(entries[1].sections[0].provisional, true);
      }
    }
  }
});

function page(events, head, next = events.at(-1)?.sequence ?? '0') {
  return { api_version: 1, session_id: f.sid, through_sequence: head, next_after: `${f.sid}:${next}`, has_more: BigInt(next) < BigInt(head), events };
}
function historyRetry(label, state, bad, good, category) {
  const before = structuredClone(state);
  assert.throws(() => applyHistoryPage(state, bad), error => error instanceof ProtocolError
    && error.category === category && error.message === `protocol.${category}`, label);
  assert.deepEqual(state, before, `${label}: unchanged cursor, state, head and ledgers`);
  const next = applyHistoryPage(state, good);
  assert.equal(next.conversation.applied_cursor, good.next_after);
  for (const event of good.events) {
    assert.equal(next.conversation.fingerprints.get(event.sequence), eventFingerprint(event));
    assert.equal(next.conversation.event_sequences.get(event.event_id), event.sequence);
    assert.strictEqual(applyEvent(next.conversation, event), next.conversation);
  }
  assert.deepEqual(state, before);
}

test('history rejects zero initial heads and pages above the shared 32-record request window atomically', () => {
  const events = Array.from({ length: 66 }, (_, i) => wire(accepted[i] ?? 'checkpoint', String(i + 1)));
  const empty = createHistory(f.sid);
  assert.equal(historyRequest(empty).limit, 32);
  historyRetry('zero initial head', empty, page([], '0'), page(events.slice(0, 32), '66'), 'invalid_cursor');
  historyRetry('oversized first page', empty, page(events.slice(0, 33), '66'), page(events.slice(0, 32), '66'), 'invalid_schema');
  const loaded = applyHistoryPage(empty, page(events.slice(0, 32), '66'));
  historyRetry('oversized later page', loaded, page(events.slice(32, 65), '66'), page(events.slice(32, 64), '66'), 'invalid_schema');
});

test('exactly 32 records and more than 32 pages do not impose a lifetime history limit', () => {
  const count = 32 * 35;
  const events = Array.from({ length: count }, (_, i) => wire(accepted[i] ?? 'checkpoint', String(i + 1)));
  let history = createHistory(f.sid);
  for (let offset = 0; offset < count; offset += 32) {
    const request = historyRequest(history);
    assert.equal(request.limit, 32);
    assert.equal(request.after, `${f.sid}:${offset}`);
    assert.equal(request.through, offset === 0 ? null : String(count));
    history = applyHistoryPage(history, page(events.slice(offset, offset + request.limit), String(count)));
  }
  assert.equal(history.complete, true);
  assert.equal(history.attach_cursor, `${f.sid}:${count}`);
  assert.equal(history.conversation.fingerprints.size, count);
  assert.equal(history.conversation.event_sequences.size, count);
  assert.equal(selectDisplay(history.conversation).length, 1);
});
