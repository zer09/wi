import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError } from '../dist/api.js';
import { replaceLatest, mergeConversationPage, mergeEntryPage, applyConversationChanges } from '../dist/display-store.js';
import { validateEntryPage, validateConversationPage, validateConversationChanges } from '../dist/display-api.js';
import { SID, RID, OTHER, FID, SECOND, cursor, order, field, fragment, entry, human, block, page, session,
  addressed, batch, upsert } from '../test-support/display-fixtures.mjs';
const clone = structuredClone;
const base = () => replaceLatest(page());
const reject = fn => assert.throws(fn, e => e instanceof ProtocolError && /^protocol\.[a-z0-9_]+$/.test(e.message));
const firstEntry = s => s.blocks[0].entries[0];
const ranges = s => firstEntry(s).fields[0].ranges;
function partial(fragments, overrides = {}) {
  return entry({ revision: '10', fields: fragments, content_complete: false,
    earlier_content: cursor('c', RID, 'e:4:0', '4', fragments[0].field_id, fragments[0].generation, fragments[0].from_byte), ...overrides });
}
function withEntry(e, earlier_activity = null) {
  return replaceLatest(page({ snapshot_head: e.revision, session: session(e.revision), block: block({ revision: e.revision }),
    entries: [e], earlier_activity, live_after: cursor('l', e.revision, '3', '', '') }));
}
function content(s, e, head = e.revision, b = block({ revision: head })) {
  return mergeEntryPage(s, addressed(e, b, head));
}
function otherBlock(accepted = '20', run = OTHER) {
  const h = human({ run_id: run, entry_id: `e:${accepted}:0`, position: { sequence: accepted, slot: '0' },
    revision: accepted, content_epoch: accepted, fields: [field({ field_id: 'text', order_key: '0', generation: accepted })] });
  return block({ run_id: run, accepted_sequence: accepted, revision: accepted, state: 'accepted', human: h });
}
test('C1 latest is an explicit window rebase with matching live watermark', () => {
  const s = base(); assert.equal(s.live_after, cursor('l', '4', '3', '', '')); assert.equal(s.blocks.length, 1);
  const b = otherBlock();
  const rebased = replaceLatest(page({ snapshot_head: '20', session: session('20'), block: b, entries: [], previous_block: cursor('b', '20'), live_after: cursor('l', '20', '3', '', '') }));
  assert.deepEqual(rebased.blocks.map(b => b.view.run_id), [OTHER]);
  assert.equal(s.blocks[0].view.run_id, RID);
  assert.equal(replaceLatest(page({ block: null, entries: [], previous_block: null })).blocks.length, 0);
});
test('C1 loaded snapshots contain only generic display state and deep immutable arrays', () => {
  const input = page(), saved = clone(input), s = replaceLatest(input), previous = clone(s);
  input.entries[0].fields[0].text = 'mutated'; input.session.title = 'mutated';
  assert.deepEqual(s, replaceLatest(saved));
  for (const action of [() => s.blocks.push({}), () => s.blocks[0].entries.splice(0, 1),
    () => firstEntry(s).view.position.slot = '9', () => ranges(s)[0].text = 'mutated',
    () => s.session.title = 'mutated', () => s.blocks[0].view.state = 'completed']) assert.throws(action, TypeError);
  const updates = batch([upsert(entry({ revision: '5', recorded_state: 'completed', provisional: false }))]);
  const savedUpdates = clone(updates); const next = applyConversationChanges(s, updates);
  assert.deepEqual(updates, savedUpdates); assert.deepEqual(s, previous); assert.notEqual(next, s);
  assert.ok(!JSON.stringify(next).match(/fingerprints|event_sequences|raw_event|provider_id|turn_id/));
});
test('C1 human entry upserts deduplicate the anchor and store actual tool/result facts', () => {
  const tool = entry({ kind: 'tool', result_recorded: true, finish_recorded: false, is_error: false,
    fields: [field({ kind: 'tool_result', text: '{error}', to_byte: '7', total_bytes: '7' })] });
  const s = replaceLatest(page({ entries: [tool] }));
  const h = human({ revision: '5' });
  const next = applyConversationChanges(s, batch([upsert(h, block({ revision: '5', human: h }))]));
  assert.equal(next.blocks[0].entries.length, 1); assert.equal(next.blocks[0].human.view.entry_id, 'e:2:0');
  assert.equal(firstEntry(next).view.is_error, false); assert.equal(firstEntry(next).view.finish_recorded, false);
  assert.equal(firstEntry(next).fields[0].ranges[0].text, '{error}');
});
test('C1 block and entry chronology uses BigInt not kind or timestamp', () => {
  const sequence = '9007199254740993';
  const s = base();
  const b = otherBlock(sequence);
  let next = applyConversationChanges(s, batch([{ kind: 'block.upsert', block: b }], sequence, cursor('l', sequence, '1', OTHER, '')));
  const e = entry({ run_id: OTHER, entry_id: `e:${sequence}:1`, position: { sequence, slot: '1' }, revision: sequence, content_epoch: sequence,
    kind: 'tool', fields: [field({ generation: sequence })] });
  const reuse = entry({ ...e, entry_id: `e:${sequence}:9007199254740993`, position: { sequence, slot: '9007199254740993' },
    kind: 'reuse', reference: { run_id: OTHER, entry_id: e.entry_id } });
  next = applyConversationChanges(next, batch([upsert(e, b), upsert(reuse, b)], sequence));
  assert.deepEqual(next.blocks.map(b => b.view.accepted_sequence), ['2', sequence]);
  assert.deepEqual(next.blocks[1].entries.map(e => e.view.position.slot), ['1', '9007199254740993']);
});
test('C1 older page metadata and revisions cannot roll back current state', () => {
  const s = applyConversationChanges(base(), batch([{ kind: 'session.upsert', session: session('8', { title: 'new title' }) },
    upsert(entry({ revision: '8', recorded_state: 'completed', provisional: false }))], '8'));
  const next = mergeConversationPage(s, page({ live_after: null }), { kind: 'before', cursor: cursor('b', '10') });
  assert.equal(next.session.title, 'new title'); assert.equal(firstEntry(next).view.revision, '8');
  assert.equal(firstEntry(next).view.recorded_state, 'completed'); assert.equal(next.blocks[0].view.revision, '8');
  assert.equal(next.live_after, s.live_after); assert.equal(next.observed_head, '8');
});
test('C1 equal revision identity scalar and field contradictions reject with rollback', () => {
  const s = base(), before = clone(s);
  for (const e of [entry({ recorded_state: 'completed' }), entry({ provisional: false }),
    entry({ fields: [field({ text: 'xyz' })] }), entry({ fields: [field({ order_key: order(2, 1n) })] })]) {
    reject(() => content(s, e)); assert.deepEqual(s, before);
  }
  reject(() => content(s, entry(), '4', block({ state: 'failed' })));
  reject(() => mergeConversationPage(s, page({ session: session('4', { title: 'contradiction' }), live_after: null }), { kind: 'before', cursor: cursor('b', '10') }));
  assert.deepEqual(s, before);
});
test('C1 equal revision compact subsets and compatible overlaps merge rather than conflict', () => {
  const s = withEntry(partial([fragment('ef', 4n, 6n)]));
  const earlier = partial([fragment('abcd', 0n, 6n)], { earlier_content: null });
  const next = content(s, earlier);
  assert.deepEqual(ranges(next), [{ from_byte: '0', to_byte: '6', text: 'abcdef' }]);
  assert.equal(firstEntry(next).earlier_content, null); assert.equal(s.blocks[0].entries[0].fields[0].ranges[0].text, 'ef');
  const compact = content(next, partial([fragment('de', 3n, 6n)]));
  assert.deepEqual(ranges(compact), ranges(next));
});
test('C1 same revision compatible disjoint field descriptor subsets preserve server order', () => {
  const s = withEntry(partial([field({ field_id: SECOND, order_key: order(2, 1n) })]));
  const next = content(s, partial([field()]));
  assert.deepEqual(firstEntry(next).fields.map(f => f.field_id), [FID, SECOND]);
  assert.equal(firstEntry(next).fields[1].ranges[0].text, 'abc');
});
for (const [name, earlier, later, expected] of [
  ['overlapping', fragment('雪🙂', 0n, 9n), fragment('🙂é', 3n, 9n), '雪🙂é'],
  ['adjacent', fragment('雪', 0n, 9n), fragment('🙂é', 3n, 9n), '雪🙂é'],
  ['NUL controls', fragment('\0\n', 0n, 4n), fragment('\n\r\x1b', 1n, 4n), '\0\n\r\x1b'],
  ['contained', fragment('abcdef', 0n, 6n), fragment('cd', 2n, 6n), 'abcdef'],
]) test(`C1 exact UTF8 ${name} ranges`, () => {
  const s = withEntry(partial([later])); const next = content(s, partial([earlier]));
  assert.deepEqual(ranges(next), [{ from_byte: '0', to_byte: earlier.total_bytes, text: expected }]);
});
test('C1 large offsets retain precision with only bounded local byte indexing', () => {
  const from = 9007199254740993n;
  const s = withEntry(partial([fragment('🙂é', from + 3n, from + 9n)]));
  const next = content(s, partial([fragment('雪🙂', from, from + 9n)]));
  assert.deepEqual(ranges(next), [{ from_byte: String(from), to_byte: String(from + 9n), text: '雪🙂é' }]);
});
test('C1 disjoint ranges leave explicit gaps and continuation, never fabricated text', () => {
  const s = withEntry(partial([fragment('ef', 4n, 6n)])); const next = content(s, partial([fragment('ab', 0n, 6n)]));
  assert.deepEqual(ranges(next), [{ from_byte: '0', to_byte: '2', text: 'ab' }, { from_byte: '4', to_byte: '6', text: 'ef' }]);
  assert.equal(firstEntry(next).content_complete, false);
  assert.equal(firstEntry(s).earlier_content, cursor('c', RID, 'e:4:0', '4', FID, '4', '4'));
});
test('C1 contradictory overlapping bytes and same revision lengths reject atomically', () => {
  const s = withEntry(partial([fragment('雪🙂', 0n, 9n)])), before = clone(s);
  for (const f of [fragment('abcdé', 3n, 9n), fragment('雪🙂', 0n, 10n)]) {
    reject(() => content(s, partial([f]))); assert.deepEqual(s, before);
  }
});
test('C1 append growth preserves compatible loaded earlier bytes and old fixed boundaries', () => {
  const old = partial([fragment('abc', 0n, 6n)], { revision: '10', earlier_content: null });
  const s = withEntry(old);
  const grown = partial([fragment('ghi', 6n, 9n)], { revision: '12' });
  const next = applyConversationChanges(s, batch([upsert(grown)], '12'));
  assert.deepEqual(ranges(next), [{ from_byte: '0', to_byte: '3', text: 'abc' }, { from_byte: '6', to_byte: '9', text: 'ghi' }]);
  const completed = content(next, partial([fragment('def', 3n, 6n)], { revision: '10' }), '12');
  assert.deepEqual(ranges(completed), [{ from_byte: '0', to_byte: '9', text: 'abcdefghi' }]);
  assert.equal(firstEntry(completed).fields[0].total_bytes, '9'); assert.equal(firstEntry(completed).view.revision, '12');
  assert.equal(firstEntry(next).earlier_content, cursor('c', RID, 'e:4:0', '4', FID, '4', '6'));
  // The fixed upper 6 was consumed; stale compatible bytes do not confirm the current layout beginning.
  assert.equal(firstEntry(completed).earlier_content, cursor('c', RID, 'e:4:0', '4', FID, '4', '3'));
  assert.equal(firstEntry(completed).content_start_loaded, false);
  const current = content(completed, partial([fragment('def', 3n, 9n)], { revision: '12', earlier_content: null }));
  assert.equal(firstEntry(current).earlier_content, null);
});
test('C1 new interleaved fields retain a zero-byte descriptor continuation despite an old complete prefix', () => {
  const tail = field({ field_id: SECOND, order_key: order(2, 1n) });
  const s = withEntry(entry({ revision: '10', fields: [tail] }));
  const newer = partial([tail], { revision: '12' });
  const next = applyConversationChanges(s, batch([upsert(newer)], '12'));
  assert.equal(firstEntry(next).earlier_content, cursor('c', RID, 'e:4:0', '4', SECOND, '4', '0'));
  assert.equal(firstEntry(next).content_start_loaded, false);
  const stale = content(next, entry({ revision: '10', fields: [tail] }), '12');
  assert.equal(firstEntry(stale).earlier_content, firstEntry(next).earlier_content);
  assert.equal(firstEntry(stale).content_complete, false);
  const current = content(stale, partial([field()], { revision: '12', earlier_content: null }));
  assert.deepEqual(firstEntry(current).fields.map(f => f.field_id), [FID, SECOND]);
  assert.equal(firstEntry(current).earlier_content, null);
});
test('C1 later same-revision subsets compare field descriptors at their own recorded revisions', () => {
  const s = withEntry(partial([field()]));
  const newer = partial([field({ field_id: SECOND, order_key: order(2, 1n), generation: '12' })], { revision: '12' });
  const next = applyConversationChanges(s, batch([upsert(newer)], '12'));
  const grown = partial([fragment('abcdef', 0n, 6n)], { revision: '12', earlier_content: null });
  const filled = content(next, grown);
  assert.equal(firstEntry(filled).fields[0].total_bytes, '6');
  assert.equal(firstEntry(filled).fields[0].revision, '12');
  assert.equal(firstEntry(filled).fields[1].ranges[0].text, 'abc');
  reject(() => content(filled, partial([fragment('abcdefg', 0n, 7n)], { revision: '12', earlier_content: null })));
});
test('C1 field generation replacement affects only that field, stale generation cannot roll back', () => {
  const s = withEntry(partial([field(), field({ field_id: SECOND, order_key: order(2, 1n), text: 'XYZ' })]));
  const newer = partial([field({ generation: '12', text: 'new' })], { revision: '12' });
  const next = applyConversationChanges(s, batch([upsert(newer)], '12'));
  assert.deepEqual(firstEntry(next).fields.map(f => f.ranges[0].text), ['new', 'XYZ']);
  const stale = content(next, partial([field()]), '12');
  assert.deepEqual(firstEntry(stale).fields.map(f => f.ranges[0].text), ['new', 'XYZ']);
  assert.equal(firstEntry(stale).fields[0].generation, '12');
});
test('C1 stale field continuations never replace a current generation boundary', () => {
  const s = withEntry(partial([fragment('c', 2n, 3n, { generation: '8' })]));
  const newer = partial([fragment('Z', 2n, 3n, { generation: '12' })], { revision: '12' });
  const next = applyConversationChanges(s, batch([upsert(newer)], '12'));
  const old = partial([fragment('ghi', 6n, 9n, { generation: '8' })]);
  const stale = content(next, old, '12');
  assert.equal(firstEntry(stale).earlier_content, cursor('c', RID, 'e:4:0', '4', FID, '12', '2'));
  assert.equal(firstEntry(stale).fields[0].generation, '12');
});
test('C1 equal revision generation contradictions reject instead of replacing', () => {
  const s = withEntry(partial([field({ generation: '6' })]));
  reject(() => content(s, partial([field({ generation: '7' })])));
});
test('C1 new content epoch clears only its entry layout and stale content continuation', () => {
  const second = entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '10', content_epoch: '5', fields: [field({ generation: '5' })] });
  let s = withEntry(partial([field(), field({ field_id: SECOND, order_key: order(2, 1n) })]));
  s = mergeConversationPage(s, page({ snapshot_head: '10', session: session('10'), block: block({ revision: '10' }), entries: [second], live_after: null }),
    { kind: 'before', cursor: cursor('b', '20') });
  const newer = entry({ revision: '12', content_epoch: '12', fields: [field({ generation: '12', text: 'NEW' })] });
  const next = applyConversationChanges(s, batch([upsert(newer)], '12'));
  assert.equal(firstEntry(next).fields.length, 1); assert.equal(firstEntry(next).earlier_content, null);
  assert.equal(next.blocks[0].entries[1].view.entry_id, 'e:5:0'); assert.deepEqual(next.blocks[0].entries[1], s.blocks[0].entries[1]);
  assert.deepEqual(content(next, partial([field()]), '12'), next);
});
test('C1 empty unsupported descriptors are retained as ranges without inventing content', () => {
  const e = entry({ fields: [field({ kind: 'unsupported', text: '', total_bytes: '0', to_byte: '0' })] });
  const s = withEntry(e); assert.deepEqual(ranges(s), [{ from_byte: '0', to_byte: '0', text: '' }]);
  assert.equal(firstEntry(s).fields[0].kind, 'unsupported'); assert.equal(firstEntry(s).content_complete, true);
});
test('C1 unloaded old blocks stay unloaded; a newly accepted later block appends one anchor', () => {
  const s = base();
  const old = { ...otherBlock('1'), revision: '5' };
  const next = applyConversationChanges(s, batch([{ kind: 'block.upsert', block: old }, { kind: 'block.upsert', block: otherBlock('20') }], '20'));
  assert.deepEqual(next.blocks.map(b => b.view.run_id), [RID, OTHER]);
  assert.equal(next.blocks[1].human.view.kind, 'human'); assert.equal(next.blocks[1].entries.length, 0);
  assert.equal(next.previous_block, s.previous_block);
});
test('C1 unloaded older entries do not append at the bottom or move backward cursors', () => {
  const tail = entry({ entry_id: 'e:8:0', position: { sequence: '8', slot: '0' }, revision: '10', content_epoch: '8', fields: [field({ generation: '8' })] });
  const s = withEntry(tail, cursor('s', RID, '8', '0'));
  const next = applyConversationChanges(s, batch([upsert(entry({ revision: '12' }))], '12'));
  assert.deepEqual(next.blocks[0].entries.map(e => e.view.entry_id), ['e:8:0']);
  assert.equal(next.blocks[0].earlier_activity, s.blocks[0].earlier_activity);
  assert.equal(mergeEntryPage(next, addressed(entry({ revision: '12' }), block({ revision: '12' }), '12')), next);
});
test('C1 old loaded block upserts update it in place, metadata does not reorder messages', () => {
  let s = applyConversationChanges(base(), batch([{ kind: 'block.upsert', block: otherBlock() }], '20'));
  const next = applyConversationChanges(s, batch([{ kind: 'session.upsert', session: session('25', { title: 'renamed' }) },
    upsert(entry({ revision: '25', recorded_state: 'interrupted' }))], '25'));
  assert.deepEqual(next.blocks.map(b => b.view.run_id), [RID, OTHER]);
  assert.equal(firstEntry(next).view.recorded_state, 'interrupted'); assert.equal(next.session.title, 'renamed');
});
test('C1 backward, activity, content and live positions remain independent', () => {
  const tail = entry({ entry_id: 'e:8:0', position: { sequence: '8', slot: '0' }, revision: '10', content_epoch: '8', fields: [field({ generation: '8' })] });
  const s = withEntry(tail, cursor('s', RID, '8', '0'));
  const within = page({ snapshot_head: '10', session: session('10'), block: block({ revision: '10' }), entries: [partial([fragment('bc', 1n, 3n)])],
    live_after: null, earlier_activity: cursor('s', RID, '4', '0') });
  const next = mergeConversationPage(s, within, { kind: 'within', cursor: s.blocks[0].earlier_activity });
  assert.equal(next.live_after, s.live_after); assert.equal(next.previous_block, s.previous_block);
  assert.equal(next.blocks[0].earlier_activity, cursor('s', RID, '4', '0'));
  const contentNext = content(next, partial([fragment('a', 0n, 3n)], { earlier_content: null }));
  assert.equal(contentNext.blocks[0].earlier_activity, next.blocks[0].earlier_activity);
  assert.equal(contentNext.live_after, s.live_after); assert.equal(firstEntry(contentNext).earlier_content, null);
});
test('C1 private-only empty batches progress and same-sequence rank ties need no raw sequence proof', () => {
  const s = base(); const next = applyConversationChanges(s, batch([], '100'));
  assert.equal(next.live_after, cursor('l', '100', '3', '', '')); assert.deepEqual(next.blocks, s.blocks);
  const b = block({ revision: '101' });
  const tie = applyConversationChanges(next, batch([{ kind: 'block.upsert', block: b }], '101', cursor('l', '101', '1', RID, '')));
  const entryTie = applyConversationChanges(tie, batch([upsert(entry({ revision: '101' }), b)], '101', cursor('l', '101', '2', RID, 'e:4:0')));
  assert.equal(entryTie.live_after, cursor('l', '101', '2', RID, 'e:4:0'));
  reject(() => applyConversationChanges(entryTie, batch([{ kind: 'block.upsert', block: b }], '101', tie.live_after)));
});
test('C1 whole change batch rolls back later structural range and identity failures before cursor publication', () => {
  const s = base(), before = clone(s);
  const good = upsert(entry({ revision: '5', recorded_state: 'completed' }));
  for (const bad of [upsert(entry({ revision: '6', fields: [field({ text: 'xyz' })] })),
    upsert(entry({ revision: '6', kind: 'notice' })), { ...upsert(entry({ revision: '6' })), native: {} }]) {
    const input = batch([good, bad], '6'), saved = clone(input);
    reject(() => applyConversationChanges(s, input)); assert.deepEqual(s, before); assert.deepEqual(input, saved);
  }
  const wrongSid = batch([good]); wrongSid.session_id = OTHER;
  reject(() => applyConversationChanges(s, wrongSid)); assert.deepEqual(s, before);
});
test('C1 a backward page with an invalid later entry publishes no partial state or cursor', () => {
  const s = base(), before = clone(s);
  const e = entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '5', content_epoch: '5', fields: [field({ generation: '5' })] });
  const p = page({ snapshot_head: '5', session: session('5'), block: block({ revision: '5' }), live_after: null,
    entries: [entry(), { ...e, native: {} }] });
  reject(() => mergeConversationPage(s, p, { kind: 'before', cursor: cursor('b', '10') }));
  assert.deepEqual(s, before);
});

