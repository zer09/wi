import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import ts from 'typescript';
import * as f from '../test-support/display-fixtures.mjs';
import { CHILD_TEST } from '../test-support/fixture.mjs';
import { decodeJson } from '../dist/api.js';
import { data } from '../test-support/presentation.mjs';
import { richPartialFacts, expectedBlock, displayedBlock } from '../test-support/rich-display-parity.mjs';
import { workKeys, workProof, messageProof, closedJson, restartParser, restartProtocol, terminalProof, runningProof,
  interruptedProof, stableProof, entryProof, receiptProof, handshakeProof, allowedRequest, createRestartRoot, rootProof } from '../test-support/restart-display.mjs';

const ready = phase => ({ protocol: 1, event: 'ready', phase, pid: 123, origin: 'http://127.0.0.1:1234' });
const work = phase => Object.fromEntries(workKeys.map((key, index) => [key, key === 'fresh_empty' ? phase === 'produce' : phase === 'produce' && index < 7 ? 1 : 0]));
const event = (name, id, extra = {}) => ({ protocol: 1, event: name, id, ...extra });
function selected(phase) {
  const p = restartProtocol(phase, 123); p.reply(ready(phase));
  p.request({ command: 'select', id: 1, session_id: f.SID }); p.reply(event('selected', 1)); return p;
}
function held() {
  const p = selected('produce'); p.reply({ protocol: 1, event: 'model_paused', gate: 1 });
  p.request({ command: 'drive', id: 2, gate: 1 }); p.reply(event('driven', 2));
  p.reply({ protocol: 1, event: 'model_paused', gate: 2 }); return p;
}
for (const phase of ['produce', 'observe']) test(`closed Work validates exact ${phase} counters`, () => { assert.equal(workProof(work(phase), phase).fresh_empty, phase === 'produce'); });
for (const phase of ['produce', 'observe']) for (const key of workKeys) test(`Work rejects changed ${phase}/${key}`, () => {
  const value = work(phase); value[key] = key === 'fresh_empty' ? !value[key] : value[key] + 1;
  assert.throws(() => workProof(value, phase));
});
for (const value of [null, {}, { ...work('observe'), extra: 0 }, { ...work('observe'), connections: '0' }, { ...work('observe'), completed: -1 }]) test('Work rejects malformed closed shape', () => { assert.throws(() => workProof(value, 'observe')); });
test('producer controls enforce actual partial gates and expected death; observer drains', () => {
  const p = held(); p.request({ command: 'sample', id: 3 }); p.reply(event('sample', 3, { work: work('produce') })); p.end(true);
  assert.throws(() => p.end(false));
  const o = selected('observe'); o.request({ command: 'sample', id: 2 }); o.reply(event('sample', 2, { work: work('observe') }));
  o.request({ command: 'stop', id: 3 }); o.reply(event('stopped', 3, { work: work('observe'), drained: true })); o.end(false);
  assert.throws(() => o.reply(event('sample', 4, { work: work('observe') })));
});
const protocolChanges = {
  'wrong ready PID': () => restartProtocol('observe', 123).reply({ ...ready('observe'), pid: 124 }),
  'wrong phase': () => restartProtocol('observe', 123).reply(ready('produce')),
  'ready twice': () => { const p = selected('observe'); p.reply(ready('observe')); },
  'unknown field': () => selected('observe').request({ command: 'sample', id: 2, extra: 1 }),
  'old Start control': () => selected('observe').request({ command: 'start', id: 2 }),
  'invalid session': () => { const p = restartProtocol('produce', 123); p.reply(ready('produce')); p.request({ command: 'select', id: 1, session_id: 'not-session' }); },
  'duplicate selection': () => selected('observe').request({ command: 'select', id: 2, session_id: f.OTHER }),
  'stale ID': () => selected('observe').request({ command: 'sample', id: 1 }),
  'zero ID': () => selected('observe').request({ command: 'sample', id: 0 }),
  'ID overflow': () => selected('observe').request({ command: 'sample', id: 0x100000000 }),
  'missing acknowledgment': () => { const p = selected('observe'); p.request({ command: 'sample', id: 2 }); p.end(false); },
  'pending control': () => { const p = selected('observe'); p.request({ command: 'sample', id: 2 }); p.request({ command: 'stop', id: 3 }); },
  'wrong acknowledgment ID': () => { const p = selected('observe'); p.request({ command: 'sample', id: 2 }); p.reply(event('sample', 3, { work: work('observe') })); },
  'wrong acknowledgment kind': () => { const p = selected('observe'); p.request({ command: 'sample', id: 2 }); p.reply(event('selected', 2)); },
  'unsolicited acknowledgment': () => selected('observe').reply(event('selected', 1)),
  'observer drive': () => selected('observe').request({ command: 'drive', id: 2, gate: 1 }),
  'observer provider gate': () => selected('observe').reply({ protocol: 1, event: 'model_paused', gate: 1 }),
  'producer early sample': () => selected('produce').request({ command: 'sample', id: 2 }),
  'producer Stop': () => held().request({ command: 'stop', id: 3 }),
  'wrong gate': () => selected('produce').reply({ protocol: 1, event: 'model_paused', gate: 2 }),
  'duplicate gate': () => held().reply({ protocol: 1, event: 'model_paused', gate: 2 }),
  'repeated Drive': () => held().request({ command: 'drive', id: 3, gate: 1 }),
  'unacknowledged kill': () => { const p = held(); p.request({ command: 'sample', id: 3 }); p.end(true); },
  'nonzero observer work': () => { const p = selected('observe'); p.request({ command: 'sample', id: 2 }); p.reply(event('sample', 2, { work: { ...work('observe'), connections: 1 } })); },
  'undrained Stop': () => { const p = selected('observe'); p.request({ command: 'stop', id: 2 }); p.reply(event('stopped', 2, { work: work('observe'), drained: false })); },
};
for (const [name, change] of Object.entries(protocolChanges)) test(`protocol rejects ${name}`, () => assert.throws(change));
for (const change of [v => { v.id = 1; }, v => { v.protocol = 2; }, v => { v.origin = 'https://external.invalid'; },
  v => { v.origin += '/'; }, v => { v.phase = 'old'; }, v => { v.pid = 0; }, v => { v.event = 'unknown'; }]) test('Ready rejects malformed private message', () => { const v = ready('observe'); change(v); assert.throws(() => messageProof(v)); });

