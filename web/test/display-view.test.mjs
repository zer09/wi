import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mountDisplayView, parseSessionHash, sessionHash, supportedOrigin, hasOlder, errorText } from '../dist/display-view.js';
import { replaceLatest, mergeConversationPage, applyConversationChanges } from '../dist/display-store.js';
import { validateConversationPage } from '../dist/display-api.js';
import { model, controller, button, control, byClass } from '../test-support/display-dom.mjs';
import * as f from '../test-support/display-fixtures.mjs';
import { createDisplayClient } from '../dist/display-client.js';

const loaded = (p = f.page()) => replaceLatest(validateConversationPage(p, { kind: 'latest' }, f.SID), f.SID);
function state(store = loaded(), overrides = {}) {
  return { connection: 'connected', settings: { workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket' },
    catalog: { entries: [], has_more: false }, catalog_loading: false, error: null, draft: ' exact\n draft ', pending: [],
    selected: { session_id: f.SID, store, manifest: null, observation: 'streaming', observation_error: null, closed_reason: null,
      older_loading: false, older_error: null, content_operations: [], run_view: null, cancel: null, cancelling: false }, ...overrides };
}
function setup(t, initial = state()) { const dom = model(t), c = controller(initial); const view = mountDisplayView(dom.root, c.client, () => {}, true, dom.layout); t.after(() => view.dispose()); return { ...dom, ...c, view }; }
function task(phase, overrides = {}) { return { command: { id: f.OID, kind: 'task', session_id: f.SID, body: { operation_id: f.OID, run_id: f.RID, text: ' exact\r\nTask 雪 ' } }, phase, receipt: null, reply: null, notices: [], error: null, reconciliation: null, ...overrides }; }

test('C display renderer preserves generic hash/origin rules with no raw runtime imports', () => {
  assert.deepEqual(parseSessionHash(sessionHash(f.SID)), { kind: 'session', session_id: f.SID });
  for (const hash of ['#token=synthetic', '#session=bad', '#session=ABCDEFAB-abcd-abcd-abcd-123456789abc', '#session=' + f.SID + '&x=1']) assert.equal(parseSessionHash(hash).kind, 'invalid');
  assert.equal(parseSessionHash('').kind, 'empty');
  for (const host of ['127.0.0.1', '127.255.255.255', '[::1]']) assert.equal(supportedOrigin('http:', host), true);
  for (const host of ['localhost', '127.00.0.1', '128.0.0.1', '[::2]']) assert.equal(supportedOrigin('http:', host), false);
  assert.equal(supportedOrigin('https:', 'remote.test'), true);
  const generated = readFileSync(new URL('../dist/display-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(generated, /from ['"]\.\/(client|state|view)\.js|innerHTML|result\.last_response|history\.complete/);
});

test('C exact inert ranges and prefix/interior/suffix gaps are distinct from recorded empty and absent content', t => {
  const store = loaded();
  const field = { ...store.blocks[0].entries[0].fields[0], total_bytes: '100', ranges: [
    { from_byte: '5', to_byte: '34', text: '<img src=https://evil.test>雪' },
    { from_byte: '40', to_byte: '45', text: '\u001b[31m' },
  ] };
  const e = { ...store.blocks[0].entries[0], fields: [field], content_complete: false, content_start_loaded: false };
  const s = state({ ...store, blocks: [{ ...store.blocks[0], entries: [e] }] });
  const h = setup(t, s);
  const pre = byClass(h.root, 'transcript').querySelectorAll('pre');
  assert.deepEqual(pre.slice(1).filter(p => p.textContent !== '').map(p => p.textContent), [field.ranges[0].text, field.ranges[1].text, pre.at(-1).textContent]);
  for (const interval of ['[0, 5)', '[34, 40)', '[45, 100)']) assert.ok(h.root.textContent.includes('Missing bytes ' + interval));
  assert.match(h.root.textContent, /Earlier field descriptors are not loaded/);
  assert.equal(h.root.querySelectorAll('img').length, 0);
  h.publish(state({ ...store, blocks: [{ ...store.blocks[0], entries: [{ ...e, fields: [{ ...field, total_bytes: '0', ranges: [] }] }] }] }));
  assert.match(h.root.textContent, /Recorded empty content/);
  h.publish(state({ ...store, blocks: [{ ...store.blocks[0], entries: [{ ...e, fields: [] }] }] }));
  assert.match(h.root.textContent, /No recorded content loaded/); assert.doesNotMatch(h.root.textContent, /Recorded empty content/);
});

test('C store chronology and supplied field order render one Human and no duplicated result', t => {
  const p = f.page({ entries: [f.entry(), f.entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '5', content_epoch: '5', kind: 'tool', fields: [], result_recorded: false, finish_recorded: true, is_error: null }),
    f.entry({ entry_id: 'e:6:0', position: { sequence: '6', slot: '0' }, revision: '6', content_epoch: '6', kind: 'reuse', fields: [], reference: { run_id: f.RID, entry_id: 'e:5:0' }, result_recorded: true, finish_recorded: true, is_error: false }),
    f.entry({ entry_id: 'e:7:0', position: { sequence: '7', slot: '0' }, revision: '7', content_epoch: '7', fields: [f.field({ generation: '7', kind: 'unsupported' })] })], snapshot_head: '7', session: f.session('7'), live_after: f.cursor('l', '7', '3', '', ''), block: f.block({ revision: '7', result_recorded: true }) });
  const h = setup(t, state(loaded(p))), transcript = byClass(h.root, 'transcript');
  assert.deepEqual(transcript.querySelectorAll('h4').map(n => n.textContent), ['Human','assistant','tool','reuse','assistant']);
  assert.equal(transcript.querySelectorAll('pre').filter(n => n.textContent === 'Task').length, 1);
  assert.match(transcript.textContent, /result_recorded: false; finish_recorded: true/);
  assert.match(transcript.textContent, /Recorded reuse reference:.*Not another execution/);
  assert.match(transcript.textContent, /Unsupported content/);
});

test('C keyed rows keep disclosure focus and draft selection across revisions and backward merges', t => {
  const p = f.page({ entries: [f.entry({ fields: [f.field({ kind: 'reasoning_text' })] })] });
  const h = setup(t, state(loaded(p))), transcript = byClass(h.root, 'transcript');
  const disclosure = transcript.querySelectorAll('details')[0], pre = transcript.querySelectorAll('pre')[1], draft = control(h.root, 'Task');
  disclosure.open = true; draft.focus(); draft.selectionStart = 2; draft.selectionEnd = 5;
  const next = applyConversationChanges(loaded(p), f.batch([f.upsert(f.entry({ revision: '5', fields: [f.field({ kind: 'reasoning_text', text: 'abcdef', total_bytes: '6', to_byte: '6' })] }), f.block({ revision: '5' }))]));
  h.publish(state(next));
  assert.equal(transcript.querySelectorAll('details')[0], disclosure); assert.equal(disclosure.open, true); assert.equal(transcript.querySelectorAll('pre')[1], pre);
  assert.equal(h.document.activeElement, draft); assert.equal(draft.selectionStart, 2); assert.equal(draft.selectionEnd, 5); assert.equal(draft.value, ' exact\n draft ');
});

for (const phase of ['sending','uncertain','rejected','accepted','conflict','reconciling']) test(`C command ${phase} truth and explicit immutable controls outside transcript`, t => {
  const item = task(phase, { reconciliation: 'not_found', error: { category: 'http', status: 503, server: { code: 'storage.io', stage: 'acceptance', certainty: 'unknown', acceptance: null, notices: [] } } });
  const h = setup(t, state(loaded(), { pending: [item] }));
  assert.doesNotMatch(byClass(h.root, 'transcript').textContent, /exact\r\nTask/);
  assert.match(byClass(h.root, 'commands').textContent, /Point-in-time absence, not rollback proof/);
  const busy = ['sending','reconciling'].includes(phase);
  assert.equal(button(h.root, 'Retry identical command').hidden, busy || !['uncertain','rejected'].includes(phase));
  assert.equal(button(h.root, 'Reconcile receipt (read only)').hidden, busy || phase === 'conflict');
  assert.equal(button(h.root, 'Discard local command').hidden, busy);
  if (!busy) { button(h.root, 'Discard local command').dispatch('click'); assert.deepEqual(h.calls.at(-1), { name: 'discardCommand', args: [f.OID] }); }
});

test('C all retained explicit command/navigation controls forward exact text and no rendering POST', t => {
  const h = setup(t);
  control(h.root, 'Title').value = ' title\n '; control(h.root, 'Workspace').value = '/synthetic/project';
  button(h.root, 'Create session').parent.dispatch('submit');
  control(h.root, 'Exact new title').value = ' rename\n '; button(h.root, 'Rename session').parent.dispatch('submit');
  for (const name of ['Refresh list','Refresh selected catalog entry','Reconnect latest','Read run status','Cancel current run']) button(h.root, name).dispatch('click');
  assert.deepEqual(h.calls.slice(0,2), [{ name: 'createSession', args: [' title\n ', '/synthetic/project'] }, { name: 'renameSession', args: [' rename\n '] }]);
  assert.deepEqual(h.calls.slice(2).map(c => c.name), ['refreshSessions','refreshCatalog','reconnectLatest','readRun','cancelCurrentRun']);
  const count = h.calls.length; h.publish(state()); assert.equal(h.calls.length, count);
  const draft = control(h.root, 'Task');
  draft.value = ' exact\r\ntext '; draft.dispatch('input');
  assert.deepEqual(h.calls.at(-1), { name: 'setDraft', args: [' exact\r\ntext '] });
  draft.dispatch('keydown', { key: 'Enter' }); draft.dispatch('keydown', { key: 'Enter', ctrlKey: true, repeat: true }); draft.dispatch('keydown', { key: 'Enter', metaKey: true, isComposing: true });
  assert.equal(h.calls.filter(c => c.name === 'sendTask').length, 0);
  draft.dispatch('keydown', { key: 'Enter', metaKey: true }); assert.equal(h.calls.filter(c => c.name === 'sendTask').length, 1);
});

test('C initial fill measures rendered B then one unit; overflow/end/error stop and resize cannot restart', t => {
  const h = setup(t), transcript = byClass(h.root, 'transcript');
  assert.match(transcript.textContent, /Task/); assert.equal(h.calls.length, 0);
  h.flush(); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
  h.publish(state(loaded(), { selected: { ...state().selected, older_loading: true } })); h.flush();
  assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
  transcript.scrollHeight = 500; h.publish(state()); h.flush();
  transcript.scrollHeight = 100; transcript.dispatch('scroll'); h.publish(state()); h.flush();
  assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
  button(h.root, 'Load older').dispatch('click'); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 2);
});

