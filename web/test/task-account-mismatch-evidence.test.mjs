import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, cursor, field, entry, human, block, session, page, batch } from '../test-support/display-fixtures.mjs';

const source = ts.createSourceFile('task-account-mismatch.js', readFileSync(new URL('../e2e/task-account-mismatch.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
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
// Run the actual four reply statements, decoder helper, catch and cleanup, not a copied diagnostic model.
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
const ids = [OID, RID, OTHER, '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const wire = { create: { operation_id: ids[0], title: titles[0], workspace: '/synthetic/project' },
  tasks: [0, 1].map(index => ({ operation_id: ids[1 + index * 2], run_id: ids[2 + index * 2], text: TASKS[index] })) };
const receipt = index => ({ operation_id: wire.tasks[index].operation_id, session_id: SID, run_id: wire.tasks[index].run_id,
  first_sequence: index === 0 ? '2' : '8', last_sequence: index === 0 ? '3' : '9' });
const acceptance = index => ({ api_version: 1, receipt: receipt(index), duplicate: false, warning_code: null, notices: [] });
const emptyPage = () => page({ snapshot_head: '1', session: session('1', { title: titles[0] }), block: null,
  entries: [], earlier_activity: null, previous_block: null, live_after: cursor('l', '1', '3', '', '') });
const plain = value => JSON.parse(JSON.stringify(value));
const blank = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false,
  body_bounded: false, decoded: false, validated: false, exact: false });
function valueFor(index) {
  if (index === 0) return { api_version: 1, session_id: SID, receipt: { operation_id: wire.create.operation_id,
    session_id: SID, run_id: null, first_sequence: '1', last_sequence: '1' }, duplicate: false, warning_code: null };
  if (index === 1) return emptyPage();
  return acceptance(index - 2);
}
async function exercise({ index = 3, option = 'valid', laterFailure = false, closeFailure = false, stopFailure = false, prior } = {}) {
  let getter, failure, acquired = 0;
  const output = [], calls = [], beforeBody = [];
  const env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const cause = new TypeError(PRIVATE);
  cause.stack = `${PRIVATE}\n at task-account-mismatch.spec.mjs:789:4\n${PRIVATE}`;
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
      if (variant === 'identity') value.receipt.operation_id = SID;
      if (variant === 'duplicate') value.duplicate = true;
      if (variant === 'notices') value.notices = [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }];
      if (variant === 'exact' && n === 1) value.session.title = 'other';
      Object.assign(response, {
        status: () => variant === 'status' ? 200 : n === 0 ? 201 : n === 1 ? 200 : 202,
        headers: () => ({ 'content-type': variant === 'media' ? 'text/plain; private=' + PRIVATE : 'application/json; charset=utf-8' }),
        body: async () => {
          beforeBody.push(plain(getFacts(n))); calls.push('body-' + n);
          if (variant === 'body') throw cause;
          if (variant === 'size') return Buffer.alloc(4097, 32);
          if (variant === 'utf8') return Buffer.from([255]);
          if (variant === 'json') return Buffer.from(`{"private":"${PRIVATE}",`);
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
      validateCreateView, validateConversationPage, validateDisplayTaskAccepted, titles,
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
  assert.deepEqual(output, [`Account mismatch cleanup: browser=${!closeFailure} fixture=${!stopFailure}`]);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
  return { failure, evidence: plain(getter()), beforeBody, calls };
}

for (const index of [2, 3]) for (const option of ['acquisition', 'body', 'size', 'utf8', 'media', 'json', 'schema', 'extra', 'identity']) {
  test(`account actual Task${index - 1} ${option} retains truthful private-safe reply facts`, async () => {
    const result = await exercise({ index, option });
    assert.ok(result.failure);
    const facts = blank();
    if (option !== 'acquisition') Object.assign(facts, { acquired: true, status: 202, body_attempted: true });
    if (!['acquisition', 'body'].includes(option)) facts.body_returned = true;
    if (!['acquisition', 'body', 'size'].includes(option)) facts.body_bounded = true;
    if (['schema', 'extra', 'identity'].includes(option)) facts.decoded = true;
    assert.deepEqual(result.evidence.observed.tasks[index - 2], facts);
    if (index === 2) assert.deepEqual(result.evidence.observed.tasks[1], blank());
    if (option !== 'acquisition') assert.deepEqual(result.beforeBody.at(-1), { ...blank(), acquired: true, status: 202, body_attempted: true });
    assert.equal(result.evidence.faults.secret, ['json', 'extra'].includes(option) ? 1 : 0);
  });
}
for (const option of ['status', 'duplicate', 'notices']) test(`account actual second Task rejects closed non-exact ${option}`, async () => {
  const result = await exercise({ option });
  assert.ok(result.failure);
  assert.deepEqual(result.evidence.observed.tasks[1], { acquired: true, status: option === 'status' ? 200 : 202,
    body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: false });
});
for (const [index, option] of [[0, 'schema'], [0, 'duplicate'], [1, 'schema'], [1, 'exact']]) test(`account actual reply${index} ${option} leaves Tasks unavailable`, async () => {
  const result = await exercise({ index, option });
  assert.ok(result.failure);
  assert.deepEqual(result.evidence.observed.tasks, [blank(), blank()]);
});
test('account actual reply statements succeed without claiming native or DOM proof', async () => {
  const result = await exercise({ prior: 'prior-guard' });
  assert.equal(result.failure, undefined);
  for (const [index, facts] of [result.evidence.observed.create, result.evidence.observed.latest, ...result.evidence.observed.tasks].entries()) {
    assert.deepEqual(facts, { acquired: true, status: index === 0 ? 201 : index === 1 ? 200 : 202,
      body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: true });
  }
});
for (const failedCleanup of [false, true]) test(`account private later failure has priority over cleanup=${failedCleanup}`, async () => {
  const result = await exercise({ laterFailure: true, closeFailure: failedCleanup, stopFailure: failedCleanup, prior: 'prior-guard' });
  assert.ok(result.failure.message.startsWith('Account mismatch failed: one-shot private rotation after audited completion; kind=TypeError line=789;'));
  assert.equal(result.evidence.observed.tasks[1].exact, true);
  assert.equal(result.failure.message.includes('cleanup failed'), false);
});
for (const closeFailure of [false, true]) test(`account cleanup-only failure is fatal; browser=${closeFailure}`, async () => {
  const result = await exercise({ closeFailure, stopFailure: true });
  assert.equal(result.failure.message, closeFailure ? 'Account mismatch browser cleanup failed' : 'Account mismatch fixture cleanup failed');
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n = 0; n < 5; n++) await tick(); }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const zero = { turns_started: '0', turns_finished: '0', model_requests_attempted: '0', model_requests_admitted: '0',
  new_tool_dispatches: '0', tool_results_prepared: '0', reused_results: '0', last_request_id: null, last_upstream_outcome: null };
function suppliedBlock(index, revision, state = 'accepted') {
  const run_id = wire.tasks[index].run_id, sequence = index === 0 ? '2' : '8', text = TASKS[index], length = String(Buffer.byteLength(text));
  return block({ run_id, accepted_sequence: sequence, revision, state, result_recorded: state !== 'accepted',
    outcome: state === 'accepted' ? null : state === 'completed' ? { type: 'completed' } : { type: 'failed', code: 'history_identity' },
    summary: state === 'accepted' ? null : { ...zero }, events_complete: state === 'accepted' ? null : true,
    human: human({ run_id, entry_id: `e:${sequence}:0`, position: { sequence, slot: '0' }, revision: sequence, content_epoch: sequence,
      fields: [field({ field_id: 'text', order_key: '0', generation: sequence, text, total_bytes: length, to_byte: length })] }) });
}
for (const displayFirst of [false, true]) test(`public display controller two immutable accepted commands clear once; display first=${displayFirst}`, async t => {
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
  const push = async (changes, head) => { const value = batch(changes, head); streamOwner.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`)); await flush(); };
  const create = client.snapshot().pending[0];
  let stableFirst;
  for (const index of [0, 1]) {
    client.setDraft(TASKS[index]);
    const send = client.sendTask(); await flush();
    const captured = client.snapshot().pending[index + 1];
    assert.equal(captured.phase, 'sending'); assert.equal(client.snapshot().draft, TASKS[index]);
    assert.deepEqual(captured.command.body, wire.tasks[index]);
    assert.equal(Object.isFrozen(captured.command) && Object.isFrozen(captured.command.body), true);
    assert.throws(() => { captured.command.body.text = 'mutated'; }, TypeError);
    assert.equal(waiting.length, index + 1);
    if (displayFirst) {
      await push([{ kind: 'block.upsert', block: suppliedBlock(index, index === 0 ? '2' : '8') }], index === 0 ? '2' : '8');
      assert.equal(client.snapshot().draft, TASKS[index]);
      assert.equal(client.snapshot().pending[index + 1].phase, 'sending');
    }
    waiting[index](response(acceptance(index), 202)); await send; await flush();
    assert.equal(client.snapshot().draft, '');
    const accepted = client.snapshot().pending[index + 1];
    assert.equal(accepted.phase, 'accepted'); assert.deepEqual(accepted.command, captured.command);
    assert.deepEqual(accepted.receipt, receipt(index)); assert.deepEqual(accepted.reply, acceptance(index));
    assert.equal(Object.isFrozen(accepted.receipt) && Object.isFrozen(accepted.reply), true);
    assert.throws(() => { accepted.receipt.run_id = SID; }, TypeError);
    client.setDraft('  later EDIT 雪\n');
    const terminal = suppliedBlock(index, index === 0 ? '4' : '10', index === 0 ? 'completed' : 'failed');
    const changes = [{ kind: 'block.upsert', block: terminal }];
    if (index === 0) changes.push({ kind: 'entry.upsert', block: terminal, entry: entry({ run_id: terminal.run_id,
      entry_id: 'e:3:0', position: { sequence: '3', slot: '0' }, revision: '4', content_epoch: '3', recorded_state: 'completed', provisional: false,
      fields: [field({ generation: '3', text: 'synthetic answer', total_bytes: '16', to_byte: '16' })] }) });
    await push(changes, terminal.revision);
    const saved = client.snapshot();
    // Repeated supplied terminal facts need a newer revision, not changes behind an applied watermark.
    const duplicate = { ...terminal, revision: String(BigInt(terminal.revision) + 1n) };
    await push([{ kind: 'block.upsert', block: duplicate }], duplicate.revision);
    const now = client.snapshot();
    assert.equal(now.selected.observation, 'streaming'); assert.equal(now.selected.observation_error, null);
    assert.deepEqual(now.pending, saved.pending);
    assert.deepEqual(now.selected.store.blocks[index].entries, saved.selected.store.blocks[index].entries);
    assert.equal(now.draft, '  later EDIT 雪\n'); assert.deepEqual(now.pending[index + 1], accepted);
    assert.deepEqual(now.pending[0], create);
    if (index === 0) stableFirst = plain(now.selected.store.blocks[0]);
    else {
      assert.deepEqual(plain(now.selected.store.blocks[0]), stableFirst);
      assert.equal(now.selected.store.blocks[1].entries.length, 0);
      assert.deepEqual(now.selected.store.blocks[1].view.summary, zero);
      assert.deepEqual(now.selected.store.blocks[1].view.outcome, { type: 'failed', code: 'history_identity' });
    }
    // Assertions run outside subscriptions because controller listeners intentionally swallow view errors.
    const cleared = publications.filter((value, n) => n > 0 && publications[n - 1].draft === TASKS[index] && value.draft === '');
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].pending[index + 1].phase, 'accepted');
    assert.deepEqual(cleared[0].pending[index + 1].receipt, receipt(index));
  }
  assert.deepEqual(calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(call.init.body)), [wire.create, ...wire.tasks]);
  assert.equal(new Set([SID, ...ids]).size, 6);
  assert.ok(calls.every(call => !/\/(history|operations)(\/|$)/.test(call.path) && !call.path.endsWith('/events')));
  assert.equal(calls.filter(call => call.path.includes('/conversation/events?')).length, 1);
  client.disconnect(); await flush();
  const cleared = client.snapshot();
  assert.equal(cleared.connection, 'disconnected'); assert.equal(cleared.selected, null); assert.equal(cleared.draft, '');
  assert.equal(cleared.settings, null); assert.equal(cleared.catalog, null); assert.deepEqual(cleared.pending, []);
  assert.equal(cancels, 1); assert.equal(calls.filter(call => call.init.method === 'POST').length, 3);
});
