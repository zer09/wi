import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import { installIncompleteHistoryObserver } from '../test-support/incomplete-history.mjs';

const sid = '12345678-1234-4234-8234-123456789abc';
const ids = ['23456789', '3456789a', '456789ab', '56789abc', '6789abcd'].map(prefix => `${prefix}-1234-4234-8234-123456789abc`);
const [operation, run, create, secondOperation, secondRun] = ids;
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${sid}/runs`;
const receipt = { operation_id: operation, session_id: sid, run_id: run, first_sequence: '2', last_sequence: '3' };
const accepted = { api_version: 1, receipt, duplicate: false, warning_code: 'storage.connection_cleanup_failed', notices: [] };
const rejected = { api_version: 1, code: 'invalid_request', stage: 'history', certainty: 'not_applicable', acceptance: null, notices: [] };
const expected = [{ operation, run, text: 'synthetic old task' }, { operation: secondOperation, run: secondRun, text: 'synthetic new task' }];
const commands = expected.map(value => ({ kind: 'task', id: value.operation, session_id: sid,
  body: { operation_id: value.operation, run_id: value.run, text: value.text } }));
const pending = commands.map(command => ({ command, phase: 'sending', error: null, notices: [], receipt: null, reply: null,
  canonical_seen: false, canonical_sequence: null }));
const state = { connection: 'connected', error: null, pending: [], recoveries: [], draft: expected[0].text,
  last_mutation: { kind: 'create', id: create }, selected: { session_id: sid, display: [], observation_error: null,
    run_view: null, cancel: null, applied_cursor: `${sid}:1` } };
const canonical = { user_text: expected[0].text, execution: 'accepted', result_recorded: false, entries: [],
  run: { run_id: run, accepted_sequence: '2', accepted: { user_text: expected[0].text }, started_sequence: null, finished: null, result: null, interrupted: null } };
const firstFinal = { ...state, draft: '', last_mutation: { kind: 'task', id: operation, session_id: sid, receipt, reply: accepted,
  notices: [], canonical_read_error: null }, selected: { ...state.selected, display: [canonical], applied_cursor: `${sid}:3` } };
const serverError = { code: rejected.code, stage: rejected.stage, certainty: rejected.certainty, acceptance: rejected.acceptance, notices: rejected.notices };
const final = { ...firstFinal, draft: expected[1].text, pending: [{ ...pending[1], phase: 'rejected', error: { category: 'http', status: 422, server: serverError } }] };
const plain = value => JSON.parse(JSON.stringify(value));
const response = (value, status) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const summary = { count: 2, replies: [202, 422].map(status => ({ status, decoded: true, validated: true, exact: true })), failures: [] };
function observer(fetch, timeout = setTimeout) {
  const source = installIncompleteHistoryObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)');
  const page = { fetch, URL, Request, TextDecoder, TextEncoder, setTimeout: timeout, clearTimeout, validators: api, location: { href: `${origin}/`, origin } };
  runInNewContext(`(${source})({ secrets: ['private-observer-canary'] });
    globalThis.publish = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') publish(child); return Object.freeze(value); };`, page, { timeout: 1000 });
  page.incompleteHistoryCapture.select(sid);
  page.publish(state); page.publish(commands[0]); page.publish({ ...state, pending: [pending[0]] });
  return page;
}
async function send(page, index) {
  const result = await page.fetch(path, { method: 'POST', body: JSON.stringify(commands[index].body) });
  await page.incompleteHistoryCapture.drain();
  return result;
}
async function first(page) {
  await send(page, 0); page.publish(firstFinal);
}
function second(page) {
  page.publish(commands[1]); page.publish({ ...firstFinal, draft: expected[1].text, pending: [pending[1]] });
}
const memory = (page, draft = expected[1].text) => page.incompleteHistoryCapture.rejected({ first: expected[0], second: expected[1], draft });

test('incomplete-history observes ordered actual DTOs and leaves both original responses unchanged', async () => {
  const originals = [response(accepted, 202), response(rejected, 422)];
  let calls = 0;
  const page = observer(async () => originals[calls++]);
  assert.equal(await send(page, 0), originals[0]); page.publish(firstFinal);
  assert.deepEqual(Object.values(page.incompleteHistoryCapture.accepted(expected[0])), Array(9).fill(true));
  second(page); assert.equal(await send(page, 1), originals[1]); page.publish(final);
  assert.deepEqual(plain(page.incompleteHistoryCapture.summary()), summary);
  assert.deepEqual(Object.values(memory(page)), Array(11).fill(true));
  for (const [index, value] of [accepted, rejected].entries()) assert.equal(await originals[index].text() === JSON.stringify(value), true);
  page.publish({ ...final, draft: 'edited but not sent' });
  assert.deepEqual(Object.values(memory(page, 'edited but not sent')), Array(11).fill(true));
  assert.equal(calls, 2);
});

