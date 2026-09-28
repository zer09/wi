import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import { installAcceptanceWarningObserver } from '../test-support/acceptance-warning.mjs';

const sid = '12345678-1234-4234-8234-123456789abc';
const operation = '23456789-1234-4234-8234-123456789abc';
const run = '3456789a-1234-4234-8234-123456789abc';
const create = '456789ab-1234-4234-8234-123456789abc';
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${sid}/runs`;
const receipt = { operation_id: operation, session_id: sid, run_id: run, first_sequence: '2', last_sequence: '3' };
const accepted = { api_version: 1, receipt, duplicate: false, warning_code: 'storage.connection_cleanup_failed', notices: [] };
const expected = { operation, run, text: 'synthetic task' };
const command = { kind: 'task', id: operation, session_id: sid, body: { operation_id: operation, run_id: run, text: expected.text } };
const state = { connection: 'connected', error: null, pending: [], recoveries: [], draft: expected.text,
  last_mutation: { kind: 'create', id: create }, selected: { session_id: sid, display: [], observation_error: null, cancel: null, applied_cursor: `${sid}:1` } };
const pending = { command, phase: 'sending', receipt: null, reply: null, canonical_seen: false, canonical_sequence: null };
const canonical = { user_text: expected.text, execution: 'accepted', result_recorded: false, entries: [],
  run: { run_id: run, accepted_sequence: '2', accepted: { user_text: expected.text }, started_sequence: null, finished: null, result: null, interrupted: null } };
const final = { ...state, draft: '', last_mutation: { kind: 'task', id: operation, session_id: sid, receipt, reply: accepted, notices: [], canonical_read_error: null },
  selected: { ...state.selected, display: [canonical], applied_cursor: `${sid}:3` } };
const plain = value => JSON.parse(JSON.stringify(value));
const response = (value = accepted, status = 202) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function observer(fetch, timeout = setTimeout) {
  const source = installAcceptanceWarningObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)');
  const page = { fetch, URL, Request, TextDecoder, setTimeout: timeout, clearTimeout, validators: api, location: { href: `${origin}/`, origin } };
  runInNewContext(`(${source})({ secrets: ['private-observer-canary'] });
    globalThis.publish = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') publish(child); return Object.freeze(value); };`, page, { timeout: 1000 });
  page.acceptanceWarningCapture.select(sid);
  page.publish(state); page.publish(command); page.publish({ ...state, pending: [pending] });
  return page;
}
async function send(page) {
  const result = await page.fetch(path, { method: 'POST', body: JSON.stringify(command.body) });
  await page.acceptanceWarningCapture.drain();
  return result;
}

test('acceptance-warning clone validates exact 202 and leaves the original response unchanged', async () => {
  const original = response();
  const page = observer(async () => original);
  assert.equal(await send(page), original);
  assert.equal(await original.text() === JSON.stringify(accepted), true);
  assert.deepEqual(plain(page.acceptanceWarningCapture.summary()), {
    count: 1, reply: { status: 202, decoded: true, validated: true, exact: true }, failures: [],
  });
  page.publish(final);
  assert.deepEqual(Object.values(page.acceptanceWarningCapture.memory(expected)), Array(9).fill(true));
});

test('acceptance-warning observes one selected task, returns every original and never adds requests', async () => {
  let calls = 0; let clones = 0;
  const page = observer(async () => {
    calls++; const reply = response(); const clone = reply.clone.bind(reply);
    reply.clone = () => { clones++; return clone(); }; return reply;
  });
  for (const [url, method] of [[path, 'GET'], [`${path}?extra=1`, 'POST'], [`${path}#x`, 'POST'],
    [`http://127.0.0.1:43211${path}`, 'POST'], ['/v1/sessions', 'POST'], ['/v1/settings', 'GET'],
    [path, 'POST'], [path, 'POST'], [path, 'POST']]) await page.fetch(url, { method });
  await page.acceptanceWarningCapture.drain();
  assert.equal(calls, 9); assert.equal(clones, 1);
  assert.equal(page.acceptanceWarningCapture.summary().count, 1);
  assert.deepEqual(plain(page.acceptanceWarningCapture.summary().failures), ['task:limit']);
});

