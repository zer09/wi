import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as catalogDiagnostics from '../test-support/catalog-pagination.mjs';
import { mountDisplayView } from '../dist/display-view.js';
import { model, controller, button } from '../test-support/display-dom.mjs';
import { createDisplayClient } from '../dist/display-client.js';
import { ROWS, FIRST_PATH, MORE_PATH, SETTINGS, catalogPage, pageProof, expectedRows, rowsProof,
  catalogPipeline, cleanupOwned, requireFact, AS_OF } from '../test-support/catalog-pagination.mjs';

const TOKEN = '0123456789abcdef'.repeat(4);
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const clone = value => structuredClone(value);
function clientHarness(change = value => value) {
  const pipeline = catalogPipeline(), calls = [];
  const client = createDisplayClient({ fetch: async (path, init) => {
    calls.push({ path, init }); return response(change(pipeline.reply(init.method, path), calls.length));
  }, crypto: { randomUUID() { throw Error('Unexpected mutation'); } } });
  return { client, calls, pipeline };
}

test('33 closed ready rows use ID order, distinct metadata and nonnull final cursors', () => {
  assert.equal(ROWS.length, 33); assert.equal(new Set(ROWS.map(r => r.session_id)).size, 33);
  assert.equal(new Set(ROWS.map(r => r.title)).size, 33);
  assert.ok(ROWS.every((r, i) => i === 0 || ROWS[i - 1].session_id < r.session_id && BigInt(ROWS[i - 1].updated_at_ms) > BigInt(r.updated_at_ms)));
  assert.equal(pageProof(catalogPage()).entries.length, 32);
  assert.equal(pageProof(catalogPage(true), ROWS[31].session_id).next_after_id, ROWS[32].session_id);
  assert.equal(catalogPage(true).has_more, false);
  rowsProof(expectedRows()); rowsProof(expectedRows(true), true);
  assert.throws(() => rowsProof(expectedRows().reverse()), /C61:dom/);
});

const corruptions = [
  ['null final cursor', p => { p.next_after_id = null; }],
  ['wrong final cursor', p => { p.next_after_id = ROWS[0].session_id; }],
  ['malformed cursor', p => { p.next_after_id = 'invalid'; }],
  ['nil cursor', p => { p.next_after_id = '00000000-0000-0000-0000-000000000000'; }],
  ['duplicate IDs', p => { p.entries[1] = p.entries[0]; }],
  ['out of order', p => { p.entries.reverse(); p.next_after_id = p.entries.at(-1).session_id; }],
  ['33 in one page', p => { p.entries = [...ROWS]; p.next_after_id = ROWS[32].session_id; }],
  ['unknown field', p => { p.private = true; }],
  ['invalid ready metadata', p => { p.entries[0].observed_head_sequence = '0'; }],
];
for (const [name, mutate] of corruptions) test(`page and actual client reject ${name} without installing catalog`, async () => {
  const bad = clone(catalogPage()); mutate(bad);
  assert.throws(() => pageProof(bad));
  const h = clientHarness((value, n) => n === 2 ? bad : value);
  await h.client.connect(TOKEN);
  assert.equal(h.client.snapshot().catalog, null);
  assert.equal(h.client.snapshot().connection, 'disconnected');
  assert.equal(h.client.snapshot().error.category, 'protocol');
  assert.equal(h.calls.length, 2); h.client.disconnect();
});
for (const [name, mutate] of [
  ['null tail cursor', p => { p.next_after_id = null; }],
  ['wrong tail cursor', p => { p.next_after_id = ROWS[31].session_id; }],
  ['repeated boundary', p => { p.entries = [ROWS[31]]; p.next_after_id = ROWS[31].session_id; }],
  ['older tail', p => { p.entries = [ROWS[0]]; p.next_after_id = ROWS[0].session_id; }],
]) test(`actual append rejects ${name} and retains first page`, async () => {
  const bad = clone(catalogPage(true)); mutate(bad);
  assert.throws(() => pageProof(bad, ROWS[31].session_id));
  const h = clientHarness((value, n) => n === 3 ? bad : value);
  await h.client.connect(TOKEN); const first = h.client.snapshot().catalog;
  await h.client.loadMoreSessions();
  assert.deepEqual(h.client.snapshot().catalog, first);
  assert.equal(h.client.snapshot().error.category, 'protocol'); h.client.disconnect();
});

