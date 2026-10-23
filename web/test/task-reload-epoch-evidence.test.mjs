import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, cursor, page, session, block, human, field, batch } from '../test-support/display-fixtures.mjs';

const source = ts.createSourceFile('task-reload-epoch.js', readFileSync(new URL('../e2e/task-reload-epoch.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1], attempt = callback.body.statements.find(ts.isTryStatement), statements = attempt.tryBlock.statements;
const constants = source.statements.filter(node => ts.isVariableStatement(node) && ['TASK', 'ANSWER', 'ARGUMENTS', 'OUTPUT', 'DRAFT'].includes(node.declarationList.declarations[0].name.getText(source)));
assert.equal(constants.length, 5);
const { TASK, DRAFT } = runInNewContext(`${constants.map(node => node.getText(source)).join('\n')}\n({TASK,DRAFT})`);
const classifier = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'bodyRejectionClass');
const helper = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'readReply');
const terminalHelpers = statements.filter(node => ts.isFunctionDeclaration(node) && ['requestFailureClass', 'requestTerminal'].includes(node.name.text));
const installation = statements.filter(node => /^(requestListenersStarted = true;|page\.on\('request(?:finished|failed)',)/.test(node.getText(source)));
assert.equal(terminalHelpers.length, 2); assert.equal(installation.length, 3);
const terminalSource = terminalHelpers.map(node => node.getText(source)).join('\n');
const installationSource = installation.map(node => node.getText(source)).join('\n');
const progressSnapshot = callback.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'h20ProgressSnapshot');
const progressObserver = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'observeH20Progress');
assert.ok(progressSnapshot && progressObserver);
const progressSource = `${progressSnapshot.getText(source)}\n${progressObserver.getText(source)}`;
const latest = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'latestReply');
const observer = statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'observeReconnect');
const reconnect = statements.find(node => node.getText(source).startsWith('const [latest] = await Promise.all('));
const facts = callback.body.statements.find(ts.isFunctionDeclaration);
const guard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
const creation = statements.find(node => node.getText(source).startsWith('const [createdReply] = await Promise.all('));
const taskReply = statements.find(node => node.getText(source).startsWith('const [acceptedReply] = await Promise.all('));
assert.ok(classifier && helper && latest && observer && reconnect && facts && guard && creation && taskReply);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1, callback.body.statements.indexOf(attempt) + 5);
assert.equal(tail[3].getText(source), 'if (failure) throw failure;');
const declarations = callback.body.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(source) !== 'lateH20Progress');
const requestRegistration = statements.find(node => node.getText(source).startsWith("context.on('request',"));
const requestCallback = requestRegistration.expression.arguments[1];
const armIndex = statements.findIndex(node => node.getText(source).startsWith('expectedH20 = Object.freeze('));
const armProgress = statements.slice(armIndex, armIndex + 2).map(node => node.getText(source)).join('\n');
assert.ok(requestCallback && armIndex >= 0);
// Execute the real reply, first-failure and cleanup statements with controlled dependencies.
const controlled = `(async () => {
  ${constants.map(node => node.getText(source)).join('\n')}
  ${facts.getText(source)}
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  workspace = '/synthetic/a'; creation = syntheticCreate; submitted = syntheticTask;
  const a = syntheticSession;
  ${progressSource}
  ${terminalSource}
  ${classifier.getText(source)}
  ${helper.getText(source)}
  ${latest.getText(source)}
  ${guard.getText(source)}
  capture(() => ({observed,cleanup,faults,network}));
  try {
    ${installationSource}
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
const blank = () => ({ acquired: false, status: null, body_attempted: false, body_rejected: false, body_rejection_class: null, request_terminal_pre_body: null, request_terminal_post_body: null, h20_progress_pre_body: null, h20_progress_post_body: null, body_returned: false, body_bounded: false, decoded: false, validated: false, exact: false });
const noTerminal = { requestfinished_observed: false, requestfailed_observed: false, failure_class: 'not_reported' };
const bound = () => ({ request_terminal_pre_body: { ...noTerminal }, request_terminal_post_body: { ...noTerminal } });
// Only the C harness supplies this public event seam. Observers come from the actual spec.
function eventPage({ installFailure, removalFailures = [], eventDuringRemoval } = {}) {
  const listeners = new Map(), calls = [];
  const page = {
    on(event, listener) {
      calls.push(['on', event, listener]);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      if (installFailure === event && listeners.get(event).size > 1) throw new Error(PRIVATE);
      return page;
    },
    off(event, listener) {
      calls.push(['off', event, listener]);
      eventDuringRemoval?.(event, page);
      if (removalFailures.includes(event)) throw new Error(PRIVATE);
      listeners.get(event)?.delete(listener);
      return page;
    },
    emit(event, request) { for (const listener of [...(listeners.get(event) ?? [])]) listener(request); },
    calls, listeners,
  };
  return page;
}
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
    ...eventPage(),
    waitForResponse: async predicate => {
      const n = acquired++, variant = n === index ? option : 'valid';
      const request = { method: () => n === 2 ? 'GET' : 'POST', failure: () => null };
      const response = { url: () => `http://127.0.0.1/v1/sessions${n === 0 ? '' : '/' + SID + (n === 1 ? '/runs' : '/conversation')}`, request: () => request };
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
  assert.deepEqual(output, [`Reload epoch cleanup: browser=${!closeFailure} fixture=${!stopFailure} request_listeners=true`, 'Reload epoch H20 progress: {"pre":null,"post":null,"first_failure":null,"late":null}']);
  return { failure, evidence: plain(getter()), beforeBody };
}
for (const index of [0, 1, 2]) for (const option of ['acquisition', 'body', 'size', 'utf8', 'media', 'json', 'schema', 'extra', 'identity']) {
  test(`reload C actual ${['Create', 'Task', 'Latest'][index]} ${option} preserves private-safe response milestones`, async () => {
    const result = await exercise({ index, option }); assert.ok(result.failure);
    const facts = blank();
    if (option !== 'acquisition') Object.assign(facts, { acquired: true, status: [201, 202, 200][index], body_attempted: true, ...bound() });
    if (option === 'body') Object.assign(facts, { body_rejected: true, body_rejection_class: 'other' });
    if (!['acquisition', 'body'].includes(option)) facts.body_returned = true;
    if (!['acquisition', 'body', 'size'].includes(option)) facts.body_bounded = true;
    if (['schema', 'extra', 'identity'].includes(option)) facts.decoded = true;
    if (index === 0 && option === 'identity') facts.validated = true;
    assert.deepEqual(index === 0 ? result.evidence.observed.create : index === 1 ? result.evidence.observed.task : result.evidence.observed.latest[0], facts);
    assert.equal(result.evidence.faults.private, ['json', 'extra'].includes(option) ? 1 : 0);
  });
}
for (const [index, options] of [[0, ['status', 'keys', 'range', 'duplicate', 'warning']], [1, ['status', 'keys', 'range', 'duplicate', 'warning', 'notices']], [2, ['status', 'keys', 'head', 'title', 'workspace']]]) {
  for (const option of options) test(`reload C actual ${['Create', 'Task', 'Latest'][index]} rejects non-exact ${option}`, async () => {
    const result = await exercise({ index, option }); assert.ok(result.failure);
    const facts = index === 0 ? result.evidence.observed.create : index === 1 ? result.evidence.observed.task : result.evidence.observed.latest[0];
    assert.deepEqual(facts, { acquired: true, status: option === 'status' ? 203 : [201, 202, 200][index],
      body_attempted: true, body_rejected: false, body_rejection_class: null, ...bound(), h20_progress_pre_body: null, h20_progress_post_body: null, body_returned: true, body_bounded: true, decoded: true,
      validated: !(index === 0 && option === 'range'), exact: false });
  });
}
test('reload C actual reply statements succeed without claiming native or DOM proof', async () => {
  const result = await exercise({ prior: 'previous-guard' }); assert.equal(result.failure, undefined);
  assert.equal([result.evidence.observed.create, result.evidence.observed.task, ...result.evidence.observed.latest].every(f => f.exact), true);
  for (const [index, facts] of result.beforeBody.entries()) assert.deepEqual(facts, { ...blank(), acquired: true, status: [201, 202, 200][index], body_attempted: true, request_terminal_pre_body: noTerminal });
});
test('reload C actual first failure survives both strict cleanup failures', async () => {
  const result = await exercise({ laterFailure: true, closeFailure: true, stopFailure: true });
  assert.ok(result.failure.message.startsWith('Reload epoch failed: Latest response;'));
  assert.equal(result.failure.message.includes('cleanup failed'), false);
});
for (const closeFailure of [false, true]) test(`reload C cleanup-only failure is fatal; browser=${closeFailure}`, async () => {
  const result = await exercise({ closeFailure, stopFailure: true });
  assert.equal(result.failure.message, closeFailure ? 'Reload epoch browser cleanup failed' : 'Reload epoch fixture cleanup failed');
});

