import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const installed = dirname(require.resolve('playwright/package.json'));
assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '1.58.2');
const source = ts.createSourceFile('playwright.js', readFileSync(join(installed, 'lib/index.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['SnapshotRecorder', 'ArtifactsRecorder', 'normalizeScreenshotMode', 'kTracingStarted'];
const declarations = source.statements.filter(node => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text))));
assert.equal(declarations.length, names.length);
const recorderSource = `${declarations.map(node => node.getText(source)).join('\n')}\nArtifactsRecorder`;
const specUrl = new URL('../e2e/rename-recovery.spec.mjs', import.meta.url);
const text = readFileSync(specUrl, 'utf8');
const spec = ts.createSourceFile('rename.js', text, ts.ScriptTarget.Latest, true);
const cases = spec.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(spec) === 'test');
assert.equal(cases.length, 1);
const callback = cases[0].expression.arguments[1];
const callbackSource = `(${callback.getText(spec)})`.replaceAll('import.meta.url', JSON.stringify(specUrl.href));
const key = 'PLAYWRIGHT_NO_COPY_PROMPT';
const privateText = 'synthetic-private-rename-recorder';

async function recorder(env, kind = 'Error') {
  const attempts = { snapshots: 0, writes: 0, attachments: 0 };
  const Recorder = runInNewContext(recorderSource, { process: { env },
    import_fs: { default: { promises: { writeFile: async () => { attempts.writes++; } } } } }, { timeout: 1000 });
  // Text never leaves this in-memory synthetic recorder. Writes and attachments only count attempts.
  const page = { _wrapApiCall: action => action(), _snapshotForAI: async () => { attempts.snapshots++; return { full: privateText }; } };
  const context = { open: true, tracing: {}, pages: () => [page], _wrapApiCall: action => action() };
  const instance = new Recorder({ _allContexts: () => context.open ? [context] : [], _allPages: () => context.open ? [page] : [],
    request: { _contexts: new Set() } }, 'unused', 'off');
  const info = { errors: [Object.assign(new Error(privateText), { name: kind })], attachments: [],
    _tracing: { traceOptions: () => undefined }, outputPath: name => name,
    _attach: () => { attempts.attachments++; } };
  await instance.willStartTest(info);
  return { instance, context, attempts };
}

test('rename installed recorder unguarded positive control detects snapshot/write/attachment attempts only in memory', async () => {
  const proof = await recorder({});
  await proof.instance.willCloseBrowserContext(proof.context);
  proof.context.open = false;
  await proof.instance.didFinishTest();
  assert.deepEqual(proof.attempts, { snapshots: 1, writes: 1, attachments: 1 });
});

for (const kind of ['Error', 'TimeoutError']) {
  for (const failClose of [false, true]) {
    test(`rename actual callback guard covers ${kind} failure; failed owned close=${failClose}`, async () => {
      for (const prior of [undefined, '', '0', '1', '  prior value  ']) {
        const env = prior === undefined ? {} : { [key]: prior };
        const proof = await recorder(env, kind);
        const guards = [], order = [], output = [];
        let closes = 0, stopGuard, failure;
        proof.context.route = async () => { throw Object.assign(new Error(privateText), { name: kind }); };
        proof.context.close = async () => {
          guards.push(env[key]); order.push('browser-close');
          await proof.instance.willCloseBrowserContext(proof.context);
          if (failClose && ++closes === 1) throw new Error(privateText);
          proof.context.open = false;
        };
        const actual = runInNewContext(callbackSource, { process: { env }, createHash, executable: 'synthetic-executable',
          startFixture: async () => ({ owner: 'synthetic-owner', stop: async () => { order.push('fixture-stop'); stopGuard = env[key]; }, evidence: () => null }),
          console: { log: value => output.push(value) } }, { timeout: 1000 });
        try {
          await actual({ browser: { newContext: async options => {
            guards.push(env[key]); order.push('context-create');
            assert.equal(JSON.stringify(options), JSON.stringify({ serviceWorkers: 'block' }));
            return proof.context;
          } } });
        } catch (error) { failure = error; }
        assert.ok(failure);
        assert.match(failure.message, /^Rename recovery failed: startup;/);
        await proof.instance.didFinishTest();
        if (failClose) await proof.context.close();
        assert.deepEqual(order, failClose ? ['context-create', 'browser-close', 'fixture-stop', 'browser-close'] : ['context-create', 'browser-close', 'fixture-stop']);
        assert.deepEqual(guards, failClose ? ['1', '1', '1'] : ['1', '1']);
        const expected = failClose ? '1' : prior;
        assert.equal(stopGuard, expected);
        assert.equal(env[key], expected);
        assert.equal(Object.hasOwn(env, key), expected !== undefined);
        assert.deepEqual(proof.attempts, { snapshots: 0, writes: 0, attachments: 0 });
        assert.equal([failure.message, failure.stack, ...output].some(value => value.includes(privateText)), false);
        const evidence = JSON.parse(output[0].slice('Rename recovery evidence: '.length));
        assert.deepEqual(evidence.cleanup, { interceptor: 'unavailable', browser: failClose ? 'failed' : 'succeeded', fixture: 'succeeded' });
      }
    });
  }
}

