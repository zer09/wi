import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { appendMeasurementAnnotation, annotationType, livePhases, cleanupSteps } from '../test-support/browser-case-diagnostics.mjs';
import { allocationProgress, outerProof, allocateParent, allocationProof, resolveAllocation, removeAllocation, prepareInvocation, browserProgram, browserProof, phaseDrive, liveCollector, diagnostics, newFaults, resolveBinding, reserveOutput, modesProof, sourceGuard } from '../test-support/live-commit-measurements.mjs';
import { texts, digest, workKeys, protocol, savedProof, telemetryProof, terminalProof, removeRoot, createRoot, rootProof, nativeFailureProof, nativeCleanupProof } from '../test-support/live-commit-native.mjs';
import { resources, acquireResource } from '../test-support/display-measurements.mjs';
import { files } from '../test-support/interrupted-display-parity.mjs';
import { replaceLatest } from '../dist/display-store.js';
import { mountDisplayView } from '../dist/display-view.js';
import { model, controller } from '../test-support/display-dom.mjs';
import { expectedPage } from '../test-support/upgrade-display-parity.mjs';

const sid = '54000000-0000-4000-8000-000000000001', rid = '54000000-0000-4000-8000-000000000002';
const origin = 'http://127.0.0.1:54321', owner = 'synthetic-owner', clone = v => structuredClone(v);
const readers = { opened: 2, closed: 2, active: 0 };
const connections = (closed = false, r = readers) => ({ readers: clone(r),
  keeper: { acquired: true, initialized: true, opened: 1, closed: Number(closed), active: Number(!closed), error: null },
  totals: r === null ? null : { opened: r.opened + 1, closed: r.closed + Number(closed), active: r.active + Number(!closed) } });
const keeperError = () => ({ first: { stage: 'keeper_action', driver: 'panic', sqlite_primary: null, sqlite_extended: null, attempt: null, elapsed_ms: null }, close: null });
const readerError = () => ({ first: { stage: 'settle_results', driver: 'sqlite_busy', sqlite_primary: 5, sqlite_extended: 517, attempt: 4, elapsed_ms: 19 },
  close: { stage: 'close', driver: 'io', sqlite_primary: null, sqlite_extended: null, attempt: 4, elapsed_ms: 20 } });
const work = stage => Object.fromEntries(workKeys.map(k => [k, stage > 0 && !['completed', 'tool_validations', 'tool_executions'].includes(k) || stage === 2 && k === 'completed' ? 1 : 0]));
function saved(kind) {
  const terminal = kind === 'terminal', text = texts[['authority', 'terminal'].includes(kind) ? 'final' : kind];
  return { session_id: sid, run_id: rid, entry_id: 'e:5:0', field_id: digest('field'), head: { first: 6, append: 7, authority: 8, terminal: 12 }[kind],
    projection_head: { first: 6, append: 7, authority: 8, terminal: 12 }[kind], generation: ['authority', 'terminal'].includes(kind) ? 8 : 5, content_epoch: 5,
    bytes: Buffer.byteLength(text), sha256: digest(text), matches: true, provisional: !terminal, entry_state: terminal ? 'completed' : 'in_progress',
    run_state: terminal ? 'completed' : 'running', result_recorded: terminal, response_finished: terminal, run_finished: terminal, events_complete: terminal ? true : null };
}
function telemetry() {
  const totals = Array.from({ length: 30 }, (_, s) => [1, s, 0, 0, 0, 0]);
  totals[20] = [1, 20, 1, 2, 2, 0]; totals[21] = [1, 21, 3, 6, 6, 0]; totals[22] = [1, 22, 1, 2, 2, 0];
  const rows = [[0, 100, 120, 20, 0, 0, 0, 0, 2], ...totals, [4, 0, 0, 0, 0], [3, 42, 1, 2], [3, 43, 2, 0],
    ...[20, 21, 21, 21, 22].map((s, i) => [2, s, 42, 0, 2, i * 3, i * 3 + 2, 0, 0]), [2, 9, 43, 0, 0, 0, 20, 1, 1]];
  return Array.from({ length: Math.ceil(rows.length / 24) }, (_, page) => ({ page, pages: Math.ceil(rows.length / 24), rows: rows.slice(page * 24, (page + 1) * 24) }));
}
function pageFor(kind) {
  const s = saved(kind), page = expectedPage(1), terminal = kind === 'terminal';
  const field = (id, text, generation) => ({ field_id: id, order_key: id === 'text' ? '0' : '0:0000000000000001:0:0:0000000000000002', kind: 'text', generation: String(generation),
    total_bytes: String(Buffer.byteLength(text)), from_byte: '0', to_byte: String(Buffer.byteLength(text)), text, has_earlier: false, has_later: false });
  const entry = (id, sequence, human) => ({ run_id: rid, entry_id: id, position: { sequence: String(sequence), slot: '0' }, revision: String(s.head), content_epoch: String(sequence),
    kind: human ? 'human' : 'assistant', recorded_state: human ? 'accepted' : s.entry_state, provisional: human ? false : s.provisional,
    reference: null, result_recorded: null, finish_recorded: null, is_error: null,
    fields: [field(human ? 'text' : s.field_id, human ? texts.task : texts[['authority', 'terminal'].includes(kind) ? 'final' : kind], human ? 2 : s.generation)],
    earlier_content: null, content_complete: true });
  Object.assign(page, { session_id: sid, snapshot_head: String(s.head), previous_block: null, earlier_activity: null,
    live_after: `g11l.${Buffer.from(JSON.stringify([1, sid, String(s.head), '3', '', ''])).toString('base64url')}` });
  Object.assign(page.session, { session_id: sid, head_sequence: String(s.head), title: 'Live measurement' });
  page.block = { run_id: rid, accepted_sequence: '2', revision: String(s.head), state: s.run_state, result_recorded: terminal,
    outcome: terminal ? { type: 'completed' } : null, events_complete: terminal ? true : null, sink_error: null,
    summary: terminal ? { turns_started: '1', turns_finished: '1', model_requests_attempted: '1', model_requests_admitted: '1', new_tool_dispatches: '0',
      tool_results_prepared: '0', reused_results: '0', last_request_id: '54000000-0000-4000-8000-000000000003', last_upstream_outcome: 'terminal_received' } : null,
    human: entry('e:2:0', 2, true) };
  page.entries = [entry(s.entry_id, 5, false)]; return page;
}
function adapt(root) {
  for (const n of root.find(() => true)) {
    n.tagName = n.tag.toUpperCase();
    n.querySelectorAll = selector => {
      if (selector === ':scope > .metadata') return n.children.filter(c => c.className.split(' ').includes('metadata'));
      if (selector === ':scope > details > pre') return n.children.filter(c => c.tag === 'details').flatMap(c => c.children.filter(p => p.tag === 'pre'));
      const selectors = selector.split(',').map(s => s.trim());
      return n.children.flatMap(c => c.find(v => selectors.some(s => s === '[data-field]' ? v.dataset.field !== undefined : s === '[data-range]' ? v.dataset.range !== undefined
        : s === '[aria-label="Canonical conversation"]' ? v.attributes['aria-label'] === 'Canonical conversation'
        : s.startsWith('.') ? v.className.split(' ').includes(s.slice(1)) : v.tag === s)));
    };
    n.querySelector = selector => n.querySelectorAll(selector)[0] ?? null;
  }
  return root;
}
function rendered(t, options = {}) {
  const d = model(t); let store, callback, clock = 100;
  const state = () => ({ connection: 'connected', settings: { workspaces: [], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket' },
    catalog: { entries: [], has_more: false }, catalog_loading: false, error: null, draft: '', pending: [],
    selected: { session_id: sid, store, manifest: null, observation: 'streaming', observation_error: null, closed_reason: null, older_loading: false,
      older_error: null, content_operations: [], run_view: null, cancel: null, cancelling: false } });
  store = replaceLatest(pageFor('first'), sid);
  const c = controller(state()), view = mountDisplayView(d.root, c.client, () => {}, true, d.layout); t.after(() => view.dispose());
  // Default controls settle digests in microtasks, not a CPU-loaded worker pool.
  // Held/reordered controls below still exercise asynchronous WebCrypto settlement explicitly.
  const crypto = options.crypto ?? { subtle: { digest: async (algorithm, bytes) => {
    assert.equal(algorithm, 'SHA-256'); return Buffer.from(digest(bytes), 'hex');
  } } };
  const env = { TextEncoder, crypto, performance: { now: () => ++clock },
    document: { querySelector: selector => adapt(d.root).querySelector(selector) },
    MutationObserver: class { constructor(fn) { callback = fn; } observe(node, opts) { assert.equal(node.attributes['aria-label'], 'Canonical conversation'); assert.equal(opts.subtree, true); } disconnect() {} } };
  return { env, root: d.root, fire() { adapt(d.root); callback?.([]); }, show(kind, mutate, mutateDom) {
    const page = pageFor(kind); mutate?.(page); store = replaceLatest(page, sid); c.publish(state()); adapt(d.root); mutateDom?.(d.root); callback?.([]);
  }, async read() { return browserProgram({ action: 'read', first: saved('first'), texts }, env); },
  arm() { return browserProgram({ action: 'arm', first: saved('first'), texts }, env); },
  poll(kind) { return browserProgram({ action: 'poll', kind }, env); }, finish() { return browserProgram({ action: 'finish' }, env); } };
}
async function eventually(fn) { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise(setImmediate); } assert.fail('finite control settlement missing'); }

test('C54B actual built store and renderer feed exact first append authority and complete terminal predicates', async t => {
  const h = rendered(t); browserProof(await h.read(), saved('first'), 'first'); const arm = await h.arm();
  for (const kind of ['append', 'authority', 'terminal']) { h.show(kind); const value = await eventually(() => h.poll(kind)); browserProof(value, saved(kind), kind, saved({ append: 'first', authority: 'append', terminal: 'authority' }[kind])); }
  const result = await h.finish(); assert.equal(result.append_absent_at_arm, true); assert.equal(result.pending, 0);
  assert.ok(result.append.callback_ms >= arm.armed_ms); assert.ok(result.terminal.callback_ms > result.authority.callback_ms);
  assert.equal(result.append.generation, '5'); assert.equal(result.authority.generation, '8'); assert.equal(result.terminal.generation, '8');
  assert.ok(!JSON.stringify(result).includes(texts.first)); assert.ok(!JSON.stringify(result).includes(texts.final));
});
test('C54B real renderer rejects independent IDs text ranges generation state and partial terminal facts', async t => {
  const defects = [
    ['run', p => { p.block.run_id = sid; p.block.human.run_id = sid; p.entries[0].run_id = sid; }],
    ['entry', p => { p.entries[0].entry_id = 'e:4:0'; p.entries[0].position.sequence = '4'; }], ['field', p => p.entries[0].fields[0].field_id = digest('other')],
    ['generation', p => p.entries[0].fields[0].generation = '6'], ['text', p => { const f = p.entries[0].fields[0]; f.text = 'wrong'; f.to_byte = '5'; f.total_bytes = '5'; }],
    ['gap', p => { const e = p.entries[0], f = e.fields[0]; f.from_byte = '1'; f.to_byte = '14'; f.total_bytes = '14'; f.has_earlier = true; e.content_complete = false; }],
    ['partial', p => { const e = p.entries[0]; e.content_complete = false; e.earlier_content = `g11c.${Buffer.from(JSON.stringify([1, sid, rid, e.entry_id, e.content_epoch, e.fields[0].field_id, e.fields[0].generation, '0'])).toString('base64url')}`; }], ['entry state', p => p.entries[0].recorded_state = 'completed'],
    ['provisional', p => p.entries[0].provisional = false], ['result', p => p.block.result_recorded = true],
    ['status', p => p.block.state = 'completed'], ['human text', p => { const f = p.block.human.fields[0]; f.text = 'wrong'; f.to_byte = '5'; f.total_bytes = '5'; }],
  ];
  for (const [name, mutate] of defects) await t.test(name, async t => {
    const h = rendered(t); await h.arm(); h.show('append', mutate); await new Promise(setImmediate); assert.equal(await h.poll('append'), null);
  });
  for (const key of ['state', 'result_recorded', 'outcome', 'events_complete', 'sink_error', 'summary']) await t.test(`terminal ${key}`, async t => {
    const h = rendered(t); await h.arm(); h.show('append'); await eventually(() => h.poll('append')); h.show('authority'); await eventually(() => h.poll('authority'));
    h.show('terminal', p => { p.block[key] = key === 'state' ? 'running' : key === 'result_recorded' || key === 'events_complete' ? false : key === 'sink_error' ? 'failed' : null; });
    await new Promise(setImmediate); assert.equal(await h.poll('terminal'), null);
  });
});
test('C54B observer reserves first qualifying candidate before held reordered and rejected digests', async t => {
  for (const schedule of ['held', 'reordered', 'rejected']) await t.test(schedule, async t => {
    const holds = []; const h = rendered(t, { crypto: { subtle: { digest: (algorithm, bytes) => new Promise((resolve, reject) => holds.push({ resolve, reject, bytes, algorithm })) } } });
    await h.arm(); h.fire(); h.fire(); assert.equal(await h.poll('append'), null);
    h.show('append'); h.fire(); const firstCount = holds.length; assert.equal(firstCount, 1);
    h.show('authority'); h.show('terminal'); assert.equal(holds.length, 3); assert.equal(await h.poll('terminal'), null);
    const order = schedule === 'reordered' ? [2, 0, 1] : [0, 1, 2];
    for (const i of order) { if (schedule === 'rejected' && i === 0) holds[i].reject(new Error('unpublished digest')); else holds[i].resolve(await webcrypto.subtle.digest(holds[i].algorithm, holds[i].bytes)); }
    if (schedule === 'rejected') { await new Promise(setImmediate); await assert.rejects(h.finish()); await assert.rejects(h.poll('append')); }
    else { const result = await h.finish(); assert.ok(result.append.callback_ms < result.authority.callback_ms); assert.equal(result.callbacks, 6); }
  });
});
test('C54B observer copies all inputs synchronously and later status cannot fill a missing terminal candidate', async t => {
  const h = rendered(t); await h.arm(); h.show('append'); await eventually(() => h.poll('append')); h.show('authority'); await eventually(() => h.poll('authority'));
  h.show('terminal', p => p.block.events_complete = null); assert.equal(await h.poll('terminal'), null);
  h.show('terminal'); const terminal = await eventually(() => h.poll('terminal')); h.show('terminal', p => p.block.events_complete = false);
  assert.deepEqual(await h.poll('terminal'), terminal); const final = await h.finish(); assert.deepEqual(final.terminal, terminal);
});
test('C54B append and final must be absent at arm and final text without lifecycle facts is not terminal', async t => {
  for (const kind of ['append', 'authority', 'terminal']) await t.test(kind, async t => { const h = rendered(t); h.show(kind); await assert.rejects(h.arm()); });
});
const trap = () => assert.fail('original API body access forbidden');
function request(path, extra = {}) { return { url: () => origin + path, method: () => 'GET', headers: () => ({ authorization: `Bearer ${owner}` }),
  body: trap, json: trap, text: trap, arrayBuffer: trap, timing: trap, sizes: trap, ...extra }; }
