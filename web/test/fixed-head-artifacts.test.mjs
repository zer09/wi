import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const installed = dirname(require.resolve('playwright/package.json'));
assert.equal(JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version,'1.58.2');
const source = ts.createSourceFile('playwright.js',readFileSync(join(installed,'lib/index.js'),'utf8'),ts.ScriptTarget.Latest,true);
const names = ['SnapshotRecorder','ArtifactsRecorder','normalizeScreenshotMode','kTracingStarted'];
const declarations = source.statements.filter(node => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text))));
assert.equal(declarations.length,names.length);
const recorderSource = `${declarations.map(node => node.getText(source)).join('\n')}\nArtifactsRecorder`;
const specUrl = new URL('../e2e/task-fixed-head.spec.mjs',import.meta.url);
const spec = ts.createSourceFile('fixed-head.js',readFileSync(specUrl,'utf8'),ts.ScriptTarget.Latest,true);
const cases = spec.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(spec) === 'test');
assert.equal(cases.length,1);
const callbackSource = `(${cases[0].expression.arguments[1].getText(spec)})`.replaceAll('import.meta.url',JSON.stringify(specUrl.href));
const key = 'PLAYWRIGHT_NO_COPY_PROMPT';
const secret = 'synthetic-private-snapshot-not-for-artifacts';

async function recorder(env) {
  const files = new Map(); const contexts = []; let snapshots = 0;
  const Recorder = runInNewContext(recorderSource, { process:{env},
    import_fs:{default:{promises:{writeFile:async (path,text) => {files.set(path,text);}}}},
  }, {timeout:1000});
  const instance = new Recorder({_allContexts:() => contexts.filter(c => c.open),
    _allPages:() => contexts.filter(c => c.open).flatMap(c => c.pages()), request:{_contexts:new Set()}},'unused','off');
  const info = { errors:[new Error('synthetic timeout')], attachments:[], _tracing:{traceOptions:() => undefined},
    outputPath:name => name, _attach:attachment => {info.attachments.push(attachment);} };
  for (let index=0; index<2; index++) {
    const page = {_wrapApiCall:callback => callback(), _snapshotForAI:async () => {snapshots++; return {full:secret};}};
    contexts.push({open:true,tracing:{},pages:() => [page],_wrapApiCall:callback => callback()});
  }
  await instance.willStartTest(info);
  return {instance,contexts,files,info,snapshots:() => snapshots};
}

test('installed recorder positive control captures unguarded DOM in either context close order', async () => {
  for (const order of [[0,1],[1,0]]) {
    const proof = await recorder({});
    for (const index of order) {
      const context = proof.contexts[index];
      await proof.instance.willCloseBrowserContext(context); context.open=false;
    }
    await proof.instance.didFinishTest();
    // The installed recorder keeps one failure snapshot per test, not one per context.
    assert.equal(proof.snapshots(),1); assert.ok(proof.files.size > 0); assert.ok(proof.info.attachments.length > 0);
  }
});

for (const failClose of [[],[0],[1],[0,1]]) {
  test(`fixed-head installed recorder stays guarded through two context closes; failures=${failClose.join(',') || 'none'}`, async () => {
    for (const prior of [undefined,'','0','1','  prior value  ']) {
      const env = prior === undefined ? {} : {[key]:prior};
      const proof = await recorder(env); const closeGuards=[[],[]]; const createGuards=[]; const output=[];
      let stopGuard; let created=0;
      for (const [index,context] of proof.contexts.entries()) {
        context.route=async () => {throw Object.assign(new Error(secret),{name:'TimeoutError'});};
        context.close=async () => {
          closeGuards[index].push(env[key]);
          await proof.instance.willCloseBrowserContext(context);
          if (failClose.includes(index) && closeGuards[index].length === 1) throw new Error(secret);
          context.open=false;
        };
      }
      const callback=runInNewContext(callbackSource,{process:{env},executable:'synthetic-executable',
        startFixture:async () => ({owner:'synthetic-owner',stop:async () => {stopGuard=env[key];}}),
        console:{log:message => {output.push(message);}},
      },{timeout:1000});
      await assert.rejects(callback({browser:{newContext:async options => {
        createGuards.push(env[key]); assert.equal(JSON.stringify(options),JSON.stringify({serviceWorkers:'block'}));
        return proof.contexts[created++];
      }}}),error => {output.push(error.message); return error.message.startsWith('Fixed head failed: startup; kind=TimeoutError');});
      // Playwright still sees any context whose owned close failed.
      await proof.instance.didFinishTest();
      for (const index of failClose) await proof.contexts[index].close();
      assert.deepEqual(createGuards,['1','1']);
      for (let index=0; index<2; index++) assert.deepEqual(closeGuards[index],failClose.includes(index) ? ['1','1'] : ['1']);
      const expected = failClose.length ? '1' : prior;
      assert.equal(env[key],expected); assert.equal(stopGuard,expected);
      assert.equal(Object.hasOwn(env,key),expected !== undefined);
      assert.equal(proof.snapshots(),0); assert.equal(proof.files.size,0); assert.equal(proof.info.attachments.length,0);
      assert.ok(output.join('\n').length < 4096); assert.equal(output.join('\n').includes(secret),false);
    }
  });
}
