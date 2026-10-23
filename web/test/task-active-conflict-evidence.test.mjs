import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateCreateView } from '../dist/api.js';

const url = new URL('../e2e/task-active-conflict.spec.mjs', import.meta.url);
const source = ts.createSourceFile('active-conflict.js', readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const attempt = callback.body.statements.find(ts.isTryStatement);
const statements = attempt.tryBlock.statements;
const start = statements.findIndex(node => node.getText(source).startsWith("stage = 'distinct active task real HTTP"));
const end = statements.findIndex(node => node.getText(source).startsWith('expect(error.acceptance'));
assert.ok(start >= 0 && end > start);
// Execute only the real response block and its real catch/cleanup, not a copied diagnostic model.
const declarations = callback.body.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => ['previousNoCopyPrompt', 'failure', 'stage', 'observed', 'responseStatus', 'createFacts', 'faults', 'cleanup'].includes(item.name.text)));
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1).map(node => node.getText(source)).join('\n');
const createStart = statements.findIndex(node => node.getText(source).startsWith('const [createReply]'));
const createEnd = statements.findIndex(node => node.getText(source).startsWith("await exact(createCommand.locator('h3')"));
assert.ok(createStart >= 0 && createEnd > createStart);
const createBlock = statements.slice(createStart, createEnd + 1).map(node => node.getText(source)).join('\n');
const recorderGuard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
assert.ok(recorderGuard);
const controlledCreate = `(async () => {
  ${declarations.map(node => node.getText(source)).join('\n')}
  const context = ownedContext, fixture = ownedFixture;
  try { ${recorderGuard.getText(source)} ${createBlock} }
  ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail}
})()`;
const controlled = `(async () => {
  ${declarations.map(node => node.getText(source)).join('\n')}
  const context = ownedContext, fixture = ownedFixture;
  try { ${statements.slice(start, end).map(node => node.getText(source)).join('\n')} }
  ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail}
})()`;

for (const failCleanup of [false, true]) {
  test(`active-conflict failed body read stays fatal with safe status and cleanup; cleanup failure=${failCleanup}`, async () => {
    const privateText = 'synthetic-private-body-exception https://private.invalid/owner?token=private';
    const cause = new TypeError(privateText);
    cause.stack = `TypeError: ${privateText}\n    at task-active-conflict.spec.mjs:123:4`;
    const output = [], calls = [];
    const env = { PLAYWRIGHT_NO_COPY_PROMPT: '1' };
    const response = { status() { calls.push('status'); return 409; }, async body() { calls.push('body'); throw cause; } };
    const cleanupError = new Error(privateText);
    let failure;
    try {
      await runInNewContext(controlled, {
        process: { env }, console: { log: value => output.push(value) }, SECOND: 'synthetic-second', taskPath: '/synthetic/runs',
        task: { fill: async () => {} }, page: { waitForResponse: async () => response, getByRole: () => ({ click: async () => {} }) },
        ownedContext: { close: async () => { calls.push('browser-close'); if (failCleanup) throw cleanupError; } },
        ownedFixture: { stop: async () => { calls.push('fixture-stop'); if (failCleanup) throw cleanupError; } },
        expect: () => { throw Error('body validation must not run after failed body read'); },
      }, { timeout: 1000 });
    } catch (error) { failure = error; }
    assert.ok(failure);
    assert.deepEqual(calls, ['status', 'body', 'browser-close', 'fixture-stop']);
    assert.match(failure.message, /^Active conflict failed: distinct active task real HTTP body read; kind=TypeError; source_line=123; response_status_available=true; response_status=409; observed=null; faults=\{"external":0,"console":0,"page":0,"secret":0,"request":0,"response":0,"reconcile":0\}; create=\{"acquired":false,"status":null,"body_attempted":false,"body_returned":false,"body_rejected":false,"body_rejection_class":null,"dto_validated":false\}$/);
    assert.deepEqual(output, [`Active conflict cleanup: browser=${!failCleanup} fixture=${!failCleanup}`]);
    assert.equal([failure.message, failure.stack, ...output].some(value => value.includes(privateText) || value.includes('private.invalid')), false);
    assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
  });
}