function positions(s) {
  return { live: s.live_after, head: s.observed_head, previous: s.previous_block,
    blocks: s.blocks.map(b => ({ run: b.view.run_id, accepted: b.view.accepted_sequence,
      activity: b.earlier_activity, human: [b.human.view.position, b.human.earlier_content],
      entries: b.entries.map(e => [e.view.entry_id, e.view.position, e.earlier_content]) })) };
}
function checkedContent(s, e, expected, head = e.revision) {
  const input = addressed(e, block({ revision: head }), head), saved = clone(input), before = clone(s);
  validateEntryPage(input);
  const read = firstEntry(s).earlier_content === null ? undefined : { kind: 'content', cursor: firstEntry(s).earlier_content };
  const next = mergeEntryPage(s, input, undefined, read);
  assert.deepEqual(s, before); assert.deepEqual(input, saved);
  assert.equal(next.live_after, s.live_after); assert.equal(next.observed_head, s.observed_head);
  assert.equal(next.previous_block, s.previous_block);
  assert.equal(next.blocks[0].earlier_activity, s.blocks[0].earlier_activity);
  assert.equal(firstEntry(next).earlier_content, expected);
  return next;
}
for (const [name, chunk] of [['small byte', 'abc'], ['24000-byte', 'a'.repeat(24000)],
  ['24KiB Unicode', '雪🙂éabc'.repeat(2048)]]) {
  test(`C1-CONTENT-01 ${name} traversal follows three nonterminal pages then terminal`, () => {
    const size = BigInt(Buffer.byteLength(chunk)), total = size * 5n;
    const pieces = Array.from({ length: 5 }, (_, i) => partial([fragment(chunk, size * BigInt(i), total)],
      i === 0 ? { earlier_content: null } : {}));
    for (const e of pieces) validateEntryPage(addressed(e, block({ revision: '10' }), '10'));
    let s = withEntry(pieces[4], cursor('s', RID, '4', '0'));
    for (let i = 3; i >= 0; i--) {
      assert.equal(firstEntry(s).earlier_content, pieces[i + 1].earlier_content);
      s = checkedContent(s, pieces[i], pieces[i].earlier_content);
      assert.deepEqual(ranges(s), [{ from_byte: String(size * BigInt(i)), to_byte: String(total), text: chunk.repeat(5 - i) }]);
    }
    assert.equal(firstEntry(s).content_start_loaded, true);
    assert.equal(firstEntry(s).content_complete, true);
    for (const i of [2, 4, 1, 0]) s = checkedContent(s, pieces[i], null);
  });
}
test('C1-CONTENT-01 minimal upper 6 advances to exact supplied upper 3', () => {
  const s = withEntry(partial([fragment('ghi', 6n, 9n)]));
  const e = partial([fragment('def', 3n, 9n)]);
  const next = checkedContent(s, e, e.earlier_content);
  assert.deepEqual(ranges(next), [{ from_byte: '3', to_byte: '9', text: 'defghi' }]);
});
for (const empty of [false, true]) test(`C1-CONTENT-01 ${empty ? 'empty unsupported descriptor' : 'cross-field'} traversal progresses in supplied order`, () => {
  const fields = [FID, SECOND, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)].map((id, i) =>
    field({ field_id: id, order_key: order(2, BigInt(i)), ...(empty ? { kind: 'unsupported', text: '', total_bytes: '0', to_byte: '0' } : {}) }));
  const pieces = fields.map((f, i) => partial([f], i === 0 ? { earlier_content: null, content_complete: true } : {}));
  let s = withEntry(pieces[4]);
  for (let i = 3; i >= 0; i--) {
    s = checkedContent(s, pieces[i], pieces[i].earlier_content);
    assert.deepEqual(firstEntry(s).fields.map(f => f.field_id), fields.slice(i).map(f => f.field_id));
  }
  assert.equal(firstEntry(s).content_complete, true);
  for (const i of [3, 1, 4]) s = checkedContent(s, pieces[i], null);
});
test('C1-CONTENT-01 duplicates and out-of-order nonterminal pages never resurrect consumed frontiers', () => {
  const tail = partial([fragment('jkl', 9n, 12n)]), middle = partial([fragment('ghi', 6n, 12n)]);
  const earlier = partial([fragment('def', 3n, 12n)]);
  let s = checkedContent(withEntry(tail), middle, middle.earlier_content);
  s = checkedContent(s, earlier, earlier.earlier_content);
  for (const e of [tail, middle, earlier, middle]) s = checkedContent(s, e, earlier.earlier_content);
  assert.deepEqual(ranges(s), [{ from_byte: '3', to_byte: '12', text: 'defghijkl' }]);
});
for (const terminal of [false, true]) test(`C1-CONTENT-01 real byte gap retains frontier until filled with ${terminal ? 'known' : 'unknown'} layout beginning`, () => {
  const tail = partial([fragment('ghi', 6n, 9n)]), early = partial([fragment('abc', 0n, 9n)],
    terminal ? { earlier_content: null } : {});
  let s = checkedContent(withEntry(tail), early, tail.earlier_content);
  assert.equal(ranges(s).length, 2);
  const middle = partial([fragment('def', 3n, 9n)]);
  s = checkedContent(s, middle, terminal ? null : middle.earlier_content);
  assert.deepEqual(ranges(s), [{ from_byte: '0', to_byte: '9', text: 'abcdefghi' }]);
  assert.equal(firstEntry(s).content_start_loaded, terminal);
});
test('C1-CONTENT-01 cross-field byte gap preserves later boundary until its missing prefix arrives', () => {
  const tail = partial([fragment('def', 3n, 6n, { field_id: SECOND, order_key: order(2, 1n) })]);
  const early = partial([field()]);
  let s = checkedContent(withEntry(tail), early, tail.earlier_content);
  const fill = partial([fragment('abc', 0n, 6n, { field_id: SECOND, order_key: order(2, 1n) })]);
  s = checkedContent(s, fill, fill.earlier_content);
  s = checkedContent(s, early, early.earlier_content);
  assert.deepEqual(firstEntry(s).fields.map(f => f.ranges[0].text), ['abc', 'abcdef']);
  s = checkedContent(s, partial([field()], { earlier_content: null }), null);
});
for (const stale of [false, true]) test(`C1-CONTENT-01 ${stale ? 'stale append-compatible' : 'current append'} page consumes fixed frontier without confirming layout beginning`, () => {
  const initial = partial([fragment('abc', 0n, 6n)], { earlier_content: null });
  let s = withEntry(initial);
  const grown = partial([fragment('ghi', 6n, 9n)], { revision: '12' });
  s = applyConversationChanges(s, batch([upsert(grown)], '12'));
  assert.equal(firstEntry(s).content_start_loaded, false);
  const fill = partial([fragment('def', 3n, stale ? 6n : 9n)], { revision: stale ? '10' : '12' });
  s = checkedContent(s, fill, fill.earlier_content, '12');
  assert.deepEqual(ranges(s), [{ from_byte: '0', to_byte: '9', text: 'abcdefghi' }]);
  assert.equal(firstEntry(s).view.revision, '12'); assert.equal(firstEntry(s).fields[0].total_bytes, '9');
  assert.equal(firstEntry(s).content_start_loaded, false);
  s = checkedContent(s, grown, fill.earlier_content, '12');
  s = checkedContent(s, initial, fill.earlier_content, '12');
  s = checkedContent(s, partial([fragment('abc', 0n, 9n)], { revision: '12', earlier_content: null }), null);
});
test('C1-CONTENT-01 large BigInt frontiers advance without narrowing', () => {
  const from = 9007199254740993n;
  const next = partial([fragment('雪', from, from + 9n)]);
  const s = checkedContent(withEntry(partial([fragment('🙂é', from + 3n, from + 9n)])), next, next.earlier_content);
  assert.equal(ranges(s)[0].from_byte, String(from));
});
function epochState() {
  return withEntry(partial([fragment('bc', 1n, 3n, { generation: '8' })], { content_epoch: '8',
    earlier_content: cursor('c', RID, 'e:4:0', '8', FID, '8', '1') }), cursor('s', RID, '4', '0'));
}
function assertAtomicConflict(s, input) {
  const before = clone(s), saved = clone(input), beforePositions = positions(s);
  validateConversationChanges(input);
  let published = s;
  assert.throws(() => { published = applyConversationChanges(s, input); },
    e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
  assert.strictEqual(published, s); assert.deepEqual(positions(published), beforePositions);
  assert.deepEqual(s, before); assert.deepEqual(input, saved);
}
for (const tuple of [false, true]) test(`C1-EPOCH-01 newer revision lower epoch rejects atomically with ${tuple ? 'entry-tuple' : 'watermark'} cursor`, () => {
  const s = epochState();
  const bad = entry({ revision: '12', content_epoch: '6', recorded_state: 'completed', provisional: false,
    fields: [field({ generation: '6' })] });
  const next = tuple ? cursor('l', '12', '2', RID, 'e:4:0') : cursor('l', '12', '3', '', '');
  assertAtomicConflict(s, batch([upsert(bad)], '12', next));
});
test('C1-EPOCH-01 valid earlier session change and later epoch contradiction reject whole batch', () => {
  const s = epochState();
  const bad = entry({ revision: '12', content_epoch: '6', recorded_state: 'completed', provisional: false,
    fields: [field({ generation: '6' })] });
  assertAtomicConflict(s, batch([{ kind: 'session.upsert', session: session('12', { title: 'must not publish' }) }, upsert(bad)], '12'));
});
test('C1-EPOCH-01 strictly older revision lower epoch remains a stale no-op', () => {
  const s = epochState(), before = clone(s);
  const stale = entry({ revision: '9', content_epoch: '6', fields: [field({ generation: '6' })] });
  const next = checkedContent(s, stale, firstEntry(s).earlier_content, '10');
  assert.deepEqual(next, s); assert.deepEqual(s, before);
  const tail = partial([fragment('bc', 1n, 3n, { generation: '8' })], { revision: '8', content_epoch: '8',
    earlier_content: cursor('c', RID, 'e:4:0', '8', FID, '8', '1') });
  const liveState = content(withEntry(tail), { ...tail, revision: '10' });
  const input = batch([upsert(stale, block({ revision: '10' }))], '10'), saved = clone(input);
  const liveNext = applyConversationChanges(liveState, input);
  assert.deepEqual(liveNext.blocks, liveState.blocks); assert.equal(liveNext.live_after, cursor('l', '10', '3', '', ''));
  assert.deepEqual(input, saved);
});
test('C1-EPOCH-01 equal-version conflicts and compatible same-epoch subsets retain their controls', () => {
  const s = epochState();
  for (const e of [entry({ revision: '10', content_epoch: '6', fields: [field({ generation: '6' })] }),
    partial([fragment('bc', 1n, 3n, { generation: '8' })], { content_epoch: '8', recorded_state: 'completed',
      earlier_content: cursor('c', RID, 'e:4:0', '8', FID, '8', '1') })]) {
    const before = clone(s), input = addressed(e, block({ revision: '10' }), '10'), saved = clone(input);
    validateEntryPage(input); reject(() => mergeEntryPage(s, input));
    assert.deepEqual(s, before); assert.deepEqual(input, saved);
  }
  const earlier = partial([fragment('a', 0n, 3n, { generation: '8' })], { content_epoch: '8', earlier_content: null });
  assert.equal(ranges(checkedContent(s, earlier, null))[0].text, 'abc');
});
test('C1-EPOCH-01 legitimate revision 12 epoch 12 replaces only target layout', () => {
  let s = epochState();
  const other = entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '10', content_epoch: '5', fields: [field({ generation: '5' })] });
  s = mergeConversationPage(s, page({ snapshot_head: '10', session: session('10'), block: block({ revision: '10' }), entries: [other], live_after: null }),
    { kind: 'before', cursor: cursor('b', '20') });
  const input = batch([upsert(entry({ revision: '12', content_epoch: '12', recorded_state: 'completed', fields: [field({ generation: '12', text: 'NEW' })] }))], '12');
  const saved = clone(input), before = clone(s), next = applyConversationChanges(s, input);
  assert.equal(firstEntry(next).view.content_epoch, '12'); assert.equal(firstEntry(next).earlier_content, null);
  assert.equal(ranges(next)[0].text, 'NEW'); assert.deepEqual(next.blocks[0].entries[1], s.blocks[0].entries[1]);
  assert.deepEqual(next.blocks[0].human, s.blocks[0].human); assert.deepEqual(s, before); assert.deepEqual(input, saved);
  assert.equal(next.previous_block, s.previous_block); assert.equal(next.blocks[0].earlier_activity, s.blocks[0].earlier_activity);
});