for (const [name, height, expected] of [['short', 20, 1], ['equality', 100, 1], ['one-pixel overflow', 101, 0], ['larger overflow', 150, 0]]) test(`C initial fill boundary ${name} measures B before admitting older`, t => {
  const store = loaded(), h = setup(t, state(store)), transcript = byClass(h.root, 'transcript');
  assert.match(transcript.textContent, /Task/);
  assert.equal(store.blocks.length, 1); assert.equal(store.blocks[0].earlier_activity, null);
  assert.ok([store.blocks[0].human, ...store.blocks[0].entries].every(e => e.content_complete && e.content_start_loaded && e.earlier_content === null));
  assert.notEqual(store.previous_block, null);
  assert.equal(h.calls.length, 0);
  transcript.clientHeight = 100; transcript.scrollHeight = height;
  h.flush(); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, expected);
  if (expected === 0) {
    // A later short layout cannot restart initial fill after measured overflow.
    transcript.scrollHeight = 20; transcript.dispatch('scroll'); h.publish(state(store)); h.flush();
    assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 0);
  }
  assert.ok(h.calls.every(c => c.name === 'loadOlder'));
});

test('C failed older and changed content stop fill until explicit entry refresh', t => {
  const h = setup(t); h.flush();
  const s = state(); s.selected.content_operations = [{ run_id: f.RID, entry_id: 'e:4:0', state: 'changed', error: { category: 'http', status: 409, server: { code: 'api.conversation_cursor_stale', stage: null, certainty: 'not_applicable', acceptance: null, notices: [] } } }];
  h.publish(s); h.flush(); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
  assert.match(h.root.textContent, /Content changed. Refresh this entry explicitly/);
  h.root.find(n => n.tag === 'button' && n.textContent === 'Refresh this entry' && !n.hidden)[0].dispatch('click'); assert.deepEqual(h.calls.at(-1), { name: 'refreshEntry', args: [f.RID, 'e:4:0'] });
  h.publish(state()); h.flush(); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
});