const prefix = `\nrunning 1 test\ntest ${CHILD_TEST} ... `;
const line = value => JSON.stringify(value) + '\n';
const ending = '\nok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1195 filtered out; finished in 0.01s\n\n';
for (const split of [1, 2, 7, 512]) test(`fatal UTF8 newline parser accepts bounded split ${split}`, () => {
  const values = [], parser = restartParser(value => values.push(value));
  const bytes = Buffer.from(prefix + line(ready('observe')) + ending);
  for (let offset = 0; offset < bytes.length; offset += split) parser.push(bytes.subarray(offset, offset + split));
  parser.end(false); assert.deepEqual(values, [ready('observe')]);
});
for (const [name, bytes, killed] of [
  ['duplicate decoded top name', prefix + '{"protocol":1,"event":"ready","event":"ready","phase":"observe","pid":123,"origin":"http://127.0.0.1:1234"}\n', true],
  ['escaped duplicate name', prefix + '{"protocol":1,"event":"ready","ev\\u0065nt":"ready","phase":"observe","pid":123,"origin":"http://127.0.0.1:1234"}\n', true],
  ['nested duplicate Work', prefix + line(ready('observe')) + '{"protocol":1,"event":"sample","id":1,"work":{"connections":0,"connections":1}}\n', true],
  ['unknown Work key', prefix + line(event('sample', 1, { work: { ...work('observe'), private: 0 } })), true],
  ['unknown harness output', prefix + line(ready('observe')) + 'native panic must not escape\n', true],
  ['bare Ready without harness', line(ready('observe')), true],
  ['bad JSON', prefix + '{"protocol":\n', true],
  ['partial EOF', prefix + line(ready('observe')).trimEnd(), true],
  ['oversized line', prefix + '{' + 'x'.repeat(4096) + '\n', true],
  ['nonzero test summary', prefix + line(ready('observe')) + '\nok\ntest result: FAILED. 0 passed; 1 failed\n', false],
  ['missing successful summary', prefix + line(ready('observe')), false],
  ['unexpected normal completion of producer', prefix + line(ready('produce')) + ending, true],
  ['fatal invalid UTF8', Buffer.concat([Buffer.from(prefix), Buffer.from([255, 10])]), true],
  ['fatal incomplete UTF8', Buffer.concat([Buffer.from(prefix), Buffer.from([0xe9])]), true],
  ['total bound', prefix + '\n'.repeat(65536), true],
]) test(`parser rejects ${name}`, () => { const p = restartParser(() => {}); assert.throws(() => { p.push(Buffer.from(bytes)); p.end(killed); }); });
test('closed JSON rejects nested escaped duplicates but accepts legitimate distinct names', () => {
  assert.throws(() => closedJson('{"work":{"id":1,"\\u0069d":2}}'));
  assert.deepEqual(closedJson('{"a":{"id":1},"b":{"id":2}}'), { a: { id: 1 }, b: { id: 2 } });
});