function response(q, extra = {}) { return { url: q.url, request: () => q, status: () => q.method() === 'POST' ? 202 : 200,
  headers: () => ({ 'content-type': q.url().includes('/events') ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }),
  body: trap, json: trap, text: trap, arrayBuffer: trap, ...extra }; }
const live = `g11l.${Buffer.from(JSON.stringify([1, sid, '1', '3', '', ''])).toString('base64url')}`;
const base = `/v1/sessions/${sid}/conversation`;
function netCase() { const faults = newFaults(), d = diagnostics(() => c.network.facts()); const c = { faults, network: liveCollector({ origin, owner, session: sid, head: 1, faults, onReject: d.freeze, onRequestFailed: d.requestFailed }), d }; return c; }
function deliver(c, q, extra = {}) { c.network.request(q); const r = response(q, extra); c.network.response(r); if (!q.url().includes('/events')) c.network.finished(q); return q; }
async function handshake(c, assets = false) {
  for (const path of ['/v1/settings', '/v1/sessions?limit=32', base]) deliver(c, request(path));
  const sse = deliver(c, request(`${base}/events?after=${encodeURIComponent(live)}`));
  if (assets) for (const [path, [file, mime]] of files) deliver(c, request(path), { headers: () => ({ 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }), body: () => fs.readFile(new URL('../' + file, import.meta.url)) });
  await c.network.drain(); return sse;
}
function taskRequest(extra = {}) { return request(`/v1/sessions/${sid}/runs`, { method: () => 'POST',
  headers: () => ({ authorization: `Bearer ${owner}`, 'content-type': 'application/json', origin }),
  postDataJSON: () => ({ operation_id: '54000000-0000-4000-8000-000000000004', run_id: rid, text: texts.task }), ...extra }); }
test('D1 failed Request freezes tracked identity and scalar status before sibling settlements', async () => {
  const c = netCase(), sse = await handshake(c);
  c.network.failed(sse);
  assert.deepEqual(c.d.packet().failed_request, { kind: 'sse', order: 10, response_present: true, finished: false, closing: false, status: 200 });
  const packet = clone(c.d.packet()); c.network.closing(); c.network.failed(sse);
  assert.deepEqual(c.d.packet(), packet);
});
test('C54B actual collector enforces original identities Task202 headers assets and never reads API bodies', async () => {
  const c = netCase(), sse = await handshake(c, true); c.network.armTask(); deliver(c, taskRequest()); const facts = c.network.proof();
  assert.equal(facts.assets, 9); assert.equal(facts.operations.task.status, 202); assert.equal(facts.operations.task.timing, 'unmeasured');
  assert.equal(c.network.taskRun(), rid); assert.equal(facts.counts.task, 1); c.network.closing(); c.network.failed(sse); c.network.proof();
  assert.ok(!JSON.stringify(facts).includes(owner)); assert.ok(!JSON.stringify(facts).includes(origin)); assert.ok(!JSON.stringify(facts).includes(texts.task));
});
test('C54BR2 actual collector admits validated Latest response before finished without arming Task early', async t => {
  for (const finish of ['before SSE response', 'after SSE response']) await t.test(finish, async () => {
    const c = netCase(), latest = request(base), sse = request(`${base}/events?after=${encodeURIComponent(live)}`);
    c.network.request(latest); c.network.response(response(latest));
    assert.equal(c.network.ready('latest'), false); assert.equal(c.network.facts().operations.latest, undefined);
    assert.throws(() => c.network.armTask()); c.network.request(sse);
    assert.equal(c.network.facts().failed, false, 'validated Latest reply admits SSE request before finished');
    if (finish === 'after SSE response') c.network.response(response(sse));
    assert.equal(c.network.ready('latest'), false); assert.throws(() => c.network.armTask());
    c.network.finished(latest); assert.equal(c.network.ready('latest'), true);
    if (finish === 'before SSE response') { assert.throws(() => c.network.armTask()); c.network.response(response(sse)); }
    assert.equal(c.network.ready('sse'), true); c.network.armTask(); deliver(c, taskRequest());
    assert.equal(c.network.ready('task'), true); assert.equal(c.network.taskRun(), rid);
    assert.equal(c.network.facts().operations.task.status, 202); assert.equal(c.network.facts().operations.latest.requestfinished, true);
    c.network.closing(); c.network.failed(sse); c.network.cleanupProof(); assert.equal(c.d.packet(), null);
  });
});
test('C54BR2 fresh invalid Latest replies and pre-response SSE stay sticky through later valid settlements', async t => {
  for (const defect of ['pre-response', 'status', 'cache', 'media', 'nosniff', 'cookie', 'identity', 'url', 'auth']) await t.test(defect, async () => {
    const c = netCase(), latest = request(base, defect === 'auth' ? { headers: () => ({ authorization: 'wrong' }) } : {});
    const headers = response(latest).headers();
    if (defect === 'cache') headers['cache-control'] = 'public';
    if (defect === 'media') headers['content-type'] = 'text/plain';
    if (defect === 'nosniff') delete headers['x-content-type-options'];
    if (defect === 'cookie') headers['set-cookie'] = 'synthetic';
    c.network.request(latest);
    if (defect !== 'pre-response') c.network.response(response(latest, { headers: () => headers,
      status: () => defect === 'status' ? 500 : 200, request: () => defect === 'identity' ? request(base) : latest,
      url: () => defect === 'url' ? origin + '/wrong' : latest.url() }));
    assert.equal(c.network.ready('latest'), false); assert.throws(() => c.network.armTask());
    const sse = request(`${base}/events?after=${encodeURIComponent(live)}`); c.network.request(sse);
    const packet = clone(c.d.packet()); assert.ok(packet); assert.equal(c.network.facts().failed, true);
    c.network.response(response(latest)); c.network.finished(latest); c.network.response(response(sse));
    await c.network.drain(); assert.equal(c.network.ready('latest'), false); assert.equal(c.network.ready('sse'), false);
    assert.throws(() => c.network.armTask()); assert.throws(() => c.network.cleanupProof()); assert.deepEqual(c.d.packet(), packet);
    assert.equal(c.network.facts().counts.task, 0);
  });
});
test('C54BR2 duplicate Latest and asset requests preserve first packet through later settlement', async t => {
  for (const path of [base, '/']) await t.test(path === base ? 'Latest' : 'asset', async () => {
    const c = netCase(), q = request(path); c.network.request(q); c.network.request(q); const packet = clone(c.d.packet());
    if (path === base) { c.network.response(response(q)); c.network.finished(q); }
    else { c.network.response(response(q, { headers: () => ({ 'content-type': files.get(path)[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }),
      body: () => fs.readFile(new URL('../index.html', import.meta.url)) })); c.network.finished(q); }
    await c.network.drain(); assert.equal(c.network.facts().pending, 0); assert.equal(c.network.ready('latest'), false);
    assert.throws(() => c.network.cleanupProof()); assert.deepEqual(c.d.packet(), packet);
  });
});
test('C54B actual collector rejects route method query identity count status auth privacy and late SSE faults', async t => {
  const defects = ['before', 'within', 'content', 'entry', 'reconcile', 'extra', 'duplicate', 'wrong-response', 'wrong-url', 'duplicate-response', 'duplicate-finish',
    'status200', 'cache', 'media', 'cookie', 'auth', 'wrong-text', 'wrong-run', 'early', 'sse-loss', 'unknown-finish', 'lost-response', 'stream-finish'];
  for (const defect of defects) await t.test(defect, async () => {
    const c = netCase(), sse = await handshake(c, true); if (defect !== 'early') c.network.armTask(); let q = taskRequest();
    if (defect === 'cookie') q = taskRequest({ headers: () => ({ cookie: 'bad' }) });
    if (defect === 'auth') q = taskRequest({ headers: () => ({ authorization: 'wrong' }) });
    if (defect === 'wrong-text') q = taskRequest({ postDataJSON: () => ({ operation_id: rid, run_id: rid, text: 'wrong' }) });
    if (defect === 'wrong-run') q = taskRequest({ postDataJSON: () => ({ operation_id: rid, run_id: 'invalid', text: texts.task }) });
    c.network.request(q);
    const r = response(q, defect === 'status200' ? { status: () => 200 } : defect === 'wrong-response' ? { request: () => taskRequest() }
      : defect === 'wrong-url' ? { url: () => origin + '/wrong' } : defect === 'cache' ? { headers: () => ({ 'content-type': 'application/json', 'cache-control': 'public' }) }
      : defect === 'media' ? { headers: () => ({ 'content-type': 'text/plain', 'cache-control': 'no-store' }) } : {});
    if (defect !== 'lost-response') c.network.response(r); if (defect !== 'lost-response') c.network.finished(q);
    if (defect === 'duplicate') c.network.request(q); if (defect === 'duplicate-response') c.network.response(r); if (defect === 'duplicate-finish') c.network.finished(q);
    if (defect === 'sse-loss') c.network.failed(sse); if (defect === 'unknown-finish') c.network.finished(taskRequest()); if (defect === 'stream-finish') c.network.finished(sse);
    if (['before', 'within'].includes(defect)) c.network.request(request(base + '?' + defect + '=wrong'));
    if (['content', 'entry'].includes(defect)) c.network.request(request(base + '/' + (defect === 'content' ? 'content?cursor=wrong' : 'entries/run/entry')));
    if (defect === 'reconcile') c.network.request(request(`/v1/sessions/${sid}/runs/reconcile`, { method: () => 'POST' }));
    if (defect === 'extra') c.network.request(request('/v1/unknown'));
    await c.network.drain(); assert.throws(() => c.network.proof());
  });
});
test('C54B actual collector tracks held asset metadata tasks through drain and rejects asset read failures', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'rejected' : 'held', async () => {
    const c = netCase(); await handshake(c); c.network.armTask(); deliver(c, taskRequest()); let release;
    const path = '/', q = request(path), bytes = await fs.readFile(new URL('../index.html', import.meta.url));
    deliver(c, q, { headers: () => ({ 'content-type': files.get(path)[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }), body: () => new Promise((resolve, reject) => { release = () => fail ? reject(new Error('unpublished')) : resolve(bytes); }) });
    await Promise.resolve(); assert.equal(c.network.facts().pending, 1); assert.throws(() => c.network.cleanupProof());
    let done = false; const drain = c.network.drain().then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false); release(); await drain;
    assert.equal(c.network.facts().pending, 0); if (fail) assert.throws(() => c.network.cleanupProof()); else c.network.cleanupProof();
  });
});