test('actual client follows settings -> first32 -> explicit exact after_id -> refresh reset, never automatic tail', async () => {
  const h = clientHarness();
  await h.client.connect(TOKEN);
  assert.equal(h.calls.length, 2); assert.deepEqual(h.client.snapshot().catalog.entries, ROWS.slice(0, 32));
  assert.equal(h.client.snapshot().selected, null);
  await h.client.loadMoreSessions();
  assert.deepEqual(h.client.snapshot().catalog.entries, ROWS);
  assert.equal(h.client.snapshot().catalog.has_more, false);
  assert.equal(h.client.snapshot().catalog.next_after_id, ROWS[32].session_id);
  await h.client.loadMoreSessions(); assert.equal(h.calls.length, 3);
  await h.client.refreshSessions();
  assert.deepEqual(h.client.snapshot().catalog.entries, ROWS.slice(0, 32));
  assert.equal(h.client.snapshot().catalog.has_more, true); h.pipeline.complete();
  assert.deepEqual(h.calls.map(c => c.path), ['/v1/settings', FIRST_PATH, MORE_PATH, FIRST_PATH]);
  for (const { init } of h.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.body, undefined); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit');
  }
  h.client.disconnect();
});

test('held first page prevents pipelined load-more; held tail admits only one exact cursor', async () => {
  const calls = []; let release;
  const client = createDisplayClient({ fetch: async (path, init) => {
    calls.push(path); assert.equal(init.method, 'GET');
    if (path === '/v1/settings') return response(SETTINGS);
    return new Promise(resolve => { release = value => resolve(response(value)); });
  }, crypto: {} });
  const connecting = client.connect(TOKEN);
  await new Promise(resolve => setImmediate(resolve));
  await client.loadMoreSessions(); assert.deepEqual(calls, ['/v1/settings', FIRST_PATH]);
  release(catalogPage()); await connecting;
  const tail = client.loadMoreSessions(); await client.loadMoreSessions();
  assert.deepEqual(calls, ['/v1/settings', FIRST_PATH, MORE_PATH]);
  release(catalogPage(true)); await tail;
  assert.deepEqual(client.snapshot().catalog.entries, ROWS); client.disconnect();
});

for (const path of [FIRST_PATH, '/v1/settings?x=1', '/v1/sessions?limit=31']) test(`pipeline rejects premature or wrong settings request ${path}`, () => {
  const p = catalogPipeline(); assert.throws(() => p.reply('GET', path), /C61:traffic/); assert.equal(p.count(), 0);
});
for (const path of [FIRST_PATH, '/v1/sessions?limit=32&after_id=null', `${FIRST_PATH}&after_id=${ROWS[0].session_id}`,
  `/v1/sessions?after_id=${ROWS[31].session_id}&limit=32`, `${MORE_PATH}&limit=32`]) test(`pipeline rejects wrong append request ${path}`, () => {
  const p = catalogPipeline(); p.reply('GET', '/v1/settings'); p.reply('GET', FIRST_PATH);
  assert.throws(() => p.reply('GET', path), /C61:traffic/); assert.equal(p.count(), 2);
});
for (const method of ['POST', 'HEAD', 'PUT']) test(`pipeline rejects ${method} and incomplete or excessive pipeline`, () => {
  const p = catalogPipeline(); assert.throws(() => p.reply(method, '/v1/settings'), /C61:traffic/);
  assert.throws(() => p.complete(), /C61:traffic/);
  for (const path of ['/v1/settings', FIRST_PATH, MORE_PATH, FIRST_PATH]) p.reply('GET', path);
  p.complete(); assert.throws(() => p.reply('GET', MORE_PATH), /C61:traffic/);
});

test('cleanup preserves original error and attempts every close in order', async () => {
  const first = Error('original'), later = Error('cleanup'), calls = [];
  const steps = [['context', async () => { calls.push('context'); throw later; }],
    ['transport', async () => { calls.push('transport'); }], ['native', async () => { calls.push('native'); }]];
  const r = await cleanupOwned(steps, first);
  assert.equal(r.error, first); assert.deepEqual(calls, ['context', 'transport', 'native']);
  assert.deepEqual(r.facts.map(s => s.pass), [false, true, true]);
  assert.equal((await cleanupOwned(steps)).error, later);
});

test('reusable spec uses ordinary path binding and excludes discovery, API body readers and global instrumentation', async () => {
  const text = await readFile(new URL('../e2e/catalog-pagination.spec.mjs', import.meta.url), 'utf8');
  assert.match(text, /process\.env\.WI_C3A_FIXTURE/); assert.match(text, /executableBinding\(executable, process\.env\.WI_C3A_FIXTURE_SHA256\)/);
  assert.match(text, /info\.outputPath\('c61'\)/); assert.match(text, /flag: 'wx'/);
  for (const banned of ['discoverFixture', 'newCDPSession', 'addInitScript', 'waitForTimeout', 'setTimeout(', 'postDataJSON', 'reply.json()', 'reply.text()', 'route.fulfill', 'test.skip', 'test.only']) assert.ok(!text.includes(banned), banned);
  assert.match(text, /if \(file\) assetReads\.push/); assert.match(text, /reply\.body\(\)/);
  assert.ok(!text.includes('/home/'));
});

