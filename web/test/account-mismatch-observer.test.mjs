import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import { installAccountMismatchObserver } from '../test-support/account-mismatch.mjs';
const sid = '12345678-1234-4234-8234-123456789abc';
const ids = ['23456789', '3456789a', '456789ab', '56789abc', '6789abcd'].map(prefix => `${prefix}-1234-4234-8234-123456789abc`);
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${sid}/runs`;
const expected = [0, 1].map(index => ({ operation: ids[index * 2], run: ids[index * 2 + 1], text: `exact synthetic task ${index}\n 雪` }));
const commands = expected.map(value => ({ kind: 'task', id: value.operation, session_id: sid,
  body: { operation_id: value.operation, run_id: value.run, text: value.text } }));
const receipts = expected.map((value, index) => ({ operation_id: value.operation, session_id: sid, run_id: value.run,
  first_sequence: index === 0 ? '2' : '21', last_sequence: index === 0 ? '3' : '22' }));
const accepted = receipts.map(receipt => ({ api_version: 1, receipt, duplicate: false, warning_code: null, notices: [] }));
const zero = { turns_started: '0', turns_finished: '0', model_requests_attempted: '0', model_requests_admitted: '0',
  new_tool_dispatches: '0', tool_results_prepared: '0', reused_results: '0', last_request_id: null, last_upstream_outcome: null };
const canonical = expected.map((value, index) => {
  const outcome = index === 0 ? { type: 'completed' } : { type: 'failed', code: 'history_identity' };
  return { user_text: value.text, execution: outcome.type, result_recorded: true, entries: [], run: {
    run_id: value.run, accepted: { user_text: value.text }, accepted_sequence: receipts[index].first_sequence,
    started_sequence: index === 0 ? '4' : '23', interrupted: null, response_observations: [],
    finished: { sequence: index === 0 ? '19' : '25', data: { outcome, summary: zero } },
    result: { sequence: index === 0 ? '20' : '26', data: { outcome, summary: zero, events_complete: true, sink_error: null } },
  } };
});
const state = { connection: 'connected', pending: [], recoveries: [], draft: expected[0].text,
  last_mutation: { kind: 'create', id: ids[4] }, selected: { session_id: sid, display: [], observation_error: null,
    run_view: null, cancel: null, applied_cursor: `${sid}:1` } };
const finals = [0, 1].map(index => ({ ...state, draft: '', last_mutation: { kind: 'task', id: expected[index].operation,
  session_id: sid, receipt: receipts[index], reply: accepted[index], notices: [], canonical_read_error: null },
selected: { ...state.selected, display: canonical.slice(0, index + 1), applied_cursor: `${sid}:${index === 0 ? '20' : '26'}` } }));
const summary = { count: 2, replies: [202, 202].map(status => ({ status, decoded: true, validated: true, exact: true })), failures: [] };
const response = (value, status = 202, type = 'application/json') => new Response(JSON.stringify(value), { status, headers: { 'content-type': type } });
const plain = value => JSON.parse(JSON.stringify(value));
function observer(fetch, timeout = setTimeout) {
  const source = installAccountMismatchObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)');
  const page = { fetch, URL, Request, Response, ReadableStream, TextDecoder, TextEncoder, setTimeout: timeout, clearTimeout,
    validators: api, location: { origin, href: `${origin}/` } };
  runInNewContext(`(${source})(); globalThis.publish = value => { for (const child of Object.values(value))
    if (child && typeof child === 'object') publish(child); return Object.freeze(value); };`, page, { timeout: 1000 });
  page.accountMismatchCapture.select(sid); page.publish(state); sending(page, 0);
  return page;
}
function sending(page, index) {
  page.publish(commands[index]);
  page.publish({ ...(index === 0 ? state : finals[0]), draft: expected[index].text,
    pending: [{ command: commands[index], phase: 'sending' }] });
}
async function send(page, index) {
  const original = await page.fetch(path, { method: 'POST', body: JSON.stringify(commands[index].body) });
  await page.accountMismatchCapture.drain(); return original;
}
async function first(page) {
  await send(page, 0); page.publish(finals[0]);
  return page.accountMismatchCapture.first(expected[0], '20');
}
async function both(page) {
  await first(page); sending(page, 1); await send(page, 1); page.publish(finals[1]);
}
const memory = (page, draft = '') => page.accountMismatchCapture.completed({ first: expected[0], second: expected[1], draft, head: '26' });

test('account mismatch observes two normal accepted DTOs, frozen commands and canonical failure without changing originals', async () => {
  const originals = accepted.map(value => response(value)); let calls = 0;
  const page = observer(async () => originals[calls++]);
  assert.equal(await send(page, 0), originals[0]); page.publish(finals[0]);
  assert.deepEqual(Object.values(page.accountMismatchCapture.first(expected[0], '20')), Array(6).fill(true));
  page.publish({ ...finals[0], draft: 'edited before Send' });
  sending(page, 1); assert.equal(await send(page, 1), originals[1]); page.publish(finals[1]);
  assert.deepEqual(plain(page.accountMismatchCapture.summary()), summary);
  assert.deepEqual(Object.values(memory(page)), Array(10).fill(true));
  page.publish({ ...finals[1], draft: 'edited after Send' });
  assert.deepEqual(Object.values(memory(page, 'edited after Send')), Array(10).fill(true));
  for (const [index, original] of originals.entries()) assert.equal(await original.text() === JSON.stringify(accepted[index]), true);
  assert.equal(calls, 2);
});

test('account mismatch bounds clone reads, rejects malformed DTO/schema/media/UTF-8/size/private and duplicate keys', async () => {
  for (const index of [0, 1]) {
    const value = accepted[index];
    const cases = [[response(value, 422), 'status'], [response({ ...value, api_version: 2 }), 'schema'],
      [response(value, 202, 'text/plain'), 'media'], [response(value, 202, 'application/json; charset=latin1'), 'media'],
      [response({ ...value, duplicate: true }), 'exact'], [response({ ...value, warning_code: 'storage.io' }), 'exact'],
      [response({ ...value, notices: [{ scope: 'project', source_label: 'private-canary', kind: 'skipped_symlink' }] }), 'exact'],
      [response({ ...value, token: 'private-canary' }), 'schema'],
      [new Response('{bad', { status: 202, headers: { 'content-type': 'application/json' } }), 'json'],
      [new Response(new Uint8Array([0xff]), { status: 202 }), 'body'],
      [new Response('x'.repeat(4097), { status: 202 }), 'size']];
    for (const [object, nested] of [[value, false], [value.receipt, true]]) {
      for (const key of [...Object.keys(object), 'private']) {
        const changed = structuredClone(value); const target = nested ? changed.receipt : changed;
        if (key === 'private') target[key] = 'private-canary'; else delete target[key];
        cases.push([response(changed), 'schema']);
      }
      for (const key of Object.keys(object)) for (const spelling of [key, `\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}`]) {
        const duplicate = `{"${spelling}":${JSON.stringify(object[key])},${JSON.stringify(object).slice(1)}`;
        const raw = nested ? JSON.stringify(value).replace(JSON.stringify(object), duplicate) : duplicate;
        cases.push([new Response(raw, { status: 202, headers: { 'content-type': 'application/json' } }), 'exact']);
      }
    }
    for (const [change, category] of [[{ operation_id: sid }, 'exact'], [{ run_id: sid }, 'exact'], [{ session_id: ids[4] }, 'exact'],
      [{ first_sequence: '3', last_sequence: '4' }, 'exact'], [{ first_sequence: '02' }, 'schema'], [{ run_id: null }, 'schema']]) {
      cases.push([response({ ...value, receipt: { ...value.receipt, ...change } }), category]);
    }
    for (const [original, category] of cases) {
      let calls = 0;
      const page = observer(async () => calls++ === index ? original : response(accepted[0]));
      if (index === 1) { await first(page); sending(page, 1); }
      assert.equal(await send(page, index), original);
      const observed = plain(page.accountMismatchCapture.summary());
      assert.deepEqual(observed.failures, [`task:${category}`]);
      assert.equal(JSON.stringify(observed).includes('private-canary'), false);
    }
  }
});

test('account mismatch clones before import, does not consume original, times out and cancels only clone', async () => {
  const original = response(accepted[0]); let release;
  const page = observer(async () => original);
  page.validators = new Promise(resolve => { release = resolve; });
  assert.equal(await page.fetch(path, { method: 'POST', body: JSON.stringify(commands[0].body) }), original);
  assert.equal(await original.text() === JSON.stringify(accepted[0]), true);
  release(api); await page.accountMismatchCapture.drain();
  assert.deepEqual(plain(page.accountMismatchCapture.summary().failures), []);
  let cancelled = 0;
  const stalled = response(accepted[0]);
  stalled.clone = () => ({ body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled++; } }) } });
  const timeout = observer(async () => stalled, callback => setTimeout(callback, 10));
  assert.equal(await send(timeout, 0), stalled);
  assert.equal(await stalled.text() === JSON.stringify(accepted[0]), true);
  assert.equal(cancelled, 1);
  assert.deepEqual(plain(timeout.accountMismatchCapture.summary().failures), ['task:body']);
});

test('account mismatch rejects response/order/extra-task failures and drains reads added during draining', async () => {
  let release; let calls = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const page = observer(async () => calls++ === 0 ? delayed : response(accepted[1]));
  const firstSend = page.fetch(path, { method: 'POST', body: JSON.stringify(commands[0].body) });
  page.publish(finals[0]); page.accountMismatchCapture.first(expected[0], '20'); sending(page, 1);
  await send(page, 1); release(response(accepted[0])); await firstSend; await page.accountMismatchCapture.drain();
  assert.deepEqual(plain(page.accountMismatchCapture.summary().failures), ['task:order']);
  await page.fetch(path, { method: 'POST', body: '{}' });
  assert.deepEqual(plain(page.accountMismatchCapture.summary().failures), ['task:order', 'task:limit']);
  assert.equal(calls, 3);
  const streams = []; let next = 0;
  const originals = [0, 1].map(() => new Response(new ReadableStream({ start(controller) { streams.push(controller); } }), { status: 202, headers: { 'content-type': 'application/json' } }));
  const draining = observer(async () => originals[next++]);
  await draining.fetch(path, { method: 'POST', body: JSON.stringify(commands[0].body) });
  let done = false; const drain = draining.accountMismatchCapture.drain().then(() => { done = true; });
  draining.publish(finals[0]); draining.accountMismatchCapture.first(expected[0], '20'); sending(draining, 1);
  await draining.fetch(path, { method: 'POST', body: JSON.stringify(commands[1].body) });
  streams[0].enqueue(new TextEncoder().encode(JSON.stringify(accepted[0]))); streams[0].close();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(done, false);
  streams[1].enqueue(new TextEncoder().encode(JSON.stringify(accepted[1]))); streams[1].close();
  await drain; assert.deepEqual(plain(draining.accountMismatchCapture.summary()), summary);
  await Promise.all(originals.map(value => value.text()));
});

test('account mismatch observes only selected POSTs and returns unchanged responses for other reads', async () => {
  let calls = 0; let clones = 0;
  const page = observer(async () => { calls++; const value = response(accepted[0]); const clone = value.clone.bind(value);
    value.clone = () => { clones++; return clone(); }; return value; });
  for (const [url, method] of [[path, 'GET'], [`${path}?x=1`, 'POST'], [`${path}#x`, 'POST'],
    [`http://127.0.0.1:43211${path}`, 'POST'], ['/v1/settings', 'GET'], ['/v1/sessions', 'POST']]) {
    const original = await page.fetch(url, { method }); assert.equal(await original.text() === JSON.stringify(accepted[0]), true);
  }
  await page.accountMismatchCapture.drain(); assert.equal(clones, 0); assert.equal(calls, 6);
});

