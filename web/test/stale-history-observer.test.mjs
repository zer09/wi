import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import { checkEmbeddedAssets, installStaleHistoryObserver } from '../test-support/stale-history.mjs';

const sid = '12345678-1234-4234-8234-123456789abc';
const operation = '23456789-1234-4234-8234-123456789abc';
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${sid}`;
const error = { api_version: 1, code: 'storage.stale_history', stage: 'acceptance',
  certainty: 'not_committed', acceptance: null, notices: [] };
const receipt = { operation_id: operation, session_id: sid, run_id: null, first_sequence: '2', last_sequence: '2' };
const rename = { api_version: 1, receipt, duplicate: false, warning_code: null, catalog_refresh: 'updated' };
const manifest = { api_version: 1, session_id: sid, title: 'renamed', workspace: null,
  created_at_ms: '1', updated_at_ms: '2', head_sequence: '2', view: 'canonical' };
const options = { secrets: ['private-observer-canary'], initialTitle: 'created', renamedTitle: 'renamed' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const plain = value => JSON.parse(JSON.stringify(value));
function observer(fetch) {
  // Unit-only module binding. Joined E2E imports the actual same-origin embedded module.
  const source = installStaleHistoryObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)');
  const page = { fetch, URL, Request, validators: api, location: { href: `${origin}/`, origin } };
  runInNewContext(`(${source})(${JSON.stringify(options)})`, page, { timeout: 1000 });
  page.staleHistoryCapture.select(sid);
  return page;
}

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('page clones validate exact task, rename and canonical DTOs without exporting content', async () => {
  let next;
  const page = observer(async () => next);
  for (const [suffix, method, value, status] of [
    ['', 'GET', { ...manifest, title: 'created', head_sequence: '1' }, 200],
    ['/rename', 'POST', rename, 200], ['', 'GET', manifest, 200], ['/runs', 'POST', error, 409],
  ]) {
    next = response(value, status);
    const original = await page.fetch(`${path}${suffix}`, { method });
    assert.equal(original, next, 'the application receives the original response');
    assert.equal(original.status, status);
    assert.equal(original.headers.get('content-type'), 'application/json');
    assert.equal(await original.text(), JSON.stringify(value));
  }
  await page.staleHistoryCapture.drain();
  assert.deepEqual(plain(page.staleHistoryCapture.summary()), {
    counts: { task: 1, rename: 1, manifest: 2 },
    reply: { status: 409, decoded: true, validated: true, exact: true },
    rename: true, canonicalRename: true, failures: [],
  });
  assert.equal(page.staleHistoryCapture.matchesRename(receipt, operation), true);
  assert.equal(page.staleHistoryCapture.matchesRename({ ...receipt, last_sequence: '3' }, operation), false);
  assert.equal(page.staleHistoryCapture.matchesRename(receipt, sid), false);
});

test('drain includes captures added during a pending drain and removes settled reads', async () => {
  const first = deferred();
  const later = deferred();
  let next = response(error, 409);
  next.clone = () => ({ text: () => first.promise });
  const page = observer(async () => next);
  const original = await page.fetch(`${path}/runs`, { method: 'POST' });
  assert.equal(original, next, 'return does not wait for the clone');
  let drained = false;
  const drain = page.staleHistoryCapture.drain().then(() => { drained = true; });
  next = response(rename);
  next.clone = () => ({ text: () => later.promise });
  await page.fetch(`${path}/rename`, { method: 'POST' });
  first.resolve(JSON.stringify(error));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'a snapshot-only drain would finish here');
  later.resolve(JSON.stringify(rename));
  await drain;
  await page.staleHistoryCapture.drain();
  assert.equal(drained, true);
  assert.deepEqual(plain(page.staleHistoryCapture.summary().failures), []);
});

test('only finite exact same-origin endpoints are cloned and capture counts are bounded', async () => {
  let clones = 0;
  let requests = 0;
  const page = observer(async () => {
    requests++;
    const reply = response(manifest);
    const clone = reply.clone.bind(reply);
    reply.clone = () => { clones++; return clone(); };
    return reply;
  });
  for (const [url, method] of [
    [`${path}/events`, 'GET'], [`${path}/history`, 'GET'], ['/v1/settings', 'GET'], ['/assets/api.js', 'GET'],
    [`http://127.0.0.1:43211${path}`, 'GET'], [`${path}?extra=1`, 'GET'], [path, 'POST'],
    [path, 'GET'], [path, 'GET'], [path, 'GET'], [path, 'GET'],
  ]) await page.fetch(url, { method });
  await page.staleHistoryCapture.drain();
  assert.equal(requests, 11, 'the observer never replaces or adds a request');
  assert.equal(clones, 2);
  assert.deepEqual(plain(page.staleHistoryCapture.summary().counts), { task: 0, rename: 0, manifest: 2 });
  assert.deepEqual(plain(page.staleHistoryCapture.summary().failures), ['manifest:limit']);
});