const specPath = new URL('../e2e/live-commit-measurements.spec.mjs', import.meta.url);
async function specCase(t, options = {}) {
  const source = await fs.readFile(specPath, 'utf8'), helper = await fs.readFile(new URL('../test-support/live-commit-measurements.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('case.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const script = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast)).join('\n').replaceAll('import.meta.url', JSON.stringify(specPath.href));
  const events = [], artifacts = new Map(), failure = new Error('unpublished first'), publication = new Error('unpublished sibling');
  let digestCalls = 0, firstOperationError, firstPacket, ownedError;
  const h = rendered(t, options.digestReject ? { crypto: { subtle: { digest: async (algorithm, bytes) => {
    assert.equal(algorithm, 'SHA-256'); if (++digestCalls === 2) throw failure;
    return Buffer.from(digest(bytes), 'hex');
  } } } } : {});
  let callback, cleanupResult, network, sse, task, disposing = false, cleaned = false, finalPreparing = false, releaseAsset, injected = false;
  let serverClosed = false, browserClosed = false, commandSerial = 1, notifyNative, diagnosticReads = 0;
  const nativeFailure = { protocol: 1, event: 'failed', category: 'native_failure', origin: 'run', phase: 'first_wire_reply',
    last_completed: 'provider_request_match', ...connections(false, options.readerUnavailable ? null : readers), reader_error: options.readerError ? readerError() : null };
  if (options.keeperError) nativeFailure.keeper.error = keeperError();
  function nativeFailed() {
    Object.assign(facts, { failure: true, first_boundary: 'native_frame', native_failure: clone(nativeFailure) });
    notifyNative('native_failed_frame', clone(facts));
  }
  const handlers = new Map();
  const faults = newFaults(), state = protocol();
  state.reply({ protocol: 1, event: 'ready', id: 1, pid: 900, origin, session_id: sid, head: 1, work: work(0), ...connections() });
  const nativeIdentity = { pid: 900, ppid: process.pid, start_ticks: '42', executable: '/synthetic/native', cwd: '/synthetic/root/child' };
  const browserIdentity = { state: 'present', pid: 901, ppid: process.pid, start_ticks: '43', executable: '/synthetic/browser', cwd: '/synthetic' };
  const facts = { identity: nativeIdentity, closed: false, input_ended: false, stopped: false, drained: false, ...connections(), code: null, signal: null,
    stderr_bytes: 0, failure: false, fallback: false, retired: false, first_boundary: null, native_failure: null, native_cleanup: null };
  const binding = { executable: '/synthetic/native', sha256: 'a'.repeat(64), selector: 'synthetic', sources: {} };
  const parent = { path: '/synthetic/wi-c54-private-ABC123', uid: process.getuid(), mode: 0o700, device: 1, inode: 2 };
  const raise = name => { events.push(name); if (options.fail === name) throw failure; };
  const allocationIo = options.allocationIo ?? {
    lstat: async p => {
      raise('parent-stat'); if (options.parentUnknown) throw failure;
      return { uid: parent.uid, mode: p === '/synthetic' ? 0o700 : options.parentRejected ? 0o755 : parent.mode,
        dev: parent.device, ino: parent.inode, isDirectory: () => true, isSymbolicLink: () => false };
    }, realpath: async p => p,
    rmdir: async (...args) => { removals.push({ kind: 'parent', args }); raise('parent-rmdir'); if (options.parentContents) throw failure; },
  };
  const removals = [], runtimeEnv = options.runtimeEnv ?? options.allocationEnv ?? {
    TMPDIR: '/synthetic', WI_BROWSER_FIXTURE_PARENT: '/synthetic', WI_C54_ALLOCATION_PARENT: JSON.stringify(parent),
  };
  let allocation;
  function late() {
    if (injected) return; injected = true; events.push('injected');
    if (options.late?.includes('pending')) {
      const q = request('/'); network.request(q); network.response(response(q, { headers: () => ({ 'content-type': files.get('/')[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }),
        body: () => new Promise((resolve, reject) => { releaseAsset = async () => options.late.endsWith('reject') ? reject(publication) : resolve(await fs.readFile(new URL('../index.html', import.meta.url))); }) })); network.finished(q);
    } else if (options.late?.endsWith('duplicate')) network.request(task);
    else network.failed(options.late?.startsWith('discovery') ? sse : task);
  }
  async function seam(name) {
    if (options.late?.startsWith(name)) await new Promise(resolve => queueMicrotask(() => { late(); resolve(); }));
  }
  const native = { origin, session_id: sid, head: 1, pid: 900,
    async request(body) {
      raise('drive:' + body.command);
      if (body.command === 'first' && options.nativeOrder) {
        assert.equal(typeof handlers.get('requestfailed'), 'function');
        if (options.nativeOrder === 'browser-first') handlers.get('requestfailed')(sse);
        nativeFailed();
        if (options.nativeOrder === 'native-first') handlers.get('requestfailed')(sse);
        throw failure;
      }
      const command = { ...body, id: ++commandSerial }; state.send(command);
      const common = { protocol: 1, id: command.id }; let reply;
      if (body.command === 'first') reply = { ...common, event: 'first', saved: saved('first'), work: work(1) };
      else if (body.command === 'observed_first') reply = { ...common, event: 'first_observed' };
      else if (body.command === 'arm') reply = { ...common, event: 'armed' };
      else if (body.command === 'second') { h.show('append'); reply = { ...common, event: 'captured', saved: saved('append'), operation_id: rid, pause_hits: 1, reader_closed: true, released: true, ...connections(), pages: telemetry().length }; }
      else if (body.command === 'page') reply = { ...common, event: 'page', ...telemetry()[body.page] };
      else if (body.command === 'authoritative') { h.show('authority'); reply = { ...common, event: 'authoritative', saved: saved('authority') }; }
      else if (body.command === 'terminal') { h.show('terminal'); reply = { ...common, event: 'terminal', saved: saved('terminal'), work: work(2), ...connections() }; }
      else if (body.command === 'observed_terminal') reply = { ...common, event: 'complete' };
      state.reply(reply); return reply;
    },
    async stop() {
      raise('native-stop');
      if (options.lateDiagnostic) {
        const badFailure = clone(nativeFailure), badCleanup = { protocol: 1, event: 'failure_cleanup', outcome: 'failed', ...connections() };
        for (const frame of [badFailure, badCleanup]) {
          if (options.lateDiagnostic === 'brand') frame.keeper = Object.assign(new Date(0), frame.keeper);
          else Object.defineProperty(frame.keeper, 'active', { enumerable: true, get() { throw publication; } });
        }
        notifyNative('native_cleanup', { ...clone(facts), native_failure: badFailure, native_cleanup: badCleanup });
        events.push('late-diagnostic');
      }
      if (options.nativeOrder) {
        if (options.readerError) facts.native_failure.reader_error.first.sqlite_extended = 999;
        if (options.keeperError) facts.native_failure.keeper.error.first.driver = 'other';
        facts.native_cleanup = { protocol: 1, event: 'failure_cleanup', outcome: 'failed', ...connections(true, null) };
        if (options.keeperError) {
          facts.native_cleanup.keeper.error = keeperError();
          facts.native_cleanup.keeper.error.close = { stage: 'keeper_close', driver: 'io', sqlite_primary: null, sqlite_extended: null, attempt: null, elapsed_ms: null };
          facts.native_cleanup.keeper.closed = 0; facts.native_cleanup.keeper.active = 1;
        }
        notifyNative('native_cleanup', clone(facts));
        Object.assign(facts, { closed: true, code: 1, retired: true }); notifyNative('native_close', clone(facts));
        throw publication;
      }
      Object.assign(facts, { closed: true, input_ended: true, stopped: true, drained: true, code: 0, retired: true, ...connections(!options.keeperOpen) });
      if (options.nativeDefect) facts[options.nativeDefect] = options.nativeDefect === 'fallback' ? true : false;
    },
    async abandon() { raise('native-abandon'); Object.assign(facts, { closed: true, input_ended: true, fallback: true }); },
    evidence() { if (options.getter === 'native' && finalPreparing) throw publication; return clone(facts); } };
  const locator = { fill: async () => {}, click: async () => {}, locator: () => locator };
  const pageHandlers = new Map();
  const page = { on: (name, fn) => pageHandlers.set(name, fn), goto: async () => {
    for (const [path, [file, mime]] of files) { if (path === '/' && options.late?.includes('pending')) continue; const q = request(path); network.request(q); network.response(response(q, { headers: () => ({ 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }), body: () => fs.readFile(new URL('../' + file, import.meta.url)) })); network.finished(q); }
    await network.drain();
  }, getByLabel: () => locator, locator: () => locator,
  getByRole: (role, o) => o.name === 'Connect' ? { ...locator, click: async () => {
    if (!options.latestFinish) { sse = await handshake({ network }); return; }
    const emit = (name, value) => { assert.equal(typeof handlers.get(name), 'function'); handlers.get(name)(value); events.push('callback:' + name); };
    for (const path of ['/v1/settings', '/v1/sessions?limit=32']) {
      const q = request(path); emit('request', q); emit('response', response(q)); emit('requestfinished', q);
    }
    const latest = request(base); emit('request', latest); emit('response', response(latest));
    assert.equal(network.ready('latest'), false); assert.equal(network.facts().operations.latest, undefined); assert.throws(() => network.armTask());
    sse = request(`${base}/events?after=${encodeURIComponent(live)}`); emit('request', sse);
    assert.equal(network.facts().failed, false, 'registered response callback admits SSE before requestfinished');
    if (options.latestFinish === 'after SSE response') emit('response', response(sse));
    assert.equal(network.ready('latest'), false); assert.throws(() => network.armTask());
    events.push('latest-not-finished'); emit('requestfinished', latest); assert.equal(network.ready('latest'), true);
    if (options.latestFinish === 'before SSE response') { assert.throws(() => network.armTask()); emit('response', response(sse)); }
    assert.equal(network.ready('sse'), true); events.push('handshake-ready');
  } }
    : o.name === 'Send' ? { ...locator, click: async () => { task = taskRequest(); deliver({ network }, task); } } : locator,
  evaluate: async (fn, input) => {
    const value = await browserProgram(input, h.env);
    if (options.observationMismatch && input.action === 'poll' && input.kind === 'append' && value) return { ...value, generation: '6' };
    return value;
  } };
  const expectation = v => ({ toBe: e => assert.equal(v, e), toEqual: e => assert.deepEqual(v, e), toContain: e => assert.ok(v.includes(e)), toHaveCount: async () => {}, toHaveValue: async () => {}, toHaveText: async () => {} });
  expectation.poll = fn => ({ toBe: async e => { if (e) await eventually(fn); else assert.equal(await fn(), e); } });
  const values = {
    test: Object.assign((name, fn) => { assert.equal(callback, undefined); callback = fn; }, { use: () => {} }), expect: expectation,
    chromium: { launchServer: async () => { raise('server-acquired'); return { process: () => ({ pid: 901 }), wsEndpoint: () => 'unpublished', close: async () => { raise('server-close'); serverClosed = true; }, kill: async () => { raise('server-kill'); serverClosed = true; } }; },
      connect: async () => { raise('browser-acquired'); return { version: () => '145.0.7632.6', close: async () => { raise('browser-close'); browserClosed = true; }, newContext: async () => { raise('context-acquired'); return { close: async () => { raise('context-close'); if (options.sseClose) network.failed(sse); }, route: async () => {}, on: (name, fn) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); }, newPage: async () => page }; } }; } },
    readFile: async u => u.href === specPath.href ? source : helper,
    writeFile: async (p, raw, opts) => { const name = p.split('/').at(-1); events.push('save:' + name); assert.equal(opts.mode, 0o600); assert.equal(opts.flag, 'wx');
      if (options.write === name) throw publication; artifacts.set(name, JSON.parse(raw)); },
    rm: async (...args) => { removals.push({ kind: 'root', args }); raise('rm'); if (options.late === 'rm-started') late(); }, rmdir: (...args) => allocationIo.rmdir(...args), lstat: async () => { throw { code: 'ENOENT' }; }, join,
    JSON: { ...JSON, stringify: (v, ...args) => { const name = v?.steps ? 'CLEANUP.json' : v?.independent_clocks ? 'MEASUREMENTS.json' : v?.native_states !== undefined ? 'ACCEPTANCE.json' : v?.fresh_cases ? 'BROWSER_RESULT.json' : null;
      if (options.serialize === name && name) throw publication; return JSON.stringify(v, ...args); } },
    createRoot: async p => { raise('nested-create'); if (options.createNested) return options.createNested(p); assert.equal(p, parent.path); return { root: '/synthetic/root', owner }; }, rootProof: async () => { if (disposing) await seam('root'); },
    launchNative: async args => {
      raise('native-acquired'); assert.equal(typeof args.onDiagnostic, 'function'); notifyNative = args.onDiagnostic;
      if (options.nativeStartup) { nativeFailed(); throw failure; }
      return native;
    }, nativeBinding: async () => { if (disposing && !cleaned) await seam('binding'); if (cleaned) finalPreparing = true; if (options.bindingChanged && disposing) throw publication; return binding; },
    terminalProof, removeRoot: async (f, processes, b, overrides) => {
      terminalProof(processes[0]); disposing = true;
      await values.rootProof(f); await values.nativeBinding(b); await seam('retirement'); await values.rootProof(f);
      await overrides.remove(f.root, { recursive: true });
    }, texts, telemetryProof,
    resources: onFailure => { const r = resources(onFailure), cleanup = r.cleanup, fail = r.fail;
      r.fail = error => { ownedError ??= error; fail(error); };
      r.cleanup = async () => { cleanupResult = await cleanup(); cleaned = true; return cleanupResult; }; return r; }, acquireResource,
    identity: async () => options.badIdentity ? { ...browserIdentity, ppid: 1 } : browserIdentity,
    retirement: async v => { if (v.pid === 901) return { ...v, retirement: serverClosed ? 'absent' : 'alive' }; return { ...v, retirement: options.unknownRetirement ? 'unknown' : 'absent' }; },
    browserTree: async () => { raise('tree'); if (disposing) throw failure;
      if (browserClosed) throw failure;
      if (options.late?.startsWith('discovery') && events.filter(v => v === 'tree').length === 2) await seam('discovery');
      return { members: [browserIdentity, { ...browserIdentity, pid: 902, ppid: 901 }], errors: { enumeration: 0, stat: 0, identity: 0 } };
    }, retireTree: async members => { raise('retire-tree'); if (!serverClosed || options.unknownRetirement) throw failure; return members.map(v => ({ ...v, retirement: 'absent' })); },
    boundary: async () => {}, resolveBinding: async () => binding,
    allocationProgress: () => { allocation = allocationProgress(); return allocation; },
    resolveAllocation: (env, progress) => {
      if (options.baseSnapshot) {
        assert.deepEqual(Object.keys(env).sort(), ['WI_BROWSER_FIXTURE_PARENT', 'WI_C54_ALLOCATION_PARENT'].sort());
        assert.equal(env.WI_BROWSER_FIXTURE_PARENT, '/synthetic');
      }
      return resolveAllocation(env, progress, allocationIo);
    },
    allocationProof: (value, outer) => allocationProof(value, outer, allocationIo),
    removeAllocation: (progress, outer, safety, overrides) => removeAllocation(progress, outer, safety, { ...allocationIo, ...overrides }),
    reserveOutput: (info, env) => reserveOutput(info, env, { mkdir: async () => { raise('reserve'); if (options.occupied) throw failure; }, writeFile: async (p, raw, opts) => { assert.equal(opts.mode, 0o600); assert.equal(opts.flag, 'wx'); raise('marker'); artifacts.set('C54.once.json', JSON.parse(raw)); } }),
    modesProof: async () => { disposing = true; await seam('modes'); }, browserProgram, browserProof, phaseDrive,
    liveCollector: args => {
      const n = liveCollector(args), originalDrain = n.drain, originalFacts = n.facts;
      n.drain = async () => { const p = originalDrain(); await Promise.resolve(); if (releaseAsset) { const release = releaseAsset; releaseAsset = null; release(); } await p; };
      n.facts = () => { if (options.getter === 'network' && finalPreparing) throw publication; return originalFacts(); };
      network = n; return n;
    }, diagnostics: read => { const d = diagnostics(read); return { ...d,
      facts: () => {
        events.push('diagnostics-read:' + ++diagnosticReads);
        if (options.diagnosticRead === diagnosticReads || options.getter === 'diagnostics' && finalPreparing) throw publication;
        return d.facts();
      },
      operation: async (name, action) => {
        try { return await d.operation(name, async () => {
          raise(name); if (options.consoleFault && name === 'privacy') pageHandlers.get('console')();
          if (name === options.mutateBaseAt) {
            runtimeEnv.WI_BROWSER_FIXTURE_PARENT = '/synthetic/changed'; runtimeEnv.TMPDIR = '/synthetic/changed';
          }
          return action();
        }); } catch (error) { firstOperationError ??= error; firstPacket ??= d.packet(); throw error; }
      } }; },
    appendMeasurementAnnotation, newFaults: () => faults, sourceGuard, process: { env: runtimeEnv, pid: process.pid }, URL,
  };
  new Function(...Object.keys(values), script)(...Object.values(values)); options.beforeCallback?.(); let error;
  const annotations = [], info = { outputPath: name => { assert.equal(name, 'c54-evidence'); return '/synthetic/output/evidence'; },
    get annotations() { events.push('annotation'); if (options.annotationAccess) throw publication; return options.annotationAppend ? Object.freeze(annotations) : annotations; } };
  try { await callback({}, info); } catch (caught) { error = caught; }
  assert.equal(typeof callback, 'function'); assert.ok(!JSON.stringify([...artifacts.values()]).includes(failure.message));
  return { artifacts, events, error, cleanupResult, failure, publication, network, facts, allocation, firstOperationError, firstPacket, ownedError, digestCalls, removals, annotations };
}
test('D1 actual registered callbacks preserve both Node callback orders and later native close without causal claims', async t => {
  for (const nativeOrder of ['browser-first', 'native-first']) for (const readerUnavailable of [false, true]) await t.test(`${nativeOrder} readers ${readerUnavailable}`, async t => {
    const c = await specCase(t, { nativeOrder, readerUnavailable }); assert.equal(c.error, c.failure);
    const before = c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'), cleanup = c.artifacts.get('CLEANUP.json'), result = c.artifacts.get('BROWSER_RESULT.json');
    assert.equal(result.status, 'FAILED'); assert.equal(cleanup.body_success, false); assert.equal(cleanup.pass, false); assert.ok(!c.events.includes('rm'));
    assert.equal(before.first_operation, nativeOrder === 'browser-first' ? 'collector_failed' : 'native_failed_frame');
    assert.equal(before.phases.first, 'pending'); assert.deepEqual(result.first_failure, before); assert.deepEqual(cleanup.first_failure, before);
    assert.deepEqual(result.diagnostics.callback_order.map(v => v.event), nativeOrder === 'browser-first'
      ? ['browser_requestfailed', 'native_failed_frame', 'native_close'] : ['native_failed_frame', 'browser_requestfailed', 'native_close']);
    assert.deepEqual(cleanup.diagnostics, result.diagnostics); assert.equal(before.callback_order.length, 1);
    assert.equal(result.diagnostics.native.failure.phase, 'first_wire_reply');
    assert.equal(result.diagnostics.native.first_boundary, 'native_frame'); assert.equal(result.diagnostics.native.code, 1);
    assert.equal(result.diagnostics.native.cleanup.outcome, 'failed'); assert.equal(result.diagnostics.native.cleanup.readers, null);
    assert.equal(result.diagnostics.native.failure.readers === null, readerUnavailable);
    assert.equal(result.diagnostics.failed_request.kind, 'sse'); assert.equal(result.diagnostics.failed_request.status, 200);
    assert.equal(result.diagnostics.callback_order_scope, 'Node callbacks only; not physical or cross-clock causality');
    assert.equal(c.artifacts.get('MEASUREMENTS.json').native, null); assert.equal(c.artifacts.get('MEASUREMENTS.json').browser, null);
    assert.equal(c.artifacts.get('ACCEPTANCE.json').pass, false);
  });
});
test('D1 native facts before assignment survive unavailable measurements getters and independent artifact publication failures', async t => {
  for (const options of [{ nativeStartup: true }, { nativeOrder: 'native-first', getter: 'native' }, { nativeOrder: 'browser-first', getter: 'network' },
    { nativeOrder: 'native-first', serialize: 'MEASUREMENTS.json' }, { nativeOrder: 'browser-first', write: 'MEASUREMENTS.json' },
    { nativeOrder: 'native-first', serialize: 'CLEANUP.json' }, { nativeOrder: 'browser-first', write: 'CLEANUP.json' }]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, options); assert.equal(c.error, c.failure);
    const result = c.artifacts.get('BROWSER_RESULT.json'); assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics.native.failure.phase, 'first_wire_reply');
    assert.deepEqual(result.first_failure, c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'));
    if (options.nativeStartup) { assert.equal(c.artifacts.get('CLEANUP.json').availability.native, 'not_acquired'); assert.ok(!c.events.includes('server-acquired')); }
    assert.ok(!c.events.includes('rm'));
  });
});
test('D4 B first packet owns keeper and total facts through mutation late getters and separate cleanup', () => {
  const d = diagnostics(() => ({ counts: {}, pending: 0, failed: false }));
  const frame = { protocol: 1, event: 'failed', category: 'native_failure', origin: 'run', phase: 'settle', last_completed: null,
    ...connections(), reader_error: readerError() };
  frame.keeper.error = keeperError();
  const value = { first_boundary: 'native_frame', native_failure: frame, native_cleanup: null, closed: false, code: null };
  d.native('native_failed_frame', value); const packet = d.packet(), first = packet.native.failure;
  for (const v of [first.keeper, first.keeper.error, first.keeper.error.first, first.totals]) assert.ok(Object.isFrozen(v));
  assert.throws(() => { first.keeper.active = 0; });
  frame.keeper.error.first.driver = 'other'; frame.totals.active = 0;
  Object.defineProperty(frame.keeper, 'active', { get() { throw Error('unpublished late getter'); } });
  const cleanup = { protocol: 1, event: 'failure_cleanup', outcome: 'failed', ...connections() };
  cleanup.keeper.error = keeperError(); cleanup.keeper.error.close = { ...keeperError().first, stage: 'keeper_close', driver: 'io' };
  d.native('native_cleanup', { ...value, native_cleanup: cleanup });
  assert.equal(d.packet(), packet); assert.equal(first.keeper.active, 1); assert.equal(first.totals.active, 1);
  assert.equal(first.keeper.error.first.driver, 'panic'); assert.equal(first.keeper.error.close, null);
  assert.equal(d.facts().native.cleanup.keeper.error.close.driver, 'io');
  assert.ok(Object.isFrozen(d.facts().native.cleanup.keeper.error.close));
  assert.deepEqual(first.reader_error, readerError());
});
test('D4 registered callback keeps keeper diagnostics and original errors through independent artifact faults', async t => {
  for (const options of [{}, { getter: 'native' }, { getter: 'diagnostics' }, ...['CLEANUP.json', 'MEASUREMENTS.json', 'ACCEPTANCE.json'].flatMap(name => [{ serialize: name }, { write: name }])]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, { nativeOrder: 'native-first', readerError: true, keeperError: true, ...options });
    assert.equal(c.error, c.failure); assert.equal(c.cleanupResult.error, c.failure);
    const before = c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'), result = c.artifacts.get('BROWSER_RESULT.json');
    assert.deepEqual(before.native.failure.keeper.error, keeperError()); assert.deepEqual(before.native.failure.reader_error, readerError());
    assert.deepEqual(result.first_failure, before); assert.equal(result.status, 'FAILED');
    assert.equal(before.native.failure.totals.active, 1); assert.ok(Object.isFrozen(c.firstPacket.native.failure.keeper.error.first));
    assert.ok(!c.events.includes('rm')); assert.ok(!c.events.includes('parent-rmdir'));
    for (const event of ['native-stop', 'context-close', 'server-close', 'browser-close']) assert.ok(c.events.includes(event));
    for (const name of ['CLEANUP.json', 'MEASUREMENTS.json', 'ACCEPTANCE.json']) if (options.serialize !== name && options.write !== name) assert.ok(c.artifacts.has(name));
    if (result.diagnostics) assert.deepEqual(result.diagnostics.native.failure.keeper.error, keeperError());
  });
});
test('D4 registered callback rejects open keeper at terminal despite balanced short readers', async t => {
  const c = await specCase(t, { keeperOpen: true });
  assert.ok(c.error); assert.equal(c.facts.readers.active, 0); assert.equal(c.facts.keeper.active, 1); assert.equal(c.facts.totals.active, 1);
  assert.equal(c.artifacts.get('CLEANUP.json').pass, false); assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED');
  assert.ok(!c.events.includes('rm')); assert.ok(!c.events.includes('parent-rmdir'));
  for (const event of ['native-stop', 'context-close', 'server-close', 'browser-close']) assert.ok(c.events.includes(event));
});
test('D4 B malformed keeper and total facts are unavailable rather than invented', () => {
  for (const defect of ['missing', 'unknown', 'getter', 'totals', 'owner', 'range', 'null']) {
    const frame = { protocol: 1, event: 'failed', category: 'native_failure', origin: 'run', phase: 'settle', last_completed: null, ...connections(), reader_error: null };
    if (defect === 'missing') delete frame.keeper.error;
    if (defect === 'unknown') frame.keeper.extra = 'unpublished';
    if (defect === 'getter') Object.defineProperty(frame.keeper, 'error', { get() { throw Error('unpublished'); } });
    if (defect === 'totals') frame.totals.active = 0;
    if (defect === 'owner') frame.keeper.error = readerError();
    if (defect === 'range') frame.keeper.opened = 2;
    if (defect === 'null') frame.keeper = null;
    const d = diagnostics(() => ({})); d.native('native_failed_frame', { native_failure: frame, native_cleanup: null });
    assert.equal(d.packet().native.failure, null); assert.equal(d.packet().native.failure_availability, 'unavailable');
    assert.ok(!JSON.stringify(d.packet()).includes('unpublished'));
  }
});
test('D4 M1 B rejects branded owned clones across failure and both cleanup outcomes', async t => {
  for (const kind of ['failure', 'failed-cleanup', 'closed-cleanup']) {
    const frame = kind === 'failure'
      ? { protocol: 1, event: 'failed', category: 'native_failure', origin: 'run', phase: 'settle', last_completed: null, ...connections(), reader_error: readerError() }
      : { protocol: 1, event: 'failure_cleanup', outcome: kind === 'failed-cleanup' ? 'failed' : 'closed', ...connections(kind === 'closed-cleanup') };
    frame.keeper.error = keeperError();
    if (kind === 'failed-cleanup') frame.keeper.error.close = { ...keeperError().first, stage: 'keeper_close', driver: 'io' };
    const cleanup = kind !== 'failure', proof = cleanup ? nativeCleanupProof : nativeFailureProof;
    const paths = ['keeper', 'readers', 'totals', 'keeper.error', 'keeper.error.first'];
    if (kind === 'failure') paths.push('reader_error', 'reader_error.first', 'reader_error.close');
    if (kind === 'failed-cleanup') paths.push('keeper.error.close');
    for (const path of paths) await t.test(`${kind} ${path}`, () => {
      const bad = clone(frame), parts = path.split('.'), key = parts.pop(); let holder = bad;
      for (const part of parts) holder = holder[part];
      holder[key] = Object.assign(new Date(0), holder[key]); assert.equal(proof(bad), true);
      const d = diagnostics(() => ({}));
      d.native('native_failed_frame', { native_failure: cleanup ? null : bad, native_cleanup: cleanup ? bad : null });
      const packet = d.packet(), native = packet.native, name = cleanup ? 'cleanup' : 'failure';
      assert.equal(native[name], null); assert.equal(native[name + '_availability'], 'unavailable');
      const serialized = JSON.stringify(packet); holder[key].setTime(1000);
      assert.equal(JSON.stringify(packet), serialized); assert.ok(!serialized.includes('1970-'));
    });
    for (const throwing of [false, true]) await t.test(`${kind} nested stateful getter throwing ${throwing}`, () => {
      const bad = clone(frame); let reads = 0;
      Object.defineProperty(bad.keeper, 'active', { enumerable: true, get() { reads++; if (throwing) throw Error('unpublished'); return reads === 1 ? 1 : 0; } });
      const d = diagnostics(() => ({})); d.native('native_failed_frame', { native_failure: cleanup ? null : bad, native_cleanup: cleanup ? bad : null });
      assert.equal(d.packet().native[cleanup ? 'cleanup' : 'failure'], null);
      assert.equal(d.packet().native[cleanup ? 'cleanup_availability' : 'failure_availability'], 'unavailable'); assert.equal(reads, 0);
    });
    await t.test(`${kind} holder captured once and plain owned immutable`, () => {
      let reads = 0; const value = { native_failure: null, native_cleanup: null }, name = cleanup ? 'native_cleanup' : 'native_failure';
      Object.defineProperty(value, name, { get() { reads++; if (reads !== 1) throw Error('unpublished second holder read'); return frame; } });
      const d = diagnostics(() => ({})); d.native('native_failed_frame', value);
      const packet = d.packet(), owned = packet.native[cleanup ? 'cleanup' : 'failure'];
      assert.equal(reads, 1); assert.equal(proof(owned), true); assert.deepEqual(owned, frame);
      for (const v of [owned, owned.keeper, owned.keeper.error, owned.keeper.error.first, owned.totals]) assert.ok(Object.isFrozen(v));
      const serialized = JSON.stringify(packet); frame.keeper.error.first.driver = 'other'; frame.readers.opened++;
      assert.equal(JSON.stringify(packet), serialized); assert.equal(proof(owned), true);
      d.native('native_close', { get native_failure() { throw Error('unpublished holder'); }, get native_cleanup() { throw Error('unpublished holder'); } });
      assert.equal(d.packet(), packet); assert.equal(JSON.stringify(packet), serialized);
    });
  }
});
test('D4 M1 registered callbacks preserve original body and cleanup errors after bad clones and publication faults', async t => {
  for (const fail of ['privacy', 'context-close']) for (const lateDiagnostic of ['brand', 'getter']) {
    for (const fault of [{}, { getter: 'diagnostics' }, { serialize: 'MEASUREMENTS.json' }, { write: 'CLEANUP.json' }]) await t.test(`${fail} ${lateDiagnostic} ${JSON.stringify(fault)}`, async t => {
      const c = await specCase(t, { fail, lateDiagnostic, sseClose: true, ...fault });
      assert.equal(c.error, c.failure); assert.equal(c.cleanupResult.error, c.failure);
      const result = c.artifacts.get('BROWSER_RESULT.json'); assert.equal(result.status, 'FAILED');
      assert.ok(c.events.includes('late-diagnostic')); assert.ok(!c.events.includes('rm')); assert.ok(!c.events.includes('parent-rmdir'));
      assert.deepEqual(result.first_failure, c.firstPacket); assert.ok(Object.isFrozen(c.firstPacket));
      if (fail === 'privacy') assert.deepEqual(c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'), c.firstPacket);
      else assert.equal(c.artifacts.has('FAILURE_BEFORE_CLEANUP.json'), false, 'cleanup-only failures occur after the body packet publication point');
      if (c.artifacts.has('CLEANUP.json')) assert.deepEqual(c.artifacts.get('CLEANUP.json').first_failure, c.firstPacket);
      assert.equal(JSON.stringify(c.firstPacket).includes('1970-'), false);
      if (result.diagnostics) {
        assert.equal(result.diagnostics.native.failure, null); assert.equal(result.diagnostics.native.cleanup, null);
        assert.equal(result.diagnostics.native.failure_availability, 'unavailable'); assert.equal(result.diagnostics.native.cleanup_availability, 'unavailable');
      }
      for (const event of ['native-stop', 'context-close', 'server-close', 'browser-close', 'retire-tree']) assert.equal(c.events.filter(v => v === event).length, 1);
      for (const name of ['CLEANUP.json', 'MEASUREMENTS.json', 'ACCEPTANCE.json']) if (fault.serialize !== name && fault.write !== name) assert.ok(c.artifacts.has(name));
      assert.equal(c.allocation.removed, false);
    });
  }
});
test('D3 B first packet owns and deeply freezes reader facts through later callbacks', () => {
  const d = diagnostics(() => ({ counts: {}, pending: 0, failed: false }));
  const frame = { protocol: 1, event: 'failed', category: 'native_failure', origin: 'run', phase: 'settle', last_completed: 'control_admission', ...connections(), reader_error: readerError() };
  const value = { first_boundary: 'native_frame', native_failure: frame, native_cleanup: null, closed: false, code: null };
  d.native('native_failed_frame', value);
  const packet = d.packet(), issue = packet.native.failure.reader_error;
  assert.ok(Object.isFrozen(issue)); assert.ok(Object.isFrozen(issue.first)); assert.ok(Object.isFrozen(issue.close));
  assert.throws(() => { issue.first.sqlite_extended = 999; });
  frame.reader_error.first.sqlite_extended = 5;
  d.native('native_close', { ...value, closed: true, code: 1 });
  assert.equal(d.packet(), packet); assert.equal(d.facts().native.failure.reader_error.first.sqlite_extended, 517);
  assert.equal(packet.native.failure.reader_error.first.sqlite_extended, 517);
  assert.ok(!JSON.stringify(packet).includes('unpublished'));
});
test('D3 actual callback reader facts survive getters serialization publication and later close', async t => {
  for (const options of [{}, { getter: 'native' }, { getter: 'diagnostics' }, ...['CLEANUP.json', 'MEASUREMENTS.json', 'ACCEPTANCE.json'].flatMap(name => [{ serialize: name }, { write: name }])]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, { nativeOrder: 'native-first', readerError: true, ...options });
    assert.equal(c.error, c.failure); assert.equal(c.cleanupResult.error, c.failure);
    const before = c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'), result = c.artifacts.get('BROWSER_RESULT.json');
    assert.deepEqual(before.native.failure.reader_error, readerError()); assert.deepEqual(result.first_failure, before);
    assert.equal(result.status, 'FAILED'); assert.ok(!c.events.includes('rm')); assert.ok(!c.events.includes('parent-rmdir'));
    assert.ok(c.events.includes('native-stop')); assert.ok(c.events.includes('context-close')); assert.ok(c.events.includes('server-close'));
    assert.ok(c.artifacts.has('ACCEPTANCE.json') || options.serialize === 'ACCEPTANCE.json' || options.write === 'ACCEPTANCE.json');
    if (result.diagnostics) assert.deepEqual(result.diagnostics.native.failure.reader_error, readerError());
    assert.ok(Object.isFrozen(c.firstPacket.native.failure.reader_error.first));
  });
});
test('D3 B malformed nested reader facts remain unavailable without inventing reader errors', () => {
  for (const defect of ['code', 'unknown', 'getter', 'missing', 'extra']) {
    const frame = { protocol: 1, event: 'failed', category: 'native_failure', origin: 'run', phase: 'settle', last_completed: null, ...connections(false, null), reader_error: readerError() };
    if (defect === 'code') frame.reader_error.first.sqlite_primary = 6;
    if (defect === 'unknown') frame.reader_error.first.driver = 'unpublished';
    if (defect === 'getter') Object.defineProperty(frame.reader_error, 'first', { get() { throw Error('unpublished'); } });
    if (defect === 'missing') delete frame.reader_error.first.attempt;
    if (defect === 'extra') frame.reader_error.first.payload = 'unpublished';
    const d = diagnostics(() => ({})); d.native('native_failed_frame', { native_failure: frame, native_cleanup: null });
    assert.equal(d.packet().native.failure, null); assert.equal(d.packet().native.failure_availability, 'unavailable');
    assert.ok(!JSON.stringify(d.packet()).includes('unpublished'));
  }
});
test('D1 actual failed Request callback uses only tracked identity and tolerates rejected status getters', async t => {
  for (const kind of ['latest', 'task', 'asset', 'untracked', 'status-unavailable', 'finished', 'closing']) await t.test(kind, async () => {
    const c = netCase(); let q, r;
    if (kind === 'untracked') q = { url: trap, headers: trap, failure: trap };
    else if (kind === 'asset') { q = request('/'); c.network.request(q); }
    else if (kind === 'task') { await handshake(c); c.network.armTask(); q = taskRequest(); c.network.request(q); }
    else { q = request(base); c.network.request(q); r = response(q); c.network.response(r); }
    if (kind === 'status-unavailable') Object.defineProperty(r, 'status', { get: trap });
    if (kind === 'finished') c.network.finished(q);
    if (kind === 'closing') c.network.closing();
    c.network.failed(q); const packet = c.d.packet(), facts = c.network.facts();
    assert.equal(facts.failed, true); assert.deepEqual(packet.failed_request, facts.failed_request);
    assert.equal(packet.failed_request.kind, ['status-unavailable', 'finished', 'closing'].includes(kind) ? 'latest' : kind);
    if (['untracked', 'asset', 'task', 'status-unavailable'].includes(kind)) assert.equal(packet.failed_request.status, 'unavailable');
    if (kind === 'finished') assert.equal(packet.failed_request.finished, true);
    if (kind === 'closing') assert.equal(packet.failed_request.closing, true);
    assert.deepEqual(packet.callback_order, [{ order: 1, event: 'browser_requestfailed' }]);
    assert.ok(!JSON.stringify(packet).includes(origin)); assert.ok(!JSON.stringify(packet).includes(owner));
  });
});
test('D1 diagnostics reject getter payloads preserve first packets and bound local callback ordering', () => {
  const d = diagnostics(() => ({ counts: {}, pending: {}, failed: { payload: 'unpublished' } }));
  const value = { first_boundary: 'parser', native_failure: null, native_cleanup: null, closed: false, code: null };
  d.native('node_failure', value); const packet = d.packet(); assert.equal(packet.collector_failed, 'unavailable');
  for (let i = 0; i < 70; i++) d.requestFailed({ get kind() { throw Error('unpublished getter payload'); } });
  d.native('native_failed_frame', { get native_failure() { throw Error('unpublished getter payload'); } });
  d.discoveryRejected(); assert.equal(d.packet(), packet); assert.equal(d.facts().native.first_boundary, 'parser');
  assert.equal(d.facts().callback_order.length, 64); assert.equal(d.facts().callback_order_overflow, true);
  assert.equal(d.facts().browser_discovery_rejection, 'local_rejection_unavailable'); assert.ok(!JSON.stringify(d.facts()).includes('payload'));
  assert.throws(() => { d.facts().callback_order.push({}); });
});
test('D1 actual discovery rejection remains unknown and diagnostic getters cannot suppress independent failed artifacts', async t => {
  for (const options of [{ fail: 'tree' }, { getter: 'diagnostics', fail: 'privacy' }]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, options); assert.equal(c.error, c.failure); const result = c.artifacts.get('BROWSER_RESULT.json');
    assert.equal(result.status, 'FAILED'); assert.ok(c.artifacts.has('CLEANUP.json')); assert.ok(c.artifacts.has('MEASUREMENTS.json'));
    if (options.fail === 'tree') assert.equal(result.diagnostics.browser_discovery_rejection, 'local_rejection_unavailable');
    else assert.equal(result.diagnostics, null);
  });
});