test('account mismatch immutable memory rejects changed commands, false completion, uncertainty, summary or first history changes', async () => {
  for (const [change, field] of [
    [{ last_mutation: finals[0].last_mutation }, 'outcome'], [{ pending: [{ command: commands[1], phase: 'uncertain' }] }, 'quiet'],
    [{ recoveries: [{ command: commands[1], phase: 'accepted' }] }, 'quiet'], [{ draft: 'changed' }, 'draft'],
    [{ selected: { ...finals[1].selected, applied_cursor: `${sid}:25` } }, 'head'],
    [{ selected: { ...finals[1].selected, display: [{ ...canonical[0], user_text: 'changed' }, canonical[1]] } }, 'firstStable'],
    ...['completed', 'accepted', 'running'].map(execution => [{ selected: { ...finals[1].selected, display: [canonical[0], { ...canonical[1], execution }] } }, 'canonical']),
    ...[{ entries: [{}] }, { result_recorded: false }, { user_text: 'changed' },
      { run: { ...canonical[1].run, finished: null } }, { run: { ...canonical[1].run, result: null } },
      { run: { ...canonical[1].run, started_sequence: '24' } },
      { run: { ...canonical[1].run, result: { ...canonical[1].run.result, data: { ...canonical[1].run.result.data, summary: { ...zero, model_requests_attempted: '1' } } } } },
      { run: { ...canonical[1].run, result: { ...canonical[1].run.result, data: { ...canonical[1].run.result.data, outcome: { type: 'failed', code: 'provider_error' } } } } },
    ].map(change => [{ selected: { ...finals[1].selected, display: [canonical[0], { ...canonical[1], ...change }] } }, 'canonical']),
  ]) {
    let calls = 0; const page = observer(async () => response(accepted[calls++])); await both(page);
    page.publish({ ...finals[1], ...change }); assert.equal(memory(page)[field], false);
  }
  let calls = 0; const page = observer(async () => response(accepted[calls++])); await both(page);
  page.publish({ ...commands[1], body: { ...commands[1].body, text: 'changed' } });
  assert.deepEqual(plain(page.accountMismatchCapture.summary().failures), ['memory:command']);
});