test('active-conflict acquisition failure reports unavailable status without observed body proof', async () => {
  const output = [];
  let failure;
  try {
    await runInNewContext(controlled, {
      process: { env: {} }, console: { log: value => output.push(value) }, SECOND: 'synthetic-second', taskPath: '/synthetic/runs',
      task: { fill: async () => {} }, page: { waitForResponse: async () => { throw Error('synthetic-private-acquisition'); }, getByRole: () => ({ click: async () => {} }) },
      ownedContext: { close: async () => {} }, ownedFixture: { stop: async () => {} },
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(failure.message, /^Active conflict failed: distinct active task real HTTP response acquisition;/);
  assert.ok(failure.message.includes('response_status_available=false; response_status=null; observed=null;'));
  assert.equal(failure.message.includes('synthetic-private-acquisition'), false);
  assert.deepEqual(output, ['Active conflict cleanup: browser=true fixture=true']);
});

test('active-conflict observed assignment follows actual body and closed validation with no body retry', () => {
  const block = statements.slice(start, end).map(node => node.getText(source)).join('\n');
  const ordered = ['responseStatus = secondReply.status()', "stage = 'distinct active task real HTTP body read'", 'await secondReply.body()',
    "stage = 'distinct active task real HTTP body validation'", 'errorBytes.byteLength <= 4096', "new TextDecoder('utf-8', { fatal: true })",
    'expect(leaked(errorRaw)).toBe(false)', 'validateErrorView)', 'observed ='];
  let previous = -1;
  for (const text of ordered) {
    const position = block.indexOf(text);
    assert.ok(position > previous, `missing or out-of-order safe response step: ${text}`);
    previous = position;
  }
  assert.equal(block.split('await secondReply.body()').length - 1, 1);
  assert.ok(declarations.some(node => node.getText(source).includes('let observed = null;')));
  assert.ok(declarations.some(node => node.getText(source).includes('let responseStatus = null;')));
});

const privateText = 'synthetic-private-suffix https://private.invalid/owner?token=private';
const session = '11111111-1111-4111-8111-111111111111';
const validCreate = { api_version: 1, session_id: session, duplicate: false, warning_code: null,
  receipt: { operation_id: '22222222-2222-4222-8222-222222222222', session_id: session,
    run_id: null, first_sequence: '1', last_sequence: '1' } };
const emptyCreate = { acquired: false, status: null, body_attempted: false, body_returned: false,
  body_rejected: false, body_rejection_class: null, dto_validated: false };

async function createObservation({ status = 201, bytes = Buffer.from(JSON.stringify(validCreate)), media = 'application/json',
  bodyCause, acquireCause, clickCause, closeFails = false, stopFails = false, previousGuard, laterFails = true } = {}) {
  const output = [], calls = [];
  const env = {};
  if (previousGuard !== undefined) env.PLAYWRIGHT_NO_COPY_PROMPT = previousGuard;
  const response = {
    status() { calls.push('status'); return status; },
    async body() { calls.push('body'); if (bodyCause) throw bodyCause; return bytes; },
    headers() { calls.push('headers'); return { 'content-type': media }; },
  };
  let failure;
  try {
    await runInNewContext(controlledCreate, {
      process: { env }, console: { log: value => output.push(value) }, TextDecoder, decodeJson, validateCreateView,
      createCommand: { locator: () => ({}) },
      page: {
        waitForResponse: async () => { calls.push('acquire'); if (acquireCause) throw acquireCause; return response; },
        getByRole: () => ({ click: async () => { calls.push('click'); if (clickCause) throw clickCause; } }),
      },
      exact: async () => { calls.push('later'); if (laterFails) throw Error(privateText); },
      leaked: value => value.includes(privateText), expect: value => ({ toBe: expected => assert.equal(value, expected) }),
      ownedContext: { close: async () => {
        calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
        if (closeFails) throw Error(privateText);
      } },
      ownedFixture: { stop: async () => {
        calls.push('fixture-stop'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFails ? '1' : previousGuard);
        if (stopFails) throw Error(privateText);
      } },
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  assert.deepEqual(output, [`Active conflict cleanup: browser=${!closeFails} fixture=${!stopFails}`]);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFails ? '1' : previousGuard);
  assert.ok(calls.filter(value => value === 'body').length <= 1);
  if (failure) {
    assert.equal(failure.cause, undefined);
    assert.equal([failure.message, failure.stack, ...output].some(value => value.includes(privateText) || value.includes('private.invalid')), false);
  }
  return { failure, calls, facts: failure?.message.includes('; create=') ? JSON.parse(failure.message.split('; create=')[1]) : null };
}

function createFailure(result, expected, bodyCalls, stage = 'startup') {
  assert.ok(result.failure);
  assert.ok(result.failure.message.startsWith(`Active conflict failed: ${stage};`));
  assert.ok(result.failure.message.includes('response_status_available=false; response_status=null; observed=null;'));
  assert.deepEqual(result.facts, expected);
  assert.equal(result.calls.filter(value => value === 'body').length, bodyCalls);
  assert.deepEqual(result.calls.slice(-2), ['browser-close', 'fixture-stop']);
}

for (const step of ['acquire', 'click']) {
  test(`Create ${step} rejection leaves acquisition/status/body unavailable`, async () => {
    const cause = Error(privateText);
    const result = await createObservation(step === 'acquire' ? { acquireCause: cause } : { clickCause: cause });
    createFailure(result, emptyCreate, 0);
    assert.deepEqual(result.calls, ['acquire', 'click', 'browser-close', 'fixture-stop']);
  });
}

for (const status of [200, 409, 99, 600, NaN, '201']) {
  test(`Create non201 ${String(status)} records bounded status without a body attempt`, async () => {
    const result = await createObservation({ status });
    createFailure(result, { ...emptyCreate, acquired: true, status: [200, 409].includes(status) ? status : null }, 0);
    assert.deepEqual(result.calls, ['acquire', 'click', 'status', 'browser-close', 'fixture-stop']);
  });
}

const markers = [
  { name: 'Error', message: 'Protocol error (Network.getResponseBody):', label: 'method_get_response_body' },
  { name: 'Error', message: 'Target page, context or browser has been closed', label: 'target_closed' },
  { name: 'Error', message: 'Target crashed', label: 'target_crashed' },
  { name: 'TimeoutError', message: 'no known message marker', label: 'timeout' },
  { name: 'Error', message: 'Timeout 30000ms exceeded.', label: 'timeout' },
  { name: 'Error', message: 'no known message marker', label: 'other' },
  { name: 'ProtocolError', message: 'no known method marker', label: 'other' },
  { name: privateText, message: 'no known message marker', label: 'other' },
  { name: 'Error', message: undefined, label: 'other' },
  { name: 'TimeoutError', message: 'Network.getResponseBody Target page, context or browser has been closed Target crashed Timeout 1ms exceeded', label: 'method_get_response_body' },
  { name: 'TimeoutError', message: 'Target page, context or browser has been closed Target crashed Timeout 1ms exceeded', label: 'target_closed' },
  { name: 'TimeoutError', message: 'Target crashed Timeout 1ms exceeded', label: 'target_crashed' },
];
for (const [index, marker] of markers.entries()) {
  test(`Create sole body rejection finite class ${index}: ${marker.label}`, async () => {
    const cause = Error();
    cause.name = marker.name;
    cause.message = marker.message === undefined ? undefined : `${marker.message} ${privateText}`;
    cause.stack = `${privateText}\n    at task-active-conflict.spec.mjs:321:4`;
    const result = await createObservation({ bodyCause: cause });
    createFailure(result, { ...emptyCreate, acquired: true, status: 201, body_attempted: true,
      body_rejected: true, body_rejection_class: marker.label }, 1);
    assert.ok(result.failure.message.includes('source_line=321;'));
    assert.deepEqual(result.calls, ['acquire', 'click', 'status', 'body', 'browser-close', 'fixture-stop']);
  });
}

const returned = { ...emptyCreate, acquired: true, status: 201, body_attempted: true, body_returned: true };
for (const [step, options, headers] of [
  ['size', { bytes: Buffer.alloc(4097, 120) }, false],
  ['UTF8', { bytes: Buffer.from([0xff]) }, false],
  ['privacy', { bytes: Buffer.from(privateText) }, false],
  ['media', { media: 'text/plain' }, true],
  ['JSON', { bytes: Buffer.from('{') }, true],
  ['DTO schema', { bytes: Buffer.from('{}') }, true],
  ['DTO identity', { bytes: Buffer.from(JSON.stringify({ ...validCreate, session_id: validCreate.receipt.operation_id })) }, true],
]) {
  test(`Create returned body then ${step} failure is not a body rejection or DTO success`, async () => {
    const result = await createObservation(options);
    createFailure(result, returned, 1, headers ? 'closed Create response and command' : 'startup');
    const expected = ['acquire', 'click', 'status', 'body'];
    if (headers) expected.push('headers');
    assert.deepEqual(result.calls, [...expected, 'browser-close', 'fixture-stop']);
  });
}

test('Create validated DTO followed by later failure does not claim native receipt proof', async () => {
  const result = await createObservation();
  createFailure(result, { ...returned, dto_validated: true }, 1, 'closed Create response and command');
  assert.deepEqual(result.calls, ['acquire', 'click', 'status', 'body', 'headers', 'later', 'browser-close', 'fixture-stop']);
});

for (const [closeFails, stopFails] of [[false, false], [true, false], [false, true], [true, true]]) {
  for (const previousGuard of [undefined, '', '1']) {
    test(`Create first failure survives cleanup close=${closeFails} stop=${stopFails} guard=${String(previousGuard)}`, async () => {
      const result = await createObservation({ bodyCause: Error(`Network.getResponseBody ${privateText}`), closeFails, stopFails, previousGuard });
      createFailure(result, { ...emptyCreate, acquired: true, status: 201, body_attempted: true,
        body_rejected: true, body_rejection_class: 'method_get_response_body' }, 1);
    });
  }
}

for (const [closeFails, stopFails, expected] of [
  [true, false, 'Active conflict browser cleanup failed'],
  [false, true, 'Active conflict fixture cleanup failed'],
  [true, true, 'Active conflict browser cleanup failed'],
]) {
  test(`Create no earlier failure preserves cleanup priority: close=${closeFails} stop=${stopFails}`, async () => {
    const result = await createObservation({ closeFails, stopFails, laterFails: false });
    assert.equal(result.failure.message, expected);
    assert.equal(result.facts, null);
    assert.equal(result.calls.filter(value => value === 'body').length, 1);
  });
}

test('Create actual source keeps one body call and records validation only after decoder return', () => {
  const ordered = ['const [createReply]', 'createFacts.acquired = true', 'createReply.status()', 'createFacts.status =',
    'expect(createStatus).toBe(201)', 'createFacts.body_attempted = true', 'await createReply.body()',
    'createFacts.body_returned = true', 'createFacts.body_rejected = true', 'throw cause', 'createBytes.byteLength <= 4096',
    "new TextDecoder('utf-8', { fatal: true })", 'expect(leaked(createRaw)).toBe(false)', 'decodeJson(createRaw,',
    'createFacts.dto_validated = true', "await exact(createCommand.locator('h3')"];
  let previous = -1;
  for (const text of ordered) {
    const position = createBlock.indexOf(text);
    assert.ok(position > previous, `missing or out-of-order Create step: ${text}`);
    previous = position;
  }
  assert.equal(createBlock.split('await createReply.body()').length - 1, 1);
  assert.equal(createBlock.split('createFacts.body_rejected = true').length - 1, 1);
  assert.equal(createBlock.includes('.finished('), false);
});