test('acceptance-warning clone rejects every missing/extra field and malformed or mismatched actual DTO', async () => {
  const cases = [
    [accepted, 503, 'status'], [{ accepted }, 202, 'schema'], [{ ...accepted, api_version: 2 }, 202, 'schema'],
    [{ ...accepted, duplicate: 'false' }, 202, 'schema'], [{ ...accepted, duplicate: true }, 202, 'exact'],
    [{ ...accepted, warning_code: null }, 202, 'exact'], [{ ...accepted, warning_code: 'storage.io' }, 202, 'exact'],
    [{ ...accepted, notices: [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }] }, 202, 'exact'],
    ['private-observer-canary', 202, 'secret'], ['x'.repeat(4097), 202, 'size'],
  ];
  for (const nested of [false, true]) {
    const fields = nested ? receipt : accepted;
    for (const field of [...Object.keys(fields), 'extra']) {
      const value = structuredClone(accepted);
      const object = nested ? value.receipt : value;
      if (field === 'extra') object.extra = true; else delete object[field];
      cases.push([value, 202, 'schema']);
    }
  }
  for (const [change, category] of [
    [{ operation_id: run }, 'exact'], [{ run_id: operation }, 'exact'], [{ session_id: run }, 'exact'],
    [{ first_sequence: '3', last_sequence: '4' }, 'exact'], [{ first_sequence: '02' }, 'schema'],
    [{ last_sequence: 3 }, 'schema'], [{ run_id: null }, 'schema'], [{ operation_id: 'not-an-id' }, 'schema'],
  ]) cases.push([{ ...accepted, receipt: { ...receipt, ...change } }, 202, category]);
  for (const [value, status, category] of cases) {
    const page = observer(async () => response(value, status)); await send(page);
    assert.deepEqual(plain(page.acceptanceWarningCapture.summary().failures), [`task:${category}`]);
  }
});

test('acceptance-warning clone rejects duplicate and escaped keys, bad JSON/media/UTF-8 and stalls without exposing data', async () => {
  const bodies = [['{bad', 'application/json', 'json'], [JSON.stringify(accepted), 'text/plain', 'media'],
    [new Uint8Array([0xff]), 'application/json', 'body']];
  for (const nested of [false, true]) for (const field of Object.keys(nested ? receipt : accepted)) {
    for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
      const source = nested ? receipt : accepted;
      const duplicate = `{"${spelling}":${JSON.stringify(source[field])},${JSON.stringify(source).slice(1)}`;
      bodies.push([nested ? JSON.stringify(accepted).replace(JSON.stringify(receipt), duplicate) : duplicate, 'application/json', 'exact']);
    }
  }
  for (const [body, type, category] of bodies) {
    const page = observer(async () => new Response(body, { status: 202, headers: { 'content-type': type } })); await send(page);
    assert.deepEqual(plain(page.acceptanceWarningCapture.summary().failures), [`task:${category}`]);
  }
  let cancelled = 0;
  const original = response();
  original.clone = () => ({ body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled++; } }) } });
  const page = observer(async () => original, callback => setTimeout(callback, 10));
  assert.equal(await send(page), original);
  assert.equal(await original.text() === JSON.stringify(accepted), true);
  assert.equal(cancelled, 1);
  assert.deepEqual(plain(page.acceptanceWarningCapture.summary().failures), ['task:body']);
  assert.equal(JSON.stringify(page.acceptanceWarningCapture.summary()).includes('private-observer-canary'), false);
});

test('acceptance-warning memory oracle rejects earlier/provisional receipts, changed bytes, premature clearing and completion', async () => {
  for (const [change, field] of [
    [{ last_mutation: state.last_mutation }, 'lastMutationExact'],
    [{ last_mutation: { ...final.last_mutation, id: create } }, 'lastMutationExact'],
    [{ last_mutation: { ...final.last_mutation, reply: { ...accepted, warning_code: null } } }, 'lastMutationExact'],
    [{ pending: [pending] }, 'noPending'], [{ draft: expected.text }, 'draftClearedByAcceptance'],
    [{ selected: { ...final.selected, display: [{ ...canonical, execution: 'completed' }] } }, 'acceptedOnly'],
    [{ selected: { ...final.selected, display: [canonical, canonical] } }, 'acceptedOnly'],
  ]) {
    const page = observer(async () => response()); await send(page); page.publish({ ...final, ...change });
    assert.equal(page.acceptanceWarningCapture.memory(expected)[field], false);
  }
  const premature = observer(async () => response());
  premature.publish({ ...state, draft: '', pending: [pending] });
  assert.equal(premature.acceptanceWarningCapture.memory(expected).draftClearedByAcceptance, false);
  assert.deepEqual(plain(premature.acceptanceWarningCapture.summary().failures), ['memory:clear']);
  const changed = observer(async () => response());
  await changed.fetch(path, { method: 'POST', body: JSON.stringify({ ...command.body, text: 'changed' }) });
  await changed.acceptanceWarningCapture.drain(); changed.publish(final);
  assert.equal(changed.acceptanceWarningCapture.memory(expected).bytesExact, false);
  assert.equal(changed.acceptanceWarningCapture.memory({ ...expected, run: operation }).commandExact, false);
});

test('acceptance-warning accepts receipt-before-event without optimistic clearing and clears references on Disconnect', async () => {
  const page = observer(async () => response()); await send(page);
  page.publish({ ...state, draft: '', pending: [{ ...pending, phase: 'accepted', receipt, reply: accepted }] });
  page.publish(final);
  assert.deepEqual(Object.values(page.acceptanceWarningCapture.memory(expected)), Array(9).fill(true));
  page.publish({ connection: 'disconnected', pending: [], recoveries: [], draft: '', selected: null, last_mutation: null });
  assert.equal(page.acceptanceWarningCapture.cleared(), true);
});