// Run the actual H20 joint await and catch before controlled teardown can settle its loser.
const jointControlled = `(async () => {
  ${facts.getText(source)}
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  workspace = '/synthetic/a'; const a = syntheticSession;
  ${progressSource}
  ${terminalSource}
  ${classifier.getText(source)}
  ${helper.getText(source)}
  ${latest.getText(source)}
  ${observer.getText(source)}
  const files = new Map(); const leaked = text => text.includes(privateMarker);
  const onContextRequest = ${requestCallback.getText(source)};
  captureRequest(onContextRequest);
  captureWitness(() => h20ProgressSnapshot(),() => firstFailureH20);
  ${guard.getText(source)}
  capture(() => ({observed,cleanup,faults,network}));
  captureFailure(() => failure?.message);
  captureLatest(() => snapshots[0]);
  try {
    ${installationSource}
    stage = 'explicit Connect joint await';
    if (renderer) { observed.latest.push(replyFacts()); load = 1; ${armProgress} }
    try { ${reconnect.getText(source)} returned(latest); }
    catch (reason) { forwarded(reason); throw reason; }
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail.map(node => node.getText(source)).join('\n')}
})()`;
function deferred() {
  let fulfill, reject;
  const promise = new Promise((resolve, fail) => { fulfill = resolve; reject = fail; });
  return { promise, fulfill, reject };
}
async function jointExercise({ option = 'valid', schedule, prior, closeFailure = false, stopFailure = false, bodyReason, requestFailure = () => null, renderer = false } = {}) {
  let getter, failureText, latestValue, returnedValue, failure, ended = false, closeReached = false;
  let onContextRequest, witness, firstWitness, ownedPage;
  let bodyCalls = 0, actionCalls = 0, acquisitionCalls = 0, propertyReads = 0, unhandled = 0, bodyRejected = false;
  let forwardedLatest = false, forwardedClick = false;
  const descriptors = { latest: { message: 0, name: 0 }, click: { message: 0, name: 0 }, cleanup: { message: 0, name: 0 } };
  const hostile = branch => {
    const target = Object.defineProperties(Object.create(null), {
      private: { enumerable: true, value: PRIVATE },
      message: { enumerable: true, get() { propertyReads++; return PRIVATE; } },
      stack: { get() { propertyReads++; return PRIVATE; } },
      cause: { get() { propertyReads++; return { private: PRIVATE }; } },
      toJSON: { get() { propertyReads++; return () => ({ private: PRIVATE }); } },
    });
    return new Proxy(target, {
      get() { propertyReads++; throw new Error('Rejection property access is forbidden'); },
      ownKeys() { propertyReads++; throw new Error('Rejection enumeration is forbidden'); },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'message' || key === 'name') descriptors[branch][key]++;
        else propertyReads++;
        throw new Error('Synthetic descriptor trap');
      },
    });
  };
  const latestCause = bodyReason ? bodyReason.value : hostile('latest'), clickCause = hostile('click'), cleanupCause = hostile('cleanup');
  const acquisition = deferred(), body = deferred(), action = deferred(), close = deferred();
  const calls = [], output = [], beforeBody = [], env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const value = completed();
  if (option === 'head') { value.snapshot_head = '21'; value.session.head_sequence = '21'; value.live_after = cursor('l', '21', '3', '', ''); }
  if (option === 'cursor') value.live_after = cursor('l', '19', '3', '', '');
  if (option === 'schema') value.api_version = 2;
  if (option === 'extra') value.private = PRIVATE;
  if (option === 'identity') value.session.session_id = OTHER;
  const seam = eventPage();
  let failureReads = 0;
  const publicRequest = { method: () => 'GET', failure: () => { failureReads++; return requestFailure(); } };
  const mainFrame = { page: () => ownedPage };
  const response = {
    url: () => `http://127.0.0.1/v1/sessions/${SID}/conversation`, request: () => publicRequest,
    status: () => 200, headers: () => ({ 'content-type': option === 'media' ? 'text/plain' : 'application/json; charset=utf-8' }),
    body: () => { bodyCalls++; calls.push('body'); beforeBody.push(plain(getter().observed.latest.at(-1))); return body.promise; },
  };
  const bytes = () => {
    if (option === 'size') return Buffer.alloc(524289, 32);
    if (option === 'utf8') return Buffer.from([255]);
    const text = JSON.stringify(value);
    return Buffer.from(option === 'keys' ? text.replace('{', '{"api_version":1,') : text);
  };
  const listener = () => { unhandled++; };
  process.on('unhandledRejection', listener);
  try {
    const execution = runInNewContext(jointControlled, {
      process: { env }, console: { log: text => output.push(text) }, URL, Buffer, TextDecoder, decodeJson, validateConversationPage,
      titles, markers: [PRIVATE], syntheticSession: SID, privateMarker: PRIVATE, renderer,
      ownedPage: ownedPage = {
        ...seam, mainFrame: () => mainFrame,
        waitForResponse: predicate => { acquisitionCalls++; calls.push('waiter'); assert.equal(predicate(response), true); return acquisition.promise; },
        getByRole: (role, options) => {
          assert.equal(role, 'button'); assert.deepEqual(plain(options), { name: 'Connect', exact: true });
          return { click: () => { actionCalls++; calls.push('click'); assert.equal(acquisitionCalls, 1); return action.promise; } };
        },
      },
      ownedFixture: { origin: 'http://127.0.0.1', owner: 'synthetic-owner', stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw cleanupCause; } },
      ownedContext: { close: async () => {
        calls.push('browser-close'); closeReached = true;
        assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
        await close.promise;
        if (closeFailure) throw cleanupCause;
      } },
      capture: value => { getter = value; }, captureFailure: value => { failureText = value; }, captureLatest: value => { latestValue = value; },
      captureRequest: value => { onContextRequest = value; }, captureWitness: (value, first) => { witness = value; firstWitness = first; },
      returned: value => { returnedValue = value; }, forwarded: reason => { forwardedLatest = reason === latestCause; forwardedClick = reason === clickCause; },
      expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
    }, { timeout: 1000 }).then(() => { ended = true; }, error => { ended = true; failure = error; });
    const control = {
      acquire: () => acquisition.fulfill(response), rejectAcquisition: () => acquisition.reject(latestCause),
      body: () => body.fulfill(bytes()), rejectBody: () => { bodyRejected = true; body.reject(latestCause); },
      click: () => action.fulfill(undefined), rejectClick: () => action.reject(clickCause), close: () => close.fulfill(),
      facts: () => plain(getter().observed), text: () => failureText(), closeReached: () => closeReached, ended: () => ended,
      emit: event => seam.emit(event,publicRequest),
      witness: () => witness(), firstWitness: () => firstWitness(), rawFacts: () => getter().observed.latest.at(-1),
      request: ({ origin = 'http://127.0.0.1', session = SID, method = 'GET', after = completed().live_after, query, suffix = '/events',
        headers = { authorization: 'Bearer synthetic-owner' }, frame = 'main', page = 'current', throwing } = {}) => {
        const request = { url: () => `${origin}/v1/sessions/${session}/conversation${suffix}?${query ?? new URLSearchParams({ after })}`,
          headers: () => headers, method: () => method, frame: () => {
            if (throwing === 'frame') throw new Error(PRIVATE);
            if (frame !== 'main') return { page: () => ownedPage };
            return mainFrame;
          } };
        const prior = mainFrame.page;
        mainFrame.page = () => { if (throwing === 'page') throw new Error(PRIVATE); return page === 'current' ? ownedPage : {}; };
        try { onContextRequest(request); } finally { mainFrame.page = prior; }
      },
    };
    assert.deepEqual(calls, ['waiter', 'click']);
    assert.deepEqual(control.facts().reconnect, { latest: 'pending', click: 'pending', first_rejection: null });
    try { await schedule(control); } finally {
      // Resolve every controlled loser before checking for detached unhandled rejection.
      acquisition.fulfill(response); body.fulfill(bytes()); action.fulfill(undefined); close.fulfill();
      await execution; await flush();
    }
    assert.equal(unhandled, 0); assert.equal(propertyReads, 0);
    assert.deepEqual(descriptors, { latest: { message: bodyRejected && !bodyReason ? 1 : 0, name: 0 }, click: { message: 0, name: 0 }, cleanup: { message: 0, name: 0 } });
    assert.equal(acquisitionCalls, 1); assert.equal(actionCalls, 1); assert.equal(bodyCalls, option === 'acquisition' ? 0 : 1);
    assert.equal(failureReads, bodyCalls * 2);
    assert.deepEqual(calls.filter(call => call.endsWith('close') || call.endsWith('stop')), ['browser-close', 'fixture-stop']);
    assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
    assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
    assert.equal(output[0], `Reload epoch cleanup: browser=${!closeFailure} fixture=${!stopFailure} request_listeners=true`);
    assert.equal(output.length, 2);
    if (!renderer) assert.equal(output[1], 'Reload epoch H20 progress: {"pre":null,"post":null,"first_failure":null,"late":null}');
    for (const text of [PRIVATE, 'private.invalid', SID, RID, OID, OTHER, TASK, DRAFT, ...titles, '/synthetic/a']) {
      assert.equal([failure?.message ?? '', ...output].join('\n').includes(text), false);
    }
    if (returnedValue !== undefined) assert.ok(returnedValue === latestValue());
    return { failure, evidence: plain(getter()), beforeBody, forwardedLatest, forwardedClick, returnedValue,
      late: JSON.parse(output[1].slice('Reload epoch H20 progress: '.length)), firstWitness: firstWitness() };
  } finally { process.removeListener('unhandledRejection', listener); }
}
const captured = result => {
  const text = result.failure.message;
  assert.ok(text.startsWith('Reload epoch failed: explicit Connect joint await; capture='));
  return JSON.parse(text.slice(text.indexOf('capture=') + 8, text.indexOf('; disconnectedView=')));
};
for (const first of ['latest', 'click']) test(`reload C actual H20 joint fulfills ${first} first and returns the identical Latest value`, async () => {
  const result = await jointExercise({ prior: 'previous-guard', schedule: async c => {
    c.acquire(); await flush();
    if (first === 'latest') { c.body(); await flush(); } else { c.click(); await flush(); }
    assert.deepEqual(c.facts().reconnect, { latest: first === 'latest' ? 'fulfilled' : 'pending', click: first === 'click' ? 'fulfilled' : 'pending', first_rejection: null });
    assert.equal(c.closeReached(), false);
    if (first === 'latest') c.click(); else c.body();
    await flush();
    assert.deepEqual(c.facts().reconnect, { latest: 'fulfilled', click: 'fulfilled', first_rejection: null });
    c.close();
  } });
  assert.equal(result.failure, undefined);
  assert.deepEqual(plain(result.returnedValue), completed());
  assert.deepEqual(result.beforeBody, [{ ...blank(), acquired: true, status: 200, body_attempted: true, request_terminal_pre_body: noTerminal }]);
  assert.deepEqual(result.evidence.observed.latest[0], { ...blank(), ...bound(), acquired: true, status: 200, body_attempted: true, body_returned: true, body_bounded: true, decoded: true, validated: true, exact: true });
});
for (const branch of ['latest', 'click']) for (const loser of ['fulfilled', 'pending']) test(`reload C actual H20 ${branch} rejection with ${loser} loser fails fast and forwards the same value`, async () => {
  let atFailure;
  const result = await jointExercise({ schedule: async c => {
    c.acquire(); await flush();
    if (loser === 'fulfilled') { if (branch === 'latest') c.click(); else c.body(); await flush(); }
    if (branch === 'latest') c.rejectBody(); else c.rejectClick();
    await flush(); atFailure = c.facts();
    assert.equal(c.closeReached(), true); assert.equal(c.ended(), false);
    assert.deepEqual(atFailure.reconnect, { latest: branch === 'latest' ? 'rejected' : loser, click: branch === 'click' ? 'rejected' : loser, first_rejection: branch });
    c.close();
  } });
  assert.equal(result.forwardedLatest, branch === 'latest'); assert.equal(result.forwardedClick, branch === 'click');
  assert.deepEqual(captured(result), atFailure);
  assert.equal(atFailure.latest[0].body_rejected, branch === 'latest');
  assert.equal(atFailure.latest[0].body_returned, branch === 'click' && loser === 'fulfilled');
});
for (const first of ['latest', 'click']) test(`reload C actual H20 both rejection orders retain first local ${first}`, async () => {
  let firstText;
  const result = await jointExercise({ schedule: async c => {
    c.acquire(); await flush();
    if (first === 'latest') c.rejectBody(); else c.rejectClick();
    await flush(); firstText = c.text();
    if (first === 'latest') c.rejectClick(); else c.rejectBody();
    await flush(); assert.equal(c.text(), firstText);
    assert.deepEqual(c.facts().reconnect, { latest: 'rejected', click: 'rejected', first_rejection: first });
    c.close();
  } });
  assert.equal(result.failure.message, firstText);
  assert.equal(captured(result).reconnect.first_rejection, first);
  assert.equal(captured(result).reconnect[first === 'latest' ? 'click' : 'latest'], 'pending');
  assert.equal(result.forwardedLatest, first === 'latest'); assert.equal(result.forwardedClick, first === 'click');
});
test('reload C actual H20 click fails before response acquisition; late body never rewrites failure facts', async () => {
  let firstText;
  const result = await jointExercise({ schedule: async c => {
    c.rejectClick(); await flush(); firstText = c.text();
    assert.deepEqual(c.facts().latest, [blank()]);
    c.acquire(); await flush(); c.body(); await flush();
    assert.equal(c.facts().latest[0].exact, true); assert.equal(c.text(), firstText);
    c.close();
  } });
  assert.equal(result.forwardedClick, true);
  assert.deepEqual(captured(result).latest, [blank()]);
  assert.equal(result.failure.message, firstText);
});
test('reload C actual H20 acquisition rejection remains separate from body rejection', async () => {
  const result = await jointExercise({ option: 'acquisition', schedule: async c => {
    c.click(); c.rejectAcquisition(); await flush(); c.close();
  } });
  assert.equal(result.forwardedLatest, true);
  assert.deepEqual(captured(result).latest, [blank()]);
  assert.deepEqual(captured(result).reconnect, { latest: 'rejected', click: 'fulfilled', first_rejection: 'latest' });
});
for (const option of ['head', 'cursor', 'schema', 'size', 'media', 'utf8', 'extra', 'identity', 'keys']) test(`reload C actual H20 joint rejects closed Latest ${option} at its original boundary`, async () => {
  const result = await jointExercise({ option, schedule: async c => { c.click(); c.acquire(); await flush(); c.body(); await flush(); c.close(); } });
  const facts = { ...blank(), ...bound(), acquired: true, status: 200, body_attempted: true, body_returned: true };
  if (option !== 'size') facts.body_bounded = true;
  if (!['size', 'media', 'utf8'].includes(option)) facts.decoded = true;
  if (['head', 'keys'].includes(option)) facts.validated = true;
  assert.deepEqual(captured(result).latest, [facts]);
  assert.deepEqual(captured(result).reconnect, { latest: 'rejected', click: 'fulfilled', first_rejection: 'latest' });
  assert.equal(result.evidence.faults.private, option === 'extra' ? 1 : 0);
});
for (const branch of ['latest', 'click']) for (const settlement of ['fulfilled', 'rejected']) for (const timing of ['during close', 'after close']) test(`reload C actual H20 ${branch} first failure freezes text across ${settlement} loser ${timing}`, async () => {
  let firstText;
  const result = await jointExercise({ schedule: async c => {
    c.acquire(); await flush();
    if (branch === 'latest') c.rejectBody(); else c.rejectClick();
    await flush(); firstText = c.text(); assert.equal(c.closeReached(), true);
    if (timing === 'after close') { c.close(); await flush(); assert.equal(c.ended(), true); }
    if (branch === 'latest') { if (settlement === 'fulfilled') c.click(); else c.rejectClick(); }
    else if (settlement === 'fulfilled') c.body(); else c.rejectBody();
    await flush(); assert.equal(c.text(), firstText);
    assert.equal(c.facts().reconnect[branch === 'latest' ? 'click' : 'latest'], settlement);
    c.close();
  } });
  assert.equal(result.failure.message, firstText);
  assert.equal(captured(result).reconnect[branch === 'latest' ? 'click' : 'latest'], 'pending');
});
test('reload C actual H20 first rejection survives failed close and stop with recorder guard retained', async () => {
  const result = await jointExercise({ prior: 'previous-guard', closeFailure: true, stopFailure: true, schedule: async c => {
    c.acquire(); await flush(); c.rejectBody(); await flush(); c.rejectClick(); c.close();
  } });
  assert.equal(result.forwardedLatest, true);
  assert.deepEqual(result.evidence.cleanup, { request_listeners: true, browser: false, fixture: false });
  assert.equal(captured(result).reconnect.first_rejection, 'latest');
});
test('reload C actual settlement helper forwards the identical fulfilled click value and rejection value', async () => {
  let reads = 0;
  const observed = { reconnect: { latest: 'not_started', click: 'not_started', first_rejection: null } };
  const wrap = runInNewContext(`${observer.getText(source)}\nobserveReconnect`, { observed });
  const value = Object.create(null), reason = new Proxy(Object.create(null), { get() { reads++; throw new Error('Forbidden rejection read'); }, ownKeys() { reads++; throw new Error('Forbidden rejection enumeration'); } });
  assert.ok(await wrap(Promise.resolve(value), 'click') === value);
  let forwarded = false;
  try { await wrap(Promise.reject(reason), 'latest'); } catch (error) { forwarded = error === reason; }
  assert.equal(forwarded, true); assert.equal(reads, 0);
  assert.deepEqual(observed.reconnect, { latest: 'rejected', click: 'fulfilled', first_rejection: 'latest' });
});

