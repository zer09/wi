import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { decodeJson } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import * as f from '../test-support/display-fixtures.mjs';
import { Element, button as domButton, control, byClass } from '../test-support/display-dom.mjs';
import { answer, data, skillOutput } from '../test-support/presentation.mjs';

const text = readFileSync(new URL('../e2e/presentation.spec.mjs', import.meta.url), 'utf8');
const source = ts.createSourceFile('presentation.js', text, ts.ScriptTarget.Latest, true);
const call = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'test');
const callback = call.expression.arguments[1];
const loop = callback.body.statements.find(ts.isForOfStatement);
const attempt = loop.statement.statements.find(ts.isTryStatement);
const declarations = loop.statement.statements.filter(ts.isVariableStatement).map(node => node.getText(source)).join('\n');
const top = source.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)).map(node => node.getText(source)).join('\n');
const helper = name => attempt.tryBlock.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(source);
const PRIVATE = 'synthetic-private-payload-stack-cause';
// Playwright serializes DOM arrays across realms. The VM locator seam must do the same before comparing.
const equalDisplayFacts = (left, right) => isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
const expect = value => ({ toBe: expected => assert.equal(value, expected), toHaveCount: expected => assert.equal(value.count, expected),
  toContainText: expected => assert.equal(value.text.includes(expected), true) });
expect.poll = asyncFn => ({ toBe: async expected => {
  for (let n = 0; n < 4; n++) if (await asyncFn() === expected) return;
  assert.fail('finite synthetic poll exhausted');
} });