test('C trusted upward 96 intent admits one unit; synthetic scroll/wheel and publications do not chain', t => {
  const h = setup(t), transcript = byClass(h.root, 'transcript'); transcript.scrollHeight = 500; h.flush(); transcript.scrollTop = 0;
  transcript.dispatch('wheel', { deltaY: -200 }); transcript.dispatch('scroll'); h.flush(); assert.equal(h.calls.length, 0);
  for (let i=0;i<3;i++) transcript.dispatch('keydown', { key: 'ArrowUp', isTrusted: true });
  h.flush(); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
  h.publish(state()); h.flush(); transcript.dispatch('scroll'); h.flush(); assert.equal(h.calls.filter(c => c.name === 'loadOlder').length, 1);
});

for (const boundary of ['selection','rebase','disconnect','dispose']) test(`C scheduled callbacks cannot cross ${boundary} ownership, including canceled callbacks`, t => {
  const h = setup(t), stale = [...h.all.values()][0];
  if (boundary === 'selection') h.publish(state(null, { selected: { ...state().selected, session_id: f.OTHER, store: null, observation: 'loading' } }));
  if (boundary === 'rebase') h.publish(state(loaded(), { selected: { ...state().selected, observation: 'loading' } }));
  if (boundary === 'disconnect') h.publish({ ...state(), connection: 'disconnected', settings: null, selected: null, pending: [], draft: '' });
  if (boundary === 'dispose') h.view.dispose();
  stale(0); h.flush(); assert.equal(h.calls.length, 0);
  if (boundary === 'dispose') { assert.equal(h.listeners.size, 0); button(h.root, 'Load older')?.dispatch('click'); assert.equal(h.root.children.length, 0); }
});

test('C failed rebase retains stale window and pending/draft; disconnect clears sensitive nodes and form values', t => {
  const h = setup(t), store = loaded(); h.publish(state(store, { pending: [task('uncertain')] }));
  h.publish(state(store, { pending: [task('uncertain')], selected: { ...state().selected, observation: 'disconnected', observation_error: { category: 'network' } } }));
  assert.match(byClass(h.root, 'transcript').textContent, /Task/); assert.match(h.root.textContent, /Retained window is stale/);
  assert.equal(control(h.root, 'Task').value, ' exact\n draft ');
  const token = control(h.root, 'Owner token'); token.value = 'synthetic-memory-only';
  h.publish({ ...state(), connection: 'disconnected', settings: null, selected: null, pending: [], draft: '', error: { category: 'authentication' } });
  for (const name of ['Owner token','Title','Exact new title','Task']) assert.equal(control(h.root, name).value, '');
  assert.equal(byClass(h.root, 'transcript').querySelectorAll('article').length, 0); assert.doesNotMatch(h.root.textContent, /synthetic-memory-only|exact\r\nTask|Execution: running/);
});

