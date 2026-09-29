import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import { installUnboundHistoryObserver } from '../test-support/unbound-history.mjs';
const sid = '12345678-1234-4234-8234-123456789abc';
const [operation, run, legacyRun] = ['23456789', '3456789a', '456789ab'].map(prefix => `${prefix}-1234-4234-8234-123456789abc`);
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${sid}/runs`;
const dto = { api_version: 1, code: 'invalid_request', stage: 'history', certainty: 'not_applicable', acceptance: null, notices: [] };
const expected = { operation, run, text: 'new task', draft: 'new task' };
const command = { kind: 'task', id: operation, session_id: sid, body: { operation_id: operation, run_id: run, text: expected.text } };
const pending = { command, phase: 'sending', error: null, receipt: null, reply: null, notices: [], canonical_seen: false, canonical_sequence: null };
const display = [{ user_text: 'legacy', execution: 'completed', result_recorded: true,
  run: { run_id: legacyRun, accepted: { user_text: 'legacy' }, accepted_sequence: '2', finished: { sequence: '8' }, result: { sequence: '9' }, interrupted: null },
  entries: [{ kind: 'response', sections: [{ text: 'answer' }] }] }];
const state = { connection: 'connected', pending: [], recoveries: [], draft: '', last_mutation: null,
  selected: { session_id: sid, display, applied_cursor: `${sid}:9`, through_sequence: '9', run_view: null, cancel: null, observation_error: null } };
const { api_version: _version, ...server } = dto;
const final = { ...state, draft: expected.text, pending: [{ ...pending, phase: 'rejected', error: { category: 'http', status: 422, server } }] };
const disconnected = { connection: 'disconnected', pending: [], recoveries: [], draft: '', selected: null, last_mutation: null };
const plain = value => JSON.parse(JSON.stringify(value));
const reply = (body = JSON.stringify(dto), status = 422, type = 'application/json') => new Response(body, { status, headers: { 'content-type': type } });
function observer(fetch, { timeout = setTimeout, setup = true } = {}) {
  const page = { fetch, URL, Request, Response, ReadableStream, TextDecoder, TextEncoder, setTimeout: timeout, clearTimeout,
    validators: api, location: { href: `${origin}/`, origin } };
  const source = installUnboundHistoryObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)');
  runInNewContext(`(${source})({ secrets: ['private-observer-canary'], legacyText: 'legacy', legacyAnswer: 'answer' });
    globalThis.publish = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') publish(child); return Object.freeze(value); };`, page, { timeout: 1000 });
  page.unboundHistoryCapture.select(sid);
  page.publish(state);
  if (setup) {
    assert.equal(page.unboundHistoryCapture.legacy(), true);
    page.publish(command); page.publish({ ...state, draft: expected.text, pending: [pending] });
  }
  return page;
}
async function send(page) {
  const original = await page.fetch(path, { method: 'POST', body: JSON.stringify(command.body) });
  await page.unboundHistoryCapture.drain();
  return original;
}
const summary = { count: 1, reply: { status: 422, decoded: true, validated: true, exact: true }, failures: [] };

test('unbound observer consumes a bounded clone, keeps the original response unchanged and preserves edited immutable command state', async () => {
  const original = reply(); let calls = 0;
  const page = observer(async () => { calls++; return original; });
  assert.equal(await send(page), original);
  assert.equal(await original.text(), JSON.stringify(dto));
  page.publish(final);
  assert.deepEqual(Object.values(page.unboundHistoryCapture.rejected(expected)), Array(9).fill(true));
  page.publish({ ...final, draft: 'edited not sent' });
  assert.deepEqual(Object.values(page.unboundHistoryCapture.rejected({ ...expected, draft: 'edited not sent' })), Array(9).fill(true));
  assert.deepEqual(plain(page.unboundHistoryCapture.summary()), summary);
  assert.equal(calls, 1);
  page.publish(disconnected); assert.equal(page.unboundHistoryCapture.cleared(), true);
});

test('unbound clone precedes validator import and never delays or consumes the original', async () => {
  const original = reply(); const page = observer(async () => original);
  let release; page.validators = new Promise(resolve => { release = resolve; });
  assert.equal(await page.fetch(path, { method: 'POST', body: JSON.stringify(command.body) }), original);
  assert.equal(await original.text(), JSON.stringify(dto));
  release(api); await page.unboundHistoryCapture.drain();
  assert.deepEqual(plain(page.unboundHistoryCapture.summary()), summary);
});

