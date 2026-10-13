import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateErrorView, validateRenameView, validateSessionView } from '../dist/api.js';
import { validateConversationPage } from '../dist/display-api.js';

const url = new URL('../e2e/task-stale-history.spec.mjs', import.meta.url);
const source = ts.createSourceFile('task-stale-history.js', readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const attempt = callback.body.statements.find(ts.isTryStatement);
const statements = attempt.tryBlock.statements;
const responses = statements.filter(node => node.getText(source).startsWith('await Promise.all(['));
assert.equal(responses.length, 3);
const stages = responses.map(node => {
  const index = statements.indexOf(node);
  return [...statements.slice(0, index)].reverse().find(item => item.getText(source).startsWith('stage = '));
});
assert.ok(stages.every(Boolean));
const declarations = callback.body.statements.filter(ts.isVariableStatement);
const files = statements.find(node => node.getText(source).startsWith('const files = '));
const assets = statements.find(node => node.getText(source).startsWith('const assets = '));
const observer = statements.find(node => node.getText(source).startsWith("context.on('response'"));
const guard = statements.find(node => node.getText(source) === "process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';");
assert.ok(files && assets && observer && guard);
const tail = callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1, callback.body.statements.indexOf(attempt) + 3);
assert.equal(tail.length, 2);
assert.ok(tail[1].getText(source).startsWith('if (failure) throw failure;'));
// Execute the actual response statements and failure cleanup. Unavailable DOM/native proof is not simulated or logged.
const controlled = `(async () => {
  ${declarations.map(node => node.getText(source)).join('\n')}
  fixture = ownedFixture; context = ownedContext; page = ownedPage;
  sid = syntheticSession; taskPath = '/v1/sessions/' + sid + '/runs'; renamePath = '/v1/sessions/' + sid + '/rename';
  Object.assign(wire, syntheticWire);
  ${guard.getText(source)}
  ${files.getText(source)}
  ${assets.getText(source)}
  ${observer.getText(source)}
  capture(() => ({ observed, displayReads, cleanup }));
  try {
    ${responses.map((node, index) => `${stages[index].getText(source)}\n${node.getText(source)}\nawait later(${index});`).join('\n')}
  } ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
  ${tail.map(node => node.getText(source)).join('\n')}
})()`;
const sid = '11111111-1111-4111-8111-111111111111';
const operation = '22222222-2222-4222-8222-222222222222';
const PRIVATE = 'synthetic-private-response-cause-id-dom https://private.invalid/?token=synthetic';
const titles = ['synthetic initial title'], renames = ['synthetic renamed title'];
const session = title => ({ api_version: 1, session_id: sid, title, workspace: '/synthetic/workspace',
  created_at_ms: '1', updated_at_ms: title === titles[0] ? '1' : '2', head_sequence: title === titles[0] ? '1' : '2', view: 'canonical' });
const receipt = { operation_id: operation, session_id: sid, run_id: null, first_sequence: '2', last_sequence: '2' };
function valueFor(kind) {
  if (kind === 'latest') return { api_version: 1, conversation_version: 1, session_id: sid, snapshot_head: '1',
    session: session(titles[0]), block: null, entries: [], earlier_activity: null, previous_block: null,
    live_after: `g11l.${Buffer.from(JSON.stringify([1, sid, '1', '3', '', ''])).toString('base64url')}` };
  if (kind === 'rename') return { api_version: 1, receipt: { ...receipt }, duplicate: false, warning_code: null, catalog_refresh: 'updated' };
  if (kind === 'manifest') return session(renames[0]);
  return { api_version: 1, code: 'storage.stale_history', stage: 'acceptance', certainty: 'not_committed', acceptance: null, notices: [] };
}
const plain = value => JSON.parse(JSON.stringify(value));
const blank = () => ({ status: null, decoded: false, validated: false, exact: false });