// Execute the shipped observation and packet code, not a second diagnostic implementation.
const spec = await readFile(new URL('../e2e/catalog-pagination.spec.mjs', import.meta.url), 'utf8');
const observeSource = spec.slice(spec.indexOf('  async function observe('), spec.indexOf('  try {\n    await mkdir(output'));
const faultsSource = spec.slice(spec.indexOf('  async function checkFaults('), spec.indexOf('  async function observe('));
const packetSource = spec.slice(spec.indexOf('    original = error;'), spec.indexOf('    if (outputOwned) await writeFile'));
const diagnosticSource = spec.includes('  function diagnosticSnapshot(')
  ? spec.slice(spec.indexOf('  function diagnosticSnapshot('), spec.indexOf('  async function checkFaults(')) : '';
const diagnosticState = spec.match(/^  let eventSeq = 0, requestFailureTotal = 0;\n  const requestFailures = \[\];$/m)?.[0] ?? '';
function observationHarness() {
  const state = { reject: null, tail: false, count: 2, paginator: { hidden: false, disabled: false } };
  const result = { first: null, observations: {} }, calls = [], faults = { traffic: 0 }, assets = new Set(['asset']), assetReads = [];
  const privateError = Error('private-operator-secret must never enter a packet');
  const hit = name => { if (state.reject === name) throw privateError; };
  const list = {
    async evaluateAll(callback) {
      const rows = expectedRows(state.tail).map(row => ({ textContent: row.title + row.metadata,
        querySelector(selector) { return { textContent: selector === 'button' ? row.title : row.metadata, getAttribute: () => row.current }; } }));
      const value = callback(rows);
      if (typeof value[0] === 'string') hit('content'); else hit('rows_await');
      if (state.reject === 'rows' && typeof value[0] !== 'string') value[0].title = 'wrong';
      return value;
    },
  };
  const more = { async isHidden() { hit('paginator_state'); return state.paginator.hidden; } };
  const page = {
    locator(selector) { assert.equal(selector, '.session-list li'); return list; },
    getByRole(role, options) {
      hit('paginator'); assert.equal(role, 'button'); assert.equal(options.name, 'Load more sessions'); assert.equal(options.exact, true);
      assert.equal(options.includeHidden, true); return more;
    },
    getByLabel(label) {
      assert.equal(label, 'Sessions');
      return { getByText(text) { assert.equal(text, AS_OF); return { async count() { hit('as_of_await'); return state.reject === 'as_of' ? 0 : 1; } }; } };
    },
  };
  const expect = value => ({
    async toHaveCount(count) { assert.equal(value, list); hit('row_count'); assert.equal(count, state.tail ? 33 : 32); },
    async toBeHidden() { assert.equal(value, more); hit('paginator_hidden'); assert.equal(state.paginator.hidden, true); },
    async toBeVisible() { assert.equal(value, more); hit('paginator_visible'); assert.equal(state.paginator.hidden, false); },
    async toBeEnabled() { assert.equal(value, more); hit('paginator_enabled'); assert.equal(state.paginator.disabled, false); },
    async toBeDisabled() { assert.fail('The retained renderer hides the tail without disabling it'); },
  });
  expect.poll = callback => ({ async toBe(expected) { assert.equal(await callback(), expected); } });
  const frames = async () => { hit('frames'); if (state.reject === 'tail_extra_read') calls.push({ ...calls[0] }); };
  const hash = value => { hit('digest'); return createHash('sha256').update(value).digest('hex'); };
  const boundary = async () => { hit('privacy_await'); requireFact(state.reject !== 'privacy', 'privacy'); };
  const scopeSource = spec.match(/^  let observation = null, failedObservation = null;$/m)?.[0]
    ?? 'let observation = null, failedObservation = null;';
  const actual = new Function('page', 'calls', 'pipeline', 'result', 'expect', 'rowsProof', 'requireFact', 'AS_OF',
    'frames', 'hash', 'boundary', 'context', 'fixture', 'assetReads', 'faults', 'assets', 'files', 'classifyCatalogRoute', `
    ${scopeSource}
    ${diagnosticState}
    let original = null, stage = 'more';
    ${diagnosticSource}
    ${faultsSource}
    ${observeSource}
    return { observe, scope: () => observation, failed: () => failedObservation,
      packet(error) { ${packetSource} return result.first; } };
  `)(page, calls, { count: () => state.count }, result, expect, rowsProof, requireFact, AS_OF,
    frames, hash, boundary, {}, { owner: 'synthetic' }, assetReads, faults, assets, new Map([['asset', 'asset']]),
    catalogDiagnostics.classifyCatalogRoute);
  return { ...actual, state, result, privateError,
    prepare(tail, count, reject = null) {
      state.tail = tail; state.count = count; state.reject = reject;
      state.paginator = { hidden: tail, disabled: false };
      calls.splice(0, calls.length, ...Array.from({ length: count }, (_, i) => ({ path: i ? FIRST_PATH : '/v1/settings',
        request: { method: () => 'GET' }, response: null, finished: false,
        request_seq: i + 1, response_seq: null, finished_seq: null, failed_seq: null })));
      if (reject === 'traffic') calls.push({ ...calls[0] });
      if (reject === 'pipeline_count') state.count++;
      assetReads.length = 0;
      if (reject === 'asset_await') assetReads.push({ then(...callbacks) { callbacks[1](privateError); } });
      faults.traffic = reject === 'faults' ? 1 : 0;
      assets.clear(); if (reject !== 'assets') assets.add('asset');
    },
  };
}