test('incomplete-history clones before an asynchronous validator import lets the application consume each original', async () => {
  let calls = 0;
  const page = observer(async () => calls++ === 0 ? response(accepted, 202) : response(rejected, 422));
  for (const index of [0, 1]) {
    let release;
    page.validators = new Promise(resolve => { release = resolve; });
    if (index === 1) second(page);
    const original = await page.fetch(path, { method: 'POST', body: JSON.stringify(commands[index].body) });
    assert.equal(await original.text() === JSON.stringify(index === 0 ? accepted : rejected), true);
    release(api); await page.incompleteHistoryCapture.drain();
    if (index === 0) page.publish(firstFinal);
  }
  assert.deepEqual(plain(page.incompleteHistoryCapture.summary()), summary);
});

test('incomplete-history clones only two selected task replies, returns every original and adds no request', async () => {
  let calls = 0; let clones = 0;
  const page = observer(async () => {
    calls++; const reply = response(accepted, 202); const clone = reply.clone.bind(reply);
    reply.clone = () => { clones++; return clone(); }; return reply;
  });
  for (const [url, method] of [[path, 'GET'], [`${path}?extra=1`, 'POST'], [`${path}#x`, 'POST'],
    [`http://127.0.0.1:43211${path}`, 'POST'], ['/v1/sessions', 'POST'], ['/v1/settings', 'GET'],
    [path, 'POST'], [path, 'POST'], [path, 'POST']]) await page.fetch(url, { method, body: method === 'POST' ? '{}' : undefined });
  await page.incompleteHistoryCapture.drain();
  assert.equal(calls, 9); assert.equal(clones, 1); // The second status is wrong, so it needs no body read.
  assert.equal(page.incompleteHistoryCapture.summary().count, 2);
  assert.deepEqual(plain(page.incompleteHistoryCapture.summary().failures), ['task:status', 'task:limit']);
});

test('incomplete-history rejects missing/extra fields and wrong actual schemas in both replies', async () => {
  const cases = [
    [0, { ...accepted, duplicate: 'false' }, 202, 'schema'], [0, { ...accepted, duplicate: true }, 202, 'exact'],
    [0, { ...accepted, warning_code: null }, 202, 'exact'], [0, { ...accepted, warning_code: 'storage.io' }, 202, 'exact'],
    [1, { ...rejected, code: 'context.invalid_request' }, 422, 'exact'],
    [1, { ...rejected, code: 'api.invalid_request' }, 422, 'exact'],
    [1, { ...rejected, stage: 'preflight' }, 422, 'exact'], [1, { ...rejected, stage: null }, 422, 'exact'],
    [1, { ...rejected, certainty: 'unknown' }, 422, 'exact'], [1, { ...rejected, certainty: 'not_committed' }, 422, 'exact'],
    [1, { ...rejected, acceptance: receipt }, 422, 'exact'],
  ];
  for (const [index, dto] of [accepted, rejected].entries()) {
    cases.push([index, dto, 503, 'status'], [index, { value: dto }, index === 0 ? 202 : 422, 'schema'],
      [index, { ...dto, api_version: 2 }, index === 0 ? 202 : 422, 'schema'],
      [index, { ...dto, notices: [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }] }, index === 0 ? 202 : 422, 'exact']);
    for (const field of [...Object.keys(dto), 'extra']) {
      const value = structuredClone(dto);
      if (field === 'extra') value.extra = true; else delete value[field];
      cases.push([index, value, index === 0 ? 202 : 422, 'schema']);
    }
  }
  for (const field of [...Object.keys(receipt), 'extra']) {
    const value = structuredClone(accepted);
    if (field === 'extra') value.receipt.extra = true; else delete value.receipt[field];
    cases.push([0, value, 202, 'schema']);
  }
  for (const [change, category] of [[{ operation_id: run }, 'exact'], [{ run_id: operation }, 'exact'], [{ session_id: run }, 'exact'],
    [{ first_sequence: '3', last_sequence: '4' }, 'exact'], [{ first_sequence: '02' }, 'schema'], [{ last_sequence: 3 }, 'schema'],
    [{ run_id: null }, 'schema'], [{ operation_id: 'not-an-id' }, 'schema']]) cases.push([0, { ...accepted, receipt: { ...receipt, ...change } }, 202, category]);
  for (const [index, value, status, category] of cases) {
    let calls = 0;
    const page = observer(async () => calls++ === index ? response(value, status) : response(accepted, 202));
    if (index === 1) { await first(page); second(page); }
    await send(page, index);
    assert.deepEqual(plain(page.incompleteHistoryCapture.summary().failures), [`task:${category}`]);
  }
});