for (const phase of ['partial', 'items', 'authoritative']) for (const task of [0, 1]) test(`actual rich fields/state are exact and ordered: ${phase}/${task}`, async () => {
  const facts = [['reasoning_summary', data.summary], ['reasoning_text', data.reasoning], ['text', data.text], ['refusal', data.refusal],
    ['function_name', 'add_numbers'], ['function_arguments', phase === 'partial' ? data.arguments : argumentsFor(task)],
    ['function_name', 'load_skill'], ['function_arguments', '{"id":"project:presentation"}'], ['function_name', 'add_numbers'],
    ['function_arguments', '{"a":9223372036854775807,"b":1}'], ['Unsupported content', 'Unsupported content']];
  const state = phase === 'authoritative' ? 'Recorded state: completed; Provisional: false' : 'Recorded state: in_progress; Provisional: true';
  const entry = entryLocator(facts, state);
  await runInNewContext(`(async () => {${top};await richSections(entry,task,phase);})()`, { expect, entry, task, phase, data, answer, isDeepStrictEqual: equalDisplayFacts }, { timeout: 1000 });
});
function argumentsFor(task) { if (task === 0) return '{"a":17,\r\n "b":25}'; return '{"a":42,\r\n "b":8}'; }
function fieldNodes(facts) {
  return facts.map(([kind, ...texts]) => ({ querySelector: () => ({ textContent: kind }),
    querySelectorAll: () => texts.map(textContent => ({ textContent })) }));
}
function leaf(value) { return { count: 1, textContent: async () => value, first() { return this; } }; }
function entryLocator(facts, state, schedule) {
  let reads = 0;
  return { count: 1, textContent: async () => facts.flat().join('\n'),
    locator(selector) {
      if (selector === ':scope > .metadata') return leaf(state);
      if (selector === '[data-field] pre') return { evaluateAll: async (fn, arg) => fn(facts.flatMap(([, ...values]) => values.map(textContent => ({ textContent }))), arg) };
      assert.equal(selector, '[data-field]');
      return { evaluateAll: async fn => {
        let sample = facts;
        if (schedule) { sample = schedule[Math.min(reads, schedule.length - 1)]; reads++; }
        return fn(fieldNodes(sample));
      } };
    }, reads: () => reads };
}
for (const variant of ['late-field', 'empty', 'swapped', 'changed-byte', 'extra', 'duplicate']) test(`actual field readiness poll does not treat a native pause as DOM readiness: ${variant}`, async () => {
  const facts = [['tool_name', 'load_skill'], ['tool_result', skillOutput]];
  let samples = [facts]; let valid = false;
  if (variant === 'late-field') { samples = [[], facts.slice(0, 1), facts]; valid = true; }
  if (variant === 'empty') samples = [[]];
  if (variant === 'swapped') samples = [[...facts].reverse()];
  if (variant === 'changed-byte') samples = [[facts[0], ['tool_result', skillOutput + ' ']]];
  if (variant === 'extra') samples = [[...facts, ['text', 'extra']]];
  if (variant === 'duplicate') samples = [[...facts, facts[1]]];
  const entry = entryLocator(facts, '', samples); let accepted = false;
  try { await runInNewContext(`(async () => {${top};await fields(entry,JSON.parse(facts));})()`, { expect, entry, facts: JSON.stringify(facts), isDeepStrictEqual: equalDisplayFacts }, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, valid); assert.equal(entry.reads(), valid ? 3 : 4);
});
for (const completed of [false, true]) for (const variant of ['valid', 'duplicate', 'changed', 'wrong-state']) test(`actual answer finalizes once without replacing recorded state: ${completed}/${variant}`, async () => {
  let facts = [['text', answer(0)]];
  if (variant === 'duplicate') facts = [...facts, ...facts];
  if (variant === 'changed') facts = [['text', answer(0) + ' ']];
  let state = 'Recorded state: in_progress; Provisional: true';
  if (completed) state = 'Recorded state: completed; Provisional: false';
  if (variant === 'wrong-state') state = 'Recorded state: unknown; Provisional: true';
  const entry = entryLocator(facts, state); let accepted = false;
  try { await runInNewContext(`(async () => {${top};await answerSection(entry,0,completed);})()`, { expect, entry, completed, answer, isDeepStrictEqual: equalDisplayFacts }, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, variant === 'valid');
});
for (const slot of [0, 1, 2]) for (const variant of ['valid', 'result', 'finish', 'error', 'provisional', 'output']) test(`actual completed helper keeps independent actual tool flags/bytes: ${slot}/${variant}`, async () => {
  const rich = [['reasoning_summary', data.summary], ['reasoning_text', data.reasoning], ['text', data.text], ['refusal', data.refusal],
    ['function_name', 'add_numbers'], ['function_arguments', argumentsFor(0)], ['function_name', 'load_skill'],
    ['function_arguments', '{"id":"project:presentation"}'], ['function_name', 'add_numbers'], ['function_arguments', '{"a":9223372036854775807,"b":1}'], ['Unsupported content', 'Unsupported content']];
  const facts = [[['text', data.user]], rich, [['tool_name', 'add_numbers'], ['tool_result', '{"sum":42}']],
    [['tool_name', 'load_skill'], ['tool_result', skillOutput]], [['tool_name', 'add_numbers'], ['tool_result', '{"error":{"code":"gateway_error"}}']], [['text', answer(0)]]];
  const states = ['Recorded state: accepted; Provisional: false', 'Recorded state: completed; Provisional: false',
    ...[false, false, true].map(error => `Recorded state: ${error ? 'failed' : 'completed'}; Provisional: false; result_recorded: true; finish_recorded: true; is_error: ${error}`), 'Recorded state: completed; Provisional: false'];
  if (variant === 'result') states[slot + 2] = states[slot + 2].replace('result_recorded: true', 'result_recorded: false');
  if (variant === 'finish') states[slot + 2] = states[slot + 2].replace('finish_recorded: true', 'finish_recorded: false');
  if (variant === 'error') states[slot + 2] = states[slot + 2].replace(`is_error: ${slot === 2}`, `is_error: ${slot !== 2}`);
  if (variant === 'provisional') states[slot + 2] = states[slot + 2].replace('Provisional: false', 'Provisional: true');
  if (variant === 'output') facts[slot + 2][1][1] += ' ';
  const recording = `Run: ${f.RID}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 3\ntool_results_prepared: 3\nreused_results: 0\nlast_request_id: ${f.OID}\nlast_upstream_outcome: terminal_received`;
  const entries = facts.map((value, n) => ({ ...entryLocator(value, states[n]), getAttribute: async () => 'e:2:0' }));
  const run = { getAttribute: async () => f.RID, textContent: async () => states.join('\n'), locator(selector) {
    if (selector === ':scope > .metadata') return leaf('Execution: completed. Final result recorded.');
    if (selector === ':scope > details > pre') return leaf(recording);
    if (selector === '.entry') return { nth: n => entries[n] };
    assert.equal(selector, '[data-field] pre');
    return { evaluateAll: async (fn, arg) => fn(facts.flatMap(row => row.flatMap(([, ...texts]) => texts.map(textContent => ({ textContent })))), arg) };
  } };
  let accepted = false;
  try { await runInNewContext(`(async () => {${top};${helper('completed')};await completed(run,0);})()`, {
    expect, run, data, answer, skillOutput, isDeepStrictEqual: equalDisplayFacts, check: 'outside', commands: [{ run_id: f.RID }],
    receipts: [{ first_sequence: '2' }], chronology: async () => {},
  }, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, variant === 'valid');
});

const validMeasurement = { label: 'short-selected', latest_ms: 1.5, rebase_ms: 2, acceptance_ms: 3, result_display_ms: 4,
  tasks: 1, loaded_blocks: 1, loaded_entries: 6, loaded_fields: 19, dom_nodes: 200, latest_requests: 4,
  older_requests: 0, stream_requests: 4, task_posts: 1, status_updates: 1, display_proof_requests: 4 };
for (const key of ['latest_ms', 'rebase_ms', 'acceptance_ms', 'result_display_ms']) for (const invalid of [-1, Infinity, NaN, '1', null, 180001]) test(`actual closed measurement timing rejects ${key}/${String(invalid)}`, () => {
  assert.throws(() => runInNewContext(`${top};measurement(value)`, { value: { ...validMeasurement, [key]: invalid } }, { timeout: 1000 }));
});
for (const key of ['tasks', 'loaded_blocks', 'loaded_entries', 'loaded_fields', 'dom_nodes', 'latest_requests', 'older_requests', 'stream_requests', 'task_posts', 'status_updates']) for (const invalid of [-1, 1.5, 10001, '1']) test(`actual closed measurement count rejects ${key}/${invalid}`, () => {
  assert.throws(() => runInNewContext(`${top};measurement(value)`, { value: { ...validMeasurement, [key]: invalid } }, { timeout: 1000 }));
});
for (const variant of ['valid', 'extra', 'missing', 'old-label', 'null', 'array', 'object-count']) test(`actual measurement schema is display-specific and finite: ${variant}`, () => {
  let value = { ...validMeasurement };
  if (variant === 'extra') value.raw_events = 0;
  if (variant === 'missing') delete value.dom_nodes;
  if (variant === 'old-label') value.label = 'stalled-reader';
  if (variant === 'null') value = null;
  if (variant === 'array') value = [];
  if (variant === 'object-count') value.dom_nodes = { valueOf() { throw Error(PRIVATE); } };
  let accepted = false;
  try { const result = runInNewContext(`${top};measurement(value)`, { value }, { timeout: 1000 }); assert.equal(JSON.stringify(result), JSON.stringify(value)); accepted = true; } catch {}
  assert.equal(accepted, variant === 'valid');
});

for (const prior of [undefined, '', 'prior']) for (const closeFailure of [false, true]) for (const stopFailure of [false, true]) test(`actual fatal cleanup keeps recording guard through failed close and first fatal: ${String(prior)}/${closeFailure}/${stopFailure}`, async () => {
  const env = {}; if (prior !== undefined) env.PLAYWRIGHT_NO_COPY_PROMPT = prior;
  const calls = [], output = [];
  let failure;
  try { await runInNewContext(`(async () => {${top};const label='short-selected';${declarations}; fixture=ownedFixture;context=ownedContext;
    stage='tools';check='fields';process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';try {throw new TypeError(privateText);} ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)} if(failure)throw failure;})()`, {
    privateText: PRIVATE, process: { env }, console: { log: value => output.push(value) },
    ownedContext: { close: async () => { calls.push('context'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw Error(PRIVATE); } },
    ownedFixture: { stop: async () => { calls.push('fixture'); if (stopFailure) throw Error(PRIVATE); } },
  }, { timeout: 1000 }); } catch (error) { failure = error; }
  assert.deepEqual(calls, ['context', 'fixture']);
  assert.equal(failure.message, 'Presentation failed: label=short-selected; stage=tools; check=fields; kind=TypeError');
  assert.equal([failure.message, failure.stack, ...output].join('\n').includes(PRIVATE), false);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.deepEqual(output, [`Presentation cleanup: label=short-selected; context=${!closeFailure}; fixture=${!stopFailure}`]);
});
for (const value of [null, PRIVATE, { get message() { throw Error(PRIVATE); }, get stack() { throw Error(PRIVATE); }, cause: PRIVATE }]) test('actual finite fatal never reads untrusted message/stack/cause', () => {
  const result = runInNewContext(`${top};fatal(privateText,privateText,privateText,error).message`, { privateText: PRIVATE, error: value }, { timeout: 1000 });
  assert.equal(result, 'Presentation failed: label=unknown; stage=unknown; check=unknown; kind=other');
});
for (const variant of ['public-field', 'bad-field', 'private-field', 'other-hash', 'private-text', 'storage']) test(`actual detached privacy clone removes only validated public field attributes: ${variant}`, async () => {
  const owner = 'f'.repeat(64); let clones = 0, removed = 0;
  const dom = { querySelectorAll: () => [{ getAttribute: () => variant === 'bad-field' ? 'invalid' : variant === 'private-field' ? owner : 'a'.repeat(64), removeAttribute: () => { removed++; } }],
    get outerHTML() { if (variant === 'other-hash') return 'b'.repeat(64); if (variant === 'private-text') return PRIVATE; return '<main>safe</main>'; } };
  const document = { documentElement: { cloneNode: () => { clones++; return dom; } }, querySelectorAll: () => [], cookie: '' };
  const page = { evaluate: async (fn, args) => runInNewContext(`(${fn.toString()})(args)`, { args, document,
    location: { href: 'http://127.0.0.1/' }, history: { state: null }, localStorage: { length: variant === 'storage' ? 1 : 0 }, sessionStorage: { length: 0 },
    indexedDB: { databases: async () => [] }, caches: { keys: async () => [] }, navigator: { serviceWorker: { getRegistrations: async () => [] } },
  }, { timeout: 1000 }) };
  let accepted = false;
  try { await runInNewContext(`(async () => {${helper('boundary')};await boundary();})()`, { expect, page, fixture: { owner }, markers: [PRIVATE], context: { cookies: async () => [] }, check: 'outside', inert: async () => {} }, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, variant === 'public-field'); assert.equal(clones, 1);
  assert.equal(removed, variant === 'bad-field' || variant === 'private-field' ? 0 : 1);
});
for (const variant of ['valid', 'status', 'body', 'size', 'utf8', 'media', 'json', 'extra']) test(`actual display reply validates real bytes without diagnostic echo: ${variant}`, async () => {
  const value = f.page(); if (variant === 'extra') value.private = PRIVATE;
  const reply = { status: () => variant === 'status' ? 202 : 200, headers: () => ({ 'content-type': variant === 'media' ? 'text/plain' : 'application/json' }), body: async () => {
    if (variant === 'body') throw Error(PRIVATE);
    if (variant === 'size') return Buffer.alloc(512 * 1024 + 1);
    if (variant === 'utf8') return Buffer.from([255]);
    if (variant === 'json') return Buffer.from('{');
    return Buffer.from(JSON.stringify(value));
  } };
  let accepted = false;
  try { await runInNewContext(`(async () => {${helper('readReply')};return readReply(reply,200,v=>validateConversationPage(v,{kind:'latest'},sid));})()`, { expect, reply, decodeJson, validateConversationPage, TextDecoder, sid: f.SID, check: 'outside' }, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, variant === 'valid');
});

for (const streaming of [false, true]) for (const variant of ['valid', 'head', 'path', 'response', 'status']) test(`actual Latest binds preceding snapshot response and exact H before stream: ${streaming}/${variant}`, async () => {
  const variants = { head: 'browser-head', path: 'stream-path', response: 'stream-response' };
  const proof = await latestObservation('direct', streaming, variants[variant] ?? variant);
  assert.equal(Object.hasOwn(proof.result, 'error'), variant !== 'valid');
  assert.equal(proof.handshakes.at(-1)?.matching === true, variant === 'valid');
  assert.equal(proof.fetches.length, ['valid', 'head'].includes(variant) ? 1 : 0);
});
for (const event of ['request', 'response', 'console']) test(`actual event collector catches private runtime errors into finite counters: ${event}`, () => {
  const registration = attempt.tryBlock.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === (event === 'console' ? 'page.on' : 'context.on') && node.expression.arguments[0].text === event);
  // VM scripts cannot parse import.meta. Supply only the unchanged module URL for this locator seam.
  const listener = registration.expression.arguments[1].getText(source).replaceAll('import.meta.url', 'sourceUrl');
  const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  const cause = { url() { throw Error(PRIVATE); }, location() { throw Error(PRIVATE); } };
  runInNewContext(`(${listener})(cause)`, { faults, cause, URL, sourceUrl: new URL('../e2e/presentation.spec.mjs', import.meta.url).href, requests: [], fixture: { origin: 'http://127.0.0.1:1234' } }, { timeout: 1000 });
  assert.deepEqual(Object.values(faults), [0, 0, 0, 0, 0, 0, 1]);
});

test('actual source keeps one case/three fixtures/four Tasks, native gates, public displays and no retired machinery', () => {
  assert.equal(text.match(/^test\('/gm).length, 1);
  assert.match(text, /const labels = \['short-selected', 'long-selected', 'disconnected-reader'\]/);
  assert.match(text, /if \(label === 'long-selected'\) taskCount = 2/);
  assert.match(text, /presentation: true/);
  for (const gate of ['gate + 1', 'gate + 2', 'gate + 3', 'gate + 4', 'gate + 5']) assert.equal(text.includes(gate), true);
  for (const banned of ['validateEventView', 'createConversation', 'applyEvent', 'selectDisplay', 'localRender', 'observe(context', 'newCDPSession', 'exposeBinding', 'addInitScript', 'page.screenshot', 'context.tracing', 'globalThis.presentation', '/history?', 'Reload history', 'Reconnect observation', 'first_page_events', 'selected_events', 'reducer_render_ms']) assert.equal(text.includes(banned), false, banned);
  assert.equal(attempt.tryBlock.statements[0].getText(source), "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
  assert.match(text, /test.use\(\{ trace: 'off', screenshot: 'off', video: 'off' \}\)/);
  assert.match(text, /liveObserver\.evaluate\(value => \{ value.dispose\(\); return value.read\(\); \}\)/);
  assert.match(text, /handshake.response === reply/);
  assert.match(text, /observed.older === olderBefore \+ 1/);
  assert.match(text, /requests.length === before/);
  assert.match(text, /abortDiagnostic <= 1/);
  function visit(node) { if (ts.isConditionalExpression(node)) { assert.equal(ts.isConditionalExpression(node.whenTrue), false); assert.equal(ts.isConditionalExpression(node.whenFalse), false); } ts.forEachChild(node, visit); }
  visit(source);
});

test('public controller discards a delayed old Latest after Disconnect and a new matching snapshot', async t => {
  let release; let held = true; const streams = [];
  const client = createDisplayClient({ fetch: async (path, init) => {
    assert.equal(init.method, 'GET');
    if (path === '/v1/settings') return response({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path.startsWith('/v1/sessions?')) return response({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path.endsWith('/conversation')) {
      if (held) return new Promise(resolve => { release = () => resolve(response(supplied('4'))); });
      return response(supplied('9', true));
    }
    if (path.includes('/conversation/events?')) {
      streams.push({ path, head: client.snapshot().selected.store.observed_head });
      return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw Error('Unexpected synthetic read');
  } });
  t.after(() => client.disconnect()); await client.connect('0123456789abcdef'.repeat(4));
  const old = client.selectSession(f.SID); await flush(); assert.equal(typeof release, 'function');
  client.setDraft('discarded'); client.disconnect(); held = false;
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID); await flush();
  release(); await old; await flush();
  assert.equal(client.snapshot().selected.store.observed_head, '9'); assert.equal(client.snapshot().draft, '');
  assert.deepEqual(client.snapshot().pending, []); assert.equal(streams.length, 1); assert.equal(streams[0].head, '9');
  assert.equal(streams[0].path.endsWith(encodeURIComponent(f.cursor('l', '9', '3', '', ''))), true);
});

const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n = 0; n < 5; n++) await tick(); }
function supplied(head, completed = false) {
  const fields = [f.field({ text: answer(0), total_bytes: String(Buffer.byteLength(answer(0))), to_byte: String(Buffer.byteLength(answer(0))) })];
  let state = 'running'; if (completed) state = 'completed';
  const block = f.block({ revision: head, state, result_recorded: completed });
  const entry = f.entry({ revision: head, fields, recorded_state: completed ? 'completed' : 'in_progress', provisional: !completed });
  return f.page({ snapshot_head: head, session: f.session(head), block, entries: [entry], previous_block: null, live_after: f.cursor('l', head, '3', '', '') });
}
for (const loss of ['EOF', 'disconnect']) for (const badBatch of [false, true]) test(`public controller applies supplied batches atomically then explicitly rebases current state without redispatch: ${loss}/${badBatch}`, async t => {
  const calls = [], published = [], readers = []; let head = '4', next = 0, owner; const receipt = { operation_id: f.OID, session_id: f.SID, run_id: f.RID, first_sequence: '2', last_sequence: '3' };
  const client = createDisplayClient({ crypto: { randomUUID: () => [f.OID, f.RID][next++] }, fetch: async (path, init) => {
    calls.push({ path, method: init.method, head: client.snapshot().selected?.store?.observed_head ?? null });
    if (path === '/v1/settings') return response({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path.startsWith('/v1/sessions?')) return response({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path.endsWith('/conversation')) return response(supplied(head, head === '9'));
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream({ start(controller) { owner = controller; readers.push(controller); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (path.endsWith('/runs')) return new Response(JSON.stringify({ api_version: 1, receipt, duplicate: false, warning_code: null, notices: [] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    throw Error('Unexpected synthetic request');
  } });
  t.after(() => client.disconnect()); client.subscribe(value => published.push(value));
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID); await flush();
  client.setDraft(data.user); await client.sendTask(); client.setDraft('retained draft'); const pending = client.snapshot().pending[0];
  assert.equal(Object.isFrozen(pending.command.body) && Object.isFrozen(pending.receipt), true);
  const updated = supplied('7'); const changes = [{ kind: 'block.upsert', block: updated.block }, f.upsert(updated.entries[0], updated.block)];
  if (badBatch) changes.push(f.upsert(f.entry({ run_id: f.OTHER }), updated.block));
  const batch = f.batch(changes, '7');
  owner.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${batch.next_after}\ndata: ${JSON.stringify(batch)}\n\n`)); await flush();
  assert.equal(client.snapshot().selected.store.observed_head, badBatch ? '4' : '7');
  if (loss === 'disconnect') { client.disconnect(); await flush(); assert.equal(client.snapshot().draft, ''); assert.deepEqual(client.snapshot().pending, []); }
  else { if (!badBatch) owner.close(); await flush(); assert.equal(client.snapshot().selected.observation, 'disconnected'); assert.equal(client.snapshot().draft, 'retained draft'); assert.deepEqual(client.snapshot().pending[0].receipt, receipt); }
  head = '9'; const posts = calls.filter(call => call.method === 'POST').length;
  if (loss === 'disconnect') { await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID); }
  else await client.reconnectLatest();
  await flush(); const snapshot = client.snapshot();
  assert.equal(snapshot.selected.store.observed_head, '9'); assert.equal(snapshot.selected.store.blocks[0].view.result_recorded, true);
  assert.equal(snapshot.selected.store.blocks[0].entries[0].view.provisional, false);
  assert.equal(calls.filter(call => call.method === 'POST').length, posts); assert.equal(posts, 1);
  assert.equal(calls.filter(call => call.path.includes('/conversation/events?')).length, 2);
  const stream = calls.at(-1); assert.equal(stream.head, '9'); assert.equal(stream.path.endsWith(encodeURIComponent(f.cursor('l', '9', '3', '', ''))), true);
  assert.equal(published.some(value => value.selected?.store?.observed_head === '9' && value.selected.observation === 'connecting'), true);
  if (loss === 'EOF') { assert.equal(snapshot.draft, 'retained draft'); assert.deepEqual(snapshot.pending[0].command, pending.command); assert.deepEqual(snapshot.pending[0].receipt, receipt); }
  else { assert.equal(snapshot.draft, ''); assert.deepEqual(snapshot.pending, []); }
  assert.equal(calls.some(call => /\/history|\/cancel|\/operations/.test(call.path)), false);
  assert.equal(readers.length, 2);
});

const taskLoop = attempt.tryBlock.statements.find(ts.isForStatement);
const taskStatements = taskLoop.statement.statements;
const positionCalls = taskStatements.filter(node => ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)
  && ts.isCallExpression(node.expression.expression) && node.expression.expression.expression.getText(source) === 'stablePosition');
const baselineStart = taskStatements.findIndex(node => node.getText(source) === 'await transcript.evaluate(node => { node.scrollTop = 0; });');
const baselineEnd = taskStatements.findIndex((node, index) => index > baselineStart && node.getText(source) === 'await boundary();');
const baselineSource = taskStatements.slice(baselineStart, baselineEnd).map(node => node.getText(source)).join('\n');
function geometrySeam(value) {
  const reads = [], output = []; let frames = 0;
  const transcript = { scrollTop: value.scroll_top, scrollHeight: value.height ?? 900, clientHeight: value.client_height ?? 800,
    getBoundingClientRect() { reads.push('transcript'); return { top: value.container_top }; } };
  const node = { closest(selector) { assert.equal(selector, '.transcript'); if (value.missing_container) return null; return transcript; },
    getBoundingClientRect() { reads.push('entry'); return { top: value.entry_top }; } };
  const entry = { evaluate: async fn => { reads.push(`sample-after-${frames}`); return fn(node); } };
  const page = { evaluate: async fn => runInNewContext(`(${fn.toString()})()`, {
    requestAnimationFrame: callback => { frames++; callback(); },
  }, { timeout: 1000 }) };
  return { entry, transcript, page, reads, output, frameCount: () => frames };
}
// Use the assertion's Error realm so the VM keeps the same classification as the actual module.
async function positionCheck(stage, value, baseline = { scroll_top: 10, anchor_y: 20, overflow: 100 }) {
  const seam = geometrySeam(value);
  const index = ['items', 'tools'].indexOf(stage); assert.notEqual(index, -1);
  const result = await runInNewContext(`(async () => {${top};${helper('stablePosition')};let check='outside';const label='short-selected';
    try {${positionCalls[index].getText(source)}} catch(error) {return {check, failure:fatal(label,stage,check,error).message};}
    return {check,failure:null};})()`, { expect, Error, TypeError, page: seam.page, entries: { first: () => seam.entry }, baseline, stage,
    console: { log: value => seam.output.push(value) },
  }, { timeout: 1000 });
  return { ...result, ...seam };
}
for (const stage of ['items', 'tools']) for (const variant of ['stable', 'translation', 'scroll-2', 'scroll+2', 'anchor-2', 'anchor+2',
  'scroll-below', 'scroll-above', 'anchor-below', 'anchor-above', 'both-drift']) test(`actual ${stage} call keeps independent signed 2px bounds: ${variant}`, async () => {
  const value = { scroll_top: 10, entry_top: 120, container_top: 100 };
  let scroll = 0, anchor = 0, failedCheck = null;
  if (variant === 'translation') { value.entry_top += 300; value.container_top += 300; }
  if (variant === 'scroll-2') scroll = -2;
  if (variant === 'scroll+2') scroll = 2;
  if (variant === 'anchor-2') anchor = -2;
  if (variant === 'anchor+2') anchor = 2;
  if (variant === 'scroll-below') { scroll = -2 - Number.EPSILON * 8; failedCheck = 'scroll-position'; }
  if (variant === 'scroll-above') { scroll = 2 + Number.EPSILON * 8; failedCheck = 'scroll-position'; }
  if (variant === 'anchor-below') { anchor = -2 - Number.EPSILON * 64; failedCheck = 'relative-anchor'; }
  if (variant === 'anchor-above') { anchor = 2 + Number.EPSILON * 64; failedCheck = 'relative-anchor'; }
  if (variant === 'both-drift') { scroll = 3; anchor = -4; failedCheck = 'scroll-position'; }
  value.scroll_top += scroll; value.entry_top += anchor;
  const result = await positionCheck(stage, value);
  assert.equal(result.failure, failedCheck === null ? null : `Presentation failed: label=short-selected; stage=${stage}; check=${failedCheck}; kind=Error`);
  assert.equal(result.check, failedCheck ?? 'relative-anchor');
  assert.equal(result.frameCount(), 2);
  assert.deepEqual(result.reads, ['sample-after-2', 'entry', 'transcript']);
  const delta = runInNewContext(`${top};positionDelta(baseline,current)`, { baseline: { scroll_top: 10, anchor_y: 20, overflow: 100 },
    current: { scroll_top: value.scroll_top, anchor_y: value.entry_top - value.container_top, overflow: 100 } }, { timeout: 1000 });
  assert.deepEqual(result.output, [`Presentation geometry: label=short-selected; stage=${stage}; scroll_delta=${delta.scroll_delta}; anchor_delta=${delta.anchor_delta}`]);
  assert.equal(result.output.join('').includes(PRIVATE), false);
});
for (const stage of ['items', 'tools']) for (const key of ['scroll_top', 'entry_top', 'container_top', 'height', 'client_height'])
  for (const invalid of [undefined, null, '10', NaN, Infinity, -Infinity, { valueOf() { throw Error(PRIVATE); } }])
    test(`actual ${stage} geometry rejects raw ${key}/${String(typeof invalid)} without coercion`, async () => {
      const value = { scroll_top: 10, entry_top: 120, container_top: 100, height: 900, client_height: 800, [key]: invalid };
      // Preserve an explicitly absent height instead of the seam's ordinary default.
      const seam = geometrySeam(value);
      if (key === 'height') seam.transcript.scrollHeight = invalid;
      if (key === 'client_height') seam.transcript.clientHeight = invalid;
      const result = await runInNewContext(`(async () => {${top};${helper('stablePosition')};let check='outside';const label='short-selected';
        try {${positionCalls[['items','tools'].indexOf(stage)].getText(source)}} catch(error) {return fatal(label,stage,check,error).message;}
        return null;})()`, { expect, page: seam.page, entries: { first: () => seam.entry }, baseline: { scroll_top: 10, anchor_y: 20, overflow: 100 }, stage,
        console: { log: value => seam.output.push(value) } }, { timeout: 1000 });
      assert.equal(result, `Presentation failed: label=short-selected; stage=${stage}; check=geometry; kind=Error`);
      assert.equal(seam.frameCount(), 2); assert.deepEqual(seam.output, []);
      assert.equal(result.includes(PRIVATE), false);
    });
for (const stage of ['items', 'tools']) for (const variant of ['missing-container', 'scroll-bound', 'anchor-bound', 'overflow-bound', 'negative-scroll',
  'negative-overflow', 'invalid-anchor-before-scroll-assertion', 'derived-bound']) test(`actual ${stage} validates both deltas before any bound assertion: ${variant}`, async () => {
  const value = { scroll_top: 10, entry_top: 120, container_top: 100 };
  let baseline = { scroll_top: 10, anchor_y: 20, overflow: 100 };
  if (variant === 'missing-container') value.missing_container = true;
  if (variant === 'scroll-bound') value.scroll_top = 1_000_001;
  if (variant === 'anchor-bound') value.entry_top = 1_000_101;
  if (variant === 'overflow-bound') value.height = 1_000_801;
  if (variant === 'negative-scroll') value.scroll_top = -1;
  if (variant === 'negative-overflow') value.height = 799;
  if (variant === 'invalid-anchor-before-scroll-assertion') { value.scroll_top = 13; value.entry_top = NaN; }
  if (variant === 'derived-bound') { baseline.anchor_y = -1_000_000; value.entry_top = 1_000_100; }
  const result = await positionCheck(stage, value, baseline);
  assert.equal(result.failure, `Presentation failed: label=short-selected; stage=${stage}; check=geometry; kind=Error`);
  assert.deepEqual(result.output, []); assert.equal(result.frameCount(), 2);
});
for (const key of ['scroll_top', 'anchor_y', 'overflow']) for (const variant of ['missing', 'string', 'nonfinite', 'bound']) test(`actual closed baseline rejects ${key}/${variant}`, () => {
  const baseline = { scroll_top: 0, anchor_y: 20, overflow: 100 };
  if (variant === 'missing') delete baseline[key];
  if (variant === 'string') baseline[key] = '0';
  if (variant === 'nonfinite') baseline[key] = NaN;
  if (variant === 'bound') baseline[key] = 1_000_001;
  assert.throws(() => runInNewContext(`${top};positionDelta(baseline,current)`, { baseline, current: { scroll_top: 0, anchor_y: 20, overflow: 100 } }, { timeout: 1000 }), /Presentation geometry rejected/);
});
for (const variant of ['null', 'array', 'extra-private', 'empty', 'edge']) test(`actual closed geometry has only bounded finite offsets: ${variant}`, () => {
  let value = { scroll_top: 1_000_000, anchor_y: -1_000_000, overflow: 1_000_000 };
  if (variant === 'null') value = null;
  if (variant === 'array') value = [];
  if (variant === 'extra-private') value.private = PRIVATE;
  if (variant === 'empty') value = {};
  if (variant === 'edge') assert.equal(JSON.stringify(runInNewContext(`${top};geometry(value)`, { value }, { timeout: 1000 })), JSON.stringify(value));
  else assert.throws(() => runInNewContext(`${top};geometry(value)`, { value }, { timeout: 1000 }), /Presentation geometry rejected/);
});
for (const overflow of [0, 64, 64.0001, 100]) test(`actual Task baseline checks settled top-reader overflow strictly above 64: ${overflow}`, async () => {
  const seam = geometrySeam({ scroll_top: 30, entry_top: 120, container_top: 100, height: 800 + overflow });
  const transcript = { evaluate: async fn => fn(seam.transcript) }; let accepted = false;
  try {
    const result = await runInNewContext(`(async () => {${top};let check='outside';${baselineSource};return baseline;})()`,
      { expect, page: seam.page, entries: { first: () => seam.entry }, transcript }, { timeout: 1000 });
    assert.equal(result.scroll_top, 0); assert.equal(result.overflow, seam.transcript.scrollHeight - seam.transcript.clientHeight); accepted = true;
  } catch {}
  assert.equal(accepted, overflow > 64); assert.equal(seam.frameCount(), 2);
  assert.deepEqual(seam.reads, ['sample-after-2', 'entry', 'transcript']);
});
test('actual frame boundary requests exactly two callbacks with no geometry-dependent repetition', async () => {
  const callbacks = []; let requests = 0, settled = false;
  const page = { evaluate: fn => runInNewContext(`(${fn.toString()})()`, {
    requestAnimationFrame: callback => { requests++; callbacks.push(callback); },
  }, { timeout: 1000 }) };
  const pending = runInNewContext(`(async () => {${top};await frames(page);})()`, { page }, { timeout: 1000 }).then(() => { settled = true; });
  assert.equal(requests, 1); assert.equal(callbacks.length, 1); assert.equal(settled, false);
  callbacks.shift()(1); assert.equal(requests, 2); assert.equal(callbacks.length, 1); assert.equal(settled, false);
  callbacks.shift()(2); await pending;
  assert.equal(settled, true); assert.equal(requests, 2); assert.equal(callbacks.length, 0);
});
for (const check of ['geometry', 'scroll-position', 'relative-anchor', 'scroll', PRIVATE]) test(`actual diagnostic allowlist closes check without private error inspection: ${check === PRIVATE ? 'private' : check}`, () => {
  const error = { get message() { throw Error(PRIVATE); }, get stack() { throw Error(PRIVATE); }, get cause() { throw Error(PRIVATE); } };
  const result = runInNewContext(`${top};fatal('short-selected','items',check,error).message`, { check, error }, { timeout: 1000 });
  assert.equal(result, `Presentation failed: label=short-selected; stage=items; check=${check === PRIVATE ? 'unknown' : check}; kind=other`);
  assert.equal(result.includes(PRIVATE), false);
});
for (const stage of ['items', 'tools']) for (const drift of ['scroll-position', 'relative-anchor']) for (const closeFailure of [false, true])
  test(`actual ${stage}/${drift} failure survives context-before-Stop cleanup: ${closeFailure}`, async () => {
    const seam = geometrySeam({ scroll_top: drift === 'scroll-position' ? 13 : 10, entry_top: drift === 'relative-anchor' ? 123 : 120, container_top: 100 });
    const calls = [], env = {}, output = [];
    const result = await runInNewContext(`(async () => {${top};const label='short-selected';${declarations};${helper('stablePosition')};
      fixture=ownedFixture;context=ownedContext;stage=selectedStage;process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';
      try {${positionCalls[['items','tools'].indexOf(stage)].getText(source)}} ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
      return failure?.message;})()`, { expect, Error, TypeError, page: seam.page, entries: { first: () => seam.entry }, baseline: { scroll_top: 10, anchor_y: 20, overflow: 100 },
      selectedStage: stage, process: { env }, console: { log: value => output.push(value) },
      ownedContext: { close: async () => { calls.push('context'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw Error(PRIVATE); } },
      ownedFixture: { stop: async () => { calls.push('fixture'); throw Error(PRIVATE); } },
    }, { timeout: 1000 });
    assert.equal(result, `Presentation failed: label=short-selected; stage=${stage}; check=${drift}; kind=Error`);
    assert.deepEqual(calls, ['context', 'fixture']); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : undefined);
    assert.equal(output.length, 2); assert.equal(output[0].startsWith(`Presentation geometry: label=short-selected; stage=${stage}; `), true);
    assert.equal(output[1], `Presentation cleanup: label=short-selected; context=${!closeFailure}; fixture=false`);
    assert.equal([result, ...output].join('\n').includes(PRIVATE), false);
  });
for (const stage of ['items', 'tools']) for (const axis of ['scroll', 'anchor']) for (const sign of [-1, 1]) for (const beyond of [false, true])
  test(`actual ${stage} accepts exact signed 2px and rejects its next representable delta: ${axis}/${sign}/${beyond}`, async () => {
    let size = 2; if (beyond) size += Number.EPSILON * 2;
    const baseline = { scroll_top: sign === -1 ? 4 : 0, anchor_y: 0, overflow: 100 };
    const value = { scroll_top: baseline.scroll_top, entry_top: 0, container_top: 0 };
    if (axis === 'scroll') value.scroll_top += sign * size;
    else value.entry_top = sign * size;
    const result = await positionCheck(stage, value, baseline);
    const expected = axis === 'scroll' ? 'scroll-position' : 'relative-anchor';
    assert.equal(result.failure, beyond ? `Presentation failed: label=short-selected; stage=${stage}; check=${expected}; kind=Error` : null);
    assert.equal(result.frameCount(), 2); assert.equal(result.output.length, 1);
    assert.equal(result.output[0].includes(`${axis === 'scroll' ? 'scroll_delta' : 'anchor_delta'}=${sign * size}`), true);
  });
for (const axis of ['scroll', 'anchor']) test(`actual item/tool calls retain their Task baseline across cumulative ${axis} drift`, async () => {
  const value = { scroll_top: 0, entry_top: 120, container_top: 100 };
  const seam = geometrySeam(value); const baselineTranscript = { evaluate: async fn => fn(seam.transcript) };
  const move = amount => { if (axis === 'scroll') seam.transcript.scrollTop = amount; else value.entry_top = 120 + amount; };
  const result = await runInNewContext(`(async () => {${top};${helper('stablePosition')};let check='outside',stage='items';const label='short-selected';
    ${baselineSource};move(1.25);${positionCalls[0].getText(source)};stage='tools';move(2.5);
    try {${positionCalls[1].getText(source)}} catch(error) {return fatal(label,stage,check,error).message;}return null;})()`, {
    expect, Error, TypeError, page: seam.page, entries: { first: () => seam.entry }, transcript: baselineTranscript, move,
    console: { log: value => seam.output.push(value) },
  }, { timeout: 1000 });
  assert.equal(result, `Presentation failed: label=short-selected; stage=tools; check=${axis === 'scroll' ? 'scroll-position' : 'relative-anchor'}; kind=Error`);
  assert.equal(seam.frameCount(), 6); assert.equal(seam.output.length, 2);
  assert.deepEqual(seam.reads.filter(value => value.startsWith('sample-after-')), ['sample-after-2', 'sample-after-4', 'sample-after-6']);
});
test('actual Task source has one immutable baseline and exact item/tool settled call sites', () => {
  assert.equal(positionCalls.length, 2); assert.notEqual(baselineStart, -1); assert.notEqual(baselineEnd, -1);
  assert.equal(taskStatements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === 'baseline')).length, 1);
  for (const node of positionCalls) assert.equal(node.getText(source), 'await stablePosition(entries.first(), baseline);');
  const itemCall = taskStatements.indexOf(positionCalls[0]), toolCall = taskStatements.indexOf(positionCalls[1]);
  assert.equal(baselineEnd < itemCall && itemCall < toolCall, true);
  assert.equal(taskStatements.slice(baselineEnd, toolCall).some(node => /scrollTop\s*=|const baseline|let baseline|baseline\s*=/.test(node.getText(source))), false);
  for (const index of [itemCall, toolCall]) assert.equal(taskStatements[index - 1].getText(source), 'expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);');
  assert.match(baselineSource, /await frames\(page\)/); assert.match(baselineSource, /baseline.scroll_top === 0 && baseline.overflow > 64/);
  const stable = helper('stablePosition'); assert.match(stable, /await frames\(page\)/);
  assert.equal(stable.indexOf('positionDelta(') < stable.indexOf("check = 'scroll-position'"), true);
  assert.equal(stable.indexOf('anchor_delta') < stable.indexOf("check = 'scroll-position'"), true);
  assert.match(stable, /Math.abs\(delta.scroll_delta\) <= 2/); assert.match(stable, /Math.abs\(delta.anchor_delta\) <= 2/);
  assert.equal(/expect.poll|setTimeout|while|Math.round|Math.min|Math.max/.test(stable), false);
  assert.equal(text.includes('const oldTop = await transcript.evaluate'), false); assert.equal(text.includes('const anchorTop ='), false);
});

const toolAssertions = taskStatements.find(ts.isForStatement).getText(source);
for (const site of ['tools', 'completed']) for (const task of [0, 1]) for (const variant of ['valid', 'sum-state', 'skill-state', 'overflow-state']) test(`actual ${site} tool states follow result flags without output inference: ${task}/${variant}`, async () => {
  const rich = [['reasoning_summary', data.summary], ['reasoning_text', data.reasoning], ['text', data.text], ['refusal', data.refusal],
    ['function_name', 'add_numbers'], ['function_arguments', argumentsFor(task)], ['function_name', 'load_skill'],
    ['function_arguments', '{"id":"project:presentation"}'], ['function_name', 'add_numbers'], ['function_arguments', '{"a":9223372036854775807,"b":1}'], ['Unsupported content', 'Unsupported content']];
  const facts = [[['text', data.user]], rich, [['tool_name', 'add_numbers'], ['tool_result', task === 0 ? '{"sum":42}' : '{"sum":50}']],
    [['tool_name', 'load_skill'], ['tool_result', skillOutput]], [['tool_name', 'add_numbers'], ['tool_result', '{"error":{"code":"gateway_error"}}']], [['text', answer(task)]]];
  const states = ['Recorded state: accepted; Provisional: false', 'Recorded state: completed; Provisional: false',
    ...[false, false, true].map(error => `Recorded state: ${error ? 'failed' : 'completed'}; Provisional: false; result_recorded: true; finish_recorded: true; is_error: ${error}`), 'Recorded state: completed; Provisional: false'];
  const slot = ['sum-state', 'skill-state', 'overflow-state'].indexOf(variant);
  // Change only the recorded state so a matching result flag or output cannot hide the wrong state.
  if (slot !== -1) states[slot + 2] = states[slot + 2].replace(`Recorded state: ${slot === 2 ? 'failed' : 'completed'}`, `Recorded state: ${slot === 2 ? 'completed' : 'failed'}`);
  let metadataSlot;
  const rows = facts.map((value, n) => {
    const entry = entryLocator(value, states[n]);
    return { ...entry, getAttribute: async () => 'e:2:0', locator(selector) {
      if (selector === ':scope > .metadata') metadataSlot = n - 2;
      return entry.locator(selector);
    } };
  });
  const entries = { nth: n => rows[n] };
  const recording = `Run: ${f.RID}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 3\ntool_results_prepared: 3\nreused_results: 0\nlast_request_id: ${f.OID}\nlast_upstream_outcome: terminal_received`;
  const run = { getAttribute: async () => f.RID, textContent: async () => states.join('\n'), locator(selector) {
    if (selector === ':scope > .metadata') return leaf('Execution: completed. Final result recorded.');
    if (selector === ':scope > details > pre') return leaf(recording);
    if (selector === '.entry') return entries;
    assert.equal(selector, '[data-field] pre');
    return { evaluateAll: async (fn, arg) => fn(facts.flatMap(row => row.flatMap(([, ...texts]) => texts.map(textContent => ({ textContent })))), arg) };
  } };
  let assertion = toolAssertions;
  if (site === 'completed') assertion = `${helper('completed')};await completed(run,task);`;
  const context = { expect, entries, run, task, data, answer, skillOutput, isDeepStrictEqual: equalDisplayFacts, check: 'outside',
    commands: [{ run_id: f.RID }, { run_id: f.RID }], receipts: [{ first_sequence: '2' }, { first_sequence: '2' }], chronology: async () => {} };
  let accepted = false;
  try { await runInNewContext(`(async () => {${top};${assertion}})()`, context, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, variant === 'valid');
  if (variant !== 'valid') { assert.equal(context.check, 'metadata'); assert.equal(metadataSlot, slot); }
});

const requestRegistration = attempt.tryBlock.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'context.on' && node.expression.arguments[0].text === 'request');
const requestListener = requestRegistration.expression.arguments[1].getText(source);
const requestDeclarations = attempt.tryBlock.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(value => ['files', 'markers', 'leaked'].includes(value.name.getText(source)))).map(node => node.getText(source)).join('\n');
function presentationRequest(path, options = {}) {
  const origin = 'http://127.0.0.1:1234', owner = '0123456789abcdef'.repeat(4);
  const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  const requests = [], handshakes = [], commands = [];
  const observed = { latest: 0, older: 0, streams: 0, taskPosts: 0, statusUpdates: 0, designatedAbort: 0, abortDiagnostic: 0 };
  const request = { url: () => new URL(path, options.origin ?? origin).href, method: () => options.method ?? 'GET',
    headers: () => options.headers ?? { authorization: `Bearer ${owner}` }, postDataJSON: () => ({ operation_id: f.OID, run_id: f.RID, text: data.user }) };
  let sid = f.SID; if (Object.hasOwn(options, 'sid')) sid = options.sid;
  runInNewContext(`${requestDeclarations};(${requestListener})(request)`, { URL, request, fixture: { origin, owner },
    sid, data, faults, requests, handshakes, commands, observed, structuredClone, snapshotRequests: [], snapshotResponse: undefined }, { timeout: 1000 });
  return { faults, requests: JSON.parse(JSON.stringify(requests)), handshakes, commands, observed };
}
for (const originHeader of [false, true]) test(`actual request listener permits only authenticated current queryless metadata GET: ${originHeader}`, () => {
  const headers = { authorization: `Bearer ${'0123456789abcdef'.repeat(4)}` };
  if (originHeader) headers.origin = 'http://127.0.0.1:1234';
  const result = presentationRequest(`/v1/sessions/${f.SID}`, { headers });
  assert.deepEqual(Object.values(result.faults), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.requests, [{ method: 'GET', path: `/v1/sessions/${f.SID}`, search: '' }]);
  assert.deepEqual(Object.values(result.observed), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([result.handshakes, result.commands], [[], []]);
});
for (const variant of ['other-session', 'undefined', 'null', 'number', 'object', 'query', 'repeated-query', 'trailing-slash',
  'suffix', 'uppercase', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'history', 'events', 'runs', 'rename', 'refresh', 'unrelated',
  'missing-bearer', 'wrong-bearer', 'wrong-scheme', 'cookie', 'foreign-origin', 'null-origin', 'external', 'private']) test(`actual metadata request boundary keeps exact route and security counters: ${variant}`, () => {
  let path = `/v1/sessions/${f.SID}`; const options = {};
  if (variant === 'other-session') path = `/v1/sessions/${f.OTHER}`;
  if (variant === 'undefined') { path = '/v1/sessions/undefined'; options.sid = undefined; }
  if (variant === 'null') { path = '/v1/sessions/null'; options.sid = null; }
  if (variant === 'number') { path = '/v1/sessions/7'; options.sid = 7; }
  if (variant === 'object') options.sid = { toString: () => f.SID };
  if (variant === 'query') path += '?limit=32';
  if (variant === 'repeated-query') path += '?limit=32&limit=32';
  if (variant === 'trailing-slash') path += '/';
  if (variant === 'suffix') path += '-suffix';
  if (variant === 'uppercase') { options.sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; path = `/v1/sessions/${options.sid.toUpperCase()}`; }
  if (['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(variant)) options.method = variant;
  if (['history', 'events', 'runs', 'rename', 'refresh', 'unrelated'].includes(variant)) path += `/${variant}`;
  const owner = '0123456789abcdef'.repeat(4), headers = { authorization: `Bearer ${owner}` };
  if (variant === 'missing-bearer') delete headers.authorization;
  if (variant === 'wrong-bearer') headers.authorization = 'Bearer synthetic-wrong';
  if (variant === 'wrong-scheme') headers.authorization = `Basic ${owner}`;
  if (variant === 'cookie') headers.cookie = '';
  if (variant === 'foreign-origin') headers.origin = 'http://127.0.0.1:9999';
  if (variant === 'null-origin') headers.origin = 'null';
  if (variant === 'external') options.origin = 'http://127.0.0.1:9999';
  if (variant === 'private') path += '?private-native';
  options.headers = headers;
  const result = presentationRequest(path, options);
  const expectedFaults = { external: 0, request: 1, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  if (variant === 'external') { expectedFaults.external = 1; expectedFaults.request = 0; }
  if (variant === 'private') expectedFaults.private = 1;
  assert.deepEqual(result.faults, expectedFaults);
  assert.equal(Object.values(result.faults).every(value => value === 0), false);
});
for (const path of ['/v1/settings', '/v1/sessions?limit=32', `/v1/sessions/${f.SID}/conversation`,
  `/v1/sessions/${f.SID}/conversation?before=synthetic`, `/v1/sessions/${f.SID}/conversation/events?after=synthetic`,
  `/v1/sessions/${f.SID}/conversation/content?cursor=synthetic`, `/v1/sessions/${f.SID}/conversation/entries/${f.RID}/e:4:0`,
  '/', '/index.html', '/assets/wi.css', '/assets/app.js']) test(`actual request listener retains existing GET route: ${path}`, () => {
  assert.deepEqual(Object.values(presentationRequest(path).faults), [0, 0, 0, 0, 0, 0, 0]);
});
for (const path of ['/v1/sessions', ...['runs', 'rename', 'refresh'].map(route => `/v1/sessions/${f.SID}/${route}`)]) test(`actual request listener retains existing POST route: ${path}`, () => {
  assert.deepEqual(Object.values(presentationRequest(path, { method: 'POST' }).faults), [0, 0, 0, 0, 0, 0, 0]);
});

function metadataPage(sid, head, title) {
  return f.page({ session_id: sid, snapshot_head: head, session: f.session(head, { session_id: sid, title }), block: null,
    entries: [], previous_block: null, live_after: `g11l.${Buffer.from(JSON.stringify([1, sid, head, '3', '', ''])).toString('base64url')}` });
}
for (const kind of ['rename', 'refresh']) for (const schedule of ['current', ...['command', 'metadata'].flatMap(phase =>
  ['connection', 'selection', 'same-selection', 'observation'].map(epoch => `${phase}/${epoch}`))]) test(`public controller ${kind} reads exact canonical metadata without redispatch: ${schedule}`, async t => {
  const [phase, epoch] = schedule.split('/'), calls = [], publications = []; let release, head = '4', title = 'Initial title';
  const canonical = f.session('5', { title: 'Canonical metadata\nnot the command title', updated_at_ms: '5' });
  const client = createDisplayClient({ crypto: { randomUUID: () => f.OID }, fetch: async (path, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${'0123456789abcdef'.repeat(4)}`);
    assert.equal(headers.has('Cookie'), false); assert.equal(headers.has('Origin'), false);
    assert.equal(init.credentials, 'omit'); assert.equal(init.mode, 'same-origin'); assert.equal(init.redirect, 'error');
    const boundary = presentationRequest(path, { method: init.method, sid: client.snapshot().selected?.session_id });
    assert.deepEqual(Object.values(boundary.faults), [0, 0, 0, 0, 0, 0, 0]);
    calls.push({ path, method: init.method, body: init.body, signal: init.signal });
    if (path === '/v1/settings') return response({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path === '/v1/sessions?limit=32') return response({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path.endsWith('/conversation')) return response(metadataPage(path.split('/')[3], head, title));
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    if (init.method === 'POST' && path === `/v1/sessions/${f.SID}/${kind}`) {
      let reply = { api_version: 1, session_id: f.SID, disposition: 'updated' };
      if (kind === 'rename') reply = { api_version: 1, receipt: { operation_id: f.OID, session_id: f.SID, run_id: null, first_sequence: '5', last_sequence: '5' },
        duplicate: false, warning_code: null, catalog_refresh: 'updated' };
      if (phase === 'command') return new Promise(resolve => { release = () => resolve(response(reply)); });
      return response(reply);
    }
    if (init.method === 'GET' && path === `/v1/sessions/${f.SID}`) {
      if (phase === 'metadata') return new Promise(resolve => { release = () => resolve(response(canonical)); });
      return response(canonical);
    }
    throw Error('Unexpected synthetic metadata request');
  } });
  t.after(() => client.disconnect()); client.subscribe(value => publications.push(value));
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID); await flush();
  client.setDraft('retained draft');
  let command;
  if (kind === 'rename') command = client.renameSession('Requested title');
  else command = client.refreshCatalog();
  await flush();
  const metadataCalls = () => calls.filter(call => call.method === 'GET' && call.path === `/v1/sessions/${f.SID}`);
  if (schedule !== 'current') {
    assert.equal(typeof release, 'function'); assert.equal(metadataCalls().length, phase === 'metadata' ? 1 : 0);
    head = '9'; title = 'New epoch title';
    if (epoch === 'connection') { client.disconnect(); await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(f.SID); }
    if (epoch === 'selection') await client.selectSession(f.OTHER);
    if (epoch === 'same-selection') await client.selectSession(f.SID);
    if (epoch === 'observation') await client.reconnectLatest();
    await flush(); client.setDraft('current draft');
    const current = client.snapshot(), published = publications.length;
    if (phase === 'metadata') assert.equal(metadataCalls()[0].signal.aborted, true);
    release(); await command; await flush();
    const final = client.snapshot();
    assert.deepEqual(final.selected, current.selected); assert.equal(final.selected.manifest, null);
    assert.equal(final.selected.store.observed_head, '9'); assert.equal(final.selected.store.session.title, 'New epoch title');
    assert.equal(final.draft, 'current draft'); assert.equal(final.error, null);
    assert.equal(publications.slice(published).some(value => value.selected?.manifest !== null), false);
    assert.equal(metadataCalls().length, phase === 'metadata' ? 1 : 0);
    if (epoch === 'connection') assert.deepEqual(final.pending, []);
    else { assert.equal(final.pending.length, 1); assert.equal(final.pending[0].phase, 'accepted'); assert.equal(final.pending[0].error, null); }
  } else {
    await command; await flush();
    const snapshot = client.snapshot();
    assert.equal(metadataCalls().length, 1); assert.deepEqual(snapshot.selected.manifest, canonical);
    assert.equal(snapshot.selected.store.session.title, 'Initial title'); assert.equal(snapshot.selected.store.observed_head, '4');
    assert.equal(snapshot.draft, 'retained draft'); assert.equal(snapshot.pending.length, 1);
    assert.equal(snapshot.pending[0].phase, 'accepted'); assert.equal(snapshot.pending[0].error, null); assert.equal(snapshot.error, null);
    assert.equal(Object.isFrozen(snapshot.pending[0].command.body) && Object.isFrozen(snapshot.selected.manifest), true);
    assert.equal(publications.some(value => value.selected?.manifest?.head_sequence === '5'), true);
  }
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].path, `/v1/sessions/${f.SID}/${kind}`);
  let expectedBody = {};
  if (kind === 'rename') expectedBody = { operation_id: f.OID, title: 'Requested title' };
  assert.deepEqual(JSON.parse(posts[0].body), expectedBody);
  assert.equal(calls.some(call => /\/history|\/runs|\/cancel|\/operations/.test(call.path)), false);
  const count = calls.length; await flush(); assert.equal(calls.length, count);
});

// Execute the current helpers so the diagnostic labels cannot drift from the failed operation.
async function replyAttribution(variant) {
  const operations = []; let currentCheck, decoded, propertyReads = 0;
  const rejection = new Error(PRIVATE);
  for (const key of ['message', 'stack', 'cause']) Object.defineProperty(rejection, key, { get() { propertyReads++; throw new Error(PRIVATE); } });
  const value = f.page(); if (variant === 'dto') value.private = PRIVATE;
  let bytes = Buffer.from(JSON.stringify(value));
  if (variant === 'limit') bytes = Buffer.concat([bytes, Buffer.alloc(512 * 1024 - bytes.length, 32)]);
  if (variant === 'size') bytes = Buffer.alloc(512 * 1024 + 1);
  if (variant === 'utf8') bytes = Buffer.from([255]);
  if (variant === 'json') bytes = Buffer.from('{');
  const record = (operation, receiver) => { operations.push({ operation, check: currentCheck() }); assert.equal(receiver, reply); };
  const reply = {
    status() { record('status', this); if (variant === 'status-call') throw rejection; return variant === 'status' ? 202 : 200; },
    async body() { record('body', this); if (variant === 'body') throw rejection; return bytes; },
    headers() { record('headers', this); if (variant === 'headers') throw rejection; return { 'content-type': variant === 'media' ? 'text/plain' : 'application/json' }; },
  };
  Object.defineProperty(bytes, 'length', { get() { record('size', reply); return bytes.byteLength; } });
  const validate = value => { record('validate', reply); if (variant === 'validator') throw rejection; return validateConversationPage(value, { kind: 'latest' }, f.SID); };
  class Decoder extends TextDecoder {
    constructor(encoding, options) { record('utf8', reply); assert.equal(encoding, 'utf-8'); assert.deepEqual(JSON.parse(JSON.stringify(options)), { fatal: true }); super(encoding, options); }
    decode(value) { assert.equal(value, bytes); return super.decode(value); }
  }
  const result = await runInNewContext(`(async () => {${top};${helper('readReply')};let check='outside';bindCheck(()=>check);
    try {const value=await readReply(reply,200,validate);return {check,value};}
    catch(error) {return {check,error,failure:fatal('long-selected','navigation-selected',check,error).message};}})()`, {
    expect, Error, TypeError, reply, validate, TextDecoder: Decoder, bindCheck: fn => { currentCheck = fn; },
    decodeJson: (body, media, validator) => { record('decode', reply); assert.equal(validator, validate); decoded = decodeJson(body, media, validator); return decoded; },
  }, { timeout: 1000 });
  return { result, operations, decoded, rejection, propertyReads };
}
for (const variant of ['valid', 'limit', 'status', 'status-call', 'body', 'size', 'utf8', 'headers', 'media', 'json', 'dto', 'validator']) test(`actual reply attribution keeps exact response/order/one body and closed failure: ${variant}`, async () => {
  const { result, operations, decoded, rejection, propertyReads } = await replyAttribution(variant);
  const order = ['status', 'body', 'size', 'utf8', 'headers', 'decode', 'validate'];
  const labels = ['reply-status', 'reply-body', 'reply-size', 'reply-utf8', 'reply-decode', 'reply-decode', 'reply-decode'];
  let count = 7, check = 'reply-decode';
  if (['status', 'status-call'].includes(variant)) { count = 1; check = 'reply-status'; }
  if (variant === 'body') { count = 2; check = 'reply-body'; }
  if (variant === 'size') { count = 3; check = 'reply-size'; }
  if (variant === 'utf8') { count = 4; check = 'reply-utf8'; }
  if (variant === 'headers') count = 5;
  if (['media', 'json'].includes(variant)) count = 6;
  assert.deepEqual(operations, order.slice(0, count).map((operation, index) => ({ operation, check: labels[index] })));
  assert.equal(operations.filter(value => value.operation === 'body').length, count > 1 ? 1 : 0);
  assert.equal(result.check, check); assert.equal(propertyReads, 0);
  if (['valid', 'limit'].includes(variant)) { assert.equal(result.value, decoded); assert.equal(Object.hasOwn(result, 'error'), false); }
  else {
    assert.equal(Object.hasOwn(result, 'value'), false);
    if (['status-call', 'body', 'headers', 'validator'].includes(variant)) assert.equal(result.error, rejection);
    let kind = 'Error'; if (variant === 'utf8') kind = 'TypeError';
    assert.equal(result.failure, `Presentation failed: label=long-selected; stage=navigation-selected; check=${check}; kind=${kind}`);
    assert.equal(result.failure.includes(PRIVATE), false);
  }
});

const navigationReads = attempt.tryBlock.statements.filter((node, index) => /latest\(.*(?:Fixture barrier seed|activate\(page, choice\))/.test(node.getText(source))
  && /stage = 'navigation-(seed|selected)'/.test(attempt.tryBlock.statements[index - 1]?.getText(source) ?? ''));
assert.equal(navigationReads.length, 2);
async function latestAttribution(site, streaming, variant) {
  const variants = { response: 'response-reject', action: 'action-reject', read: 'body', handshake: 'stream-response' };
  return latestObservation(site, streaming, variants[variant] ?? variant);
}
for (const site of ['direct', 'seed', 'selected']) for (const streaming of site === 'direct' ? [false, true] : [true]) for (const variant of ['valid', 'response', 'action', 'read', 'status', 'handshake']) test(`actual Latest keeps acquisition/status/handshake attribution at ${site}/${streaming}/${variant}`, async () => {
  const { result, operations, rejection, propertyReads, handshakes, fetches, bodyReads } = await latestAttribution(site, streaming, variant);
  let stage = 'rebase'; if (site === 'seed') stage = 'navigation-seed'; if (site === 'selected') stage = 'navigation-selected';
  assert.equal(result.stage, stage); assert.equal(propertyReads, 0);
  for (const operation of operations) assert.equal(operation.stage, stage);
  assert.deepEqual(operations.filter(value => ['response', 'action'].includes(value.operation)).map(value => value.operation), ['response', 'action']);
  assert.equal(operations.filter(value => value.operation === 'response').length, 1);
  assert.equal(operations.filter(value => value.operation === 'action').length, 1);
  assert.equal(fetches.length, ['valid', 'read'].includes(variant) ? 1 : 0);
  assert.equal(bodyReads, fetches.length);
  if (variant === 'valid') { assert.equal(Object.hasOwn(result, 'error'), false); assert.equal(result.check, 'requests'); assert.equal(handshakes.at(-1).matching, true); }
  else {
    let check = 'reply-response'; if (variant === 'read') check = 'reply-body'; if (variant === 'status') check = 'status'; if (variant === 'handshake') check = 'requests';
    assert.equal(result.check, check); assert.equal(handshakes.at(-1)?.matching, undefined);
    if (['response', 'action', 'read'].includes(variant)) assert.equal(result.error, rejection);
    assert.equal(result.failure, `Presentation failed: label=long-selected; stage=${stage}; check=${check}; kind=Error`);
    assert.equal(result.failure.includes(PRIVATE), false);
  }
});

test('actual V1 correction keeps strict reply bytes/validators/timeouts and restores final navigation stage', () => {
  assert.match(helper('readReply'), /check = 'reply-status'; expect\(response.status\(\) === statusCode\).toBe\(true\)/);
  assert.match(helper('readReply'), /check = 'reply-body'; const bytes = await response.body\(\)/);
  assert.equal(helper('readReply').match(/response.body\(/g).length, 1);
  assert.match(helper('readReply'), /check = 'reply-size'; expect\(bytes.length <= 512 \* 1024\).toBe\(true\)/);
  assert.match(helper('readReply'), /check = 'reply-utf8'; const body = new TextDecoder\('utf-8', \{ fatal: true \}\).decode\(bytes\)/);
  assert.match(helper('readReply'), /check = 'reply-decode'; return decodeJson\(body, response.headers\(\)\['content-type'\], validate\)/);
  assert.match(helper('latest'), /check = 'reply-response';\s*const \[reply\] = await Promise.all/);
  assert.match(helper('latest'), /parseDisplayCursor\(after, 'live', selectedSid\)/);
  assert.match(helper('latest'), /decodeJson\(body, proof.headers.get\('content-type'\), v => validateConversationPage\(v, \{ kind: 'latest' \}, selectedSid\)\)/);
  assert.match(text, /check = 'reply-response'; const acceptedReply = page.waitForResponse/);
  assert.match(text, /readReply\(await acceptedReply, 202, v => validateDisplayTaskAccepted\(v, \{ ...commands\[task\], session_id: sid \}\)\)/);
  const afterSelected = attempt.tryBlock.statements.indexOf(navigationReads[1]);
  assert.equal(attempt.tryBlock.statements[afterSelected + 3].getText(source), "stage = 'navigation';");
  assert.match(text, /test.setTimeout\(180_000\)/);
  for (const name of ['readReply', 'latest']) for (const banned of ['catch', 'retry', 'setTimeout', 'console.', '.message', '.stack', '.cause', '.text()', '.json()']) assert.equal(helper(name).includes(banned), false);
});

// These execute current source with synthetic transport schedules. They do not prove SQLite or a joined producer.
async function latestObservation(site, streaming, variant) {
  const origin = 'http://127.0.0.1:1234', owner = '0123456789abcdef'.repeat(4), operations = [], fetches = [];
  const requests = [], snapshotRequests = [], handshakes = [];
  const observed = { latest: 0, older: 0, streams: 0, taskPosts: 0, statusUpdates: 0, designatedAbort: 0, abortDiagnostic: 0 };
  const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  let currentCheck, currentStage, recordRequest, recordResponse, release, predicate, streamIssued = false;
  let clock = 10, propertyReads = 0, sdkReads = 0, bodyReads = 0, headerReads = 0, decoderReads = 0, validatorReads = 0, nowReads = 0;
  const rejection = new Error(PRIVATE);
  for (const key of ['message', 'stack', 'cause']) Object.defineProperty(rejection, key, { get() { propertyReads++; throw new Error(PRIVATE); } });
  const record = operation => operations.push({ operation, check: currentCheck(), stage: currentStage() });
  let resourceSid = f.SID;
  if (site === 'seed' || variant === 'selected-sid') resourceSid = f.OTHER;
  let resource = `${origin}/v1/sessions/${resourceSid}/conversation`;
  if (variant === 'get-origin') resource = resource.replace(origin, 'http://127.0.0.1:9999');
  if (variant === 'get-path') resource += '/suffix';
  if (variant === 'get-query') resource += '?before=synthetic';
  if (variant === 'get-uppercase') resource = `${origin}/v1/sessions/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/conversation`;
  if (variant === 'get-nil') resource = `${origin}/v1/sessions/00000000-0000-0000-0000-000000000000/conversation`;
  const request = (url = resource, method = 'GET') => ({ url: () => url, method: () => method, headers: () => ({ authorization: `Bearer ${owner}` }) });
  const fresh = request(resource, variant === 'get-method' ? 'HEAD' : 'GET'), old = request();
  const sdkReply = request => {
    const reply = { url: () => request.url(), request: () => request,
      status() { record('browser-status'); if (variant === 'browser-status-call') throw rejection; return variant === 'browser-status' ? 202 : 200; } };
    for (const key of ['body', 'text', 'json']) Object.defineProperty(reply, key, { get() { sdkReads++; throw rejection; } });
    return reply;
  };
  const reply = sdkReply(fresh), oldReply = sdkReply(old);
  let after = `g11l.${Buffer.from(JSON.stringify([1, resourceSid, variant === 'browser-head' ? '7' : '4', '3', '', ''])).toString('base64url')}`;
  if (variant === 'stream-sid') after = `g11l.${Buffer.from(JSON.stringify([1, f.OTHER, '4', '3', '', ''])).toString('base64url')}`;
  if (variant === 'rank') after = f.cursor('l', '4', '0', '', '');
  if (variant === 'cursor-identities') after = f.cursor('l', '4', '3', f.RID, '');
  if (variant === 'cursor-kind') after = f.cursor('b', '2');
  if (variant === 'cursor-malformed') after = 'g11l.invalid';
  let search = `?after=${encodeURIComponent(after)}`;
  if (variant === 'query-duplicate') search += `&after=${encodeURIComponent(after)}`;
  if (variant === 'query-extra') search += '&other=1';
  if (variant === 'query-encoded') search = search.replace('g11l', '%6711l');
  let streamUrl = `${resource}/events${search}`;
  if (variant === 'stream-path') streamUrl = `${origin}/v1/sessions/${f.OTHER}/conversation/events${search}`;
  if (variant === 'stream-origin') streamUrl = streamUrl.replace(origin, 'http://127.0.0.1:9999');
  const stream = request(streamUrl);
  let value = f.page();
  if (site === 'seed') value = metadataPage(resourceSid, '4', 'Fixture barrier seed');
  if (variant === 'seed-title') value.session.title = 'Wrong title';
  if (['head-advance', 'private-advance', 'head-behind'].includes(variant)) {
    const head = variant === 'head-behind' ? '3' : '7';
    if (variant === 'head-behind') value = metadataPage(resourceSid, head, 'Synthetic');
    else { value.snapshot_head = head; value.session.head_sequence = head; value.live_after = f.cursor('l', head, '3', '', ''); }
  }
  if (variant === 'dto') value.private = PRIVATE;
  if (variant === 'dto-session') value.session.session_id = f.OTHER;
  if (variant === 'dto-nested') value.block.human.private = PRIVATE;
  if (variant === 'dto-live') value.live_after = f.cursor('l', '7', '3', '', '');
  let bytes = Buffer.from(JSON.stringify(value));
  if (variant === 'limit') bytes = Buffer.concat([bytes, Buffer.alloc(512 * 1024 - bytes.length, 32)]);
  if (variant === 'size') bytes = Buffer.alloc(512 * 1024 + 1);
  if (variant === 'utf8') bytes = Buffer.from([255]);
  if (variant === 'json') bytes = Buffer.from('{');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const emitStream = () => {
    if (streamIssued) return; streamIssued = true;
    if (['no-stream', 'missing-decode', 'missing-install', 'reused-handshake'].includes(variant)) return;
    if (variant === 'stream-response') recordResponse(oldReply);
    recordRequest(stream);
    if (!streaming && variant !== 'arbitrary-disconnected') {
      context.abortedRequest = variant === 'wrong-abort' ? old : stream; observed.designatedAbort++;
    }
    if (variant === 'duplicate-get') recordRequest(request());
    if (variant === 'duplicate-stream') recordRequest(request(streamUrl));
  };
  const supersede = phase => {
    if (variant === `superseding-get-${phase}`) { const newer = request(); recordRequest(newer); recordResponse(sdkReply(newer)); }
    if (variant === `superseding-stream-${phase}`) recordRequest(request(streamUrl));
    if (variant === 'replace-snapshot' && phase === 'body') snapshotRequests[snapshotRequests.length - 1] = { ...snapshotRequests.at(-1) };
    if (variant === 'replace-handshake' && phase === 'body') handshakes[handshakes.length - 1] = { ...handshakes.at(-1) };
  };
  const status = { count: 1, text: variant === 'status' ? 'connected' : 'connected; observation: disconnected',
    textContent: async () => { record('status-text'); emitStream(); clock = 20; return variant === 'status' ? 'connected' : 'connected; observation: streaming'; } };
  const seamExpect = target => {
    const assertion = expect(target);
    return { ...assertion, toContainText(expected) { record('status-text'); emitStream(); clock = 20;
      assertion.toContainText(expected);
    } };
  };
  // Keep the inherited finite polling seam, but never poll the cursor or identity until it becomes acceptable.
  seamExpect.poll = fn => ({ toBe: async expected => { record('poll'); clock = 25; await expect.poll(fn).toBe(expected); } });
  const responseListener = attempt.tryBlock.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'context.on' && node.expression.arguments[0].text === 'response').expression.arguments[1].getText(source).replaceAll('import.meta.url', 'sourceUrl');
  const navigationTop = top.replace(source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'activate').getText(source), '');
  const action = async () => {
    record('action');
    const currentReply = variant === 'reuse-get-request' ? oldReply : reply;
    if (!['pre-entry', 'same-url-other-request'].includes(variant)) recordRequest(currentReply.request());
    recordResponse(currentReply);
    let selectedReply = currentReply; if (variant === 'stale-reply' || variant === 'pre-entry') selectedReply = oldReply;
    if (variant === 'same-url-other-request') selectedReply = sdkReply(request());
    if (release) release(predicate(selectedReply) ? selectedReply : Promise.reject(rejection));
    if (variant === 'action-reject') throw rejection;
  };
  const context = createContext({ expect: seamExpect, Error, TypeError, URL, URLSearchParams, Buffer, parseDisplayCursor, streaming,
    fixture: { origin, owner }, sid: f.SID, data, requests, snapshotRequests, handshakes, observed, faults, commands: [],
    files: new Map(), assetReads: [], assets: new Set(), leaked: () => false, sourceUrl: new URL('../e2e/presentation.spec.mjs', import.meta.url).href,
    abortedRequest: undefined, structuredClone, status, action, button: name => name, choice: 'selected',
    performance: { now: () => { record('time'); nowReads++; return clock; } },
    bind: (getCheck, getStage) => { currentCheck = getCheck; currentStage = getStage; },
    bindListeners: (getRequest, getResponse) => { recordRequest = getRequest; recordResponse = getResponse; },
    prepare: () => { if (['pre-entry', 'stale-reply', 'reused-handshake', 'reuse-get-request', 'reuse-stream-request'].includes(variant)) { recordRequest(old); recordResponse(oldReply); }
      if (variant === 'reused-handshake') recordRequest(request(streamUrl));
      if (variant === 'reuse-stream-request') recordRequest(stream); },
    page: { waitForResponse: candidate => { record('response'); predicate = candidate; if (variant === 'response-reject') return Promise.reject(rejection);
      return new Promise(resolve => { release = resolve; }); } },
    activate: async (page, target) => { assert.equal(target, site === 'seed' ? 'Fixture barrier seed' : 'selected'); await action(); },
    AbortSignal: { timeout: milliseconds => { assert.equal(milliseconds, 10_000); record('signal'); if (variant === 'signal') throw rejection; return 'synthetic-http-signal'; } },
    fetch: async (url, init) => {
      record('fetch'); fetches.push({ url, init }); clock = 900; supersede('fetch'); if (variant === 'fetch') throw rejection;
      return { get status() { record('observer-status'); if (variant === 'status-call') throw rejection; return variant === 'http-status' ? 503 : 200; },
        arrayBuffer: async () => { record('body'); bodyReads++; clock = 1200; supersede('body'); if (variant === 'body') throw rejection; return buffer; },
        headers: { get: key => { record('headers'); headerReads++; assert.equal(key, 'content-type'); supersede('headers'); if (variant === 'headers') throw rejection;
          return variant === 'media' ? 'text/plain' : 'application/json'; } } };
    },
    TextDecoder: class extends TextDecoder {
      constructor(encoding, options) { record('utf8'); decoderReads++; assert.equal(encoding, 'utf-8'); assert.deepEqual(JSON.parse(JSON.stringify(options)), { fatal: true }); super(encoding, options); }
      decode(input) { assert.equal(input, buffer); return super.decode(input); }
    },
    decodeJson, validateConversationPage: (...args) => { record('validate'); validatorReads++; supersede('validate'); if (variant === 'validator') throw rejection; return validateConversationPage(...args); },
  });
  let preceding = "stage='rebase';", invocation = 'const observation=await latest(action,streaming);';
  if (site !== 'direct') {
    const node = navigationReads[site === 'seed' ? 0 : 1], position = attempt.tryBlock.statements.indexOf(node);
    preceding = attempt.tryBlock.statements[position - 1].getText(source);
    if (site === 'seed') invocation = `${node.getText(source)}${attempt.tryBlock.statements[position + 1].getText(source)}const observation=seed;`;
    else invocation = `const observation=${node.getText(source)}`;
  }
  if (variant === 'seed-bypass-outside') invocation = 'const observation=await latest(action,true,null);';
  const result = await runInContext(`(async () => {${navigationTop};${helper('latest')};let check='outside',stage='outside',snapshotResponse,displayProofRequests=0;
    bind(()=>check,()=>stage);bindListeners(${requestListener},${responseListener});${preceding}prepare();
    try {${invocation}return {check,stage,...observation,proofCount:displayProofRequests};}
    catch(error) {return {check,stage,error,proofCount:displayProofRequests,failure:fatal('long-selected',stage,check,error).message};}})()`, context, { timeout: 1000 });
  return { result, operations, rejection, propertyReads, sdkReads, bodyReads, headerReads, decoderReads, validatorReads, nowReads,
    handshakes, snapshotRequests, observed, faults, fetches, value, buffer };
}

const observationVariants = ['valid', 'limit', 'pre-entry', 'same-url-other-request', 'stale-reply', 'reused-handshake', 'duplicate-get', 'duplicate-stream',
  'no-stream', 'missing-decode', 'missing-install', 'selected-sid', 'seed-bypass-outside', 'browser-status', 'browser-status-call',
  'get-origin', 'get-path', 'get-query', 'get-uppercase', 'get-nil', 'get-method', 'reuse-get-request', 'reuse-stream-request', 'signal',
  'stream-path', 'stream-origin', 'stream-response', 'stream-sid', 'rank', 'cursor-identities', 'cursor-kind', 'cursor-malformed',
  'query-duplicate', 'query-extra', 'query-encoded', 'browser-head', 'head-advance', 'private-advance', 'head-behind',
  'fetch', 'http-status', 'status-call', 'body', 'size', 'utf8', 'headers', 'media', 'json', 'dto', 'dto-session', 'dto-nested', 'dto-live', 'validator',
  ...['fetch', 'body', 'headers', 'validate'].flatMap(phase => [`superseding-get-${phase}`, `superseding-stream-${phase}`]), 'replace-snapshot', 'replace-handshake'];
for (const variant of observationVariants) test(`actual independent Latest observer enforces freshness/epoch/head/wire/privacy without retry: ${variant}`, async () => {
  const proof = await latestObservation('direct', true, variant);
  const accepted = ['valid', 'limit'].includes(variant);
  const beforeProof = observationVariants.indexOf(variant) < observationVariants.indexOf('browser-head') && !accepted;
  assert.equal(Object.hasOwn(proof.result, 'error'), !accepted);
  assert.equal(proof.handshakes.at(-1)?.matching === true, accepted);
  assert.equal(proof.fetches.length, beforeProof ? 0 : 1); assert.equal(proof.result.proofCount, proof.fetches.length);
  assert.equal(proof.bodyReads, beforeProof || ['fetch', 'http-status', 'status-call'].includes(variant) ? 0 : 1);
  assert.equal(proof.sdkReads, 0); assert.equal(proof.propertyReads, 0);
  assert.equal(proof.operations.filter(value => value.operation === 'response').length, 1);
  assert.equal(proof.operations.filter(value => value.operation === 'action').length, 1);
  if (variant === 'signal') assert.equal(proof.result.error, proof.rejection);
  if (proof.fetches.length) {
    assert.equal(proof.fetches[0].url, 'http://127.0.0.1:1234/v1/sessions/11111111-1111-4111-8111-111111111111/conversation');
    assert.deepEqual(JSON.parse(JSON.stringify(proof.fetches[0].init)), { method: 'GET', headers: { Authorization: `Bearer ${'0123456789abcdef'.repeat(4)}`, Accept: 'application/json' },
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: 'synthetic-http-signal' });
    const fetchIndex = proof.operations.findIndex(value => value.operation === 'fetch');
    assert.equal(proof.operations.slice(0, fetchIndex).some(value => value.operation === 'status-text'), true);
    assert.equal(proof.operations[fetchIndex - 2].operation, 'time');
  }
  if (accepted) {
    assert.equal(proof.result.ms, 15); assert.equal(proof.nowReads, 2);
    assert.equal(proof.decoderReads, 1); assert.equal(proof.headerReads, 1); assert.equal(proof.validatorReads, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(proof.result.value)), proof.value);
    assert.deepEqual(Object.values(proof.faults), [0, 0, 0, 0, 0, 0, 0]);
  } else {
    assert.equal(proof.result.failure.includes(PRIVATE), false);
    if (['fetch', 'status-call', 'body', 'headers', 'validator', 'browser-status-call', 'pre-entry', 'same-url-other-request', 'stale-reply'].includes(variant)) assert.equal(proof.result.error, proof.rejection);
  }
});
for (const variant of ['valid', 'arbitrary-disconnected', 'wrong-abort', 'no-stream', 'superseding-get-body', 'superseding-stream-body']) test(`actual designated aborted stream must be fresh and bound before observer GET: ${variant}`, async () => {
  const proof = await latestObservation('direct', false, variant);
  assert.equal(Object.hasOwn(proof.result, 'error'), variant !== 'valid');
  assert.equal(proof.fetches.length, ['valid', 'superseding-get-body', 'superseding-stream-body'].includes(variant) ? 1 : 0);
  assert.equal(proof.sdkReads, 0); assert.equal(proof.propertyReads, 0);
});
for (const site of ['seed', 'selected']) for (const variant of ['valid', 'selected-sid', 'seed-title']) test(`actual navigation uses matched seed metadata or strict selected SID: ${site}/${variant}`, async () => {
  const proof = await latestObservation(site, true, variant);
  const accepted = site === 'seed' ? variant !== 'seed-title' : variant !== 'selected-sid';
  assert.equal(Object.hasOwn(proof.result, 'error'), !accepted);
  assert.equal(proof.sdkReads, 0); assert.equal(proof.propertyReads, 0);
  if (site === 'seed') {
    assert.equal(proof.fetches[0].url.includes(`/v1/sessions/${f.OTHER}/conversation`), true);
    if (accepted) { assert.equal(proof.result.value.session_id, f.OTHER); assert.equal(proof.result.value.block, null); assert.deepEqual(JSON.parse(JSON.stringify(proof.result.value.entries)), []); }
  }
});
for (const key of ['display_proof_requests']) for (const invalid of [-1, 1.5, 10001, '1']) test(`actual new closed proof count rejects ${key}/${invalid}`, () => {
  assert.throws(() => runInNewContext(`${top};measurement(value)`, { value: { ...validMeasurement, [key]: invalid } }, { timeout: 1000 }));
});
for (const label of ['short-selected', 'long-selected', 'disconnected-reader']) for (const delta of [-1, 0, 1]) test(`actual proof accounting uses browser cutoff plus only disconnected completion: ${label}/${delta}`, () => {
  const value = { ...validMeasurement, label, display_proof_requests: 4 + Number(label === 'disconnected-reader') + delta };
  let accepted = false;
  try { runInNewContext(`${top};measurement(value)`, { value }, { timeout: 1000 }); accepted = true; } catch {}
  assert.equal(accepted, delta === 0);
});
test('actual measurements sample proof and browser counts at the same post-DOM cutoff and keep final accounting', async () => {
  const statement = attempt.tryBlock.statements.find(node => ts.isExpressionStatement(node) && node.getText(source).startsWith('measurements.push'));
  const values = [], observed = { latest: 3, older: 0, streams: 3, taskPosts: 1, statusUpdates: 0 };
  let currentContext;
  const transcript = { locator: selector => ({ count: async () => {
    if (selector === '*') { observed.latest = 4; observed.streams = 4; currentContext.displayProofRequests = 4; }
    return { '.run': 1, '.entry': 6, '[data-field]': 19, '*': 200 }[selector];
  } }) };
  currentContext = createContext({ observed, transcript, measurements: values, displayProofRequests: 3, label: 'short-selected', taskCount: 1,
    latestMs: 1.5, rebaseMs: 2, acceptanceMs: 3, visibilityMs: 4 });
  await runInContext(`(async()=>{${top};${statement.getText(source)}})()`, currentContext, { timeout: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(values)), [{ ...validMeasurement, status_updates: 0 }]);
  const final = attempt.tryBlock.statements.find(node => node.getText(source) === "expect(displayProofRequests === observed.latest + Number(label === 'disconnected-reader')).toBe(true);");
  assert.ok(final);
  for (const valid of [false, true]) {
    observed.latest = 8; currentContext.displayProofRequests = valid ? 8 : 7;
    currentContext.expect = expect;
    if (valid) runInContext(final.getText(source), currentContext, { timeout: 1000 });
    else assert.throws(() => runInContext(final.getText(source), currentContext, { timeout: 1000 }));
  }
});
test('actual source unconditionally replaces only Latest SDK body with one bounded Node GET after the app stream and pins timing', () => {
  const latest = helper('latest');
  assert.equal((latest.match(/await fetch\(/g) ?? []).length, 1);
  assert.equal((latest.match(/await proof.arrayBuffer\(/g) ?? []).length, 1);
  for (const forbidden of ['readReply(', '.body(', '.text(', '.json(', 'catch', 'retry', 'while', 'console.', '.message', '.stack', '.cause']) assert.equal(latest.includes(forbidden), false);
  assert.match(latest, /bytes.byteLength <= 512 \* 1024/);
  assert.match(latest, /value.snapshot_head === cursor.sequence && value.live_after === after/);
  assert.match(latest, /new TextDecoder\('utf-8', \{ fatal: true \}\)/);
  assert.equal(latest.indexOf('const ms = performance.now() - start;') < latest.indexOf('await fetch('), true);
  assert.equal((latest.match(/snapshotRequests.length === snapshotMark \+ 1/g) ?? []).length, 2);
  assert.equal((latest.match(/handshakes.length === streamMark \+ 1/g) ?? []).length, 2);
  assert.match(text, /displayProofRequests\+\+;\s*const reply = await fetch\(`\$\{fixture.origin\}\/v1\/sessions\/\$\{sid\}\/conversation`/);
  assert.match(text, /await activate\(page, choice\); await frames\(page\)/);
  assert.match(navigationReads[0].getText(source), /true, null/);
  assert.equal(text.includes('fixture.session_id'), false);
  assert.equal(helper('readReply').match(/await response.body\(\)/g).length, 1);
  assert.equal(text.match(/await response.body\(\)/g).length, 2);
});

test('actual selected catalog activation is a read-free keyboard action, not a fresh Latest observation', () => {
  const catalogStart = attempt.tryBlock.statements.findIndex(node => node.getText(source) === "stage = 'catalog';");
  const keyboardStart = attempt.tryBlock.statements.findIndex(node => node.getText(source) === "stage = 'keyboard';");
  const catalog = attempt.tryBlock.statements.slice(catalogStart, keyboardStart).map(node => node.getText(source)).join('\n');
  assert.match(catalog, /await activate\(page, choice\);/);
  assert.equal(catalog.includes('latest('), false);
  assert.match(catalog, /toHaveAttribute\('aria-current', 'true'\)/);
  assert.match(catalog, /location.hash\) === `#session=\$\{sid\}`/);
  assert.match(catalog, /await exact\(status, 'connected; observation: streaming'\)/);
  for (const invariant of ['requests.length === catalogMark.requests', 'snapshotRequests.length === catalogMark.snapshots',
    'handshakes.length === catalogMark.streams', 'displayProofRequests === catalogMark.proofs',
    'isDeepStrictEqual(observed, catalogMark.observed)', 'handshakes.at(-1) === catalogStream', 'catalogStream.matching === true',
    'snapshotResponse === catalogSnapshot', 'toHaveValue(catalogDraft)', 'await exact(transcript, catalogTranscript)',
    'await exact(page.locator(\'.commands\'), catalogCommands)']) assert.equal(catalog.includes(invariant), true);
});

// C evidence loads the actual generated graph. It does not observe a browser store or a native producer.
const catalogAppModules = new Map(['api', 'display-api', 'sse', 'display-store', 'display-client', 'display-view', 'app'].map(name => [name,
  ts.transpileModule(readFileSync(new URL(`../dist/${name}.js`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText]));
function catalogAppRealm(fetch) {
  const document = { createElement: tag => new Element(tag, document), activeElement: null };
  const root = new Element('main', document), listeners = new Map(), queued = new Map(); let frame = 0, hash = `#session=${f.SID}`;
  let hashWrites = 0;
  document.getElementById = () => root;
  const location = { protocol: 'http:', hostname: '127.0.0.1', get hash() { return hash; }, set hash(value) {
    if (value === hash) return;
    hash = value; hashWrites++; queueMicrotask(() => listeners.get('hashchange')?.());
  } };
  const context = createContext({ fetch, crypto: globalThis.crypto, AbortController, TextDecoder, TextEncoder, structuredClone, atob, btoa, URL, Headers, Response, Request,
    document, requestAnimationFrame: cb => { const id = ++frame; queued.set(id, cb); return id; }, cancelAnimationFrame: id => queued.delete(id),
    window: { location, addEventListener: (name, callback) => listeners.set(name, callback) } });
  const cache = new Map(); let client;
  function load(name) {
    if (!cache.has(name)) {
      assert.ok(catalogAppModules.has(name)); const exports = {}; cache.set(name, exports);
      const evaluate = runInContext(`(function(exports,require){${catalogAppModules.get(name)}\n})`, context, { timeout: 1000 });
      evaluate(exports, path => load(path.slice(2, -3)));
      if (name === 'display-client') {
        const create = exports.createDisplayClient;
        exports.createDisplayClient = () => { client = create(); return client; };
      }
    }
    return cache.get(name);
  }
  load('app');
  return { root, client, location, loaded: cache, field: name => control(root, name), hashWrites: () => hashWrites,
    frames() { for (let n = 0; n < 2; n++) { const batch = [...queued]; for (const [id, cb] of batch) { queued.delete(id); cb(0); } } } };
}
async function selectedCatalogApp(t, populated) {
  const owner = '0123456789abcdef'.repeat(4), calls = [], streams = [], publications = [];
  const title = `${data.title}\nrenamed`; let head = '4', currentTitle = 'Initial title';
  const canonical = () => f.session(head, { title: currentTitle });
  const catalogEntry = session => {
    const { api_version: _version, head_sequence, ...entry } = session;
    return { ...entry, view: 'catalog', observed_head_sequence: head_sequence, availability: 'ready', fault_code: null, last_run_id: null, last_run_state: null };
  };
  const seed = metadataPage(f.OTHER, '1', 'Fixture barrier seed');
  const realm = catalogAppRealm(async (path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${owner}`); assert.equal(init.credentials, 'omit');
    if (path === '/v1/settings') return response({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path === '/v1/sessions?limit=32') return response({ api_version: 1, entries: [catalogEntry(canonical()), catalogEntry(seed.session)], next_after_id: f.OTHER, has_more: false });
    if (path === `/v1/sessions/${f.SID}/rename` && init.method === 'POST') {
      const body = JSON.parse(init.body); assert.equal(body.title, title); head = '5'; currentTitle = body.title;
      streams[0].push(f.batch([{ kind: 'session.upsert', session: canonical() }], head));
      return response({ api_version: 1, receipt: { operation_id: body.operation_id, session_id: f.SID, run_id: null, first_sequence: head, last_sequence: head },
        duplicate: false, warning_code: null, catalog_refresh: 'updated' });
    }
    if (path === `/v1/sessions/${f.SID}/refresh` && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), {}); return response({ api_version: 1, session_id: f.SID, disposition: 'updated' });
    }
    if (path === `/v1/sessions/${f.SID}` && init.method === 'GET') return response(canonical());
    if (path === `/v1/sessions/${f.SID}/conversation` && init.method === 'GET') {
      if (!populated) return response(metadataPage(f.SID, head, currentTitle));
      return response(f.page({ snapshot_head: head, session: canonical(), previous_block: null, live_after: f.cursor('l', head, '3', '', '') }));
    }
    if (path === `/v1/sessions/${f.OTHER}/conversation` && init.method === 'GET') return response(seed);
    const match = path.match(/^\/v1\/sessions\/([0-9a-f-]{36})\/conversation\/events\?after=(.+)$/);
    if (match && init.method === 'GET') {
      const cursor = parseDisplayCursor(decodeURIComponent(match[2]), 'live', match[1]);
      assert.equal(cursor.sequence, match[1] === f.SID ? head : '1');
      let sender; const observation = { sid: match[1], signal: init.signal, cancelled: 0, push(batch) {
        sender.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${batch.next_after}\ndata: ${JSON.stringify(batch)}\n\n`));
      } };
      const body = new ReadableStream({ start(c) { sender = c; }, cancel() { observation.cancelled++; } }); streams.push(observation);
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    assert.fail('Unexpected catalog app transport');
  });
  t.after(async () => { realm.client.disconnect(); await flush(); assert.ok(streams.every(stream => stream.signal.aborted && stream.cancelled === 1)); });
  realm.client.subscribe(state => publications.push(state));
  const submit = field => field.parent.parent.dispatch('submit');
  realm.field('Owner token').value = owner; submit(realm.field('Owner token')); await flush(); realm.frames();
  assert.equal(realm.client.snapshot().selected.observation, 'streaming');
  realm.field('Exact new title').value = title; realm.field('Exact new title').dispatch('input'); submit(realm.field('Exact new title')); await flush();
  domButton(realm.root, 'Refresh selected catalog entry').dispatch('click'); await flush();
  domButton(realm.root, 'Refresh list').dispatch('click'); await flush(); realm.frames();
  assert.equal(domButton(realm.root, 'Refresh list').disabled, false);
  assert.equal(domButton(realm.root, 'Refresh selected catalog entry').disabled, false);
  const state = realm.client.snapshot();
  assert.equal(state.catalog_loading, false); assert.equal(state.error, null); assert.equal(state.selected.manifest.head_sequence, '5');
  assert.equal(state.selected.store.session.title, title); assert.equal(state.selected.observation, 'streaming');
  assert.deepEqual(state.pending.map(item => [item.command.kind, item.phase, item.error]), [['rename', 'accepted', null], ['refresh', 'accepted', null]]);
  assert.deepEqual(calls.map(call => [call.path, call.method]), [['/v1/settings', 'GET'], ['/v1/sessions?limit=32', 'GET'],
    [`/v1/sessions/${f.SID}/conversation`, 'GET'], [`/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l', '4', '3', '', ''))}`, 'GET'],
    [`/v1/sessions/${f.SID}/rename`, 'POST'], [`/v1/sessions/${f.SID}`, 'GET'], [`/v1/sessions/${f.SID}/refresh`, 'POST'],
    [`/v1/sessions/${f.SID}`, 'GET'], ['/v1/sessions?limit=32', 'GET']]);
  realm.field('Task').value = '  retained unsent catalog draft 雪\n  '; realm.field('Task').dispatch('input');
  assert.equal(streams.length, 1); assert.equal(streams[0].cancelled, 0); assert.equal(streams[0].signal.aborted, false);
  assert.deepEqual([...realm.loaded.keys()].sort(), [...catalogAppModules.keys()].sort());
  return { realm, calls, streams, publications, title, advance() { head = '6'; streams[0].push(f.batch([], head)); } };
}
for (const populated of [false, true]) for (const action of ['same-selected', 'reconnect', 'different-and-return'])
  test(`C actual generated app/view/controller after Rename/Refresh/list uses real catalog hash guard: ${populated}/${action}`, async t => {
    const { realm, calls, streams, publications, title, advance } = await selectedCatalogApp(t, populated);
    const choice = domButton(realm.root, title), seed = domButton(realm.root, 'Fixture barrier seed');
    const publicSession = realm.root.find(node => node.className === 'conversation')[0].children.find(node => node.className === 'metadata');
    assert.equal(choice.attributes['aria-current'], 'true'); assert.equal(realm.location.hash, `#session=${f.SID}`);
    assert.equal(publicSession.textContent, `Workspace: /synthetic/project\nSession: ${f.SID}`);
    const state = realm.client.snapshot(), mark = calls.length, publicationMark = publications.length;
    const publicText = realm.root.textContent, commands = byClass(realm.root, 'commands').textContent, originalStream = streams[0];
    if (action === 'same-selected') {
      // Dispatch the mounted button. The app executes readHash without a hash write or selection.
      choice.dispatch('click'); realm.frames(); await flush();
      assert.equal(calls.length, mark); assert.equal(publications.length, publicationMark); assert.equal(realm.hashWrites(), 0);
      assert.deepEqual(realm.client.snapshot(), state); assert.equal(realm.root.textContent, publicText);
      assert.equal(realm.field('Task').value, state.draft); assert.equal(byClass(realm.root, 'commands').textContent, commands);
      assert.equal(choice.attributes['aria-current'], 'true'); assert.equal(realm.location.hash, `#session=${f.SID}`);
      assert.equal(streams.length, 1); assert.equal(streams[0], originalStream);
      assert.equal(originalStream.signal.aborted, false); assert.equal(originalStream.cancelled, 0);
      assert.deepEqual(calls.slice(mark), []);
      // A subsequent batch on the original transport still reaches the real controller and view.
      advance(); await flush(); assert.equal(realm.client.snapshot().selected.store.observed_head, '6');
      assert.equal(calls.length, mark); assert.equal(streams.length, 1);
      assert.deepEqual(realm.client.snapshot().pending, state.pending); assert.equal(realm.client.snapshot().draft, state.draft);
    } else if (action === 'reconnect') {
      domButton(realm.root, 'Reconnect latest').dispatch('click'); await flush(); realm.frames();
      assert.equal(calls.length, mark + 2); assert.equal(streams.length, 2);
      assert.deepEqual(calls.slice(mark).map(call => call.path), [`/v1/sessions/${f.SID}/conversation`,
        `/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l', '5', '3', '', ''))}`]);
      assert.equal(originalStream.signal.aborted, true); assert.equal(originalStream.cancelled, 1);
      assert.equal(realm.hashWrites(), 0); assert.equal(realm.client.snapshot().selected.session_id, f.SID);
      assert.equal(realm.client.snapshot().selected.observation, 'streaming');
      assert.equal(realm.client.snapshot().draft, state.draft); assert.deepEqual(realm.client.snapshot().pending, state.pending);
      assert.equal(byClass(realm.root, 'commands').textContent, commands);
    } else {
      seed.dispatch('click'); await flush(); realm.frames();
      assert.equal(realm.location.hash, `#session=${f.OTHER}`); assert.equal(realm.client.snapshot().selected.session_id, f.OTHER);
      assert.equal(seed.attributes['aria-current'], 'true'); assert.equal(choice.attributes['aria-current'], 'false');
      assert.equal(realm.client.snapshot().selected.store.blocks.length, 0); assert.equal(realm.client.snapshot().selected.observation, 'streaming');
      choice.dispatch('click'); await flush(); realm.frames();
      assert.equal(realm.location.hash, `#session=${f.SID}`); assert.equal(realm.client.snapshot().selected.session_id, f.SID);
      assert.equal(realm.hashWrites(), 2); assert.equal(calls.length, mark + 4); assert.equal(streams.length, 3);
      assert.deepEqual(calls.slice(mark).map(call => call.path), [`/v1/sessions/${f.OTHER}/conversation`,
        `/v1/sessions/${f.OTHER}/conversation/events?after=${encodeURIComponent(metadataPage(f.OTHER, '1', '').live_after)}`,
        `/v1/sessions/${f.SID}/conversation`, `/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l', '5', '3', '', ''))}`]);
      assert.equal(realm.client.snapshot().selected.observation, 'streaming'); assert.equal(choice.attributes['aria-current'], 'true');
      assert.deepEqual(realm.client.snapshot().pending, state.pending); assert.equal(realm.client.snapshot().draft, '');
      assert.equal(byClass(realm.root, 'commands').textContent, commands);
      assert.equal(originalStream.cancelled, 1); assert.equal(streams[1].cancelled, 1);
    }
    assert.equal(streams.at(-1).signal.aborted, false); assert.equal(streams.at(-1).cancelled, 0);
    assert.equal(calls.slice(mark).every(call => call.method === 'GET'), true);
    assert.equal(calls.some(call => /\/runs|\/history|\/cancel|\/reconcile|\/(?:content|entries)\b|\?(?:before|within)=/.test(call.path)), false);
  });
