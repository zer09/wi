import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateErrorView } from '../dist/api.js';

const url = new URL('../e2e/task-input-rejection.spec.mjs', import.meta.url);
const source = ts.createSourceFile('task-input-rejection.js', readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const attempt = callback.body.statements.find(ts.isTryStatement);
const loop = attempt.tryBlock.statements.find(ts.isForOfStatement);
const statements = loop.statement.statements;
const stage = statements.find(node => node.getText(source).startsWith('stage = index === 0'));
const start = statements.findIndex(node => node.getText(source).startsWith('const [{ status, error }]'));
const end = statements.findIndex(node => node.getText(source).startsWith('observed.push('));
assert.ok(stage && start >= 0 && end > start);
const names = ['previousNoCopyPrompt', 'failure', 'stage', 'observed', 'replyEvidence', 'requests', 'firstIdentity', 'faults', 'cleanup'];
const declarations = callback.body.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => names.includes(item.name.text)));
assert.equal(declarations.length, names.length);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1).map(node => node.getText(source)).join('\n');
// Run the spec's response assertions and catch/cleanup with synthetic response and later-failure seams.
const controlled = `(async () => {
  ${declarations.map(node => node.getText(source)).join('\n')}
  const context = ownedContext, fixture = ownedFixture;
  capture(() => ({ ...replyEvidence }));
  try {
    for (const [index] of syntheticResponses.entries()) {
      ${stage.getText(source)}
      ${statements.slice(start, end + 1).map(node => node.getText(source)).join('\n')}
      await later(index);
    }
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail}
})()`;
const errorView = index => ({ api_version: 1, code: index === 0 ? 'context.invalid_request' : 'api.body_too_large',
  stage: null, certainty: 'not_applicable', acceptance: null, notices: [] });
const PRIVATE = 'synthetic-private-response-exception-id-page https://private.invalid/?token=synthetic';
const plain = value => JSON.parse(JSON.stringify(value));