test('D1 M1 actual callback prepares final diagnostics before verdict and first packet', async t => {
  for (const [name, options] of [
    ['baseline', {}],
    ['final-only diagnostic fault', { diagnosticRead: 2 }],
    ['cleanup-only diagnostic fault', { diagnosticRead: 1 }],
    ['prior privacy error then final diagnostic fault', { fail: 'privacy', diagnosticRead: 2 }],
  ]) await t.test(name, async t => {
    const c = await specCase(t, { latestFinish: 'after SSE response', sseClose: true, ...options });
    const result = c.artifacts.get('BROWSER_RESULT.json'), cleanup = c.artifacts.get('CLEANUP.json');
    const measured = c.artifacts.get('MEASUREMENTS.json'), acceptance = c.artifacts.get('ACCEPTANCE.json');
    const priorFailure = options.fail === 'privacy', fault = options.diagnosticRead !== undefined;
    assert.ok(result && cleanup && measured && acceptance);
    let expectedError;
    if (priorFailure) expectedError = c.failure;
    else if (fault) expectedError = c.publication;
    assert.equal(c.error, expectedError);
    assert.equal(c.cleanupResult.error, expectedError ?? null);
    assert.equal(cleanup.steps.length, 12);
    assert.deepEqual(cleanup.steps.filter(step => !step.ok).map(step => step.name), priorFailure ? ['root', 'allocation-parent'] : []);
    assert.equal(cleanup.pass, !priorFailure); assert.equal(cleanup.root_removed, !priorFailure); assert.equal(cleanup.parent_removed, !priorFailure);
    assert.equal(cleanup.retained_root, priorFailure ? '/synthetic/root' : null);
    assert.equal(cleanup.binding_unchanged, true); assert.equal(cleanup.fallback, false);
    assert.equal(cleanup.native.stopped, true); assert.equal(cleanup.native.drained, true);
    assert.equal(cleanup.native.input_ended, true); assert.equal(cleanup.native.code, 0);
    assert.equal(result.cleanup, !priorFailure); assert.equal(result.parent_removed, !priorFailure); assert.equal(c.allocation.removed, !priorFailure);
    assert.equal(c.events.filter(event => event === 'rm').length, priorFailure ? 0 : 1);
    assert.equal(c.events.filter(event => event === 'parent-rmdir').length, priorFailure ? 0 : 1);
    assert.equal(result.body_success, !priorFailure); assert.equal(measured.body_success, !priorFailure);
    assert.equal(measured.availability.native, priorFailure ? 'not_claimed' : 'available');
    assert.equal(measured.availability.browser, priorFailure ? 'not_claimed' : 'available');
    assert.equal(measured.availability.network, 'available'); assert.ok(measured.network);
    assert.deepEqual(result.counts, { latest: 1, sse: 1, task: 1, forbidden: 0, helper_http: 0, settings: 1, catalog: 1 });
    assert.equal(result.availability.counts, 'available'); assert.equal(acceptance.accepted, false);
    // ACCEPTANCE is an earlier serialized cutoff, not the final-result verdict.
    assert.equal(acceptance.pass, !priorFailure && options.diagnosticRead !== 1);
    assert.deepEqual(result.publication_failures, []);
    assert.deepEqual(result.preparation_failures, fault ? [{ artifact: options.diagnosticRead === 1 ? 'CLEANUP.json' : 'BROWSER_RESULT.json', field: 'diagnostics' }] : []);
    assert.equal(result.diagnostics === null, options.diagnosticRead === 2);
    assert.equal(cleanup.diagnostics === null, options.diagnosticRead === 1);
    assert.deepEqual(c.events.filter(event => event.startsWith('diagnostics-read:')), ['diagnostics-read:1', 'diagnostics-read:2']);
    if (!priorFailure) assert.ok(c.events.indexOf('parent-rmdir') < c.events.indexOf('diagnostics-read:1'));
    assert.ok(c.events.indexOf('diagnostics-read:1') < c.events.indexOf('save:CLEANUP.json'));
    assert.ok(c.events.indexOf('save:ACCEPTANCE.json') < c.events.indexOf('diagnostics-read:2'));
    assert.ok(c.events.indexOf('diagnostics-read:2') < c.events.indexOf('save:BROWSER_RESULT.json'));
    assert.equal(result.status, fault || priorFailure ? 'FAILED' : 'PASS');
    if (priorFailure) {
      assert.deepEqual(result.first_failure, c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'));
      assert.equal(result.first_failure.first_operation, 'privacy');
    } else if (fault) assert.equal(result.first_failure.first_operation, 'publication');
    else assert.equal(result.first_failure, null);
  });
});

test('D1 M2 actual callbacks retain known body failures without skipping safe resource closure', async t => {
  for (const [name, options, operation] of [
    ['prior privacy operation', { fail: 'privacy', diagnosticRead: 2 }, 'privacy'],
    ['observer second digest rejection', { digestReject: true }, 'append_dom'],
    ['observation generation mismatch', { observationMismatch: true }, 'append_dom'],
    ['body proof failure', { fail: 'body_proof' }, 'body_proof'],
    ['actual console privacy callback', { consoleFault: true }, 'privacy'],
    ['predelete collector fault', { late: 'modes-failed' }, 'collector_failed'],
  ]) await t.test(name, async t => {
    const c = await specCase(t, { latestFinish: 'after SSE response', sseClose: true, ...options });
    const cleanup = c.artifacts.get('CLEANUP.json'), result = c.artifacts.get('BROWSER_RESULT.json');
    const measured = c.artifacts.get('MEASUREMENTS.json'), acceptance = c.artifacts.get('ACCEPTANCE.json');
    assert.ok(c.firstOperationError); assert.equal(c.error, c.firstOperationError); assert.equal(c.cleanupResult.error, c.firstOperationError);
    if (!options.late) assert.equal(c.ownedError, c.firstOperationError);
    if (options.fail) assert.equal(c.error, c.failure);
    if (options.digestReject) assert.equal(c.digestCalls, 2);
    assert.equal(c.events.filter(event => event === 'rm').length, 0); assert.equal(c.events.filter(event => event === 'parent-rmdir').length, 0);
    assert.equal(cleanup.root_removed, false); assert.equal(cleanup.parent_removed, false); assert.equal(c.allocation.removed, false);
    assert.equal(cleanup.retained_root, '/synthetic/root'); assert.equal(cleanup.allocation.path, '/synthetic/wi-c54-private-ABC123');
    assert.equal(cleanup.pass, false); assert.equal(result.cleanup, false); assert.equal(result.parent_removed, false); assert.equal(result.status, 'FAILED');
    assert.equal(result.body_success, !!options.late); assert.equal(acceptance.pass, false); assert.equal(acceptance.accepted, false);
    assert.equal(cleanup.steps.length, 12);
    const rejected = options.consoleFault ? ['collector-drain', 'root', 'allocation-parent'] : ['root', 'allocation-parent'];
    assert.deepEqual(cleanup.steps.filter(step => !step.ok).map(step => step.name), rejected);
    for (const event of ['context-close', 'browser-close', 'server-close', 'native-stop', 'retire-tree']) assert.equal(c.events.filter(v => v === event).length, 1);
    for (const step of ['browser-final-discovery', 'context-close', 'browser-connection-close', 'browser-server-close', 'browser-emergency', 'browser-retirement', 'native-stop', 'native-abandon', 'native-retirement']) assert.equal(cleanup.steps.find(v => v.name === step).ok, true);
    for (const field of ['stopped', 'drained', 'input_ended', 'closed', 'retired']) assert.equal(cleanup.native[field], true);
    assert.equal(cleanup.native.code, 0); assert.equal(cleanup.native.stderr_bytes, 0); assert.equal(cleanup.native.fallback, false);
    assert.deepEqual(cleanup.native.readers, readers); assert.equal(cleanup.fallback, false); assert.equal(cleanup.binding_unchanged, true);
    assert.equal(cleanup.native_retirement.length, 1); assert.equal(cleanup.browser_retirement.length, 2);
    assert.ok([...cleanup.native_retirement, ...cleanup.browser_retirement].every(v => v.retirement === 'absent'));
    assert.ok(Object.isFrozen(c.firstPacket)); assert.ok(Object.isFrozen(c.firstPacket.phases)); assert.equal(c.firstPacket.first_operation, operation);
    assert.deepEqual(result.first_failure, c.firstPacket); assert.deepEqual(cleanup.first_failure, c.firstPacket);
    if (!options.late) assert.deepEqual(c.artifacts.get('FAILURE_BEFORE_CLEANUP.json'), c.firstPacket);
    assert.ok(measured.network); assert.equal(measured.availability.network, 'available'); assert.equal(result.availability.counts, 'available');
    assert.deepEqual(result.counts, measured.network.counts); assert.equal(measured.body_success, !!options.late);
    if (!options.late) { assert.equal(measured.native, null); assert.equal(measured.browser, null); }
    assert.equal(result.diagnostics === null, options.diagnosticRead === 2);
    assert.deepEqual(result.preparation_failures, options.diagnosticRead ? [{ artifact: 'BROWSER_RESULT.json', field: 'diagnostics' }] : []);
  });
});

test('C54B actual registered callback uses real renderer predicates A protocol and released capture before DOM', async t => {
  const c = await specCase(t, { sseClose: true }); assert.equal(c.error, undefined);
  assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'PASS'); assert.equal(c.artifacts.get('MEASUREMENTS.json').native.projection_sum_us, 6);
  assert.ok(c.events.indexOf('browser_arm') < c.events.indexOf('drive:arm')); assert.ok(c.events.indexOf('drive:second') < c.events.indexOf('append_dom'));
  assert.ok(c.events.indexOf('append_dom') < c.events.indexOf('drive:authoritative')); assert.ok(c.events.indexOf('authority_dom') < c.events.indexOf('drive:terminal'));
  assert.ok(c.events.lastIndexOf('tree') < c.events.indexOf('context-close')); assert.ok(c.events.indexOf('native-stop') < c.events.indexOf('rm'));
  assert.ok(c.events.indexOf('allocation') < c.events.indexOf('marker')); assert.ok(c.events.indexOf('binding') < c.events.indexOf('marker'));
  assert.ok(c.events.indexOf('rm') < c.events.indexOf('parent-rmdir')); assert.equal(c.allocation.removed, true);
});
test('C54BR2 actual registered callback completes both response-before-finished schedules with Task202 and strict cleanup', async t => {
  for (const latestFinish of ['before SSE response', 'after SSE response']) await t.test(latestFinish, async t => {
    const c = await specCase(t, { latestFinish, sseClose: true }); assert.equal(c.error, undefined);
    const result = c.artifacts.get('BROWSER_RESULT.json'), measured = c.artifacts.get('MEASUREMENTS.json');
    assert.equal(result.status, 'PASS'); assert.equal(result.first_failure, null); assert.equal(result.parent_removed, true);
    assert.equal(measured.network.operations.latest.requestfinished, true); assert.equal(measured.network.operations.task.status, 202);
    assert.deepEqual(result.counts, { latest: 1, sse: 1, task: 1, forbidden: 0, helper_http: 0, settings: 1, catalog: 1 });
    assert.ok(c.events.indexOf('latest-not-finished') < c.events.indexOf('handshake-ready'));
    assert.ok(c.events.indexOf('handshake-ready') < c.events.indexOf('task')); assert.equal(c.artifacts.get('CLEANUP.json').pass, true);
  });
});
test('C54B actual callback partial acquisition and early failure closes all acquired resources and preserves first rejection', async t => {
  for (const name of ['binding', 'root', 'native', 'server', 'identity', 'browser', 'context', 'page', 'goto', 'fresh', 'connect', 'handshake', 'task', 'first', 'first_dom',
    'browser_arm', 'native_arm', 'second', 'pages', 'append_dom', 'authority', 'authority_dom', 'terminal', 'terminal_dom', 'complete', 'observer_finish', 'privacy', 'body_proof']) await t.test(name, async t => {
    const c = await specCase(t, { fail: name }); assert.equal(c.error, c.failure); assert.equal(c.cleanupResult.error, c.failure);
    if (name === 'binding') { assert.equal(c.artifacts.size, 0); assert.ok(!c.events.includes('marker')); }
    else { assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED'); assert.equal(c.artifacts.get('BROWSER_RESULT.json').first_failure.first_operation, name); }
    if (c.events.includes('native-acquired')) assert.ok(c.events.includes('native-stop'));
    if (c.events.includes('server-acquired')) assert.ok(c.events.includes('server-close'));
    assert.ok(!c.events.includes('rm')); assert.ok(!c.events.includes('parent-rmdir'));
  });
});
test('C54B actual callback rejects preclose held discovery SSE loss and final predelete late faults or pending tasks', async t => {
  for (const late of ['discovery-failed', 'modes-failed', 'binding-failed', 'root-duplicate', 'retirement-failed', 'binding-pending-reject', 'root-pending-resolve', 'rm-started']) await t.test(late, async t => {
    const c = await specCase(t, { late }); assert.ok(c.error); assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED');
    assert.equal(c.events.includes('rm'), late === 'rm-started');
    if (late.includes('pending')) assert.equal(c.artifacts.get('CLEANUP.json').body_success, false);
    if (late === 'discovery-failed') assert.ok(c.events.indexOf('injected') < c.events.indexOf('context-close'));
    if (late.includes('pending')) assert.equal(c.network.facts().pending, 0);
    if (late === 'rm-started') { assert.equal(c.artifacts.get('CLEANUP.json').root_removed, true); assert.ok(!c.events.includes('parent-rmdir')); assert.equal(c.allocation.removed, false); }
  });
});
test('C54B actual callback cleanup failures retirement input close fallback and rejected ownership retain roots', async t => {
  for (const options of [{ fail: 'context-close' }, { fail: 'browser-close' }, { fail: 'server-close' }, { fail: 'native-stop' },
    { nativeDefect: 'input_ended' }, { nativeDefect: 'closed' }, { nativeDefect: 'fallback' }, { nativeDefect: 'drained' },
    { unknownRetirement: true }, { badIdentity: true }, { bindingChanged: true }]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, options); assert.ok(c.error); assert.ok(!c.events.includes('rm')); assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED');
    if (options.badIdentity) assert.ok(!c.events.includes('server-kill'));
  });
});
test('C54B actual callback independent lazy sibling getters serialization and writes preserve first failure and FAILED result', async t => {
  for (const options of [{ getter: 'native' }, { getter: 'network' }, ...['CLEANUP.json', 'MEASUREMENTS.json', 'ACCEPTANCE.json'].flatMap(name => [{ serialize: name }, { write: name }])]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, { fail: 'privacy', ...options }); assert.equal(c.error, c.failure); assert.equal(c.cleanupResult.error, c.failure);
    assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED'); assert.ok(c.artifacts.has('ACCEPTANCE.json') || options.serialize === 'ACCEPTANCE.json' || options.write === 'ACCEPTANCE.json');
    assert.equal(c.artifacts.get('BROWSER_RESULT.json').first_failure.first_operation, 'privacy');
  });
});
test('C54B final preparation failures after a successful body cannot publish PASS and leave sibling artifacts', async t => {
  for (const getter of ['native', 'network']) await t.test(getter, async t => {
    const c = await specCase(t, { getter }); assert.ok(c.error); assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED');
    assert.ok(c.artifacts.has('CLEANUP.json')); assert.ok(c.artifacts.has('MEASUREMENTS.json')); assert.ok(c.artifacts.has('ACCEPTANCE.json'));
    if (getter === 'native') assert.equal(c.artifacts.get('CLEANUP.json').availability.native, 'unavailable');
    else assert.equal(c.artifacts.get('MEASUREMENTS.json').availability.network, 'unavailable');
  });
});
test('C54B actual callback occupied ordinary output rejects before root native or browser acquisition', async t => {
  const c = await specCase(t, { occupied: true }); assert.ok(c.error); assert.ok(!c.events.includes('native-acquired')); assert.ok(!c.events.includes('server-acquired')); assert.equal(c.artifacts.size, 0);
});
test('C54B explicit binding no discovery and fresh output are inert until callback and reject malformed binding', async t => {
  const binding = { executable: '/synthetic/native' }, io = { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }), realpath: async p => p, readFile: async () => JSON.stringify(binding) };
  assert.deepEqual(await resolveBinding({ WI_C54_NATIVE_BINDING: '/synthetic/binding.json' }, io, async v => v), binding);
  for (const value of [undefined, '', 'relative']) await assert.rejects(resolveBinding({ WI_C54_NATIVE_BINDING: value }, io, trap));
  let builds = 0; const recorded = [];
  for (const path of ['/fresh/one', '/fresh/two']) { await reserveOutput({ outputPath: () => path }, {}, { mkdir: async (p, o) => { builds++; assert.equal(o.mode, 0o700); }, writeFile: async (p, raw, o) => { recorded.push(p); assert.equal(o.mode, 0o600); assert.equal(o.flag, 'wx'); } }); }
  assert.equal(builds, 2); assert.notEqual(recorded[0], recorded[1]);
  const source = await fs.readFile(specPath, 'utf8'), helper = await fs.readFile(new URL('../test-support/live-commit-measurements.mjs', import.meta.url), 'utf8'); assert.equal(sourceGuard(source, helper), true);
  for (const bad of ['discoverFixture()', 'test.skip(', 'response.json()', 'response.text()', 'response.arrayBuffer()', 'response.body()', 'globalThis.fetch =', 'newCDPSession()', 'fetch(']) assert.throws(() => sourceGuard(source + bad, helper));
});
test('C54B browser phase guards reject early final or terminal drives without replacing A protocol', async t => {
  for (const action of ['arm', 'second', 'authority', 'terminal', 'complete']) await t.test(action, async () => { let calls = 0; const d = phaseDrive({ request: async () => { calls++; } }); await assert.rejects(d[action]()); assert.equal(calls, 0); });
});
test('C54B actual renderer DOM mutations cannot manufacture human identity metadata ranges or terminal finish facts', async t => {
  const find = (root, kind) => root.find(n => n.dataset.entry === (kind === 'human' ? 'e:2:0' : 'e:5:0'))[0];
  const changes = [
    ['human-id', r => { find(r, 'human').dataset.entry = 'e:3:0'; }],
    ['human-generation', r => { find(r, 'human').querySelector('[data-field]').querySelector('.metadata').textContent = 'Recorded bytes: 22; generation: 3'; }],
    ['range-offset', r => { find(r).querySelector('[data-range]').dataset.range = 'text:1'; }],
    ['duplicate-range', r => { const field = find(r).querySelector('[data-field]'), range = field.querySelector('[data-range]'), extra = range.ownerDocument.createElement('pre'); extra.dataset.range = range.dataset.range; extra.textContent = range.textContent; field.append(extra); }],
    ['gap-node', r => { find(r).querySelector('[data-range]').tagName = 'P'; }],
    ['field-metadata', r => { find(r).querySelector('[data-field]').querySelector('.metadata').textContent = 'unknown'; }],
    ['entry-finish-lie', r => { find(r).querySelector(':scope > .metadata').textContent += '; finish_recorded: true'; }],
    ['missing-entry-state', r => { find(r).querySelector(':scope > .metadata').textContent = ''; }],
    ['missing-run-detail', r => { r.querySelector('.run').querySelector(':scope > details > pre').textContent = ''; }],
    ['wrong-kind', r => { find(r).querySelector('h4').textContent = 'tool'; }],
  ];
  for (const [name, mutate] of changes) await t.test(name, async t => {
    const h = rendered(t); await h.arm(); h.show('append', null, mutate); await new Promise(setImmediate); assert.equal(await h.poll('append'), null);
  });
  for (const kind of ['authority', 'terminal']) await t.test(`${kind} generation`, async t => {
    const h = rendered(t); await h.arm(); h.show('append'); await eventually(() => h.poll('append'));
    if (kind === 'terminal') { h.show('authority'); await eventually(() => h.poll('authority')); }
    h.show(kind, p => { p.entries[0].fields[0].generation = kind === 'terminal' ? '9' : '5'; });
    await new Promise(setImmediate); assert.equal(await h.poll(kind), null);
  });
});
test('C54B established SSE cancellation is singular and only admitted at actual close', async t => {
  for (const ending of ['failed', 'finished']) await t.test(ending, async () => {
    const c = netCase(), sse = await handshake(c, true); c.network.armTask(); deliver(c, taskRequest());
    c.network.closing(); c.network[ending](sse); c.network.proof(); c.network[ending](sse); assert.throws(() => c.network.proof());
  });
});
test('C54B root metadata validator rejects symlinks wrong modes aliases ownership and hardlinks', async t => {
  const directory = { uid: process.getuid(), mode: 0o700, nlink: 1, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false };
  const file = { ...directory, mode: 0o600, isDirectory: () => false, isFile: () => true };
  const io = { lstat: async p => p.endsWith('/file') ? file : directory, realpath: async p => p, readdir: async () => ['file'] };
  assert.equal(await modesProof('/synthetic', io), true);
  for (const defect of ['symlink', 'mode', 'uid', 'hardlink', 'alias']) await t.test(defect, async () => {
    const changed = { ...file }; if (defect === 'symlink') changed.isSymbolicLink = () => true;
    if (defect === 'mode') changed.mode = 0o644; if (defect === 'uid') changed.uid++;
    if (defect === 'hardlink') changed.nlink = 2;
    await assert.rejects(modesProof('/synthetic', { ...io, lstat: async p => p.endsWith('/file') ? changed : directory, realpath: async p => defect === 'alias' ? '/different' : p }));
  });
});

