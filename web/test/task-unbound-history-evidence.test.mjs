import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { decodeJson, validateErrorView } from '../dist/api.js';
import { validateConversationPage } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, cursor, field, entry, human, block, session, page } from '../test-support/display-fixtures.mjs';

const source = ts.createSourceFile('task-unbound-history.js', readFileSync(new URL('../e2e/task-unbound-history.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const attempt = callback.body.statements.find(ts.isTryStatement);
const statements = attempt.tryBlock.statements;
const reads = statements.filter(node => node.getText(source).includes('readReply(page.waitForResponse('));
assert.equal(reads.length, 2);
const stages = reads.map(node => [...statements.slice(0, statements.indexOf(node))].reverse().find(item => item.getText(source).startsWith('stage = ')));
const helpers = statements.filter(node => ts.isFunctionDeclaration(node) && ['readReply', 'completeText'].includes(node.name?.text));
const guard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
assert.equal(helpers.length, 2); assert.ok(guard && stages.every(Boolean));
const constants = source.statements.filter(node => ts.isVariableStatement(node) && ['TASKS', 'ANSWER', 'TITLE', 'EDIT'].includes(node.declarationList.declarations[0].name.getText(source)));
assert.equal(constants.length, 4);
const declarations = callback.body.statements.filter(ts.isVariableStatement);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1, callback.body.statements.indexOf(attempt) + 3);
assert.equal(tail[1].getText(source), 'if (failure) throw failure;');
// Execute the authored response/catch/cleanup statements, not a copied diagnostic model.
const controlled = `(async () => {
  ${constants.map(node => node.getText(source)).join('\n')}
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  sid = syntheticSession; taskPath = '/v1/sessions/' + sid + '/runs'; workspace = '/synthetic/project'; sent = syntheticCommand;
  ${helpers.map(node => node.getText(source)).join('\n')}
  ${guard.getText(source)}
  capture(() => ({ observed, cleanup, faults }));
  try {
    ${reads.map((node, index) => `${stages[index].getText(source)}\n${node.getText(source)}\nawait later(${index});`).join('\n')}
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail.map(node => node.getText(source)).join('\n')}
})()`;
const { TASKS, ANSWER, TITLE, EDIT } = runInNewContext(`${constants.map(node => node.getText(source)).join('\n')}\n({ TASKS, ANSWER, TITLE, EDIT })`);
const PRIVATE = 'synthetic-private-cause-response-dom https://private.invalid/?token=synthetic';
const command = { operation_id: OID, run_id: OTHER, text: TASKS[1] };
const summary = { turns_started: '1', turns_finished: '1', model_requests_attempted: '1', model_requests_admitted: '1',
  new_tool_dispatches: '0', tool_results_prepared: '0', reused_results: '0', last_request_id: '00000000-0000-4000-8000-000000000001', last_upstream_outcome: 'terminal_received' };
function suppliedLegacy() {
  const length = text => String(Buffer.byteLength(text));
  return page({ snapshot_head: '9', session: session('9', { title: TITLE }),
    block: block({ revision: '9', state: 'completed', result_recorded: true, outcome: { type: 'completed' }, summary: { ...summary }, events_complete: true,
      human: human({ fields: [field({ field_id: 'text', order_key: '0', generation: '2', text: TASKS[0], total_bytes: length(TASKS[0]), to_byte: length(TASKS[0]) })] }) }),
    entries: [entry({ entry_id: 'e:5:0', position: { sequence: '5', slot: '0' }, revision: '6', content_epoch: '6', recorded_state: 'completed', provisional: false,
      fields: [field({ generation: '6', text: ANSWER, total_bytes: length(ANSWER), to_byte: length(ANSWER) })] })],
    previous_block: null, earlier_activity: null, live_after: cursor('l', '9', '3', '', '') });
}
const rejection = () => ({ api_version: 1, code: 'invalid_request', stage: 'history', certainty: 'not_applicable', acceptance: null, notices: [] });
const plain = value => JSON.parse(JSON.stringify(value));
const blank = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false,
  body_bounded: false, decoded: false, validated: false, exact: false });
