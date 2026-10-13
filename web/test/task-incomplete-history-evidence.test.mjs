import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateCreateView, validateErrorView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, cursor, field, human, block, session, page, batch } from '../test-support/display-fixtures.mjs';

const source = ts.createSourceFile('task-incomplete-history.js', readFileSync(new URL('../e2e/task-incomplete-history.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const attempt = callback.body.statements.find(ts.isTryStatement);
const statements = attempt.tryBlock.statements;
const reads = statements.filter(node => node.getText(source).includes(' = await Promise.all([') || node.getText(source).startsWith('await Promise.all(['));
assert.equal(reads.length, 4);
const stages = reads.map(node => [...statements.slice(0, statements.indexOf(node))].reverse().find(item => item.getText(source).startsWith('stage = ')));
assert.ok(stages.every(Boolean));
const helper = statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readReply');
const guard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
assert.ok(helper && guard);
const declarations = callback.body.statements.filter(ts.isVariableStatement);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1, callback.body.statements.indexOf(attempt) + 3);
assert.equal(tail[1].getText(source), 'if (failure) throw failure;');
// Execute the real reply statements, decoder helper, catch and cleanup, not a copied diagnostic model.
const controlled = `(async () => {
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  sid = syntheticSession; taskPath = '/v1/sessions/' + sid + '/runs'; Object.assign(wire, syntheticWire);
  ${helper.getText(source)}
  ${guard.getText(source)}
  capture(() => ({ observed, cleanup, faults }));
  try {
    ${reads.map((node, index) => `${stages[index].getText(source)}\n${node.getText(source)}\nawait later(${index});`).join('\n')}
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail.map(node => node.getText(source)).join('\n')}
})()`;
const PRIVATE = 'synthetic-private-cause-response-dom https://private.invalid/?token=synthetic';
const titles = ['synthetic title'];
const TASKS = ['  first 雪\n', '  second 雪\n'];
const EDIT = '  later EDIT 雪\n';
const ids = [OID, RID, OTHER, '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const wire = { create: { operation_id: ids[0], title: titles[0], workspace: '/synthetic/project' },
  tasks: [0, 1].map(index => ({ operation_id: ids[1 + index * 2], run_id: ids[2 + index * 2], text: TASKS[index] })) };
const receipt = () => ({ operation_id: wire.tasks[0].operation_id, session_id: SID, run_id: wire.tasks[0].run_id,
  first_sequence: '2', last_sequence: '3' });
const acceptance = () => ({ api_version: 1, receipt: receipt(), duplicate: false, warning_code: 'storage.connection_cleanup_failed', notices: [] });
const rejection = () => ({ api_version: 1, code: 'invalid_request', stage: 'history', certainty: 'not_applicable', acceptance: null, notices: [] });
const emptyPage = () => page({ snapshot_head: '1', session: session('1', { title: titles[0] }), block: null,
  entries: [], earlier_activity: null, previous_block: null, live_after: cursor('l', '1', '3', '', '') });
const plain = value => JSON.parse(JSON.stringify(value));
const blank = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false,
  body_bounded: false, decoded: false, validated: false, exact: false });