async function allocationOuter(t) {
  const outer = await fs.mkdtemp(join(process.env.TMPDIR, 'wi-c54-control-'));
  await fs.chmod(outer, 0o700);
  // The test owns this synthetic outer independently of the product's deletion authority.
  t.after(() => fs.rm(outer, { recursive: true })); return outer;
}
test('C54B actual filesystem accepts private explicit base with fresh parent and unchanged A root proofs', async t => {
  const scratch = process.env.TMPDIR, outer = await allocationOuter(t), progress = allocationProgress(), sibling = allocationProgress();
  assert.equal(await outerProof(outer), true);
  await allocateParent(outer, [], sibling);
  await allocateParent(outer, [join(outer, 'evidence'), join(outer, 'playwright')], progress);
  assert.equal(progress.phase, 'identity_verified'); assert.equal(progress.identity.mode, 0o700);
  const f = await createRoot(progress.path); assert.equal(await rootProof(f), true);
  progress.nested = 'acquired'; progress.phase = 'nested_fixture_acquired';
  await assert.rejects(removeAllocation(progress, outer, { root_removed: false, prior_cleanup_safe: true }));
  await assert.rejects(removeAllocation(progress, outer, { root_removed: true, prior_cleanup_safe: false }));
  assert.equal(progress.removed, false); await fs.rm(f.root, { recursive: true });
  await removeAllocation(progress, outer, { root_removed: true, prior_cleanup_safe: true });
  assert.equal(progress.removed, true); await assert.rejects(fs.lstat(progress.path), { code: 'ENOENT' });
  assert.equal((await fs.lstat(outer)).mode & 0o7777, 0o700);
  assert.notEqual(progress.path, sibling.path); assert.equal(await allocationProof(sibling.identity, outer).then(() => true), true);
  await fs.rmdir(sibling.path); assert.deepEqual(await fs.readdir(outer), []); assert.equal(process.env.TMPDIR, scratch);
});
test('C54B actual allocation captures path before rejected or unavailable identity without deletion authority', async t => {
  for (const kind of ['mode', 'unavailable', 'canonical', 'uid', 'symlink', 'inode']) await t.test(kind, async t => {
    const outer = await allocationOuter(t), progress = allocationProgress(); let metadataReads = 0;
    const io = { ...fs, lstat: async p => {
      if (p !== outer) {
        assert.equal(progress.path, p); assert.equal(progress.phase, 'path_returned');
        if (kind === 'unavailable') throw new Error('Synthetic unavailable metadata');
        if (kind === 'mode') await fs.chmod(p, 0o755);
      }
      const s = await fs.lstat(p);
      if (p !== outer && kind === 'uid') return { ...s, isDirectory: () => true, isSymbolicLink: () => false, uid: s.uid + 1 };
      if (p !== outer && kind === 'symlink') return { ...s, isDirectory: () => true, isSymbolicLink: () => true };
      if (p !== outer && kind === 'inode') return { ...s, isDirectory: () => true, isSymbolicLink: () => false, ino: s.ino + ++metadataReads };
      return s;
    }, realpath: async p => p !== outer && kind === 'canonical' ? outer : fs.realpath(p) };
    await assert.rejects(allocateParent(outer, [], progress, io));
    assert.equal(progress.phase, 'path_returned'); assert.equal(progress.identity, null); assert.equal(progress.removed, false);
    await assert.rejects(removeAllocation(progress, outer, { root_removed: true, prior_cleanup_safe: true }));
    assert.equal((await fs.lstat(progress.path)).isDirectory(), true);
  });
});
test('C54B actual parent validation rejects unsafe outer modes and occupied allocation is never adopted', async t => {
  const outer = await allocationOuter(t);
  for (const mode of [0o755, 0o775, 0o757, 0o555, 0o655, 0o1700, 0o2700, 0o4700]) {
    await fs.chmod(outer, mode); await assert.rejects(outerProof(outer));
  }
  await fs.chmod(outer, 0o700);
  const old = allocationProgress(), fresh = allocationProgress(); await allocateParent(outer, [], old); await allocateParent(outer, [], fresh);
  assert.notEqual(fresh.path, old.path);
  const progress = allocationProgress();
  await assert.rejects(allocateParent(outer, [], progress, { ...fs, mkdtemp: async () => { throw new Error('Synthetic occupied allocation'); } }));
  assert.equal(progress.phase, 'no_path'); assert.equal(progress.path, null);
  await assert.rejects(resolveAllocation({ WI_BROWSER_FIXTURE_PARENT: outer, WI_C54_ALLOCATION_PARENT: JSON.stringify({ ...old.identity, inode: old.identity.inode + 1 }) }, allocationProgress()));
});
test('C54B actual nonrecursive parent removal retains unexpected contents and identity or removal failures', async t => {
  for (const kind of ['contents', 'identity', 'rmdir']) await t.test(kind, async t => {
    const outer = await allocationOuter(t), p = allocationProgress(); await allocateParent(outer, [], p);
    p.phase = 'nested_fixture_acquired'; p.nested = 'acquired';
    if (kind === 'contents') await fs.writeFile(join(p.path, 'unexpected'), '', { mode: 0o600, flag: 'wx' });
    if (kind === 'identity') await fs.chmod(p.path, 0o755);
    const io = { ...fs, rm: trap, rmdir: async (...args) => { assert.deepEqual(args, [p.path]); if (kind === 'rmdir') throw new Error('Synthetic rmdir failure'); return fs.rmdir(...args); } };
    await assert.rejects(removeAllocation(p, outer, { root_removed: true, prior_cleanup_safe: true }, io));
    assert.equal(p.removed, false); assert.equal((await fs.lstat(p.path)).isDirectory(), true);
  });
});
test('C54B actual callback rejects unknown or rejected parent identity before marker native or browser acquisition', async t => {
  for (const options of [{ parentUnknown: true }, { parentRejected: true }]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, options); assert.ok(c.error); assert.equal(c.artifacts.size, 0);
    assert.equal(c.allocation.phase, 'path_returned'); assert.equal(c.allocation.identity, null);
    for (const event of ['marker', 'nested-create', 'native-acquired', 'server-acquired', 'parent-rmdir']) assert.ok(!c.events.includes(event));
  });
});
test('C54B actual callback retains known parent and unknown nested state when A provisioning rejects', async t => {
  for (const kind of ['partial', 'after-A']) await t.test(kind, async t => {
    const outer = await allocationOuter(t), p = allocationProgress(); await allocateParent(outer, [], p);
    let nested;
    const c = await specCase(t, { allocationIo: fs, allocationEnv: { WI_BROWSER_FIXTURE_PARENT: outer, WI_C54_ALLOCATION_PARENT: JSON.stringify(p.identity) }, createNested: async path => {
      assert.equal(path, p.path);
      if (kind === 'after-A') { const f = await createRoot(path); await rootProof(f); nested = f.root; }
      else { nested = await fs.mkdtemp(join(path, 'wi-live-commit-')); await fs.mkdir(join(nested, 'workspace'), { mode: 0o700 }); }
      throw new Error('Synthetic nested boundary rejection');
    } });
    assert.ok(c.error); assert.equal(c.allocation.phase, 'identity_verified'); assert.equal(c.allocation.nested, 'partial_unknown');
    const cleanup = c.artifacts.get('CLEANUP.json'); assert.equal(cleanup.nested_availability, 'partial_unknown');
    assert.equal(cleanup.allocation.path, p.path); assert.equal(cleanup.parent_removed, false); assert.equal(cleanup.root_removed, false);
    assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED'); assert.equal((await fs.lstat(nested)).isDirectory(), true);
    for (const event of ['native-acquired', 'server-acquired', 'rm', 'parent-rmdir']) assert.ok(!c.events.includes(event));
    assert.deepEqual(c.cleanupResult.steps, [{ name: 'allocation-parent', ok: false }]);
  });
});
test('C54B actual callback continues cleanup but never sweeps parent after root or earlier cleanup failure', async t => {
  for (const fail of ['rm', 'root_cleanup', 'context-close', 'parent-rmdir']) await t.test(fail, async t => {
    const c = await specCase(t, { fail }); assert.ok(c.error);
    assert.ok(c.events.includes('allocation_cleanup')); assert.equal(c.allocation.removed, false);
    assert.equal(c.events.includes('parent-rmdir'), fail === 'parent-rmdir');
    assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED'); assert.equal(c.artifacts.get('CLEANUP.json').pass, false);
    if (fail === 'parent-rmdir') assert.equal(c.artifacts.get('CLEANUP.json').root_removed, true);
  });
});
test('C54B actual invocation preflight validates readiness binding and parent before OUTER then callback marker', async t => {
  for (const fail of ['none', 'readiness', 'binding', 'metadata', 'second-readiness']) await t.test(fail, async t => {
    const outer = await allocationOuter(t), progress = allocationProgress(), events = []; let reads = 0;
    const run = prepareInvocation({ env: { WI_BROWSER_FIXTURE_PARENT: outer }, excluded: [join(outer, 'evidence'), join(outer, 'playwright')], progress,
      readiness: async () => { events.push('ready'); if (fail === 'readiness' || fail === 'second-readiness' && ++reads === 2) throw new Error('Synthetic readiness failure'); },
      consume: async () => { events.push('OUTER'); assert.equal(progress.phase, 'identity_verified');
        await reserveOutput({ outputPath: () => join(outer, 'evidence') }, {}, { ...fs, writeFile: async (...args) => { events.push('callback'); return fs.writeFile(...args); } }); },
    }, { ...fs, lstat: async p => { if (fail === 'metadata' && p !== outer) { assert.equal(progress.path, p); throw new Error('Synthetic metadata failure'); } return fs.lstat(p); } },
    async () => { events.push('binding'); if (fail === 'binding') throw new Error('Synthetic binding failure'); return {}; });
    if (fail === 'none') { await run; assert.deepEqual(events, ['ready', 'binding', 'ready', 'OUTER', 'callback']); }
    else { await assert.rejects(run); assert.ok(!events.includes('OUTER')); assert.ok(!events.includes('callback'));
      if (['metadata', 'second-readiness'].includes(fail)) { assert.equal(typeof progress.path, 'string'); assert.equal(progress.removed, false); assert.equal((await fs.lstat(progress.path)).isDirectory(), true); }
    }
  });
});

