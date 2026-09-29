import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const installed=dirname(require.resolve('playwright/package.json'));
assert.equal(JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version,'1.58.2');
const source=ts.createSourceFile('playwright.js',readFileSync(join(installed,'lib/index.js'),'utf8'),ts.ScriptTarget.Latest,true);
const names=['SnapshotRecorder','ArtifactsRecorder','normalizeScreenshotMode','kTracingStarted'];
const declarations=source.statements.filter(node => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text))));
assert.equal(declarations.length,names.length);
const recorderSource=`${declarations.map(node => node.getText(source)).join('\n')}\nArtifactsRecorder`;
const specUrl=new URL('../e2e/tool-fidelity.spec.mjs',import.meta.url);
const spec=ts.createSourceFile('tool-fidelity.js',readFileSync(specUrl,'utf8'),ts.ScriptTarget.Latest,true);
const cases=spec.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(spec) === 'test');
assert.equal(cases.length,1);
const callbackSource=`(${cases[0].expression.arguments[1].getText(spec)})`.replaceAll('import.meta.url',JSON.stringify(specUrl.href));
const key='PLAYWRIGHT_NO_COPY_PROMPT';
const data=JSON.parse(readFileSync(new URL('../test-support/tool-fidelity.json',import.meta.url),'utf8'));
const privateText=[data.tasks[0],data.fixture_output,'12345678-1234-4234-8234-123456789012','synthetic-private-snapshot'].join('\n');
async function recorder(env) {
  const files=new Map();let snapshots=0;
  const Recorder=runInNewContext(recorderSource,{process:{env},import_fs:{default:{promises:{writeFile:async (path,text) => {files.set(path,text);}}}}},{timeout:1000});
  const page={_wrapApiCall:callback => callback(),_snapshotForAI:async () => {snapshots++;return {full:privateText};}};
  const context={open:true,tracing:{},pages:() => [page],_wrapApiCall:callback => callback()};
  const instance=new Recorder({_allContexts:() => context.open ? [context] : [],_allPages:() => context.open ? [page] : [],request:{_contexts:new Set()}},'unused','off');
  const info={errors:[new Error('synthetic timeout')],attachments:[],_tracing:{traceOptions:() => undefined},outputPath:name => name,_attach:attachment => {info.attachments.push(attachment);}};
  await instance.willStartTest(info);return {instance,context,files,info,snapshots:() => snapshots};
}
test('tool-fidelity installed recorder positive control captures unguarded synthetic DOM',async () => {
  const proof=await recorder({});await proof.instance.willCloseBrowserContext(proof.context);proof.context.open=false;await proof.instance.didFinishTest();
  assert.equal(proof.snapshots(),1);assert.ok(proof.files.size > 0 && proof.info.attachments.length > 0);
});
for(const failClose of [false,true]) {
  test(`tool-fidelity guard covers context creation and teardown; close failure=${failClose}`,async () => {
    for(const prior of [undefined,'','0','1','  prior value  ']) {
      const env=prior === undefined ? {} : {[key]:prior};const proof=await recorder(env);const guards=[];const output=[];let stopGuard;
      proof.context.route=async () => {throw Object.assign(new Error(privateText),{name:'TimeoutError'});};
      proof.context.close=async () => {
        guards.push(env[key]);await proof.instance.willCloseBrowserContext(proof.context);
        if(failClose && guards.length === 2) throw new Error(privateText);proof.context.open=false;
      };
      const callback=runInNewContext(callbackSource,{process:{env},executable:'synthetic-executable',
        startFixture:async () => ({owner:'synthetic-owner',stop:async () => {stopGuard=env[key];}}),console:{log:message => output.push(message)}},{timeout:1000});
      await assert.rejects(callback({browser:{newContext:async options => {
        guards.push(env[key]);assert.equal(JSON.stringify(options),JSON.stringify({serviceWorkers:'block'}));return proof.context;
      }}}),error => {output.push(error.message);return error.message.startsWith('Tool fidelity failed: startup; kind=TimeoutError;');});
      await proof.instance.didFinishTest();if(failClose) await proof.context.close();
      assert.deepEqual(guards,failClose ? ['1','1','1'] : ['1','1']);
      const expected=failClose ? '1' : prior;
      assert.equal(env[key],expected);assert.equal(stopGuard,expected);assert.equal(Object.hasOwn(env,key),expected !== undefined);
      assert.equal(proof.snapshots(),0);assert.equal(proof.files.size,0);assert.equal(proof.info.attachments.length,0);
      assert.ok(output.join('\n').length < 4096);
      for(const value of privateText.split('\n')) assert.equal(output.join('\n').includes(value),false);
    }
  });
}
test('tool-fidelity has no trace screenshots video HAR or substituted joined responses',() => {
  const use=spec.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(spec) === 'test.use');
  const options=runInNewContext(`(${use.expression.arguments[0].getText(spec)})`);
  assert.equal(JSON.stringify(options),JSON.stringify({trace:'off',screenshot:'off',video:'off'}));
  const text=readFileSync(specUrl,'utf8');
  for(const forbidden of ['route.fulfill','recordHar','recordVideo','.screenshot(','tracing.start','newCDPSession']) assert.equal(text.includes(forbidden),false);
});