test('C backward merges keep keyed rows while simultaneous bottom growth does not count as prepend height', t => {
  const p = f.page({ snapshot_head: '14', session: f.session('14'), live_after: f.cursor('l', '14', '3', '', ''), previous_block: f.cursor('b', '10'),
    block: f.block({ accepted_sequence: '10', revision: '14', human: f.human({ entry_id: 'e:10:0', position: { sequence: '10', slot: '0' }, revision: '10', content_epoch: '10', fields: [f.field({ field_id: 'text', order_key: '0', generation: '10', text: 'Task', total_bytes: '4', to_byte: '4' })] }) }),
    entries: [f.entry({ entry_id: 'e:14:0', position: { sequence: '14', slot: '0' }, revision: '14', content_epoch: '14', fields: [f.field({ generation: '14' })] })] });
  const store = loaded(p), h = setup(t, state(store)), transcript = byClass(h.root, 'transcript');
  transcript.scrollHeight = 500; h.flush(); transcript.scrollTop = 200;
  transcript.getBoundingClientRect = () => ({ top: 100, bottom: 200, height: 100 });
  const pre = transcript.querySelectorAll('pre').find(n => n.textContent === 'abc');
  pre.getBoundingClientRect = () => { const top = 100 + 200 + (transcript.querySelectorAll('article').length-1)*150 - transcript.scrollTop; return { top, bottom: top+24, height: 24 }; };
  const older = f.page({ snapshot_head: '15', session: f.session('15'), live_after: null, previous_block: null, block: f.block({ run_id: f.OTHER, human: f.human({ run_id: f.OTHER }) }), entries: [] });
  const next = mergeConversationPage(store, validateConversationPage(older, { kind: 'before', cursor: p.previous_block }, f.SID), { kind: 'before', cursor: p.previous_block });
  const grown = applyConversationChanges(next, f.batch([f.upsert({ ...p.entries[0], revision: '15', fields: [f.field({ generation: '14', text: 'abcdef', to_byte: '6', total_bytes: '6' })] }, { ...p.block, revision: '15' })], '15'));
  h.publish(state(store, { selected: { ...state(store).selected, older_loading: true } }));
  transcript.scrollHeight = 1000; h.publish(state(grown));
  assert.equal(transcript.querySelectorAll('pre').find(n => n.textContent === 'abcdef'), pre);
  assert.equal(transcript.scrollTop, 350); assert.equal(pre.getBoundingClientRect().top, 100);
});

test('C selected canonical metadata prefers the newer store head without moving messages', t => {
  const h = setup(t), store = loaded(); const run = byClass(h.root, 'transcript').querySelectorAll('article')[0];
  const newer = { ...store, session: { ...store.session, title: 'new live title', head_sequence: '6' } };
  h.publish(state(newer, { selected: { ...state(newer).selected, manifest: { ...store.session, title: 'older read title', head_sequence: '5' } } }));
  assert.equal(h.root.find(n => n.attributes['aria-label'] === 'Canonical session title')[0].textContent, 'new live title');
  assert.equal(byClass(h.root, 'transcript').querySelectorAll('article')[0], run);
});

test('C safe diagnostics ignore arbitrary error properties and receipts preserve decimal strings', () => {
  for (const category of ['network','protocol','authentication','conflict']) assert.ok(!errorText({ category, detail: 'invalid_schema', message: 'untrusted-secret' }).includes('untrusted-secret'));
  assert.equal(hasOlder(loaded(f.page({ block: null, entries: [], previous_block: null }))), false);
});

const catalogEntry = (title = 'Synthetic private catalog title', sid = f.SID) => ({ session_id: sid, title, workspace: '/synthetic/project', created_at_ms: '1', updated_at_ms: '2', observed_head_sequence: '4', view: 'catalog', availability: 'ready', fault_code: null, last_run_id: null, last_run_state: null });
const registrations = node => [...node.listeners.values()].reduce((n, callbacks) => n + callbacks.size, 0);
function retirement(row) {
  const held = row.find(() => true), atDetach = [], remove = row.remove.bind(row);
  // Observe this row only. Assertions stay outside controller publications.
  row.remove = () => { atDetach.push(held.map(n => ({ text: n.textContent, value: n.value, registrations: registrations(n) }))); remove(); };
  return { held, atDetach };
}
function retired(probe) {
  assert.equal(probe.atDetach.length, 1);
  for (const n of probe.held) { assert.equal(n.textContent, ''); assert.equal(n.value, ''); assert.equal(registrations(n), 0); }
  for (const snapshot of probe.atDetach) for (const n of snapshot) assert.deepEqual(n, { text: '', value: '', registrations: 0 });
}