test('actual renderer and observe agree on hidden tail and visible enabled initial/Refresh with truthful scalar state', async t => {
  const dom = model(t), c = controller({ connection: 'connected', settings: SETTINGS, catalog: catalogPage(),
    catalog_loading: false, error: null, draft: '', pending: [], selected: null });
  const view = mountDisplayView(dom.root, c.client, () => {}, true, dom.layout); t.after(() => view.dispose());
  const h = observationHarness();
  for (const [name, tail, count] of [['initial', false, 2], ['append', true, 3], ['refresh', false, 4]]) {
    c.publish({ connection: 'connected', settings: SETTINGS, catalog: { ...catalogPage(tail), entries: tail ? ROWS : ROWS.slice(0, 32) },
      catalog_loading: false, error: null, draft: '', pending: [], selected: null });
    const paginator = button(dom.root, 'Load more sessions');
    assert.equal(paginator.hidden, tail); assert.equal(paginator.disabled, false);
    h.prepare(tail, count); h.state.paginator = paginator;
    await h.observe(name, tail, count);
    assert.equal(h.result.observations[name].paginator_hidden, paginator.hidden);
    assert.equal(Object.hasOwn(h.result.observations[name], 'paginator_enabled'), false);
    assert.equal(h.result.observations[name].rows, tail ? 33 : 32);
    assert.equal(h.scope(), null); assert.equal(h.failed(), null);
  }
  assert.equal(h.result.observations.initial.dom_sha256, h.result.observations.refresh.dom_sha256);
});

for (const [reject, check, tail, code] of [
  ['row_count', 'row_count'], ['rows', 'rows'], ['rows_await', 'rows'],
  ['paginator', 'paginator'], ['paginator_hidden', 'paginator_hidden', true], ['paginator_visible', 'paginator_visible'],
  ['paginator_enabled', 'paginator_enabled'], ['paginator_state', 'paginator_state'],
  ['as_of', 'as_of'], ['as_of_await', 'as_of'], ['frames', 'frames'],
  ['traffic', 'traffic', false, 'traffic'], ['pipeline_count', 'traffic', false, 'traffic'], ['tail_extra_read', 'traffic', true, 'traffic'],
  ['content', 'content'], ['digest', 'content'], ['privacy', 'privacy', false, 'privacy'],
  ['privacy_await', 'privacy'], ['asset_await', 'faults'], ['faults', 'faults', false, 'faults'], ['assets', 'faults', false, 'assets'],
]) test(`actual observe independently rejects ${reject} and freezes scalar ${check} context`, async () => {
  const h = observationHarness(); h.prepare(Boolean(tail), tail ? 3 : 2, reject);
  let original;
  try { await h.observe('append', Boolean(tail), tail ? 3 : 2); } catch (error) { original = error; }
  assert.ok(original); assert.equal(h.scope(), null);
  assert.deepEqual(h.failed(), { observation: 'append', check }); assert.equal(Object.isFrozen(h.failed()), true);
  const packet = h.packet(original);
  assert.equal(packet.stage, 'more'); assert.equal(packet.observation, 'append'); assert.equal(packet.check, check);
  assert.equal(packet.code, code ?? 'verification_failure');
  assert.deepEqual(Object.keys(packet).sort(), ['api', 'api_requests', 'check', 'code', 'faults', 'observation', 'request_failures', 'server_requests', 'stage']);
  assert.ok(!JSON.stringify(packet).includes('private-operator-secret'));
  if (!['rows', 'as_of', 'traffic', 'pipeline_count', 'tail_extra_read', 'privacy', 'faults', 'assets'].includes(reject)) assert.equal(original, h.privateError);
  const cleanup = await cleanupOwned([['later', async () => { throw Error('private cleanup'); }]], original);
  assert.equal(cleanup.error, original); assert.equal(h.scope(), null);
  assert.equal(h.packet(cleanup.error).check, check); assert.equal(h.packet(cleanup.error).observation, 'append');
});