test('C67 invalid base syntax rejects before filesystem reads or allocation effects', async t => {
  for (const value of [undefined, null, 1, {}, new String('/synthetic'), new URL('file:///synthetic'), '', 'relative', '/bad\0base', '/bad\ud800base', '/synthetic/', '/synthetic/.', '/synthetic/../synthetic', '//synthetic']) await t.test(String(value), async () => {
    const p = allocationProgress(), io = { lstat: trap, realpath: trap, mkdtemp: trap };
    await assert.rejects(outerProof(value, io), { message: 'Live measurement rejected' });
    await assert.rejects(allocateParent(value, [], p, io), { message: 'Live measurement rejected' });
    assert.deepEqual(p, allocationProgress());
  });
});
test('C67 existing base must be canonical nonsymlink owned and exactly private before allocation', async t => {
  for (const kind of ['missing', 'file', 'link', 'alias', 'public', 'sticky', 'setgid', 'setuid', 'uid']) await t.test(kind, async t => {
    const outer = await allocationOuter(t), base = join(outer, 'base'), p = allocationProgress();
    if (kind === 'file') await fs.writeFile(base, '', { mode: 0o600 });
    else if (kind !== 'missing') await fs.mkdir(base, { mode: 0o700 });
    let supplied = base;
    if (kind === 'link' || kind === 'alias') {
      await fs.symlink(base, join(outer, 'alias')); supplied = join(outer, 'alias');
      if (kind === 'alias') { await fs.mkdir(join(base, 'nested'), { mode: 0o700 }); supplied += '/nested'; }
    }
    if (kind === 'public') await fs.chmod(base, 0o755);
    if (kind === 'sticky') await fs.chmod(base, 0o1700);
    if (kind === 'setgid') await fs.chmod(base, 0o2700);
    if (kind === 'setuid') await fs.chmod(base, 0o4700);
    const io = { ...fs, mkdtemp: trap, lstat: async path => {
      const s = await fs.lstat(path);
      if (kind === 'uid') return { ...s, uid: s.uid + 1, isDirectory: () => true, isSymbolicLink: () => false };
      return s;
    } };
    await assert.rejects(allocateParent(supplied, [], p, io), error => kind === 'missing' ? error.code === 'ENOENT' : error.message === 'Live measurement rejected');
    assert.deepEqual(p, allocationProgress());
  });
});
test('C67 base I/O errors remain the original error and do not grant allocation authority', async t => {
  for (const boundary of ['lstat', 'realpath']) await t.test(boundary, async () => {
    const failure = new Error('Synthetic base I/O failure'), p = allocationProgress();
    const io = { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o700 }),
      realpath: async path => path, mkdtemp: trap, [boundary]: async () => { throw failure; } };
    await assert.rejects(allocateParent('/synthetic', [], p, io), error => error === failure);
    assert.deepEqual(p, allocationProgress());
  });
});
test('C67 explicit base is captured after readiness and binding and reused across allocation and reproof', async t => {
  const outer = await allocationOuter(t), scratch = await allocationOuter(t), p = allocationProgress(), events = [];
  let reads = 0, ready = 0, bound = false;
  const env = { TMPDIR: scratch, get WI_BROWSER_FIXTURE_PARENT() {
    assert.equal(ready, 1); assert.equal(bound, true); assert.equal(++reads, 1); return outer;
  } };
  const result = await prepareInvocation({ env, excluded: [], progress: p,
    readiness: async () => { events.push('ready'); ready++; }, consume: async value => { events.push('consume'); return value; },
  }, { ...fs, mkdtemp: async prefix => { assert.equal(prefix, join(outer, 'wi-c54-private-')); events.push('allocate'); return fs.mkdtemp(prefix); } },
  async value => { assert.equal(value, env); events.push('bind'); bound = true; return { synthetic: true }; });
  assert.equal(reads, 1); assert.deepEqual(events, ['ready', 'bind', 'allocate', 'ready', 'consume']);
  assert.deepEqual(result, { binding: { synthetic: true }, progress: p });
  const resolved = allocationProgress(); let resolveReads = 0;
  await resolveAllocation({ TMPDIR: scratch, WI_C54_ALLOCATION_PARENT: JSON.stringify(p.identity),
    get WI_BROWSER_FIXTURE_PARENT() { assert.equal(++resolveReads, 1); return outer; } }, resolved);
  assert.deepEqual(resolved, p); assert.equal(resolveReads, 1); assert.deepEqual(await fs.readdir(scratch), []);
});
test('C67 missing explicit base never falls back to valid private scratch', async t => {
  const outer = await allocationOuter(t), p = allocationProgress(); await allocateParent(outer, [], p);
  const env = { TMPDIR: outer, WI_C54_ALLOCATION_PARENT: JSON.stringify(p.identity) }, progress = allocationProgress();
  await assert.rejects(prepareInvocation({ env, excluded: [], progress, readiness: async () => {}, consume: trap }, { ...fs, mkdtemp: trap }, async () => ({})), { message: 'Live measurement rejected' });
  assert.deepEqual(progress, allocationProgress());
  const resolved = allocationProgress(); await assert.rejects(resolveAllocation(env, resolved));
  assert.equal(resolved.identity, null); assert.equal(resolved.phase, 'path_returned');
  const c = await specCase(t, { runtimeEnv: { TMPDIR: '/synthetic', WI_C54_ALLOCATION_PARENT: JSON.stringify({ path: '/synthetic/wi-c54-private-ABC123', uid: process.getuid(), mode: 0o700, device: 1, inode: 2 }) } });
  assert.equal(c.error?.message, 'Live measurement rejected'); assert.equal(c.firstPacket.first_operation, 'allocation'); assert.equal(c.artifacts.size, 0);
  for (const event of ['reserve', 'marker', 'nested-create', 'native-acquired', 'server-acquired', 'parent-rmdir']) assert.ok(!c.events.includes(event));
});
test('C67 actual callback snapshots the base only at allocation and keeps it through root and parent cleanup', async t => {
  for (const kind of ['second-read', 'mutation']) await t.test(kind, async t => {
    let reads = 0;
    const env = { TMPDIR: '/synthetic/scratch', WI_C54_ALLOCATION_PARENT: JSON.stringify({ path: '/synthetic/wi-c54-private-ABC123', uid: process.getuid(), mode: 0o700, device: 1, inode: 2 }),
      get WI_BROWSER_FIXTURE_PARENT() { assert.equal(++reads, 1); return '/synthetic'; },
      set WI_BROWSER_FIXTURE_PARENT(value) { assert.equal(value, '/synthetic/changed'); Object.defineProperty(this, 'WI_BROWSER_FIXTURE_PARENT', { value, writable: true }); },
    };
    const c = await specCase(t, { runtimeEnv: env, baseSnapshot: true, beforeCallback: () => assert.equal(reads, 0), mutateBaseAt: kind === 'mutation' ? 'native_stop' : undefined });
    assert.equal(reads, 1); assert.equal(c.error, undefined); assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'PASS');
    assert.deepEqual(c.removals, [{ kind: 'root', args: ['/synthetic/root', { recursive: true }] }, { kind: 'parent', args: ['/synthetic/wi-c54-private-ABC123'] }]);
    assert.equal(c.allocation.removed, true);
  });
});
test('C67 actual registered callback rejects invalid runtime base before output or acquisition', async t => {
  for (const value of [undefined, null, '', 'relative', '/bad\0base', '/bad\ud800base', '/synthetic/', '/synthetic/../synthetic', '/synthetic/other']) await t.test(String(value), async t => {
    let reads = 0;
    const env = { TMPDIR: '/synthetic', WI_C54_ALLOCATION_PARENT: JSON.stringify({ path: '/synthetic/wi-c54-private-ABC123', uid: process.getuid(), mode: 0o700, device: 1, inode: 2 }),
      get WI_BROWSER_FIXTURE_PARENT() { reads++; return value; } };
    const c = await specCase(t, { runtimeEnv: env, beforeCallback: () => assert.equal(reads, 0) });
    assert.ok(c.error); assert.equal(reads, 1); assert.equal(c.artifacts.size, 0); assert.equal(c.allocation.identity, null);
    for (const event of ['reserve', 'marker', 'nested-create', 'native-acquired', 'server-acquired', 'parent-rmdir']) assert.ok(!c.events.includes(event));
  });
});
test('C67 child identity shape direct relationship and excluded overlap remain strict', async t => {
  const outer = await allocationOuter(t), wrong = await allocationOuter(t), p = allocationProgress(); await allocateParent(outer, [], p);
  for (const field of ['path', 'uid', 'mode', 'device', 'inode', 'extra', 'missing']) await t.test(field, async () => {
    const value = { ...p.identity };
    if (field === 'path') value.path = join(p.path, 'wi-c54-private-NESTED');
    else if (field === 'extra') value.extra = 1;
    else if (field === 'missing') delete value.device;
    else value[field]++;
    await assert.rejects(allocationProof(value, outer));
  });
  await assert.rejects(allocationProof(p.identity, wrong));
  for (const defect of ['file', 'device']) await t.test(defect, async () => {
    await assert.rejects(allocationProof(p.identity, outer, { ...fs, lstat: async path => {
      const s = await fs.lstat(path); if (path === outer) return s;
      return { ...s, dev: defect === 'device' ? s.dev + 1 : s.dev, isDirectory: () => defect !== 'file', isSymbolicLink: () => false };
    } }));
  });
  for (const relation of ['same', 'ancestor', 'descendant']) await t.test(relation, async () => {
    const progress = allocationProgress();
    let excluded = p.path;
    if (relation === 'ancestor') excluded = outer;
    if (relation === 'descendant') excluded = join(p.path, 'nested');
    await assert.rejects(allocateParent(outer, [excluded], progress, { ...fs, mkdtemp: async () => p.path }));
    assert.equal(progress.path, p.path); assert.equal(progress.phase, 'path_returned'); assert.equal(progress.identity, null);
  });
  assert.equal(await allocationProof(p.identity, outer).then(() => true), true);
});

