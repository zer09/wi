import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, cursor, page, session, block, human, field, batch } from '../test-support/display-fixtures.mjs';

const source = ts.createSourceFile('task-disconnect-epoch.js', readFileSync(new URL('../e2e/task-disconnect-epoch.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1], attempt = callback.body.statements.find(ts.isTryStatement), statements = attempt.tryBlock.statements;
const constants = source.statements.filter(node => ts.isVariableStatement(node) && ['TASK', 'ANSWER', 'ARGUMENTS', 'OUTPUT', 'DRAFT'].includes(node.declarationList.declarations[0].name.getText(source)));
assert.equal(constants.length, 5);
const { TASK, DRAFT } = runInNewContext(`${constants.map(node => node.getText(source)).join('\n')}\n({TASK,DRAFT})`);
const helper = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'readReply');
const latest = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'latestReply');
const facts = callback.body.statements.find(ts.isFunctionDeclaration);
const guard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
const creation = statements.find(node => node.getText(source).startsWith('const [createdReply] = await Promise.all('));
const taskReply = statements.find(node => node.getText(source).startsWith('const [acceptedReply] = await Promise.all('));
assert.ok(helper && latest && facts && guard && creation && taskReply);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1, callback.body.statements.indexOf(attempt) + 3);
assert.equal(tail[1].getText(source), 'if (failure) throw failure;');
const declarations = callback.body.statements.filter(ts.isVariableStatement);
// Exercise the actual safe reply checks and cleanup, not a copied diagnostic implementation.
const controlled = `(async () => {
  ${constants.map(node => node.getText(source)).join('\n')}
  ${facts.getText(source)}
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  workspace = '/synthetic/a'; creation = syntheticCreate; submitted = syntheticTask;
  const a = syntheticSession;
  ${helper.getText(source)}
  ${latest.getText(source)}
  ${guard.getText(source)}
  capture(() => ({observed,cleanup,faults,network}));
  try {
    stage = 'Create response'; ${creation.getText(source)}
    stage = 'Task response'; ${taskReply.getText(source)}
    stage = 'Latest response'; await latestReply(a,'1');
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
const blank = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false, body_bounded: false, decoded: false, validated: false, exact: false });
const plain = value => JSON.parse(JSON.stringify(value));
function empty() {
  return page({ snapshot_head: '1', session: session('1', { title: titles[0], workspace: '/synthetic/a' }),
    block: null, entries: [], previous_block: null, live_after: cursor('l', '1', '3', '', '') });
}
async function exercise({ index = 1, option = 'valid', laterFailure = false, closeFailure = false, stopFailure = false, prior } = {}) {
  let getter, failure, acquired = 0;
  const calls = [], output = [], beforeBody = [], env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const cause = new TypeError(PRIVATE);
  const ownedPage = {
    waitForResponse: async predicate => {
      const n = acquired++, variant = n === index ? option : 'valid';
      const response = { url: () => `http://127.0.0.1/v1/sessions${n === 0 ? '' : '/' + SID + (n === 1 ? '/runs' : '/conversation')}`, request: () => ({ method: () => n === 2 ? 'GET' : 'POST' }) };
      assert.equal(predicate(response), true);
      if (variant === 'acquisition') throw cause;
      const value = n === 0 ? createReply() : n === 1 ? acceptance() : empty();
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
      Object.assign(response, {
        status: () => variant === 'status' ? 203 : n === 0 ? 201 : n === 1 ? 202 : 200,
        headers: () => ({ 'content-type': variant === 'media' ? 'text/plain' : 'application/json; charset=utf-8' }),
        body: async () => {
          beforeBody.push(plain(n === 0 ? getter().observed.create : n === 1 ? getter().observed.task : getter().observed.latest[0]));
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
  try {
    await runInNewContext(controlled, {
      process: { env }, console: { log: text => output.push(text) }, URL, Buffer, TextDecoder, decodeJson, validateCreateView, validateDisplayTaskAccepted, validateConversationPage,
      titles, syntheticCreate: plain(createCommand), syntheticTask: plain(taskCommand), syntheticSession: SID,
      ownedPage, markers: [PRIVATE], ownedFixture: { origin: 'http://127.0.0.1', owner: 'synthetic-owner', stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw cause; } },
      ownedContext: { close: async () => { calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw cause; } },
      capture: value => { getter = value; }, later: async () => { if (laterFailure) throw cause; },
      expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  for (const text of [PRIVATE, 'private.invalid', SID, RID, OID, OTHER, TASK, DRAFT, ...titles, '/synthetic/a']) {
    assert.equal([failure?.message ?? '', failure?.stack ?? '', ...output].join('\n').includes(text), false);
  }
  assert.deepEqual(calls, ['browser-close', 'fixture-stop']);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
  assert.deepEqual(output, [`Disconnect epoch cleanup: browser=${!closeFailure} fixture=${!stopFailure}`]);
  return { failure, evidence: plain(getter()), beforeBody };
}
for (const index of [0, 1, 2]) for (const option of ['acquisition', 'body', 'size', 'utf8', 'media', 'json', 'schema', 'extra', 'identity']) {
  test(`disconnect actual ${['Create', 'Task', 'Latest'][index]} ${option} preserves private-safe response milestones`, async () => {
    const result = await exercise({ index, option }); assert.ok(result.failure);
    const facts = blank();
    if (option !== 'acquisition') Object.assign(facts, { acquired: true, status: [201, 202, 200][index], body_attempted: true });
    if (!['acquisition', 'body'].includes(option)) facts.body_returned = true;
    if (!['acquisition', 'body', 'size'].includes(option)) facts.body_bounded = true;
    if (['schema', 'extra', 'identity'].includes(option)) facts.decoded = true;
    if (index === 0 && option === 'identity') facts.validated = true;
    assert.deepEqual(index === 0 ? result.evidence.observed.create : index === 1 ? result.evidence.observed.task : result.evidence.observed.latest[0], facts);
    assert.equal(result.evidence.faults.private, ['json', 'extra'].includes(option) ? 1 : 0);
  });
}
for (const [index, options] of [[0, ['status', 'keys', 'range', 'duplicate', 'warning']], [1, ['status', 'keys', 'range', 'duplicate', 'warning', 'notices']], [2, ['status', 'keys', 'head', 'title', 'workspace']]]) {
  for (const option of options) test(`disconnect actual ${['Create', 'Task', 'Latest'][index]} rejects non-exact ${option}`, async () => {
    const result = await exercise({ index, option }); assert.ok(result.failure);
    const facts = index === 0 ? result.evidence.observed.create : index === 1 ? result.evidence.observed.task : result.evidence.observed.latest[0];
    assert.deepEqual(facts, { acquired: true, status: option === 'status' ? 203 : [201, 202, 200][index],
      body_attempted: true, body_returned: true, body_bounded: true, decoded: true,
      validated: !(index === 0 && option === 'range'), exact: false });
  });
}
test('disconnect actual reply statements succeed without claiming native or DOM proof', async () => {
  const result = await exercise({ prior: 'previous-guard' }); assert.equal(result.failure, undefined);
  assert.equal([result.evidence.observed.create, result.evidence.observed.task, ...result.evidence.observed.latest].every(f => f.exact), true);
  for (const [index, facts] of result.beforeBody.entries()) assert.deepEqual(facts, { ...blank(), acquired: true, status: [201, 202, 200][index], body_attempted: true });
});
test('disconnect actual first failure survives both strict cleanup failures', async () => {
  const result = await exercise({ laterFailure: true, closeFailure: true, stopFailure: true });
  assert.ok(result.failure.message.startsWith('Disconnect epoch failed: Latest response;'));
  assert.equal(result.failure.message.includes('cleanup failed'), false);
});
for (const closeFailure of [false, true]) test(`disconnect cleanup-only failure is fatal; browser=${closeFailure}`, async () => {
  const result = await exercise({ closeFailure, stopFailure: true });
  assert.equal(result.failure.message, closeFailure ? 'Disconnect epoch browser cleanup failed' : 'Disconnect epoch fixture cleanup failed');
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n = 0; n < 5; n++) await tick(); }
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function running() {
  return block({ revision: '6', state: 'running', human: human({ fields: [field({ field_id: 'text', order_key: '0', generation: '2', text: TASK, total_bytes: String(Buffer.byteLength(TASK)), to_byte: String(Buffer.byteLength(TASK)) })] }) });
}
function completed() {
  return page({ snapshot_head: '20', session: session('20', { title: titles[0], workspace: '/synthetic/a' }),
    block: { ...running(), revision: '20', state: 'completed', result_recorded: true, outcome: { type: 'completed' }, events_complete: true },
    entries: [], previous_block: null, live_after: cursor('l', '20', '3', '', '') });
}
for (const stale of ['reader', 'response']) for (const timing of ['disconnected', 'fresh Connect']) for (const taskPoint of ['fetch', 'decoded']) {
  test(`public display Disconnect ignores old ${taskPoint} Task202 and ${stale} while ${timing}`, async t => {
    const calls = [], publications = [], streams = [];
    let next = 0, deliver, lateStream, fresh = false, connecting, transitioned = false;
    let readBytes = 0, unlockedDiscards = 0;
    const client = createDisplayClient({ crypto: { randomUUID: () => [OID, RID][next++] }, fetch: async (path, init) => {
      calls.push({ path, init });
      if (path === '/v1/settings') return reply({ api_version: 1, workspaces: ['/synthetic/a'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
      if (path.startsWith('/v1/sessions?')) return reply({ api_version: 1, entries: [], next_after_id: null, has_more: false });
      if (path.endsWith('/conversation')) return reply(fresh ? completed() : empty());
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
    const unsubscribe = client.subscribe(value => publications.push(value));
    t.after(async () => { unsubscribe(); client.disconnect(); await flush(); });
    await client.connect('0123456789abcdef'.repeat(4)); await client.selectSession(SID); await flush();
    client.setDraft(TASK); const sending = client.sendTask(); await flush();
    const captured = client.snapshot().pending[0], mutation = calls.find(call => call.init.method === 'POST');
    assert.deepEqual(captured.command, { id: OID, kind: 'task', session_id: SID, body: taskCommand });
    assert.equal(captured.phase, 'sending'); assert.equal(captured.receipt, null); assert.equal(captured.reply, null);
    assert.equal(Object.isFrozen(captured.command) && Object.isFrozen(captured.command.body), true);
    assert.throws(() => { captured.command.body.text = 'mutated'; }, TypeError);
    if (stale === 'reader') {
      streams[0].push(batch([{ kind: 'block.upsert', block: running() }], '6')); await flush();
      assert.equal(client.snapshot().selected.store.observed_head, '6');
      assert.equal(client.snapshot().selected.store.blocks[0].view.state, 'running');
    }
    client.setDraft(DRAFT);
    function disconnect() {
      if (stale === 'reader') streams[0].push(batch([{ kind: 'block.upsert', block: { ...running(), revision: '7', state: 'failed' } }], '7'));
      client.disconnect(); transitioned = true;
      assert.equal(mutation.init.signal.aborted, true); assert.equal(streams[0].init.signal.aborted, true);
      assert.deepEqual(client.snapshot(), { connection: 'disconnected', settings: null, catalog: null, catalog_loading: false,
        error: null, draft: '', pending: [], selected: null });
    }
    async function reconnect() {
      fresh = true; await client.connect('fedcba9876543210'.repeat(4)); await client.selectSession(SID); await flush();
      client.setDraft(DRAFT);
      const state = client.snapshot();
      assert.equal(state.connection, 'connected'); assert.equal(state.selected.observation, 'streaming');
      assert.equal(state.selected.store.observed_head, '20'); assert.equal(state.selected.store.live_after, completed().live_after);
      assert.equal(state.selected.store.blocks[0].view.state, 'completed'); assert.equal(state.selected.store.blocks[0].view.result_recorded, true);
      assert.deepEqual(state.pending, []); assert.equal(state.draft, DRAFT);
    }
    if (taskPoint === 'fetch') {
      disconnect(); await flush();
      if (timing === 'fresh Connect') await reconnect();
    } else {
      // A supplied body retires after real closed decoding, before execute checks its connection stamp.
      // This proves ignored state, not the retired raw unconsumed-response optimization.
      const bytes = new TextEncoder().encode(JSON.stringify(acceptance()));
      let locked = true, reads = 0;
      deliver({ status: 202, headers: new Headers({ 'Content-Type': 'application/json' }), body: {
        getReader: () => ({ read: async () => {
          if (reads++ === 0) { readBytes += bytes.length; return { value: bytes, done: false }; }
          return { value: undefined, done: true };
        }, cancel: async () => {}, releaseLock: () => { locked = false; } }),
        cancel: async () => {
          assert.equal(locked, false); unlockedDiscards++;
          disconnect();
          if (timing === 'fresh Connect') connecting = reconnect();
        },
      } });
      await sending; await connecting; await flush();
      assert.equal(readBytes, bytes.length); assert.equal(unlockedDiscards, 1);
    }
    assert.equal(transitioned, true);
    const before = client.snapshot(), count = publications.length;
    if (stale === 'response') { streams[0].push(batch([{ kind: 'block.upsert', block: running() }], '6')); lateStream(); }
    if (taskPoint === 'fetch') deliver(reply(acceptance(), 202));
    await sending; await flush();
    assert.deepEqual(client.snapshot(), before); assert.equal(publications.length, count);
    assert.equal(streams[0].cancels, 1);
    assert.equal(publications.some(value => value.pending.some(item => item.phase === 'accepted')), false);
    assert.equal(publications.some(value => value.selected?.store?.observed_head === '7'), false);
    assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
    assert.equal(mutation.init.body, JSON.stringify(taskCommand));
    assert.equal(next, 2);
    const expectedPages = timing === 'fresh Connect' ? [empty(), completed()] : [empty()];
    assert.deepEqual(calls.filter(call => call.path.includes('/conversation')).map(call => call.path), expectedPages.flatMap(value => [
      `/v1/sessions/${SID}/conversation`, `/v1/sessions/${SID}/conversation/events?after=${encodeURIComponent(value.live_after)}`]));
    assert.equal(calls.length, timing === 'fresh Connect' ? 9 : 5);
    client.disconnect(); await flush();
    assert.equal(streams.every(stream => stream.cancels === 1 && stream.init.signal.aborted), true);
    assert.deepEqual(client.snapshot().pending, []);
  });
}

const routeStatement = statements.find(node => node.getText(source).startsWith("await context.route('**/*'"));
const clickStatement = statements.find(node => node.getText(source).startsWith('await connect.evaluate('));
const requestStatements = statements.filter(node => /^context\.on\('request(?:finished|failed)?',/.test(node.getText(source)));
const classify = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'classifyStarts');
const accounting = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'readAccounting');
assert.ok(routeStatement && clickStatement && classify && accounting);
assert.equal(requestStatements.length, 3);
const documentStatement = statements.find(node => node.getText(source).startsWith('originalDocument = await page.evaluateHandle('));
const rootStatement = statements.find(node => node.getText(source).startsWith('originalRoot = await page.evaluateHandle('));
const finalIndex = statements.findIndex(node => node.getText(source).startsWith("stage = 'final Disconnect"));
const finalSequence = statements.slice(finalIndex, statements.findIndex((node, index) => index > finalIndex
  && node.getText(source).startsWith('expect(Object.values(faults))')) + 1);
const finalDeclaration = finalSequence.find(ts.isVariableStatement);
const finalCapture = finalSequence.find(node => node.getText(source).startsWith('await disconnect.evaluate('));
const providerCheck = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'provider');
const responseStatement = statements.find(node => node.getText(source).startsWith("context.on('response',"));
const assetDeclarations = statements.filter(node => ts.isVariableStatement(node)
  && ['files','assets'].includes(node.declarationList.declarations[0].name.text));
const captureCleanup = attempt.finallyBlock.statements[0];
assert.ok(documentStatement && rootStatement && finalDeclaration && finalCapture && providerCheck && responseStatement);
assert.equal(assetDeclarations.length, 2);
async function timingOracle({ initialNavigation = true } = {}) {
  const handlers = new Map(); let routeHandler, clickHandler, finalHandler, installingFinal = false;
  let now = 10, continued = 0, aborted = 0, release, resolveClick, markParked, currentRoot;
  let clickResolved = false, domChecks = 0, inspections = 0, domHook;
  const parked = new Promise(resolve => { markParked = resolve; });
  const clickCompletion = new Promise(resolve => { resolveClick = resolve; });
  const navigation = [], resources = [], owner = 'synthetic-owner', origin = 'http://127.0.0.1';
  const root = { addEventListener: (name, callback, options) => {
    assert.equal(name, 'click'); assert.deepEqual(plain(options), {capture:true,once:true});
    if (installingFinal) finalHandler = callback; else clickHandler = callback;
  }, evaluate: async callback => callback(root) };
  currentRoot = root;
  const button = { closest: selector => { assert.equal(selector, '#app'); return currentRoot; } };
  const finalButton = { closest: selector => { assert.equal(selector, '#app'); return currentRoot; } };
  const disconnect = {
    evaluate: async (callback, args) => { installingFinal = true; callback(finalButton, args); installingFinal = false; },
    click: async () => { markParked(); await clickCompletion; clickResolved = true; },
  };
  const sandbox = {
    URL, URLSearchParams, process: {env:{}}, leaked: () => false,
    ownedFixture: {origin,owner,inspect:async () => { inspections++; return {
      requests:2,connections:1,auth_loads:1,auth_prepares:1,prepared_exact:2,tool_results:1,terminals:1,results:1,completed:1,
      fresh_empty:true,restored_history:false,fresh_parents:1,continuations:1,provider_failed:false,read_failure:null,accepted:[0],receipts:[0],
    }; }},
    ownedContext: { route: async (_, callback) => { routeHandler = callback; }, on: (name, callback) => { handlers.set(name, callback); } },
    ownedPage: { evaluate: async (callback, args) => callback(args), evaluateHandle: async callback => callback(),
      getByRole: (role, options) => { assert.equal(role, 'button'); assert.deepEqual(plain(options), {name:'Disconnect',exact:true}); return disconnect; } },
    connect: { evaluate: async callback => callback(button) },
    document: { getElementById: () => currentRoot },
    disconnectedTruth: async () => { domChecks++; await domHook?.(); }, a: SID,
    performance: { now: () => now, getEntriesByType: kind => {
      assert.equal(['navigation','resource'].includes(kind), true);
      return kind === 'navigation' ? navigation : resources;
    } },
    expect: actual => ({ toBe: expected => assert.equal(actual, expected),
      toEqual: expected => assert.equal(JSON.stringify(plain(actual)) === JSON.stringify(expected), true, 'actual final accounting mismatch') }),
  };
  const state = await runInNewContext(`(async () => {
    ${facts.getText(source)}
    ${declarations.map(node => node.getText(source)).join('\n')}
    fixture = ownedFixture; context = ownedContext; page = ownedPage;
    ${assetDeclarations.map(node => node.getText(source)).join('\n')}
    ${documentStatement.getText(source)}
    ${rootStatement.getText(source)}
    ${routeStatement.getText(source)}
    ${requestStatements.map(node => node.getText(source)).join('\n')}
    ${responseStatement.getText(source)}
    ${classify.getText(source)}
    ${accounting.getText(source)}
    ${providerCheck.getText(source)}
    ${clickStatement.getText(source)}
    return {begin:period => {quietPeriod = period;},account:classifyStarts,
      armFinal:async () => {${finalDeclaration.getText(source)} ${finalCapture.getText(source)}},
      finish:async () => {${finalSequence.map(node => node.getText(source)).join('\n')}},
      cleanup:async () => {${captureCleanup.getText(source)} return failure === undefined;},
      prime:() => {
        Object.assign(network,{create:1,task:1,settings:2,list:3});
        for (const live_after of ['synthetic-head-one','synthetic-head-twenty']) {
          snapshots.push({live_after});
          reads.push({path:'/v1/sessions/' + a + '/conversation',query:new URLSearchParams()},
            {path:'/v1/sessions/' + a + '/conversation/events',query:new URLSearchParams({after:live_after})});
        }
      },
      mismatch:kind => {if (kind === 'API') network.other++; else reads[3].query.set('after','wrong-head');},
      read:() => ({quiet:network.quiet,clicked:connectClickObserved,finalClicked:finalDisconnectClickObserved,timing:quietTiming,
        network,faults,assets:assets.size,period:quietPeriod,
        immutable:starts.every(start => Object.isFrozen(start)),periods:starts.map(start => start.period),
        kinds:starts.map(start => start.kind),occurrences:starts.map(start => start.occurrence)})};
  })()`, sandbox);
  const oracle = {
    begin: period => state.begin(period), read: () => plain(state.read()),
    account: async final => { if (final) { await state.armFinal(); if (finalHandler) oracle.finalClick(20); } await state.account(final); },
    finish: () => state.finish(), parked: () => parked, prime: () => state.prime(), mismatch: kind => state.mismatch(kind),
    resolveFinal: () => resolveClick(), onDomCheck: callback => { domHook = callback; },
    actionFacts: () => ({clickResolved,domChecks,inspections}),
    click: time => { now = time; assert.equal(typeof clickHandler, 'function'); const handler = clickHandler; clickHandler = undefined; handler({target:button}); },
    finalClick: (time, target = finalButton) => { now = time; assert.equal(typeof finalHandler, 'function'); const handler = finalHandler; finalHandler = undefined; handler({target}); },
    marker: descriptor => { delete root.disconnectQuietFinalClickTime; if (descriptor) Object.defineProperty(root,'disconnectQuietFinalClickTime',descriptor); },
    markerImmutable: () => {
      const descriptor = Object.getOwnPropertyDescriptor(root,'disconnectQuietFinalClickTime');
      return descriptor?.writable === false && descriptor.enumerable === false && descriptor.configurable === true;
    },
    cleanup: () => state.cleanup(), replaceRoot: () => { currentRoot = {}; },
    token: () => {}, actionStart: () => {}, removed: () => !Object.hasOwn(root, 'disconnectQuietClickTime') && !Object.hasOwn(root, 'disconnectQuietFinalClickTime'),
    entry: (request, time, kind = request.isNavigationRequest() ? 'navigation' : 'resource') => {
      (kind === 'navigation' ? navigation : resources).push({entryType:kind,name:request.url(),startTime:time});
    },
    clear: kind => { (kind === 'navigation' ? navigation : resources).length = 0; },
    replaceDocument: () => { sandbox.document = { getElementById: () => root }; },
    request: (path = '/v1/settings', navigation = false) => {
      const request = { url: () => origin + path, isNavigationRequest: () => navigation,
        method: () => 'GET', headers: () => ({authorization:`Bearer ${owner}`}) };
      handlers.get('request')(request); return request;
    },
    settle: (request, failed = false) => handlers.get(failed ? 'requestfailed' : 'requestfinished')(request),
    response: request => handlers.get('response')({url:request.url,status:() => 200}),
    route: async (request, held = false) => routeHandler({request:() => request,
      continue: async () => { continued++; if (held) await new Promise(resolve => { release = resolve; }); },
      abort: async () => { aborted++; } }),
    external: () => routeHandler({request:() => ({url:() => 'https://external.invalid/'}),abort:async () => {aborted++;}}),
    release: () => release(), counts: () => ({continued,aborted}),
  };
  if (initialNavigation) {
    const initial = oracle.request('/', true); oracle.entry(initial, 0); oracle.settle(initial);
  }
  return oracle;
}

test('disconnect actual overlap counts immutable pre-click start despite delayed route and classification', async () => {
  const oracle = await timingOracle(); oracle.begin(1);
  const request = oracle.request(); const continuing = oracle.route(request, true);
  oracle.entry(request, 9); oracle.click(10); await oracle.account();
  assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().clicked, true);
  oracle.release(); await continuing; await oracle.account();
  assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().immutable, true);
  assert.deepEqual(oracle.counts(), {continued:1,aborted:0});
});
test('disconnect actual matched quiet count never decreases after a later actual click', async () => {
  const oracle = await timingOracle(); oracle.begin(1); const request = oracle.request(); oracle.entry(request, 9);
  await oracle.account(); assert.equal(oracle.read().quiet, 1);
  oracle.click(10); await oracle.account(); assert.equal(oracle.read().quiet, 1);
});
for (const deliveredBeforeClick of [false, true]) test(`disconnect actual legitimate post-click start; delivery inversion=${deliveredBeforeClick}`, async () => {
  const oracle = await timingOracle(); oracle.begin(1);
  let request;
  if (deliveredBeforeClick) request = oracle.request();
  oracle.click(10);
  request ??= oracle.request(); oracle.entry(request, 11); await oracle.route(request); await oracle.account(true);
  assert.equal(oracle.read().quiet, 0); assert.equal(oracle.read().clicked, true); assert.equal(oracle.removed(), true);
});
for (const action of ['token','actionStart']) test(`disconnect actual ${action} does not authorize reads`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle[action]();
  const request = oracle.request(); oracle.entry(request, 11); await oracle.account();
  assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().clicked, false);
});
for (const [kind, time] of [['tie',10],['unknown',NaN]]) test(`disconnect actual ${kind} timing fails closed without tolerance`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const request = oracle.request(); oracle.entry(request, time);
  await assert.rejects(oracle.account(true)); assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().timing[kind], 1);
});
for (const failed of [false,true]) test(`disconnect actual missing entry is only intermediate pending; no response=${failed}`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); const request = oracle.request('/observation');
  if (failed) oracle.settle(request, true);
  await oracle.account(); assert.equal(oracle.read().timing.pending, 1); assert.equal(oracle.read().quiet, 0);
  await assert.rejects(oracle.account(true)); assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().timing.missing, 1);
});
test('disconnect actual incomplete stream resolves only from its original start after abort', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); const request = oracle.request('/observation');
  await oracle.account(); assert.equal(oracle.read().timing.pending, 1);
  oracle.settle(request, true); oracle.entry(request, 11); await oracle.account(true);
  assert.equal(oracle.read().quiet, 0); assert.equal(oracle.read().timing.pending, 0);
});
test('disconnect actual delayed pre-click nonAPI request remains in the first period through reconnect', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const legitimate = oracle.request(); oracle.entry(legitimate, 11); await oracle.account();
  const delayed = oracle.request('/assets/late.js'); oracle.entry(delayed, 9); await oracle.account();
  assert.equal(oracle.read().quiet, 1); assert.deepEqual(oracle.read().periods, [null,1,1]);
});
test('disconnect actual overlapping duplicate URLs reject both pairings even with delivery inversion', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const first = oracle.request(), second = oracle.request(); oracle.entry(second, 11); oracle.entry(first, 9);
  await assert.rejects(oracle.account(true)); assert.equal(oracle.read().quiet, 2); assert.equal(oracle.read().timing.ambiguous, 2);
});
test('disconnect actual settled callback cannot disambiguate duplicate starts in one period', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const first = oracle.request(); oracle.settle(first); const second = oracle.request();
  oracle.entry(second, 9); oracle.entry(first, 11);
  await assert.rejects(oracle.account(true)); assert.equal(oracle.read().quiet, 2); assert.equal(oracle.read().timing.ambiguous, 2);
});
test('disconnect actual old URL occurrence alone fails closed at final accounting', async () => {
  const oracle = await timingOracle(); const initial = oracle.request(); oracle.entry(initial, 1); oracle.settle(initial);
  oracle.begin(1); oracle.click(10); oracle.request();
  await assert.rejects(oracle.account(true)); assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().timing.missing, 1);
});
test('disconnect actual sequential old URL occurrence cannot stand in for a missing reconnect start', async () => {
  const oracle = await timingOracle(); const initial = oracle.request(); oracle.entry(initial, 1); oracle.settle(initial);
  oracle.begin(1); oracle.click(10); const next = oracle.request();
  await oracle.account(); assert.equal(oracle.read().timing.pending, 1); assert.equal(oracle.read().quiet, 0);
  oracle.entry(next, 11); oracle.settle(next); await oracle.account(true);
  assert.equal(oracle.read().quiet, 0); assert.deepEqual(oracle.read().periods, [null,null,1]);
});
test('disconnect actual unaccounted or tied duplicate resource occurrences fail closed', async () => {
  for (const time of [11,12]) {
    const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
    const request = oracle.request(); oracle.entry(request, 11); oracle.entry(request, time);
    await assert.rejects(oracle.account(true)); assert.equal(oracle.read().timing.ambiguous, 1);
  }
});
test('disconnect actual final quiet period does not inherit the first Connect permission', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); oracle.begin(2);
  const request = oracle.request('/assets/late.js'); oracle.entry(request, 11); await oracle.account(true);
  assert.equal(oracle.read().quiet, 1); assert.deepEqual(oracle.read().periods, [null,2]); assert.equal(oracle.removed(), true);
});
test('disconnect actual route only continues real local traffic or aborts external traffic', async () => {
  const oracle = await timingOracle(); oracle.begin(1); const request = oracle.request();
  await oracle.route(request); await oracle.external(); assert.deepEqual(oracle.counts(), {continued:1,aborted:1});
  assert.equal(oracle.read().quiet, 0); assert.equal(oracle.read().clicked, false);
});
test('disconnect actual initial navigation and later same-URL root fetch match separate populations', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const resource = oracle.request('/'); oracle.entry(resource, 11); await oracle.account(true);
  assert.equal(oracle.read().quiet, 0); assert.equal(oracle.read().clicked, true);
  assert.deepEqual(oracle.read().kinds, ['navigation','resource']);
  assert.deepEqual(oracle.read().occurrences, [0,0]);
  assert.deepEqual(oracle.read().timing, {pending:0,ambiguous:0,missing:0,tie:0,unknown:0});
});
test('disconnect actual kind is immutable even if the request API later changes', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const request = oracle.request('/'); request.isNavigationRequest = () => true;
  oracle.entry(request, 11, 'resource'); await oracle.account(true);
  assert.equal(oracle.read().quiet, 0); assert.equal(oracle.read().immutable, true);
  assert.deepEqual(oracle.read().kinds, ['navigation','resource']);
});
for (const kind of ['navigation','resource']) test(`disconnect actual missing ${kind} cannot use the other timing population`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const resource = oracle.request('/'); oracle.entry(resource, 11);
  oracle.clear(kind); await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().timing.missing, 1);
});
for (const kind of ['navigation','resource']) test(`disconnect actual cross-kind substitution for ${kind} fails closed`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const request = oracle.request('/'); oracle.entry(request, 11); oracle.clear(kind);
  oracle.entry(request, 12, kind === 'navigation' ? 'resource' : 'navigation');
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().timing.missing, 1); assert.equal(oracle.read().quiet > 0, true);
});
test('disconnect actual absent original navigation request fails the document provenance check', async () => {
  const oracle = await timingOracle({initialNavigation:false}); oracle.begin(1); oracle.click(10);
  const request = oracle.request('/'); oracle.entry(request, 11);
  await assert.rejects(oracle.account(true));
});
for (const period of [null,1,2]) test(`disconnect actual unexpected same-URL navigation is not permission; period=${period}`, async () => {
  const oracle = await timingOracle(); oracle.begin(period); oracle.click(10);
  const request = oracle.request('/', true); oracle.entry(request, 11);
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().timing.ambiguous, 2); assert.equal(oracle.read().quiet, 2);
  assert.deepEqual(oracle.read().kinds, ['navigation','navigation']);
  assert.deepEqual(oracle.read().occurrences, [0,1]);
});
for (const period of [1,2]) test(`disconnect actual replacement document cannot reuse the original click; period=${period}`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); oracle.begin(period);
  oracle.replaceDocument(); const request = oracle.request('/'); oracle.entry(request, 11);
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().clicked, false); assert.equal(oracle.read().timing.unknown, 2);
  assert.equal(oracle.read().quiet, 2);
});
for (const [schedule,time] of [['pre',9],['tie',10],['post',11]]) test(`disconnect actual same-URL resource uses strict pre-tie-post classification; schedule=${schedule}`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); const request = oracle.request('/');
  const continuing = oracle.route(request, true); oracle.entry(request, time); oracle.click(10);
  if (time === 10) await assert.rejects(oracle.account(true));
  else await oracle.account(true);
  assert.equal(oracle.read().quiet, time > 10 ? 0 : 1);
  assert.equal(oracle.read().timing.tie, time === 10 ? 1 : 0);
  oracle.release(); await continuing;
});
for (const [variant,time] of [['nan',NaN],['infinite',Infinity],['negative',-1]]) test(`disconnect actual invalid original navigation timing fails closed; variant=${variant}`, async () => {
  const oracle = await timingOracle(); oracle.clear('navigation');
  const request = {url:() => 'http://127.0.0.1/',isNavigationRequest:() => true}; oracle.entry(request, time);
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().timing.unknown, 1); assert.equal(oracle.read().quiet, 1);
});
for (const kind of ['navigation','resource']) test(`disconnect actual excess ${kind} entries cannot pair by kind alone`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const request = oracle.request('/'); oracle.entry(request, 11); oracle.entry(request, 12, kind);
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().timing.ambiguous, 1); assert.equal(oracle.read().quiet, 1);
});
for (const settled of [false,true]) test(`disconnect actual same-kind root duplicates stay ambiguous; settled=${settled}`, async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10);
  const first = oracle.request('/'); if (settled) oracle.settle(first);
  const second = oracle.request('/'); oracle.entry(second, 9); oracle.entry(first, 11);
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().timing.ambiguous, 2); assert.equal(oracle.read().quiet, 2);
  assert.deepEqual(oracle.read().occurrences, [0,0,1]);
});
test('disconnect actual unsettled navigation and same-URL resource are not a same-kind overlap', async () => {
  const oracle = await timingOracle({initialNavigation:false}); const initial = oracle.request('/', true);
  oracle.entry(initial, 0); oracle.begin(1); oracle.click(10);
  const resource = oracle.request('/'); oracle.entry(resource, 11); await oracle.account(true);
  assert.equal(oracle.read().quiet, 0); assert.equal(oracle.read().timing.ambiguous, 0);
});
test('disconnect actual root resource in final period cannot inherit the baseline or Connect permission', async () => {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); oracle.begin(2);
  const request = oracle.request('/'); oracle.entry(request, 11); await oracle.account(true);
  assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().timing.missing, 0);
  assert.deepEqual(oracle.read().kinds, ['navigation','resource']); assert.equal(oracle.removed(), true);
});
for (const invalid of [false,true]) test(`disconnect actual baseline resource needs its own finite entry when a later occurrence is missing; invalid=${invalid}`, async () => {
  const oracle = await timingOracle(); const baseline = oracle.request('/');
  oracle.entry(baseline, invalid ? NaN : 1); oracle.settle(baseline);
  oracle.begin(1); oracle.click(10); oracle.request('/');
  await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().timing.missing, 1); assert.equal(oracle.read().timing.unknown, invalid ? 1 : 0);
  assert.equal(oracle.read().quiet, invalid ? 2 : 1);
});
test('disconnect actual missing navigation is never intermediate streaming pending', async () => {
  const oracle = await timingOracle(); oracle.clear('navigation'); await oracle.account();
  assert.equal(oracle.read().quiet, 1); assert.equal(oracle.read().timing.missing, 1);
  assert.equal(oracle.read().timing.pending, 0); await assert.rejects(oracle.account(true));
  assert.equal(oracle.read().quiet, 1);
});
async function finalAction() {
  const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); oracle.prime();
  const completion = oracle.finish(); await oracle.parked();
  assert.deepEqual(oracle.actionFacts(), {clickResolved:false,domChecks:0,inspections:0});
  assert.equal(oracle.read().period, 1);
  return {oracle,completion};
}
const timingZero = {pending:0,ambiguous:0,missing:0,tie:0,unknown:0};
const quietZero = {create:1,task:1,other:0,settings:2,list:3,quiet:0};
const accountingFailure = cause => cause?.code === 'ERR_ASSERTION' && cause.message.startsWith('actual final accounting mismatch');
function finalFacts(oracle, quiet, inspected) {
  const value = oracle.read();
  assert.equal(value.immutable, true); assert.equal(value.finalClicked, true);
  assert.deepEqual(value.network, {...quietZero,quiet}); assert.deepEqual(value.faults, {external:0,request:0,response:0,console:0,page:0,private:0});
  assert.equal(value.assets, 0); assert.equal(oracle.removed(), true);
  assert.deepEqual(oracle.actionFacts(), {clickResolved:true,domChecks:1,inspections:inspected});
}
test('disconnect F1 actual final capture rejects a successful unique static alias before SDK completion through quiet-zero accounting', async () => {
  const {oracle,completion} = await finalAction();
  oracle.finalClick(20); assert.equal(oracle.markerImmutable(), true);
  const request = oracle.request('/index.html'); oracle.entry(request, 21);
  await oracle.route(request); oracle.response(request); oracle.settle(request);
  assert.deepEqual(oracle.read().network, quietZero);
  assert.deepEqual(oracle.read().periods, [null,1]); assert.deepEqual(oracle.read().occurrences, [0,0]);
  assert.deepEqual(oracle.actionFacts(), {clickResolved:false,domChecks:0,inspections:0});
  oracle.resolveFinal(); await assert.rejects(completion, accountingFailure);
  finalFacts(oracle,1,0); assert.deepEqual(oracle.read().timing, timingZero);
  assert.deepEqual(oracle.counts(), {continued:1,aborted:0});
});
for (const schedule of ['before action','waiting for actual dispatch','delivered after dispatch']) {
  test(`disconnect actual final action preserves legitimate earlier reads; ${schedule}`, async () => {
    const oracle = await timingOracle(); oracle.begin(1); oracle.click(10); oracle.prime();
    let request;
    if (schedule === 'before action') { request = oracle.request('/index.html'); oracle.entry(request, 11); }
    const completion = oracle.finish(); await oracle.parked();
    if (schedule === 'waiting for actual dispatch') { request = oracle.request('/index.html'); oracle.entry(request, 19); }
    oracle.finalClick(20);
    if (schedule === 'delivered after dispatch') { request = oracle.request('/index.html'); oracle.entry(request, 19); }
    oracle.response(request); oracle.settle(request); oracle.resolveFinal(); await completion;
    finalFacts(oracle,0,1); assert.deepEqual(oracle.read().timing, timingZero);
    assert.deepEqual(oracle.read().periods, [null,1]);
  });
}
for (const schedule of ['tie','post']) test(`disconnect actual final-click ${schedule} fails while SDK action is parked`, async () => {
  const {oracle,completion} = await finalAction(); oracle.finalClick(20);
  const request = oracle.request('/index.html'); oracle.entry(request, schedule === 'tie' ? 20 : 21);
  oracle.response(request); oracle.settle(request); oracle.resolveFinal(); await assert.rejects(completion);
  finalFacts(oracle,1,0);
  assert.deepEqual(oracle.read().timing, {...timingZero,tie:schedule === 'tie' ? 1 : 0});
});
for (const delivery of ['during SDK action','after SDK completion']) for (const settlement of ['during SDK action','after SDK completion']) {
  test(`disconnect actual final upper boundary survives delayed callback and settlement; ${delivery}; ${settlement}`, async () => {
    const {oracle,completion} = await finalAction(); oracle.finalClick(20);
    let request;
    if (delivery === 'during SDK action') request = oracle.request('/index.html');
    if (request && settlement === 'during SDK action') { oracle.entry(request,21); oracle.response(request); oracle.settle(request); }
    oracle.onDomCheck(() => {
      request ??= oracle.request('/index.html');
      if (delivery === 'after SDK completion' || settlement === 'after SDK completion') {
        oracle.entry(request,21); oracle.response(request); oracle.settle(request);
      }
    });
    oracle.resolveFinal(); await assert.rejects(completion, accountingFailure);
    finalFacts(oracle,1,0); assert.deepEqual(oracle.read().timing, timingZero);
    assert.deepEqual(oracle.read().periods, [null,delivery === 'during SDK action' ? 1 : 2]);
  });
}
for (const requestPresent of [false,true]) for (const variant of ['missing','nan','infinite','negative','Connect tie','before Connect','writable','enumerable','accessor']) {
  test(`disconnect actual final proof requires a valid immutable witness; ${variant}; resource=${requestPresent}`, async () => {
    const {oracle,completion} = await finalAction(); oracle.finalClick(20);
    const values = {nan:NaN,infinite:Infinity,negative:-1,'Connect tie':10,'before Connect':9};
    let descriptor = {value:20,configurable:true};
    if (variant === 'missing') descriptor = null;
    else if (Object.hasOwn(values,variant)) descriptor.value = values[variant];
    else if (variant === 'writable') descriptor.writable = true;
    else if (variant === 'enumerable') descriptor.enumerable = true;
    else if (variant === 'accessor') descriptor = {get:() => 20,configurable:true};
    oracle.marker(descriptor);
    if (requestPresent) { const request = oracle.request('/index.html'); oracle.entry(request,11); oracle.settle(request); }
    oracle.resolveFinal(); await assert.rejects(completion);
    assert.equal(oracle.read().finalClicked, false); assert.equal(oracle.removed(), true);
    assert.equal(oracle.read().quiet, requestPresent ? 1 : 0);
    assert.equal(oracle.read().timing.unknown, requestPresent ? 1 : 0);
    assert.deepEqual(oracle.actionFacts(), {clickResolved:true,domChecks:1,inspections:0});
  });
}
for (const identity of ['document','root']) for (const schedule of ['before dispatch','after dispatch']) {
  test(`disconnect actual final witness is bound to original ${identity}; ${schedule}`, async () => {
    const {oracle,completion} = await finalAction();
    const replace = () => identity === 'document' ? oracle.replaceDocument() : oracle.replaceRoot();
    if (schedule === 'before dispatch') replace(); oracle.finalClick(20);
    if (schedule === 'after dispatch') replace();
    oracle.resolveFinal(); await assert.rejects(completion);
    assert.equal(oracle.read().finalClicked, false); assert.equal(oracle.read().quiet, 1);
    assert.equal(oracle.read().timing.unknown, 1); assert.equal(oracle.removed(), true);
  });
}
test('disconnect actual final wrong target supplies no permission or observed proof', async () => {
  const {oracle,completion} = await finalAction(); oracle.finalClick(20,{});
  oracle.resolveFinal(); await assert.rejects(completion);
  assert.equal(oracle.read().finalClicked, false); assert.equal(oracle.removed(), true);
});
test('disconnect actual final capture is one-shot and its immutable cutoff cannot authorize later traffic', async () => {
  const {oracle,completion} = await finalAction(); oracle.finalClick(20);
  assert.equal(oracle.markerImmutable(), true); assert.throws(() => oracle.finalClick(30));
  const request = oracle.request('/index.html'); oracle.entry(request,21);
  await oracle.account(); assert.equal(oracle.read().quiet,1);
  oracle.resolveFinal(); await assert.rejects(completion);
  finalFacts(oracle,1,0); assert.deepEqual(oracle.read().timing,timingZero);
});
test('disconnect actual final sequence keeps cumulative earlier quiet violations', async () => {
  const oracle = await timingOracle(); oracle.begin(1);
  const request = oracle.request('/index.html'); oracle.entry(request,9); await oracle.account();
  oracle.click(10); oracle.prime(); const completion = oracle.finish(); await oracle.parked(); oracle.finalClick(20);
  oracle.resolveFinal(); await assert.rejects(completion, accountingFailure);
  finalFacts(oracle,1,0); assert.deepEqual(oracle.read().timing,timingZero);
});
test('disconnect actual owned capture cleanup removes both markers after an interrupted final action', async () => {
  const {oracle,completion} = await finalAction(); oracle.finalClick(20);
  assert.equal(oracle.removed(), false); assert.equal(await oracle.cleanup(), true); assert.equal(oracle.removed(), true);
  oracle.resolveFinal(); await assert.rejects(completion);
  assert.equal(oracle.read().finalClicked, false); assert.equal(oracle.removed(), true);
});
for (const mismatch of ['API','Latest/SSE']) test(`disconnect actual final action still enforces ${mismatch} accounting`, async () => {
  const {oracle,completion} = await finalAction(); oracle.finalClick(20); oracle.mismatch(mismatch);
  oracle.resolveFinal(); await assert.rejects(completion);
  assert.equal(oracle.read().finalClicked, true); assert.equal(oracle.read().quiet,0); assert.equal(oracle.removed(), true);
  assert.deepEqual(oracle.actionFacts(), {clickResolved:true,domChecks:1,inspections:0});
});

test('disconnect final accounting follows the original app abort and owned DOM checks without new waits', () => {
  const text = source.getFullText();
  assert.equal((text.match(/waitForTimeout\(500\)/g) ?? []).length, 3);
  assert.equal(text.includes('data-connect-clicked'), false);
  const final = text.slice(text.indexOf("stage = 'final Disconnect"));
  assert.equal(final.indexOf('await disconnect.evaluate(') < final.indexOf('await disconnect.click();'), true);
  assert.equal(final.indexOf('await disconnect.click(); quietPeriod = 2; await disconnectedTruth();') < final.indexOf('await readAccounting(a,true,true)'), true);
  assert.equal(classify.getText(source).includes('expect(finalDisconnectClickObserved).toBe(true);'), true);
  assert.equal(captureCleanup.getText(source).includes('delete root.disconnectQuietClickTime; delete root.disconnectQuietFinalClickTime;'), true);
  assert.equal(accounting.getText(source).includes('await classifyStarts(final);'), true);
  for (const forbidden of ['.timing(', 'errorText', 'PerformanceObserver', 'exposeBinding', 'addInitScript', 'route.fulfill', 'newCDPSession']) assert.equal(text.includes(forbidden), false);
});