test('observer failures expose only static endpoint/stage categories', async () => {
  for (const [suffix, value, status, category] of [
    ['/runs', error, 200, 'task:status'], ['/runs', { error }, 409, 'task:schema'],
    ['/runs', { ...error, code: 'storage.active_run_exists' }, 409, 'task:exact'],
    ['/runs', { ...error, extra: true }, 409, 'task:schema'],
    ['/rename', rename, 201, 'rename:status'], ['/rename', { ...rename, duplicate: true }, 200, 'rename:exact'],
    ['', manifest, 201, 'manifest:status'], ['', { ...manifest, head_sequence: '3' }, 200, 'manifest:exact'],
    ['', { ...manifest, title: 'incorrect' }, 200, 'manifest:exact'],
    ['/runs', 'private-observer-canary', 409, 'task:secret'],
    ['/runs', 'x'.repeat(64 * 1024), 409, 'task:size'],
  ]) {
    const page = observer(async () => response(value, status));
    await page.fetch(`${path}${suffix}`, { method: suffix === '' ? 'GET' : 'POST' });
    await page.staleHistoryCapture.drain();
    assert.deepEqual(plain(page.staleHistoryCapture.summary().failures), [category]);
  }
  for (const [kind, expected] of [['media', 'task:media'], ['json', 'task:json'], ['body', 'task:body']]) {
    const reply = response(error, 409);
    if (kind === 'media') reply.headers.set('content-type', 'text/plain');
    if (kind === 'json') reply.clone = () => ({ text: async () => '{invalid' });
    if (kind === 'body') reply.clone = () => { throw new Error('private-observer-canary'); };
    const page = observer(async () => reply);
    assert.equal(await page.fetch(`${path}/runs`, { method: 'POST' }), reply);
    await page.staleHistoryCapture.drain();
    assert.deepEqual(plain(page.staleHistoryCapture.summary().failures), [expected]);
    assert.equal(JSON.stringify(page.staleHistoryCapture.summary()).includes('private-observer-canary'), false);
  }
});

test('asset verification compares exact bytes and reports no response data', async () => {
  const bytes = [0, 13, 10, 255, 32];
  for (const mode of ['exact', 'different', 'status', 'secret', 'read']) {
    const calls = [];
    const run = runInNewContext(`(${checkEmbeddedAssets.toString()})`, {
      Uint8Array, TextDecoder,
      fetch: async (path, init) => {
        calls.push({ path, init: plain(init) });
        if (mode === 'read') throw new Error('private-observer-canary');
        if (mode === 'secret') return new Response('private-observer-canary');
        return new Response(new Uint8Array(mode === 'different' ? [0, 10, 13, 255, 32] : bytes), { status: mode === 'status' ? 201 : 200 });
      },
    }, { timeout: 1000 });
    const proof = await run({ files: [['/assets/api.js', bytes]], secrets: options.secrets });
    const failures = { exact: [], different: ['asset:bytes'], status: ['asset:status'],
      secret: ['asset:bytes', 'asset:secret'], read: ['asset:read'] };
    assert.deepEqual(plain(proof), { checked: mode === 'read' ? 0 : 1, failures: failures[mode] });
    assert.deepEqual(calls, [{ path: '/assets/api.js', init: { mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error' } }]);
  }
});