// Execute the actual classifier and sole body catch, without forwarding a raw reason to an assertion.
async function rejectionExercise(reason) {
  const counts = { body: 0, headers: 0, validator: 0, check: 0 };
  const result = await runInNewContext(`(async () => {
    ${facts.getText(source)}
    ${classifier.getText(source)}
    ${declarations.filter(node => /finishedRequests|failedRequests/.test(node.getText(source))).map(node => node.getText(source)).join('\n')}
    ${terminalSource}
    ${helper.getText(source)}
    const facts = replyFacts();
    let same = false;
    try { await readReply(Promise.resolve(response),facts,validator,check); }
    catch (error) { same = error === reason; }
    return {facts,same};
  })()`, {
    reason, response: { request: () => ({ failure: () => null }), status: () => 200, body: () => { counts.body++; return Promise.reject(reason); }, headers: () => { counts.headers++; return {}; } },
    validator: () => { counts.validator++; }, check: () => { counts.check++; },
    expect: () => { throw new Error('Body rejection must not continue'); },
  }, { timeout: 1000 });
  assert.equal(result.same, true);
  assert.deepEqual(counts, { body: 1, headers: 0, validator: 0, check: 0 });
  const finite = plain(result.facts);
  assert.deepEqual(Object.keys(finite), Object.keys(blank()));
  assert.deepEqual({ ...finite, body_rejection_class: null }, { ...blank(), ...bound(), acquired: true, status: 200, body_attempted: true, body_rejected: true });
  assert.equal(JSON.stringify(finite).includes(PRIVATE), false);
  return finite.body_rejection_class;
}
const sdkMarkers = [
  ['get_response_body_no_resource', 'Protocol error (Network.getResponseBody): No resource with given identifier found'],
  ['get_response_body_no_data', 'Protocol error (Network.getResponseBody): No data found for resource with given identifier'],
  ['get_response_body_evicted', 'Protocol error (Network.getResponseBody): Request content was evicted from inspector cache'],
  ['method_get_response_body', 'Protocol error (Network.getResponseBody): unknown detail'],
  ['method_load_network_resource', 'Protocol error (Network.loadNetworkResource): unknown detail'],
  ['method_io_read', 'Protocol error (IO.read): unknown detail'],
  ['method_io_close', 'Protocol error (IO.close): unknown detail'],
  ['target_closed', 'Target page, context or browser has been closed'],
  ['target_crashed', 'Target crashed '+PRIVATE],
  ['timeout', 'Timeout 30000ms exceeded.'],
  ['collected', 'The object has been collected to prevent unbounded heap growth.'],
  ['redirect_body_unavailable', 'Response body is unavailable for redirect responses'],
  ['other', 'unknown private marker'],
];
const competingSuffix = PRIVATE+'\n'+sdkMarkers.map(([, text]) => text).join('\n');
for (const [token, marker] of sdkMarkers) for (const prefix of ['', 'response.body: ']) for (const boundary of ['', '\n', '\r\n']) {
  test(`reload C actual SDK token ${token}; API prefix=${!!prefix}; boundary=${JSON.stringify(boundary)}`, async () => {
    const message = prefix+marker+(boundary ? boundary+competingSuffix : '');
    assert.equal(await rejectionExercise({ message }), token);
  });
}
for (const [token, marker] of sdkMarkers.slice(0, 7)) test(`reload C structural method beats own TimeoutError and conflicting suffix for ${token}`, async () => {
  assert.equal(await rejectionExercise({ message: 'response.body: '+marker+'\n'+competingSuffix, name: 'TimeoutError' }), token);
});
for (const [token, marker] of sdkMarkers.slice(0, 3)) for (const suffix of ['X', '.', ': '+PRIVATE, ' '+PRIVATE, '\t'+PRIVATE, '\r'+PRIVATE]) {
  test(`reload C precise detail ${token} rejects adjacent suffix ${JSON.stringify(suffix.slice(0, 1))}`, async () => {
    assert.equal(await rejectionExercise({ message: marker+suffix }), 'method_get_response_body');
  });
}
for (const [label, message, expected] of [
  ['method case', 'Protocol error (network.getResponseBody): '+PRIVATE, 'other'],
  ['method near match', 'Protocol error (Network.getResponseBodyX): '+PRIVATE, 'other'],
  ['method missing space', 'Protocol error (IO.read):'+PRIVATE, 'other'],
  ['method missing colon', 'Protocol error (IO.close) '+PRIVATE, 'other'],
  ['method extra space', 'Protocol error (Network.getResponseBody):  No resource with given identifier found', 'method_get_response_body'],
  ['detail case', 'Protocol error (Network.getResponseBody): no resource with given identifier found', 'method_get_response_body'],
  ['detail leading newline', 'Protocol error (Network.getResponseBody): \nNo resource with given identifier found', 'method_get_response_body'],
  ['detail embedded', 'Protocol error (Network.getResponseBody): '+PRIVATE+' No resource with given identifier found', 'method_get_response_body'],
  ['API case', 'Response.body: '+sdkMarkers[0][1], 'other'],
  ['API missing space', 'response.body:'+sdkMarkers[0][1], 'other'],
  ['API extra space', 'response.body:  '+sdkMarkers[0][1], 'other'],
  ['API repeated', 'response.body: response.body: '+sdkMarkers[0][1], 'other'],
  ['API incidental', PRIVATE+' response.body: '+sdkMarkers[0][1], 'other'],
  ['method incidental', PRIVATE+'\n'+competingSuffix, 'other'],
  ['closed adjacent', sdkMarkers[7][1]+'X\n'+competingSuffix, 'other'],
  ['closed private inline', sdkMarkers[7][1]+' '+PRIVATE, 'other'],
  ['crashed adjacent', 'Target crashedX '+PRIVATE, 'other'],
  ['crashed exact', 'Target crashed', 'target_crashed'],
  ['timeout fractional', 'Timeout 1.5ms exceeded.\n'+PRIVATE, 'timeout'],
  ['timeout adjacent', 'Timeout 30000ms exceeded.X\n'+competingSuffix, 'other'],
  ['timeout negative', 'Timeout -1ms exceeded.', 'other'],
  ['timeout nonnumeric', 'Timeout '+PRIVATE+'ms exceeded.', 'other'],
  ['collected adjacent', sdkMarkers[10][1]+'X', 'other'],
  ['redirect adjacent', sdkMarkers[11][1]+'X', 'other'],
]) test(`reload C actual structural boundary ${label}`, async () => {
  assert.equal(await rejectionExercise({ message }), expected);
});
for (const [label, make, expected] of [
  ['missing message and name', () => ({}), 'other'],
  ['missing message own timeout name', () => ({ name: 'TimeoutError' }), 'timeout'],
  ['unknown message own timeout name', () => ({ message: PRIVATE, name: 'TimeoutError' }), 'timeout'],
  ['inherited timeout name', () => Object.create({ name: 'TimeoutError' }), 'other'],
  ['inherited protocol message', () => Object.create({ message: sdkMarkers[0][1] }), 'other'],
  ['cross realm ordinary Error', () => runInNewContext('new Error(message)', { message: sdkMarkers[0][1] }), 'get_response_body_no_resource'],
  ['cross realm own TimeoutError', () => runInNewContext('Object.assign(new Error(message),{name:"TimeoutError"})', { message: PRIVATE }), 'timeout'],
  ['function own data', () => Object.assign(function () {}, { message: sdkMarkers[5][1] }), 'method_io_read'],
  ['huge private message suffix', () => ({ message: sdkMarkers[2][1]+'\n'+PRIVATE.repeat(100000) }), 'get_response_body_evicted'],
  ['huge private message prefix', () => ({ message: PRIVATE.repeat(100000)+'\n'+sdkMarkers[2][1] }), 'other'],
  ['null', () => null, 'other'],
  ['undefined', () => undefined, 'other'],
  ['primitive string marker', () => sdkMarkers[0][1], 'other'],
  ['number', () => 42, 'other'],
  ['boolean', () => true, 'other'],
  ['symbol', () => Symbol(PRIVATE), 'other'],
  ['bigint', () => 1n, 'other'],
]) test(`reload C actual own-data rejection ${label}`, async () => {
  assert.equal(await rejectionExercise(make()), expected);
});
for (const key of ['message', 'name']) for (const value of [undefined, null, 1, false, {}, Symbol(PRIVATE)]) {
  test(`reload C nonstring own ${key} overrides recognized markers; type=${typeof value}`, async () => {
    assert.equal(await rejectionExercise({ message: sdkMarkers[0][1], name: 'TimeoutError', [key]: value }), 'other');
  });
}
for (const key of ['message', 'name']) for (const trap of ['accessor', 'throwing descriptor', 'nonstring descriptor', 'ordinary data']) {
  test(`reload C ${key} ${trap} permits only two guarded descriptor attempts`, async () => {
    let forbidden = 0;
    const descriptors = { message: 0, name: 0 };
    const target = Object.assign(Object.create(null), { message: sdkMarkers[0][1], name: 'TimeoutError' });
    for (const property of ['stack', 'cause', 'toJSON', 'toString', Symbol.toPrimitive]) {
      Object.defineProperty(target, property, { get() { forbidden++; throw new Error('Forbidden synthetic getter'); } });
    }
    if (trap === 'accessor') Object.defineProperty(target, key, { get() { forbidden++; return PRIVATE; } });
    const reason = new Proxy(target, {
      get() { forbidden++; throw new Error('Forbidden synthetic direct get'); },
      ownKeys() { forbidden++; throw new Error('Forbidden synthetic enumeration'); },
      getPrototypeOf() { forbidden++; throw new Error('Forbidden synthetic prototype read'); },
      getOwnPropertyDescriptor(target, property) {
        if (property !== 'message' && property !== 'name') { forbidden++; throw new Error('Forbidden synthetic descriptor key'); }
        descriptors[property]++;
        if (property === key && trap === 'throwing descriptor') throw new Error(PRIVATE);
        if (property === key && trap === 'nonstring descriptor') return { value: {}, configurable: true };
        return Object.getOwnPropertyDescriptor(target, property);
      },
    });
    assert.equal(await rejectionExercise(reason), trap === 'ordinary data' ? 'get_response_body_no_resource' : 'other');
    assert.equal(forbidden, 0);
    assert.deepEqual(descriptors, { message: 1, name: key === 'message' && trap === 'throwing descriptor' ? 0 : 1 });
  });
}
test('reload C revoked proxy remains other and forwards the original rejection', async () => {
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.equal(await rejectionExercise(proxy), 'other');
});
test('reload C actual source confines classification to the sole body catch and closed descriptor keys', () => {
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
  const inspected = [], reasonAccesses = [], writes = [];
  walk(classifier, node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'Object.getOwnPropertyDescriptor') inspected.push(node.arguments.map(arg => arg.getText(source)));
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.getText(source) === 'reason') reasonAccesses.push(node.getText(source));
    assert.equal(ts.isAwaitExpression(node), false);
  });
  assert.deepEqual(inspected, [["reason", "'message'"], ["reason", "'name'"]]);
  assert.deepEqual(reasonAccesses, []);
  walk(callback, node => {
    if (ts.isBinaryExpression(node) && node.left.getText(source) === 'facts.body_rejection_class') writes.push(node);
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].right.getText(source), 'bodyRejectionClass(reason)');
  const bodyTry = helper.body.statements.find(node => ts.isTryStatement(node) && node.tryBlock.getText(source).includes('await response.body()'));
  assert.equal(bodyTry.tryBlock.getText(source), '{ bytes = await response.body(); }');
  assert.equal(bodyTry.catchClause.getText(source), 'catch (reason) { facts.h20_progress_post_body = targetH20 ? h20ProgressSnapshot() : null; facts.body_rejected = true; facts.body_rejection_class = bodyRejectionClass(reason); facts.request_terminal_post_body = requestTerminal(request); throw reason; }');
  assert.equal(reconnect.getText(source), "const [latest] = await Promise.all([observeReconnect(latestReply(a,'20'),'latest'),observeReconnect(page.getByRole('button',{name:'Connect',exact:true}).click(),'click')]);");
});
for (const first of ['latest', 'click']) for (const timing of ['during close', 'after close']) test(`reload C SDK finite class freezes with ${first} first and body rejection ${timing}`, async () => {
  let firstText;
  const result = await jointExercise({ bodyReason: { value: { message: sdkMarkers[0][1]+'\n'+competingSuffix, name: 'TimeoutError' } }, schedule: async c => {
    c.acquire(); await flush();
    if (first === 'latest') c.rejectBody(); else c.rejectClick();
    await flush(); firstText = c.text();
    assert.equal(captured({ failure: { message: firstText } }).latest[0].body_rejection_class, first === 'latest' ? 'get_response_body_no_resource' : null);
    if (timing === 'after close') { c.close(); await flush(); assert.equal(c.ended(), true); }
    if (first === 'latest') c.rejectClick(); else c.rejectBody();
    await flush();
    assert.equal(c.text(), firstText);
    assert.equal(c.facts().latest[0].body_rejection_class, 'get_response_body_no_resource');
    c.close();
  } });
  assert.equal(result.failure.message, firstText);
  assert.equal(result.forwardedLatest, first === 'latest'); assert.equal(result.forwardedClick, first === 'click');
});
for (const prior of [undefined, 'previous-guard']) for (const closeFailure of [false, true]) test(`reload C classified rejection survives cleanup failures; prior=${!!prior}; close=${closeFailure}`, async () => {
  const result = await jointExercise({ prior, closeFailure, stopFailure: true, bodyReason: { value: { message: sdkMarkers[2][1] } }, schedule: async c => {
    c.acquire(); await flush(); c.rejectBody(); c.click(); await flush(); c.close();
  } });
  assert.equal(result.forwardedLatest, true);
  assert.equal(captured(result).latest[0].body_rejection_class, 'get_response_body_evicted');
  assert.deepEqual(result.evidence.cleanup, { request_listeners: true, browser: !closeFailure, fixture: false });
});

