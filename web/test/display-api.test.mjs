import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError, validateErrorView, validateSessionView } from '../dist/api.js';
import {
  validateFieldFragment, validateEntryView, validateBlockView, validateConversationPage, validateEntryPage,
  validateConversationChanges, validateTaskReconciliation, parseDisplayCursor, validateEntryId, validateOrderKey,
} from '../dist/display-api.js';
import { SID, RID, OTHER, FID, SECOND, cursor, order, field, fragment, entry, human, block, page, session,
  addressed, batch, upsert, reconciliation, command } from '../test-support/display-fixtures.mjs';
const reject = (fn, value) => assert.throws(() => fn(value), e => e instanceof ProtocolError && /^protocol\.[a-z0-9_]+$/.test(e.message));
const clone = structuredClone;
const shapes = [
  ['fragment', field(), validateFieldFragment], ['entry', entry(), validateEntryView], ['block', block(), validateBlockView],
  ['page', page(), validateConversationPage], ['addressed', addressed(), validateEntryPage],
  ['changes', batch([upsert(entry())]), validateConversationChanges],
  ['reconciliation', reconciliation(), v => validateTaskReconciliation(v, command)],
];
for (const [name, value, validate] of shapes) {
  test(`C1 ${name} accepts exact Rust encoder shape without input mutation`, () => {
    const before = clone(value); assert.deepEqual(validate(value), value); assert.deepEqual(value, before);
  });
  for (const key of Object.keys(value)) test(`C1 ${name} requires ${key}`, () => {
    const missing = clone(value); delete missing[key]; reject(validate, missing);
  });
  for (const key of ['unknown', 'native', 'prepared_input', 'provider_binding']) test(`C1 ${name} rejects extra ${key}`, () => {
    reject(validate, { ...value, [key]: {} });
  });
}
function objects(value, path = []) {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => objects(v, [...path, i]));
  return [[path, value], ...Object.entries(value).flatMap(([k, v]) => objects(v, [...path, k]))];
}
for (const [name, original, validate] of shapes) {
  for (const [path, object] of objects(original).slice(1)) test(`C1 ${name} closes recursive ${path.join('.')}`, () => {
    for (const key of Object.keys(object)) {
      const v = clone(original); const target = path.reduce((v, k) => v[k], v); delete target[key]; reject(validate, v);
    }
    const v = clone(original); path.reduce((v, k) => v[k], v).native = {}; reject(validate, v);
  });
}
for (const kind of ['text', 'refusal', 'reasoning_summary', 'reasoning_text', 'function_name', 'function_arguments',
  'tool_name', 'tool_result', 'authoritative_text', 'unsupported', 'notice']) test(`C1 field kind ${kind}`, () => {
  assert.equal(validateFieldFragment(field({ kind })).kind, kind);
});
for (const kind of ['assistant', 'tool', 'notice', 'human', 'reuse']) test(`C1 entry kind ${kind} and recorded facts stay server-owned`, () => {
  let e = entry({ kind });
  if (kind === 'human') e = human();
  if (kind === 'tool' || kind === 'reuse') e = { ...e, result_recorded: true, finish_recorded: false, is_error: false };
  if (kind === 'reuse') e.reference = { run_id: RID, entry_id: 'e:3:0' };
  assert.deepEqual(validateEntryView(e), e);
});
for (const state of ['accepted', 'in_progress', 'completed', 'incomplete', 'failed', 'cancelled', 'interrupted', 'unknown']) {
  test(`C1 recorded state ${state}`, () => assert.equal(validateEntryView(entry({ recorded_state: state })).recorded_state, state));
}
test('C1 block states and recorded outcomes preserve independent evidence', () => {
  for (const state of ['accepted', 'running', 'completed', 'failed', 'cancelled_locally', 'interrupted']) {
    const b = block({ state }); assert.equal(validateBlockView(b).state, state);
  }
  for (const outcome of [{ type: 'completed' }, { type: 'cancelled_locally' }, { type: 'failed', code: 'gateway_error' }]) {
    assert.deepEqual(validateBlockView(block({ outcome })).outcome, outcome);
  }
  reject(validateBlockView, block({ outcome: { type: 'failed', code: 'unrecognized' } }));
});
test('C1 exact scalar UTF8 Unicode NUL controls and empty unsupported descriptors', () => {
  for (const text of ['', '\0\r\n\x1b', '雪🙂é', '\ufeff', '<script>']) assert.equal(validateFieldFragment(fragment(text, 0n, Buffer.byteLength(text))).text, text);
  assert.equal(validateEntryView(entry({ fields: [field({ kind: 'unsupported', text: '', total_bytes: '0', to_byte: '0' })] })).fields[0].kind, 'unsupported');
  for (const text of ['\ud800', '\udfff', 'a\ud800b']) reject(validateFieldFragment, fragment(text, 0n, Buffer.byteLength(text)));
});
test('C1 byte ranges flags and lengths reject contradictions', () => {
  for (const overrides of [{ from_byte: '4' }, { to_byte: '4' }, { total_bytes: '2' }, { text: '雪🙂' },
    { has_earlier: true }, { has_later: true }, { from_byte: 0 }, { has_later: null }, { generation: '0' },
    { total_bytes: '18446744073709551616' }, { from_byte: '01' }, { total_bytes: '-1' }, { kind: 'custom_tool_input' }]) reject(validateFieldFragment, field(overrides));
  const huge = '18446744073709551612';
  assert.equal(validateFieldFragment(fragment('abc', huge, '18446744073709551615')).from_byte, huge);
});
test('C1 concrete sortable ASCII order keys include null/zero/u64 extremes', () => {
  assert.ok(order(2, null, null) < order(2, 0n, 0n));
  assert.ok(order(2, 9n) < order(2, 10n));
  for (let rank = 0; rank <= 8; rank++) for (const index of [null, 0n, 9007199254740993n, 18446744073709551615n]) assert.equal(validateOrderKey(order(rank, index, index, index)), order(rank, index, index, index));
  for (const key of ['', '1:2:0:0:2', order(2, 10n).toUpperCase(), order().replace(':0000000000000001:', ':0000000000000002:'), order() + ':0', order(8).replace(/8$/, '9')]) reject(validateOrderKey, key);
});
test('C1 UUID and entry identity spelling, slot precision, u64 bounds', () => {
  const max = '18446744073709551615';
  assert.equal(validateEntryId(`e:${max}:${max}`), `e:${max}:${max}`);
  const e = entry({ entry_id: 'e:4:9007199254740993', position: { sequence: '4', slot: '9007199254740993' } });
  assert.equal(validateEntryView(e).position.slot, '9007199254740993');
  for (const id of ['e:0:0', 'e:01:0', 'e:1:00', 'e:1:-1', 'e:1:0:0', '../e:1:0', `e:${max}0:0`]) reject(validateEntryId, id);
  for (const run_id of ['', 'ABCDEFAB-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', '../run']) reject(validateEntryView, entry({ run_id }));
});
test('C1 SessionView retains signed i64 timestamps and u64 head without narrowing', () => {
  for (const timestamp of ['-9223372036854775808', '-1', '0', '9223372036854775807']) {
    const s = session('18446744073709551615', { created_at_ms: timestamp, updated_at_ms: timestamp });
    assert.deepEqual(validateSessionView(s), s);
  }
  for (const timestamp of ['-0', '-01', '+1', '9223372036854775808', '-9223372036854775809', 1]) reject(validateSessionView, session('4', { created_at_ms: timestamp }));
  const max = '18446744073709551615';
  assert.equal(validateConversationPage(page({ snapshot_head: max, session: session(max), live_after: cursor('l', max, '3', '', '') })).snapshot_head, max);
});
const tokens = {
  block: cursor('b', '18446744073709551615'), activity: cursor('s', RID, '4', '18446744073709551615'),
  content: cursor('c', RID, 'e:4:0', '4', FID, '4', '18446744073709551615'), live: cursor('l', '4', '3', '', ''),
};
for (const [kind, token] of Object.entries(tokens)) test(`C1 opaque ${kind} cursor retains complete token and isolates types/session`, () => {
  assert.equal(parseDisplayCursor(token, kind, SID).token, token);
  for (const other of Object.keys(tokens).filter(k => k !== kind)) reject(v => parseDisplayCursor(v, other), token);
  reject(v => parseDisplayCursor(v, kind, OTHER), token);
  for (const bad of [token + '=', token + '\n', token + '/', 'g11b.' + 'a'.repeat(4097), token.slice(0, -1) + '#']) reject(v => parseDisplayCursor(v, kind), bad);
});
test('C1 cursor fatal UTF8 JSON canonical arrays and encoded bounds', () => {
  const decode = v => parseDisplayCursor(v, 'live');
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('{}'), Buffer.from('[1]'), Buffer.from(`[1, "${SID}","4","3","",""]`),
    Buffer.from(JSON.stringify([2, SID, '4', '3', '', ''])), Buffer.from(JSON.stringify([1, SID, 4, '3', '', ''])),
    Buffer.from(JSON.stringify([1, SID, '4', '3', '', '', 'extra']))]) reject(decode, 'g11l.' + bytes.toString('base64url'));
  for (const [seq, rank, run, e] of [['0', '3', '', ''], ['4', '4', '', ''], ['4', '3', RID, ''], ['4', '1', '', ''],
    ['4', '1', RID, 'e:4:0'], ['4', '2', RID, 'e:5:0'], ['04', '3', '', '']]) reject(decode, cursor('l', seq, rank, run, e));
  for (const rank of ['0', '1', '2', '3']) {
    const run = rank === '1' || rank === '2' ? RID : '', e = rank === '2' ? 'e:4:0' : '';
    assert.equal(decode(cursor('l', '4', rank, run, e)).rank, rank);
  }
  reject(v => parseDisplayCursor(v, 'content'), cursor('c', RID, 'e:4:0', '3', FID, '4', '0'));
  reject(v => parseDisplayCursor(v, 'content'), cursor('c', RID, 'e:4:0', '4', '../field', '4', '0'));
});
test('C1 entry closed semantics, generations, reuse reference and field order', () => {
  for (const overrides of [{ entry_id: 'e:4:1' }, { revision: '3' }, { content_epoch: '3' },
    { reference: { run_id: RID, entry_id: 'e:3:0' } }, { result_recorded: false },
    { fields: [field({ generation: '3' })] }, { fields: [field({ generation: '5' })] },
    { fields: [field({ field_id: 'text', order_key: '0' })] }, { fields: [field(), field()] },
    { fields: [field({ order_key: order(2, 1n) }), field({ field_id: SECOND })] },
    { earlier_content: cursor('c', OTHER, 'e:4:0', '4', FID, '4', '0'), content_complete: false },
    { earlier_content: cursor('c', RID, 'e:4:0', '4', FID, '4', '4'), content_complete: false },
    { fields: [fragment('c', 2n, 3n)] }]) reject(validateEntryView, entry(overrides));
  for (const reference of [null, { run_id: OTHER, entry_id: 'e:3:0' }, { run_id: RID, entry_id: 'e:4:0' }]) reject(validateEntryView, entry({ kind: 'reuse', reference }));
  reject(validateEntryView, human({ fields: [] }));
});
test('C1 snapshots enforce head/header/anchor/resource consistency and ordered nonhuman entries', () => {
  for (const overrides of [{ conversation_version: 2 }, { api_version: '1' }, { snapshot_head: '3' }, { session_id: OTHER },
    { session: session('3') }, { entries: [human()] }, { entries: [entry(), entry()] },
    { entries: [entry({ run_id: OTHER })] }, { block: null }, { live_after: cursor('l', '3', '3', '', '') },
    { live_after: cursor('l', '4', '1', RID, '') }, { earlier_activity: cursor('s', OTHER, '4', '0') },
    { previous_block: cursor('b', '3') }]) reject(validateConversationPage, page(overrides));
  for (const b of [block({ run_id: OTHER }), block({ accepted_sequence: '3' }), block({ revision: '1' }), block({ human: entry() })]) reject(validateBlockView, b);
  assert.equal(validateConversationPage(page({ block: null, entries: [], previous_block: null })).block, null);
  const before = { kind: 'before', cursor: cursor('b', '10') };
  assert.equal(validateConversationPage(page({ live_after: null }), before).live_after, null);
  reject(v => validateConversationPage(v, before), page());
  const within = { kind: 'within', cursor: cursor('s', RID, '5', '0') };
  assert.equal(validateConversationPage(page({ live_after: null }), within).block.run_id, RID);
  reject(v => validateConversationPage(v, { kind: 'within', cursor: cursor('s', RID, '4', '0') }), page({ live_after: null }));
});
test('C1 addressed responses and self-contained closed upsert variants', () => {
  assert.deepEqual(validateEntryPage(addressed(human()), { session_id: SID, run_id: RID, entry_id: 'e:2:0' }).entry, human());
  reject(v => validateEntryPage(v, { session_id: SID, run_id: OTHER, entry_id: 'e:4:0' }), addressed());
  for (const changes of [[{ kind: 'session.upsert', session: session('5') }], [{ kind: 'block.upsert', block: block() }], [upsert(entry())]]) assert.deepEqual(validateConversationChanges(batch(changes)).changes, changes);
  for (const change of [{ kind: 'delete', block: block() }, { kind: 'entry.upsert', entry: entry() },
    { kind: 'session.upsert', session: session('4') }, { kind: 'block.upsert', block: block(), raw: {} }]) reject(validateConversationChanges, batch([change]));
  const tie = cursor('l', '4', '2', RID, 'e:4:0');
  assert.equal(validateConversationChanges(batch([upsert(entry())], '5', tie)).next_after, tie);
  reject(validateConversationChanges, batch([], '5', tie));
  reject(validateConversationChanges, batch([upsert(entry())], '5', cursor('l', '4', '1', RID, '')));
});
test('C1 reconciliation checks identities and exact body, not first+1/raw proof', () => {
  const accepted = reconciliation(); accepted.acceptance.last_sequence = '100';
  assert.deepEqual(validateTaskReconciliation(accepted, command), accepted);
  assert.deepEqual(validateTaskReconciliation(reconciliation('not_found'), command), reconciliation('not_found'));
  for (const mutate of [v => v.acceptance.operation_id = OTHER, v => v.acceptance.session_id = OTHER,
    v => v.acceptance.run_id = OTHER, v => v.run.run_id = OTHER, v => v.run.user_text += '\n',
    v => v.run.user_text = 'Task\0', v => v.state = 'unknown', v => v.acceptance = null, v => v.run = null]) {
    const v = reconciliation(); mutate(v); reject(v => validateTaskReconciliation(v, command), v);
  }
  for (const key of ['run', 'acceptance']) { const v = reconciliation('not_found'); v[key] = {}; reject(v => validateTaskReconciliation(v, command), v); }
});
test('C1 exactly the three documented conversation errors extend the closed allowlist', () => {
  const base = { api_version: 1, stage: null, certainty: 'not_applicable', acceptance: null, notices: [] };
  for (const code of ['api.conversation_cursor_invalid', 'api.conversation_cursor_stale', 'api.conversation_display_unavailable']) assert.equal(validateErrorView({ ...base, code }).code, code);
  reject(validateErrorView, { ...base, code: 'api.conversation_anything' });
});
test('C1 encoded compact/page/batch size and descriptor counts stay bounded', () => {
  reject(validateEntryView, entry({ fields: [fragment('x'.repeat(32768), 0n, 32768n)] }));
  const fields = Array.from({ length: 65 }, (_, i) => field({ field_id: BigInt(i).toString(16).padStart(64, '0'), order_key: order(2, BigInt(i)) }));
  reject(validateEntryView, entry({ fields }));
  reject(validateConversationChanges, batch(Array.from({ length: 65 }, () => upsert(entry()))));
  reject(validateConversationPage, page({ session: session('4', { title: 'x'.repeat(524288) }) }));
});