function provenContent(s, e, read, head = e.revision, h = false) {
  const input = addressed(e, block({ revision: head, ...(h ? { human: e } : {}) }), head);
  const saved = clone(input), before = clone(s), navigation = positions(s);
  const next = mergeEntryPage(s, input, { session_id: SID, run_id: RID, entry_id: e.entry_id }, read);
  assert.deepEqual(input, saved); assert.deepEqual(s, before);
  const after = positions(next);
  assert.equal(after.live, navigation.live); assert.equal(after.head, navigation.head);
  assert.equal(after.previous, navigation.previous); assert.equal(after.blocks[0].activity, navigation.blocks[0].activity);
  if (!h) assert.deepEqual(next.blocks[0].human, s.blocks[0].human);
  return next;
}
function linkedContent(s, e, head = e.revision, h = false) {
  const loaded = h ? s.blocks[0].human : firstEntry(s);
  return provenContent(s, e, { kind: 'content', cursor: loaded.earlier_content }, head, h);
}
function assertWhole(e, text) {
  assert.deepEqual(e.fields[0].ranges, [{ from_byte: '0', to_byte: String(Buffer.byteLength(text)), text }]);
  assert.equal(e.fields[0].total_bytes, String(Buffer.byteLength(text)));
}
// Scalar-valid boundaries captured from the actual Rust compact/content producer.
for (const unicode of [false, true]) for (const h of [false, true]) {
  test(`C1-COMPLETE-01 producer-shaped 72000-byte ${unicode ? 'Unicode' : 'ASCII'} ${h ? 'human anchor' : 'assistant'} linked chain completes`, () => {
    const text = unicode ? '雪🙂éabc'.repeat(6000) : (h ? 'h' : 'a').repeat(72000);
    const upper = unicode ? 40959 : 40960;
    const lower = h ? (unicode ? 8859 : 8858) : (unicode ? 9075 : 9074);
    const bytes = Buffer.from(text), id = h ? 'text' : FID, generation = h ? '2' : '6', epoch = h ? '2' : '5';
    const eid = h ? 'e:2:0' : 'e:5:0';
    const piece = (from, to) => (h ? human : entry)({ entry_id: eid, position: { sequence: h ? '2' : '5', slot: '0' },
      revision: h ? '2' : '6', content_epoch: epoch,
      fields: [fragment(bytes.subarray(from, to).toString('utf8'), BigInt(from), 72000n,
        { field_id: id, order_key: h ? '0' : order(), generation })],
      earlier_content: from === 0 ? null : cursor('c', RID, eid, epoch, id, generation, String(from)), content_complete: false });
    const tail = piece(upper, 72000), middle = piece(lower, upper), prefix = piece(0, lower);
    let s = h ? replaceLatest(page({ snapshot_head: '6', session: session('6'), block: block({ revision: '6', human: tail }),
      entries: [], live_after: cursor('l', '6', '3', '', '') })) : withEntry(tail);
    s = linkedContent(s, middle, '6', h);
    assert.equal((h ? s.blocks[0].human : firstEntry(s)).content_complete, false);
    s = linkedContent(s, prefix, '6', h);
    const loaded = h ? s.blocks[0].human : firstEntry(s);
    assertWhole(loaded, text); assert.equal(loaded.content_start_loaded, true); assert.equal(loaded.earlier_content, null);
    assert.equal(loaded.content_complete, true);
    assert.equal(s.blocks[0].entries.filter(e => e.view.kind === 'human').length, 0);
    for (const e of [middle, tail, prefix]) s = provenContent(s, e, undefined, '6', h);
    assert.equal((h ? s.blocks[0].human : firstEntry(s)).content_complete, true);
  });
}
for (const replacement of ['append', 'generation', 'epoch']) {
  test(`C1-COMPLETE-01 current ${replacement} tail and linked prefix complete only current bytes`, () => {
    const old = partial([fragment('abcdef', 0n, 6n)], { earlier_content: null });
    let s = withEntry(old);
    const generation = replacement === 'append' ? '4' : '12', epoch = replacement === 'epoch' ? '12' : '4';
    const text = replacement === 'append' ? 'abcdefghi' : 'UVWABCXYZ';
    const tail = partial([fragment(text.slice(6), 6n, 9n, { generation })], { revision: '12', content_epoch: epoch,
      earlier_content: cursor('c', RID, 'e:4:0', epoch, FID, generation, '6') });
    // An addressed current read, not a bounded content response, proves the new tail.
    s = provenContent(s, tail, { kind: 'entry' });
    s = provenContent(s, old, { kind: 'content', cursor: tail.earlier_content }, '12');
    assert.equal(firstEntry(s).content_complete, false); assert.equal(firstEntry(s).view.revision, '12');
    const prefix = partial([fragment(text.slice(0, 6), 0n, 9n, { generation })],
      { revision: '12', content_epoch: epoch, earlier_content: null });
    s = provenContent(s, prefix, { kind: 'content', cursor: tail.earlier_content });
    assertWhole(firstEntry(s), text); assert.equal(firstEntry(s).content_complete, true);
    assert.equal(firstEntry(s).view.content_epoch, epoch); assert.equal(firstEntry(s).fields[0].generation, generation);
  });
}
test('C1-COMPLETE-01 a real byte gap cannot complete a linked traversal', () => {
  const tail = partial([fragment('ef', 4n, 6n)]), prefix = partial([fragment('ab', 0n, 6n)], { earlier_content: null });
  const s = linkedContent(withEntry(tail), prefix);
  assert.equal(firstEntry(s).fields[0].ranges.length, 2); assert.equal(firstEntry(s).content_complete, false);
  assert.notEqual(firstEntry(s).earlier_content, null);
});
for (const mode of ['unresolved', 'unlinked', 'out-of-order', 'duplicate', 'wrong-upper', 'bounded-complete']) {
  test(`C1-COMPLETE-01 ${mode} descriptor interval stays incomplete even with full known fields`, () => {
    const descriptors = [FID, SECOND, 'c'.repeat(64)].map((id, i) => field({ field_id: id, order_key: order(2, BigInt(i)),
      text: '', total_bytes: '0', to_byte: '0', kind: 'unsupported' }));
    const pieces = descriptors.map((f, i) => partial([f], i === 0 ? { earlier_content: null, content_complete: true } : {}));
    let s = withEntry(pieces[2]);
    if (mode === 'unlinked' || mode === 'bounded-complete') s = provenContent(s, pieces[0], undefined);
    if (mode === 'out-of-order') s = provenContent(s, pieces[0], { kind: 'content', cursor: pieces[1].earlier_content });
    if (mode === 'duplicate') {
      s = provenContent(s, pieces[0], { kind: 'content', cursor: pieces[1].earlier_content });
      s = provenContent(s, pieces[0], { kind: 'content', cursor: pieces[1].earlier_content });
    }
    if (mode === 'wrong-upper') s = provenContent(s, pieces[0], { kind: 'content', cursor: cursor('c', RID, 'e:4:0', '4', SECOND, '4', '0') });
    assert.ok(firstEntry(s).fields.every(f => f.ranges[0].from_byte === '0' && f.ranges[0].to_byte === f.total_bytes));
    assert.equal(firstEntry(s).content_complete, false);
    // Replaying the actual missing link is the only way to certify the inventory.
    s = provenContent(s, pieces[1], { kind: 'content', cursor: pieces[2].earlier_content });
    s = provenContent(s, pieces[0], { kind: 'content', cursor: pieces[1].earlier_content });
    assert.equal(firstEntry(s).fields.length, 3); assert.equal(firstEntry(s).content_complete, true);
  });
}
test('C1-COMPLETE-01 145 empty descriptors need the entire server chain, not known-range coverage', () => {
  const fields = Array.from({ length: 145 }, (_, i) => field({ field_id: BigInt(i + 1).toString(16).padStart(64, '0'),
    order_key: order(2, BigInt(i)), text: '', total_bytes: '0', to_byte: '0', kind: 'unsupported' }));
  const pieces = [fields.slice(81), fields.slice(17, 81), fields.slice(0, 17)].map((fs, i) =>
    partial(fs, i === 2 ? { earlier_content: null, content_complete: true } : {}));
  let s = withEntry(pieces[0]); assert.equal(firstEntry(s).content_complete, false);
  s = provenContent(s, pieces[2], { kind: 'content', cursor: pieces[1].earlier_content });
  assert.equal(firstEntry(s).fields.length, 81); assert.equal(firstEntry(s).content_complete, false);
  s = provenContent(s, pieces[1], { kind: 'content', cursor: pieces[0].earlier_content });
  assert.equal(firstEntry(s).fields.length, 145); assert.equal(firstEntry(s).content_complete, false);
  s = provenContent(s, pieces[2], { kind: 'content', cursor: pieces[1].earlier_content });
  assert.equal(firstEntry(s).fields.length, 145); assert.equal(firstEntry(s).content_complete, true);
});
test('C1-COMPLETE-01 newer revision bounded prefix cannot certify an old tail layout', () => {
  const tail = partial([fragment('def', 3n, 6n)]);
  let s = withEntry(tail);
  const prefix = partial([fragment('abc', 0n, 6n)], { revision: '12', earlier_content: null });
  s = linkedContent(s, prefix);
  assertWhole(firstEntry(s), 'abcdef'); assert.equal(firstEntry(s).content_complete, false);
  const currentTail = partial([fragment('def', 3n, 6n)], { revision: '12' });
  s = provenContent(s, currentTail, { kind: 'entry' });
  s = provenContent(s, prefix, { kind: 'content', cursor: currentTail.earlier_content });
  assert.equal(firstEntry(s).content_complete, true);
});
test('C1-COMPLETE-01 stale complete prefix fills append bytes but never proves newer descriptor layout', () => {
  const tail = partial([fragment('ghi', 6n, 9n)], { revision: '12' });
  let s = withEntry(tail);
  s = linkedContent(s, entry({ revision: '10', fields: [fragment('abcdef', 0n, 6n)] }), '12');
  assertWhole(firstEntry(s), 'abcdefghi'); assert.equal(firstEntry(s).content_start_loaded, false);
  assert.equal(firstEntry(s).content_complete, false);
});
test('C1-COMPLETE-01 read provenance identity errors are static and leave every cursor and input unchanged', () => {
  const s = withEntry(partial([fragment('def', 3n, 6n)])), before = clone(s);
  const prefix = partial([fragment('abc', 0n, 6n)], { earlier_content: null });
  for (const token of [cursor('c', OTHER, 'e:4:0', '4', FID, '4', '3'), cursor('c', RID, 'e:5:0', '5', FID, '5', '3'), 'invalid']) {
    reject(() => provenContent(s, prefix, { kind: 'content', cursor: token })); assert.deepEqual(s, before);
  }
});