for (const boundary of ['Disconnect', 'controller 401']) test(`C nonempty catalog actual ${boundary} retires detached controls before detach`, async t => {
  const dom = model(t), requests = [], navigations = []; let unauthorized = false;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const client = createDisplayClient({ fetch: async (path, init) => {
    requests.push({ path, method: init.method });
    if (path === '/v1/settings') return reply({ api_version: 1, ...state().settings, enable_add_numbers: false });
    if (path.startsWith('/v1/sessions?')) return reply({ api_version: 1, entries: [catalogEntry()], has_more: false, next_after_id: f.SID });
    if (path.endsWith('/conversation')) return unauthorized ? reply({ api_version: 1, code: 'api.unauthorized', stage: null, certainty: 'not_applicable', acceptance: null, notices: [] }, 401) : reply(f.page({ previous_block: null }));
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream({}), { headers: { 'Content-Type': 'text/event-stream' } });
    throw Error('Unexpected synthetic ownership request');
  } });
  const view = mountDisplayView(dom.root, client, sid => navigations.push(sid), true, dom.layout);
  t.after(() => { view.dispose(); client.disconnect(); });
  const staticCount = view.listenerCount;
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID);
  const choose = button(dom.root, catalogEntry().title), catalogProbe = retirement(choose.parent);
  const block = byClass(dom.root, 'transcript').querySelectorAll('article')[0], blockProbe = retirement(block);
  const refresh = block.find(n => n.tag === 'button' && n.textContent === 'Refresh this entry')[0];
  assert.equal(choose.textContent, catalogEntry().title); assert.equal(registrations(choose), 1);
  if (boundary === 'Disconnect') button(dom.root, 'Disconnect').dispatch('click');
  else { unauthorized = true; await client.selectSession(f.SID); }
  assert.equal(client.snapshot().connection, 'disconnected'); assert.equal(client.snapshot().catalog, null); assert.equal(client.snapshot().selected, null);
  if (boundary === 'controller 401') assert.equal(client.snapshot().error.category, 'authentication');
  assert.equal(dom.root.contains(choose), false); retired(catalogProbe); retired(blockProbe);
  const count = requests.length; choose.dispatch('click'); refresh.dispatch('click');
  assert.deepEqual(navigations, []); assert.equal(requests.length, count); assert.equal(view.listenerCount, staticCount);
  for (const name of ['Owner token', 'Title', 'Exact new title', 'Task']) assert.equal(control(dom.root, name).value, '');
  assert.ok(requests.every(r => r.method !== 'POST'));
});

test('C nine catalog replacements release registrations while retained identity focus disclosure and drafts survive', t => {
  const p = f.page({ entries: [f.entry({ fields: [f.field({ kind: 'reasoning_text' })] })] }), store = loaded(p);
  const h = setup(t, state(store)), baseline = h.view.listenerCount, removed = [];
  const retained = catalogEntry('Retained synthetic title', f.OTHER);
  h.publish(state(store, { catalog: { entries: [retained], has_more: false } }));
  const choose = button(h.root, retained.title), disclosure = byClass(h.root, 'transcript').querySelectorAll('details')[0], draft = control(h.root, 'Task');
  disclosure.open = true; draft.focus(); draft.selectionStart = 2; draft.selectionEnd = 5;
  for (let i = 0; i < 9; i++) {
    const entry = catalogEntry(`Removed synthetic title ${i}`);
    h.publish(state(store, { catalog: { entries: [entry, retained], has_more: false } }));
    const node = button(h.root, entry.title); removed.push({ node, probe: retirement(node.parent) });
    h.publish(state(store, { catalog: { entries: [retained], has_more: false } }));
  }
  assert.equal(new Set(removed.map(r => r.node)).size, 9);
  assert.equal(removed.reduce((n, r) => n + registrations(r.node), 0), 0);
  for (const r of removed) retired(r.probe);
  assert.equal(h.view.listenerCount, baseline + 1);
  assert.equal(button(h.root, retained.title), choose); assert.equal(registrations(choose), 1);
  assert.equal(byClass(h.root, 'transcript').querySelectorAll('details')[0], disclosure); assert.equal(disclosure.open, true);
  assert.equal(h.document.activeElement, draft); assert.deepEqual([draft.selectionStart, draft.selectionEnd, draft.value], [2, 5, ' exact\n draft ']);
  const count = h.calls.length; for (const r of removed) r.node.dispatch('click'); assert.equal(h.calls.length, count);
  h.view.dispose(); h.view.dispose(); assert.equal(h.view.listenerCount, 0); assert.equal(registrations(choose), 0);
});

test('C removed command owns all controls and captured text without resetting a retained command', t => {
  const kept = task('uncertain', { command: { ...task('uncertain').command, id: f.OTHER } });
  const h = setup(t, state(loaded(), { pending: [task('uncertain'), kept] })), rows = byClass(h.root, 'commands').querySelectorAll('article');
  const probe = retirement(rows[0]), buttons = rows[0].find(n => n.tag === 'button'), disclosure = rows[1].querySelectorAll('details')[0], baseline = h.view.listenerCount;
  disclosure.open = true; assert.match(rows[0].textContent, /exact\r\nTask/);
  h.publish(state(loaded(), { pending: [kept] })); retired(probe);
  assert.equal(byClass(h.root, 'commands').querySelectorAll('article')[0], rows[1]); assert.equal(disclosure.open, true);
  assert.equal(h.view.listenerCount, baseline - 4);
  const count = h.calls.length; for (const b of buttons) b.dispatch('click'); assert.equal(h.calls.length, count);
});