for (const first of ['latest','click']) for (const timing of ['during close','after close']) for (const loser of ['fulfilled','rejected']) {
  test(`reload C actual joint terminal snapshots freeze with ${first} first; ${loser} loser ${timing}`, async () => {
    let cached = null, text;
    const result = await jointExercise({ requestFailure: () => cached, schedule: async c => {
      c.emit('requestfinished'); c.acquire(); await flush();
      if (first === 'latest') c.rejectBody(); else c.rejectClick();
      await flush(); text = c.text();
      const atFailure = captured({failure:{message:text}}).latest[0];
      assert.deepEqual(atFailure.request_terminal_pre_body,{...noTerminal,requestfinished_observed:true});
      assert.deepEqual(atFailure.request_terminal_post_body,first === 'latest' ? {...noTerminal,requestfinished_observed:true} : null);
      if (timing === 'after close') { c.close(); await flush(); }
      cached = {errorText:'net::ERR_ABORTED\n'+terminalPrivate}; c.emit('requestfailed');
      if (first === 'latest') { if (loser === 'fulfilled') c.click(); else c.rejectClick(); }
      else if (loser === 'fulfilled') c.body(); else c.rejectBody();
      await flush(); assert.equal(c.text(),text);
      if (first === 'click') assert.deepEqual(c.facts().latest[0].request_terminal_post_body,
        {requestfinished_observed:true,requestfailed_observed:false,failure_class:'aborted'});
      c.close();
    } });
    assert.equal(result.failure.message,text);
    assert.equal(captured(result).reconnect.first_rejection,first);
  });
}
for (const first of ['latest','click']) test(`reload C actual joint public terminal events with ${first} success first`, async () => {
  const result = await jointExercise({ schedule: async c => {
    c.emit('requestfailed'); c.acquire(); await flush();
    if (first === 'latest') { c.emit('requestfinished'); c.body(); } else c.click();
    await flush();
    if (first === 'latest') c.click(); else { c.emit('requestfinished'); c.body(); }
    await flush(); c.close();
  } });
  assert.equal(result.failure,undefined);
  assert.deepEqual(result.evidence.observed.latest[0].request_terminal_pre_body,{...noTerminal,requestfailed_observed:true});
  assert.deepEqual(result.evidence.observed.latest[0].request_terminal_post_body,{...noTerminal,requestfinished_observed:true,requestfailed_observed:true});
});

