import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import * as f from '../test-support/display-fixtures.mjs';
import { data } from '../test-support/presentation.mjs';
import { decodeJson } from '../dist/api.js';
import { validateConversationPage } from '../dist/display-api.js';
import { richPartialFacts, partialProof, expectedBlock, displayedBlock, normalizedDom, freshHandshake, readOnly } from '../test-support/rich-display-parity.mjs';

const head = '30';
function richPage() {
  const indexes = [[0, 0, null, 0], [1, 0, 0, null], [2, 1, 0, null], [3, 1, 1, null],
    [4, 2, null, null], [5, 2, null, null], [4, 3, null, null], [5, 3, null, null],
    [4, 4, null, null], [5, 4, null, null], [8, 5, null, null]];
  const fields = richPartialFacts.map(([kind, text], index) => {
    const [rank, output, content, summary] = indexes[index];
    return f.field({ field_id: (index + 1).toString(16).repeat(64), kind, text, total_bytes: String(Buffer.byteLength(text)),
      to_byte: String(Buffer.byteLength(text)), order_key: f.order(rank, output, content, summary) });
  });
  const human = f.human({ fields: [f.field({ field_id: 'text', order_key: '0', generation: '2', text: data.user,
    total_bytes: String(Buffer.byteLength(data.user)), to_byte: String(Buffer.byteLength(data.user)) })] });
  return f.page({ snapshot_head: head, session: f.session(head), block: f.block({ human }),
    entries: [f.entry({ fields })], previous_block: null, live_after: f.cursor('l', head, '3', '', '') });
}
test('rich proof validates actual closed DTO with independently expected nonempty fixture fields', () => {
  const page = richPage();
  assert.equal(isDeepStrictEqual(partialProof(page, f.SID, f.RID, head, '2'), page), true);
  assert.equal(richPartialFacts.length, 11);
  for (const key of ['user', 'summary', 'reasoning', 'text', 'refusal', 'arguments']) assert.equal(data[key].length > 0, true);
});
const changes = {
  'empty block': p => { p.block = null; p.entries = []; },
  'missing human': p => { delete p.block.human; },
  'empty human': p => { p.block.human.fields = []; },
  'wrong human text': p => { p.block.human.fields[0].text += ' '; },
  'wrong run identity': p => { p.block.run_id = f.OTHER; },
  'wrong entry identity': p => { p.entries[0].entry_id = 'e:5:0'; },
  'wrong field identity shape': p => { p.entries[0].fields[0].field_id = 'unknown'; },
  'reordered fields': p => { p.entries[0].fields.reverse(); },
  'missing reasoning': p => { p.entries[0].fields.splice(1, 1); },
  'missing refusal': p => { p.entries[0].fields.splice(3, 1); },
  'missing text': p => { p.entries[0].fields.splice(2, 1); },
  'missing arguments': p => { p.entries[0].fields.splice(5, 1); },
  'changed content bytes': p => { p.entries[0].fields[0].text += ' '; },
  'empty rich field': p => { Object.assign(p.entries[0].fields[0], { text: '', total_bytes: '0', to_byte: '0' }); },
  'wrong byte length': p => { p.entries[0].fields[0].total_bytes = '1'; },
  'completed state': p => { p.block.state = 'completed'; },
  'recorded result': p => { p.block.result_recorded = true; },
  'recorded outcome': p => { p.block.outcome = { type: 'completed' }; },
  'nonprovisional assistant': p => { p.entries[0].provisional = false; },
  'wrong recorded state': p => { p.entries[0].recorded_state = 'completed'; },
  'unexpected tool': p => { p.entries[0].kind = 'tool'; },
  'extra entry': p => { p.entries.push(f.entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' } })); },
  'wrong session': p => { p.session_id = f.OTHER; },
  'wrong nested session': p => { p.session.session_id = f.OTHER; },
  'wrong H': p => { p.snapshot_head = '31'; p.session.head_sequence = '31'; },
  'wrong live cursor': p => { p.live_after = f.cursor('l', '31', '3', '', ''); },
  'private DTO field': p => { p.entries[0].private = 'synthetic-private'; },
};
// A changed but valid stable entry ID is caught by DOM/DTO identity equality, not fixture-specific ID guessing.
for (const [name, change] of Object.entries(changes)) test(`rich barrier rejects changed proof: ${name}`, () => {
  const page = richPage(); change(page);
  assert.throws(() => partialProof(page, f.SID, f.RID, head, '2'));
});

function domNode(value) {
  const leaf = textContent => ({ textContent });
  const entries = value.entries.map(entry => ({ dataset: { entry: entry.entry_id },
    querySelector: selector => leaf(selector === 'h4' ? entry.kind : entry.state),
    querySelectorAll: selector => selector === ':scope > .metadata' ? [leaf(entry.state), leaf(entry.content)]
      : entry.fields.map(field => ({ dataset: { field: field.field_id },
        querySelector: selector => leaf(selector === 'h5,summary' ? field.kind : field.metadata),
        querySelectorAll: () => field.ranges.map(range => ({ dataset: { range: range.range }, textContent: range.text })) })),
  }));
  return { dataset: { run: value.run_id }, querySelector: selector => leaf(selector === ':scope > .metadata' ? value.status : value.recording), querySelectorAll: () => entries };
}
const domChanges = {
  run: v => { v.run_id = f.OTHER; }, entry: v => { v.entries[1].entry_id = 'e:5:0'; },
  'entry order': v => { v.entries.reverse(); }, field: v => { v.entries[1].fields[0].field_id = 'c'.repeat(64); },
  'field order': v => { v.entries[1].fields.reverse(); }, bytes: v => { v.entries[1].fields[0].ranges[0].text += ' '; },
  metadata: v => { v.entries[1].fields[0].metadata += ' '; }, range: v => { v.entries[1].fields[0].ranges[0].range = 'text:1'; },
  provisional: v => { v.entries[1].state = 'Recorded state: completed; Provisional: false'; },
  recording: v => { v.recording += ' '; }, result: v => { v.status = 'Execution: running. Final result recorded.'; },
  missing: v => { v.entries[1].fields.splice(3, 1); },
};
for (const [name, change] of [['unchanged', () => {}], ...Object.entries(domChanges)]) test(`actual public DOM normalization detects ${name}`, async () => {
  const expected = expectedBlock(richPage()), current = structuredClone(expected); change(current);
  const actual = await displayedBlock({ evaluate: fn => fn(domNode(current)) });
  assert.equal(isDeepStrictEqual(actual, expected), name === 'unchanged');
});
test('whole public DOM normalization excludes only disclosure, preserving all other markup', async () => {
  let removed = [];
  const result = await normalizedDom({ evaluate: fn => fn({ cloneNode: deep => {
    assert.equal(deep, true);
    return { querySelectorAll: selector => { assert.equal(selector, 'details'); return [{ removeAttribute: attribute => removed.push(attribute) }]; },
      outerHTML: '<section data-run="synthetic"><pre>exact public markup</pre></section>' };
  } }) });
  assert.equal(isDeepStrictEqual(removed, ['open']), true);
  assert.equal(result.includes('exact public markup'), true);
});

function handshake() {
  const origin = 'http://127.0.0.1:1234', url = `${origin}/v1/sessions/${f.SID}/conversation`;
  const request = { method: () => 'GET', url: () => url };
  const reply = { request: () => request, url: () => url, status: () => 200 };
  const stream = { method: () => 'GET', url: () => `${url}/events?after=${encodeURIComponent(f.cursor('l', head, '3', '', ''))}` };
  for (const key of ['body', 'text', 'json']) Object.defineProperty(reply, key, { get() { assert.fail('SDK body is not application consumption'); } });
  return { origin, sid: f.SID, head, value: richPage(), reply, snapshots: [{ request, index: 0, response: reply }], streams: [{ request: stream, index: 1, response: reply }] };
}
const handshakeChanges = {
  'same URL different Request': h => { h.reply = { ...h.reply, request: () => ({ ...h.snapshots[0].request }) }; },
  'same URL different Response': h => { h.streams[0].response = { ...h.reply }; },
  'missing snapshot': h => { h.snapshots = []; }, 'duplicate snapshot': h => { h.snapshots.push(h.snapshots[0]); },
  'missing stream': h => { h.streams = []; }, 'duplicate stream': h => { h.streams.push(h.streams[0]); },
  'stream before snapshot': h => { h.streams[0].index = 0; }, 'wrong H': h => { h.head = '31'; },
  'wrong session': h => { h.sid = f.OTHER; }, 'wrong live head': h => { h.value.live_after = f.cursor('l', '31', '3', '', ''); },
  'wrong rank': h => { h.value.live_after = f.cursor('l', head, '0', '', ''); },
  'extra stream query': h => { const original = h.streams[0].request.url(); h.streams[0].request.url = () => `${original}&extra=1`; },
};
test('fresh handshake binds original framework identities without reading an SDK body', () => { assert.equal(freshHandshake(handshake()), true); });
for (const [name, change] of Object.entries(handshakeChanges)) test(`fresh handshake rejects ${name}`, () => {
  const h = handshake(); change(h); assert.throws(() => freshHandshake(h));
});
for (const path of ['/runs', '/runs/reconcile', '/rename', '/refresh', '/runs/fixture/cancel']) test(`read-only observer rejects mutation ${path}`, () => {
  assert.equal(readOnly([{ method: 'GET' }, { method: 'POST', path }]), false);
});

const sourceText = readFileSync(new URL('../e2e/rich-display-parity.spec.mjs', import.meta.url), 'utf8');
const source = ts.createSourceFile('rich-display-parity.mjs', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const helper = name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(source);
for (const [method, path, observer, expected] of [
  ['GET', '/v1/settings', true, true], ['GET', `/v1/sessions/${f.SID}/conversation`, true, true],
  ['GET', `/v1/sessions/${f.SID}/conversation/events?after=synthetic`, true, true],
  ['POST', '/v1/sessions', true, false], ['POST', `/v1/sessions/${f.SID}/runs`, true, false],
  ['POST', `/v1/sessions/${f.SID}/runs/fixture/cancel`, false, false], ['GET', `/v1/sessions/${f.SID}/history`, true, false],
  ['GET', `/v1/sessions/${f.SID}/conversation?before=synthetic`, true, false],
]) test(`actual-source request allowlist preserves observer boundary ${method}/${path}`, () => {
  assert.equal(runInNewContext(`${helper('allowedRequest')};allowedRequest(method,url,sid,observer)`,
    { method, url: new URL(path, 'http://127.0.0.1:1234'), sid: f.SID, observer }), expected);
});
for (const variant of ['valid', 'bad-status', 'bad-media', 'bad-dto', 'bad-utf8', 'too-large', 'body-rejected']) test(`actual-source independent HTTP proof has no body fallback: ${variant}`, async () => {
  let bodyReads = 0, calls = 0;
  const page = richPage(); if (variant === 'bad-dto') page.private = 'synthetic-private';
  let bytes = Buffer.from(JSON.stringify(page));
  if (variant === 'bad-utf8') bytes = Buffer.from([255]);
  if (variant === 'too-large') bytes = Buffer.alloc(512 * 1024 + 1);
  const fetch = async (url, init) => {
    calls++;
    assert.equal(url, `http://127.0.0.1:1234/v1/sessions/${f.SID}/conversation`);
    assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-owner');
    return { status: variant === 'bad-status' ? 503 : 200,
      headers: new Headers({ 'Cache-Control': 'no-store', 'Content-Type': variant === 'bad-media' ? 'text/plain' : 'application/json' }),
      arrayBuffer: async () => { bodyReads++; if (variant === 'body-rejected') throw new Error('synthetic rejection'); return bytes; } };
  };
  const promise = runInNewContext(`${helper('latestProof')};latestProof(fixture,sid)`, {
    fetch, fixture: { origin: 'http://127.0.0.1:1234', owner: 'synthetic-owner' }, sid: f.SID, TextDecoder, AbortSignal,
    decodeJson, validateConversationPage, expect: value => ({ toBe: expected => assert.equal(value, expected) }),
  });
  if (variant === 'valid') assert.equal(isDeepStrictEqual(await promise, page), true);
  else await assert.rejects(promise);
  assert.equal(calls, 1); assert.equal(bodyReads, variant === 'bad-status' ? 0 : 1);
});
test('actual scenario is one joined Task, one partial barrier, fresh context and strict native drain', () => {
  const calls = [];
  function visit(node) { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); }
  visit(source);
  const named = name => calls.filter(call => call.expression.getText(source) === name);
  assert.equal(named('test').length, 1); assert.equal(named('startFixture').length, 1);
  assert.equal(named('startFixture')[0].arguments[1].getText(source), "{ transport: 'websocket', recovered: false, mime: true, presentation: true }");
  assert.equal(named('browser.newContext').length, 2);
  assert.equal(named('freshHandshake').length, 1); assert.equal(named('fixture.stop').length, 1);
  assert.equal(sourceText.includes('for (const gate of [2, 3, 4, 5, 6])'), true);
  assert.equal(sourceText.indexOf("stage = 'close-b'") < sourceText.indexOf('for (const gate of [2, 3, 4, 5, 6])'), true);
  assert.equal(/freshReply\.(body|text|json)\s*\(/.test(sourceText), false);
  assert.equal(/\.fulfill\s*\(|test\.skip|test\.only|\.newCDPSession\s*\(/.test(sourceText), false);
});