test('actual tail observation reports hidden without imposing a disabled property', async () => {
  const h = observationHarness(); h.prepare(true, 3); h.state.paginator.disabled = true;
  await h.observe('append', true, 3); assert.equal(h.result.observations.append.paginator_hidden, true);
});

for (const code of ['traffic', 'privacy', 'faults', 'assets']) test(`actual packet preserves existing ${code} custom code without observe attribution`, () => {
  const h = observationHarness(), packet = h.packet(Error(`C61:${code}`));
  assert.equal(packet.code, code); assert.equal(packet.observation, null); assert.equal(packet.check, null);
});

test('actual observe clears success scope so a later caller failure has no stale label', async () => {
  const h = observationHarness(); h.prepare(false, 2); await h.observe('initial', false, 2);
  assert.equal(h.scope(), null); assert.equal(h.failed(), null);
  const packet = h.packet(Error('caller failed privately'));
  assert.equal(packet.observation, null); assert.equal(packet.check, null); assert.equal(packet.code, 'verification_failure');
});

test('successive actual observations reset scope and preserve the first captured rejection through later activity', async () => {
  const h = observationHarness(); h.prepare(false, 2); await h.observe('initial', false, 2);
  h.prepare(true, 3, 'content'); await assert.rejects(h.observe('append', true, 3), error => error === h.privateError);
  const first = h.failed(); assert.deepEqual(first, { observation: 'append', check: 'content' });
  h.prepare(false, 4); await h.observe('refresh', false, 4); assert.equal(h.scope(), null); assert.equal(h.failed(), first);
  h.prepare(false, 4, 'row_count'); await assert.rejects(h.observe('refresh', false, 4), error => error === h.privateError);
  assert.equal(h.failed(), first); assert.equal(h.scope(), null);
  assert.equal(h.packet(h.privateError).check, 'content');
});

for (const [hidden, disabled, check] of [[false, false, 'paginator_hidden'], [true, false, 'paginator_visible'], [false, true, 'paginator_enabled']]) {
  test(`actual observe rejects wrong paginator state hidden=${hidden} disabled=${disabled}`, async () => {
    const h = observationHarness(), tail = check === 'paginator_hidden'; h.prepare(tail, tail ? 3 : 2);
    h.state.paginator = { hidden, disabled };
    await assert.rejects(h.observe('append', tail, tail ? 3 : 2));
    assert.equal(h.failed().check, check); assert.equal(h.scope(), null);
  });
}