for (const scope of ['range', 'field', 'entry', 'human', 'block']) test(`C nested ${scope} removal scrubs held descendants and retires only removed ownership`, t => {
  const store = loaded(), h = setup(t, state(store)), block = store.blocks[0], transcript = byClass(h.root, 'transcript');
  const entry = transcript.find(n => n.dataset.entry === (scope === 'human' ? block.human.view.entry_id : block.entries[0].view.entry_id))[0];
  let row = entry, next = block, lost = 0;
  if (scope === 'range') { row = entry.querySelectorAll('pre').find(n => n.textContent === 'abc'); next = { ...block, entries: [{ ...block.entries[0], fields: [{ ...block.entries[0].fields[0], ranges: [] }] }] }; }
  if (scope === 'field') { row = entry.find(n => n.dataset.field === f.FID)[0]; next = { ...block, entries: [{ ...block.entries[0], fields: [] }] }; }
  if (scope === 'entry') { next = { ...block, entries: [] }; lost = 1; }
  if (scope === 'human') { next = { ...block, human: { ...block.human, view: { ...block.human.view, entry_id: 'e:2:1' }, fields: [] } }; }
  if (scope === 'block') { row = transcript.querySelectorAll('article')[0]; lost = 3; }
  const probe = retirement(row), refresh = row.find(n => n.tag === 'button' && n.textContent === 'Refresh this entry'), baseline = h.view.listenerCount;
  h.publish(state({ ...store, blocks: scope === 'block' ? [] : [next] })); retired(probe);
  assert.equal(h.view.listenerCount, baseline - lost);
  const count = h.calls.length; for (const b of refresh) b.dispatch('click'); assert.equal(h.calls.length, count);
  if (scope !== 'block') assert.equal(transcript.querySelectorAll('article')[0].dataset.run, block.view.run_id);
});

test('C ordinary idempotent dispose releases all listener closures and empties held controls', t => {
  const h = setup(t, state(loaded(), { catalog: { entries: [catalogEntry()], has_more: false }, pending: [task('uncertain')] }));
  const held = h.root.find(() => true), actions = held.filter(n => n.tag === 'button'), scheduled = [...h.all.values()];
  control(h.root, 'Title').value = 'synthetic private title'; control(h.root, 'Owner token').value = 'synthetic unsent value';
  h.view.dispose(); h.view.dispose();
  for (const n of held) { assert.equal(n.textContent, ''); assert.equal(n.value, ''); assert.equal(registrations(n), 0); }
  assert.equal(h.view.listenerCount, 0); assert.equal(h.listeners.size, 0); assert.equal(h.queued.size, 0);
  for (const cb of scheduled) cb(0); for (const b of actions) b.dispatch('click');
  assert.deepEqual(h.calls, []); assert.equal(h.root.children.length, 0);
});

function workspaceRetirement(select) {
  const options = [...select.options], atDetach = [];
  // Local bookkeeping models held text and reflected values; Chromium proves native semantics.
  const held = options.map(option => {
    const child = { nodeType: 3, textContent: option.textContent, nextSibling: null };
    option.attributes.value = option.value;
    Object.defineProperties(option, {
      firstChild: { get: () => child },
      value: { get: () => option.attributes.value, set: value => { option.attributes.value = value; } },
      label: { get: () => option.textContent },
    });
    const values = () => ({ text: option.textContent, value: option.value, attribute: option.attributes.value, label: option.label, child: child.textContent });
    const remove = option.remove.bind(option);
    option.remove = () => { atDetach.push(values()); remove(); };
    return { option, child, values };
  });
  return { held, atDetach };
}
function workspaceRetired(probe) {
  const blank = { text: '', value: '', attribute: '', label: '', child: '' };
  assert.equal(probe.atDetach.length, probe.held.length);
  for (const value of probe.atDetach) assert.deepEqual(value, blank);
  for (const h of probe.held) { assert.equal(h.option.parent, null); assert.deepEqual(h.values(), blank); assert.equal(registrations(h.option), 0); }
}

for (const boundary of ['Disconnect', 'controller 401']) test(`C workspace actual ${boundary} scrubs held options before detach and reconnect dispose`, async t => {
  const dom = model(t), requests = [], navigations = [], paths = ['/synthetic/private-workspace', '/synthetic/other-workspace'];
  let unauthorized = false;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const client = createDisplayClient({ fetch: async (path, init) => {
    requests.push({ path, method: init.method });
    if (path === '/v1/settings') return reply({ api_version: 1, ...state().settings, workspaces: paths, enable_add_numbers: false });
    if (path.startsWith('/v1/sessions?')) return unauthorized ? reply({}, 401) : reply({ api_version: 1, entries: [], has_more: false, next_after_id: null });
    if (path.endsWith('/conversation')) return reply(f.page({ previous_block: null }));
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream({}), { headers: { 'Content-Type': 'text/event-stream' } });
    throw Error('Unexpected synthetic workspace request');
  } });
  const view = mountDisplayView(dom.root, client, sid => navigations.push(sid), true, dom.layout), staticCount = view.listenerCount;
  t.after(() => { view.dispose(); client.disconnect(); });
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID);
  const select = control(dom.root, 'Workspace'), retiredOptions = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(control(dom.root, 'Workspace'), select);
    assert.deepEqual(select.options.map(o => [o.textContent, o.value]), paths.map(p => [p, p]));
    const probe = workspaceRetirement(select); retiredOptions.push(probe);
    assert.deepEqual(probe.held.map(h => h.values().child), paths);
    if (boundary === 'Disconnect') button(dom.root, 'Disconnect').dispatch('click');
    else { unauthorized = true; await client.refreshSessions(); }
    assert.equal(client.snapshot().connection, 'disconnected');
    if (boundary === 'controller 401') assert.equal(client.snapshot().error.category, 'authentication');
    workspaceRetired(probe); assert.equal(select.options.length, 0); assert.equal(select.value, '');
    for (const name of ['Owner token', 'Title', 'Exact new title', 'Task']) assert.equal(control(dom.root, name).value, '');
    assert.equal(view.listenerCount, staticCount);
    unauthorized = false; await client.connect('0123456789abcdef'.repeat(4));
    assert.equal(select.options.some(o => probe.held.some(h => h.option === o)), false);
    select.value = paths[1]; assert.equal(select.value, paths[1]);
  }
  const direct = workspaceRetirement(select); view.dispose(); view.dispose(); workspaceRetired(direct);
  for (const p of retiredOptions) workspaceRetired(p);
  const count = requests.length;
  for (const p of [...retiredOptions, direct]) for (const h of p.held) { h.option.dispatch('click'); h.option.dispatch('change'); }
  dom.flush(); assert.equal(requests.length, count); assert.deepEqual(navigations, []); assert.equal(view.listenerCount, 0);
  assert.ok(requests.every(r => r.method !== 'POST' && !/\/history(?:\?|$)/.test(r.path) && !r.path.includes('?before=') && !r.path.includes('?within=')));
});