async function exercise({ kind = 'reply', option = 'valid', laterFailure = false, closeFailure = false,
  stopFailure = false, prior } = {}) {
  const output = [], calls = [], beforeBody = [];
  const env = prior === undefined ? {} : { PLAYWRIGHT_NO_COPY_PROMPT: prior };
  const cause = new TypeError(PRIVATE);
  if (laterFailure) cause.name = PRIVATE;
  cause.stack = `${PRIVATE}\n    at task-stale-history.spec.mjs:789:4\n    at ${PRIVATE}`;
  let getter, onResponse, failure;
  const page = {
    privateContent: PRIVATE,
    waitForResponse: async predicate => {
      const paths = { latest: `/v1/sessions/${sid}/conversation`, rename: `/v1/sessions/${sid}/rename`,
        manifest: `/v1/sessions/${sid}`, reply: `/v1/sessions/${sid}/runs` };
      const selected = Object.keys(paths).find(name => predicate({ url: () => `http://127.0.0.1${paths[name]}`,
        request: () => ({ method: () => ['rename', 'reply'].includes(name) ? 'POST' : 'GET' }) }));
      assert.ok(selected);
      calls.push(`acquire-${selected}`);
      const variant = selected === kind ? option : 'valid';
      if (variant === 'acquisition') throw cause;
      const value = valueFor(selected);
      if (variant === 'schema') value.api_version = 2;
      if (variant === 'schema-extra') value.private = PRIVATE;
      if (variant === 'code') value.code = 'api.invalid_request';
      if (variant === 'stage') value.stage = null;
      if (variant === 'certainty') value.certainty = 'unknown';
      if (variant === 'acceptance') value.acceptance = { ...receipt };
      if (variant === 'notices') value.notices = [{ scope: 'project', source_label: 'synthetic', kind: 'skipped_symlink' }];
      if (variant === 'exact') {
        if (selected === 'latest') value.session.title = 'other';
        if (selected === 'rename') value.duplicate = true;
        if (selected === 'manifest') value.title = 'other';
      }
      const response = {
        url: () => `http://127.0.0.1${paths[selected]}`,
        request: () => ({ method: () => ['rename', 'reply'].includes(selected) ? 'POST' : 'GET' }),
        status: () => selected === 'reply' && variant !== 'status' ? 409 : 200,
        headers: () => ({ 'content-type': variant === 'media' ? `text/plain; private=${PRIVATE}` : 'application/json; charset=utf-8' }),
        body: async () => {
          calls.push(`body-${selected}`); beforeBody.push({ kind: selected, facts: plain(getter().observed[selected]) });
          if (variant === 'body') throw cause;
          if (variant === 'utf8') return Buffer.from([0xff]);
          if (variant === 'json') return Buffer.from(`{"private":"${PRIVATE}",`);
          return Buffer.from(JSON.stringify(value));
        },
      };
      onResponse(response);
      return response;
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button'); assert.equal(options.exact, true);
      assert.ok(['Open receipt session', 'Rename session'].includes(options.name));
      return { click: async () => { calls.push(options.name); } };
    },
  };
  try {
    await runInNewContext(controlled, {
      process: { env }, console: { log: message => output.push(message) }, URL, Buffer, TextDecoder,
      decodeJson, validateErrorView, validateRenameView, validateSessionView, validateConversationPage, titles, renames,
      syntheticSession: sid, syntheticWire: { create: { workspace: '/synthetic/workspace' }, rename: { operation_id: operation } },
      ownedPage: page, createCommand: page,
      ownedContext: { on: (event, listener) => { assert.equal(event, 'response'); onResponse = listener; },
        close: async () => { calls.push('browser-close'); assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, '1'); if (closeFailure) throw cause; } },
      ownedFixture: { request: async request => { assert.deepEqual(plain(request), { command: 'replay_head', step: 'release' });
        calls.push('release'); return { step: 'released' }; },
        stop: async () => { calls.push('fixture-stop'); if (stopFailure) throw cause; } },
      leaked: raw => raw.includes(PRIVATE), capture: value => { getter = value; },
      later: async index => { if (laterFailure && index === 2) throw cause; },
      expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
    }, { timeout: 1000 });
  } catch (error) { failure = error; }
  const serialized = [failure?.message ?? '', failure?.stack ?? '', ...output].join('\n');
  assert.equal(serialized.includes(PRIVATE) || serialized.includes('private.invalid') || serialized.includes(sid)
    || serialized.includes(operation) || serialized.includes(titles[0]) || serialized.includes('/synthetic/workspace'), false);
  assert.deepEqual(calls.slice(-2), ['browser-close', 'fixture-stop']);
  assert.deepEqual(output, [`Stale history cleanup: browser=${!closeFailure} fixture=${!stopFailure}`]);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT, closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env, 'PLAYWRIGHT_NO_COPY_PROMPT'), closeFailure || prior !== undefined);
  return { failure, evidence: plain(getter()), beforeBody, calls };
}