const rbWireEntry = (id, revision = '5') => {
  const [, sequence, slot] = id.split(':');
  return entry({ entry_id: id, position: { sequence, slot }, revision, content_epoch: sequence, fields: [field({ generation: sequence })] });
};
const rbWireOther = block({ run_id: OTHER, accepted_sequence: '3', revision: '5', human: human({ run_id: OTHER,
  entry_id: 'e:3:0', position: { sequence: '3', slot: '0' }, revision: '3', content_epoch: '3',
  fields: [field({ field_id: 'text', order_key: '0', generation: '3' })] }) });
for (const [name, changes, head, next] of [
  ['sequence descent', [upsert(entry({ revision: '6' })), { kind: 'block.upsert', block: block({ revision: '5' }) }], '6', cursor('l', '5', '1', RID, '')],
  ['duplicate', [upsert(entry({ revision: '5' })), upsert(entry({ revision: '5' }))], '5', cursor('l', '5', '2', RID, 'e:4:0')],
  ['rank descent', [upsert(entry({ revision: '5' })), { kind: 'block.upsert', block: block({ revision: '5' }) }], '5', cursor('l', '5', '1', RID, '')],
  ['UUID descent', [{ kind: 'block.upsert', block: rbWireOther }, { kind: 'block.upsert', block: block({ revision: '5' }) }], '5', cursor('l', '5', '1', RID, '')],
  ['ASCII slot descent', [upsert(rbWireEntry('e:4:2')), upsert(rbWireEntry('e:4:10'))], '5', cursor('l', '5', '2', RID, 'e:4:10')],
  ['ASCII sequence descent', [upsert(rbWireEntry('e:9:0', '20')), upsert(rbWireEntry('e:10:0', '20'))], '20', cursor('l', '20', '2', RID, 'e:10:0')],
  ['watermark descent', [upsert(entry({ revision: '6' })), { kind: 'block.upsert', block: block({ revision: '5' }) }], '6', cursor('l', '6', '3', '', '')],
  ['known order across metadata', [upsert(entry({ revision: '6' })), { kind: 'session.upsert', session: session('8') }, { kind: 'block.upsert', block: block({ revision: '5' }) }], '8', cursor('l', '5', '1', RID, '')],
  ['duplicate metadata singleton', [{ kind: 'session.upsert', session: session('8') }, { kind: 'session.upsert', session: session('8') }], '8', cursor('l', '8', '3', '', '')],
  ['known entity beyond final metadata prefix', [upsert(entry({ revision: '6' })), { kind: 'session.upsert', session: session('8') }], '8', cursor('l', '5', '0', '', '')],
]) test(`C1-RB-01 wire rejects ${name} without changing input`, () => {
  const input = batch(changes, head, next), saved = clone(input);
  reject(validateConversationChanges, input); assert.deepEqual(input, saved);
});
test('C1-RB-01 wire preserves ASCII order, hidden metadata sequence and final rank0 facts', () => {
  for (const input of [batch([upsert(rbWireEntry('e:4:10')), upsert(rbWireEntry('e:4:2'))], '5', cursor('l', '5', '2', RID, 'e:4:2')),
    batch([{ kind: 'session.upsert', session: session('10') }, { kind: 'block.upsert', block: block({ revision: '6' }) }], '10', cursor('l', '6', '1', RID, '')),
    batch([{ kind: 'block.upsert', block: block({ revision: '6' }) }, { kind: 'session.upsert', session: session('10') }], '10', cursor('l', '7', '0', '', '')),
    batch([], '4'), batch([], '100')]) {
    const saved = clone(input); assert.deepEqual(validateConversationChanges(input), input); assert.deepEqual(input, saved);
  }
});