test('C changed workspace lists retire only old options while copied lists preserve controls focus selection and draft', t => {
  const store = loaded(f.page({ previous_block: null })), paths = ['/synthetic/private-workspace', '/synthetic/other-workspace'];
  const settings = { ...state().settings, workspaces: paths }, h = setup(t, state(store, { settings }));
  const select = control(h.root, 'Workspace'), draft = control(h.root, 'Task'), baseline = h.view.listenerCount, retiredOptions = [];
  for (let i = 0; i < 3; i++) {
    const probe = workspaceRetirement(select); retiredOptions.push(probe);
    const current = select.options.map(o => o.value);
    select.value = current[1]; select.focus();
    h.publish(state(store, { settings: { ...settings, workspaces: [...current] } }));
    assert.equal(h.document.activeElement, select); assert.equal(select.value, current[1]);
    assert.deepEqual(select.options, probe.held.map(h => h.option)); assert.deepEqual(probe.atDetach, []);
    assert.deepEqual(probe.held.map(h => h.child.textContent), current);
    draft.focus(); draft.selectionStart = 2; draft.selectionEnd = 5;
    h.publish(state(store, { settings: { ...settings, workspaces: [...current] } }));
    const next = paths.map(p => `${p}-${i}`);
    h.publish(state(store, { settings: { ...settings, workspaces: next } }));
    workspaceRetired(probe); assert.equal(control(h.root, 'Workspace'), select);
    assert.deepEqual(select.options.map(o => [o.textContent, o.value]), next.map(p => [p, p]));
    select.value = next[1]; assert.equal(select.value, next[1]);
    assert.equal(h.document.activeElement, draft); assert.deepEqual([draft.value, draft.selectionStart, draft.selectionEnd], [' exact\n draft ', 2, 5]);
    assert.equal(h.view.listenerCount, baseline);
  }
  const direct = workspaceRetirement(select); h.view.dispose(); h.view.dispose(); workspaceRetired(direct);
  for (const p of retiredOptions) workspaceRetired(p);
  for (const p of [...retiredOptions, direct]) for (const n of p.held) { n.option.dispatch('click'); n.option.dispatch('change'); }
  h.flush(); assert.deepEqual(h.calls, []); assert.equal(h.listeners.size, 0); assert.equal(h.view.listenerCount, 0);
});

function trackPosition(row, target) {
  const container = row.parent, insert = container.insertBefore.bind(container), moves = [];
  // Instance-local bookkeeping detects relocation, not native browser focus behavior.
  container.insertBefore = (node, next) => { moves.push({ protected: node.contains(target) }); insert(node, next); };
  return moves;
}
const focusField = (id, index, kind = 'text') => f.field({ field_id: id, order_key: f.order(2, BigInt(index)), kind });