// Exercise real registration, snapshots, sole body catch and final cleanup, not a copied observer.
const terminalControlled = `(async () => {
  ${facts.getText(source)}
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  ${progressSource}
  ${classifier.getText(source)}
  ${terminalSource}
  ${helper.getText(source)}
  ${guard.getText(source)}
  capture(() => ({observed,cleanup})); captureFailure(() => failure?.message);
  try {
    if (startupFailure) throw originalReason;
    ${installationSource}
    stage = 'terminal response';
    try { await readReply(acquisition,observed.create,value => value,() => true); }
    catch (reason) { forwarded(reason); throw reason; }
    if (laterFailure) throw originalReason;
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail.map(node => node.getText(source)).join('\n')}
})()`;
async function terminalExercise({ request, schedule, startupFailure = false, installFailure, removalFailures = [], closeFailure = false,
  stopFailure = false, laterFailure = false, bindingFailure = false, prior, missing = false, eventDuringRemoval } = {}) {
  let getter, failureText, failure, same = false, ended = false, failureReads = 0, bindings = 0, bodies = 0;
  const calls = [], output = [], env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const originalReason = { message: sdkMarkers[0][1]+'\n'+competingSuffix };
  const acquisition = deferred(), body = deferred(), close = deferred();
  const publicRequest = request === undefined ? { failure: () => { failureReads++; return null; } } : request;
  const seam = eventPage({ installFailure, removalFailures, eventDuringRemoval });
  let unrelatedEvents = 0;
  const unrelated = () => { unrelatedEvents++; };
  seam.on('requestfinished',unrelated); seam.on('requestfailed',unrelated);
  const response = {
    request: () => { bindings++; calls.push('bind'); if (bindingFailure) throw originalReason; return publicRequest; },
    status: () => 201, headers: () => ({ 'content-type': 'application/json' }),
    body: () => { bodies++; calls.push('body'); return body.promise; },
  };
  const execution = runInNewContext(terminalControlled, {
    process: { env }, console: { log: text => output.push(text) }, TextDecoder, decodeJson, markers: [PRIVATE],
    acquisition: acquisition.promise, originalReason, startupFailure, laterFailure,
    ownedPage: missing ? undefined : seam,
    ownedContext: missing ? undefined : { close: async () => {
      calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
      await close.promise;
      if (closeFailure) throw originalReason;
    } },
    ownedFixture: missing ? undefined : { owner: 'synthetic-owner', stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw originalReason; } },
    capture: value => { getter = value; }, captureFailure: value => { failureText = value; }, forwarded: reason => { same = reason === originalReason; },
    expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
  }, { timeout: 1000 }).then(() => { ended = true; }, error => { failure = error; ended = true; });
  const control = {
    acquire: () => acquisition.fulfill(response), body: () => body.fulfill(Buffer.from('{}')), rejectBody: () => body.reject(originalReason),
    close: () => close.fulfill(), emit: (event, identity = publicRequest) => seam.emit(event,identity),
    facts: () => getter().observed.create, cleanup: () => getter().cleanup, text: () => failureText(), ended: () => ended,
    request: publicRequest, seam, calls,
  };
  try { if (schedule) await schedule(control); else { control.acquire(); await flush(); control.body(); } }
  finally { acquisition.fulfill(response); body.fulfill(Buffer.from('{}')); close.fulfill(); await execution; await flush(); }
  for (const text of [PRIVATE, 'private.invalid', SID, RID, OID, TASK, DRAFT, ...titles]) {
    assert.equal([failure?.message ?? '', ...output].join('\n').includes(text), false);
  }
  const installed = seam.calls.filter(([kind,,listener]) => kind === 'on' && listener !== unrelated);
  const removed = seam.calls.filter(([kind]) => kind === 'off');
  if (startupFailure) assert.equal(removed.length, 0);
  else {
    assert.deepEqual(removed.map(([,event]) => event), ['requestfinished','requestfailed']);
    for (const [,event,listener] of installed) assert.ok(removed.some(([,e,l]) => e === event && l === listener));
  }
  assert.ok(seam.listeners.get('requestfinished').has(unrelated)); assert.ok(seam.listeners.get('requestfailed').has(unrelated));
  assert.deepEqual(calls.filter(call => call.endsWith('close') || call.endsWith('stop')), missing ? [] : ['browser-close','fixture-stop']);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure && !missing ? '1' : prior);
  assert.equal(Object.hasOwn(env,'PLAYWRIGHT_NO_COPY_PROMPT'), (closeFailure && !missing) || prior !== undefined);
  assert.deepEqual(output, [`Reload epoch cleanup: browser=${!missing && !closeFailure} fixture=${!missing && !stopFailure} request_listeners=${removed.length === 0 || removalFailures.length === 0}`, 'Reload epoch H20 progress: {"pre":null,"post":null,"first_failure":null,"late":null}']);
  return { failure, same, facts: control.facts(), cleanup: plain(control.cleanup()), failureReads, bindings, bodies, calls, installed, removed, unrelatedEvents };
}
const terminalMarkers = [
  ['aborted','ERR_ABORTED'], ['connection_reset','ERR_CONNECTION_RESET'], ['connection_closed','ERR_CONNECTION_CLOSED'],
  ['connection_refused','ERR_CONNECTION_REFUSED'], ['connection_aborted','ERR_CONNECTION_ABORTED'],
  ['content_length_mismatch','ERR_CONTENT_LENGTH_MISMATCH'], ['incomplete_chunked_encoding','ERR_INCOMPLETE_CHUNKED_ENCODING'],
];
const terminalPrivate = PRIVATE+'\nnet::ERR_CONNECTION_REFUSED\nnet::ERR_ABORTED';
for (const [token,marker] of terminalMarkers) for (const suffix of ['', '\n'+terminalPrivate, '\r\n'+terminalPrivate, ' Canceled', ' Canceled\n'+terminalPrivate, ' Canceled\r\n'+terminalPrivate]) {
  test(`reload C cached Request failure ${token}; complete boundary=${JSON.stringify(suffix.slice(0,10))}`, async () => {
    let reads = 0;
    const result = await terminalExercise({ request: { failure: () => { reads++; return { errorText: 'net::'+marker+suffix }; } } });
    assert.equal(reads, 2); assert.equal(result.bindings, 1); assert.equal(result.bodies, 1);
    assert.equal(result.facts.request_terminal_pre_body.failure_class, token);
    assert.equal(result.facts.request_terminal_post_body.failure_class, token);
    assert.equal(result.facts.body_rejection_class, null); assert.equal(result.facts.exact, true);
  });
}
for (const [,marker] of terminalMarkers) for (const suffix of ['X', '.', ' '+PRIVATE, '\t'+PRIVATE, '\r'+PRIVATE, ' CanceledX', ' Canceled '+PRIVATE]) {
  test(`reload C cached Request rejects ${marker} adjacent private suffix=${JSON.stringify(suffix.slice(0,2))}`, async () => {
    const result = await terminalExercise({ request: { failure: () => ({ errorText: 'net::'+marker+suffix+'\n'+terminalPrivate }) } });
    assert.equal(result.facts.request_terminal_post_body.failure_class, 'other_failure');
  });
}
for (const [label,make,expected] of [
  ['null cached result', () => ({ failure: () => null }), 'not_reported'],
  ['undefined cached result', () => ({ failure: () => undefined }), 'other_failure'],
  ['primitive cached result', () => ({ failure: () => PRIVATE }), 'other_failure'],
  ['missing errorText', () => ({ failure: () => ({}) }), 'other_failure'],
  ['inherited errorText', () => ({ failure: () => Object.create({ errorText: 'net::ERR_ABORTED' }) }), 'other_failure'],
  ['case near miss', () => ({ failure: () => ({ errorText: 'net::err_aborted' }) }), 'other_failure'],
  ['private leading marker', () => ({ failure: () => ({ errorText: terminalPrivate }) }), 'other_failure'],
  ['space leading marker', () => ({ failure: () => ({ errorText: ' net::ERR_ABORTED' }) }), 'other_failure'],
  ['API leading marker', () => ({ failure: () => ({ errorText: 'request.failure: net::ERR_ABORTED' }) }), 'other_failure'],
  ['function result own data', () => ({ failure: () => Object.assign(function () {}, { errorText: 'net::ERR_ABORTED' }) }), 'aborted'],
  ['cross realm cached result', () => ({ failure: () => runInNewContext('({errorText:"net::ERR_ABORTED"})') }), 'aborted'],
  ['huge conflicting private suffix', () => ({ failure: () => ({ errorText: 'net::ERR_ABORTED\n'+terminalPrivate.repeat(10000) }) }), 'aborted'],
  ['throwing failure method', () => ({ failure() { throw new Error(PRIVATE); } }), 'unavailable'],
  ['missing failure method', () => Object.create(null), 'unavailable'],
  ['nonfunction failure method', () => ({ failure: PRIVATE }), 'unavailable'],
  ['immediate SDK-like prototype', () => Object.create({ failure: () => null }), 'not_reported'],
  ['no prototype chain walk', () => Object.create(Object.create({ failure: () => null })), 'unavailable'],
  ['revoked Request', () => { const p = Proxy.revocable({},{}); p.revoke(); return p.proxy; }, 'unavailable'],
  ['revoked failure object', () => ({ failure: () => { const p = Proxy.revocable({},{}); p.revoke(); return p.proxy; } }), 'unavailable'],
]) test(`reload C guarded public Request ${label}`, async () => {
  const result = await terminalExercise({ request: make() });
  assert.equal(result.facts.request_terminal_pre_body.failure_class, expected);
  assert.equal(result.facts.request_terminal_post_body.failure_class, expected);
});
for (const value of [undefined, null, 1, false, {}, Symbol(PRIVATE), 1n]) test(`reload C cached errorText nonstring ${typeof value}`, async () => {
  const result = await terminalExercise({ request: { failure: () => ({ errorText: value }) } });
  assert.equal(result.facts.request_terminal_post_body.failure_class, 'other_failure');
});
for (const position of ['request own', 'request prototype', 'failure result', 'method function']) for (const behavior of ['accessor', 'throwing descriptor']) {
  test(`reload C ${position} ${behavior} never gets, enumerates or coerces private values`, async () => {
    let forbidden = 0, descriptors = 0, methodCalls = 0;
    const blocked = () => { forbidden++; throw new Error(PRIVATE); };
    const traps = { get: blocked, ownKeys: blocked, getPrototypeOf: blocked, getOwnPropertyDescriptor(target,key) {
      descriptors++; if (behavior === 'throwing descriptor') throw new Error(PRIVATE);
      return Object.getOwnPropertyDescriptor(target,key);
    } };
    const key = position === 'failure result' ? 'errorText' : 'failure';
    const target = Object.create(null);
    Object.defineProperty(target,key,{ configurable: true, get: blocked });
    let request;
    if (position === 'failure result') request = { failure: () => { methodCalls++; return new Proxy(target,traps); } };
    else if (position === 'request prototype') request = Object.create(new Proxy(target,traps));
    else if (position === 'method function') {
      const method = new Proxy(() => { methodCalls++; return null; }, { get: blocked, ownKeys: blocked });
      request = { failure: method };
    } else request = new Proxy(target,traps);
    const result = await terminalExercise({ request });
    assert.equal(forbidden, 0);
    let expected = 'unavailable';
    if (position === 'method function') expected = 'not_reported';
    else if (position === 'failure result' && behavior === 'accessor') expected = 'other_failure';
    assert.equal(result.facts.request_terminal_post_body.failure_class, expected);
    assert.equal(descriptors, position === 'method function' ? 0 : 2);
    assert.equal(methodCalls, ['failure result','method function'].includes(position) ? 2 : 0);
  });
}
for (const phase of ['before bind', 'after pre', 'after post']) for (const events of ['finished','failed','both','unrelated']) for (const rejection of [false,true]) {
  test(`reload C exact Request identity ${events} ${phase}; body rejects=${rejection}`, async () => {
    let frozenPre, frozenPost;
    const result = await terminalExercise({ schedule: async c => {
      const emit = () => {
        const identity = events === 'unrelated' ? { failure: () => null } : c.request;
        if (events !== 'failed') { c.emit('requestfinished',identity); c.emit('requestfinished',identity); }
        if (events === 'failed' || events === 'both') { c.emit('requestfailed',identity); c.emit('requestfailed',identity); }
      };
      if (phase === 'before bind') emit();
      c.acquire(); await flush();
      frozenPre = plain(c.facts().request_terminal_pre_body);
      assert.equal(Object.isFrozen(c.facts().request_terminal_pre_body), true);
      if (phase === 'after pre') emit();
      if (rejection) c.rejectBody(); else c.body();
      await flush(); frozenPost = plain(c.facts().request_terminal_post_body);
      assert.equal(Object.isFrozen(c.facts().request_terminal_post_body), true);
      if (phase === 'after post') emit();
      assert.deepEqual(plain(c.facts().request_terminal_pre_body), frozenPre);
      assert.deepEqual(plain(c.facts().request_terminal_post_body), frozenPost);
      c.close();
    } });
    const finite = when => ({ requestfinished_observed: when && ['finished','both'].includes(events), requestfailed_observed: when && ['failed','both'].includes(events), failure_class: 'not_reported' });
    assert.deepEqual(frozenPre, finite(phase === 'before bind'));
    assert.deepEqual(frozenPost, finite(phase !== 'after post'));
    assert.equal(result.bindings, 1); assert.equal(result.failureReads, 2); assert.equal(result.bodies, 1);
    assert.equal(result.same, rejection); assert.equal(result.facts.body_rejection_class, rejection ? 'get_response_body_no_resource' : null);
    assert.equal(result.facts.exact, !rejection);
  });
}
for (const bindingFailure of [false,true]) for (const rejection of [false,true]) test(`reload C unbound identity remains null; throwing bind=${bindingFailure}; rejection=${rejection}`, async () => {
  const result = await terminalExercise({ request: null, bindingFailure, schedule: async c => {
    c.acquire(); await flush(); if (rejection) c.rejectBody(); else c.body(); await flush(); c.close();
  } });
  assert.equal(result.bindings, 1); assert.equal(result.bodies, 1); assert.equal(result.failureReads, 0);
  assert.equal(result.facts.request_terminal_pre_body, null); assert.equal(result.facts.request_terminal_post_body, null);
  assert.equal(result.same, rejection);
});
test('reload C failure class changes between snapshots without replacing the original rejection', async () => {
  let cached = null, reads = 0;
  const result = await terminalExercise({ request: { failure: () => { reads++; return cached; } }, schedule: async c => {
    c.emit('requestfinished'); c.acquire(); await flush();
    cached = { errorText: 'net::ERR_CONNECTION_RESET\n'+terminalPrivate }; c.emit('requestfailed'); c.rejectBody();
    await flush(); const text = c.text(); cached = { errorText: 'net::ERR_ABORTED' }; c.emit('requestfailed');
    assert.equal(c.text(),text); c.close();
  } });
  assert.equal(reads,2); assert.equal(result.same,true);
  assert.deepEqual(plain(result.facts.request_terminal_pre_body), { ...noTerminal, requestfinished_observed:true });
  assert.deepEqual(plain(result.facts.request_terminal_post_body), { requestfinished_observed:true, requestfailed_observed:true, failure_class:'connection_reset' });
});
for (const startup of ['before registration','partial first','partial second','complete']) for (const removal of ['none','finished','failed','both']) for (const prior of [undefined,'previous-guard']) {
  test(`reload C listener ownership ${startup}; removal failure=${removal}; prior=${!!prior}`, async () => {
    const startupFailure = startup === 'before registration';
    let installFailure;
    if (startup === 'partial first') installFailure = 'requestfinished';
    else if (startup === 'partial second') installFailure = 'requestfailed';
    const removalFailures = ['finished','failed'].filter(name => removal === name || removal === 'both').map(name => 'request'+name);
    const result = await terminalExercise({ startupFailure, installFailure, removalFailures, prior, schedule: async c => {
      c.acquire(); await flush(); c.body(); await flush();
      // Removal runs before context close, even when either owned removal throws.
      if (!startupFailure) assert.equal(c.seam.calls.filter(([kind]) => kind === 'off').length,2);
      c.close();
    } });
    assert.equal(result.cleanup.request_listeners, startupFailure || removal === 'none');
    let installed = 2;
    if (startup === 'partial first') installed = 1;
    else if (startupFailure) installed = 0;
    assert.equal(result.installed.length, installed);
    if (startup !== 'complete') assert.ok(result.failure.message.startsWith('Reload epoch failed:'));
    else if (removal !== 'none') assert.equal(result.failure.message,'Reload epoch request listener cleanup failed');
    else assert.equal(result.failure,undefined);
  });
}
for (const firstFailure of [false,true]) for (const closeFailure of [false,true]) for (const prior of [undefined,'previous-guard']) {
  test(`reload C removal failure priority; first=${firstFailure}; close=${closeFailure}; prior=${!!prior}`, async () => {
    const result = await terminalExercise({ laterFailure:firstFailure, closeFailure, stopFailure:true, prior, removalFailures:['requestfinished','requestfailed'], schedule: async c => {
      c.acquire(); await flush(); c.body(); await flush(); const first = c.text();
      c.emit('requestfailed'); assert.equal(c.text(),first); c.close();
    } });
    assert.equal(result.cleanup.request_listeners,false); assert.equal(result.cleanup.browser,!closeFailure); assert.equal(result.cleanup.fixture,false);
    assert.equal(result.failure.message.startsWith('Reload epoch failed:'),firstFailure);
    if (!firstFailure) assert.equal(result.failure.message,'Reload epoch request listener cleanup failed');
  });
}
test('reload C startup without page/context/fixture is a clean no-listener lifecycle', async () => {
  const result = await terminalExercise({ startupFailure:true, missing:true });
  assert.deepEqual(result.cleanup,{request_listeners:true,browser:false,fixture:false});
  assert.deepEqual(plain(result.facts),blank());
});
test('reload C late removal and context events cannot rewrite frozen snapshots or first failure', async () => {
  let pre,post,text;
  const result = await terminalExercise({ eventDuringRemoval: (event,seam) => seam.emit('requestfailed',Object.create(null)), schedule: async c => {
    c.acquire(); await flush(); c.rejectBody(); await flush();
    pre = plain(c.facts().request_terminal_pre_body); post = plain(c.facts().request_terminal_post_body); text = c.text();
    c.emit('requestfinished'); c.emit('requestfailed'); c.close(); await flush();
    assert.deepEqual(plain(c.facts().request_terminal_pre_body),pre); assert.deepEqual(plain(c.facts().request_terminal_post_body),post);
    assert.equal(c.text(),text);
  } });
  assert.equal(result.failure.message,text); assert.equal(result.unrelatedEvents >= 4,true);
});
test('reload C actual terminal source adds only synchronous finite observations at the original boundary', () => {
  const walk = (node,visit) => { visit(node); ts.forEachChild(node,child => walk(child,visit)); };
  const calls = [], awaits = [], registrations = [], removals = [];
  walk(helper,node => {
    if (ts.isAwaitExpression(node)) awaits.push(node.expression.getText(source));
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
  });
  assert.deepEqual(awaits,['promise','response.body()']);
  assert.equal(calls.filter(name => name === 'response.request').length,1);
  assert.equal(calls.filter(name => name === 'response.body').length,1);
  assert.equal(calls.filter(name => name === 'requestTerminal').length,3); // Pre, success post, rejection post.
  for (const helper of terminalHelpers) walk(helper,node => assert.equal(ts.isAwaitExpression(node),false));
  walk(callback,node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'page.on' && /^'request(finished|failed)'$/.test(node.arguments[0].getText(source))) registrations.push(node.getText(source));
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'page.off') removals.push(node.getText(source));
  });
  assert.deepEqual(registrations,["page.on('requestfinished',onRequestFinished)","page.on('requestfailed',onRequestFailed)"]);
  assert.deepEqual(removals,["page.off('requestfinished',onRequestFinished)","page.off('requestfailed',onRequestFailed)"]);
  assert.ok(installation.every(node => node.pos < statements.find(node => node.getText(source).startsWith("stage = 'UI creation")).pos));
  const removalText = attempt.finallyBlock.getText(source);
  assert.ok(removalText.indexOf("page.off('requestfailed'") < removalText.indexOf('context?.close()'));
  const identityOnly = declarations.filter(node => /^const onRequest/.test(node.getText(source))).map(node => node.getText(source));
  assert.deepEqual(identityOnly,["const onRequestFinished = request => { finishedRequests.add(request); };","const onRequestFailed = request => { failedRequests.add(request); };"]);
  const success = callback.body.statements.at(-1).getText(source), output = [];
  runInNewContext(success,{console:{log:text => output.push(text)},observed:{create:blank(),task:blank(),latest:[blank(),blank()],reconnect:{latest:'fulfilled',click:'fulfilled',first_rejection:null}}});
  assert.ok(output[0].includes('Reload epoch evidence: documents=2 reloads=1'));
  const finite = JSON.parse(output[0].slice(output[0].indexOf(' request_terminal=')+' request_terminal='.length));
  assert.deepEqual(finite,{create:{pre:null,post:null},task:{pre:null,post:null},latest:[{pre:null,post:null},{pre:null,post:null}]});
});