const command = { operation_id: f.OID, run_id: f.RID, text: data.user };
const receipt = { operation_id: f.OID, session_id: f.SID, run_id: f.RID, first_sequence: '2', last_sequence: '3' };
function richPage() {
  const indexes = [[0, 0, null, 0], [1, 0, 0, null], [2, 1, 0, null], [3, 1, 1, null],
    [4, 2, null, null], [5, 2, null, null], [4, 3, null, null], [5, 3, null, null], [4, 4, null, null], [5, 4, null, null], [8, 5, null, null]];
  const fields = richPartialFacts.map(([kind, text], index) => {
    const [rank, output, content, summary] = indexes[index];
    return f.field({ field_id: (index + 1).toString(16).repeat(64), kind, text, total_bytes: String(Buffer.byteLength(text)),
      to_byte: String(Buffer.byteLength(text)), order_key: f.order(rank, output, content, summary) });
  });
  const human = f.human({ fields: [f.field({ field_id: 'text', order_key: '0', generation: '2', text: data.user,
    total_bytes: String(Buffer.byteLength(data.user)), to_byte: String(Buffer.byteLength(data.user)) })] });
  return f.page({ snapshot_head: '23', session: f.session('23', { title: data.title }), block: f.block({ human, revision: '23' }),
    entries: [f.entry({ fields, revision: '23' })], previous_block: null, live_after: f.cursor('l', '23', '3', '', '') });
}
function interrupted() {
  const page = richPage(); page.snapshot_head = '24'; page.session.head_sequence = '24'; page.session.updated_at_ms = '3';
  page.block.state = 'interrupted'; page.block.revision = '24'; page.entries[0].recorded_state = 'interrupted'; page.entries[0].revision = '24';
  page.live_after = f.cursor('l', '24', '3', '', ''); return page;
}
test('typed public running and interruption proofs preserve all content while settling only metadata', () => {
  assert.deepEqual(runningProof(richPage(), f.SID, command, receipt, '/synthetic/project'), richPage());
  assert.deepEqual(interruptedProof(interrupted(), richPage()), interrupted()); assert.deepEqual(stableProof(interrupted(), interrupted()), interrupted());
});
const mutations = {
  'missing interruption': p => { p.block.state = 'running'; },
  'extra canonical head': p => { p.snapshot_head = '25'; p.session.head_sequence = '25'; p.live_after = f.cursor('l', '25', '3', '', ''); },
  'uninterrupted assistant': p => { p.entries[0].recorded_state = 'in_progress'; },
  'invented result': p => { p.block.result_recorded = true; },
  'invented outcome': p => { p.block.outcome = { type: 'completed' }; },
  'moved human': p => { p.block.human.entry_id = 'e:3:0'; },
  'changed user bytes': p => { p.block.human.fields[0].text += ' '; },
  'changed entry identity': p => { p.entries[0].entry_id = 'e:5:0'; p.entries[0].position.sequence = '5'; p.entries[0].content_epoch = '5'; },
  'changed field identity': p => { p.entries[0].fields[0].field_id = 'f'.repeat(64); },
  'changed epoch': p => { p.entries[0].content_epoch = '5'; },
  'changed generation': p => { p.entries[0].fields[0].generation = '5'; },
  'changed range': p => { p.entries[0].fields[0].from_byte = '1'; },
  'changed rich bytes': p => { p.entries[0].fields[0].text += ' '; },
  'changed order': p => { p.entries[0].fields.reverse(); },
  'lost rich field': p => { p.entries[0].fields.splice(1, 1); },
  'extra tool': p => { p.entries.push(f.entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '24', kind: 'tool' })); },
  'changed provisional': p => { p.entries[0].provisional = false; },
  'changed human state': p => { p.block.human.recorded_state = 'interrupted'; },
  'changed session source': p => { p.session.workspace = '/synthetic/changed'; },
  'older timestamp': p => { p.session.updated_at_ms = '1'; },
  'changed creation': p => { p.session.created_at_ms = '2'; },
  'private field': p => { p.block.private = 'synthetic private'; },
};
for (const [name, change] of Object.entries(mutations)) test(`restart public preservation rejects ${name}`, () => { const p = interrupted(); change(p); assert.throws(() => interruptedProof(p, richPage())); });
for (const name of ['generation', 'revision', 'bytes']) test(`warm exact snapshot rejects changed ${name}`, () => {
  const p = interrupted(); if (name === 'generation') p.entries[0].fields[0].generation = '5';
  else if (name === 'revision') p.entries[0].revision = '23'; else p.entries[0].fields[0].text += ' ';
  assert.throws(() => stableProof(p, interrupted()));
});
test('addressed typed entries and exact same-body receipt bind to running and interrupted snapshots', () => {
  for (const p of [richPage(), interrupted()]) {
    for (const entry of [p.block.human, ...p.entries]) {
      const value = f.addressed(entry, p.block, p.snapshot_head); assert.deepEqual(entryProof(value, p, entry), value);
      assert.throws(() => entryProof({ ...value, snapshot_head: '25' }, p, entry));
    }
    const value = f.reconciliation(); value.run.user_text = data.user; value.run.state = p.block.state;
    value.run.terminal_sequence = p.block.state === 'interrupted' ? '24' : null;
    assert.deepEqual(receiptProof(value, p, command, receipt), value);
    for (const change of [v => { v.acceptance.operation_id = f.OTHER; }, v => { v.run.user_text += ' '; },
      v => { v.acceptance.last_sequence = '4'; }, v => { v.run.state = 'completed'; }, v => { v.run.result_recorded = true; }]) {
      const current = structuredClone(value); change(current); assert.throws(() => receiptProof(current, p, command, receipt));
    }
  }
});
function handshake() {
  const value = interrupted(), origin = 'http://127.0.0.1:1234', url = `${origin}/v1/sessions/${f.SID}/conversation`;
  const request = { method: () => 'GET', url: () => url }, streamRequest = { method: () => 'GET', url: () => `${url}/events?after=${encodeURIComponent(value.live_after)}` };
  const headers = type => ({ 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  const reply = { request: () => request, url: () => url, status: () => 200, headers: () => headers('application/json') };
  const streamReply = { request: () => streamRequest, status: () => 200, headers: () => headers('text/event-stream') };
  for (const key of ['body', 'json', 'text']) Object.defineProperty(reply, key, { get() { assert.fail('Original Latest body must not be duplicated'); } });
  return { origin, sid: f.SID, head: '24', value, reply, snapshots: [{ request, index: 0, response: reply }], streams: [{ request: streamRequest, index: 1, response: reply, reply: streamReply }] };
}
test('original Latest identity and headers precede matching actual SSE without reading duplicate body', () => assert.equal(handshakeProof(handshake()), true));
for (const [name, change] of Object.entries({
  'different Request': h => { h.snapshots[0].request = { ...h.snapshots[0].request }; },
  'different Response': h => { h.streams[0].response = { ...h.reply }; },
  'early SSE': h => { h.streams[0].index = 0; },
  'missing SSE reply': h => { h.streams[0].reply = null; },
  'mismatched head': h => { h.head = '25'; },
  'duplicate Latest': h => { h.snapshots.push(h.snapshots[0]); },
  'unknown query': h => { const url = h.streams[0].request.url(); h.streams[0].request.url = () => url + '&extra=1'; },
  'bad Latest MIME': h => { h.reply.headers = () => ({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'text/plain' }); },
  'bad stream status': h => { h.streams[0].reply.status = () => 503; },
  'cookie header': h => { const headers = h.reply.headers(); h.reply.headers = () => ({ ...headers, 'set-cookie': 'synthetic' }); },
})) test(`original handshake rejects ${name}`, () => { const h = handshake(); change(h); assert.throws(() => handshakeProof(h)); });

const terminal = killed => ({ closed: true, reaped: true, stderr_bytes: 0, error: false, fallback: false, code: killed ? null : 0,
  signal: killed ? 'SIGKILL' : null, expected_kill: killed, same_start_alive: false, drained: !killed });
for (const killed of [false, true]) test(`strict owned terminal distinguishes ${killed ? 'expected SIGKILL' : 'normal drain'}`, () => assert.equal(terminalProof(terminal(killed), killed), true));
for (const killed of [false, true]) for (const key of ['closed', 'reaped', 'stderr_bytes', 'error', 'fallback', 'code', 'signal', 'expected_kill', 'same_start_alive']) test(`strict cleanup rejects ${killed}/${key}`, () => {
  const facts = terminal(killed); facts[key] = typeof facts[key] === 'boolean' ? !facts[key] : key === 'stderr_bytes' ? 1 : key === 'code' ? 1 : 'SIGTERM';
  assert.throws(() => terminalProof(facts, killed));
});
test('normal observer completion requires drained=true, never fallback reap', () => assert.throws(() => terminalProof({ ...terminal(false), drained: false }, false)));
test('owned synthetic root has exact isolated phases, skills, private owner mode and unchanged source', async () => {
  const fixture = await createRestartRoot();
  try {
    assert.equal(await rootProof(fixture, 'produce'), true); assert.equal(await rootProof(fixture, 'observe'), true);
    await writeFile(`${fixture.workspace}/AGENTS.md`, 'synthetic changed source'); await assert.rejects(rootProof(fixture, 'observe'));
  } finally { await rm(fixture.root, { recursive: true }); }
});
for (const [method, path, permission, expected] of [
  ['GET', '/v1/settings', 'none', true], ['GET', '/v1/sessions?limit=32', 'none', true],
  ['GET', `/v1/sessions/${f.SID}/conversation`, 'none', true],
  ['GET', `/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l', '24', '3', '', ''))}`, 'none', true],
  ['GET', `/v1/sessions/${f.SID}`, 'none', false], ['GET', `/v1/sessions/${f.SID}/history`, 'none', false],
  ['POST', '/v1/sessions', 'none', false], ['POST', '/v1/sessions', 'create', true],
  ['POST', `/v1/sessions/${f.SID}/runs`, 'none', false], ['POST', `/v1/sessions/${f.SID}/runs`, 'task', true],
  ['POST', `/v1/sessions/${f.SID}/runs/reconcile`, 'none', false], ['POST', `/v1/sessions/${f.SID}/runs/${f.RID}/cancel`, 'task', false],
]) test(`actual request allowlist enforces ${method}/${permission}/${expected}`, () => assert.equal(allowedRequest(method, new URL(path, 'http://127.0.0.1:1234'), f.SID, permission), expected));

for (const variant of ['valid', 'bad-status', 'bad-media', 'bad-schema', 'bad-UTF8', 'oversized', 'body-rejected']) test(`independent HTTP proof rejects faults without retry: ${variant}`, async () => {
  let calls = 0;
  const fetch = async (url, init) => {
    calls++; assert.equal(url, `http://127.0.0.1:1234/v1/sessions/${f.SID}/conversation`);
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'GET');
    let bytes = Buffer.from(JSON.stringify(interrupted()));
    if (variant === 'bad-schema') bytes = Buffer.from('{}'); if (variant === 'bad-UTF8') bytes = Buffer.from([255]); if (variant === 'oversized') bytes = Buffer.alloc(524289);
    return { status: variant === 'bad-status' ? 503 : 200, headers: new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': variant === 'bad-media' ? 'text/plain' : 'application/json' }),
      arrayBuffer: async () => { if (variant === 'body-rejected') throw Error('synthetic body rejection'); return bytes; } };
  };
  const source = ts.createSourceFile('helper.mjs', readFileSync(new URL('../test-support/restart-display.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'publicJson').getText(source).replace('export ', '');
  const proof = runInNewContext(`${fn};publicJson(process,owner,suffix,validate)`, {
    fetch, process: { origin: 'http://127.0.0.1:1234' }, owner: 'synthetic-owner', suffix: `/v1/sessions/${f.SID}/conversation`,
    validate: value => stableProof(value, interrupted()), TextDecoder, AbortSignal, decodeJson, reject: () => { throw Error('synthetic rejection'); },
  });
  if (variant === 'valid') await proof; else await assert.rejects(proof);
  assert.equal(calls, 1);
});

const spec = readFileSync(new URL('../e2e/restart-display.spec.mjs', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../test-support/restart-display.mjs', import.meta.url), 'utf8');
const bindingExecutable = '/synthetic/compiler';
const bindingRoot = '/synthetic/repository';
const bindingSources = ['src/providers/openai_codex/tests/replay/http_api_joined/browser.rs',
  'src/providers/openai_codex/tests/replay/http_api_joined/browser/restart.rs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function bindingControls(env) {
  const ast = ts.createSourceFile('helper.mjs', helper, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node) ? node.name.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(ast) === name)).getText(ast).replace('export ', '');
  const files = new Map([[bindingExecutable, Buffer.from('synthetic compiler bytes')], ...bindingSources.map(file =>
    [join(bindingRoot, file), readFileSync(new URL(`../../${file}`, import.meta.url))])]);
  const facts = { canonical: bindingExecutable, regular: true, spawn: 0, calls: [] };
  // Extract the real functions; only their filesystem, environment and spawn dependencies are synthetic.
  const functions = runInNewContext(`${['reject', 'sha', 'nativeBinding', 'startRestartProcess'].map(declaration).join('\n')};({nativeBinding,startRestartProcess})`, {
    createHash, isAbsolute, join, ROOT: bindingRoot, process: { env },
    realpath: async path => { facts.calls.push(['realpath', path]); return facts.canonical; },
    lstat: async path => { facts.calls.push(['lstat', path]); return { isFile: () => facts.regular }; },
    readFile: async path => { facts.calls.push(['readFile', path]); assert.ok(files.has(path)); return files.get(path); },
    rootProof: async (fixture, phase) => { assert.equal(fixture.root, '/synthetic/wi-restart-root'); facts.calls.push(['rootProof', phase]); },
    spawn: () => { facts.spawn++; assert.fail('Binding controls must not spawn'); },
  });
  return { ...functions, files, facts };
}
test('actual native binding accepts path-only and matching pins with the same computed executable and source hashes', async () => {
  const expected = { executable: bindingExecutable, sha256: digest(Buffer.from('synthetic compiler bytes')),
    sources: Object.fromEntries(bindingSources.map(file => [file, digest(readFileSync(new URL(`../../${file}`, import.meta.url)))])) };
  for (const env of [{ WI_C3A_FIXTURE: bindingExecutable }, { WI_C3A_FIXTURE: bindingExecutable, WI_C47_FIXTURE_SHA256: expected.sha256 }]) {
    const controls = bindingControls(env), binding = await controls.nativeBinding(bindingExecutable);
    assert.deepEqual(JSON.parse(JSON.stringify(binding)), expected);
    assert.deepEqual(controls.facts.calls, [['realpath', bindingExecutable], ['lstat', bindingExecutable],
      ['readFile', bindingExecutable], ...bindingSources.map(file => ['readFile', join(bindingRoot, file)])]);
    assert.equal(controls.facts.spawn, 0);
  }
});
for (const [name, pin] of [['mismatch', '0'.repeat(64)], ['empty', ''], ['malformed', 'not-a-digest']]) test(`actual native binding rejects supplied ${name} digest`, async () => {
  const controls = bindingControls({ WI_C3A_FIXTURE: bindingExecutable, WI_C47_FIXTURE_SHA256: pin });
  await assert.rejects(controls.nativeBinding(bindingExecutable), /Restart display rejected/);
  assert.deepEqual(controls.facts.calls, [['realpath', bindingExecutable], ['lstat', bindingExecutable], ['readFile', bindingExecutable]]);
  assert.equal(controls.facts.spawn, 0);
});
for (const supplied of [false, true]) for (const defect of ['relative path', 'wrong path', 'noncanonical', 'nonregular', ...bindingSources]) test(`actual native binding retains ${defect} rejection with supplied pin=${supplied}`, async () => {
  const env = { WI_C3A_FIXTURE: bindingExecutable };
  if (supplied) env.WI_C47_FIXTURE_SHA256 = digest(Buffer.from('synthetic compiler bytes'));
  const controls = bindingControls(env);
  let executable = bindingExecutable;
  if (defect === 'relative path') executable = 'synthetic/compiler';
  else if (defect === 'wrong path') env.WI_C3A_FIXTURE = '/synthetic/other-compiler';
  else if (defect === 'noncanonical') controls.facts.canonical = '/synthetic/real-compiler';
  else if (defect === 'nonregular') controls.facts.regular = false;
  else controls.files.set(join(bindingRoot, defect), Buffer.from('synthetic changed native source'));
  await assert.rejects(controls.nativeBinding(executable), /Restart display rejected/);
  assert.equal(controls.facts.spawn, 0);
});
for (const phase of ['produce', 'observe']) test(`actual ${phase} pre-spawn rehash rejects changed executable before spawn`, async () => {
  const controls = bindingControls({ WI_C3A_FIXTURE: bindingExecutable });
  const binding = await controls.nativeBinding(bindingExecutable);
  controls.files.set(bindingExecutable, Buffer.from('synthetic changed executable'));
  controls.facts.calls.length = 0;
  await assert.rejects(controls.startRestartProcess(binding, { root: '/synthetic/wi-restart-root' }, phase), /Restart display rejected/);
  assert.deepEqual(controls.facts.calls, [['rootProof', phase], ['readFile', bindingExecutable]]);
  assert.equal(controls.facts.spawn, 0);
});
test('current path-only workflow publication reaches actual case binding before root creation', async () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const publication = workflow.match(/appendFileSync\(process\.env\.GITHUB_ENV, `([^=]+)=\$\{await discoverFixture\(\)\}\\n`\);/);
  assert.ok(publication); assert.equal(publication[1], 'WI_C3A_FIXTURE');
  assert.ok(workflow.indexOf('Publish browser fixture executable') < workflow.indexOf('- run: npm run test:e2e'));
  assert.ok(!/WI_C47_FIXTURE_SHA256|test:e2e[^\n]*(?:--grep|--project)|test:e2e:/.test(workflow));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:e2e'], 'playwright test');
  const config = readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  assert.ok(config.includes("testDir: './e2e'")); assert.ok(!/testIgnore|grep|testMatch/.test(config));
  let prior = -1;
  for (const term of ['const executable = await discoverFixture()', 'const binding = await nativeBinding(executable)', 'fixture = await createRestartRoot()', "await startRestartProcess(binding, fixture, 'produce')"]) {
    const index = spec.indexOf(term); assert.ok(index > prior); prior = index;
  }
  const controls = bindingControls({ [publication[1]]: bindingExecutable });
  const binding = await controls.nativeBinding(bindingExecutable);
  assert.equal(binding.sha256, digest(controls.files.get(bindingExecutable)));
  assert.equal(controls.facts.spawn, 0);
  assert.ok(!controls.facts.calls.some(([name]) => name === 'rootProof'));
});
test('actual process source retains root validation and independent executable rehash immediately before each spawn', () => {
  const ast = ts.createSourceFile('helper.mjs', helper, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const start = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'startRestartProcess').getText(ast);
  assert.ok(start.includes("await rootProof(fixture, phase);\n  if (sha(await readFile(binding.executable)) !== binding.sha256) reject();"));
  assert.ok(start.indexOf('if (sha(await readFile(binding.executable))') < start.indexOf('const child = spawn(binding.executable'));
  assert.equal((spec.match(/await startRestartProcess\(binding, fixture, '(produce|observe)'\)/g) ?? []).length, 2);
});
function scenarioSource(text, support = helper) {
  const source = ts.createSourceFile('restart-display.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = []; function visit(node) { if (ts.isCallExpression(node)) calls.push(node.expression.getText(source)); ts.forEachChild(node, visit); } visit(source);
  for (const [name, count] of [['test', 1], ['startRestartProcess', 2], ['browser.newContext', 2], ['producer.killProducer', 1], ['observer.stopObserver', 1], ['removeRestartRoot', 1]]) assert.equal(calls.filter(value => value === name).length, count);
  const order = ["stage = 'task'", "stage = 'partial'", "stage = 'close-a'", 'await producer.killProducer()', "stage = 'observe'", 'await observer.sample()', "stage = 'connect-b'", 'const [originalLatest]', "await exact(transcript(b).locator('.run > .metadata')", 'const after = await publicJson(observer', 'await observer.stopObserver()', 'await removeRestartRoot'];
  let prior = -1; for (const term of order) { const index = text.indexOf(term); assert.ok(index > prior); prior = index; }
  assert.ok(text.includes('for (const round of [1, 2])')); assert.ok(text.includes("button(b, 'Reconnect latest').click()"));
  assert.ok(text.includes('value => interruptedProof(value, before)')); assert.ok(text.includes('readOnly(records[1].requests)'));
  assert.ok(text.includes("permission = 'none'; await producer.wait(1)"));
  assert.equal((text.match(/button\(a, 'Send'\)\.click\(\)/g) ?? []).length, 1);
  assert.ok(!text.includes("button(b, 'Send')"));
  assert.ok(!/setTimeout|test\.(skip|only)|\.newCDPSession|\.fulfill\s*\(|originalLatest\.(json|body|text)\s*\(/.test(text));
  assert.ok(!/startFixture\(|stdoutParser\(|\/history|\/events\?after=|globalThis\.fetch\s*=/.test(support));
  assert.ok(support.includes('WI_NATIVE_RESTART_CHILD: \'1\''));
  assert.ok(support.includes("const argv = ['--ignored', '--exact', CHILD_TEST, '--nocapture', '--test-threads=1']"));
  assert.ok(support.includes("if (phase !== 'produce' || failure || facts.closed) reject()"));
  assert.ok(support.includes("child.kill('SIGKILL')")); assert.ok(support.includes('terminalProof(facts, false)'));
  assert.ok(support.includes('await rootProof(fixture, \'observe\')')); assert.ok(support.includes('await rm(fixture.root, { recursive: true })'));
}
test('actual scenario source pins browser-triggered recovery, no copied memory and strict process ownership', () => scenarioSource(spec));
for (const [name, change] of Object.entries({
  'recovery pre-trigger': s => s.replace('const [originalLatest]', 'const after = await publicJson(observer; const [originalLatest]'),
  'missing native kill': s => s.replace('await producer.killProducer()', 'await producer.fallback()'),
  'second browser Task': s => s.replace('await observer.stopObserver()', "await button(b, 'Send').click(); await observer.stopObserver()"),
  'timeout inflation': s => s.replace("stage = 'task'", "test.setTimeout(180000); stage = 'task'"),
  'duplicate Latest body': s => s.replace('const after = await publicJson(observer', 'await originalLatest.json(); const after = await publicJson(observer'),
  'missing warm round': s => s.replace('for (const round of [1, 2])', 'for (const round of [1])'),
  'no read-only guard': s => s.replace('readOnly(records[1].requests)', 'true'),
})) test(`source sensitivity rejects ${name}`, () => assert.throws(() => scenarioSource(change(spec))));
for (const [name, change] of Object.entries({
  'old Start parser': s => s + '\nstdoutParser(() => {});', 'ambient environment': s => s.replace("WI_NATIVE_RESTART_CHILD: '1'", '...process.env'),
  'wrong child arguments': s => s.replace("'--test-threads=1'", "'--test-threads=8'"), 'fallback as normal drain': s => s.replace('terminalProof(facts, false)', 'terminalProof(facts, true)'),
  'missing root cleanup': s => s.replace('await rm(fixture.root, { recursive: true })', 'void 0'),
})) test(`helper source sensitivity rejects ${name}`, () => assert.throws(() => scenarioSource(spec, change(helper))));

test('actual privacy and asset observers retain DOM/text-only/storage/header barriers', async () => {
  const ast = ts.createSourceFile('spec.mjs', spec, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(ast);
  let value = interrupted();
  const expect = actual => ({ toBe: expected => assert.equal(actual, expected) });
  runInNewContext(`${fn('publicPrivacy')};publicPrivacy(value,owner)`, { value, owner: 'synthetic-owner', markers: ['private-native'], expect });
  value = { ...value, private: 'private-native' };
  assert.throws(() => runInNewContext(`${fn('publicPrivacy')};publicPrivacy(value,owner)`, { value, owner: 'synthetic-owner', markers: ['private-native'], expect }));
  for (const term of ['localStorage.length === 0', 'sessionStorage.length === 0', 'indexedDB.databases()', 'context.cookies()', "headers['x-content-type-options'] !== 'nosniff'", "headers['set-cookie'] !== undefined", "!bytes.equals(await readFile"]) assert.ok(spec.includes(term));
  const page = interrupted(), expected = expectedBlock(page);
  assert.equal(expected.entries[1].state, 'Recorded state: interrupted; Provisional: true');
  assert.equal(expected.entries.flatMap(entry => entry.fields).length, 12);
  assert.equal(isDeepStrictEqual(expectedBlock(page).entries[1].fields, expected.entries[1].fields), true);
  assert.equal(typeof displayedBlock, 'function');
});