async function exercise(responses, { laterFailure = false, cleanupFailure = false, unknownName = false } = {}) {
  const output = [], calls = [], beforeBody = [];
  const env = { PLAYWRIGHT_NO_COPY_PROMPT: '1' };
  const cause = new TypeError(PRIVATE);
  if (unknownName) cause.name = PRIVATE;
  cause.stack = `${PRIVATE}\n    at task-input-rejection.spec.mjs:789:4\n    at ${PRIVATE}`;
  let getter, waiter = 0, failure;
  const page = {
    privateContent: PRIVATE,
    waitForResponse: async predicate => {
      const index = waiter++, option = responses[index];
      const response = {
        url: () => 'http://127.0.0.1/synthetic-runs', request: () => ({ method: () => 'POST' }),
        status: () => index === 0 ? 422 : 413,
        body: async () => {
          calls.push(`body-${index}`); beforeBody.push(plain(getter()));
          if (option === 'body') throw cause;
          if (option === 'utf8') return Buffer.from([0xff]);
          if (option === 'json') return Buffer.from(`{"private":"${PRIVATE}",`);
          const value = errorView(index);
          if (option === 'schema-version') value.api_version = 2;
          if (option === 'schema-extra') value.private = PRIVATE;
          if (option === 'assertion') value.code = 'api.invalid_request';
          return Buffer.from(JSON.stringify(value));
        },
        headers: () => ({ 'content-type': option === 'media' ? `text/plain; private=${PRIVATE}` : 'application/json; charset=utf-8' }),
      };
      assert.equal(predicate(response), true);
      return response;
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button'); assert.equal(options.name, 'Send'); assert.equal(options.exact, true);
      return { click: async () => { calls.push('send'); } };
    },
  };
  try {
    await runInNewContext(controlled, {
      process: { env }, console: { log: value => output.push(value) }, syntheticResponses: responses,
      taskPath: '/synthetic-runs', page, URL, TextDecoder, decodeJson, validateErrorView,
      leaked: raw => raw.includes(PRIVATE), capture: value => { getter = value; },
      later: async () => { if (laterFailure) throw cause; },
      ownedContext: { close: async () => { calls.push('browser-close'); if (cleanupFailure) throw cause; } },
      ownedFixture: { stop: async () => { calls.push('fixture-stop'); if (cleanupFailure) throw cause; } },
      expect: value => ({ toBe: expected => assert.equal(value, expected),
        toEqual: expected => assert.deepEqual(plain(value), plain(expected)) }),
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  const serialized = [failure?.message ?? '', failure?.stack ?? '', ...output].join('\n');
  assert.equal(serialized.includes(PRIVATE) || serialized.includes('private.invalid'), false);
  assert.deepEqual(calls.slice(-2), ['browser-close', 'fixture-stop']);
  assert.deepEqual(output, [`Task rejection cleanup: browser=${!cleanupFailure} fixture=${!cleanupFailure}`]);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
  return { failure, evidence: plain(getter()), beforeBody, calls };
}

function failedFacts(result, index, decoded, validated, { observed = [], secret = 0, kind = 'ProtocolError', line = 'none' } = {}) {
  assert.ok(result.failure);
  const reply = { status: index === 0 ? 422 : 413, decoded, validated };
  const faults = { external: 0, console: 0, page: 0, secret, request: 0, asset: 0, response: 0 };
  const stage = index === 0 ? 'whitespace input and real HTTP rejection' : 'oversized input and real HTTP rejection';
  // Exact equality permits only closed scalar facts, not response objects, exception text, IDs or page content.
  assert.equal(result.failure.message, `Task rejection failed: ${stage}; kind=${kind} line=${line}; reply=${JSON.stringify(reply)}; observed=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; task_posts=0`);
  assert.deepEqual(result.evidence, reply);
}

for (const [option, decoded, secret, kind, line] of [
  ['body', false, 0, 'TypeError', '789'], ['utf8', false, 0, 'TypeError', 'none'],
  ['media', false, 0, 'ProtocolError', 'none'], ['json', false, 1, 'ProtocolError', 'none'],
  ['schema-version', true, 0, 'ProtocolError', 'none'], ['schema-extra', true, 1, 'ProtocolError', 'none'],
]) {
  test(`task-input rejection retains parse/schema milestones for ${option} failure`, async () => {
    const result = await exercise([option]);
    failedFacts(result, 0, decoded, false, { secret, kind, line });
    assert.deepEqual(result.beforeBody, [{ status: 422, decoded: false, validated: false }]);
    assert.equal(result.calls.filter(value => value.startsWith('body-')).length, 1);
  });
}

test('task-input rejection successful responses assert truthful closed evidence', async () => {
  const result = await exercise(['valid', 'valid']);
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.evidence, { status: 413, decoded: true, validated: true });
  assert.deepEqual(result.beforeBody, [422, 413].map(status => ({ status, decoded: false, validated: false })));
});

test('task-input rejection later real response assertion failure retains both milestones', async () => {
  failedFacts(await exercise(['assertion']), 0, true, true, { kind: 'other' });
});

for (const cleanupFailure of [false, true]) {
  test(`task-input rejection later private failure keeps closed facts; cleanup failure=${cleanupFailure}`, async () => {
    failedFacts(await exercise(['valid'], { laterFailure: true, cleanupFailure, unknownName: true }), 0, true, true,
      { kind: 'other', line: '789', observed: [{ status: 422, code: 'context.invalid_request', stage: null,
        certainty: 'not_applicable', acceptance_null: true, notices: 0 }] });
  });
}

for (const [option, decoded, secret, kind, line] of [
  ['body', false, 0, 'TypeError', '789'], ['utf8', false, 0, 'TypeError', 'none'],
  ['media', false, 0, 'ProtocolError', 'none'], ['json', false, 1, 'ProtocolError', 'none'],
  ['schema-extra', true, 1, 'ProtocolError', 'none'],
]) {
  test(`task-input rejection second ${option} failure resets prior successful evidence`, async () => {
    const result = await exercise(['valid', option]);
    failedFacts(result, 1, decoded, false, { secret, kind, line,
      observed: [{ status: 422, code: 'context.invalid_request', stage: null,
        certainty: 'not_applicable', acceptance_null: true, notices: 0 }] });
    assert.deepEqual(result.beforeBody, [422, 413].map(status => ({ status, decoded: false, validated: false })));
    assert.equal(result.calls.filter(value => value.startsWith('body-')).length, 2);
  });
}