test('incomplete-history rejects duplicate/escaped keys, media, JSON, UTF-8, size and secret negatives in either response', async () => {
  for (const [index, dto] of [accepted, rejected].entries()) {
    const status = index === 0 ? 202 : 422;
    const bodies = [['{bad', 'application/json', 'json'], [JSON.stringify(dto), 'text/plain', 'media'],
      [JSON.stringify(dto), 'application/json; charset=latin1', 'media'], [new Uint8Array([0xff]), 'application/json', 'body'],
      [JSON.stringify('private-observer-canary'), 'application/json', 'secret'], ['x'.repeat(4097), 'application/json', 'size']];
    for (const nested of index === 0 ? [false, true] : [false]) for (const field of Object.keys(nested ? receipt : dto)) {
      for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
        const source = nested ? receipt : dto;
        const duplicate = `{"${spelling}":${JSON.stringify(source[field])},${JSON.stringify(source).slice(1)}`;
        bodies.push([nested ? JSON.stringify(dto).replace(JSON.stringify(receipt), duplicate) : duplicate, 'application/json', 'exact']);
      }
    }
    for (const [body, type, category] of bodies) {
      let calls = 0;
      const page = observer(async () => calls++ === index ? new Response(body, { status, headers: { 'content-type': type } }) : response(accepted, 202));
      if (index === 1) { await first(page); second(page); }
      await send(page, index);
      assert.deepEqual(plain(page.incompleteHistoryCapture.summary().failures), [`task:${category}`]);
      assert.equal(JSON.stringify(page.incompleteHistoryCapture.summary()).includes('private-observer-canary'), false);
    }
  }
});

test('incomplete-history read deadlines cancel only clones and preserve original bodies', async () => {
  for (const index of [0, 1]) {
    let cancelled = 0; let calls = 0;
    const original = response(index === 0 ? accepted : rejected, index === 0 ? 202 : 422);
    original.clone = () => ({ body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled++; } }) } });
    const page = observer(async () => calls++ === index ? original : response(accepted, 202), callback => setTimeout(callback, 10));
    if (index === 1) { await first(page); second(page); }
    assert.equal(await send(page, index), original);
    assert.equal(await original.text() === JSON.stringify(index === 0 ? accepted : rejected), true);
    assert.equal(cancelled, 1);
    assert.deepEqual(plain(page.incompleteHistoryCapture.summary().failures), ['task:body']);
  }
});

test('incomplete-history drain waits for reads added while the first read is pending', async () => {
  const streams = [];
  const originals = [202, 422].map(status => new Response(new ReadableStream({ start(controller) { streams.push(controller); } }),
    { status, headers: { 'content-type': 'application/json' } }));
  let calls = 0; let drained = false;
  const page = observer(async () => originals[calls++]);
  await page.fetch(path, { method: 'POST', body: JSON.stringify(commands[0].body) });
  const drain = page.incompleteHistoryCapture.drain().then(() => { drained = true; });
  second(page);
  await page.fetch(path, { method: 'POST', body: JSON.stringify(commands[1].body) });
  streams[0].enqueue(new TextEncoder().encode(JSON.stringify(accepted))); streams[0].close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(drained, false);
  streams[1].enqueue(new TextEncoder().encode(JSON.stringify(rejected))); streams[1].close();
  await drain;
  assert.deepEqual(plain(page.incompleteHistoryCapture.summary()), summary);
  await Promise.all(originals.map(value => value.text()));
});

test('incomplete-history rejects reversed response order and never reorders or retries the originals', async () => {
  let release; let calls = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const page = observer(async () => calls++ === 0 ? delayed : response(rejected, 422));
  const firstRequest = page.fetch(path, { method: 'POST', body: JSON.stringify(commands[0].body) });
  second(page); await send(page, 1);
  const original = response(accepted, 202); release(original);
  assert.equal(await firstRequest, original); await page.incompleteHistoryCapture.drain();
  assert.deepEqual(plain(page.incompleteHistoryCapture.summary().failures), ['task:order']);
  assert.equal(calls, 2);
});