function valueFor(index) {
  if (index === 0) return { api_version: 1, session_id: SID, receipt: { operation_id: wire.create.operation_id,
    session_id: SID, run_id: null, first_sequence: '1', last_sequence: '1' }, duplicate: false, warning_code: null };
  if (index === 1) return emptyPage();
  return index === 2 ? acceptance() : rejection();
}
async function exercise({ index = 3, option = 'valid', laterFailure = false, closeFailure = false, stopFailure = false, prior } = {}) {
  let getter, failure, acquired = 0;
  const output = [], calls = [], beforeBody = [];
  const env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const cause = new TypeError(PRIVATE);
  cause.stack = `${PRIVATE}\n at task-incomplete-history.spec.mjs:789:4\n${PRIVATE}`;
  const statusFor = n => [201, 200, 202, 422][n];
  const getFacts = n => n < 2 ? getter().observed[n === 0 ? 'create' : 'latest'] : getter().observed.tasks[n - 2];
  const ownedPage = {
    waitForResponse: async predicate => {
      const n = acquired++, variant = n === index ? option : 'valid';
      const paths = ['/v1/sessions', `/v1/sessions/${SID}/conversation`, `/v1/sessions/${SID}/runs`, `/v1/sessions/${SID}/runs`];
      const response = { url: () => 'http://127.0.0.1' + paths[n], request: () => ({ method: () => n === 1 ? 'GET' : 'POST' }) };
      assert.equal(predicate(response), true); calls.push('acquire-' + n);
      if (variant === 'acquisition') throw cause;
      const value = valueFor(n);
      if (variant === 'schema') value.api_version = 2;
      if (variant === 'extra') value.private = PRIVATE;
      if (variant === 'identity') value.receipt.run_id = SID;
      if (variant === 'duplicate') value.duplicate = true;
      if (variant === 'notices') value.notices = [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }];
      if (variant === 'warning') value.warning_code = null;
      if (variant === 'range') value.receipt.last_sequence = '4';
      if (variant === 'code') value.code = 'storage.stale_history';
      if (variant === 'stage') value.stage = 'preflight';
      if (variant === 'certainty') value.certainty = 'unknown';
      if (variant === 'acceptance') value.acceptance = receipt();
      if (variant === 'exact' && n === 1) value.session.title = 'other';
      Object.assign(response, {
        status: () => variant === 'status' ? 200 : statusFor(n),
        headers: () => ({ 'content-type': variant === 'media' ? 'text/plain; private=' + PRIVATE : 'application/json; charset=utf-8' }),
        body: async () => {
          beforeBody.push(plain(getFacts(n))); calls.push('body-' + n);
          if (variant === 'body') throw cause;
          if (variant === 'size') return Buffer.alloc(4097, 32);
          if (variant === 'utf8') return Buffer.from([255]);
          if (variant === 'json') return Buffer.from(`{"private":"${PRIVATE}",`);
          if (variant === 'keys') return Buffer.from(JSON.stringify(value).replace('{', '{"api_version":1,'));
          return Buffer.from(JSON.stringify(value));
        },
      });
      return response;
    },
    getByRole: () => ({ click: async () => {} }),
  };
  try {
    await runInNewContext(controlled, {
      process: { env }, console: { log: text => output.push(text) }, URL, Buffer, TextDecoder, decodeJson,
      validateCreateView, validateConversationPage, validateDisplayTaskAccepted, validateErrorView, titles,
      uuid: value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000',
      syntheticSession: SID, syntheticWire: plain(wire), ownedPage, createCommand: ownedPage,
      ownedContext: { close: async () => { calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw cause; } },
      ownedFixture: { stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw cause; } },
      leaked: raw => raw.includes(PRIVATE), capture: value => { getter = value; },
      later: async n => { if (laterFailure && n === 3) throw cause; },
      expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  const diagnostic = [failure?.message ?? '', failure?.stack ?? '', ...output].join('\n');
  for (const secret of [PRIVATE, 'private.invalid', SID, ...ids, titles[0], '/synthetic/project', ...TASKS]) assert.equal(diagnostic.includes(secret), false);
  assert.deepEqual(calls.slice(-2), ['browser-close', 'fixture-stop']);
  assert.deepEqual(output, [`Incomplete history cleanup: browser=${!closeFailure} fixture=${!stopFailure}`]);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
  return { failure, evidence: plain(getter()), beforeBody, calls };
}

for (const index of [2, 3]) for (const option of ['acquisition', 'body', 'size', 'utf8', 'media', 'json', 'schema', 'extra']) {
  test(`incomplete actual Task${index - 1} ${option} retains truthful private-safe reply facts`, async () => {
    const result = await exercise({ index, option });
    assert.ok(result.failure);
    const facts = blank(), status = index === 2 ? 202 : 422;
    if (option !== 'acquisition') Object.assign(facts, { acquired: true, status, body_attempted: true });
    if (!['acquisition', 'body'].includes(option)) facts.body_returned = true;
    if (!['acquisition', 'body', 'size'].includes(option)) facts.body_bounded = true;
    if (['schema', 'extra'].includes(option)) facts.decoded = true;
    assert.deepEqual(result.evidence.observed.tasks[index - 2], facts);
    if (index === 2) assert.deepEqual(result.evidence.observed.tasks[1], blank());
    if (option !== 'acquisition') assert.deepEqual(result.beforeBody.at(-1), { ...blank(), acquired: true, status, body_attempted: true });
    assert.equal(result.evidence.faults.secret, ['json', 'extra'].includes(option) ? 1 : 0);
  });
}
test('incomplete actual warning receipt rejects wrong identity before validation returns', async () => {
  const result = await exercise({ index: 2, option: 'identity' });
  assert.ok(result.failure);
  assert.deepEqual(result.evidence.observed.tasks[0], { ...blank(), acquired: true, status: 202,
    body_attempted: true, body_returned: true, body_bounded: true, decoded: true });
  assert.deepEqual(result.evidence.observed.tasks[1], blank());
});
for (const [index, options] of [[2, ['status', 'duplicate', 'notices', 'warning', 'range', 'keys']],
  [3, ['status', 'code', 'stage', 'certainty', 'acceptance', 'notices', 'keys']]]) {
  for (const option of options) test(`incomplete actual Task${index - 1} rejects closed non-exact ${option}`, async () => {
    const result = await exercise({ index, option });
    assert.ok(result.failure);
    assert.deepEqual(result.evidence.observed.tasks[index - 2], { acquired: true, status: option === 'status' ? 200 : index === 2 ? 202 : 422,
      body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: false });
    if (index === 2) assert.deepEqual(result.evidence.observed.tasks[1], blank());
  });
}
for (const [index, option] of [[0, 'schema'], [0, 'duplicate'], [0, 'keys'], [1, 'schema'], [1, 'exact']]) test(`incomplete actual reply${index} ${option} leaves Tasks unavailable`, async () => {
  const result = await exercise({ index, option });
  assert.ok(result.failure);
  assert.deepEqual(result.evidence.observed.tasks, [blank(), blank()]);
});
test('incomplete actual reply statements succeed without claiming native or DOM proof', async () => {
  const result = await exercise({ prior: 'prior-guard' });
  assert.equal(result.failure, undefined);
  for (const [index, facts] of [result.evidence.observed.create, result.evidence.observed.latest, ...result.evidence.observed.tasks].entries()) {
    assert.deepEqual(facts, { acquired: true, status: [201, 200, 202, 422][index],
      body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: true });
  }
});
for (const failedCleanup of [false, true]) test(`incomplete private later failure has priority over cleanup=${failedCleanup}`, async () => {
  const result = await exercise({ laterFailure: true, closeFailure: failedCleanup, stopFailure: failedCleanup, prior: 'prior-guard' });
  assert.ok(result.failure.message.startsWith('Incomplete history failed: second Send rejects incomplete stored history; kind=TypeError line=789;'));
  assert.equal(result.evidence.observed.tasks[1].exact, true);
  assert.equal(result.failure.message.includes('cleanup failed'), false);
});
for (const closeFailure of [false, true]) test(`incomplete cleanup-only failure is fatal; browser=${closeFailure}`, async () => {
  const result = await exercise({ closeFailure, stopFailure: true });
  assert.equal(result.failure.message, closeFailure ? 'Incomplete history browser cleanup failed' : 'Incomplete history fixture cleanup failed');
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n = 0; n < 5; n++) await tick(); }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function suppliedBlock() {
  const text = TASKS[0], length = String(Buffer.byteLength(text)), run_id = wire.tasks[0].run_id;
  return block({ run_id, revision: '2', state: 'accepted', human: human({ run_id,
    fields: [field({ field_id: 'text', order_key: '0', generation: '2', text, total_bytes: length, to_byte: length })] }) });
}
for (const displayFirst of [false, true]) test(`public display controller immutable warning then rejection never clears second draft; display first=${displayFirst}`, async t => {
  const calls = [], publications = [], waiting = [];
  let next = 0, streamOwner, cancels = 0;
  const client = createDisplayClient({ crypto: { randomUUID: () => ids[next++] }, fetch: async (path, init) => {
    calls.push({ path, init });
    if (path === '/v1/settings') return response({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path.startsWith('/v1/sessions?')) return response({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path === '/v1/sessions' && init.method === 'POST') return response(valueFor(0), 201);
    if (path.endsWith('/conversation')) return response(emptyPage());
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream({ start(owner) { streamOwner = owner; }, cancel() { cancels++; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (path.endsWith('/runs') && init.method === 'POST') return new Promise(resolve => waiting.push(resolve));
    throw new Error('Unexpected synthetic request');
  } });
  t.after(() => client.disconnect());
  client.subscribe(snapshot => publications.push(snapshot));
  await client.connect('0123456789abcdef'.repeat(4));
  await client.createSession(titles[0], '/synthetic/project');
  await client.selectSession(SID); await flush();
  const push = async () => {
    const value = batch([{ kind: 'block.upsert', block: suppliedBlock() }], '3');
    streamOwner.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`)); await flush();
  };
  const create = client.snapshot().pending[0];
  client.setDraft(TASKS[0]);
  const firstSend = client.sendTask(); await flush();
  const capturedFirst = client.snapshot().pending[1];
  assert.equal(capturedFirst.phase, 'sending'); assert.equal(client.snapshot().draft, TASKS[0]);
  assert.deepEqual(capturedFirst.command.body, wire.tasks[0]);
  assert.equal(Object.isFrozen(capturedFirst.command) && Object.isFrozen(capturedFirst.command.body), true);
  assert.throws(() => { capturedFirst.command.body.text = 'mutated'; }, TypeError);
  if (displayFirst) {
    await push();
    assert.equal(client.snapshot().draft, TASKS[0]); assert.equal(client.snapshot().pending[1].phase, 'sending');
  }
  waiting[0](response(acceptance(), 202)); await firstSend; await flush();
  assert.equal(client.snapshot().draft, '');
  const accepted = client.snapshot().pending[1];
  assert.equal(accepted.phase, 'accepted'); assert.deepEqual(accepted.command, capturedFirst.command);
  assert.deepEqual(accepted.receipt, receipt()); assert.deepEqual(accepted.reply, acceptance());
  assert.equal(Object.isFrozen(accepted.receipt) && Object.isFrozen(accepted.reply), true);
  assert.throws(() => { accepted.receipt.run_id = SID; }, TypeError);
  assert.throws(() => { accepted.reply.warning_code = null; }, TypeError);
  if (!displayFirst) await push();
  const firstStore = plain(client.snapshot().selected.store);
  assert.equal(client.snapshot().selected.observation, 'streaming');
  assert.equal(client.snapshot().selected.observation_error, null);
  assert.equal(firstStore.blocks.length, 1); assert.equal(firstStore.blocks[0].entries.length, 0);
  const { human: suppliedHuman, ...suppliedHeader } = suppliedBlock();
  const { fields: suppliedFields, earlier_content, content_complete, ...suppliedEntry } = suppliedHuman;
  assert.deepEqual(firstStore.blocks[0].view, suppliedHeader);
  assert.deepEqual(firstStore.blocks[0].human.view, suppliedEntry);
  assert.equal(firstStore.blocks[0].human.earlier_content, earlier_content);
  assert.equal(firstStore.blocks[0].human.content_complete, content_complete);
  assert.deepEqual(firstStore.blocks[0].human.fields[0].ranges, [{ from_byte: '0', to_byte: suppliedFields[0].to_byte, text: TASKS[0] }]);
  client.setDraft(TASKS[1]);
  const secondSend = client.sendTask(); await flush();
  const capturedSecond = client.snapshot().pending[2];
  assert.equal(capturedSecond.phase, 'sending'); assert.equal(client.snapshot().draft, TASKS[1]);
  assert.deepEqual(capturedSecond.command.body, wire.tasks[1]);
  assert.equal(Object.isFrozen(capturedSecond.command) && Object.isFrozen(capturedSecond.command.body), true);
  assert.throws(() => { capturedSecond.command.body.text = 'mutated'; }, TypeError);
  assert.equal(waiting.length, 2);
  waiting[1](response(rejection(), 422)); await secondSend; await flush();
  const rejected = client.snapshot().pending[2], { api_version: _version, ...safeError } = rejection();
  assert.equal(rejected.phase, 'rejected'); assert.deepEqual(rejected.command, capturedSecond.command);
  assert.equal(rejected.receipt, null); assert.equal(rejected.reply, null); assert.deepEqual(rejected.notices, []);
  assert.deepEqual(rejected.error, { category: 'http', status: 422, server: safeError });
  assert.equal(Object.isFrozen(rejected.error) && Object.isFrozen(rejected.error.server), true);
  for (const draft of [TASKS[1], EDIT, EDIT]) {
    client.setDraft(draft); await flush();
    const now = client.snapshot();
    assert.equal(now.draft, draft); assert.deepEqual(now.pending, [create, accepted, rejected]);
    assert.deepEqual(plain(now.selected.store), firstStore);
    assert.equal(now.selected.run_view, null); assert.equal(now.selected.cancel, null);
    assert.equal(now.selected.observation_error, null);
  }
  // Check publications outside subscriptions because controller listeners swallow view errors.
  const cleared = publications.filter((value, n) => n > 0 && publications[n - 1].draft === TASKS[0] && value.draft === '');
  assert.equal(cleared.length, 1); assert.equal(cleared[0].pending[1].phase, 'accepted');
  assert.deepEqual(cleared[0].pending[1].receipt, receipt());
  assert.equal(publications.some((value, n) => n > 0 && publications[n - 1].draft === TASKS[1] && value.draft === ''), false);
  assert.deepEqual(calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(call.init.body)), [wire.create, ...wire.tasks]);
  assert.equal(new Set([SID, ...ids]).size, 6);
  assert.ok(calls.every(call => !/\/(history|operations)(\/|$)/.test(call.path) && !call.path.endsWith('/events')));
  assert.equal(calls.filter(call => call.path.includes('/conversation/events?')).length, 1);
  client.disconnect(); await flush();
  const clearedMemory = client.snapshot();
  assert.equal(clearedMemory.connection, 'disconnected'); assert.equal(clearedMemory.selected, null); assert.equal(clearedMemory.draft, '');
  assert.equal(clearedMemory.settings, null); assert.equal(clearedMemory.catalog, null); assert.deepEqual(clearedMemory.pending, []);
  assert.equal(cancels, 1); assert.equal(calls.filter(call => call.init.method === 'POST').length, 3);
});