test('account mismatch rejects premature clearing and duplicate finalization, fences teardown and clears all retained references', async () => {
  const premature = observer(async () => response(accepted[0])); premature.publish({ ...state, draft: '' });
  assert.deepEqual(plain(premature.accountMismatchCapture.summary().failures), ['memory:clear']);
  let calls = 0; const page = observer(async () => response(accepted[calls++])); await both(page);
  page.publish(finals[0]); page.publish(finals[1]); assert.equal(memory(page).once, false);
  page.publish({ connection: 'disconnected', pending: [], recoveries: [], draft: '', selected: null, last_mutation: null });
  assert.equal(page.accountMismatchCapture.cleared(), true);
  const stalled = []; const original = new Response(new ReadableStream({ start(controller) { stalled.push(controller); } }), { status: 202 });
  const late = observer(async () => original);
  await late.fetch(path, { method: 'POST', body: JSON.stringify(commands[0].body) });
  late.publish({ connection: 'disconnected', pending: [], recoveries: [], draft: '', selected: null, last_mutation: null });
  stalled[0].enqueue(new TextEncoder().encode(JSON.stringify(accepted[0]))); stalled[0].close();
  await late.accountMismatchCapture.drain(); assert.equal(late.accountMismatchCapture.cleared(), true);
  assert.equal(await original.text() === JSON.stringify(accepted[0]), true);
});