async function exercise({ index = 1, option = 'valid', laterFailure = false, closeFailure = false, stopFailure = false, prior } = {}) {
  let getter, failure, acquired = 0;
  const output = [], calls = [], beforeBody = [];
  const env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const cause = new TypeError(PRIVATE);
  cause.stack = `${PRIVATE}\n at task-unbound-history.spec.mjs:789:4\n${PRIVATE}`;
  const getFacts = n => getter().observed[n === 0 ? 'latest' : 'task'];
  const ownedPage = {
    waitForResponse: async predicate => {
      const n = acquired++, variant = n === index ? option : 'valid';
      const response = { url: () => `http://127.0.0.1/v1/sessions/${SID}/${n === 0 ? 'conversation' : 'runs'}`,
        request: () => ({ method: () => n === 0 ? 'GET' : 'POST' }) };
      assert.equal(predicate(response), true); calls.push('acquire-' + n);
      if (variant === 'acquisition') throw cause;
      const value = n === 0 ? suppliedLegacy() : rejection();
      if (variant === 'schema') value.api_version = 2;
      if (variant === 'extra') value.private = PRIVATE;
      if (variant === 'code') value.code = 'storage.stale_history';
      if (variant === 'stage') value.stage = 'preflight';
      if (variant === 'certainty') value.certainty = 'unknown';
      if (variant === 'acceptance') value.acceptance = { operation_id: OID, session_id: SID, run_id: OTHER, first_sequence: '10', last_sequence: '11' };
      if (variant === 'notices') value.notices = [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }];
      if (variant === 'title') value.session.title = 'other';
      if (variant === 'workspace') value.session.workspace = '/synthetic/other';
      if (variant === 'result') value.block.result_recorded = false;
      if (variant === 'summary') value.block.summary.new_tool_dispatches = '1';
      if (variant === 'missing') value.entries = [];
      if (variant === 'answer') value.entries[0].fields[0].text = ANSWER.replace('42', '43');
      if (variant === 'extra-entry') value.entries.push({ ...plain(value.entries[0]), entry_id: 'e:6:0', position: { sequence: '6', slot: '0' } });
      if (variant === 'task-text') {
        const f = value.block.human.fields[0]; f.text = TASKS[1]; f.to_byte = f.total_bytes = String(Buffer.byteLength(TASKS[1]));
      }
      Object.assign(response, {
        status: () => variant === 'status' ? 201 : n === 0 ? 200 : 422,
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
    locator: () => ownedPage,
    getByRole: () => ({ click: async () => {} }),
  };
  try {
    await runInNewContext(controlled, {
      process: { env }, console: { log: text => output.push(text) }, URL, Buffer, TextDecoder, decodeJson,
      validateConversationPage, validateErrorView, syntheticSession: SID, syntheticCommand: plain(command), ownedPage,
      ownedContext: { close: async () => { calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw cause; } },
      ownedFixture: { stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw cause; } },
      leaked: raw => raw.includes(PRIVATE), capture: value => { getter = value; }, later: async n => { if (laterFailure && n === 1) throw cause; },
      expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  const diagnostic = [failure?.message ?? '', failure?.stack ?? '', ...output].join('\n');
  for (const secret of [PRIVATE, 'private.invalid', SID, RID, OTHER, OID, TITLE, '/synthetic/project', ...TASKS, ANSWER, EDIT]) assert.equal(diagnostic.includes(secret), false);
  assert.deepEqual(calls.slice(-2), ['browser-close', 'fixture-stop']);
  assert.deepEqual(output, [`Unbound history cleanup: browser=${!closeFailure} fixture=${!stopFailure}`]);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
  return { failure, evidence: plain(getter()), beforeBody, calls };
}
for (const index of [0, 1]) for (const option of ['acquisition', 'body', 'size', 'utf8', 'media', 'json', 'schema', 'extra']) {
  test(`unbound actual ${index === 0 ? 'Latest' : 'Task'} ${option} retains truthful private-safe reply facts`, async () => {
    const result = await exercise({ index, option });
    assert.ok(result.failure);
    const facts = blank(), status = index === 0 ? 200 : 422;
    if (option !== 'acquisition') Object.assign(facts, { acquired: true, status, body_attempted: true });
    if (!['acquisition', 'body'].includes(option)) facts.body_returned = true;
    if (!['acquisition', 'body', 'size'].includes(option)) facts.body_bounded = true;
    if (['schema', 'extra'].includes(option)) facts.decoded = true;
    assert.deepEqual(result.evidence.observed[index === 0 ? 'latest' : 'task'], facts);
    if (index === 0) assert.deepEqual(result.evidence.observed.task, blank());
    if (option !== 'acquisition') assert.deepEqual(result.beforeBody.at(-1), { ...blank(), acquired: true, status, body_attempted: true });
    assert.equal(result.evidence.faults.secret, ['json', 'extra'].includes(option) ? 1 : 0);
  });
}
for (const [index, options] of [[0, ['status', 'keys', 'title', 'workspace', 'result', 'summary', 'missing', 'answer', 'extra-entry', 'task-text']],
  [1, ['status', 'keys', 'code', 'stage', 'certainty', 'acceptance', 'notices']]]) {
  for (const option of options) test(`unbound actual ${index === 0 ? 'Latest' : 'Task'} rejects closed non-exact ${option}`, async () => {
    const result = await exercise({ index, option });
    assert.ok(result.failure);
    assert.deepEqual(result.evidence.observed[index === 0 ? 'latest' : 'task'], { acquired: true, status: option === 'status' ? 201 : index === 0 ? 200 : 422,
      body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: false });
    if (index === 0) assert.deepEqual(result.evidence.observed.task, blank());
  });
}
test('unbound actual reply statements succeed without claiming native or DOM proof', async () => {
  const result = await exercise({ prior: 'prior-guard' });
  assert.equal(result.failure, undefined);
  for (const [index, facts] of Object.values(result.evidence.observed).entries()) assert.deepEqual(facts, { acquired: true, status: index === 0 ? 200 : 422,
    body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: true });
});
for (const failedCleanup of [false, true]) test(`unbound private later failure has priority over cleanup=${failedCleanup}`, async () => {
  const result = await exercise({ laterFailure: true, closeFailure: failedCleanup, stopFailure: failedCleanup, prior: 'prior-guard' });
  assert.ok(result.failure.message.startsWith('Unbound history failed: one explicit Send rejects unbound replay; kind=TypeError line=789;'));
  assert.equal(result.evidence.observed.task.exact, true);
  assert.equal(result.failure.message.includes('cleanup failed'), false);
});
for (const closeFailure of [false, true]) test(`unbound cleanup-only failure is fatal; browser=${closeFailure}`, async () => {
  const result = await exercise({ closeFailure, stopFailure: true });
  assert.equal(result.failure.message, closeFailure ? 'Unbound history browser cleanup failed' : 'Unbound history fixture cleanup failed');
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n = 0; n < 5; n++) await tick(); }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
for (const editBeforeReply of [false, true]) test(`public display controller completed legacy and unique rejected Task retain memory; edit before reply=${editBeforeReply}`, async t => {
  const calls = [], publications = [], waiting = [];
  let next = 0, cancels = 0;
  const client = createDisplayClient({ crypto: { randomUUID: () => [OID, OTHER][next++] }, fetch: async (path, init) => {
    calls.push({ path, init });
    if (path === '/v1/settings') return response({ api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path.startsWith('/v1/sessions?')) return response({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path.endsWith('/conversation')) return response(suppliedLegacy());
    if (path.includes('/conversation/events?')) return new Response(new ReadableStream({ cancel() { cancels++; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (path.endsWith('/runs') && init.method === 'POST') return new Promise(resolve => waiting.push(resolve));
    throw new Error('Unexpected synthetic request');
  } });
  t.after(() => client.disconnect());
  client.subscribe(snapshot => publications.push(snapshot));
  await client.connect('0123456789abcdef'.repeat(4));
  await client.selectSession(SID); await flush();
  const initial = client.snapshot(), legacy = plain(initial.selected.store), supplied = suppliedLegacy();
  assert.equal(initial.selected.observation, 'streaming'); assert.equal(initial.selected.observation_error, null);
  assert.equal(legacy.blocks.length, 1); assert.equal(legacy.blocks[0].entries.length, 1);
  const { human: anchor, ...header } = supplied.block;
  assert.ok(isDeepStrictEqual(legacy.blocks[0].view, header));
  for (const [loaded, dto, text] of [[legacy.blocks[0].human, anchor, TASKS[0]], [legacy.blocks[0].entries[0], supplied.entries[0], ANSWER]]) {
    const { fields, earlier_content, content_complete, ...metadata } = dto;
    assert.ok(isDeepStrictEqual(loaded.view, metadata)); assert.equal(loaded.earlier_content, earlier_content);
    assert.equal(loaded.content_complete, content_complete); assert.equal(loaded.content_start_loaded, true);
    assert.equal(loaded.fields.length, 1);
    assert.ok(isDeepStrictEqual(loaded.fields[0].ranges, [{ from_byte: '0', to_byte: fields[0].to_byte, text }]));
  }
  client.setDraft(TASKS[1]);
  const send = client.sendTask(); await flush();
  const captured = client.snapshot().pending[0];
  assert.equal(captured.phase, 'sending'); assert.equal(client.snapshot().draft, TASKS[1]);
  assert.ok(isDeepStrictEqual(captured.command, { id: OID, kind: 'task', session_id: SID, body: command }));
  assert.equal(Object.isFrozen(captured.command) && Object.isFrozen(captured.command.body), true);
  assert.throws(() => { captured.command.body.text = 'mutated'; }, TypeError);
  assert.equal(waiting.length, 1);
  if (editBeforeReply) client.setDraft(EDIT);
  waiting[0](response(rejection(), 422)); await send; await flush();
  const rejected = client.snapshot().pending[0], { api_version: _version, ...safeError } = rejection();
  assert.equal(rejected.phase, 'rejected'); assert.ok(isDeepStrictEqual(rejected.command, captured.command));
  assert.equal(rejected.receipt, null); assert.equal(rejected.reply, null); assert.deepEqual(rejected.notices, []);
  assert.deepEqual(rejected.error, { category: 'http', status: 422, server: safeError });
  assert.equal(Object.isFrozen(rejected.error) && Object.isFrozen(rejected.error.server), true);
  assert.throws(() => { rejected.error.server.code = 'mutated'; }, TypeError);
  assert.equal(client.snapshot().draft, editBeforeReply ? EDIT : TASKS[1]);
  for (const draft of [EDIT, EDIT]) {
    client.setDraft(draft); await flush();
    const now = client.snapshot();
    assert.ok(now.draft === draft); assert.ok(isDeepStrictEqual(now.pending, [rejected]));
    assert.ok(isDeepStrictEqual(plain(now.selected.store), legacy)); assert.ok(isDeepStrictEqual(now.selected.store.session, supplied.session));
    assert.equal(now.selected.manifest, null);
    assert.equal(now.selected.run_view, null); assert.equal(now.selected.cancel, null); assert.equal(now.selected.observation_error, null);
  }
  // Check outside subscriptions because the controller isolates errors thrown by views.
  assert.equal(publications.some((value, n) => n > 0 && [TASKS[1], EDIT].includes(publications[n - 1].draft) && value.draft === ''), false);
  assert.equal(new Set([SID, command.operation_id, command.run_id]).size, 3);
  assert.ok(isDeepStrictEqual(calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(call.init.body)), [command]));
  assert.deepEqual(calls.filter(call => call.path.includes('/conversation')).map(call => call.path), [`/v1/sessions/${SID}/conversation`, `/v1/sessions/${SID}/conversation/events?after=${encodeURIComponent(supplied.live_after)}`]);
  assert.ok(calls.every(call => !/\/(history|operations)(\/|$)/.test(call.path) && !call.path.endsWith('/events')));
  client.disconnect(); await flush();
  const cleared = client.snapshot();
  assert.equal(cleared.connection, 'disconnected'); assert.equal(cleared.selected, null); assert.equal(cleared.draft, '');
  assert.equal(cleared.settings, null); assert.equal(cleared.catalog, null); assert.deepEqual(cleared.pending, []);
  assert.equal(cancels, 1); assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
});