const progress = value => ({ stream_request_observed: value });
for (const [label, request] of [
  ['origin', { origin: 'http://127.0.0.2' }], ['session', { session: OTHER }], ['method', { method: 'HEAD' }],
  ['frame', { frame: 'other' }], ['page', { page: 'other' }], ['head', { after: cursor('l','19','3','','') }],
  ['cursor rank', { after: cursor('l','20','2',RID,'e:14:0') }], ['H1 delayed same Page/Frame at load1', { after: empty().live_after }],
  ['missing query', { query: '' }], ['wrong query', { query: 'before=x' }],
  ['fragment', { query: `${new URLSearchParams({after:completed().live_after})}#synthetic` }],
  ['URL credentials', { origin: 'http://synthetic@127.0.0.1' }], ['extra query', { query: new URLSearchParams({ after: completed().live_after, extra: 'x' }).toString() }],
  ['duplicate after', { query: new URLSearchParams([['after',completed().live_after],['after',completed().live_after]]).toString() }],
  ['path', { suffix: '' }], ['bearer', { headers: { authorization: 'Bearer wrong' } }],
  ['cookie', { headers: { authorization: 'Bearer synthetic-owner', cookie: 'synthetic' } }],
  ['Origin header', { headers: { authorization: 'Bearer synthetic-owner', origin: 'http://127.0.0.2' } }],
]) test(`reload C actual request callback cannot witness wrong ${label}`, async () => {
  const result = await jointExercise({ renderer: true, schedule: async c => {
    c.request(request); assert.deepEqual(plain(c.witness()),progress(false));
    c.acquire(); await flush(); c.body(); c.click(); await flush(); c.close();
  } });
  assert.equal(result.failure,undefined);
  assert.deepEqual(result.late,{pre:progress(false),post:progress(false),first_failure:null,late:progress(false)});
});
for (const headers of [{ authorization:'Bearer synthetic-owner' }, { authorization:'Bearer synthetic-owner', origin:'http://127.0.0.1' }]) {
  test(`reload C exact H20 callback accepts existing Origin predicate; present=${!!headers.origin}`, async () => {
    const result = await jointExercise({ renderer:true, schedule:async c => {
      c.request({headers}); assert.deepEqual(plain(c.witness()),progress(true));
      c.acquire(); await flush(); c.body(); c.click(); await flush(); c.close();
    } });
    assert.deepEqual(result.late,{pre:progress(true),post:progress(true),first_failure:null,late:progress(true)});
  });
}
for (const throwing of ['frame','page']) for (const positive of [false,true]) test(`reload C guarded ${throwing} binding cannot replace rejection; prior witness=${positive}`, async () => {
  const result = await jointExercise({ renderer:true, schedule:async c => {
    if (positive) c.request();
    c.request({throwing}); c.request();
    assert.deepEqual(plain(c.witness()),progress(positive ? true : null));
    c.acquire(); await flush(); c.rejectBody(); c.click(); await flush(); c.close();
  } });
  assert.equal(result.forwardedLatest,true);
  assert.deepEqual(result.late.pre,progress(positive ? true : null));
  assert.deepEqual(result.late.post,result.late.pre);
});
test('reload C actual callback is unarmed even for exact H20', async () => {
  const result = await jointExercise({ schedule:async c => {
    c.request(); assert.equal(c.witness(),null); c.acquire(); await flush(); c.body(); c.click(); await flush(); c.close();
  } });
  assert.deepEqual(result.late,{pre:null,post:null,first_failure:null,late:null});
});
test('reload C witness runs beyond original four-read cap without hiding duplicates', async () => {
  const result = await jointExercise({ renderer:true, schedule:async c => {
    for (let n=0;n<4;n++) c.request({after:empty().live_after});
    assert.deepEqual(plain(c.witness()),progress(false));
    c.request(); c.request(); assert.deepEqual(plain(c.witness()),progress(true));
    c.acquire(); await flush(); c.body(); c.click(); await flush(); c.close();
  } });
  assert.equal(result.evidence.network.otherRead,2);
});
for (const first of ['latest','click','success']) for (const timing of ['before body','between body','after body','during cleanup','after cleanup','absent']) {
  test(`reload C frozen H20 boundary ${first}; progress ${timing}`, async () => {
    let pre,post,firstSnapshot,text;
    const result = await jointExercise({ renderer:true, schedule:async c => {
      if (timing === 'before body') c.request();
      c.acquire(); await flush(); pre = c.rawFacts().h20_progress_pre_body;
      assert.equal(Object.isFrozen(pre),true);
      if (timing === 'between body') c.request();
      if (first === 'latest') c.rejectBody(); else if (first === 'click') c.rejectClick(); else { c.body(); c.click(); }
      await flush(); firstSnapshot = c.firstWitness(); text = c.text(); post = c.rawFacts().h20_progress_post_body;
      if (first !== 'success') assert.equal(Object.isFrozen(firstSnapshot),true);
      if (timing === 'after body' || timing === 'during cleanup') c.request();
      if (first === 'click') { c.rejectBody(); await flush(); post = c.rawFacts().h20_progress_post_body; }
      else if (first === 'latest') c.click();
      assert.equal(Object.isFrozen(post),true);
      assert.throws(() => { pre.stream_request_observed = true; },TypeError);
      assert.throws(() => { post.stream_request_observed = true; },TypeError);
      c.close(); await flush();
      if (timing === 'after cleanup') c.request();
      assert.ok(c.rawFacts().h20_progress_pre_body === pre); assert.ok(c.rawFacts().h20_progress_post_body === post);
      assert.ok(c.firstWitness() === firstSnapshot); assert.equal(c.text(),text);
    } });
    const before = timing === 'before body', between = timing === 'between body', late = timing === 'after body' || timing === 'during cleanup';
    assert.deepEqual(result.late.pre,progress(before));
    assert.deepEqual(result.late.post,progress(before || between || (first === 'click' && late)));
    assert.deepEqual(result.late.first_failure,first === 'success' ? null : progress(before || between));
    assert.deepEqual(result.late.late,progress(before || between || late));
    assert.equal(result.forwardedLatest,first === 'latest'); assert.equal(result.forwardedClick,first === 'click');
    assert.equal(result.failure === undefined,first === 'success');
    assert.equal(result.evidence.observed.latest[0].h20_progress_pre_body,null);
  });
}
test('reload C other reply facts remain null even after H20 witness is armed and positive', async () => {
  const outcome = await runInNewContext(`(async () => {
    ${facts.getText(source)} ${declarations.map(node => node.getText(source)).join('\n')}
    ${progressSource} ${terminalSource} ${classifier.getText(source)} ${helper.getText(source)}
    fixture = syntheticFixture; expectedH20 = {path:'synthetic',after:'synthetic'}; h20Progress = true;
    const facts = replyFacts(); await readReply(Promise.resolve(response),facts,value => value,() => true);
    return facts;
  })()`,{response:{status:()=>201,request:()=>null,body:async()=>Buffer.from('{}'),headers:()=>({'content-type':'application/json'})},
    TextDecoder,Buffer,decodeJson,process:{env:{}},syntheticFixture:{owner:'synthetic-owner'},markers:[],expect:actual=>({toBe:expected=>assert.equal(actual,expected)})});
  assert.equal(outcome.h20_progress_pre_body,null); assert.equal(outcome.h20_progress_post_body,null);
});
for (const key of ['origin','authorization','mainFrame']) test(`reload C actual guarded witness tolerates throwing ${key} binding`, () => {
  const target = runInNewContext(`let expectedH20 = {path:'/events',after:'synthetic'},h20Progress=false;
    ${progressSource}\n({observeH20Progress,h20ProgressSnapshot})`,{fixture:{origin:'http://127.0.0.1',owner:'synthetic-owner'},page:{mainFrame(){throw new Error(PRIVATE);}}});
  const url = new URL('http://127.0.0.1/events?after=synthetic'),headers={authorization:'Bearer synthetic-owner'};
  if (key === 'origin') Object.defineProperty(url,'origin',{get(){throw new Error(PRIVATE);}});
  if (key === 'authorization') Object.defineProperty(headers,'authorization',{get(){throw new Error(PRIVATE);}});
  target.observeH20Progress({method:()=> 'GET',frame:()=>({})},url,headers);
  assert.deepEqual(plain(target.h20ProgressSnapshot()),progress(null));
});
for (const closeFailure of [false,true]) for (const stopFailure of [false,true]) test(`reload C H20 collection does not hide cleanup failure; close=${closeFailure}; stop=${stopFailure}`, async () => {
  const result = await jointExercise({renderer:true,closeFailure,stopFailure,schedule:async c => {
    c.acquire(); await flush(); c.rejectBody(); c.click(); await flush(); c.request(); c.close();
  }});
  assert.equal(result.forwardedLatest,true); assert.deepEqual(result.late.first_failure,progress(false)); assert.deepEqual(result.late.late,progress(true));
  assert.deepEqual(result.evidence.cleanup,{request_listeners:true,browser:!closeFailure,fixture:!stopFailure});
});
test('reload C actual source binds arming and snapshots to preserved flow without new asynchronous work', () => {
  const walk = (node,visit) => { visit(node); ts.forEachChild(node,child => walk(child,visit)); };
  const calls = [], awaits = [];
  walk(progressObserver,node => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    if (ts.isAwaitExpression(node)) awaits.push(node.getText(source));
  });
  assert.deepEqual(awaits,[]); assert.deepEqual(calls,['request.method','url.searchParams.get','request.frame','page.mainFrame','frame.page']);
  assert.ok(requestCallback.getText(source).indexOf('observeH20Progress(request,url,headers)') < requestCallback.getText(source).indexOf('reads.length < 4'));
  assert.equal(armProgress, "expectedH20 = Object.freeze({path:`/v1/sessions/${a}/conversation/events`,after:`g11l.${Buffer.from(JSON.stringify([1,a,'20','3','',''])).toString('base64url')}`});\nh20Progress = false;");
  assert.equal(statements[armIndex-1].getText(source),'quiet = false;'); assert.ok(statements[armIndex+2] === reconnect);
  const before = statements.slice(0,armIndex).map(node => node.getText(source)).join('\n');
  for (const proof of ['expect(oldDocumentUnavailable).toBe(true)',"final.sequence_count === '20'",'token entry alone cannot authorize retained-hash reads','provider(await fixture.inspect(),2,1,1);']) assert.ok(before.includes(proof));
  const text = helper.getText(source), rejection = helper.body.statements.find(node => ts.isTryStatement(node) && node.tryBlock.getText(source).includes('await response.body()'));
  assert.ok(text.indexOf('facts.h20_progress_pre_body =') < rejection.pos-helper.getStart(source));
  assert.ok(rejection.catchClause.getText(source).startsWith('catch (reason) { facts.h20_progress_post_body = targetH20 ? h20ProgressSnapshot() : null;'));
  assert.ok(latest.getText(source).includes(",524288,head === '20')"));
  assert.ok(attempt.catchClause.getText(source).includes('firstFailureH20 = h20ProgressSnapshot();'));
  assert.equal(tail[1].declarationList.declarations[0].initializer.expression.getText(source),'Object.freeze');
  assert.ok(tail[2].getText(source).startsWith('console.log(`Reload epoch H20 progress:'));
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
// These public Fetch/body seams establish prerequisites, not actual transport or a historical cause.
for (const option of ['valid','partial JSON','partial UTF8','incomplete JSON','incomplete UTF8','body rejection','schema','cursor','session','selection superseded','connection superseded']) {
  test(`reload C public H20 stream requires complete validated current Latest; ${option}`, async t => {
    const calls = [], encoder = new TextEncoder();
    let controller, bodyCancelled = 0, streamCancelled = 0, client;
    const value = completed();
    if (option === 'schema') value.api_version = 2;
    if (option === 'cursor') value.live_after = cursor('l','19','3','','');
    if (option === 'session') value.session.session_id = OTHER;
    const bytes = encoder.encode(JSON.stringify(value));
    const body = new ReadableStream({ start(c) { controller = c; }, cancel() { bodyCancelled++; } });
    client = createDisplayClient({ fetch: async (path,init) => {
      calls.push({path,init});
      if (path === '/v1/settings') return reply({api_version:1,workspaces:['/synthetic/a'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:true});
      if (path.startsWith('/v1/sessions?')) return reply({api_version:1,entries:[],next_after_id:null,has_more:false});
      if (path === `/v1/sessions/${SID}/conversation`) return new Response(body,{headers:{'Content-Type':'application/json'}});
      if (path === `/v1/sessions/${OTHER}/conversation`) return reply({...empty(),session_id:OTHER,session:session('1',{session_id:OTHER}),live_after:`g11l.${Buffer.from(JSON.stringify([1,OTHER,'1','3','',''])).toString('base64url')}`});
      if (path.includes('/conversation/events?')) {
        if (path.startsWith(`/v1/sessions/${SID}/`)) {
          const installed = client.snapshot().selected.store;
          assert.equal(installed.observed_head,'20'); assert.equal(installed.live_after,completed().live_after);
          assert.equal(installed.blocks[0].view.state,'completed');
          assert.equal(new URL(path,'http://127.0.0.1').searchParams.get('after'),installed.live_after);
        }
        return new Response(new ReadableStream({cancel() { streamCancelled++; }}),{headers:{'Content-Type':'text/event-stream'}});
      }
      throw new Error('Unexpected synthetic request');
    }});
    t.after(async () => { client.disconnect(); await flush(); });
    const h20Streams = () => calls.filter(c => c.path === `/v1/sessions/${SID}/conversation/events?after=${encodeURIComponent(completed().live_after)}`);
    await client.connect('0123456789abcdef'.repeat(4));
    const selected = client.selectSession(SID); await flush();
    assert.equal(h20Streams().length,0); assert.equal(client.snapshot().selected.store,null);
    let cut = Math.floor(bytes.length/2);
    if (option === 'partial UTF8') cut = bytes.indexOf(0xe9) + 1;
    if (option === 'partial JSON' || option === 'partial UTF8') {
      controller.enqueue(bytes.slice(0,cut)); await flush();
      assert.equal(h20Streams().length,0); assert.equal(client.snapshot().selected.store,null);
      controller.enqueue(bytes.slice(cut)); controller.close();
    } else if (option === 'incomplete JSON') { controller.enqueue(bytes.slice(0,cut)); controller.close(); }
    else if (option === 'incomplete UTF8') { controller.enqueue(Uint8Array.from([0xe9,0x9b])); controller.close(); }
    else if (option === 'body rejection') controller.error(new Error(PRIVATE));
    else if (option === 'selection superseded' || option === 'connection superseded') {
      if (option === 'connection superseded') { client.disconnect(); await client.connect('fedcba9876543210'.repeat(4)); }
      await client.selectSession(OTHER); await flush();
      assert.equal(bodyCancelled,1); assert.equal(client.snapshot().selected.session_id,OTHER);
      assert.equal(client.snapshot().selected.store.observed_head,'1');
    } else { controller.enqueue(bytes); controller.close(); }
    await selected; await flush();
    const success = ['valid','partial JSON','partial UTF8'].includes(option);
    assert.equal(h20Streams().length,success ? 1 : 0);
    if (success) assert.equal(client.snapshot().selected.store.observed_head,'20');
    else if (!option.endsWith('superseded')) {
      assert.equal(client.snapshot().selected.store,null); assert.equal(client.snapshot().selected.observation,'disconnected');
      assert.ok(client.snapshot().selected.observation_error);
    }
    assert.equal(calls.every(c => c.init.method === 'GET'),true);
    client.disconnect(); await flush(); assert.equal(streamCancelled,success || option.endsWith('superseded') ? 1 : 0);
  });
}

const cleared = { connection: 'disconnected', settings: null, catalog: null, catalog_loading: false,
  error: null, draft: '', pending: [], selected: null };
for (const stale of ['reader', 'response']) for (const timing of ['before fresh Connect', 'after fresh Connect']) for (const taskPoint of ['fetch', 'decoded']) {
  test(`reload C independent clients ignore old ${taskPoint} Task202 and ${stale} ${timing}`, async t => {
    const calls = [], oldPublications = [], freshPublications = [], streams = [];
    let next = 0, deliver, lateStream, freshClient, freshUnsubscribe, freshConnection;
    let decodedBytes = 0, unlockedDiscards = 0;
    function clientFor(fresh) {
      return createDisplayClient({ crypto: { randomUUID: () => { assert.equal(fresh, false); return [OID, RID][next++]; } }, fetch: async (path, init) => {
        calls.push({ fresh, path, init });
        if (path === '/v1/settings') return reply({ api_version: 1, workspaces: ['/synthetic/a'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true });
        if (path.startsWith('/v1/sessions?')) return reply({ api_version: 1, entries: [], next_after_id: null, has_more: false });
        if (path.endsWith('/conversation')) return reply(fresh ? completed() : empty());
        if (path.includes('/conversation/events?')) {
          let controller, cancels = 0;
          const body = new ReadableStream({ start(c) { controller = c; }, cancel() { cancels++; } });
          const stream = { fresh, init, push: value => controller.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`)),
            get cancels() { return cancels; }, response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }) };
          streams.push(stream);
          if (!fresh && stale === 'response') return new Promise(resolve => { lateStream = () => resolve(stream.response); });
          return stream.response;
        }
        if (!fresh && path === `/v1/sessions/${SID}/runs` && init.method === 'POST') return new Promise(resolve => { deliver = resolve; });
        throw new Error('Unexpected synthetic request');
      } });
    }
    const oldClient = clientFor(false), oldUnsubscribe = oldClient.subscribe(value => oldPublications.push(value));
    t.after(async () => { oldUnsubscribe(); freshUnsubscribe?.(); oldClient.disconnect(); freshClient?.disconnect(); await flush(); });
    await oldClient.connect('0123456789abcdef'.repeat(4)); await oldClient.selectSession(SID); await flush();
    oldClient.setDraft(TASK); const sending = oldClient.sendTask(); await flush();
    const captured = oldClient.snapshot().pending[0], mutation = calls.find(call => call.init.method === 'POST');
    assert.deepEqual(captured.command, { id: OID, kind: 'task', session_id: SID, body: taskCommand });
    assert.equal(captured.phase, 'sending'); assert.equal(captured.receipt, null); assert.equal(captured.reply, null);
    assert.equal(Object.isFrozen(captured.command) && Object.isFrozen(captured.command.body), true);
    assert.throws(() => { captured.command.body.text = 'mutated'; }, TypeError);
    if (stale === 'reader') {
      streams[0].push(batch([{ kind: 'block.upsert', block: running() }], '6')); await flush();
      assert.equal(oldClient.snapshot().selected.store.observed_head, '6');
    }
    oldClient.setDraft(DRAFT);
    function retire() {
      if (stale === 'reader') streams[0].push(batch([{ kind: 'block.upsert', block: { ...running(), revision: '7', state: 'failed' } }], '7'));
      oldClient.disconnect();
      assert.equal(mutation.init.signal.aborted, true); assert.equal(streams[0].init.signal.aborted, true);
      assert.deepEqual(oldClient.snapshot(), cleared);
    }
    async function connectFresh() {
      assert.deepEqual(oldClient.snapshot(), cleared);
      freshClient = clientFor(true);
      assert.notEqual(freshClient, oldClient); assert.deepEqual(freshClient.snapshot(), cleared);
      freshUnsubscribe = freshClient.subscribe(value => freshPublications.push(value));
      await freshClient.connect('fedcba9876543210'.repeat(4)); await freshClient.selectSession(SID); await flush();
      freshClient.setDraft(DRAFT);
      const value = freshClient.snapshot();
      assert.equal(value.connection, 'connected'); assert.equal(value.selected.observation, 'streaming');
      assert.equal(value.selected.store.observed_head, '20'); assert.equal(value.selected.store.live_after, completed().live_after);
      assert.equal(value.selected.store.blocks[0].view.state, 'completed'); assert.equal(value.selected.store.blocks[0].view.result_recorded, true);
      assert.deepEqual(value.pending, []); assert.equal(value.draft, DRAFT);
    }
    if (taskPoint === 'fetch') {
      retire(); await flush();
      if (timing === 'after fresh Connect') await connectFresh();
    } else {
      // Retire through the public method after real closed decoding, before command publication.
      // This controlled body seam is not a physically withheld browser response or cross-realm promise.
      const bytes = new TextEncoder().encode(JSON.stringify(acceptance()));
      let locked = true, reads = 0;
      deliver({ status: 202, headers: new Headers({ 'Content-Type': 'application/json' }), body: {
        getReader: () => ({ read: async () => {
          if (reads++ === 0) { decodedBytes += bytes.length; return { value: bytes, done: false }; }
          return { value: undefined, done: true };
        }, cancel: async () => {}, releaseLock: () => { locked = false; } }),
        cancel: async () => {
          assert.equal(locked, false); unlockedDiscards++;
          retire();
          if (timing === 'after fresh Connect') freshConnection = connectFresh();
        },
      } });
      await sending; await freshConnection; await flush();
      assert.equal(decodedBytes, bytes.length); assert.equal(unlockedDiscards, 1);
    }
    const oldBefore = oldClient.snapshot(), oldCount = oldPublications.length;
    const freshBefore = freshClient?.snapshot(), freshCount = freshPublications.length, callsBefore = calls.length;
    if (stale === 'response') { streams[0].push(batch([{ kind: 'block.upsert', block: running() }], '6')); lateStream(); }
    if (taskPoint === 'fetch') deliver(reply(acceptance(), 202));
    await sending; await flush();
    assert.deepEqual(oldClient.snapshot(), oldBefore); assert.equal(oldPublications.length, oldCount);
    assert.deepEqual(freshClient?.snapshot(), freshBefore); assert.equal(freshPublications.length, freshCount);
    assert.equal(calls.length, callsBefore); assert.equal(streams[0].cancels, 1);
    if (timing === 'before fresh Connect') await connectFresh();
    assert.deepEqual(oldClient.snapshot(), cleared);
    assert.equal(oldPublications.some(value => value.pending.some(item => item.phase === 'accepted')), false);
    assert.equal(oldPublications.some(value => value.selected?.store?.observed_head === '7'), false);
    assert.deepEqual(captured.command.body, taskCommand); assert.equal(captured.phase, 'sending');
    assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
    assert.equal(mutation.init.body, JSON.stringify(taskCommand)); assert.equal(next, 2);
    for (const fresh of [false, true]) {
      const value = fresh ? completed() : empty();
      assert.deepEqual(calls.filter(call => call.fresh === fresh).map(call => call.path), [
        '/v1/settings', '/v1/sessions?limit=32', `/v1/sessions/${SID}/conversation`,
        `/v1/sessions/${SID}/conversation/events?after=${encodeURIComponent(value.live_after)}`,
        ...fresh ? [] : [`/v1/sessions/${SID}/runs`],
      ]);
    }
    assert.equal(calls.length, 9);
    oldClient.disconnect(); freshClient.disconnect(); await flush();
    assert.equal(streams.every(stream => stream.cancels === 1 && stream.init.signal.aborted), true);
    assert.deepEqual(oldClient.snapshot(), cleared); assert.deepEqual(freshClient.snapshot(), cleared);
  });
}
