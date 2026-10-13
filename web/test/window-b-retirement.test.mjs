import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFixture, parseControl, stdoutParser } from '../test-support/fixture.mjs';
import { startScenario } from '../test-support/cancellation-protocol.mjs';
import { createDisplayClient } from '../dist/display-client.js';
import { WiConversationSseParser } from '../dist/sse.js';
import { SID, RID, OID, page, batch, session, entry, field, block, upsert } from '../test-support/display-fixtures.mjs';

const base = { transport: 'websocket', recovered: false, mime: true };
const rejected = { message: 'fixture protocol rejected' };
const frame = value => `event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`;
const bytes = value => new TextEncoder().encode(value);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// This peer records only command names. The shared fixture owns its isolated child and teardown.
async function peer(t) {
  const root = await mkdtemp(join(tmpdir(), 'wi-retirement-peer-'));
  const executable = join(root, 'peer.mjs'), owned = join(root, 'owned.json'), closure = join(root, 'closure.json');
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const commands = [];
fs.writeFileSync(${JSON.stringify(owned)}, JSON.stringify({ pid: process.pid, sandbox: process.cwd() }));
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  commands.push({ command: request.command ?? 'start', id: request.id });
  const reply = { protocol: 1, id: request.id };
  if (!request.command) Object.assign(reply, { event: 'ready', origin: 'http://127.0.0.1:1' });
  else if (request.command === 'stop') Object.assign(reply, { event: 'stopped', cleaned: true });
  else process.exit(7);
  process.stdout.write(JSON.stringify(reply) + '\\n');
  if (request.command === 'stop') {
    fs.writeFileSync(${JSON.stringify(closure)}, JSON.stringify(commands));
    lines.close();
    process.stdout.end(() => process.exit(0));
  }
});
`, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { executable, owned, closure };
}

for (const value of [true, false, null, 0, 'false']) test(`retired Start key ${JSON.stringify(value)} rejects before child launch`, async t => {
  const p = await peer(t);
  await assert.rejects(startFixture(p.executable, { ...base, read_reconnect: value }), rejected);
  await assert.rejects(access(p.owned), { code: 'ENOENT' });
});
for (const raw of [
  '{"transport":"websocket","recovered":false,"mime":true,"read_reconnect":false,"read_reconnect":true}',
  '{"transport":"websocket","recovered":false,"mime":true,"read_\\u0072econnect":false}',
]) test(`retired Start raw ambiguity ${raw.includes('\\') ? 'escaped' : 'duplicate'} rejects before child launch`, async t => {
  const p = await peer(t);
  await assert.rejects(startFixture(p.executable, raw), rejected);
  await assert.rejects(access(p.owned), { code: 'ENOENT' });
});

for (const [name, scenario] of [
  ['ordinary', base], ['provider SSE', { transport: 'sse', recovered: true, mime: false }],
  ['presentation', { ...base, presentation: true }], ['mutations', { ...base, mutations: true }],
  ['unbound history', { ...base, mutations: true, unbound_history: true }],
  ['fixed head', { ...base, mutations: true, fixed_head: true }],
  ['tool fidelity', { ...base, tool_fidelity: true }], ['lifecycle', { ...base, lifecycle_failure: true }],
  ['cancellation', { ...base, cancellation: true }], ['disabled cancellation', { ...base, cancellation: false }],
]) test(`cancellation-backed Start chain retains ${name}`, () => {
  for (const raw of [scenario, JSON.stringify(scenario)]) {
    assert.deepEqual(startScenario(raw), scenario);
    assert.equal(Object.isFrozen(startScenario(raw)), true);
  }
  assert.throws(() => startScenario({ ...scenario, read_reconnect: false }), rejected);
  assert.throws(() => startScenario({ ...scenario, private: false }), rejected);
});

for (const [name, scenario] of [['ordinary', base], ['lifecycle', { ...base, lifecycle_failure: true }], ['cancellation', { ...base, cancellation: true }]]) {
  test(`retired controls reject before stdin and preserve ${name} ready/Stop identity and cleanup`, async t => {
    const p = await peer(t), fixture = await startFixture(p.executable, scenario);
    t.after(() => fixture.stop().catch(() => {}));
    const owned = JSON.parse(await readFile(p.owned, 'utf8'));
    for (const step of ['pending', 'arm', 'written', 'release', 'retired', 'inspect']) {
      await assert.rejects(fixture.request({ command: 'read_reconnect', step, window: 1, subscription: 1,
        session_id: SID, run_id: RID, operation_id: OID }), rejected);
    }
    await assert.rejects(fixture.request({ command: 'read_reconnect', id: 2 }), rejected);
    await fixture.stop();
    assert.deepEqual(JSON.parse(await readFile(p.closure, 'utf8')), [{ command: 'start', id: 1 }, { command: 'stop', id: 2 }]);
    const facts = fixture.evidence();
    assert.equal(facts.failure, null);
    for (const key of ['attempted', 'clean_acknowledgment', 'reap_complete', 'sandbox_removed', 'exit_observed', 'exit_zero', 'stderr_empty']) assert.equal(facts.stop[key], true);
    for (const key of ['sigterm', 'sigkill', 'error_latched']) assert.equal(facts.stop[key], false);
    assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(owned.sandbox), { code: 'ENOENT' });
  });
}

for (const step of ['pending', 'arm', 'written', 'release', 'retired', 'inspect']) test(`retired stdout ${step} rejects before publication`, () => {
  const value = { protocol: 1, event: 'read_reconnect', id: 3, step, window: 1, subscription: 1,
    session_id: SID, run_id: RID, operation_id: OID };
  assert.throws(() => parseControl(value), rejected);
  const published = [], parser = stdoutParser(v => published.push(v));
  parser.push(Buffer.from('{"protocol":1,"event":"selected","id":2}\n'));
  const raw = Buffer.from(JSON.stringify(value) + '\n');
  for (const byte of raw.subarray(0, -1)) parser.push(Buffer.from([byte]));
  assert.equal(published.length, 1);
  assert.throws(() => parser.push(raw.subarray(-1)), rejected);
  assert.deepEqual(published, [{ protocol: 1, event: 'selected', id: 2 }]);
});
test('retired stdout duplicate and escaped fields never publish', () => {
  for (const raw of [
    '{"protocol":1,"event":"read_reconnect","id":3}',
    '{"protocol":1,"event":"read_reconnect","id":3,"id":4}',
    '{"protocol":1,"event":"read_\\u0072econnect","id":3}',
  ]) {
    let publications = 0;
    assert.throws(() => stdoutParser(() => { publications++; }).push(Buffer.from(raw + '\n')), rejected);
    assert.equal(publications, 0);
  }
});

for (const [name, raw] of [
  ['literal', '{"protocol":1,"event":"read_reconnect","event":"task_finished","task":1}'],
  ['earlier escaped key', '{"protocol":1,"\\u0065vent":"read_reconnect","event":"task_finished","task":1}'],
  ['later escaped key', '{"protocol":1,"event":"read_reconnect","e\\u0076ent":"task_finished","task":1}'],
  ['both escaped keys', '{"protocol":1,"\\u0065vent":"read_reconnect","e\\u0076ent":"task_finished","task":1}'],
  ['escaped retired value', '{"protocol":1,"event":"read_\\u0072econnect","event":"task_finished","task":1}'],
  ['reversed', '{"protocol":1,"event":"task_finished","event":"read_reconnect","task":1}'],
  ['retained duplicate', '{"protocol":1,"event":"task_finished","event":"task_finished","task":1}'],
  ['nested between members', '{"protocol":1,"event":"read_reconnect","task":{"event":"read_reconnect"},"event":"task_finished","task":1}'],
]) test(`stdout parser rejects duplicate top-level event ${name}`, () => {
  const line = Buffer.from(raw + '\n');
  const unpublished = [];
  assert.throws(() => stdoutParser(value => unpublished.push(value)).push(line), rejected);
  assert.deepEqual(unpublished, []);
  for (const split of [false, true]) {
    const published = [], parser = stdoutParser(value => published.push(value));
    parser.push(Buffer.from('{"protocol":1,"event":"selected","id":2}\n'));
    if (split) {
      for (const byte of line.subarray(0, -1)) parser.push(Buffer.from([byte]));
      assert.deepEqual(published, [{ protocol: 1, event: 'selected', id: 2 }]);
      assert.throws(() => parser.push(line.subarray(-1)), rejected);
    } else {
      assert.throws(() => parser.push(line), rejected);
    }
    assert.deepEqual(published, [{ protocol: 1, event: 'selected', id: 2 }]);
  }
});
test('stdout parser retains single decoded events and existing non-event member handling', () => {
  for (const raw of [
    '{"protocol":1,"event":"task_finished","task":1}',
    '{"protocol":1,"\\u0065vent":"task_\\u0066inished","task":1}',
    // Other members still use the existing schema rules, not a new all-key duplicate policy.
    '{"protocol":"{\\\"event\\\":\\\"read_reconnect\\\",\\\"event\\\":\\\"task_finished\\\"} [] \\\\","protocol":1,"event":"task_finished","task":1}',
    '{"protocol":1,"task":{"event":"read_reconnect","event":"task_finished","items":[{"event":"event"}]},"event":"task_finished","task":1}',
  ]) {
    const published = [], parser = stdoutParser(value => published.push(value));
    for (const byte of Buffer.from(raw + '\n')) parser.push(Buffer.from([byte]));
    parser.end();
    assert.deepEqual(published, [{ protocol: 1, event: 'task_finished', task: 1 }]);
  }
});
test('stdout parser retains nested receipt validation with the event member after the object', () => {
  const value = { protocol: 1, id: 3, receipt: { operation_id: OID, session_id: SID, run_id: RID,
    first_sequence: '2', last_sequence: '3' }, event: 'task_inspect', exact: true,
    accepted_event_id: '44444444-4444-4444-8444-444444444444',
    checkpoint_event_id: '55555555-5555-4555-8555-555555555555', sequence_count: '3',
    task_commands: 1, runs: 1, acceptance_events: 1, selection_events: 1, binding_events: 0,
    rename_events: 0, run_state: 'accepted', deltas: 0, tool_starts: 0, tool_finishes: 0 };
  const published = [], parser = stdoutParser(reply => published.push(reply));
  parser.push(Buffer.from(JSON.stringify(value) + '\n'));
  parser.end();
  assert.deepEqual(published, [value]);
});

async function display(t) {
  let stream;
  const calls = [], publications = [];
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const client = createDisplayClient({ fetch: async (path, init) => {
    calls.push({ path, method: init.method });
    if (path === '/v1/settings') return json({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic',
      model: 'synthetic', provider_transport: 'sse', enable_add_numbers: false });
    if (path === '/v1/sessions?limit=32') return json({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path === `/v1/sessions/${SID}/conversation`) return json(page());
    if (path === `/v1/sessions/${SID}/conversation/events?after=${page().live_after}`) {
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }, { highWaterMark: 0 }),
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw Error('unexpected synthetic request');
  } });
  t.after(() => client.disconnect());
  client.subscribe(snapshot => { if (snapshot.selected?.store) publications.push(snapshot.selected.store); });
  await client.connect('ab'.repeat(32));
  await client.selectSession(SID);
  await flush();
  assert.equal(client.snapshot().selected.observation, 'streaming');
  assert.equal(calls.length, 4);
  return { client, calls, publications, push: text => stream.enqueue(bytes(text)), end: () => stream.close() };
}
const rename = () => batch([{ kind: 'session.upsert', session: session('5', { title: 'Applied frame' }) }]);

test('actual controller partial display frame and EOF retain prior state and cursor', async t => {
  const h = await display(t), before = h.client.snapshot().selected.store, mark = h.publications.length;
  h.push(frame(rename()).slice(0, -1));
  await flush();
  assert.deepEqual(h.client.snapshot().selected.store, before);
  h.end();
  await flush();
  const selected = h.client.snapshot().selected;
  assert.deepEqual(selected.store, before);
  assert.equal(selected.observation, 'disconnected');
  assert.equal(selected.observation_error, null);
  assert.ok(h.publications.slice(mark).every(store => JSON.stringify(store) === JSON.stringify(before)));
  assert.equal(h.calls.length, 4);
});
test('actual controller applies a delimited frame before a later suffix failure', async t => {
  const h = await display(t), value = rename();
  h.push(frame(value).slice(0, -1));
  await flush();
  assert.equal(h.client.snapshot().selected.store.live_after, page().live_after);
  h.push('\nevent: wi.conversation\ndata: {\n\n');
  await flush();
  const selected = h.client.snapshot().selected;
  assert.equal(selected.store.live_after, value.next_after);
  assert.equal(selected.store.session.title, 'Applied frame');
  assert.equal(selected.observation, 'disconnected');
  assert.equal(selected.observation_error.category, 'protocol');
  assert.ok(h.publications.some(store => store.live_after === value.next_after && store.session.title === 'Applied frame'));
  assert.equal(h.calls.length, 4);
});
test('actual controller application rejection preserves the whole prior state and cursor', async t => {
  const h = await display(t), before = h.client.snapshot().selected.store, mark = h.publications.length;
  // The DTO is valid, but matching-generation overlapping text disagrees with the installed range.
  const value = batch([{ kind: 'session.upsert', session: session('5', { title: 'Must not publish' }) },
    upsert(entry({ revision: '5', fields: [field({ text: 'xyz' })] }), block({ revision: '5' }))]);
  h.push(frame(value));
  await flush();
  const selected = h.client.snapshot().selected;
  assert.deepEqual(selected.store, before);
  assert.equal(selected.observation, 'disconnected');
  assert.equal(selected.observation_error.category, 'protocol');
  assert.ok(h.publications.slice(mark).every(store => JSON.stringify(store) === JSON.stringify(before)));
  assert.equal(h.calls.length, 4);
});
test('actual parser consumer rejection does not publish a cursor or consume a later frame', () => {
  let applied = page().live_after, calls = 0;
  const parser = new WiConversationSseParser(SID, () => {
    calls++;
    throw Error('synthetic consumer failure');
  });
  assert.throws(() => parser.push(bytes(frame(rename()) + frame(batch([], '6')))), { message: 'protocol.consumer_failed' });
  assert.equal(calls, 1);
  assert.equal(applied, page().live_after);
  assert.equal(parser.done, true);
});
