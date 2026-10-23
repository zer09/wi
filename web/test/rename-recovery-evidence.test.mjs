import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const url = new URL('../e2e/rename-recovery.spec.mjs', import.meta.url);
const text = readFileSync(url, 'utf8');
const source = ts.createSourceFile('rename.js', text, ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const attempt = callback.body.statements.find(ts.isTryStatement);
const statements = attempt.tryBlock.statements;
const start = statements.findIndex(node => node.getText(source) === 'retryPage = page;');
const end = statements.findIndex(node => node.getText(source).startsWith("stage = 'select stable seed"));
assert.ok(start >= 0 && end > start);
const names = ['previousNoCopyPrompt', 'failure', 'stage', 'retry', 'cleanup', 'faults', 'retryPage', 'manifestRequest',
  'finishedRequests', 'failedRequests', 'onManifestFinished', 'onManifestFailed', 'snapshots', 'listenerCleanup'];
const declarations = callback.body.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => names.includes(item.name.text)));
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1).map(node => node.getText(source)).join('\n');
// Execute the real declarations, registration, binding, settlement, snapshots, removal and cleanup.
const controlled = `(async () => {
  ${declarations.map(node => node.getText(source)).join('\n')}
  capture(() => ({ ...retry }));
  const fixture = ownedFixture, context = ownedContext, loss = ownedLoss;
  try { ${statements.slice(start, end).map(node => node.getText(source)).join('\n')} }
  ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail}
})()`;
const privateText = 'synthetic-private-rename https://private.invalid/?token=private';
const fields = ['statuses', 'manifest_finish', 'accepted_dom', 'native_inspection', 'native_equality', 'no_work'];
const stages = ['status validation', 'manifest finish', 'accepted DOM', 'native mutation inspection', 'native mutation equality', 'no-work checks'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plain = value => JSON.parse(JSON.stringify(value));

function launch({ fail, cleanupFailures = [], absent = [], beforeBinding = [], afterBinding = [], unrelatedEvents = [],
  lateBinding, closeEvents = [], postRemovalEvents = [], pendingFinish = false, removalFailures = [] } = {}) {
  const output = [], order = [], guards = [], callbacks = {}, access = { request: 0, serialization: 0 };
  const env = { PLAYWRIGHT_NO_COPY_PROMPT: '1' };
  const cause = new Error(privateText);
  const boundary = name => { order.push(name); if (fail === name) throw cause; };
  // Distinct SDK-like identities have the same URL. Added diagnostics must never read it or other data.
  const request = () => Object.defineProperties({}, Object.fromEntries(['url', 'method', 'failure', 'headers', 'postData', 'toJSON'].map(name =>
    [name, { get: () => { if (name === 'toJSON') access.serialization++; else access.request++; return () => 'synthetic-same-url'; } }])));
  const target = request(), unrelated = request();
  const page = new EventEmitter();
  const emit = (kind, identity = target) => page.emit('request' + kind, identity);
  const unrelatedCalls = { finished: 0, failed: 0 };
  const unrelatedListeners = Object.fromEntries(['finished', 'failed'].map(kind => [kind, () => { unrelatedCalls[kind]++; }]));
  for (const kind of ['finished', 'failed']) page.on('request' + kind, unrelatedListeners[kind]);
  const on = page.on.bind(page), off = page.off.bind(page);
  page.on = (name, listener) => { order.push('on-' + name); callbacks[name] = listener; return on(name, listener); };
  page.off = (name, listener) => {
    order.push('off-' + name); assert.equal(listener, callbacks[name]);
    if (removalFailures.includes(name)) throw cause;
    return off(name, listener);
  };
  const manifest = deferred(), finish = deferred(), finishEntered = deferred();
  let finishedCalls = 0;
  const response = name => ({ status: () => fail === `status_${name}` ? 503 : 200, request: () => target,
    finished: async () => {
      finishedCalls++; boundary('manifest_finish');
      for (const kind of afterBinding) emit(kind);
      finishEntered.resolve();
      if (pendingFinish) return await finish.promise;
      return fail === 'finish_error' ? cause : null;
    } });
  const releaseManifest = () => manifest.resolve(response('manifest'));
  const lifecycle = { failure: null, stop: { attempted: true, clean_acknowledgment: false,
    exit_observed: true, exit_zero: true, error_latched: true, stderr_empty: true,
    reap_complete: true, sandbox_removed: true, sigterm: false, sigkill: false } };
  const ownedFixture = {
    inspectMutations: async () => { boundary('native_inspection'); return { same: fail !== 'native_equality' }; },
    stop: async () => { guards.push(env.PLAYWRIGHT_NO_COPY_PROMPT); boundary('fixture-stop');
      for (const kind of postRemovalEvents) emit(kind);
      if (cleanupFailures.includes('fixture')) throw cause; },
    evidence: () => { boundary('closed-evidence'); return lifecycle; },
  };
  const ownedContext = { close: async () => {
    guards.push(env.PLAYWRIGHT_NO_COPY_PROMPT); boundary('browser-close');
    if (lateBinding === 'browser') { releaseManifest(); await Promise.resolve(); }
    for (const kind of closeEvents) emit(kind);
    if (cleanupFailures.includes('browser')) throw cause;
  } };
  const ownedLoss = { stop: async () => {
    guards.push(env.PLAYWRIGHT_NO_COPY_PROMPT); boundary('interceptor-stop');
    if (lateBinding === 'interceptor') { releaseManifest(); await Promise.resolve(); }
    if (cleanupFailures.includes('interceptor')) throw cause;
  } };
  let waiter = 0, readFacts;
  page.waitForResponse = () => {
    const name = ++waiter === 1 ? 'reply' : 'manifest'; order.push(`wait-${name}`);
    if (name === fail) return Promise.reject(cause);
    if (name === 'manifest') {
      for (const kind of beforeBinding) emit(kind);
      for (const kind of unrelatedEvents) emit(kind, unrelated);
      if (lateBinding) return manifest.promise;
    }
    return Promise.resolve(response(name));
  };
  const running = runInNewContext(controlled, {
    process: { env }, console: { log: value => output.push(value) }, capture: getter => { readFacts = getter; },
    ownedFixture: absent.includes('fixture') ? undefined : ownedFixture,
    ownedContext: absent.includes('browser') ? undefined : ownedContext,
    ownedLoss: absent.includes('interceptor') ? undefined : ownedLoss,
    sid: 'synthetic-session', renameUrl: 'synthetic-rename', renamePath: '/synthetic-rename', first: {},
    committed: { same: true }, posts: () => 2, page,
    pending: { getByRole: () => ({ click: async () => boundary('click') }) },
    expect: value => ({ toBe: expected => {
      if (expected === null && fail === 'null_assertion') boundary('null_assertion');
      if (value !== expected) throw cause;
    } }),
    accepted: async () => boundary('accepted_dom'), oneSession: value => value,
    noWork: async (...args) => { assert.deepEqual(args, [1, 2, 0, '2']); boundary('no_work'); },
  }, { timeout: 1000 });
  // Observe the overall callback immediately. The real finished chain must still reject into its catch.
  const observed = running.then(() => undefined, error => error);
  return { emit, target, unrelated, page, callbacks, access, unrelatedCalls, unrelatedListeners, order,
    readFacts: () => plain(readFacts()), finishEntered: finishEntered.promise, release: finish.resolve, reject: () => finish.reject(cause),
    complete: async () => {
      const failure = await observed;
      const log = output.find(value => value.startsWith('Rename recovery evidence: '));
      assert.ok(log, 'actual callback must report retry and independent cleanup facts');
      const proof = JSON.parse(log.slice('Rename recovery evidence: '.length));
      assert.equal([failure?.message ?? '', failure?.stack ?? '', ...output].some(value => value.includes(privateText) || value.includes('private.invalid')), false);
      assert.deepEqual(access, { request: 0, serialization: 0 });
      return { failure, proof, order, guards, env, finishedCalls };
    } };
}
async function exercise(options) { return await launch(options).complete(); }
const actions = order => order.filter(name => !name.startsWith('on-') && !name.startsWith('off-'));

for (const fail of ['reply', 'manifest', 'click']) {
  test(`rename independently retains resolved response facts when ${fail} fails`, async () => {
    const { failure, proof, order, finishedCalls } = await exercise({ fail });
    assert.ok(failure);
    assert.match(failure.message, /^Rename recovery failed: explicit identical retry response acquisition;/);
    assert.deepEqual(order.slice(0, 5), ['on-requestfinished', 'on-requestfailed', 'wait-reply', 'wait-manifest', 'click']);
    assert.equal(proof.retry.reply_acquired, fail !== 'reply');
    assert.equal(proof.retry.reply_status, fail === 'reply' ? null : 200);
    assert.equal(proof.retry.manifest_acquired, fail !== 'manifest');
    assert.equal(proof.retry.manifest_status, fail === 'manifest' ? null : 200);
    for (const field of fields) assert.equal(proof.retry[field], 'unavailable');
    assert.equal(proof.retry.finish_settlement, 'unavailable');
    assert.equal(proof.retry.manifest_null, 'unavailable');
    assert.equal(proof.retry.manifest_requestfinished, fail === 'manifest' ? null : false);
    assert.equal(proof.retry.manifest_requestfailed, fail === 'manifest' ? null : false);
    assert.equal(finishedCalls, 0);
  });
}

for (const [index, fail] of ['statuses', 'manifest_finish', 'accepted_dom', 'native_inspection', 'native_equality', 'no_work'].entries()) {
  test(`rename ${fail} failure is fatal at its fixed stage without later proof`, async () => {
    const { failure, proof } = await exercise({ fail: fail === 'statuses' ? 'status_reply' : fail });
    assert.ok(failure);
    assert.ok(failure.message.startsWith(`Rename recovery failed: explicit identical retry ${stages[index]};`));
    for (const [position, field] of fields.entries()) assert.equal(proof.retry[field], position < index ? 'succeeded' : position === index ? 'failed' : 'unavailable');
    let settlement = 'returned_null';
    if (index === 0) settlement = 'unavailable';
    else if (index === 1) settlement = 'rejected';
    assert.equal(proof.retry.finish_settlement, settlement);
    assert.equal(proof.retry.manifest_null, index < 2 ? 'unavailable' : 'succeeded');
  });
}

test('rename non-null manifest finish is only a static failed fact, never exported error text', async () => {
  const { failure, proof, finishedCalls } = await exercise({ fail: 'finish_error' });
  assert.ok(failure);
  assert.match(failure.message, /^Rename recovery failed: explicit identical retry manifest null assertion;/);
  assert.equal(proof.retry.manifest_finish, 'failed');
  assert.equal(proof.retry.finish_settlement, 'returned_other');
  assert.equal(proof.retry.manifest_null, 'failed');
  assert.equal(finishedCalls, 1);
  for (const field of fields.slice(2)) assert.equal(proof.retry[field], 'unavailable');
});

test('rename returned null is not proof when the original null assertion fails', async () => {
  const { failure, proof, finishedCalls } = await exercise({ fail: 'null_assertion' });
  assert.ok(failure);
  assert.match(failure.message, /^Rename recovery failed: explicit identical retry manifest null assertion;/);
  assert.equal(proof.retry.finish_settlement, 'returned_null');
  assert.equal(proof.retry.manifest_null, 'failed');
  assert.equal(proof.retry.manifest_finish, 'failed');
  assert.equal(finishedCalls, 1);
  for (const field of fields.slice(2)) assert.equal(proof.retry[field], 'unavailable');
});

for (const primary of [false, true]) {
  for (const cleanup of ['interceptor', 'browser', 'fixture']) {
    test(`rename preserves fatal cleanup ${cleanup} separately; primary=${primary}`, async () => {
      const { failure, proof, order, guards } = await exercise({ fail: primary ? 'click' : undefined, cleanupFailures: [cleanup] });
      assert.ok(failure);
      assert.ok(failure.message.startsWith(primary ? 'Rename recovery failed: explicit identical retry response acquisition;' : `Rename recovery ${cleanup === 'browser' ? 'browser' : cleanup} cleanup failed`));
      assert.deepEqual(actions(order).slice(-4), ['interceptor-stop', 'browser-close', 'fixture-stop', 'closed-evidence']);
      for (const name of ['interceptor', 'browser', 'fixture']) assert.equal(proof.cleanup[name], name === cleanup ? 'failed' : 'succeeded');
      assert.deepEqual(guards, ['1', '1', '1']);
      assert.deepEqual(proof.listener_cleanup, { requestfinished: 'succeeded', requestfailed: 'succeeded' });
      assert.equal(proof.lifecycle.stop.clean_acknowledgment, false);
      assert.equal(proof.lifecycle.stop.reap_complete && proof.lifecycle.stop.sandbox_removed, true);
      assert.equal(proof.snapshots.catch === null, !primary);
    });
  }
}

test('rename absent resources remain unavailable, not successfully closed', async () => {
  const { failure, proof } = await exercise({ fail: 'click', absent: ['interceptor', 'browser', 'fixture'] });
  assert.ok(failure);
  assert.deepEqual(proof.cleanup, { interceptor: 'unavailable', browser: 'unavailable', fixture: 'unavailable' });
  assert.equal(proof.lifecycle, null);
  assert.equal(proof.snapshots.before_context_close, null);
  assert.ok(proof.snapshots.catch);
});

test('rename successful actual retry block retains action/assertion order and complete facts', async () => {
  const { failure, proof, order, finishedCalls } = await exercise();
  assert.equal(failure, undefined);
  assert.deepEqual(order, ['on-requestfinished', 'on-requestfailed', 'wait-reply', 'wait-manifest', 'click', 'manifest_finish', 'accepted_dom', 'native_inspection', 'no_work',
    'interceptor-stop', 'browser-close', 'off-requestfinished', 'off-requestfailed', 'fixture-stop', 'closed-evidence']);
  for (const field of fields) assert.equal(proof.retry[field], 'succeeded');
  assert.equal(proof.retry.finish_settlement, 'returned_null');
  assert.equal(proof.retry.manifest_null, 'succeeded');
  assert.equal(proof.snapshots.catch, null);
  assert.equal(finishedCalls, 1);
  const block = statements.slice(start, end).map(node => node.getText(source)).join('\n');
  for (const literal of ['Promise.all', 'expect(retryReply.status()).toBe(200)', 'expect(retryManifest.status()).toBe(200)',
    'expect(finish).toBe(null)', "await accepted('rename', first, true, 'unchanged')", 'oneSession(await fixture.inspectMutations(), 1)',
    'expect(JSON.stringify(retried) === JSON.stringify(committed)).toBe(true)', "await noWork(1, 2, 0, '2')"]) assert.ok(block.includes(literal));
  assert.equal(block.split('retryManifest.finished()').length - 1, 1);
});

for (const events of [[], ['finished'], ['failed'], ['finished', 'finished'], ['failed', 'failed'], ['failed', 'finished', 'failed', 'finished']]) {
  for (const when of ['before', 'after']) {
    test(`rename identity facts are independent and monotonic: ${when} binding; ${events.join(',') || 'neither'}`, async () => {
      const options = when === 'before' ? { beforeBinding: events } : { afterBinding: events };
      const { failure, proof } = await exercise(options);
      assert.equal(failure, undefined);
      assert.equal(proof.retry.manifest_requestfinished, events.includes('finished'));
      assert.equal(proof.retry.manifest_requestfailed, events.includes('failed'));
      assert.equal(proof.retry.finish_settlement, 'returned_null');
    });
  }
}

test('rename unrelated same-URL identities cannot change matched facts or invoke accessors/serialization', async () => {
  const control = launch({ unrelatedEvents: ['finished', 'failed'], pendingFinish: true });
  await control.finishEntered;
  control.emit('finished', control.unrelated); control.emit('failed', control.unrelated);
  const facts = control.readFacts();
  assert.equal(facts.manifest_requestfinished, false); assert.equal(facts.manifest_requestfailed, false);
  assert.equal(facts.finish_settlement, 'pending');
  control.release(null);
  await control.complete();
  assert.deepEqual(control.access, { request: 0, serialization: 0 });
});

test('rename unavailable binding never exports unrelated buffered terminal facts', async () => {
  const control = launch({ fail: 'manifest' });
  control.emit('finished'); control.emit('failed');
  const { proof } = await control.complete();
  assert.equal(proof.retry.manifest_requestfinished, null); assert.equal(proof.retry.manifest_requestfailed, null);
});

for (const phase of ['interceptor', 'browser']) {
  for (const fail of ['reply', 'click']) {
    test(`rename binds independently during ${phase} cleanup after ${fail} failed; earlier snapshots do not change`, async () => {
      const control = launch({ fail, lateBinding: phase, beforeBinding: ['failed'], closeEvents: ['finished'] });
      const { failure, proof } = await control.complete();
      assert.ok(failure);
      assert.equal(proof.snapshots.catch.manifest_acquired, false);
      assert.equal(proof.snapshots.catch.manifest_requestfailed, null);
      assert.equal(proof.snapshots.catch.manifest_requestfinished, null);
      const before = proof.snapshots.before_context_close;
      assert.equal(before.manifest_acquired, phase === 'interceptor');
      assert.equal(before.manifest_requestfailed, phase === 'interceptor' ? true : null);
      assert.equal(before.manifest_requestfinished, phase === 'interceptor' ? false : null);
      assert.equal(proof.snapshots.through_owned_close_removal.manifest_requestfailed, true);
      assert.equal(proof.snapshots.through_owned_close_removal.manifest_requestfinished, true);
      assert.equal(proof.retry.finish_settlement, 'unavailable');
      for (const field of fields) assert.equal(proof.retry[field], 'unavailable');
    });
  }
}

for (const rejection of [false, true]) {
  test(`rename single controlled finished await stays pending until explicit ${rejection ? 'rejection' : 'release'}`, async () => {
    const control = launch({ pendingFinish: true });
    await control.finishEntered;
    const facts = control.readFacts();
    assert.equal(facts.finish_settlement, 'pending'); assert.equal(facts.manifest_finish, 'attempted');
    assert.equal(facts.manifest_null, 'unavailable');
    for (const field of fields.slice(2)) assert.equal(facts[field], 'unavailable');
    assert.equal(control.order.includes('browser-close'), false);
    control.emit('failed');
    assert.equal(control.readFacts().finish_settlement, 'pending');
    if (rejection) control.reject(); else control.release(null);
    const { failure, proof, finishedCalls } = await control.complete();
    assert.equal(!!failure, rejection); assert.equal(finishedCalls, 1);
    assert.equal(proof.retry.finish_settlement, rejection ? 'rejected' : 'returned_null');
    assert.equal(proof.retry.manifest_finish, rejection ? 'failed' : 'succeeded');
    assert.equal(proof.retry.manifest_null, rejection ? 'unavailable' : 'succeeded');
    if (rejection) {
      assert.match(failure.message, /^Rename recovery failed: explicit identical retry manifest finish;/);
      for (const field of fields.slice(2)) assert.equal(proof.retry[field], 'unavailable');
      assert.equal(proof.snapshots.catch.finish_settlement, 'rejected');
    }
  });
}

for (const failClose of [false, true]) {
  test(`rename closure-time observations survive owned close; failed close=${failClose}; later events cannot rewrite copies`, async () => {
    const control = launch({ fail: 'null_assertion', closeEvents: ['failed'], postRemovalEvents: ['finished'], cleanupFailures: failClose ? ['browser'] : [] });
    const { failure, proof } = await control.complete();
    assert.ok(failure);
    assert.equal(proof.snapshots.catch.manifest_requestfailed, false);
    assert.equal(proof.snapshots.before_context_close.manifest_requestfailed, false);
    assert.equal(proof.snapshots.through_owned_close_removal.manifest_requestfailed, true);
    assert.equal(proof.snapshots.through_owned_close_removal.manifest_requestfinished, false);
    const saved = JSON.stringify(proof.snapshots);
    control.emit('finished'); control.emit('failed');
    assert.equal(control.readFacts().manifest_requestfinished, false);
    assert.equal(JSON.stringify(proof.snapshots), saved);
    for (const kind of ['finished', 'failed']) assert.deepEqual(control.page.listeners('request' + kind), [control.unrelatedListeners[kind]]);
    assert.ok(control.unrelatedCalls.finished > 0 && control.unrelatedCalls.failed > 0);
    assert.equal(proof.cleanup.browser, failClose ? 'failed' : 'succeeded');
  });
}

for (const name of ['requestfinished', 'requestfailed']) {
  test(`rename removal failure for ${name} cannot interrupt other removal or fixture Stop`, async () => {
    const { failure, proof, order } = await exercise({ removalFailures: [name], cleanupFailures: ['browser'] });
    assert.match(failure.message, /^Rename recovery browser cleanup failed/);
    assert.deepEqual(order.slice(-4), ['off-requestfinished', 'off-requestfailed', 'fixture-stop', 'closed-evidence']);
    assert.equal(proof.listener_cleanup[name], 'failed');
    assert.equal(proof.listener_cleanup[name === 'requestfinished' ? 'requestfailed' : 'requestfinished'], 'succeeded');
    assert.equal(proof.cleanup.fixture, 'succeeded');
  });
}

test('rename ordinary terminal callbacks are synchronous non-throwing identity-only observers', async () => {
  const control = launch({ pendingFinish: true });
  await control.finishEntered;
  for (const name of ['requestfinished', 'requestfailed']) {
    const callback = control.callbacks[name];
    assert.equal(callback.constructor.name, 'Function');
    assert.equal(callback(control.unrelated), undefined);
    assert.equal(callback(control.target), undefined);
    assert.equal(callback(control.target), undefined);
  }
  assert.deepEqual(control.access, { request: 0, serialization: 0 });
  assert.equal(control.readFacts().manifest_requestfinished, true);
  assert.equal(control.readFacts().manifest_requestfailed, true);
  control.release(null);
  await control.complete();
  const observers = declarations.filter(node => /const onManifest(Finished|Failed) =/.test(node.getText(source)));
  assert.equal(observers.length, 2);
  for (const observer of observers) {
    const body = observer.declarationList.declarations[0].initializer.body;
    assert.equal(body.statements.length, 2);
    assert.match(body.statements[0].getText(source), /^(finished|failed)Requests\.add\(request\);$/);
    assert.match(body.statements[1].getText(source), /^if \(request === manifestRequest\) retry\.manifest_request(finished|failed) = true;$/);
  }
});

test('rename observed terminal events and acquired 200 do not promote failed status validation to semantic proof', async () => {
  const { failure, proof } = await exercise({ fail: 'status_reply', beforeBinding: ['finished', 'failed'] });
  assert.ok(failure);
  assert.equal(proof.retry.manifest_status, 200);
  assert.equal(proof.retry.manifest_requestfinished, true);
  assert.equal(proof.retry.manifest_requestfailed, true);
  assert.equal(proof.retry.statuses, 'failed');
  assert.equal(proof.retry.finish_settlement, 'unavailable');
  for (const field of fields.slice(1)) assert.equal(proof.retry[field], 'unavailable');
});

test('rename registers exactly two owned page callbacks before the original concurrent waiters and click', () => {
  const registrations = statements.filter(node => /^page\.on\('request(finished|failed)'/.test(node.getText(source)));
  assert.deepEqual(registrations.map(node => node.getText(source)), [
    "page.on('requestfinished', onManifestFinished);", "page.on('requestfailed', onManifestFailed);",
  ]);
  const acquisition = statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isArrayBindingPattern(item.name))
    && node.getText(source).includes('retryReply'));
  const all = acquisition.declarationList.declarations[0].initializer.expression;
  assert.equal(all.expression.getText(source), 'Promise.all');
  const branches = all.arguments[0].elements;
  assert.equal(branches.length, 3);
  assert.ok(branches[0].getText(source).startsWith('page.waitForResponse('));
  assert.ok(branches[1].getText(source).startsWith('page.waitForResponse('));
  assert.ok(branches[2].getText(source).includes("name: 'Retry identical command'"));
  for (const registration of registrations) assert.ok(statements.indexOf(registration) < statements.indexOf(acquisition));
});