// Register and invoke the actual four listeners, including the packet write boundary.
function requestHarness() {
  const context = new EventEmitter(), calls = [], faults = { request: 0, traffic: 0, response: 0, asset: 0 };
  const files = new Function(spec.slice(spec.indexOf('const files ='), spec.indexOf('const privateMarkers =')) + 'return files;')();
  const result = { body_success: false, success: false, first: null, observations: {} }, writes = [], assetReads = [], assets = new Set();
  const listenerSource = spec.slice(spec.indexOf("    context.on('request',"), spec.indexOf('    page = await context.newPage();'))
    .replaceAll('import.meta.url', 'specUrl');
  const writeSource = spec.slice(spec.indexOf('    original = error;'), spec.indexOf('  } finally {\n    const cleanup'));
  const finalSource = spec.slice(spec.indexOf('      result.cleanup = cleanup.facts;'), spec.indexOf('    } finally {\n      if (previous'));
  const state = { duringObserve: null, duringWrite: null };
  const expect = () => ({ async toHaveCount() { state.duringObserve?.(); throw Error('synthetic observation rejection'); } });
  const actual = new Function('context', 'calls', 'faults', 'files', 'result', 'FIRST_PATH', 'MORE_PATH',
    'classifyCatalogRoute', 'classifyRequestError', 'requireFact', 'readFile', 'specUrl', 'assetReads', 'assets', 'expect', 'writeFile', `
    let observation = null, failedObservation = null, stage = 'connect', original = null;
    const fixture = { origin: 'http://127.0.0.1:12345', evidence: () => ({ stop: {
      attempted:true, clean_acknowledgment:true, reap_complete:true, sandbox_removed:true, exit_zero:true, stderr_empty:true,
      sigterm:false, sigkill:false, error_latched:false } }) }, leaked = () => false;
    const pipeline = { count: () => calls.length }, outputOwned = true, output = 'synthetic';
    const join = (...parts) => parts.join('/'), page = { locator: () => ({}) };
    ${diagnosticState}
    ${diagnosticSource}
    ${faultsSource}
    ${observeSource}
    ${listenerSource}
    return { observe, original: () => original, failed: () => failedObservation,
      snapshot: () => typeof diagnosticSnapshot === 'function' ? diagnosticSnapshot() : null,
      async packet(error) { ${writeSource} return result.first; },
      async finish(cleanup) { ${finalSource} return result; } };
  `)(context, calls, faults, files, result, FIRST_PATH, MORE_PATH,
    catalogDiagnostics.classifyCatalogRoute, catalogDiagnostics.classifyRequestError, requireFact, readFile,
    new URL('../e2e/catalog-pagination.spec.mjs', import.meta.url), assetReads, assets, expect,
    async (path, bytes, options) => {
      assert.ok(['synthetic/FAILURE.json', 'synthetic/RESULT.json'].includes(path)); assert.equal(options.flag, 'wx');
      writes.push({ path, packet: JSON.parse(bytes), frozen: Object.isFrozen(result.first), snapshot: result.first });
      if (path.endsWith('/FAILURE.json')) state.duringWrite?.();
    });
  const request = (path, errorText) => ({ url: () => 'http://127.0.0.1:12345' + path,
    method: () => 'GET', failure: () => errorText === undefined ? null : { errorText } });
  const reply = request => ({ url: request.url, request: () => request, status: () => 200,
    headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
    body: () => { throw Error('API body must not be read'); } });
  return { ...actual, context, calls, faults, files, result, state, writes, request, reply,
    drainAssets: () => Promise.all(assetReads), emit: (event, value) => context.emit(event, value) };
}

for (const [path, expected] of [
  ['/v1/settings', 'settings'], [FIRST_PATH, 'catalog_first'], [MORE_PATH, 'catalog_more'],
  ['/', 'asset'], ['/assets/api.js', 'asset'], ['/assets/wi.css', 'asset'],
  ['/v1/settings?x=1', 'other'], [FIRST_PATH + '&x=1', 'other'], [MORE_PATH + '&x=1', 'other'],
  [`/v1/sessions?after_id=${ROWS[31].session_id}&limit=32`, 'other'],
  ['/assets/api.js?x=1', 'other'], ['/?x=1', 'other'], ['/assets/unknown.js', 'other'],
  ['/v1/unknown', 'other'], ['/unknown', 'other'],
]) test(`actual failure listener classifies exact route ${path} as ${expected}`, () => {
  const h = requestHarness(), r = h.request(path, 'net::ERR_ABORTED');
  h.emit('request', r); h.emit('requestfailed', r);
  assert.equal(h.faults.request, 1);
  const s = h.snapshot(); assert.ok(s, 'Listener diagnostics must exist');
  assert.equal(s.request_failures.records[0].route, expected);
  assert.equal(s.request_failures.total, 1);
  const api = path.startsWith('/v1/');
  assert.equal(s.request_failures.records[0].response_seen, api ? false : null);
  assert.equal(s.request_failures.records[0].finished_seen, api ? false : null);
  if (api) assert.equal(s.api.calls[0].route, expected);
});