test('unbound observer rejects exact DTO, schema, duplicate keys, malformed media/JSON/UTF-8/size and private output', async () => {
  const cases = [[JSON.stringify(dto), 503, 'application/json', 'status'], ['{bad', 422, 'application/json', 'json'],
    [new Uint8Array([0xff]), 422, 'application/json', 'body'], [new Uint8Array([0xe9, 0x9b]), 422, 'application/json', 'body'],
    ['x'.repeat(4097), 422, 'application/json', 'size'], [JSON.stringify('private-observer-canary'), 422, 'application/json', 'secret']];
  for (const type of ['text/plain', 'application/json; charset=latin1', 'application/json; charset=utf-8; charset=utf-8']) cases.push([JSON.stringify(dto), 422, type, 'media']);
  for (const field of [...Object.keys(dto), 'private']) {
    const bad = { ...dto }; if (field === 'private') bad.private = true; else delete bad[field];
    cases.push([JSON.stringify(bad), 422, 'application/json', 'schema']);
  }
  for (const [change, category] of [[{ api_version: 2 }, 'schema'], [{ error: dto }, 'schema'], [{ code: 'api.invalid_request' }, 'exact'],
    [{ stage: null }, 'exact'], [{ stage: 'preflight' }, 'exact'], [{ certainty: 'unknown' }, 'exact'], [{ certainty: 'not_committed' }, 'exact'],
    [{ acceptance: { operation_id: operation, session_id: sid, run_id: run, first_sequence: '2', last_sequence: '3' } }, 'exact'],
    [{ notices: [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }] }, 'exact']]) {
    cases.push([JSON.stringify({ ...dto, ...change }), 422, 'application/json', category]);
  }
  for (const field of Object.keys(dto)) for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
    cases.push([`{"${spelling}":${JSON.stringify(dto[field])},${JSON.stringify(dto).slice(1)}`, 422, 'application/json', 'exact']);
  }
  for (const [body, status, type, category] of cases) {
    const page = observer(async () => reply(body, status, type));
    await send(page);
    assert.deepEqual(plain(page.unboundHistoryCapture.summary().failures), [`task:${category}`]);
    assert.equal(JSON.stringify(page.unboundHistoryCapture.summary()).includes('private-observer-canary'), false);
  }
});

test('unbound observer timeout cancels only its clone and drain waits; selection/order and late post-disconnect replies fail', async () => {
  let cancelled = 0;
  const original = reply();
  original.clone = () => ({ body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled++; } }) } });
  const page = observer(async () => original, { timeout: callback => setTimeout(callback, 10) });
  assert.equal(await send(page), original);
  assert.equal(await original.text(), JSON.stringify(dto)); assert.equal(cancelled, 1);
  assert.deepEqual(plain(page.unboundHistoryCapture.summary().failures), ['task:body']);
  const unordered = observer(async () => reply(), { setup: false }); await send(unordered);
  assert.deepEqual(plain(unordered.unboundHistoryCapture.summary().failures), ['task:order']);
  const late = observer(async () => reply());
  let release; late.validators = new Promise(resolve => { release = resolve; });
  const received = await late.fetch(path, { method: 'POST', body: JSON.stringify(command.body) });
  let drained = false; const drain = late.unboundHistoryCapture.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(drained, false);
  late.publish(disconnected); release(api); await drain; await received.text();
  assert.deepEqual(plain(late.unboundHistoryCapture.summary().failures), ['task:order']);
  assert.equal(late.unboundHistoryCapture.cleared(), true);
});

test('unbound observer clones only one same-origin selected POST and makes no added or retry requests', async () => {
  let calls = 0; let clones = 0;
  const page = observer(async () => { calls++; const original = reply(); const clone = original.clone.bind(original);
    original.clone = () => { clones++; return clone(); }; return original; });
  for (const [url, method] of [[path, 'GET'], [`${path}?extra=1`, 'POST'], [`${path}#x`, 'POST'],
    [`http://127.0.0.1:43211${path}`, 'POST'], ['/v1/sessions', 'POST'], [path, 'POST'], [path, 'POST']]) {
    await page.fetch(url, { method, body: method === 'POST' ? JSON.stringify(command.body) : undefined });
  }
  await page.unboundHistoryCapture.drain();
  assert.equal(calls, 7); assert.equal(clones, 1);
  assert.deepEqual(plain(page.unboundHistoryCapture.summary().failures), ['task:limit']);
});

test('unbound memory audit rejects changed commands, draft, errors, receipts, uncertainty and legacy display', async () => {
  for (const [change, field] of [
    [{ draft: '' }, 'draftExact'], [{ last_mutation: {} }, 'noLastMutation'],
    [{ pending: [{ ...final.pending[0], command: { ...command, body: { ...command.body, text: 'changed' } } }] }, 'commandExact'],
    ...['accepted', 'uncertain', 'conflict'].map(phase => [{ pending: [{ ...final.pending[0], phase }] }, 'rejectedOnly']),
    ...[{ category: 'network' }, { status: 503 }, { server: { ...server, stage: 'preflight' } }, { server: { ...server, certainty: 'unknown' } }]
      .map(error => [{ pending: [{ ...final.pending[0], error: { ...final.pending[0].error, ...error } }] }, 'errorExact']),
    ...[{ receipt: {} }, { reply: {} }, { canonical_seen: true }, { canonical_sequence: '10' }]
      .map(change => [{ pending: [{ ...final.pending[0], ...change }] }, 'noAcceptance']),
    [{ selected: { ...state.selected, applied_cursor: `${sid}:10` } }, 'canonicalUnchanged'],
    [{ selected: { ...state.selected, display: [display[0], display[0]] } }, 'canonicalUnchanged'],
    [{ selected: { ...state.selected, display: [{ ...display[0], result_recorded: false }] } }, 'canonicalUnchanged'],
  ]) {
    const page = observer(async () => reply()); await send(page); page.publish({ ...final, ...change });
    assert.equal(page.unboundHistoryCapture.rejected(expected)[field], false);
  }
});