for (const [option, decoded, secret] of [
  ['acquisition', false, 0], ['body', false, 0], ['utf8', false, 0], ['media', false, 0],
  ['json', false, 1], ['schema', true, 0], ['schema-extra', true, 1],
]) {
  test(`stale-history actual Task statements retain private-safe ${option} milestones`, async () => {
    const result = await exercise({ option });
    assert.ok(result.failure);
    assert.deepEqual(result.evidence.observed.reply, { status: option === 'acquisition' ? null : 409, decoded, validated: false, exact: false });
    if (option !== 'acquisition') assert.deepEqual(result.beforeBody.at(-1), { kind: 'reply', facts: { status: 409, decoded: false, validated: false, exact: false } });
    const faults = { external: 0, console: 0, page: 0, secret, request: 0, asset: 0, response: 0 };
    const kind = ['acquisition', 'body', 'utf8'].includes(option) ? 'TypeError' : 'ProtocolError';
    const line = ['acquisition', 'body'].includes(option) ? '789' : 'none';
    assert.equal(result.failure.message, `Stale history failed: release and exact stale-history rejection; kind=${kind} line=${line}; capture=${JSON.stringify(result.evidence.observed)}; assets=null; faults=${JSON.stringify(faults)}; posts={"create":0,"task":0,"rename":0,"other":0}; display=${JSON.stringify(result.evidence.displayReads)}`);
  });
}

for (const option of ['status', 'code', 'stage', 'certainty', 'acceptance', 'notices']) {
  test(`stale-history closed exact-error check rejects ${option} without claiming exact`, async () => {
    const result = await exercise({ option });
    assert.ok(result.failure);
    assert.deepEqual(result.evidence.observed.reply, { status: option === 'status' ? 200 : 409, decoded: true, validated: true, exact: false });
  });
}

for (const kind of ['latest', 'rename', 'manifest']) for (const option of ['schema', 'exact']) {
  test(`stale-history actual ${kind} ${option} failure leaves later Task proof unavailable`, async () => {
    const result = await exercise({ kind, option });
    assert.ok(result.failure);
    assert.deepEqual(result.evidence.observed[kind], { status: 200, decoded: true, validated: option === 'exact', exact: false });
    assert.deepEqual(result.evidence.observed.reply, blank());
    if (kind === 'latest') {
      assert.deepEqual(result.evidence.observed.rename, blank());
      assert.deepEqual(result.evidence.observed.manifest, blank());
    }
    assert.equal(result.calls.includes('release'), false);
  });
}

test('stale-history successful actual response statements prove only closed C facts', async () => {
  const result = await exercise();
  assert.equal(result.failure, undefined);
  for (const kind of ['latest', 'rename', 'manifest', 'reply']) {
    assert.deepEqual(result.evidence.observed[kind], { status: kind === 'reply' ? 409 : 200, decoded: true, validated: true, exact: true });
  }
  assert.deepEqual(result.calls.filter(value => !value.startsWith('acquire-') && !value.startsWith('body-')),
    ['Open receipt session', 'Rename session', 'release', 'browser-close', 'fixture-stop']);
});

for (const cleanupFailure of [false, true]) {
  test(`stale-history later private failure survives cleanup failure=${cleanupFailure}`, async () => {
    const result = await exercise({ laterFailure: true, closeFailure: cleanupFailure, stopFailure: cleanupFailure });
    assert.ok(result.failure);
    assert.deepEqual(result.evidence.observed.reply, { status: 409, decoded: true, validated: true, exact: true });
    assert.ok(result.failure.message.startsWith('Stale history failed: release and exact stale-history rejection; kind=other line=789;'));
    assert.equal(result.failure.message.includes('cleanup failed'), false);
  });
}

for (const closeFailure of [false, true]) {
  test(`stale-history cleanup-only failure remains fatal; browser failure=${closeFailure}`, async () => {
    const result = await exercise({ closeFailure, stopFailure: true, prior: undefined });
    assert.equal(result.failure.message, closeFailure ? 'Stale history browser cleanup failed' : 'Stale history fixture cleanup failed');
  });
}