function rbEntry(id, revision = '5', run_id = RID) {
  const [, sequence, slot] = id.split(':');
  return entry({ run_id, entry_id: id, position: { sequence, slot }, revision, content_epoch: sequence,
    fields: [field({ generation: sequence })] });
}
function rbOther(revision = '5', run = OTHER) { return { ...otherBlock('3', run), revision }; }
const rbPrefix = () => applyConversationChanges(base(), batch([upsert(entry({ revision: '5' }))], '5', cursor('l', '5', '2', RID, 'e:4:0')));
const rbInvalids = [
  ['sequence 6 entry then 5 block', base, () => batch([upsert(entry({ revision: '6' })), { kind: 'block.upsert', block: block({ revision: '5' }) }], '6', cursor('l', '5', '1', RID, ''))],
  ['duplicate tuple', base, () => batch([upsert(entry({ revision: '5' })), upsert(entry({ revision: '5' }))], '5', cursor('l', '5', '2', RID, 'e:4:0'))],
  ['descending rank', base, () => batch([upsert(entry({ revision: '5' })), { kind: 'block.upsert', block: block({ revision: '5' }) }], '5', cursor('l', '5', '1', RID, ''))],
  ['descending UUID', base, () => batch([{ kind: 'block.upsert', block: rbOther() }, { kind: 'block.upsert', block: block({ revision: '5' }) }], '5', cursor('l', '5', '1', RID, ''))],
  ['descending ASCII slot e:4:2 before e:4:10', base, () => batch([upsert(rbEntry('e:4:2')), upsert(rbEntry('e:4:10'))], '5', cursor('l', '5', '2', RID, 'e:4:10'))],
  ['descending ASCII sequence e:9 before e:10', base, () => batch([upsert(rbEntry('e:9:0', '20')), upsert(rbEntry('e:10:0', '20'))], '20', cursor('l', '20', '2', RID, 'e:10:0'))],
  ['descending exhausted watermark', base, () => batch([upsert(entry({ revision: '6' })), { kind: 'block.upsert', block: block({ revision: '5' }) }], '6')],
  ['nonempty equal entity prefix', rbPrefix, () => batch([upsert(entry({ revision: '5' }))], '5', cursor('l', '5', '2', RID, 'e:4:0'))],
  ['nonempty equal initial watermark', base, () => batch([upsert(entry())], '4')],
  ['equal tuple hidden by advancing watermark', rbPrefix, () => batch([upsert(entry({ revision: '5' }))], '6')],
  ['behind tuple hidden by advancing watermark', () => applyConversationChanges(base(), batch([], '5')), () => batch([upsert(entry({ revision: '5' }))], '6')],
  ['snapshot replay before newer final entity', base, () => batch([upsert(entry()), { kind: 'block.upsert', block: block({ revision: '6' }) }], '6', cursor('l', '6', '1', RID, ''))],
];
for (const [name, initial, input] of rbInvalids) test(`C1-RB-01 rejects ${name} without publication or mutation`, () => {
  const s = initial(), value = input(), saved = clone(value), before = clone(s), cursors = positions(s);
  let published = s;
  reject(() => { published = applyConversationChanges(s, value); });
  assert.strictEqual(published, s); assert.deepEqual(positions(s), cursors);
  assert.deepEqual(s, before); assert.deepEqual(value, saved);
});
function rbApply(s, value) {
  const saved = clone(value), before = clone(s);
  validateConversationChanges(value, SID);
  const next = applyConversationChanges(s, value);
  assert.deepEqual(value, saved); assert.deepEqual(s, before);
  assert.equal(next.previous_block, s.previous_block);
  for (const b of s.blocks) assert.equal(next.blocks.find(n => n.view.run_id === b.view.run_id).earlier_activity, b.earlier_activity);
  return next;
}
const rbValids = [
  ['private-only empty advancement', base, () => batch([], '100'), n => assert.equal(n.live_after, cursor('l', '100', '3', '', ''))],
  ['empty same-head exhaustion', rbPrefix, () => batch([], '5'), n => assert.equal(n.live_after, cursor('l', '5', '3', '', ''))],
  ['ascending sequence', base, () => batch([{ kind: 'block.upsert', block: block({ revision: '5' }) }, upsert(entry({ revision: '6' }))], '6', cursor('l', '6', '2', RID, 'e:4:0')), n => assert.equal(firstEntry(n).view.revision, '6')],
  ['metadata block entry rank ties', base, () => batch([{ kind: 'session.upsert', session: session('5') }, { kind: 'block.upsert', block: block({ revision: '5' }) }, upsert(entry({ revision: '5' }))], '5'), n => assert.equal(n.session.head_sequence, '5')],
  ['canonical UUID ties', base, () => batch([{ kind: 'block.upsert', block: block({ revision: '5' }) }, { kind: 'block.upsert', block: rbOther() }], '5', cursor('l', '5', '1', OTHER, '')), n => assert.deepEqual(n.blocks.map(b => b.view.run_id), [RID, OTHER])],
  // Explicit page membership keeps the ASCII traversal control separate from historical admission.
  ['ASCII e:4:10 before e:4:2 but numeric display order', () => replaceLatest(page({ entries: [entry(), rbEntry('e:4:2', '4'), rbEntry('e:4:10', '4')] })), () => batch([upsert(rbEntry('e:4:10')), upsert(rbEntry('e:4:2'))], '5', cursor('l', '5', '2', RID, 'e:4:2')), n => assert.deepEqual(n.blocks[0].entries.map(e => e.view.position.slot), ['0', '2', '10'])],
  ['rank dominates UUID', base, () => batch([{ kind: 'block.upsert', block: rbOther('5', '99999999-9999-4999-8999-999999999999') }, upsert(entry({ revision: '5' }))], '5'), n => assert.equal(n.blocks.length, 2)],
  ['same-sequence key after prefix', () => applyConversationChanges(replaceLatest(page({ entries: [entry(), rbEntry('e:4:1', '4')] })), batch([upsert(entry({ revision: '5' }))], '5', cursor('l', '5', '2', RID, 'e:4:0'))), () => batch([upsert(rbEntry('e:4:1'))], '5', cursor('l', '5', '2', RID, 'e:4:1')), n => assert.equal(n.blocks[0].entries.length, 2)],
  ['coalesced gaps with newer attached header', base, () => batch([upsert(entry({ revision: '8' }), block({ revision: '9' }))], '9', cursor('l', '8', '2', RID, 'e:4:0')), n => { assert.equal(firstEntry(n).view.revision, '8'); assert.equal(n.blocks[0].view.revision, '9'); }],
  ['delayed SSE behind newer addressed content', () => content(base(), entry({ revision: '10' })), () => batch([upsert(entry({ revision: '6' }))], '6'), n => { assert.equal(firstEntry(n).view.revision, '10'); assert.equal(n.live_after, cursor('l', '6', '3', '', '')); }],
  ['moving emitted identity', rbPrefix, () => batch([upsert(entry({ revision: '12' }))], '12'), n => assert.equal(firstEntry(n).view.revision, '12')],
  ['public metadata head is not metadata sequence', base, () => batch([{ kind: 'session.upsert', session: session('10') }, { kind: 'block.upsert', block: block({ revision: '6' }) }], '10', cursor('l', '6', '1', RID, '')), n => assert.equal(n.session.head_sequence, '10')],
  ['sequence above Number range', base, () => batch([upsert(entry({ revision: '9007199254740993' }))], '9007199254740993'), n => assert.equal(n.observed_head, '9007199254740993')],
];
for (const [name, initial, input, check] of rbValids) test(`C1-RB-01 valid ${name}`, () => check(rbApply(initial(), input())));
test('C1-RB-01 unchanged empty caught-up watermark is a valid pure-store no-op', () => {
  const s = base(); assert.deepEqual(rbApply(s, batch([], '4')), s);
});
function rbWindow(head = '9', ids = ['e:8:0'], earlier = null) {
  const emptyWithCursor = ids.length === 0 && earlier !== null;
  const s = replaceLatest(page({ snapshot_head: head, session: session(head), block: block({ revision: head }),
    entries: (emptyWithCursor ? ['e:8:0'] : ids).map(id => rbEntry(id, head)), earlier_activity: earlier, live_after: cursor('l', head, '3', '', '') }));
  // A current page cannot encode an empty segment with a cursor. Exercise this defensive internal shape separately.
  if (emptyWithCursor) return { ...s, blocks: [{ ...s.blocks[0], entries: [] }] };
  return s;
}
for (const earlier of [null, cursor('s', RID, '8', '0')]) for (const ids of [[], ['e:8:0'], ['e:8:0', 'e:12:0']]) {
  const head = ids.length === 2 ? '13' : '9';
  for (const id of ids.length === 2 ? ['e:4:0', 'e:10:0'] : ['e:4:0']) {
    test(`C1-RB-02 pre-H unknown ${id} stays unloaded in ${earlier === null ? 'null' : 'non-null'} cursor ${ids.length}-entry window`, () => {
      const s = rbWindow(head, ids, earlier);
      const n = rbApply(s, batch([{ kind: 'session.upsert', session: session('14', { title: 'renamed' }) }, upsert(rbEntry(id, '14'))], '14'));
      assert.deepEqual(n.blocks[0].entries, s.blocks[0].entries);
      assert.equal(n.session.title, 'renamed'); assert.equal(n.blocks[0].view.revision, '14');
      assert.equal(n.live_after, cursor('l', '14', '3', '', ''));
    });
  }
}
for (const earlier of [null, cursor('s', RID, '8', '0')]) for (const ids of [[], ['e:8:0']]) {
  for (const split of [false, true]) test(`C1-RB-02 post-H e10 after e12 survives advanced head ${earlier === null ? 'null' : 'non-null'} ${ids.length}-entry ${split ? 'split' : 'single'} batch`, () => {
    let s = rbWindow('9', ids, earlier);
    const rename = { kind: 'session.upsert', session: session('14') };
    if (split) {
      s = rbApply(s, batch([upsert(rbEntry('e:12:0', '12'))], '14', cursor('l', '12', '2', RID, 'e:12:0')));
      s = rbApply(s, batch([rename, upsert(rbEntry('e:10:0', '14'))], '14'));
    } else s = rbApply(s, batch([rename, upsert(rbEntry('e:12:0', '12')), upsert(rbEntry('e:10:0', '14'))], '14'));
    assert.deepEqual(s.blocks[0].entries.map(e => e.view.entry_id), [...ids, 'e:10:0', 'e:12:0']);
  });
}
test('C1-RB-02 known old and requested backward members remain admissible', () => {
  let s = rbWindow('9', ['e:8:0'], cursor('s', RID, '8', '0'));
  s = mergeConversationPage(s, page({ snapshot_head: '14', session: session('14'), block: block({ revision: '14' }), entries: [rbEntry('e:4:0', '14')], live_after: null }), { kind: 'within', cursor: s.blocks[0].earlier_activity });
  const n = rbApply(s, batch([upsert(rbEntry('e:4:0', '15'))], '15'));
  assert.deepEqual(n.blocks[0].entries.map(e => e.view.entry_id), ['e:4:0', 'e:8:0']); assert.equal(firstEntry(n).view.revision, '15');
});
test('C1-RB-02 backward-installed block retains its own H through within/content/metadata reads', () => {
  const b = otherBlock('20');
  let s = replaceLatest(page({ snapshot_head: '21', session: session('21'), block: b, entries: [], previous_block: cursor('b', '20'), live_after: cursor('l', '21', '3', '', '') }));
  s = mergeConversationPage(s, page({ snapshot_head: '22', session: session('22'), block: block({ revision: '22' }), entries: [rbEntry('e:8:0', '22')], earlier_activity: cursor('s', RID, '8', '0'), live_after: null }), { kind: 'before', cursor: s.previous_block });
  s = mergeConversationPage(s, page({ snapshot_head: '30', session: session('30'), block: block({ revision: '30' }), entries: [rbEntry('e:4:0', '30')], live_after: null }), { kind: 'within', cursor: s.blocks[0].earlier_activity });
  s = content(s, rbEntry('e:8:0', '31'));
  s = rbApply(s, batch([{ kind: 'session.upsert', session: session('33') }, upsert(rbEntry('e:25:0', '32')), upsert(rbEntry('e:22:0', '33'))], '33'));
  assert.deepEqual(s.blocks[0].entries.map(e => e.view.entry_id), ['e:4:0', 'e:8:0', 'e:25:0']);
});
test('C1-RB-02 later within does not raise latest activity cutoff', () => {
  let s = rbWindow('9', ['e:8:0'], cursor('s', RID, '8', '0'));
  s = mergeConversationPage(s, page({ snapshot_head: '14', session: session('14'), block: block({ revision: '14' }), entries: [rbEntry('e:4:0', '14')], live_after: null }), { kind: 'within', cursor: s.blocks[0].earlier_activity });
  s = rbApply(s, batch([upsert(rbEntry('e:12:0', '15')), upsert(rbEntry('e:10:0', '16'))], '16'));
  assert.deepEqual(s.blocks[0].entries.map(e => e.view.entry_id), ['e:4:0', 'e:8:0', 'e:10:0', 'e:12:0']);
});
test('C1-RB-02 live-origin block admits delayed activity after partial within and deduplicates anchor', () => {
  const b = { ...otherBlock('20'), revision: '24' };
  let s = rbApply(base(), batch([{ kind: 'block.upsert', block: b }, upsert(rbEntry('e:24:0', '24', OTHER), b)], '24'));
  s = mergeConversationPage(s, page({ snapshot_head: '30', session: session('30'), block: { ...b, revision: '30' }, entries: [rbEntry('e:21:0', '30', OTHER)], previous_block: cursor('b', '20'), live_after: null }), { kind: 'within', cursor: cursor('s', OTHER, '24', '0') });
  s = rbApply(s, batch([upsert(rbEntry('e:22:0', '31', OTHER), { ...b, revision: '31' })], '31'));
  const h = { ...b.human, revision: '32' }, header = { ...b, revision: '32', human: h };
  s = rbApply(s, batch([upsert(h, header)], '32'));
  assert.deepEqual(s.blocks[1].entries.map(e => e.view.entry_id), ['e:21:0', 'e:22:0', 'e:24:0']);
  assert.equal(s.blocks[1].human.view.entry_id, 'e:20:0'); assert.equal(s.blocks[1].entries.filter(e => e.view.kind === 'human').length, 0);
});
test('C1-RB-02 ignored history does not hide other entities and late invalid merge rolls back everything', () => {
  const s = rbWindow(), before = clone(s), cursors = positions(s);
  const good = [upsert(rbEntry('e:4:0', '14')), upsert(rbEntry('e:10:0', '15'))];
  const n = rbApply(s, batch(good, '15')); assert.deepEqual(n.blocks[0].entries.map(e => e.view.entry_id), ['e:8:0', 'e:10:0']);
  const value = batch([...good, upsert(rbEntry('e:8:0', '16'), block({ revision: '16', accepted_sequence: '3', human: human({ entry_id: 'e:3:0', position: { sequence: '3', slot: '0' }, revision: '3', content_epoch: '3', fields: [field({ field_id: 'text', order_key: '0', generation: '3' })] }) }))], '16');
  const saved = clone(value); validateConversationChanges(value); reject(() => applyConversationChanges(s, value));
  assert.deepEqual(s, before); assert.deepEqual(positions(s), cursors); assert.deepEqual(value, saved);
});