test('C actual controller epoch retirement precedes positioning without relocating retained active field', async t => {
  const dom = model(t), requests = []; let sender;
  const a = focusField(f.FID, 0), b = focusField(f.SECOND, 1, 'reasoning_summary');
  const client = createDisplayClient({ fetch: async (path, init) => {
    requests.push({ path, method: init.method });
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/v1/settings') return reply({ api_version: 1, ...state().settings, enable_add_numbers: false });
    if (path.startsWith('/v1/sessions?')) return reply({ api_version: 1, entries: [], has_more: false, next_after_id: null });
    if (path.endsWith('/conversation')) return reply(f.page({ entries: [f.entry({ fields: [a,b] })], previous_block: null }));
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream({ start(c) { sender = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    throw Error('Unexpected focus control request');
  } });
  const view = mountDisplayView(dom.root, client, () => {}, true, dom.layout);
  t.after(() => { client.disconnect(); view.dispose(); });
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID);
  const rows = dom.root.find(n => n.dataset.field === f.FID || n.dataset.field === f.SECOND);
  const retained = rows[1], summary = retained.firstElementChild, probe = retirement(rows[0]), moves = trackPosition(retained, summary);
  retained.open = true; summary.focus();
  const batch = f.batch([f.upsert(f.entry({ revision: '5', content_epoch: '5', fields: [b] }))]);
  sender.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${batch.next_after}\ndata: ${JSON.stringify(batch)}\n\n`));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.snapshot().selected.store.observed_head, '5'); retired(probe);
  assert.equal(retained.parent.children.length, 1); assert.equal(retained.parent.children[0] === retained, true); assert.equal(moves.length, 0);
  assert.equal(dom.document.activeElement, summary); assert.equal(retained.open, true);
  assert.ok(requests.every(r => r.method === 'GET')); assert.equal(dom.queued.size, 1);
});

for (const scope of ['field', 'entry', 'block']) test(`C ${scope} supplied permutations keep the active owning row stationary and exact order`, t => {
  const store = loaded(f.page({ previous_block: null })), b = store.blocks[0], e = b.entries[0];
  const ids = ['a','b','c','d','e'].map(c => c.repeat(64));
  let rows;
  if (scope === 'field') rows = ids.map((id, i) => ({ ...e.fields[0], field_id: id, kind: 'reasoning_summary', order_key: f.order(2, BigInt(i)) }));
  if (scope === 'entry') rows = ids.map((_, i) => ({ ...e, view: { ...e.view, entry_id: `e:${i+4}:0` } }));
  if (scope === 'block') rows = ids.map((_, i) => ({ ...b, view: { ...b.view, run_id: `00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}` } }));
  const arrange = ordered => {
    if (scope === 'block') return { ...store, blocks: ordered };
    let entry = e;
    if (scope === 'field') entry = { ...e, fields: ordered };
    return { ...store, blocks: [{ ...b, entries: scope === 'entry' ? ordered : [entry] }] };
  };
  const h = setup(t, state(arrange(rows))), transcript = byClass(h.root, 'transcript');
  let node;
  if (scope === 'field') node = transcript.find(n => n.dataset.field === ids[2])[0];
  if (scope === 'entry') node = transcript.find(n => n.dataset.entry === 'e:6:0')[0];
  if (scope === 'block') node = transcript.querySelectorAll('article')[2];
  const target = scope === 'field' ? node.firstElementChild : node;
  target.focus(); const moves = trackPosition(node, target);
  const permutations = [[4,3,2,1,0],[2,4,0,3,1],[0,4,1,3,2],[4,2,3,0,1],[0,1,2,3,4]];
  const original = new Map(rows.map((row, i) => [row, scope === 'field' ? transcript.find(n => n.dataset.field === ids[i])[0] : scope === 'entry' ? transcript.find(n => n.dataset.entry === `e:${i+4}:0`)[0] : transcript.querySelectorAll('article')[i]]));
  for (const order of permutations) {
    const desired = order.map(i => rows[i]); h.publish(state(arrange(desired)));
    const actual = node.parent.children;
    assert.equal(actual.length, desired.length); assert.equal(actual.every((n,i) => n === original.get(desired[i])), true);
    assert.equal(moves.some(m => m.protected), false); assert.equal(h.root.contains(node), true);
  }
  const count = moves.length; h.publish(state(arrange(rows))); assert.equal(moves.length, count);
  assert.equal(h.document.activeElement, target); assert.deepEqual(h.calls, []);
});

test('C ordered range retirement additions and unchanged publication do not relocate retained active PRE', t => {
  const store = loaded(f.page({ previous_block: null })), b = store.blocks[0], e = b.entries[0];
  const ranges = [0,1,2,3,4].map(i => ({ from_byte: String(i*6),to_byte: String(i*6+3),text: 'abc' }));
  const arrange = ranges => ({ ...store,blocks: [{ ...b,entries: [{ ...e,fields: [{ ...e.fields[0],total_bytes: '27',ranges }] }] }] });
  const h = setup(t,state(arrange(ranges))), pre = h.root.find(n => n.dataset.range === 'text:12')[0];
  pre.focus(); const moves = trackPosition(pre,pre);
  for (const indices of [[2,3,4],[2,4],[0,1,2,3,4],[0,1,2,3,4]]) {
    h.publish(state(arrange(indices.map(i => ranges[i]))));
    assert.deepEqual(pre.parent.children.filter(n => n.tag === 'pre').map(n => n.dataset.range),indices.map(i => `text:${i*6}`));
    assert.equal(moves.some(m => m.protected),false); assert.equal(h.root.contains(pre),true);
  }
  assert.deepEqual(h.calls,[]);
});

for (const scope of ['catalog', 'command']) test(`C ${scope} predecessor retirement leaves focused retained control stationary and retired controls inert`, t => {
  const kept = task('uncertain', { command: { ...task('uncertain').command, id: f.OTHER } });
  const first = scope === 'catalog' ? { catalog: { entries: [catalogEntry(),catalogEntry('Retained', f.OTHER)], has_more: false } } : { pending: [task('uncertain'),kept] };
  const h = setup(t, state(loaded(f.page({ previous_block: null })), first));
  const list = byClass(h.root, scope === 'catalog' ? 'session-list' : 'commands');
  const rows = list.querySelectorAll(scope === 'catalog' ? 'li' : 'article'), retained = rows[1], target = retained.querySelectorAll('button')[0];
  const probe = retirement(rows[0]), moves = trackPosition(retained, target), heldButtons = rows[0].querySelectorAll('button');
  target.focus();
  h.publish(state(loaded(f.page({ previous_block: null })), scope === 'catalog' ? { catalog: { entries: [catalogEntry('Retained',f.OTHER)], has_more: false } } : { pending: [kept] }));
  retired(probe); assert.equal(moves.length, 0); assert.equal(retained.parent.children.length, 1); assert.equal(retained.parent.children[0] === retained, true);
  assert.equal(h.document.activeElement, target);
  for (const b of heldButtons) b.dispatch('click'); assert.deepEqual(h.calls, []);
});