for (const [input, expected] of [
  ...['net::ERR_ABORTED', 'net::ERR_FAILED', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED', 'net::ERR_EMPTY_RESPONSE'].map(v => [v, v]),
  ['private-operator-raw-error http://secret.invalid/?token=secret', 'other'], [' net::ERR_ABORTED', 'other'],
  [undefined, 'unavailable'], [null, 'unavailable'], [42, 'unavailable'], ['', 'unavailable'],
]) test(`actual failure listener closes error class ${String(input)} to ${expected}`, () => {
  const h = requestHarness(), r = h.request(FIRST_PATH, input);
  h.emit('request', r); h.emit('requestfailed', r);
  const s = h.snapshot(); assert.ok(s, 'Listener diagnostics must exist');
  assert.equal(s.request_failures.records[0].error, expected);
  assert.ok(!JSON.stringify(s).includes('secret.invalid'));
  assert.ok(!JSON.stringify(s).includes('private-operator-raw-error'));
});

test('actual listeners retain first8 duplicate events, count every failure and freeze scalar snapshots', () => {
  const h = requestHarness(), r = h.request(FIRST_PATH, 'net::ERR_FAILED'); h.emit('request', r);
  for (let i = 0; i < 11; i++) h.emit('requestfailed', r);
  const s = h.snapshot(); assert.ok(s, 'Listener diagnostics must exist');
  assert.equal(s.request_failures.total, 11); assert.equal(h.faults.request, 11);
  assert.equal(s.request_failures.records.length, 8);
  assert.deepEqual(s.request_failures.records.map(r => r.seq), [2,3,4,5,6,7,8,9]);
  const scalar = value => {
    if (value && typeof value === 'object') {
      assert.equal(Object.isFrozen(value), true);
      for (const [key,v] of Object.entries(value)) { assert.ok(!['path','url','request','response','body','token','errorText'].includes(key)); scalar(v); }
    } else assert.ok(value === null || ['string','number','boolean'].includes(typeof value));
  };
  scalar(s);
  for (const r of s.request_failures.records) {
    assert.deepEqual(Object.keys(r).sort(), ['check','error','finished_seen','observation','response_seen','route','seq','stage']);
    assert.ok(Object.values(r).every(v => v === null || ['string','number','boolean'].includes(typeof v)));
  }
  assert.throws(() => s.request_failures.records.push({}));
  assert.throws(() => { s.request_failures.records[0].route = 'other'; });
  h.emit('requestfailed', r); assert.equal(h.faults.request, 12);
  assert.equal(s.request_failures.total, 11); assert.equal(s.request_failures.records.length, 8);
  assert.ok(!JSON.stringify(s).includes('127.0.0.1')); assert.ok(!JSON.stringify(s).includes(FIRST_PATH));
});

test('actual listeners expose identity-matched pending/finished/failed witnesses with all callback entries in one Node order', () => {
  const h = requestHarness(), a = h.request('/v1/settings', 'net::ERR_ABORTED'), b = h.request(FIRST_PATH, 'net::ERR_FAILED');
  const asset = h.request('/assets/api.js', 'net::ERR_EMPTY_RESPONSE');
  h.emit('request', a); h.emit('request', asset); h.emit('request', b);
  let s = h.snapshot(); assert.ok(s, 'Listener diagnostics must exist');
  assert.deepEqual(s.api.calls, [
    { route:'settings', terminal:'pending', request_seq:1, response_seq:null, finished_seq:null, failed_seq:null },
    { route:'catalog_first', terminal:'pending', request_seq:3, response_seq:null, finished_seq:null, failed_seq:null },
  ]);
  h.emit('requestfailed', a); h.emit('response', h.reply(b)); h.emit('requestfinished', asset);
  h.emit('requestfailed', b); h.emit('requestfinished', b);
  const c = h.request(MORE_PATH, 'net::ERR_CONNECTION_RESET');
  h.emit('request', c); h.emit('response', h.reply(c)); h.emit('requestfinished', c); h.emit('requestfailed', c);
  const missing = h.request('/v1/unknown', 'net::ERR_CONNECTION_CLOSED'); h.emit('requestfailed', missing);
  s = h.snapshot();
  assert.deepEqual(s.request_failures.records.map(r => [r.response_seen,r.finished_seen,r.seq]),
    [[false,false,4],[true,false,7],[true,true,12],[null,null,13]]);
  assert.deepEqual(s.api.calls, [
    { route:'settings',terminal:'failed',request_seq:1,response_seq:null,finished_seq:null,failed_seq:4 },
    { route:'catalog_first',terminal:'failed',request_seq:3,response_seq:5,finished_seq:8,failed_seq:7 },
    { route:'catalog_more',terminal:'failed',request_seq:9,response_seq:10,finished_seq:11,failed_seq:12 },
  ]);
  assert.equal(s.api.settings,1); assert.equal(s.api.catalog,2); assert.equal(s.api.total,3);
  assert.equal(s.api.matched_responses,2); assert.equal(s.api.finished,2); assert.equal(s.api.all_get,true);
  assert.equal(h.faults.request,4);
  const finished = h.request(FIRST_PATH); h.emit('request',finished); h.emit('requestfinished',finished);
  assert.equal(h.snapshot().api.calls[3].terminal,'finished');
  assert.equal(s.api.calls.length,3); assert.equal(s.request_failures.records[0].finished_seen,false);
});

test('actual failure records use active observe context only, not its later retained rejection', async () => {
  const h = requestHarness(), r = h.request(FIRST_PATH,'net::ERR_ABORTED'); h.emit('request',r);
  h.state.duringObserve = () => h.emit('requestfailed',r);
  await assert.rejects(h.observe('initial',false,2), /synthetic observation rejection/);
  assert.deepEqual(h.failed(),{observation:'initial',check:'row_count'});
  h.emit('requestfailed',r);
  const s = h.snapshot(); assert.ok(s, 'Listener diagnostics must exist');
  assert.deepEqual(s.request_failures.records.map(r=>[r.stage,r.observation,r.check]),
    [['connect','initial','row_count'],['connect',null,null]]);
});

test('actual first packet contains immutable diagnostics before write and cannot acquire cleanup events', async () => {
  const h = requestHarness(), r = h.request(FIRST_PATH,'net::ERR_ABORTED');
  h.emit('request',r); h.emit('requestfailed',r);
  const original = Error('C61:faults');
  h.state.duringWrite = () => { h.emit('response',h.reply(r)); h.emit('requestfinished',r); h.emit('requestfailed',r); };
  const first = await h.packet(original);
  assert.equal(h.original(),original); assert.equal(first.code,'faults');
  assert.equal(h.writes.length,1); assert.equal(h.writes[0].frozen,true);
  assert.ok(first.request_failures, 'First packet must include request diagnostics before write');
  assert.equal(first.request_failures.total,1); assert.equal(first.api.calls[0].failed_seq,2);
  assert.equal(first.api.calls[0].response_seq,null);
  assert.deepEqual(h.writes[0].packet,first);
  assert.equal(first.request_failures.records[0].response_seen,false);
  const final = h.snapshot(); assert.equal(final.request_failures.total,2);
  assert.equal(final.request_failures.records[1].response_seen,true); assert.equal(final.request_failures.records[1].finished_seen,true);
  assert.equal(final.api.calls[0].terminal,'failed');
  assert.throws(()=>{first.api.calls[0].terminal='finished';});
  const cleanup = await cleanupOwned([['later',async()=>{throw Error('C61:assets');}]],original);
  const result = await h.finish(cleanup);
  assert.equal(cleanup.error,original); assert.equal(result.first,first); assert.equal(result.first.code,'faults');
  assert.equal(result.request_failures.total,2); assert.equal(result.success,false);
  assert.equal(h.writes.filter(w=>w.path.endsWith('/FAILURE.json')).length,1);
  const saved = h.writes.at(-1).packet;
  assert.equal(saved.first.request_failures.total,1); assert.equal(saved.request_failures.total,2);
  h.emit('requestfailed',r); assert.equal(result.request_failures.total,2); assert.equal(h.faults.request,3);
});

test('actual asset response entry advances the same order without reading an API body', async () => {
  const h = requestHarness(), asset = h.request('/assets/api.js');
  h.emit('request',asset);
  h.emit('response',{...h.reply(asset),body:()=>readFile(new URL('../dist/api.js',import.meta.url))});
  h.emit('requestfinished',asset); await h.drainAssets();
  const api = h.request(FIRST_PATH,'net::ERR_ABORTED'); h.emit('request',api); h.emit('requestfailed',api);
  const s = h.snapshot(); assert.equal(s.api.assets,1); assert.equal(s.api.calls[0].request_seq,4);
  assert.equal(s.request_failures.records[0].seq,5); assert.equal(h.faults.asset,0); assert.equal(h.faults.response,0);
});

test('actual cleanup-only failure publishes the same scalar facts without a successful request-failure disposition', async () => {
  const h = requestHarness(), r = h.request(FIRST_PATH,'net::ERR_CONNECTION_RESET');
  h.result.body_success = true; h.emit('request',r); h.emit('response',h.reply(r));
  h.emit('requestfailed',r);
  const original = Error('C61:faults');
  const result = await h.finish({facts:[{stage:'faults',pass:false}],error:original});
  assert.equal(result.success,false); assert.equal(result.first.code,'faults');
  assert.equal(result.first.request_failures.total,1); assert.equal(result.request_failures.total,1);
  assert.equal(h.faults.request,1); assert.equal(result.first.faults.request,1);
  assert.equal(h.writes[0].path,'synthetic/FAILURE.json'); assert.equal(h.writes[0].frozen,true);
  assert.deepEqual(h.writes[0].packet.api.calls,[
    {route:'catalog_first',terminal:'failed',request_seq:1,response_seq:2,finished_seq:null,failed_seq:3},
  ]);
  assert.equal(h.writes[0].packet.request_failures.records[0].response_seen,true);
  assert.equal(h.writes[1].path,'synthetic/RESULT.json');
});