function raPiece(text, from, total = 9, overrides = {}) {
  return partial([fragment(text, BigInt(from), BigInt(total))], overrides);
}
const raToken = (upper, id = FID) => cursor('c', RID, 'e:4:0', '4', id, '4', String(upper));
const raTail = (s, e, head = e.revision) => provenContent(s, e, { kind: 'entry' }, head);
function raDone(s, text) {
  assertWhole(firstEntry(s), text);
  assert.equal(firstEntry(s).earlier_content, null);
  assert.deepEqual(firstEntry(s).content_traversal, { earlier_content: null });
  assert.equal(firstEntry(s).content_complete, true);
}
test('C1-RA-01 nine-byte wider current tail strengthens proof before exact advertised prefix', () => {
  let s = withEntry(raPiece('ghi', 6));
  s = raTail(s, raPiece('defghi', 3));
  assert.equal(firstEntry(s).earlier_content, raToken(3));
  assert.deepEqual(firstEntry(s).content_traversal, { earlier_content: raToken(3) });
  s = linkedContent(s, raPiece('abc', 0, 9, { earlier_content: null }));
  raDone(s, 'abcdefghi');
});
for (const unicode of [false, true]) test(`C1-RA-01 producer-shaped large ${unicode ? 'Unicode' : 'ASCII'} narrow wider linked chain`, () => {
  const text = unicode ? '雪🙂éabc'.repeat(6000) : 'a'.repeat(72000), bytes = Buffer.from(text);
  const narrow = unicode ? 70995 : 71000, wide = unicode ? 40959 : 40960;
  const middle = unicode ? 10008 : 10000;
  const piece = (from, to) => raPiece(bytes.subarray(from, to).toString('utf8'), from, bytes.length,
    from === 0 ? { earlier_content: null } : {});
  let s = withEntry(piece(narrow, bytes.length));
  s = raTail(s, piece(wide, bytes.length));
  assert.equal(firstEntry(s).content_traversal.earlier_content, raToken(wide));
  s = linkedContent(s, piece(middle, wide));
  assert.equal(firstEntry(s).content_complete, false);
  assert.equal(firstEntry(s).content_traversal.earlier_content, raToken(middle));
  s = linkedContent(s, piece(0, middle));
  raDone(s, text);
});
for (const mode of ['duplicate', 'narrower', 'linked stronger', 'completed']) {
  test(`C1-RA-01 ${mode} tail cannot weaken or resurrect stronger proof`, () => {
    let s = withEntry(raPiece('defghi', 3));
    if (mode === 'linked stronger') {
      s = linkedContent(withEntry(raPiece('ghi', 6)), raPiece('def', 3));
    } else if (mode === 'completed') {
      s = linkedContent(s, raPiece('abc', 0, 9, { earlier_content: null }));
    }
    const proof = clone(firstEntry(s).content_traversal);
    for (const tail of [raPiece('ghi', 6), raPiece('defghi', 3), raPiece('defghi', 3)]) {
      s = raTail(s, tail); assert.deepEqual(firstEntry(s).content_traversal, proof);
    }
    if (mode !== 'completed') s = linkedContent(s, raPiece('abc', 0, 9, { earlier_content: null }));
    raDone(s, 'abcdefghi');
  });
}
test('C1-RA-01 wider tail strengthens an already advanced linked proof', () => {
  let s = linkedContent(withEntry(raPiece('jkl', 9, 12)), raPiece('ghi', 6, 12));
  s = raTail(s, raPiece('defghijkl', 3, 12));
  assert.equal(firstEntry(s).content_traversal.earlier_content, raToken(3));
  raDone(linkedContent(s, raPiece('abc', 0, 12, { earlier_content: null })), 'abcdefghijkl');
});
test('C1-RA-01 full current addressed tail establishes terminal proof monotonically', () => {
  let s = raTail(withEntry(raPiece('ghi', 6)), raPiece('abcdefghi', 0, 9, { earlier_content: null, content_complete: true }));
  raDone(s, 'abcdefghi');
  s = raTail(s, raPiece('ghi', 6)); raDone(s, 'abcdefghi');
});
for (const empty of [false, true]) for (const crossByte of [false, true]) {
  test(`C1-RA-01 wider multiple ${empty ? 'empty unsupported' : 'text'} descriptors ${crossByte ? 'byte boundary' : 'upper0'} complete only linked chain`, () => {
    const descriptors = [FID, SECOND, 'c'.repeat(64)].map((id, i) => field({ field_id: id, order_key: order(2, BigInt(i)),
      ...(empty ? { text: '', total_bytes: '0', to_byte: '0', kind: 'unsupported' } : {}) }));
    const [a, b, c] = descriptors;
    const middle = crossByte && !empty ? fragment('def', 3n, 6n, { field_id: SECOND, order_key: b.order_key }) : b;
    let s = raTail(withEntry(partial([c])), partial([middle, c]));
    assert.equal(firstEntry(s).content_traversal.earlier_content, raToken(middle.from_byte, SECOND));
    s = linkedContent(s, partial(crossByte && !empty ? [a, fragment('abc', 0n, 6n, { field_id: SECOND, order_key: b.order_key })] : [a],
      { earlier_content: null, content_complete: !crossByte || empty }));
    assert.equal(firstEntry(s).fields.length, 3);
    assert.equal(firstEntry(s).content_complete, true);
    assert.equal(firstEntry(s).content_traversal.earlier_content, null);
    s = raTail(s, partial([c])); assert.equal(firstEntry(s).content_complete, true);
  });
}
for (const mode of ['gap', 'unlinked', 'wrong upper', 'missing descriptor', 'noncontiguous', 'no provenance']) {
  test(`C1-RA-01 ${mode} cannot certify current layout from known bytes`, () => {
    const c = field({ field_id: SECOND, order_key: order(2, 2n), text: '', total_bytes: '0', to_byte: '0', kind: 'unsupported' });
    let s = withEntry(mode === 'missing descriptor' || mode === 'noncontiguous' ? partial([c]) : raPiece('ghi', 6));
    const proof = clone(firstEntry(s).content_traversal);
    if (mode === 'missing descriptor') s = provenContent(s, partial([field()], { earlier_content: null, content_complete: true }), undefined);
    else if (mode === 'noncontiguous') s = raTail(s, partial([fragment('ab', 0n, 3n), c], { earlier_content: null }));
    else if (mode === 'no provenance') s = provenContent(s, raPiece('defghi', 3), undefined);
    else s = provenContent(s, raPiece(mode === 'gap' || mode === 'wrong upper' ? 'abc' : 'abcdef', 0, 9, { earlier_content: null }),
      mode === 'unlinked' ? undefined : { kind: 'content', cursor: mode === 'wrong upper' ? raToken(3) : firstEntry(s).earlier_content });
    assert.equal(firstEntry(s).content_complete, false);
    assert.deepEqual(firstEntry(s).content_traversal, proof);
    if (mode === 'gap') assert.equal(firstEntry(s).fields[0].ranges.length, 2);
  });
}
test('C1-RA-01 stale wider revision cannot strengthen current proof', () => {
  const s = withEntry(raPiece('ghi', 6, 9, { revision: '12' }));
  const n = raTail(s, raPiece('defghi', 3), '12');
  assert.equal(firstEntry(n).view.revision, '12');
  assert.deepEqual(firstEntry(n).content_traversal, firstEntry(s).content_traversal);
  assert.equal(firstEntry(n).content_complete, false);
});
for (const replacement of ['generation', 'epoch']) test(`C1-RA-01 ${replacement} replacement isolates current proof from stale tail and prefix`, () => {
  const epoch = replacement === 'epoch' ? '12' : '4';
  const piece = (text, from) => raPiece(text, from, 9, { revision: '12', content_epoch: epoch,
    fields: [fragment(text, BigInt(from), 9n, { generation: '12' })],
    earlier_content: from === 0 ? null : cursor('c', RID, 'e:4:0', epoch, FID, '12', String(from)) });
  let s = raTail(withEntry(raPiece('ghi', 6)), piece('XYZ', 6));
  const proof = clone(firstEntry(s).content_traversal);
  s = raTail(s, raPiece('defghi', 3), '12');
  assert.deepEqual(firstEntry(s).content_traversal, proof);
  s = provenContent(s, raPiece('abcdef', 0, 9, { earlier_content: null }), { kind: 'content', cursor: proof.earlier_content }, '12');
  assert.equal(firstEntry(s).content_complete, false);
  s = raTail(s, piece('ABCXYZ', 3));
  s = linkedContent(s, piece('UVW', 0));
  raDone(s, 'UVWABCXYZ');
  assert.equal(firstEntry(s).view.content_epoch, epoch);
  assert.equal(firstEntry(s).fields[0].generation, '12');
});
for (const contradiction of ['generation', 'epoch', 'scalar']) test(`C1-RA-01 equal revision ${contradiction} contradiction rejects without mutation`, () => {
  const s = withEntry(raPiece('ghi', 6)), before = clone(s), cursors = positions(s);
  const e = raPiece('defghi', 3, 9, contradiction === 'generation' ? {
    fields: [fragment('defghi', 3n, 9n, { generation: '8' })], earlier_content: cursor('c', RID, 'e:4:0', '4', FID, '8', '3')
  } : contradiction === 'epoch' ? { content_epoch: '8', earlier_content: cursor('c', RID, 'e:4:0', '8', FID, '4', '3') } : { recorded_state: 'completed' });
  const value = addressed(e, block({ revision: '10' }), '10'), saved = clone(value);
  validateEntryPage(value);
  let published = s;
  assert.throws(() => { published = mergeEntryPage(s, value, undefined, { kind: 'entry' }); }, e => e.message === 'protocol.identity_mismatch');
  assert.strictEqual(published, s); assert.deepEqual(s, before); assert.deepEqual(positions(s), cursors); assert.deepEqual(value, saved);
});

// Canonical SQL forbids aliases. These closed DTOs test the defensive loaded-window boundary.
const collisionRun = '44444444-4444-4444-8444-444444444444';
const collisionCases = [
  ['single existing position', base, () => batch([{ kind: 'block.upsert', block: { ...otherBlock('2'), revision: '5' } }], '5', cursor('l', '5', '1', OTHER, ''))],
  ['nonlatest position', () => rbApply(base(), batch([{ kind: 'block.upsert', block: otherBlock() }], '20')), () => batch([{ kind: 'block.upsert', block: { ...otherBlock('2', collisionRun), revision: '21' } }], '21', cursor('l', '21', '1', collisionRun, ''))],
  ['two new blocks same position', base, () => batch([{ kind: 'block.upsert', block: otherBlock() }, { kind: 'block.upsert', block: { ...otherBlock('20', collisionRun), revision: '21' } }], '21', cursor('l', '21', '1', collisionRun, ''))],
  ['entry attached header alias', base, () => batch([upsert(rbEntry('e:5:0', '5', OTHER), { ...otherBlock('2'), revision: '5' })], '5', cursor('l', '5', '2', OTHER, 'e:5:0'))],
  ['prior valid identity update then alias', base, () => batch([upsert(entry({ revision: '5', recorded_state: 'completed', provisional: false })), { kind: 'block.upsert', block: { ...otherBlock('2'), revision: '6' } }], '6', cursor('l', '6', '1', OTHER, ''))],
  ['known ID changed accepted position', base, () => batch([{ kind: 'session.upsert', session: session('5', { title: 'renamed' }) }, { kind: 'block.upsert', block: { ...otherBlock('3', RID), revision: '5' } }], '5', cursor('l', '5', '1', RID, ''))],
];
for (const [name, initial, input] of collisionCases) test(`C1-REVIEW-B-01 rejects ${name} atomically before live publication`, () => {
  const s = initial(), before = clone(s), cursors = positions(s), value = input(), saved = clone(value);
  validateConversationChanges(value, SID);
  let published = s;
  assert.throws(() => { published = applyConversationChanges(s, value); }, e => e.message === 'protocol.identity_mismatch');
  assert.strictEqual(published, s); assert.deepEqual(s, before); assert.deepEqual(positions(s), cursors); assert.deepEqual(value, saved);
});
test('C1-REVIEW-B-01 known header and human updates retain identity and one anchor', () => {
  const h = human({ revision: '5' }), b = block({ revision: '5', human: h });
  const s = rbApply(base(), batch([{ kind: 'block.upsert', block: b }, upsert(h, b)], '5', cursor('l', '5', '2', RID, h.entry_id)));
  assert.equal(s.blocks.length, 1); assert.equal(s.blocks[0].human.view.revision, '5');
  assert.equal(s.blocks[0].entries.filter(e => e.view.kind === 'human').length, 0);
});
test('C1-REVIEW-B-01 genuinely older noncolliding unknown block stays unloaded with live progress', () => {
  const s = base(), value = batch([{ kind: 'block.upsert', block: { ...otherBlock('1'), revision: '5' } }], '5', cursor('l', '5', '1', OTHER, ''));
  const n = rbApply(s, value); assert.deepEqual(n.blocks, s.blocks); assert.equal(n.live_after, value.next_after); assert.equal(n.observed_head, '5');
});
test('C1-REVIEW-B-01 later block admits delivered activity and deduplicates human', () => {
  const b = { ...otherBlock('5'), revision: '6' }, e = rbEntry('e:6:0', '6', OTHER), h = { ...b.human, revision: '7' };
  const s = rbApply(base(), batch([{ kind: 'block.upsert', block: b }, upsert(e, b), upsert(h, { ...b, revision: '7', human: h })], '7'));
  assert.deepEqual(s.blocks.map(b => b.view.accepted_sequence), ['2', '5']);
  assert.equal(s.blocks[1].human.view.entry_id, 'e:5:0');
  assert.deepEqual(s.blocks[1].entries.map(e => e.view.entry_id), ['e:6:0']);
});