test('rename rejected context creation retains guard through Stop, recorder finalization and later owned close', async () => {
  const env = { [key]: '' }, proof = await recorder(env);
  const guards = [], output = [];
  const actual = runInNewContext(callbackSource, { process: { env }, createHash, executable: 'synthetic-executable',
    startFixture: async () => ({ owner: 'synthetic-owner', stop: async () => { guards.push(env[key]); }, evidence: () => null }),
    console: { log: value => output.push(value) } }, { timeout: 1000 });
  await assert.rejects(actual({ browser: { newContext: async () => { guards.push(env[key]); throw new Error(privateText); } } }),
    error => error.message.startsWith('Rename recovery failed: startup;') && !error.message.includes(privateText));
  await proof.instance.didFinishTest();
  await proof.instance.willCloseBrowserContext(proof.context);
  proof.context.open = false;
  assert.deepEqual(guards, ['1', '1']);
  assert.equal(env[key], '1');
  assert.deepEqual(proof.attempts, { snapshots: 0, writes: 0, attachments: 0 });
  assert.equal(JSON.parse(output[0].slice('Rename recovery evidence: '.length)).cleanup.browser, 'unavailable');
});

const attempt = callback.body.statements.find(ts.isTryStatement);
const contextRoute = attempt.tryBlock.statements.findIndex(node => node.getText(spec).startsWith('await context.route('));
assert.ok(contextRoute > 0);
// Supply only an installed interceptor to the real startup/guard/catch/cleanup seam.
const cleanupSource = `(async () => {
  ${callback.body.statements.filter(node => node !== attempt).slice(0, callback.body.statements.indexOf(attempt)).map(node => node.getText(spec)).join('\n')}
  loss = ownedLoss;
  try { ${attempt.tryBlock.statements.slice(0, contextRoute + 1).map(node => node.getText(spec)).join('\n')} }
  ${attempt.catchClause.getText(spec)} finally ${attempt.finallyBlock.getText(spec)}
  ${callback.body.statements.slice(callback.body.statements.indexOf(attempt) + 1).map(node => node.getText(spec)).join('\n')}
})()`;
for (const failClose of [false, true]) {
  test(`rename interceptor failure still attempts guarded close and fixture Stop; failed close=${failClose}`, async () => {
    const env = {}, proof = await recorder(env), order = [], output = [];
    proof.context.route = async () => { throw new Error(privateText); };
    proof.context.close = async () => {
      order.push(['browser-close', env[key]]);
      await proof.instance.willCloseBrowserContext(proof.context);
      if (failClose) throw new Error(privateText);
      proof.context.open = false;
    };
    await assert.rejects(runInNewContext(cleanupSource, { process: { env }, createHash, executable: 'synthetic-executable',
      browser: { newContext: async () => proof.context },
      ownedLoss: { stop: async () => { order.push(['interceptor-stop', env[key]]); throw new Error(privateText); } },
      startFixture: async () => ({ owner: 'synthetic-owner', stop: async () => { order.push(['fixture-stop', env[key]]); }, evidence: () => null }),
      console: { log: value => output.push(value) } }, { timeout: 1000 }),
    error => error.message.startsWith('Rename recovery failed: startup;') && !error.message.includes(privateText));
    await proof.instance.didFinishTest();
    assert.deepEqual(order, [['interceptor-stop', '1'], ['browser-close', '1'], ['fixture-stop', failClose ? '1' : undefined]]);
    assert.deepEqual(proof.attempts, { snapshots: 0, writes: 0, attachments: 0 });
    const evidence = JSON.parse(output[0].slice('Rename recovery evidence: '.length));
    assert.deepEqual(evidence.cleanup, { interceptor: 'failed', browser: failClose ? 'failed' : 'succeeded', fixture: 'succeeded' });
  });
}

test('rename retains off recording modes and only its original reply-loss interceptor', () => {
  const use = spec.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(spec) === 'test.use');
  const options = runInNewContext(`(${use.expression.arguments[0].getText(spec)})`);
  assert.equal(JSON.stringify(options), JSON.stringify({ trace: 'off', screenshot: 'off', video: 'off' }));
  for (const forbidden of ['route.fulfill', 'recordHar', 'recordVideo', '.screenshot(', 'tracing.start', '_snapshotForAI', 'addInitScript', 'Object.freeze =', 'fetch =']) assert.equal(text.includes(forbidden), false);
  assert.equal(text.split('newCDPSession').length - 1, 1);
  assert.ok(text.includes('armReplyLoss(await context.newCDPSession(page), renameUrl, 200)'));
});