test('incomplete-history memory rejects changed identities, bytes, local receipts, completion and uncertain second commands', async () => {
  for (const [change, field] of [
    [{ last_mutation: state.last_mutation }, 'lastMutationUnchanged'],
    [{ last_mutation: { ...firstFinal.last_mutation, id: secondOperation } }, 'lastMutationUnchanged'],
    [{ last_mutation: { ...firstFinal.last_mutation, reply: { ...accepted, warning_code: null } } }, 'lastMutationUnchanged'],
    [{ draft: '' }, 'draftExact'],
    [{ pending: [{ ...final.pending[0], command: { ...commands[1], body: { ...commands[1].body, text: 'edited' } } }] }, 'commandsExact'],
    [{ pending: [{ ...final.pending[0], command: { ...commands[1], id: operation } }] }, 'commandsExact'],
    [{ pending: [{ ...final.pending[0], command: { ...commands[1], body: { ...commands[1].body, run_id: run } } }] }, 'commandsExact'],
    ...[{ category: 'network' }, { status: 503 }, { server: rejected },
      ...[{ code: 'context.invalid_request' }, { stage: 'preflight' }, { certainty: 'unknown' }, { acceptance: receipt }, { notices: ['unexpected'] }]
        .map(change => ({ server: { ...serverError, ...change } })),
      ...Object.keys(serverError).map(field => ({ server: Object.fromEntries(Object.entries(serverError).filter(([key]) => key !== field)) })),
    ].map(change => [{ pending: [{ ...final.pending[0], error: { ...final.pending[0].error, ...change } }] }, 'errorExact']),
    [{ pending: [{ ...final.pending[0], receipt }] }, 'noAcceptance'],
    [{ pending: [{ ...final.pending[0], canonical_seen: true, canonical_sequence: '2' }] }, 'noAcceptance'],
    ...['uncertain', 'accepted', 'completed'].map(phase => [{ pending: [{ ...final.pending[0], phase }] }, 'rejectedOnly']),
    [{ selected: { ...final.selected, display: [{ ...canonical, execution: 'completed' }] } }, 'canonicalOnly'],
    [{ selected: { ...final.selected, display: [canonical, canonical] } }, 'canonicalOnly'],
  ]) {
    let calls = 0;
    const page = observer(async () => calls++ === 0 ? response(accepted, 202) : response(rejected, 422));
    await first(page); second(page); await send(page, 1); page.publish({ ...final, ...change });
    assert.equal(memory(page)[field], false);
  }
  let calls = 0;
  const changed = observer(async () => calls++ === 0 ? response(accepted, 202) : response(rejected, 422));
  await first(changed); second(changed);
  await changed.fetch(path, { method: 'POST', body: JSON.stringify({ ...commands[1].body, text: 'changed' }) });
  await changed.incompleteHistoryCapture.drain(); changed.publish(final);
  assert.equal(memory(changed).bytesExact, false);
});

test('incomplete-history accepts either receipt/event ordering, rejects duplicate finalization and clears references on Disconnect', async () => {
  for (const receiptFirst of [true, false]) {
    const page = observer(async () => response(accepted, 202)); await send(page, 0);
    page.publish({ ...state, draft: '', pending: [{ ...pending[0], phase: 'accepted', receipt: receiptFirst ? receipt : null }],
      selected: receiptFirst ? state.selected : firstFinal.selected });
    page.publish(firstFinal);
    assert.deepEqual(Object.values(page.incompleteHistoryCapture.accepted(expected[0])), Array(9).fill(true));
    page.publish({ ...firstFinal, last_mutation: state.last_mutation }); page.publish(firstFinal);
    assert.equal(page.incompleteHistoryCapture.accepted(expected[0]).finalizedOnce, false);
    assert.deepEqual(plain(page.incompleteHistoryCapture.summary().failures), ['memory:outcome']);
    page.publish({ connection: 'disconnected', pending: [], recoveries: [], draft: '', selected: null, last_mutation: null });
    assert.equal(page.incompleteHistoryCapture.cleared(), true);
  }
  const premature = observer(async () => response(accepted, 202));
  premature.publish({ ...state, draft: '', pending: [pending[0]] });
  assert.equal(premature.incompleteHistoryCapture.accepted(expected[0]).clearedOnce, false);
  assert.deepEqual(plain(premature.incompleteHistoryCapture.summary().failures), ['memory:clear']);
});
