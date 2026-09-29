import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import { installAcceptanceUnknownObserver } from '../test-support/acceptance-unknown.mjs';

const sid = '12345678-1234-4234-8234-123456789abc';
const operation = '23456789-1234-4234-8234-123456789abc';
const run = '3456789a-1234-4234-8234-123456789abc';
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${sid}/runs`;
const error = { api_version: 1, code: 'storage.commit_unknown', stage: 'acceptance', certainty: 'unknown', acceptance: null, notices: [] };
const plain = value => JSON.parse(JSON.stringify(value));
const response = (value = error, status = 503) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function observer(fetch, timeout = setTimeout) {
  const source = installAcceptanceUnknownObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)');
  const page = { fetch, URL, Request, TextDecoder, setTimeout: timeout, clearTimeout, validators: api, location: { href: `${origin}/`, origin } };
  runInNewContext(`(${source})({ secrets: ['private-observer-canary'] });
    globalThis.freeze = value => Object.freeze(value);
    globalThis.publish = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') publish(child); return Object.freeze(value); };`, page, { timeout: 1000 });
  page.acceptanceUnknownCapture.select(sid);
  return page;
}

test('acceptance-unknown clone validates the exact real DTO without changing the original response', async () => {
  const original = response();
  const page = observer(async () => original);
  const result = await page.fetch(path, { method: 'POST' });
  assert.equal(result, original);
  assert.equal(await result.text(), JSON.stringify(error));
  await page.acceptanceUnknownCapture.drain();
  assert.deepEqual(plain(page.acceptanceUnknownCapture.summary()), {
    count: 1, reply: { status: 503, decoded: true, validated: true, exact: true }, failures: [],
  });
});

test('acceptance-unknown observes only one exact selected task and never adds requests', async () => {
  let calls = 0;
  let clones = 0;
  const page = observer(async () => {
    calls++;
    const reply = response(); const clone = reply.clone.bind(reply);
    reply.clone = () => { clones++; return clone(); };
    return reply;
  });
  for (const [url, method] of [[path, 'GET'], [`${path}?extra=1`, 'POST'], [`${path}#x`, 'POST'],
    [`http://127.0.0.1:43211${path}`, 'POST'], ['/v1/sessions', 'POST'], ['/v1/settings', 'GET'],
    [path, 'POST'], [path, 'POST'], [path, 'POST']]) await page.fetch(url, { method });
  await page.acceptanceUnknownCapture.drain();
  assert.equal(calls, 9); assert.equal(clones, 1);
  assert.equal(page.acceptanceUnknownCapture.summary().count, 1);
  assert.deepEqual(plain(page.acceptanceUnknownCapture.summary().failures), ['task:limit']);
});

test('acceptance-unknown clone rejects private, malformed, non-exact and oversized replies with static diagnostics', async () => {
  for (const [value, status, category] of [
    [error, 202, 'status'], [{ error }, 503, 'schema'], [{ ...error, extra: true }, 503, 'schema'],
    [{ ...error, api_version: 2 }, 503, 'schema'], [{ ...error, stage: null }, 503, 'exact'],
    [{ ...error, code: 'storage.stale_history' }, 503, 'exact'], [{ ...error, certainty: 'not_committed' }, 503, 'exact'],
    [{ ...error, acceptance: { operation_id: operation, session_id: sid, run_id: run, first_sequence: '2', last_sequence: '3' } }, 503, 'exact'],
    [{ ...error, notices: [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }] }, 503, 'exact'],
    ['private-observer-canary', 503, 'secret'], ['x'.repeat(4097), 503, 'size'],
  ]) {
    const page = observer(async () => response(value, status));
    await page.fetch(path, { method: 'POST' });
    await page.acceptanceUnknownCapture.drain();
    assert.deepEqual(plain(page.acceptanceUnknownCapture.summary().failures), [`task:${category}`]);
  }
  for (const [body, type, category] of [['{bad', 'application/json', 'json'],
    [JSON.stringify(error), 'text/plain', 'media'],
    [`{"code":"storage.commit_unknown",${JSON.stringify(error).slice(1)}`, 'application/json', 'exact']]) {
    const page = observer(async () => new Response(body, { status: 503, headers: { 'content-type': type } }));
    await page.fetch(path, { method: 'POST' }); await page.acceptanceUnknownCapture.drain();
    assert.deepEqual(plain(page.acceptanceUnknownCapture.summary().failures), [`task:${category}`]);
  }
});

test('acceptance-unknown clone has a finite read deadline and never waits on the application branch', async () => {
  let cancelled = 0;
  const original = response();
  original.clone = () => ({ body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled++; } }) } });
  const page = observer(async () => original, callback => setTimeout(callback, 10));
  assert.equal(await page.fetch(path, { method: 'POST' }), original);
  assert.equal(await original.text(), JSON.stringify(error));
  await page.acceptanceUnknownCapture.drain();
  assert.equal(cancelled, 1);
  assert.deepEqual(plain(page.acceptanceUnknownCapture.summary().failures), ['task:body']);
  assert.equal(JSON.stringify(page.acceptanceUnknownCapture.summary()).includes('private-observer-canary'), false);
});

test('acceptance-unknown memory observer reads actual frozen objects, detects identity/substitution and clears on Disconnect', () => {
  const page = observer(async () => response());
  const expected = { operation, run, text: 'synthetic task', draft: 'synthetic task' };
  const state = { connection: 'connected', pending: [], recoveries: [], draft: expected.draft,
    last_mutation: { kind: 'create', id: sid }, selected: { display: [], run_view: null, cancel: null, applied_cursor: `${sid}:1` } };
  assert.equal(page.publish(state), state);
  const command = { kind: 'task', id: operation, session_id: sid, body: { operation_id: operation, run_id: run, text: expected.text } };
  assert.equal(page.publish(command), command);
  assert.equal(Object.isFrozen(command), true); assert.equal(Object.isFrozen(command.body), true);
  const pending = { command, phase: 'uncertain', receipt: null, reply: null, canonical_seen: false, canonical_sequence: null };
  const failed = { ...state, pending: [pending] };
  page.publish(failed);
  assert.ok(Object.values(page.acceptanceUnknownCapture.memory(expected)).every(value => value === true));
  page.publish({ ...failed, draft: 'edited' });
  assert.ok(Object.values(page.acceptanceUnknownCapture.memory({ ...expected, draft: 'edited' })).every(value => value === true));
  page.publish({ ...failed, pending: [{ ...pending, command: { ...command, body: { ...command.body, run_id: operation } } }] });
  assert.equal(page.acceptanceUnknownCapture.memory(expected).commandExact, false);
  page.publish({ ...failed, last_mutation: { kind: 'task' } });
  assert.equal(page.acceptanceUnknownCapture.memory(expected).lastMutationUnchanged, false);
  page.publish({ ...failed, pending: [{ ...pending, receipt: {} }] });
  assert.equal(page.acceptanceUnknownCapture.memory(expected).noAcceptance, false);
  page.publish({ connection: 'disconnected', pending: [], recoveries: [], draft: '', selected: null, last_mutation: null });
  assert.equal(page.acceptanceUnknownCapture.cleared(), true);
});