test('C89 live actual callback appends one result-level checkpoint only after all artifact attempts', async t => {
  for (const options of [{ fail: 'privacy' }, { fail: 'context-close' }, { write: 'MEASUREMENTS.json' }]) await t.test(JSON.stringify(options), async t => {
    const c = await specCase(t, options);
    assert.equal(c.annotations.length, 1); assert.equal(c.annotations[0].type, annotationType);
    const tuple = JSON.parse(c.annotations[0].description);
    assert.equal(tuple[0], 1); assert.equal(tuple[1], 1);
    assert.equal(livePhases[tuple[2] - 1], c.artifacts.get('BROWSER_RESULT.json').first_failure.first_operation);
    assert.equal(tuple[3], !options.fail || options.fail === 'context-close');
    assert.equal(tuple[4], c.artifacts.get('CLEANUP.json').pass);
    const failed = c.cleanupResult.steps.find(s => !s.ok);
    assert.equal(tuple[5], failed ? cleanupSteps.indexOf(failed.name) + 1 : null);
    assert.equal(c.error, c.cleanupResult.error);
    assert.ok(c.events.indexOf('annotation') > c.events.indexOf('save:BROWSER_RESULT.json'));
  });
  const success = await specCase(t); assert.deepEqual(success.annotations, []); assert.equal(success.error, undefined);
});
test('C89 live actual callback contains TestInfo access and append failures without changing first error or artifacts', async t => {
  for (const option of ['annotationAccess', 'annotationAppend']) await t.test(option, async t => {
    const c = await specCase(t, { fail: 'privacy', [option]: true });
    assert.equal(c.error, c.failure); assert.equal(c.cleanupResult.error, c.failure); assert.deepEqual(c.annotations, []);
    assert.deepEqual(c.artifacts.get('BROWSER_RESULT.json').first_failure, c.firstPacket);
    assert.equal(c.artifacts.get('BROWSER_RESULT.json').status, 'FAILED'); assert.equal(c.cleanupResult.steps.length, 12);
  });
});
