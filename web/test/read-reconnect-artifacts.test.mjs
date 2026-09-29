import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { reconnectPrivacy } from '../test-support/read-reconnect-privacy.mjs';
const require=createRequire(import.meta.url);
const installed=dirname(require.resolve('playwright/package.json'));
assert.equal(JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version,'1.58.2');
const source=ts.createSourceFile('playwright.js',readFileSync(join(installed,'lib/index.js'),'utf8'),ts.ScriptTarget.Latest,true);
const names=['SnapshotRecorder','ArtifactsRecorder','normalizeScreenshotMode','kTracingStarted'];
const declarations=source.statements.filter(node => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text))));
assert.equal(declarations.length,names.length);
const recorderSource=`${declarations.map(node => node.getText(source)).join('\n')}\nArtifactsRecorder`;
const specUrl=new URL('../e2e/read-reconnect.spec.mjs',import.meta.url);
const spec=ts.createSourceFile('read-reconnect.js',readFileSync(specUrl,'utf8'),ts.ScriptTarget.Latest,true);
const cases=spec.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(spec) === 'test');
assert.equal(cases.length,1);
const callbackSource=`(${cases[0].expression.arguments[1].getText(spec)})`;
const key='PLAYWRIGHT_NO_COPY_PROMPT';
const privateText='synthetic-private-snapshot-and-header';
async function recorder(env) {
  const files=new Map();let snapshots=0;
  const Recorder=runInNewContext(recorderSource,{process:{env},import_fs:{default:{promises:{writeFile:async (path,text) => {files.set(path,text);}}}}});
  const page={_wrapApiCall:callback => callback(),_snapshotForAI:async () => {snapshots++;return {full:privateText};}};
  const context={open:true,tracing:{},pages:() => [page],_wrapApiCall:callback => callback()};
  const instance=new Recorder({_allContexts:() => context.open ? [context] : [],_allPages:() => context.open ? [page] : [],request:{_contexts:new Set()}},'unused','off');
  const info={errors:[new Error('synthetic timeout')],attachments:[],_tracing:{traceOptions:() => undefined},outputPath:name => name,_attach:attachment => {info.attachments.push(attachment);}};
  await instance.willStartTest(info);return {instance,context,files,info,snapshots:() => snapshots};
}
test('read reconnect installed recorder positive control captures unguarded DOM',async () => {
  const r=await recorder({});await r.instance.willCloseBrowserContext(r.context);r.context.open=false;await r.instance.didFinishTest();
  assert.equal(r.snapshots(),1);assert.ok(r.files.size > 0);
});
for(const contextFails of [false,true])for(const browserFails of [false,true]) {
  test(`revised spec suppresses failure artifacts across context=${contextFails} browser=${browserFails} teardown failures`,async () => {
    for(const prior of [undefined,'','0','1']) {
      const env=prior === undefined ? {} : {[key]:prior};const r=await recorder(env);const output=[];let launched=false;let stopped=false;
      const browser={version:() => '145.0.7632.6',newContext:async () => r.context,close:async () => {assert.equal(env[key],'1');if(browserFails)throw new Error(privateText);r.context.open=false;}};
      r.context.route=async () => {throw new Error(privateText);};
      r.context.close=async () => {assert.equal(env[key],'1');await r.instance.willCloseBrowserContext(r.context);if(contextFails)throw new Error(privateText);r.context.open=false;};
      const callback=runInNewContext(callbackSource,{process:{env},executable:'synthetic',
        reconnectPrivacy:() => {assert.equal(launched,false);},chromium:{launch:async () => {launched=true;assert.equal(env[key],'1');return browser;}},
        startFixture:async () => ({stop:async () => {stopped=true;}}),console:{log:value => output.push(value)}});
      await assert.rejects(callback({}, {project:{use:{}}}),error => {output.push(error.message);return error.message.startsWith('Read reconnect failed: startup;');});
      await r.instance.didFinishTest();assert.equal(stopped,true);
      assert.equal(env[key],contextFails || browserFails ? '1' : prior);
      assert.equal(r.snapshots(),0);assert.equal(r.files.size,0);assert.equal(r.info.attachments.length,0);
      assert.equal(output.join('\n').includes(privateText),false);
    }
  });
}
test('read reconnect privacy guard rejects protocol/API debug, custom loggers, netlog, and artifact capture',() => {
  for(const env of [{DEBUG:'pw:protocol'},{PWDEBUG:'1'},{DEBUG_FILE:'private'},{NODE_OPTIONS:'--require private'},{SSLKEYLOGFILE:'private'}])assert.throws(() => reconnectPrivacy({}, {},env));
  for(const use of [{trace:'retain-on-failure'},{screenshot:'only-on-failure'},{video:'on'},{recordHar:{}},{launchOptions:{args:['--log-net-log=private']}},{logger:{}}])assert.throws(() => reconnectPrivacy({},use,{}));
  assert.throws(() => reconnectPrivacy({_playwright:{_defaultLaunchOptions:{logger:{}}}}, {},{}));
  assert.throws(() => reconnectPrivacy({_connection:{_protocolLogger:() => {}}}, {},{}));
  reconnectPrivacy({}, {trace:'off',screenshot:'off',video:'off'},{});
});