test('rename actual startup failure leaves unreached listener and context phases unavailable', async () => {
  const output = [];
  const actual = runInNewContext(`(${callback.getText(source)})`.replaceAll('import.meta.url', JSON.stringify(url.href)), {
    process: { env: {} }, executable: 'synthetic-executable',
    startFixture: async () => { throw new Error(privateText); }, console: { log: value => output.push(value) },
  }, { timeout: 1000 });
  await assert.rejects(actual({ browser: {} }), error => error.message.startsWith('Rename recovery failed: startup;') && !error.message.includes(privateText));
  const proof = JSON.parse(output[0].slice('Rename recovery evidence: '.length));
  assert.deepEqual(proof.listener_cleanup, { requestfinished: 'unavailable', requestfailed: 'unavailable' });
  assert.equal(proof.snapshots.before_context_close, null);
  assert.equal(proof.snapshots.catch.manifest_requestfinished, null);
  assert.equal(proof.snapshots.catch.manifest_requestfailed, null);
  assert.equal(proof.snapshots.catch.finish_settlement, 'unavailable');
  assert.equal(proof.lifecycle, null);
});

test('rename observes exactly the awaited finished chain and preserves return/rejection identity', () => {
  const finish = statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.text === 'finish'));
  const then = finish.declarationList.declarations[0].initializer.expression;
  assert.equal(then.expression.getText(source), 'retryManifest.finished().then');
  const retry = {};
  const resolved = runInNewContext(`(${then.arguments[0].getText(source)})`, { retry });
  const rejected = runInNewContext(`(${then.arguments[1].getText(source)})`, { retry });
  const value = Object.create(null), reason = Object.create(null);
  assert.equal(resolved(null), null); assert.equal(retry.finish_settlement, 'returned_null');
  assert.equal(resolved(value), value); assert.equal(retry.finish_settlement, 'returned_other');
  assert.throws(() => rejected(reason), error => error === reason);
  assert.equal(retry.finish_settlement, 'rejected');
});