{
  const third = 'c'.repeat(64);
  const b = field({ field_id: SECOND, order_key: order(2, 1n) });
  const c = field({ field_id: third, order_key: order(2, 2n) });
  const token = (id = FID) => cursor('c', RID, 'e:4:0', '4', id, '4', '0');
  const subset = (fields, earlier = token(fields[0].field_id), revision = '4') => entry({ revision, fields,
    earlier_content: earlier, content_complete: earlier === null && fields.every(f => !f.has_earlier && !f.has_later) });
  const current = (s, e, read = { kind: 'entry' }) => mergeEntryPage(s, addressed(e, block({ revision: e.revision }), e.revision), undefined, read);
  const chain = () => current(withEntry(subset([b])), subset([field()], null), { kind: 'content', cursor: token(SECOND) });
  function requireConflict(name, s, input, apply, validate) {
    test(`C1-REVIEW-B-02 rejects ${name} without publication or mutation`, () => {
      const before = clone(s), saved = clone(input), cursors = positions(s), proof = clone(firstEntry(s).content_traversal);
      validate(input);
      assert.deepEqual(proof, { earlier_content: null });
      let published = s;
      assert.throws(() => { published = apply(s, input); }, e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
      assert.strictEqual(published, s); assert.deepEqual(s, before); assert.deepEqual(input, saved);
      assert.deepEqual(positions(s), cursors); assert.deepEqual(firstEntry(s).content_traversal, proof);
    });
  }
  requireConflict('direct complete Latest then addressed fieldB upper0', base(), addressed(subset([b])),
    (s, p) => mergeEntryPage(s, p, { session_id: SID, run_id: RID, entry_id: 'e:4:0' }, { kind: 'entry' }), validateEntryPage);
  requireConflict('direct complete addressed then addressed fieldB upper0', current(withEntry(subset([field()])), entry()), addressed(subset([b])),
    (s, p) => mergeEntryPage(s, p, undefined, { kind: 'entry' }), validateEntryPage);
  requireConflict('completed linked chain then addressed fieldC', chain(), addressed(subset([c])),
    (s, p) => mergeEntryPage(s, p, undefined, { kind: 'entry' }), validateEntryPage);
  requireConflict('completed linked chain then unprovenanced fieldC', chain(), addressed(subset([c])),
    (s, p) => mergeEntryPage(s, p), validateEntryPage);
  requireConflict('completed linked chain then content-provenance fieldC', chain(), addressed(subset([c])),
    (s, p) => mergeEntryPage(s, p, undefined, { kind: 'content', cursor: token(SECOND) }), validateEntryPage);
  for (const kind of ['before', 'within']) {
    const query = { kind, cursor: kind === 'before' ? cursor('b', '10') : cursor('s', RID, '8', '0') };
    const p = page({ entries: [subset([b])], live_after: null, earlier_activity: cursor('s', RID, '4', '0') });
    requireConflict(`direct complete then ${kind} page`, base(), p,
      (s, value) => mergeConversationPage(s, value, query), value => validateConversationPage(value, query, SID));
  }
  for (const tuple of [false, true]) {
    const s = current(base(), entry({ revision: '6' }));
    const p = batch([{ kind: 'session.upsert', session: session('7', { title: 'must not publish' }) },
      upsert(subset([b], token(SECOND), '6'), block({ revision: '6' }))], '7',
    tuple ? cursor('l', '6', '2', RID, 'e:4:0') : cursor('l', '7', '3', '', ''));
    requireConflict(`whole batch after valid metadata with ${tuple ? 'entry-tuple' : 'watermark'} cursor`, s, p,
      applyConversationChanges, validateConversationChanges);
  }
  // Inventory proof still applies when missing bytes prevent content completion.
  const gap = clone(chain());
  gap.blocks[0].entries[0].fields[0].ranges = [{ from_byte: '0', to_byte: '1', text: 'a' }, { from_byte: '2', to_byte: '3', text: 'c' }];
  gap.blocks[0].entries[0].content_complete = false;
  requireConflict('terminal inventory with a defensive byte gap', gap, addressed(subset([c])),
    (s, p) => mergeEntryPage(s, p, undefined, { kind: 'entry' }), validateEntryPage);

  test('C1-REVIEW-B-02 incomplete same-revision disjoint subsets merge with content provenance', () => {
    const tail = subset([b]), s = withEntry(tail), before = clone(s), p = addressed(subset([field()], null)), saved = clone(p);
    const next = mergeEntryPage(s, p, undefined, { kind: 'content', cursor: tail.earlier_content });
    assert.deepEqual(firstEntry(next).fields.map(f => f.field_id), [FID, SECOND]); assert.equal(firstEntry(next).content_complete, true);
    assert.deepEqual(s, before); assert.deepEqual(p, saved);
  });
  test('C1-REVIEW-B-02 null lower token without rooted proof permits unseen descriptors', () => {
    const s = current(withEntry(subset([fragment('c', 2n, 3n)])), subset([fragment('a', 0n, 3n)], null), undefined);
    assert.equal(firstEntry(s).content_traversal, null);
    const next = current(s, subset([b]));
    assert.equal(firstEntry(next).fields.length, 2); assert.equal(firstEntry(next).content_complete, false);
  });
  test('C1-REVIEW-B-02 terminal inventory permits compatible known fragments', () => {
    const s = base(), next = current(s, subset([fragment('bc', 1n, 3n)]));
    assert.deepEqual(firstEntry(next).fields, firstEntry(s).fields); assert.equal(firstEntry(next).content_complete, true);
    assert.equal(firstEntry(next).earlier_content, null);
  });
  test('C1-REVIEW-B-02 completed chain permits known descriptor retransmission', () => {
    const s = chain(), next = current(s, subset([b]));
    assert.deepEqual(firstEntry(next).fields, firstEntry(s).fields); assert.equal(firstEntry(next).content_complete, true);
  });
  test('C1-REVIEW-B-02 newer revision admits a new field and resets current proof', () => {
    const next = current(base(), subset([{ ...b, generation: '5' }], cursor('c', RID, 'e:4:0', '4', SECOND, '5', '0'), '5'));
    assert.equal(firstEntry(next).fields.length, 2); assert.equal(firstEntry(next).content_complete, false);
    assert.notEqual(firstEntry(next).content_traversal.earlier_content, null);
  });
  test('C1-REVIEW-B-02 newer epoch replaces only the target layout', () => {
    const s = base(), next = current(s, entry({ revision: '6', content_epoch: '6', fields: [{ ...b, generation: '6' }] }));
    assert.deepEqual(firstEntry(next).fields.map(f => f.field_id), [SECOND]); assert.equal(firstEntry(next).content_complete, true);
    assert.deepEqual(next.blocks[0].human, s.blocks[0].human);
  });
  test('C1-REVIEW-B-02 known overlap contradiction remains an atomic static rejection', () => {
    const s = base(), p = addressed(entry({ fields: [field({ text: 'xyz' })] })), before = clone(s), saved = clone(p);
    let published = s;
    assert.throws(() => { published = mergeEntryPage(s, p); }, e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
    assert.strictEqual(published, s); assert.deepEqual(s, before); assert.deepEqual(p, saved);
  });
}

{
  const c = 'c'.repeat(64), d = 'd'.repeat(64);
  const a = field(), b = field({ field_id: SECOND, order_key: order(2, 1n) });
  const cf = field({ field_id: c, order_key: order(2, 2n) }), df = field({ field_id: d, order_key: order(2, 3n) });
  const token = (f, upper = f.from_byte, epoch = '4') => cursor('c', RID, 'e:4:0', epoch, f.field_id, f.generation, String(upper));
  const piece = (fields, lower = token(fields[0]), revision = '4', extra = {}) => entry({ revision, fields,
    earlier_content: lower, content_complete: lower === null && fields.every(f => !f.has_earlier && !f.has_later), ...extra });
  const ep = e => addressed(e, block({ revision: e.revision }), e.revision);
  const current = (s, e, read = { kind: 'entry' }) => mergeEntryPage(s, ep(e), undefined, read);
  const known = (s, e) => mergeEntryPage(s, ep(e));
  const linked = (upper = cf) => known(withEntry(piece([upper])), piece([b]));
  function omission(name, prepare) {
    test(`C1-RA-NEW-01 rejects ${name} atomically`, () => {
      const { s, input, read, live = false } = prepare();
      const before = clone(s), saved = clone(input), cursors = positions(s), proof = clone(firstEntry(s).content_traversal);
      if (live) validateConversationChanges(input, SID); else validateEntryPage(input);
      let published = s;
      assert.throws(() => { published = live ? applyConversationChanges(s, input) : mergeEntryPage(s, input, undefined, read); },
        e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
      assert.strictEqual(published, s); assert.deepEqual(s, before); assert.deepEqual(input, saved);
      assert.deepEqual(positions(s), cursors); assert.deepEqual(firstEntry(s).content_traversal, proof);
    });
  }
  omission('CURRENT complete A omits known B upper0 rev4', () => ({ s: withEntry(piece([b])), input: ep(piece([a], null)), read: { kind: 'entry' } }));
  omission('CURRENT complete A omits B from nonterminal A+B', () => ({ s: withEntry(piece([a, b])), input: ep(piece([a], null)), read: { kind: 'entry' } }));
  omission('CURRENT complete A omits unprovenanced known B', () => ({ s: known(withEntry(piece([fragment('ab', 0n, 3n)])), piece([b])), input: ep(piece([a], null)), read: { kind: 'entry' } }));
  omission('CURRENT nonterminal A+C omits middle B', () => ({ s: withEntry(piece([b])), input: ep(piece([a, cf])), read: { kind: 'entry' } }));
  omission('CURRENT complete A+C omits middle B', () => ({ s: withEntry(piece([b])), input: ep(piece([a, cf], null)), read: { kind: 'entry' } }));
  omission('LINKED nonterminal A+C below D upper0 omits middle B', () => ({ s: linked(df), input: ep(piece([a, cf])), read: { kind: 'content', cursor: token(df) } }));
  omission('LINKED complete A+C below D upper0 omits middle B', () => ({ s: linked(df), input: ep(piece([a, cf], null)), read: { kind: 'content', cursor: token(df) } }));
  omission('LINKED complete A below C upper0 omits B', () => ({ s: linked(), input: ep(piece([a], null)), read: { kind: 'content', cursor: token(cf) } }));
  omission('LINKED A+C at positive C upper3 omits B', () => {
    const tail = fragment('def', 3n, 6n, { field_id: c, order_key: cf.order_key });
    const prefix = fragment('abc', 0n, 6n, { field_id: c, order_key: cf.order_key });
    return { s: linked(tail), input: ep(piece([a, prefix], null)), read: { kind: 'content', cursor: token(tail) } };
  });
  for (const kind of ['CURRENT', 'LINKED']) omission(`${kind} omits B with defensive byte gap`, () => {
    const s = clone(kind === 'CURRENT' ? withEntry(piece([b])) : linked());
    firstEntry(s).fields.find(f => f.field_id === SECOND).ranges = [{ from_byte: '0', to_byte: '1', text: 'a' }, { from_byte: '2', to_byte: '3', text: 'c' }];
    return { s, input: ep(piece([a], null)), read: kind === 'CURRENT' ? { kind: 'entry' } : { kind: 'content', cursor: token(cf) } };
  });
  for (const tuple of [false, true]) omission(`live metadata then CURRENT A rev6 omits addressed B rev6 with ${tuple ? 'entry-tuple' : 'watermark'}`, () => {
    const s = current(withEntry(piece([b])), piece([b], token(b), '6'));
    const input = batch([{ kind: 'session.upsert', session: session('7', { title: 'must not publish' }) }, upsert(piece([a], null, '6'), block({ revision: '6' }))], '7',
      tuple ? cursor('l', '6', '2', RID, 'e:4:0') : cursor('l', '7', '3', '', ''));
    return { s, input, live: true };
  });
  omission('CURRENT empty unsupported A+C omits empty B descriptor', () => {
    const empty = f => ({ ...f, kind: 'unsupported', text: '', total_bytes: '0', to_byte: '0' });
    return { s: withEntry(piece([empty(b)])), input: ep(piece([empty(a), empty(cf)], null)), read: { kind: 'entry' } };
  });
  function stable(s, e, read) {
    const before = clone(s), input = ep(e), saved = clone(input), cursors = positions(s);
    validateEntryPage(input); const n = mergeEntryPage(s, input, undefined, read);
    assert.deepEqual(s, before); assert.deepEqual(input, saved);
    assert.equal(n.live_after, cursors.live); assert.equal(n.observed_head, s.observed_head); assert.equal(n.previous_block, s.previous_block);
    return n;
  }
  const control = (name, run) => test(`C1-RA-NEW-01 control ${name}`, run);
  control('CURRENT complete A+B includes known B', () => {
    const n = stable(withEntry(piece([b])), piece([a, b], null), { kind: 'entry' });
    assert.equal(firstEntry(n).content_complete, true); assert.equal(firstEntry(n).fields.length, 2);
  });
  control('LINKED B-to-A complete includes inventory', () => {
    const n = stable(withEntry(piece([b])), piece([a], null), { kind: 'content', cursor: token(b) });
    assert.equal(firstEntry(n).content_complete, true); assert.equal(firstEntry(n).fields.length, 2);
  });
  control('positive upper prefix includes A+B+C', () => {
    const tail = fragment('def', 3n, 6n, { field_id: c, order_key: cf.order_key });
    const prefix = fragment('abc', 0n, 6n, { field_id: c, order_key: cf.order_key });
    const n = stable(linked(tail), piece([a, b, prefix], null), { kind: 'content', cursor: token(tail) });
    assert.equal(firstEntry(n).content_complete, true);
  });
  control('unprovenanced complete A cannot certify B tail', () => {
    const n = stable(withEntry(piece([b])), piece([a], null), undefined);
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
    assert.deepEqual(firstEntry(n).content_traversal, { earlier_content: token(b) });
  });
  control('unlinked null lower prefix cannot certify', () => {
    const n = stable(withEntry(piece([b])), piece([a], null), { kind: 'content', cursor: token(a) });
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
  });
  control('unprovenanced nonterminal disjoint subsets', () => {
    const n = stable(withEntry(piece([b])), piece([a]), undefined);
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
  });
  control('nonterminal CURRENT lower descriptor outside interval', () => {
    const n = stable(withEntry(piece([b])), piece([a, b]), { kind: 'entry' });
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
  });
  control('known partial bytes of terminal inventory', () => {
    const s = withEntry(piece([a, b], null));
    const n = stable(s, piece([fragment('bc', 1n, 3n, { field_id: SECOND, order_key: b.order_key })]), { kind: 'entry' });
    assert.deepEqual(firstEntry(n).fields, firstEntry(s).fields); assert.equal(firstEntry(n).content_complete, true);
  });
  control('known retransmission after linked completion', () => {
    const s = current(withEntry(piece([b])), piece([a], null), { kind: 'content', cursor: token(b) });
    const n = stable(s, piece([b]), { kind: 'entry' });
    assert.deepEqual(firstEntry(n).fields, firstEntry(s).fields); assert.equal(firstEntry(n).content_complete, true);
  });
  control('newer revision permits descriptor and resets proof', () => {
    const nextB = { ...b, generation: '5' };
    const n = stable(withEntry(piece([a], null)), piece([nextB], token(nextB), '5'), { kind: 'entry' });
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
  });
  control('newer CURRENT complete A is not same-revision omission', () => {
    const n = stable(withEntry(piece([b])), piece([a], null, '5'), { kind: 'entry' });
    assert.equal(firstEntry(n).view.revision, '5'); assert.equal(firstEntry(n).fields.length, 2);
  });
  control('new epoch replaces target only', () => {
    const s = withEntry(piece([b])), n = stable(s, piece([{ ...a, generation: '6' }], null, '6', { content_epoch: '6' }), { kind: 'entry' });
    assert.equal(firstEntry(n).fields.length, 1); assert.equal(firstEntry(n).view.content_epoch, '6'); assert.deepEqual(n.blocks[0].human, s.blocks[0].human);
  });
  control('stale append bytes do not prove current layout', () => {
    const tail = fragment('def', 3n, 6n, { field_id: SECOND, order_key: b.order_key });
    const n = stable(withEntry(piece([tail], token(tail), '6')), piece([b], null), { kind: 'content', cursor: token(tail) });
    assert.equal(firstEntry(n).view.revision, '6'); assert.equal(firstEntry(n).fields[0].ranges[0].text, 'abcdef'); assert.equal(firstEntry(n).content_complete, false);
  });
  control('terminal-to-unseen guard remains', () => {
    const s = withEntry(piece([a], null)), before = clone(s), input = ep(piece([b])), saved = clone(input);
    assert.throws(() => mergeEntryPage(s, input, undefined, { kind: 'entry' }), e => e.message === 'protocol.identity_mismatch');
    assert.deepEqual(s, before); assert.deepEqual(input, saved);
  });
  control('unknown opaque upper has no certificate', () => {
    const n = stable(withEntry(piece([b])), piece([a], null), { kind: 'content', cursor: token(df) });
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
  });
  control('CURRENT legitimate lower descriptor and byte gap', () => {
    const tail = fragment('c', 2n, 3n, { field_id: FID, order_key: a.order_key });
    const n = stable(withEntry(piece([b])), piece([tail, b]), { kind: 'entry' });
    assert.equal(firstEntry(n).fields.length, 2); assert.equal(firstEntry(n).content_complete, false);
  });
}

{
  const expected = { session_id: SID, run_id: RID, entry_id: 'e:4:0' };
  const token = (id = FID, gen = '4', epoch = '4', upper = '0') => cursor('c', RID, 'e:4:0', epoch, id, gen, upper);
  const b = field({ field_id: SECOND, order_key: order(2, 1n) });
  const stale = rev => entry({ revision: rev, fields: [b], earlier_content: token(SECOND), content_complete: false });
  const start = (e = entry()) => withEntry(e, cursor('s', RID, '4', '0'));
  const current = (gap = false) => {
    let s = mergeEntryPage(start(), addressed(entry({ revision: '6' }), block({ revision: '6' }), '6'), expected, { kind: 'entry' });
    assert.equal(s.live_after, cursor('l', '4', '3', '', '')); assert.deepEqual(firstEntry(s).content_traversal, { earlier_content: null });
    if (gap) {
      s = clone(s); firstEntry(s).fields[0].ranges = [{ from_byte: '0', to_byte: '1', text: 'a' }, { from_byte: '2', to_byte: '3', text: 'c' }];
      firstEntry(s).content_complete = false;
    }
    return s;
  };
  function observe(s, input, validate, apply, rejection, check) {
    const before = clone(s), saved = clone(input), cursors = positions(s), proof = clone(firstEntry(s).content_traversal);
    validate(input); let published = s;
    if (rejection) {
      assert.throws(() => { published = apply(s, input); }, e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
      assert.strictEqual(published, s); assert.deepEqual(positions(s), cursors); assert.deepEqual(firstEntry(s).content_traversal, proof);
    } else { published = apply(s, input); check(published); }
    assert.deepEqual(s, before); assert.deepEqual(input, saved);
  }
  for (const gap of [false, true]) for (const route of ['addressed', 'content', 'unprovenanced', 'before', 'within', 'live-watermark', 'live-tuple']) {
    test(`C1-REVIEW-B-03 rejects ${gap ? 'byte-gap' : 'full-bytes'} ${route} stale absent B atomically`, () => {
      const s = current(gap); let input, validate, apply;
      if (route.startsWith('live')) {
        input = batch([{ kind: 'session.upsert', session: session('7', { title: 'must not publish' }) }, upsert(stale('5'), block({ revision: '5' }))], '7',
          route === 'live-tuple' ? cursor('l', '5', '2', RID, 'e:4:0') : cursor('l', '7', '3', '', ''));
        validate = p => validateConversationChanges(p, SID); apply = applyConversationChanges;
      } else if (route === 'before' || route === 'within') {
        const query = { kind: route, cursor: route === 'before' ? cursor('b', '10') : cursor('s', RID, '8', '0') };
        input = page({ entries: [stale('4')], live_after: null, earlier_activity: cursor('s', RID, '4', '0') });
        validate = p => validateConversationPage(p, query, SID); apply = (s, p) => mergeConversationPage(s, p, query);
      } else {
        input = addressed(stale('4')); validate = p => validateEntryPage(p, expected);
        const read = route === 'addressed' ? { kind: 'entry' } : route === 'content' ? { kind: 'content', cursor: token() } : undefined;
        apply = (s, p) => mergeEntryPage(s, p, expected, read);
      }
      observe(s, input, validate, apply, true);
    });
  }
  const install = e => mergeEntryPage(start(), addressed(e, block({ revision: e.revision }), e.revision), expected, { kind: 'entry' });
  const growth = () => install(entry({ revision: '6', fields: [field({ text: 'abcdef', total_bytes: '6', to_byte: '6' })] }));
  const epoch6 = () => install(entry({ revision: '6', content_epoch: '6', fields: [field({ generation: '6' })] }));
  function control(name, prepare, e, rejection, check) {
    test(`C1-REVIEW-B-03 control ${name}`, () => {
      const s = prepare(), input = addressed(e, block({ revision: e.revision }), e.revision);
      observe(s, input, p => validateEntryPage(p, expected), (s, p) => mergeEntryPage(s, p, expected, { kind: 'entry' }), rejection, n => check(n, s));
    });
  }
  control('equal revision absent B rejects', current, stale('6'), true);
  control('lower epoch stale absent B no-op', epoch6, stale('4'), false, (n, s) => assert.deepEqual(n, s));
  control('known stale append prefix retained', growth, entry({ fields: [fragment('abc', 0n, 3n)] }), false, (n, s) => assert.deepEqual(n, s));
  control('known stale byte contradiction rejects', growth, entry({ fields: [field({ text: 'abX' })] }), true);
  control('known stale Unicode prefix retained', () => {
    const s = start(entry({ fields: [field({ text: '雪', total_bytes: '3', to_byte: '3' })] }));
    return mergeEntryPage(s, addressed(entry({ revision: '6', fields: [field({ text: '雪🙂', total_bytes: '7', to_byte: '7' })] }), block({ revision: '6' }), '6'), expected, { kind: 'entry' });
  }, entry({ fields: [field({ text: '雪', total_bytes: '3', to_byte: '3' })] }), false, (n, s) => assert.deepEqual(n, s));
  control('older generation and cursor retain replacement', () => install(entry({ revision: '6', fields: [field({ generation: '6', text: 'XYZ' })] })),
    entry({ earlier_content: token(), content_complete: false }), false, (n, s) => assert.deepEqual(n, s));
  control('incomplete newer inventory admits stale absent descriptor', () => {
    const e = stale('6'); return mergeEntryPage(start(stale('4')), addressed(e, block({ revision: '6' }), '6'), expected, { kind: 'entry' });
  }, entry(), false, n => {
    assert.deepEqual(firstEntry(n).fields.map(f => f.field_id), [FID, SECOND]); assert.equal(firstEntry(n).view.revision, '6');
    assert.equal(firstEntry(n).content_complete, false); assert.notEqual(firstEntry(n).content_traversal.earlier_content, null);
  });
  control('newer same epoch grows inventory', current, stale('7'), false, n => {
    assert.deepEqual(firstEntry(n).fields.map(f => f.field_id), [FID, SECOND]); assert.equal(firstEntry(n).view.revision, '7');
    assert.notEqual(firstEntry(n).content_traversal.earlier_content, null);
  });
  control('newer epoch replaces target layout', current, entry({ revision: '7', content_epoch: '7', fields: [{ ...b, generation: '7' }] }), false, (n, s) => {
    assert.deepEqual(firstEntry(n).fields.map(f => f.field_id), [SECOND]); assert.equal(firstEntry(n).view.content_epoch, '7'); assert.deepEqual(n.blocks[0].human, s.blocks[0].human);
  });
  control('equal revision generation conflict rejects', () => install(entry({ revision: '6', fields: [field({ generation: '6' })] })), entry({ revision: '6' }), true);
  for (const tuple of [false, true]) {
    const next = tuple ? cursor('l', '5', '2', RID, 'e:4:0') : cursor('l', '7', '3', '', '');
    const metadata = { kind: 'session.upsert', session: session('7', { title: 'healthy metadata' }) };
    test(`C1-REVIEW-B-03 control live ${tuple ? 'tuple' : 'watermark'} known delayed prefix`, () => {
      const s = growth(), input = batch([metadata, upsert(entry({ revision: '5' }), block({ revision: '5' }))], '7', next);
      observe(s, input, p => validateConversationChanges(p, SID), applyConversationChanges, false, n => {
        assert.deepEqual(firstEntry(n), firstEntry(s)); assert.equal(n.live_after, next); assert.equal(n.session.title, 'healthy metadata');
      });
    });
    test(`C1-REVIEW-B-03 control live ${tuple ? 'tuple' : 'watermark'} lower epoch no-op`, () => {
      const s = epoch6(), input = batch([metadata, upsert(stale('5'), block({ revision: '5' }))], '7', next);
      observe(s, input, p => validateConversationChanges(p, SID), applyConversationChanges, false, n => {
        assert.deepEqual(firstEntry(n), firstEntry(s)); assert.equal(n.live_after, next); assert.equal(n.session.title, 'healthy metadata');
      });
    });
  }
  test('C1-REVIEW-B-03 control live metadata then known byte conflict rolls back', () => {
    const input = batch([{ kind: 'session.upsert', session: session('7', { title: 'must not publish' }) }, upsert(entry({ revision: '5', fields: [field({ text: 'abX' })] }), block({ revision: '5' }))], '7');
    observe(growth(), input, p => validateConversationChanges(p, SID), applyConversationChanges, true);
  });
}

{
  const F = n => field({ field_id: n.repeat(64), order_key: order(2, BigInt({ a: 1, b: 2, c: 3, d: 4 }[n])) });
  const A = F('a'), B = F('b'), C = F('c'), D = F('d');
  const P = field({ field_id: '0'.repeat(64), order_key: order(2, 0n) });
  const token = (f, upper = f.from_byte, epoch = '4') => cursor('c', RID, 'e:4:0', epoch, f.field_id, f.generation, String(upper));
  const piece = (fields, lower = token(fields[0]), revision = '10', extra = {}) => entry({ revision, fields,
    earlier_content: lower, content_complete: lower === null && fields.every(f => !f.has_earlier && !f.has_later), ...extra });
  const ep = e => addressed(e, block({ revision: e.revision }), e.revision);
  const merge = (s, e, read) => mergeEntryPage(s, ep(e), undefined, read);
  const empty = f => ({ ...f, kind: 'unsupported', text: '', total_bytes: '0', from_byte: '0', to_byte: '0' });
  function prepare(kind, variant = 'full', lowLive = false) {
    const transform = variant === 'empty' ? empty : f => f;
    const a = transform(A), c = transform(C), d = transform(D);
    let s;
    if (kind === 'CURRENT') s = lowLive ? merge(withEntry(piece([c], token(c), '9')), piece([a, c]), { kind: 'entry' }) : withEntry(piece([a, c]));
    else if (kind === 'LINKED0') {
      const root = lowLive ? merge(withEntry(piece([d], token(d), '9')), piece([d]), { kind: 'entry' }) : withEntry(piece([d]));
      s = merge(root, piece([a, c]), { kind: 'content', cursor: token(d) });
    } else {
      const tail = fragment('def', 3n, 6n, { field_id: D.field_id, order_key: D.order_key });
      const prefix = fragment('abc', 0n, 6n, { field_id: D.field_id, order_key: D.order_key });
      s = merge(withEntry(piece([tail])), piece([a, c, prefix]), { kind: 'content', cursor: token(tail) });
    }
    if (variant === 'gap') {
      // A byte gap does not erase the already certified descriptor inventory.
      s = clone(s); firstEntry(s).fields.find(f => f.field_id === C.field_id).ranges = [
        { from_byte: '0', to_byte: '1', text: 'a' }, { from_byte: '2', to_byte: '3', text: 'c' }];
    }
    assert.deepEqual(firstEntry(s).content_traversal, { earlier_content: token(a) });
    assert.equal(firstEntry(s).content_complete, false);
    return s;
  }
  function atomic(s, input, apply) {
    const before = clone(s), saved = clone(input), navigation = positions(s), proof = clone(firstEntry(s).content_traversal);
    let published = s;
    assert.throws(() => { published = apply(s, input); }, e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
    assert.strictEqual(published, s); assert.deepEqual(published, before); assert.deepEqual(positions(s), navigation);
    assert.deepEqual(firstEntry(s).content_traversal, proof); assert.deepEqual(input, saved);
  }
  function negative(name, kind, variant = 'full', ingress = 'unprovenanced') {
    test('C1-RA-CERT-REVERSE-01 STRICT ' + name, () => {
      const b = variant === 'empty' ? empty(B) : B;
      let e = piece([b]), read;
      if (ingress === 'stale-unprovenanced') e = piece([b], token(b), '9');
      if (ingress === 'unlinked') read = { kind: 'content', cursor: token(C) };
      if (ingress === 'noncontiguous-current') {
        e = piece([fragment('ab', 0n, 3n, { field_id: B.field_id, order_key: B.order_key })]); read = { kind: 'entry' };
      }
      const tail = kind === 'CURRENT' ? [b, variant === 'empty' ? empty(C) : C]
        : [b, variant === 'empty' ? empty(C) : C, variant === 'empty' ? empty(D) : D];
      if (ingress === 'current-BC') { e = piece(tail); read = { kind: 'entry' }; }
      const live = ingress.startsWith('live');
      if (live) e = piece(tail);
      const s = prepare(kind, variant, live);
      const input = live ? batch([{ kind: 'session.upsert', session: session('12', { title: 'Synthetic candidate metadata' }) },
        upsert(e, block({ revision: '10' }))], '12', ingress === 'live-tuple' ? cursor('l', '10', '2', RID, 'e:4:0') : cursor('l', '12', '3', '', '')) : ep(e);
      if (live) validateConversationChanges(input, SID); else validateEntryPage(input);
      atomic(s, input, live ? applyConversationChanges : (s, p) => mergeEntryPage(s, p, undefined, read));
    });
  }
  for (const kind of ['CURRENT', 'LINKED0', 'LINKEDPOS']) {
    negative(kind + ' later unprovenanced B', kind);
    negative(kind + ' content C upper0 is not frontier', kind, 'full', 'unlinked');
    negative(kind + ' later noncontiguous current B', kind, 'full', 'noncontiguous-current');
  }
  for (const kind of ['CURRENT', 'LINKED0']) {
    negative(kind + ' empty descriptors', kind, 'empty');
    negative(kind + ' defensive byte gaps', kind, 'gap');
    negative(kind + ' stale same-epoch unprovenanced B', kind, 'full', 'stale-unprovenanced');
    negative(kind + ' later current BC', kind, 'full', 'current-BC');
    negative(kind + ' metadata batch watermark', kind, 'full', 'live-watermark');
    negative(kind + ' metadata batch entity tuple', kind, 'full', 'live-tuple');
  }
  const control = (name, run) => test('C1-RA-CERT-REVERSE-01 CONTROL ' + name, run);
  for (const kind of ['CURRENT', 'LINKED0', 'LINKEDPOS']) {
    control(kind + ' reversing arrival rejects', () => {
      const b = merge(withEntry(piece([D])), piece([B])), saved = clone(b);
      if (kind === 'CURRENT') assert.throws(() => merge(b, piece([A, C]), { kind: 'entry' }), e => e.message === 'protocol.identity_mismatch');
      else if (kind === 'LINKED0') assert.throws(() => merge(b, piece([A, C]), { kind: 'content', cursor: token(D) }), e => e.message === 'protocol.identity_mismatch');
      else {
        const tail = fragment('def', 3n, 6n, { field_id: D.field_id, order_key: D.order_key });
        const prefix = fragment('abc', 0n, 6n, { field_id: D.field_id, order_key: D.order_key });
        const x = merge(withEntry(piece([tail])), piece([B]));
        assert.throws(() => merge(x, piece([A, C, prefix]), { kind: 'content', cursor: token(tail) }), e => e.message === 'protocol.identity_mismatch');
      }
      assert.deepEqual(b, saved);
    });
    control(kind + ' known bytes and lower outside interval valid', () => {
      const s = prepare(kind), n = merge(s, piece([P])), same = merge(n, piece([C]), { kind: 'content', cursor: token(C) });
      assert.deepEqual(firstEntry(same).fields.map(f => f.field_id[0]), kind === 'CURRENT' ? ['0', 'a', 'c'] : ['0', 'a', 'c', 'd']);
      assert.deepEqual(firstEntry(same).content_traversal, firstEntry(s).content_traversal);
      assert.equal(same.live_after, s.live_after); assert.equal(same.observed_head, s.observed_head);
    });
    control(kind + ' new revision resets proof and admits B', () => {
      const s = prepare(kind), n = merge(s, piece([B], token(B), '11'));
      assert.equal(firstEntry(n).view.revision, '11'); assert.equal(firstEntry(n).content_traversal, null);
      assert.ok(firstEntry(n).fields.some(f => f.field_id === B.field_id)); assert.equal(n.live_after, s.live_after);
    });
    control(kind + ' new epoch replaces only entry', () => {
      const s = prepare(kind), b = { ...B, generation: '11' }, n = merge(s, piece([b], token(b, 0, '11'), '11', { content_epoch: '11' }));
      assert.deepEqual(firstEntry(n).fields.map(f => f.field_id), [B.field_id]); assert.equal(firstEntry(n).content_traversal, null);
      assert.deepEqual(n.blocks[0].human, s.blocks[0].human);
    });
    control(kind + ' stale known bytes preserve current revision', () => {
      const s = prepare(kind), n = merge(s, piece([C], token(C), '9'));
      assert.deepEqual(firstEntry(n), firstEntry(s)); assert.equal(n.live_after, s.live_after);
    });
    control(kind + ' lower epoch no-op', () => {
      const a = { ...A, generation: '8' }, newer = withEntry(piece([a], token(a, 0, '8'), '10', { content_epoch: '8' }));
      const noop = merge(newer, piece([B], token(B), '9'));
      assert.deepEqual(firstEntry(noop), firstEntry(newer)); assert.equal(noop.live_after, newer.live_after);
    });
  }
  for (const read of [undefined, { kind: 'content', cursor: token(C) }]) control('unprovenanced or unlinked priors supply no negative proof ' + String(read?.kind), () => {
    const s = merge(withEntry(piece([D])), piece([A, C]), read), n = merge(s, piece([B]));
    assert.ok(firstEntry(n).fields.some(f => f.field_id === B.field_id));
    assert.deepEqual(firstEntry(n).content_traversal, { earlier_content: token(D) }); assert.equal(firstEntry(n).content_complete, false);
  });
  control('noncontiguous CURRENT prior supplies no negative proof', () => {
    const s = merge(withEntry(piece([D])), piece([A, fragment('ab', 0n, 3n, { field_id: C.field_id, order_key: C.order_key })]), { kind: 'entry' });
    assert.deepEqual(firstEntry(s).content_traversal, { earlier_content: token(D) });
    assert.ok(firstEntry(merge(s, piece([B]))).fields.some(f => f.field_id === B.field_id));
  });
  control('terminal prior guard unchanged', () => {
    const s = withEntry(piece([A, C], null)); assert.throws(() => merge(s, piece([B])), e => e.message === 'protocol.identity_mismatch');
  });
  control('whole metadata batch known-byte conflict rolls back watermark and tuple', () => {
    for (const next of [cursor('l', '12', '3', '', ''), cursor('l', '10', '2', RID, 'e:4:0')]) {
      const s = prepare('CURRENT', 'full', true), conflicting = piece([{ ...C, text: 'xyz' }]);
      const input = batch([{ kind: 'session.upsert', session: session('12', { title: 'Synthetic candidate metadata' }) },
        upsert(conflicting, block({ revision: '10' }))], '12', next);
      validateConversationChanges(input, SID); atomic(s, input, applyConversationChanges);
    }
  });
}

{
  const c = (generation = '4', upper = '0', id = FID, epoch = '4') => cursor('c', RID, 'e:4:0', epoch, id, generation, upper);
  const desc = (text = 'new', generation = '4') => field({ text, generation, total_bytes: String(Buffer.byteLength(text)), to_byte: String(Buffer.byteLength(text)) });
  function state(gap = false, observed = '10') {
    const f = gap ? fragment('!!', 4n, 6n) : desc();
    const e = entry({ fields: [f], content_complete: !gap, earlier_content: gap ? c('4', '4') : null });
    let s = replaceLatest(page({ entries: [e] }));
    s = mergeEntryPage(s, addressed(entry({ ...e, revision: observed }), block({ revision: observed }), observed), undefined, { kind: 'entry' });
    if (gap) s = mergeEntryPage(s, addressed(entry({ revision: observed, fields: [fragment('ne', 0n, 6n)], content_complete: false, earlier_content: null }), block({ revision: observed }), observed));
    if (observed !== '10') s = mergeEntryPage(s, addressed(entry({ revision: '10', fields: [], earlier_content: null }), block({ revision: '10' }), '10'));
    assert.equal(firstEntry(s).view.revision, '10'); assert.equal(firstEntry(s).fields[0].revision, observed);
    assert.equal(s.live_after, cursor('l', '4', '3', '', '')); assert.equal(s.observed_head, '4');
    if (gap) assert.deepEqual(firstEntry(s).fields[0].ranges, [{ from_byte: '0', to_byte: '2', text: 'ne' }, { from_byte: '4', to_byte: '6', text: '!!' }]);
    return s;
  }
  function incoming(s, e, ingress) {
    const b = block({ revision: e.revision });
    if (['addressed', 'unprovenanced', 'content'].includes(ingress)) {
      const value = addressed(e, b, e.revision); validateEntryPage(value, { session_id: SID, run_id: RID, entry_id: e.entry_id });
      let read;
      if (ingress === 'addressed') read = { kind: 'entry' };
      else if (ingress === 'content') read = { kind: 'content', cursor: firstEntry(s).earlier_content ?? c() };
      return { value, apply: () => mergeEntryPage(s, value, undefined, read) };
    }
    if (ingress === 'before' || ingress === 'within') {
      const query = { kind: ingress, cursor: ingress === 'before' ? cursor('b', '20') : cursor('s', RID, '5', '0') };
      const value = page({ snapshot_head: e.revision, session: session(e.revision), block: b, entries: [e], live_after: null });
      validateConversationPage(value, query, SID); return { value, apply: () => mergeConversationPage(s, value, query) };
    }
    const next = ingress === 'live-tuple' ? cursor('l', e.revision, '2', RID, e.entry_id) : cursor('l', e.revision, '3', '', '');
    const value = batch([{ kind: 'session.upsert', session: session(e.revision, { title: 'Synthetic incoming metadata' }) }, upsert(e, b)], e.revision, next);
    validateConversationChanges(value, SID); return { value, apply: () => applyConversationChanges(s, value) };
  }
  function check(s, e, ingress, expect, shouldReject = false) {
    const { value, apply } = incoming(s, e, ingress), before = clone(s), saved = clone(value), navigation = positions(s), proof = clone(firstEntry(s).content_traversal);
    let published = s;
    if (shouldReject) {
      assert.throws(() => { published = apply(); }, error => error instanceof ProtocolError && error.message === 'protocol.identity_mismatch');
      assert.strictEqual(published, s); assert.deepEqual(published, before); assert.deepEqual(positions(s), navigation);
      assert.deepEqual(firstEntry(s).content_traversal, proof);
    } else { published = apply(); expect(published); }
    assert.deepEqual(s, before); assert.deepEqual(value, saved);
  }
  for (const gap of [false, true]) for (const ingress of ['addressed', 'unprovenanced', 'content', 'before', 'within', 'live-watermark', 'live-tuple']) {
    test(`C1-RB-CURRENT-01 strict ${gap ? 'byte-gap' : 'full-bytes'} ${ingress}: stale higher generation must reject atomically`, () => {
      check(state(gap), entry({ revision: '8', fields: [desc('old', '8')] }), ingress, undefined, true);
    });
  }
  test('C1-RB-CURRENT-01 strict descriptor observed9 entry10 incoming8 gen8 rejects atomically', () => {
    check(state(false, '9'), entry({ revision: '8', fields: [desc('old', '8')] }), 'addressed', undefined, true);
  });
  const control = (name, run) => test('C1-RB-CURRENT-01 control ' + name, run);
  control('old lower generation no-op retains newer descriptor and bytes', () => {
    let s = state(); const high = entry({ revision: '12', fields: [desc('NEW', '12')] });
    s = mergeEntryPage(s, addressed(high, block({ revision: '12' }), '12'), undefined, { kind: 'entry' });
    check(s, entry({ revision: '8', fields: [desc('old', '4')] }), 'addressed', n => { assert.deepEqual(firstEntry(n), firstEntry(s)); assert.equal(n.live_after, s.live_after); });
  });
  function grow() {
    let s = replaceLatest(page({ entries: [entry({ fields: [fragment('ab', 0n, 4n)], content_complete: false, earlier_content: null })] }));
    s = mergeEntryPage(s, addressed(entry({ revision: '10', fields: [fragment('ef', 4n, 6n)], content_complete: false, earlier_content: c('4', '4') }), block({ revision: '10' }), '10'), undefined, { kind: 'entry' });
    return s;
  }
  control('same-generation valid stale fixed prefix merges missing bytes without metadata regression', () => {
    const s = grow(); check(s, entry({ revision: '8', fields: [fragment('abcd', 0n, 4n)], content_complete: false, earlier_content: null }), 'content', n => {
      assert.equal(firstEntry(n).view.revision, '10'); assert.equal(firstEntry(n).fields[0].revision, '10'); assert.equal(firstEntry(n).fields[0].total_bytes, '6');
      assert.deepEqual(firstEntry(n).fields[0].ranges, [{ from_byte: '0', to_byte: '6', text: 'abcdef' }]); assert.equal(n.live_after, s.live_after); assert.equal(n.observed_head, s.observed_head);
    });
  });
  control('same-generation contradiction rejects after valid metadata and keeps all prior state', () => {
    check(state(), entry({ revision: '8', fields: [desc('BAD', '4')] }), 'live-watermark', undefined, true);
  });
  control('same-generation stale larger total rejects genuine prefix-bounds violation', () => {
    check(grow(), entry({ revision: '8', fields: [fragment('abcd', 0n, 7n)], content_complete: false, earlier_content: null }), 'content', undefined, true);
  });
  control('same-generation current disjoint subsets merge with exact Unicode bytes', () => {
    const text = '雪🙂é', total = BigInt(Buffer.byteLength(text));
    const s = withEntry(entry({ revision: '10', fields: [fragment('é', 7n, total)], content_complete: false, earlier_content: c('4', '7') }));
    check(s, entry({ revision: '10', fields: [fragment('雪🙂', 0n, total)], content_complete: false, earlier_content: null }), 'unprovenanced', n => {
      assert.deepEqual(firstEntry(n).fields[0].ranges, [{ from_byte: '0', to_byte: '9', text }]);
    });
  });
  control('newer entry and higher generation replace only target field', () => {
    let s = state(); s = mergeEntryPage(s, addressed(entry({ revision: '11', fields: [desc(), field({ field_id: SECOND, order_key: order(2, 1n), generation: '11', text: 'XYZ' })], earlier_content: c(), content_complete: false }), block({ revision: '11' }), '11'), undefined, { kind: 'entry' });
    const sibling = firstEntry(s).fields[1];
    check(s, entry({ revision: '12', fields: [desc('NEW', '12')], earlier_content: c('12'), content_complete: false }), 'addressed', n => {
      assert.equal(firstEntry(n).fields[0].generation, '12'); assert.equal(firstEntry(n).fields[0].ranges[0].text, 'NEW'); assert.deepEqual(firstEntry(n).fields[1], sibling); assert.equal(n.live_after, s.live_after);
    });
  });
  control('new epoch replaces target only and preserves another entry and anchor', () => {
    let s = state(); const another = entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '10', content_epoch: '5', fields: [desc('other', '5')] });
    s = mergeConversationPage(s, page({ snapshot_head: '10', session: session('10'), block: block({ revision: '10' }), entries: [another], live_after: null }), { kind: 'before', cursor: cursor('b', '20') });
    const before = clone(s); check(s, entry({ revision: '12', content_epoch: '12', fields: [desc('NEW', '12')] }), 'addressed', n => {
      assert.equal(firstEntry(n).view.content_epoch, '12'); assert.deepEqual(n.blocks[0].entries[1], before.blocks[0].entries[1]); assert.deepEqual(n.blocks[0].human, before.blocks[0].human); assert.equal(n.live_after, s.live_after);
    });
  });
  control('sparse older last-seen field may learn intermediate generation despite newer entry metadata', () => {
    const old = entry({ fields: [desc('abc')], earlier_content: c(), content_complete: false }); let s = replaceLatest(page({ entries: [old] }));
    const tail = entry({ revision: '10', fields: [field({ field_id: SECOND, order_key: order(2, 1n), generation: '10', text: 'XYZ' })], earlier_content: c('10', '0', SECOND), content_complete: false });
    s = mergeEntryPage(s, addressed(tail, block({ revision: '10' }), '10'), undefined, { kind: 'entry' });
    assert.equal(firstEntry(s).view.revision, '10'); assert.equal(firstEntry(s).fields[0].revision, '4');
    check(s, entry({ revision: '8', fields: [desc('old', '8')], earlier_content: c('8'), content_complete: false }), 'unprovenanced', n => {
      assert.equal(firstEntry(n).view.revision, '10'); assert.equal(firstEntry(n).fields[0].revision, '8'); assert.equal(firstEntry(n).fields[0].generation, '8');
      assert.equal(firstEntry(n).fields[0].ranges[0].text, 'old'); assert.deepEqual(firstEntry(n).fields[1], firstEntry(s).fields[1]);
    });
  });
  control('equal field-observation revision with differing generation remains conflict', () => {
    check(state(), entry({ revision: '10', fields: [desc('old', '8')] }), 'addressed', undefined, true);
  });
  control('live stale same-generation compatible bytes advances live but never lowers addressed entry metadata', () => {
    const s = state(); check(s, entry({ revision: '8', fields: [desc('new', '4')] }), 'live-tuple', n => {
      assert.deepEqual(firstEntry(n), firstEntry(s)); assert.equal(n.live_after, cursor('l', '8', '2', RID, 'e:4:0'));
      assert.equal(n.session.title, 'Synthetic incoming metadata'); assert.equal(n.observed_head, '8');
    });
  });
  control('newer entry higher generation can replace after a prior gap', () => {
    const s = state(true); check(s, entry({ revision: '12', fields: [desc('NEW', '12')] }), 'addressed', n => {
      assert.equal(firstEntry(n).fields[0].generation, '12'); assert.deepEqual(firstEntry(n).fields[0].ranges, [{ from_byte: '0', to_byte: '3', text: 'NEW' }]); assert.equal(firstEntry(n).view.revision, '12');
    });
  });
}

{
  const c = (generation, upper, id = FID, epoch = '4') => cursor('c', RID, 'e:4:0', epoch, id, generation, upper);
  const desc = (text, generation) => field({ text, generation, total_bytes: String(Buffer.byteLength(text)), to_byte: String(Buffer.byteLength(text)) });
  const compact = (revision, f, lower = c(f.generation, f.from_byte), extra = {}) => entry({ revision, fields: [f],
    earlier_content: lower, content_complete: lower === null && !f.has_earlier && !f.has_later, ...extra });
  const expected = { session_id: SID, run_id: RID, entry_id: 'e:4:0' };
  const install = (s, e, read) => mergeEntryPage(s, addressed(e, block({ revision: e.revision }), e.revision), expected, read);
  function known(shape) {
    let f;
    if (shape === 'prefix') f = fragment('NE', 0n, 6n, { generation: '10' });
    else if (shape === 'gapped') f = fragment('N', 0n, 3n, { generation: '10' });
    else f = desc('NEW', '10');
    let s = install(base(), compact('10', f, null));
    if (shape === 'gapped') s = install(s, compact('10', fragment('W', 2n, 3n, { generation: '10' }), null));
    assert.equal(firstEntry(s).view.revision, '10'); assert.equal(firstEntry(s).view.content_epoch, '4');
    assert.equal(firstEntry(s).fields[0].generation, '10'); assert.equal(firstEntry(s).fields[0].revision, '10');
    assert.equal(s.live_after, cursor('l', '4', '3', '', '')); assert.equal(s.observed_head, '4');
    assert.equal(firstEntry(s).earlier_content, null); assert.equal(firstEntry(s).content_traversal, null);
    return s;
  }
  function incoming(s, e, ingress) {
    const b = block({ revision: e.revision });
    if (['addressed', 'unprovenanced', 'content'].includes(ingress)) {
      const value = addressed(e, b, e.revision); validateEntryPage(value, expected);
      let read;
      if (ingress === 'addressed') read = { kind: 'entry' };
      else if (ingress === 'content') read = { kind: 'content', cursor: c('10', '3') };
      return { value, apply: () => mergeEntryPage(s, value, expected, read) };
    }
    if (ingress === 'before' || ingress === 'within') {
      const query = { kind: ingress, cursor: ingress === 'before' ? cursor('b', '20') : cursor('s', RID, '5', '0') };
      const value = page({ snapshot_head: e.revision, session: session(e.revision), block: b, entries: [e], live_after: null });
      validateConversationPage(value, query, SID); return { value, apply: () => mergeConversationPage(s, value, query) };
    }
    const next = ingress === 'live-tuple' ? cursor('l', e.revision, '2', RID, e.entry_id) : cursor('l', e.revision, '3', '', '');
    const value = batch([{ kind: 'session.upsert', session: session(e.revision, { title: 'Synthetic prior valid metadata' }) }, upsert(e, b)], e.revision, next);
    validateConversationChanges(value, SID); return { value, apply: () => applyConversationChanges(s, value) };
  }
  for (const shape of ['prefix', 'gapped', 'fullbytes']) for (const full of [false, true]) {
    for (const ingress of ['addressed', 'unprovenanced', 'content', 'before', 'within', 'live-watermark', 'live-tuple']) {
      test(`C1-RB-NEWER-LOWER-GENERATION-01 strict ${ingress} ${shape} retained bytes ${full ? 'full' : 'partial'} discarded input`, () => {
        const s = known(shape), f = full ? desc('old', '8') : fragment('d', 2n, 3n, { generation: '8' });
        const e = compact('12', f, full ? null : c('8', '2'));
        const { value, apply } = incoming(s, e, ingress), before = clone(s), saved = clone(value), navigation = positions(s);
        const proof = clone(firstEntry(s).content_traversal);
        let published = s;
        assert.throws(() => { published = apply(); }, error => {
          assert.ok(error instanceof ProtocolError); assert.equal(error.message, 'protocol.identity_mismatch');
          assert.deepEqual(Object.keys(error).sort(), ['category', 'name']); assert.equal(error.cause, undefined);
          return true;
        });
        assert.strictEqual(published, s); assert.deepEqual(published, before); assert.deepEqual(positions(published), navigation);
        assert.deepEqual(firstEntry(published).content_traversal, proof);
        assert.deepEqual(s, before); assert.deepEqual(value, saved);
      });
    }
  }
  const control = (name, run) => test('C1-RB-NEWER-LOWER-GENERATION-01 control ' + name, run);
  control('truly older lower generation is a no-op', () => {
    const s = known('fullbytes'), n = install(s, compact('8', desc('old', '8')), { kind: 'entry' });
    assert.deepEqual(n, s);
  });
  control('same-generation newer append preserves exact earlier bytes', () => {
    const s = known('fullbytes'), n = install(s, compact('12', desc('NEW!', '10'), null), { kind: 'entry' });
    assert.deepEqual(firstEntry(n).fields[0].ranges, [{ from_byte: '0', to_byte: '4', text: 'NEW!' }]);
    assert.equal(firstEntry(n).fields[0].generation, '10'); assert.equal(firstEntry(n).fields[0].revision, '12');
  });
  control('higher newer generation replaces only target field', () => {
    let s = known('fullbytes');
    const sibling = field({ field_id: SECOND, order_key: order(2, 1n), generation: '11', text: 'XYZ' });
    s = install(s, entry({ revision: '11', fields: [desc('NEW', '10'), sibling], content_complete: false, earlier_content: c('10', '0') }), { kind: 'entry' });
    const n = install(s, compact('12', desc('new', '12')), { kind: 'entry' });
    assert.equal(firstEntry(n).fields[0].generation, '12'); assert.deepEqual(firstEntry(n).fields[1], firstEntry(s).fields[1]);
    assert.deepEqual(n.blocks[0].human, s.blocks[0].human); assert.equal(n.live_after, s.live_after);
  });
  control('new epoch replaces only target entry layout', () => {
    const s = known('fullbytes'), n = install(s, compact('12', desc('new', '12'), null, { content_epoch: '12' }), { kind: 'entry' });
    assert.equal(firstEntry(n).view.content_epoch, '12'); assert.equal(firstEntry(n).fields[0].generation, '12');
    assert.deepEqual(n.blocks[0].human, s.blocks[0].human); assert.equal(n.live_after, s.live_after);
  });
  control('old compatible bytes fill gaps without lowering metadata', () => {
    const s = install(base(), compact('10', fragment('def', 3n, 6n)), { kind: 'entry' });
    const n = install(s, compact('8', fragment('abc', 0n, 3n), null), { kind: 'content', cursor: c('4', '3') });
    assert.equal(firstEntry(n).view.revision, '10'); assert.equal(firstEntry(n).fields[0].revision, '10');
    assert.equal(firstEntry(n).fields[0].total_bytes, '6');
    assert.deepEqual(firstEntry(n).fields[0].ranges, [{ from_byte: '0', to_byte: '6', text: 'abcdef' }]);
  });
  control('sparse field observed4 entry10 learns intermediate gen8 at observation8', () => {
    const s = install(base(), compact('10', field({ field_id: SECOND, order_key: order(2, 1n), generation: '10', text: 'XYZ' }), c('10', '0', SECOND)), { kind: 'entry' });
    assert.equal(firstEntry(s).view.revision, '10'); assert.equal(firstEntry(s).fields[0].revision, '4');
    const n = install(s, compact('8', desc('old', '8')));
    assert.equal(firstEntry(n).view.revision, '10'); assert.equal(firstEntry(n).fields[0].revision, '8');
    assert.equal(firstEntry(n).fields[0].generation, '8'); assert.deepEqual(firstEntry(n).fields[1], firstEntry(s).fields[1]);
  });
  control('equal observation differing generation rejects with full rollback', () => {
    const s = known('fullbytes'), before = clone(s), value = addressed(compact('10', desc('old', '8')), block({ revision: '10' }), '10'), saved = clone(value);
    assert.throws(() => mergeEntryPage(s, value, expected, { kind: 'entry' }), e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
    assert.deepEqual(s, before); assert.deepEqual(value, saved);
  });
  control('known-byte conflict rolls back prior batch metadata and both live cursor modes', () => {
    const s = base();
    for (const ingress of ['live-watermark', 'live-tuple']) {
      const { value, apply } = incoming(s, compact('12', desc('BAD', '4'), null), ingress), before = clone(s), saved = clone(value);
      let published = s;
      assert.throws(() => { published = apply(); }, e => e instanceof ProtocolError && e.message === 'protocol.identity_mismatch');
      assert.strictEqual(published, s); assert.deepEqual(s, before); assert.deepEqual(value, saved);
    }
  });
  test('C1-RB-NEWER-LOWER-GENERATION-01 guard truth table uses field observation, not entry revision', () => {
    const rejects = (fieldRevision, generation, incomingRevision, incomingGeneration) => BigInt(incomingRevision) > BigInt(fieldRevision) && BigInt(incomingGeneration) < BigInt(generation);
    assert.equal(rejects('10', '10', '12', '8'), true); assert.equal(rejects('9', '9', '12', '8'), true);
    assert.equal(rejects('10', '10', '8', '8'), false); assert.equal(rejects('4', '4', '8', '8'), false);
    assert.equal(rejects('10', '10', '12', '10'), false); assert.equal(rejects('10', '10', '12', '12'), false);
  });
}
