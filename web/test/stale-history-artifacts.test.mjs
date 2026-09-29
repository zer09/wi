import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const specs = [['stale-history', 'Stale history'], ['acceptance-unknown', 'Acceptance unknown'],
  ['acceptance-warning', 'Acceptance warning'], ['incomplete-history', 'Incomplete history'],
  ['account-mismatch', 'Account mismatch'], ['unbound-history', 'Unbound history']].map(([name, label]) => {
  const specUrl = new URL(`../e2e/task-${name}.spec.mjs`, import.meta.url);
  const spec = ts.createSourceFile(`task-${name}.spec.mjs`, readFileSync(specUrl, 'utf8'), ts.ScriptTarget.Latest, true);
  const cases = spec.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(spec) === 'test');
  assert.equal(cases.length, 1);
  // VM scripts have no import.meta; keep the spec's URL without importing its E2E module.
  const callbackSource = `(${cases[0].expression.arguments[1].getText(spec)})`.replaceAll('import.meta.url', JSON.stringify(specUrl.href));
  return { name, label, callbackSource };
});
const key = 'PLAYWRIGHT_NO_COPY_PROMPT';
const markers = ['synthetic-task-snapshot', 'synthetic-title-snapshot', '12345678-1234-4234-8234-123456789abc'];
const snapshot = markers.join('\n');

async function recorder(env) {
  const files = new Map();
  let snapshots = 0;
  let open = true;
  const page = {
    _wrapApiCall: callback => callback(),
    _snapshotForAI: async () => { snapshots++; return { full: snapshot }; },
  };
  const context = { tracing: {}, pages: () => [page], _wrapApiCall: callback => callback() };
  // Execute the installed recorder, but keep its filesystem writes and page data in memory.
  const Recorder = runInNewContext(recorderSource, {
    process: { env },
    import_fs: { default: { promises: { writeFile: async (path, text) => { files.set(path, text); } } } },
  }, { timeout: 1000 });
  const instance = new Recorder({
    _allContexts: () => open ? [context] : [], _allPages: () => open ? [page] : [],
    request: { _contexts: new Set() },
  }, 'unused', 'off');
  const info = {
    errors: [new Error('synthetic timeout')], attachments: [],
    _tracing: { traceOptions: () => undefined },
    outputPath: name => name,
    _attach: attachment => { info.attachments.push(attachment); },
  };
  await instance.willStartTest(info);
  return { instance, context, files, info, snapshots: () => snapshots, closed: () => { open = false; } };
}

test('installed Playwright failure recorder captures synthetic DOM even with tracing and screenshots off', { timeout: 5000 }, async () => {
  const proof = await recorder({});
  await proof.instance.willCloseBrowserContext(proof.context);
  proof.closed();
  await proof.instance.didFinishTest();
  assert.equal(proof.snapshots(), 1);
  assert.equal(proof.files.size, 1);
  assert.equal(proof.files.get('error-context.md')?.includes(snapshot), true);
  assert.equal(proof.info.attachments.length, 1);
  assert.equal(proof.info.attachments[0].name, 'error-context');
});

for (const { name, label, callbackSource } of specs) for (const closeFails of [false, true]) {
  test(`${name} guard suppresses installed failure capture when owned context close ${closeFails ? 'fails' : 'succeeds'}`, { timeout: 5000 }, async () => {
    for (const prior of [undefined, '', '0', '  synthetic prior value  ', '1']) {
      const env = prior === undefined ? {} : { [key]: prior };
      const proof = await recorder(env);
      const output = [];
      const closeGuards = [];
      let creationGuard;
      let stopGuard;
      let optionsSafe = false;
      proof.context.route = async () => { throw Object.assign(new Error(snapshot), { name: 'TimeoutError' }); };
      proof.context.close = async () => {
        closeGuards.push(env[key]);
        await proof.instance.willCloseBrowserContext(proof.context);
        // A rejected owned close leaves the page available to Playwright's later fixture cleanup.
        if (closeFails && closeGuards.length === 1) throw new Error('synthetic close failure');
        proof.closed();
      };
      const callback = runInNewContext(callbackSource, {
        process: { env }, createHash, executable: 'synthetic-executable',
        startFixture: async () => ({ owner: 'synthetic-owner', stop: async () => { stopGuard = env[key]; } }),
        console: { log: message => { output.push(message); } },
      }, { timeout: 1000 });
      await assert.rejects(callback({ browser: { newContext: async options => {
        creationGuard = env[key];
        optionsSafe = JSON.stringify(options) === JSON.stringify({ serviceWorkers: 'block' });
        return proof.context;
      } } }), error => {
        output.push(error.message);
        return error.message.startsWith(`${label} failed: startup; kind=TimeoutError`);
      });
      await proof.instance.didFinishTest();
      if (closeFails) await proof.context.close();
      assert.equal(proof.snapshots(), 0, 'failure DOM must not be captured');
      assert.equal(proof.files.size, 0, 'no artifact writes');
      assert.equal(proof.info.attachments.length, 0, 'no artifact attachments');
      assert.equal(optionsSafe, true);
      assert.equal(creationGuard, '1', 'guard precedes context creation');
      assert.deepEqual(closeGuards, closeFails ? ['1', '1'] : ['1']);
      const expected = closeFails ? '1' : prior;
      assert.equal(stopGuard, expected);
      assert.equal(env[key], expected);
      assert.equal(Object.hasOwn(env, key), expected !== undefined, 'originally absent variable is deleted only after safe close');
      const text = output.join('\n');
      assert.ok(text.length < 4096);
      assert.equal(markers.some(marker => text.includes(marker)), false, 'diagnostics omit synthetic task/title/UUID');
    }
  });
}
