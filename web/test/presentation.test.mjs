import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { answer, data, labels, measurement, observe, skillOutput } from '../test-support/presentation.mjs';

const sample = { label: 'short-selected', first_page_ms: 0, durable_acceptance_ms: 1.25, committed_visibility_ms: 2,
  reducer_render_ms: 3, rebuild_ms: 4, stall_ms: 0, first_page_events: 1, history_pages: 4, selected_events: 100,
  selected_dom_nodes: 150, local_dom_nodes: 150, live_updates: 0, deltas: 64 };

test('finite measurement output has exactly three closed labels and numeric fields', () => {
  assert.equal(labels.length, 3);
  assert.equal(new Set(labels).size, 3);
  for (const label of labels) assert.deepEqual(measurement({ ...sample, label }), { ...sample, label });
  assert.equal(measurement({ ...sample, reducer_render_ms: 1.23456 }).reducer_render_ms, 1.23);
  for (const value of [null, [], {}, { ...sample, label: 'private-canary' }, { ...sample, token: 'private-canary' },
    { ...sample, path: '/private' }, { ...sample, selected_events: '100' }, { ...sample, selected_events: 1.5 },
    { ...sample, selected_events: 10001 }, { ...sample, reducer_render_ms: -1 }, { ...sample, first_page_ms: Infinity },
    { ...sample, durable_acceptance_ms: NaN }, { ...sample, stall_ms: 180001 }, { ...sample, live_updates: -1 }]) {
    assert.throws(() => measurement(value), { message: 'measurement rejected' });
  }
  for (const key of Object.keys(sample)) {
    const missing = { ...sample }; delete missing[key];
    assert.throws(() => measurement(missing), { message: 'measurement rejected' });
  }
});

test('page measurements keep request order, reset old reads and drain later response bodies', { timeout: 1000 }, async () => {
  const context = new EventEmitter();
  context.route = async () => {};
  const fixture = { origin: 'http://127.0.0.1:1234', owner: 'synthetic-owner' };
  const queue = [];
  let nativeCalls = 0;
  const sandbox = createContext({ URL, Request, location: { href: fixture.origin, origin: fixture.origin },
    fetch: async () => { nativeCalls++; return queue.shift(); } });
  context.exposeBinding = async (name, callback) => { sandbox[name] = value => Promise.resolve(callback({}, value)); };
  context.addInitScript = async callback => { runInContext(`(${callback})()`, sandbox); };
  context.pages = () => [{ evaluate: async (callback, argument) => {
    sandbox.argument = argument;
    return runInContext(`(${callback})(argument)`, sandbox);
  } }];
  const observed = await observe(context, fixture);
  async function response() {
    let writer;
    const original = new Response(new ReadableStream({ start(controller) { writer = controller; } }));
    queue.push(original);
    assert.equal(await sandbox.fetch(`${fixture.origin}/v1/sessions/fixture/history`), original);
    return events => { writer.enqueue(new TextEncoder().encode(JSON.stringify({ events }))); writer.close(); };
  }
  await observed.beginPage();
  const old = await response();
  await observed.beginPage();
  const first = await response();
  (await response())([2, 3]);
  let drained = false;
  const drain = observed.drain().then(() => { drained = true; });
  old([0]);
  const last = await response();
  first([1]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  last([4]);
  await drain;
  assert.equal(nativeCalls, 4);
  assert.deepEqual(observed.pages.map(page => page.events), [[1], [2, 3], [4]]);
  assert.equal(observed.firstPage().events, 1);
  assert.ok(Number.isFinite(observed.firstPage().ms));
  assert.equal(observed.faults.response, 0);
  await observed.beginPage();
  assert.equal(observed.firstPage(), null);
  assert.deepEqual(observed.pages, []);
});

test('only the designated observation abort may emit one known network console error', async () => {
  const context = new EventEmitter();
  for (const method of ['route', 'exposeBinding', 'addInitScript']) context[method] = async () => {};
  const fixture = { origin: 'http://127.0.0.1:1234', owner: 'synthetic-owner' };
  const observed = await observe(context, fixture);
  const page = new EventEmitter();
  context.emit('page', page);
  const url = `${fixture.origin}/v1/sessions/fixture/events?after=fixture:1`;
  const message = (text, location = url) => ({ type: () => 'error', text: () => text, location: () => ({ url: location }) });
  observed.expectReadAbort(url);
  page.emit('console', message('Failed to load resource: net::ERR_FAILED'));
  assert.equal(observed.faults.console, 0);
  page.emit('console', message('Failed to load resource: net::ERR_FAILED'));
  page.emit('console', message('Failed to load resource: net::ERR_FAILED', `${fixture.origin}/other`));
  page.emit('console', message('synthetic-owner'));
  assert.equal(observed.faults.console, 3);
  assert.equal(observed.faults.secret, 1);
});

test('presentation bytes remain distinct inert canaries and successful skill output remains a string', () => {
  assert.deepEqual(Object.keys(data), ['title', 'user', 'text', 'refusal', 'summary', 'reasoning', 'arguments', 'tool']);
  assert.equal(new Set(Object.values(data)).size, 8);
  for (const text of Object.values(data)) for (const marker of ['<script>', '<img', 'onerror=', 'javascript:', '\u001b', '雪', 'é', '😀']) {
    assert.ok(text.includes(marker));
  }
  assert.ok(data.user.endsWith('\n') && !data.user.includes('\r'));
  assert.equal(JSON.parse(skillOutput).body, data.tool);
  assert.ok(JSON.parse(skillOutput).body.startsWith('{"error":'));
  assert.ok(answer(0).includes('\r\n') && answer(0).endsWith('W'.repeat(2048)));
});
