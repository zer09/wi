import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, cursor, page, session, block, human, field, batch } from '../test-support/display-fixtures.mjs';

const source = ts.createSourceFile('task-selection-epoch.js', readFileSync(new URL('../e2e/task-selection-epoch.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1], attempt = callback.body.statements.find(ts.isTryStatement), statements = attempt.tryBlock.statements;
const constants = source.statements.filter(node => ts.isVariableStatement(node) && ['TASK', 'ANSWER', 'ARGUMENTS', 'OUTPUT', 'DRAFT'].includes(node.declarationList.declarations[0].name.getText(source)));
assert.equal(constants.length, 5);
const { TASK, DRAFT } = runInNewContext(`${constants.map(node => node.getText(source)).join('\n')}\n({TASK,DRAFT})`);
const helper = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'readReply');
const latest = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'openSession');
const guard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
const loop = statements.find(ts.isForStatement);
const creation = loop.statement.statements.find(node => node.getText(source).startsWith('const [reply] = await Promise.all('));
const taskReply = statements.find(node => node.getText(source).startsWith('const acceptedReply = readReply('));
const pause = statements.find(node => node.getText(source).startsWith('expect(await hold.wait())'));
const release = statements.find(node => node.getText(source) === 'await hold.stop();');
assert.ok(helper && latest && guard && creation && taskReply && pause && release);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1, callback.body.statements.indexOf(attempt) + 3);
assert.equal(tail[1].getText(source), 'if (failure) throw failure;');
const declarations = callback.body.statements.filter(ts.isVariableStatement);
// Execute the actual authored validator checks, delay milestones and strict cleanup.
const controlled = `(async () => {
  ${constants.map(node => node.getText(source)).join('\n')}
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage; hold = ownedHold;
  workspaces = ['/synthetic/a','/synthetic/b']; creates.push(syntheticCreate); submitted = syntheticTask;
  const a = syntheticSession, slot = 0;
  ${helper.getText(source)}
  ${latest.getText(source)}
  const originalReadReply = readReply;
  readReply = async (...args) => {
    try { return await originalReadReply(...args); }
    catch (cause) { identity(cause === suppliedCause); throw cause; }
  };
  ${guard.getText(source)}
  capture(() => ({observed,delay,cleanup,faults}));
  try {
    stage = 'Create response'; ${creation.getText(source)}
    if (latestFirst) { stage = 'Latest response'; await openSession(0,a,'1'); }
    stage = 'held Task response'; ${taskReply.getText(source)}
    void acceptedReply.catch(() => {});
    delay.armed = true;
    ${pause.getText(source)} delay.paused = true;
    stage = 'release after selected B draft'; ${release.getText(source)} delay.released = true; cleanup.interceptor = true;
    await acceptedReply;
    if (!latestFirst) { stage = 'Latest response'; await openSession(0,a,'1'); }
    await later();
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail.map(node => node.getText(source)).join('\n')}
})()`;
const titles = JSON.parse(readFileSync(new URL('../test-support/mutations.json', import.meta.url))).titles;
const PRIVATE = 'synthetic-private-response-cause https://private.invalid/?token=synthetic';
const createCommand = { operation_id: OID, title: titles[0], workspace: '/synthetic/a' };
const taskCommand = { operation_id: OID, run_id: RID, text: TASK };
const acceptance = () => ({ api_version: 1, receipt: { operation_id: OID, session_id: SID, run_id: RID, first_sequence: '2', last_sequence: '3' }, duplicate: false, warning_code: null, notices: [] });
const createReply = () => ({ api_version: 1, session_id: SID, receipt: { operation_id: OID, session_id: SID, run_id: null, first_sequence: '1', last_sequence: '1' }, duplicate: false, warning_code: null });
const blank = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false, body_rejected: false, body_rejection_class: null, body_bounded: false, decoded: false, validated: false, exact: false });
const plain = value => JSON.parse(JSON.stringify(value));
async function exercise({ index = 1, option = 'valid', latestFirst = false, rejection = 'other', pauseFailure = false, releaseFailure = false, laterFailure = false, closeFailure = false, stopFailure = false, prior } = {}) {
  let getter, failure, acquired = 0, resolveTask, stopped = false, sameCause = false;
  const bodyCalls = [0,0,0];
  const calls = [], output = [], beforeBody = [], env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const messages = {
    method: 'Network.getResponseBody', closed: 'Target page, context or browser has been closed',
    crashed: 'Target crashed', timeout: 'Timeout 123ms exceeded', other: 'unknown',
    precedence_method: 'Network.getResponseBody Target page, context or browser has been closed Target crashed Timeout 1ms exceeded',
    precedence_closed: 'Target page, context or browser has been closed Target crashed Timeout 1ms exceeded',
    precedence_crashed: 'Target crashed Timeout 1ms exceeded', timeout_name: 'unknown',
  };
  const cause = new TypeError(`${messages[rejection] ?? ''} ${PRIVATE}`);
  if (rejection === 'absent') delete cause.message;
  if (rejection === 'nonstring') cause.message = null;
  if (rejection === 'timeout_name' || rejection.startsWith('precedence_')) cause.name = 'TimeoutError';
  cause.stack = `TypeError: ${PRIVATE}\n    at task-selection-epoch.spec.mjs:52:4`;
  const ownedPage = {
    waitForResponse: async predicate => {
      const order = latestFirst ? [0,2,1] : [0,1,2];
      const n = order[acquired++], variant = n === index ? option : 'valid';
      const response = { url: () => `http://127.0.0.1/v1/sessions${n === 0 ? '' : '/' + SID + (n === 1 ? '/runs' : '/conversation')}`, request: () => ({ method: () => n === 2 ? 'GET' : 'POST' }) };
      assert.equal(predicate(response), true);
      if (n === 1) await new Promise(resolve => { resolveTask = resolve; });
      if (variant === 'acquisition') throw cause;
      const value = n === 0 ? createReply() : n === 1 ? acceptance() : empty(SID);
      if (variant === 'schema') value.api_version = 2;
      if (variant === 'extra') value.private = PRIVATE;
      if (variant === 'identity') { if (n === 2) value.session.session_id = OTHER; else value.receipt.operation_id = OTHER; }
      if (variant === 'range') value.receipt.last_sequence = n === 0 ? '2' : '4';
      if (variant === 'duplicate') value.duplicate = true;
      if (variant === 'warning') value.warning_code = 'storage.connection_cleanup_failed';
      if (variant === 'notices') value.notices = [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }];
      if (variant === 'head') { value.snapshot_head = '2'; value.session.head_sequence = '2'; value.live_after = cursor('l', '2', '3', '', ''); }
      if (variant === 'title') value.session.title = 'Wrong title';
      if (variant === 'workspace') value.session.workspace = '/synthetic/b';
      if (variant === 'public_hex') value.session.title = 'a'.repeat(64);
      Object.assign(response, {
        status: () => variant === 'status' ? (n === 2 ? 203 : 200) : [201,202,200][n],
        headers: () => ({ 'content-type': variant === 'media' ? 'text/plain' : 'application/json; charset=utf-8' }),
        body: async () => {
          bodyCalls[n]++;
          beforeBody.push(plain(n === 0 ? getter().observed.creates[0] : n === 1 ? getter().observed.task : getter().observed.latest[0]));
          if (variant === 'body') throw cause;
          if (variant === 'size') return Buffer.alloc(n === 2 ? 524289 : 4097, 32);
          if (variant === 'utf8') return Buffer.from([255]);
          if (variant === 'json') return Buffer.from(`{"private":"${PRIVATE}",`);
          const text = JSON.stringify(value);
          return Buffer.from(variant === 'keys' ? text.replace('{', '{"api_version":1,') : text);
        },
      });
      return response;
    },
    getByRole: () => ({ click: async () => {} }),
  };
  const ownedHold = {
    wait: async () => { calls.push('pause'); if (pauseFailure) throw cause; assert.equal(getter().observed.task.acquired, false); return 202; },
    stop: async () => {
      calls.push('interceptor-stop');
      if (releaseFailure) throw cause;
      if (!stopped) { stopped = true; resolveTask?.(); }
    },
  };
  try {
    await runInNewContext(controlled, {
      process: { env }, console: { log: text => output.push(text) }, URL, Buffer, TextDecoder, decodeJson, validateCreateView, validateDisplayTaskAccepted, validateConversationPage,
      latestFirst, suppliedCause: cause, identity: value => { sameCause = value; },
      sessionButton: () => ({click:async () => {}}), status: {}, exact: async () => {},
      titles, syntheticCreate: plain(createCommand), syntheticTask: plain(taskCommand), syntheticSession: SID,
      ownedPage, ownedHold, markers: [PRIVATE], ownedFixture: { origin: 'http://127.0.0.1', owner: 'synthetic-owner', stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw cause; } },
      ownedContext: { close: async () => { calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw cause; } },
      capture: value => { getter = value; }, later: async () => { if (laterFailure) throw cause; },
      expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  for (const text of [PRIVATE, 'private.invalid', SID, RID, OID, OTHER, TASK, DRAFT, ...titles, '/synthetic/a']) {
    assert.equal([failure?.message ?? '', failure?.stack ?? '', ...output].join('\n').includes(text), false);
  }
  assert.deepEqual(calls.slice(-3), ['interceptor-stop', 'browser-close', 'fixture-stop']);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
  assert.deepEqual(output, [`Selection epoch cleanup: interceptor=${!releaseFailure} browser=${!closeFailure} fixture=${!stopFailure}`]);
  return { failure, evidence: plain(getter()), beforeBody, bodyCalls, sameCause };
}
for (const index of [0, 1, 2]) for (const option of ['acquisition', 'body', 'size', 'utf8', 'media', 'json', 'schema', 'extra', 'identity']) {
  test(`selection actual ${['Create','Task','Latest'][index]} ${option} preserves private-safe response milestones`, async () => {
    const result = await exercise({ index, option });
    assert.ok(result.failure);
    const facts = blank();
    if (option !== 'acquisition') Object.assign(facts, { acquired: true, status: [201,202,200][index], body_attempted: true });
    if (option === 'body') Object.assign(facts, {body_rejected:true,body_rejection_class:'other'});
    if (!['acquisition', 'body'].includes(option)) facts.body_returned = true;
    if (!['acquisition', 'body', 'size'].includes(option)) facts.body_bounded = true;
    if (['schema', 'extra', 'identity'].includes(option)) facts.decoded = true;
    // Create validates its metadata receipt, then our exact check binds the operation.
    if (index === 0 && option === 'identity') facts.validated = true;
    assert.deepEqual(index === 0 ? result.evidence.observed.creates[0] : index === 1 ? result.evidence.observed.task : result.evidence.observed.latest[0], facts);
    assert.equal(result.bodyCalls[index], option === 'acquisition' ? 0 : 1);
    if (['acquisition','body'].includes(option)) assert.equal(result.sameCause, true);
    if (index === 0) assert.deepEqual(result.evidence.observed.task, blank());
    assert.equal(result.evidence.faults.private, ['json', 'extra'].includes(option) ? 1 : 0);
  });
}
for (const [index, options] of [[0, ['status', 'keys', 'range', 'duplicate', 'warning']], [1, ['status', 'keys', 'range', 'duplicate', 'warning', 'notices']], [2, ['status', 'keys', 'head', 'title', 'workspace']]]) {
  for (const option of options) test(`selection actual ${['Create','Task','Latest'][index]} rejects non-exact ${option}`, async () => {
    const result = await exercise({ index, option }); assert.ok(result.failure);
    const facts = index === 0 ? result.evidence.observed.creates[0] : index === 1 ? result.evidence.observed.task : result.evidence.observed.latest[0];
    assert.deepEqual(facts, { acquired: true, status: option === 'status' ? (index === 2 ? 203 : 200) : [201,202,200][index],
      body_attempted: true, body_returned: true, body_rejected: false, body_rejection_class: null, body_bounded: true, decoded: true,
      validated: !(index === 0 && option === 'range'), exact: false });
  });
}
test('selection actual held response statements succeed without claiming native or DOM proof', async () => {
  const result = await exercise({ prior: 'previous-guard' }); assert.equal(result.failure, undefined);
  assert.equal(result.evidence.observed.creates[0].exact && result.evidence.observed.task.exact && result.evidence.observed.latest[0].exact, true);
  assert.deepEqual(result.bodyCalls, [1,1,1]);
  assert.deepEqual(result.evidence.delay, { armed: true, paused: true, released: true });
  for (const [index, facts] of result.beforeBody.entries()) assert.deepEqual(facts, { ...blank(), acquired: true, status: [201,202,200][index], body_attempted: true });
});
for (const mode of ['pauseFailure', 'releaseFailure', 'laterFailure']) test(`selection actual ${mode} keeps first failure through strict cleanup`, async () => {
  const result = await exercise({ [mode]: true, closeFailure: true, stopFailure: true });
  assert.ok(result.failure.message.startsWith('Selection epoch failed:'));
  assert.equal(result.failure.message.includes('cleanup failed'), false);
  assert.equal(result.evidence.delay.paused, mode !== 'pauseFailure');
  assert.equal(result.evidence.delay.released, mode === 'laterFailure');
});
for (const closeFailure of [false, true]) test(`selection cleanup-only failure is fatal; browser=${closeFailure}`, async () => {
  const result = await exercise({ closeFailure, stopFailure: true });
  assert.equal(result.failure.message, closeFailure ? 'Selection epoch browser cleanup failed' : 'Selection epoch fixture cleanup failed');
});

for (const [rejection, category] of [['method','method_get_response_body'],['closed','target_closed'],['crashed','target_crashed'],
  ['timeout','timeout'],['timeout_name','timeout'],['other','other'],['absent','other'],['nonstring','other'],
  ['precedence_method','method_get_response_body'],['precedence_closed','target_closed'],['precedence_crashed','target_crashed']]) {
  test(`selection actual Latest body rejection is finite and preserves identity; control=${rejection}`, async () => {
    const result = await exercise({index:2,option:'body',latestFirst:true,rejection});
    assert.equal(result.sameCause, true); assert.deepEqual(result.bodyCalls, [1,0,1]);
    assert.deepEqual(result.evidence.observed.latest[0], {...blank(),acquired:true,status:200,body_attempted:true,body_rejected:true,body_rejection_class:category});
    assert.deepEqual(result.evidence.observed.task, blank());
    assert.deepEqual(result.evidence.delay, {armed:false,paused:false,released:false});
    assert.equal(result.failure.message.includes('line=52;'), true);
  });
}
test('selection actual positive Latest permits public hex without weakening private marker checks', async () => {
  const result = await exercise({index:2,option:'public_hex'});
  assert.equal(result.evidence.faults.private, 0); assert.equal(result.evidence.observed.latest[0].validated, true);
  assert.equal(result.evidence.observed.latest[0].exact, false); assert.equal(result.evidence.observed.latest[0].body_rejected, false);
  const positive = await exercise({latestFirst:true}); assert.equal(positive.failure, undefined);
  assert.equal(positive.evidence.observed.latest[0].exact, true); assert.deepEqual(positive.bodyCalls, [1,1,1]);
});
test('selection actual helper catches only its one body call and rethrows the original cause', () => {
  const text = helper.getText(source), nodes = [];
  function visit(node) { nodes.push(node); ts.forEachChild(node,visit); }
  visit(helper);
  assert.equal(nodes.filter(node => ts.isCallExpression(node) && node.expression.getText(source) === 'response.body').length, 1);
  const narrow = nodes.filter(ts.isTryStatement); assert.equal(narrow.length, 1);
  assert.equal(narrow[0].tryBlock.statements.length, 1);
  assert.equal(narrow[0].tryBlock.statements[0].getText(source), 'bytes = await response.body();');
  assert.equal(narrow[0].catchClause.block.statements.at(-1).getText(source), 'throw cause;');
  assert.equal(text.includes('/Network\\.getResponseBody/.test(message)'), true);
  assert.equal(latest.getText(source).includes('validateConversationPage(value'), true);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n = 0; n < 5; n++) await tick(); }
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function empty(sid) {
  return page({ session_id: sid, snapshot_head: '1', session: session('1', { session_id: sid, title: sid === SID ? titles[0] : titles[1], workspace: sid === SID ? '/synthetic/a' : '/synthetic/b' }),
    block: null, entries: [], previous_block: null, live_after: 'g11l.' + Buffer.from(JSON.stringify([1, sid, '1', '3', '', ''])).toString('base64url') });
}
function running() {
  return block({ revision: '6', state: 'running', human: human({ fields: [field({ field_id: 'text', order_key: '0', generation: '2', text: TASK, total_bytes: String(Buffer.byteLength(TASK)), to_byte: String(Buffer.byteLength(TASK)) })] }) });
}
for (const stale of ['reader', 'response']) test(`public display selection lifetime preserves delayed A command and ignores stale A ${stale}`, async t => {
  const calls = [], publications = [], streams = [];
  let next = 0, deliver, lateStream, complete = false;
  const client = createDisplayClient({ crypto: { randomUUID: () => [OID, RID][next++] }, fetch: async (path, init) => {
    calls.push({ path, init });
    if (path === '/v1/settings') return reply({ api_version: 1, workspaces: ['/synthetic/a', '/synthetic/b'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
    if (path.startsWith('/v1/sessions?')) return reply({ api_version: 1, entries: [], next_after_id: null, has_more: false });
    if (path.endsWith('/conversation')) {
      const sid = path.split('/')[3];
      if (!complete || sid !== SID) return reply(empty(sid));
      return reply(page({ snapshot_head: '20', session: session('20', { title: titles[0], workspace: '/synthetic/a' }),
        block: { ...running(), revision: '20', state: 'completed', result_recorded: true, outcome: { type: 'completed' }, events_complete: true },
        entries: [], previous_block: null, live_after: cursor('l', '20', '3', '', '') }));
    }
    if (path.includes('/conversation/events?')) {
      let controller, cancels = 0;
      const body = new ReadableStream({ start(c) { controller = c; }, cancel() { cancels++; } });
      const stream = { init, push: value => controller.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`)),
        get cancels() { return cancels; }, response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }) };
      streams.push(stream);
      if (streams.length === 1 && stale === 'response') return new Promise(resolve => { lateStream = () => resolve(stream.response); });
      return stream.response;
    }
    if (path === `/v1/sessions/${SID}/runs` && init.method === 'POST') return new Promise(resolve => { deliver = resolve; });
    throw new Error('Unexpected synthetic request');
  } });
  t.after(() => client.disconnect());
  client.subscribe(value => publications.push(value));
  await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(SID); await flush();
  client.setDraft(TASK); const sending = client.sendTask(); await flush();
  const captured = client.snapshot().pending[0];
  assert.equal(captured.phase, 'sending'); assert.equal(captured.receipt, null); assert.equal(captured.reply, null);
  assert.ok(isDeepStrictEqual(captured.command, { id: OID, kind: 'task', session_id: SID, body: taskCommand }));
  assert.equal(Object.isFrozen(captured.command) && Object.isFrozen(captured.command.body), true);
  assert.throws(() => { captured.command.body.text = 'mutated'; }, TypeError);
  const mutation = calls.find(call => call.init.method === 'POST');
  if (stale === 'reader') {
    streams[0].push(batch([{ kind: 'block.upsert', block: running() }], '6')); await flush();
    assert.equal(client.snapshot().selected.store.observed_head, '6');
    assert.equal(client.snapshot().selected.store.blocks[0].view.state, 'running');
    assert.equal(client.snapshot().pending[0].phase, 'sending'); assert.equal(client.snapshot().draft, TASK);
    // Queue an actual reader result, then switch before its continuation can apply it.
    streams[0].push(batch([{ kind: 'block.upsert', block: { ...running(), revision: '7', state: 'failed' } }], '7'));
  }
  await client.selectSession(OTHER); client.setDraft(DRAFT); await flush();
  assert.equal(streams[0].init.signal.aborted, true); assert.equal(mutation.init.signal.aborted, false);
  const before = client.snapshot(), savedB = plain(before.selected), count = publications.length;
  assert.equal(before.pending[0].phase, 'sending'); assert.ok(isDeepStrictEqual(before.pending[0].command, captured.command));
  assert.equal(before.selected.store.blocks.length, 0); assert.equal(before.selected.store.observed_head, '1');
  if (stale === 'response') { streams[0].push(batch([{ kind: 'block.upsert', block: running() }], '6')); lateStream(); }
  await flush(); assert.ok(isDeepStrictEqual(client.snapshot(), before)); assert.equal(publications.length, count);
  assert.equal(streams[0].cancels, 1);
  deliver(reply(acceptance(), 202)); await sending; await flush();
  const accepted = client.snapshot().pending[0];
  assert.equal(accepted.phase, 'accepted'); assert.ok(isDeepStrictEqual(accepted.command, captured.command));
  assert.ok(isDeepStrictEqual(accepted.receipt, acceptance().receipt)); assert.ok(isDeepStrictEqual(accepted.reply, acceptance()));
  assert.equal(Object.isFrozen(accepted.reply) && Object.isFrozen(accepted.receipt), true);
  assert.equal(accepted.error, null); assert.deepEqual(accepted.notices, []);
  assert.equal(client.snapshot().draft, DRAFT); assert.ok(isDeepStrictEqual(plain(client.snapshot().selected), savedB));
  assert.equal(mutation.init.signal.aborted, false);
  complete = true; await client.selectSession(SID); await flush();
  assert.equal(client.snapshot().draft, ''); assert.equal(client.snapshot().selected.store.observed_head, '20');
  assert.equal(client.snapshot().selected.store.blocks[0].view.state, 'completed');
  assert.ok(isDeepStrictEqual(client.snapshot().pending, [accepted]));
  await client.selectSession(OTHER); await flush();
  assert.equal(client.snapshot().selected.store.observed_head, '1'); assert.equal(client.snapshot().selected.store.blocks.length, 0);
  assert.equal(client.snapshot().selected.run_view, null); assert.equal(client.snapshot().selected.cancel, null);
  assert.ok(isDeepStrictEqual(client.snapshot().pending, [accepted]));
  const expectedPages = [empty(SID), empty(OTHER), { ...empty(SID), live_after: cursor('l', '20', '3', '', '') }, empty(OTHER)];
  assert.deepEqual(calls.filter(call => call.path.includes('/conversation')).map(call => call.path), expectedPages.flatMap(value => [
    `/v1/sessions/${value.session_id}/conversation`, `/v1/sessions/${value.session_id}/conversation/events?after=${encodeURIComponent(value.live_after)}`]));
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(mutation.init.body === JSON.stringify(taskCommand), true);
  assert.equal(publications.some(value => value.selected?.session_id === OTHER && value.draft === '' && value.pending[0]?.phase === 'accepted'), true);
  assert.equal(publications.some(value => value.selected?.session_id === OTHER && value.pending[0]?.phase === 'accepted' && value.selected.store?.observed_head === '6'), false);
  client.disconnect(); await flush();
  const cleared = client.snapshot();
  assert.equal(cleared.connection, 'disconnected'); assert.equal(cleared.selected, null); assert.equal(cleared.draft, '');
  assert.equal(cleared.catalog, null); assert.equal(cleared.settings, null); assert.deepEqual(cleared.pending, []);
  assert.equal(streams.every(stream => stream.cancels === 1 && stream.init.signal.aborted), true);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
});
