import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateCancelView } from '../dist/api.js';
import { validateTaskReconciliation } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import * as f from '../test-support/display-fixtures.mjs';

const text=readFileSync(new URL('../e2e/cancellation.spec.mjs',import.meta.url),'utf8');
const source=ts.createSourceFile('cancellation.js',text,ts.ScriptTarget.Latest,true);
const call=source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'test');
const callback=call.expression.arguments[1];
const attempt=callback.body.statements.find(ts.isTryStatement);
const declarations=callback.body.statements.filter(ts.isVariableStatement).map(node => node.getText(source)).join('\n');
const helpers=attempt.tryBlock.statements.filter(ts.isFunctionDeclaration);
const replyHelper=helpers.find(node => node.name.text === 'readReply').getText(source);
const boundaryHelper=helpers.find(node => node.name.text === 'boundary').getText(source);
const tail=callback.body.statements.slice(callback.body.statements.indexOf(attempt)+1).map(node => node.getText(source));
const cancelIndex=attempt.tryBlock.statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === 'cancel'));
const cancelStatements=attempt.tryBlock.statements.slice(cancelIndex,cancelIndex+3).map(node => node.getText(source)).join('\n');
const PRIVATE='synthetic-private-rejection-stack-and-cause';
const expect=value => ({toBe:expected => assert.equal(value,expected)});
const response=value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const data=JSON.parse(readFileSync(new URL('../test-support/cancellation.json',import.meta.url),'utf8'));
const task=data.task, command={operation_id:f.OID,run_id:f.RID,text:task};
const receipt={operation_id:f.OID,session_id:f.SID,run_id:f.RID,first_sequence:'2',last_sequence:'3'};
const result={outcome:{type:'cancelled_locally'},summary:{turns_started:'1',turns_finished:'1',model_requests_attempted:'1',model_requests_admitted:'1',
  new_tool_dispatches:'0',tool_results_prepared:'0',reused_results:'0',last_request_id:f.OTHER,last_upstream_outcome:'unknown'},events_complete:true,sink_error:null};
const run=head => ({api_version:1,run_id:f.RID,state:head === '9' ? 'cancelled_locally' : 'running',user_text:task,
  accepted_sequence:'2',terminal_sequence:head === '9' ? '8' : null,result_sequence:head === '9' ? '9' : null,result_recorded:head === '9',result:head === '9' ? result : null});
const reconciliation=head => ({api_version:1,state:'accepted',acceptance:receipt,run:run(head)});

for(const variant of ['valid','status','body','size','utf8','media','json','extra','identity','result']) test(`actual reconciliation reply helper stays closed: ${variant}`,async () => {
  const value=structuredClone(reconciliation('9'));
  if(variant === 'extra')value.private=PRIVATE;
  if(variant === 'identity')value.run.user_text='changed';
  if(variant === 'result')value.run.result_recorded=false;
  const reply={status:() => variant === 'status' ? 202 : 200,
    headers:() => ({'content-type':variant === 'media' ? 'text/plain' : 'application/json'}),
    body:async () => {
      if(variant === 'body')throw new Error(PRIVATE);
      if(variant === 'size')return Buffer.alloc(4097);
      if(variant === 'utf8')return Buffer.from([255]);
      if(variant === 'json')return Buffer.from('{');
      return Buffer.from(JSON.stringify(value));
    }};
  let accepted=false;
  try {await runInNewContext(`(async () => { ${replyHelper}; return readReply(reply,200,v => validateTaskReconciliation(v,{...command,session_id:sid}),4096); })()`,
    {reply,expect,decodeJson,validateTaskReconciliation,TextDecoder,command,sid:f.SID},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,variant === 'valid');
});

for(const variant of ['valid','status','body','size','utf8','media','json','extra','session','run','disposition']) test(`actual Cancel202 validation rejects substituted signal evidence: ${variant}`,async () => {
  const value={api_version:1,session_id:f.SID,run_id:f.RID,disposition:'requested'};
  if(variant === 'extra')value.private=PRIVATE;
  if(variant === 'session')value.session_id=f.OTHER;
  if(variant === 'run')value.run_id=f.OTHER;
  if(variant === 'disposition')value.disposition='not_tracked';
  const cancelResponse={status:() => variant === 'status' ? 200 : 202,
    headers:() => ({'content-type':variant === 'media' ? 'text/plain' : 'application/json'}),
    body:async () => {
      if(variant === 'body')throw new Error(PRIVATE);
      if(variant === 'size')return Buffer.alloc(4097);
      if(variant === 'utf8')return Buffer.from([255]);
      if(variant === 'json')return Buffer.from('{');
      return Buffer.from(JSON.stringify(value));
    }};
  let accepted=false;
  try {await runInNewContext(`(async () => { ${replyHelper}; ${cancelStatements} })()`,
    {cancelResponse,expect,decodeJson,validateCancelView,TextDecoder,command,sid:f.SID,observed:{cancels:0},isDeepStrictEqual:(a,b) => JSON.stringify(a) === JSON.stringify(b)},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,variant === 'valid');
});

const requestHandler=attempt.tryBlock.statements.find(node => ts.isExpressionStatement(node) && node.expression.expression?.getText(source) === 'context.on' && node.expression.arguments[0]?.text === 'request').expression.arguments[1].getText(source);
for(const variant of ['cancel','cancel-query','cancel-body','cancel-path','reconcile','reconcile-text','reconcile-query','raw-run','raw-history','private-url','cookie','authorization']) test(`actual request recorder retains public command and read boundary: ${variant}`,() => {
  const origin='http://127.0.0.1:1234',owner='f'.repeat(64);
  let path=`/v1/sessions/${f.SID}/runs/${f.RID}/cancel`,body='{}',method='POST';
  if(variant.startsWith('reconcile')){path=`/v1/sessions/${f.SID}/runs/reconcile`;body=JSON.stringify(command);}
  if(variant === 'cancel-query' || variant === 'reconcile-query')path+='?extra=1';
  if(variant === 'cancel-body')body='{ "extra":1 }';
  if(variant === 'cancel-path')path=`/v1/sessions/${f.SID}/runs/${f.OTHER}/cancel`;
  if(variant === 'reconcile-text')body=JSON.stringify({...command,text:'changed'});
  if(variant === 'raw-run'){method='GET';path=`/v1/sessions/${f.SID}/runs/${f.RID}`;}
  if(variant === 'raw-history'){method='GET';path=`/v1/sessions/${f.SID}/history`;}
  if(variant === 'private-url')path+='?private='+owner;
  const faults={external:0,private:0,request:0},posts={create:0,task:0,cancel:0,reconcile:0,other:0};
  const headers={authorization:`Bearer ${owner}`};
  if(variant === 'cookie')headers.cookie='synthetic';
  if(variant === 'authorization')headers.authorization='invalid';
  runInNewContext(`(${requestHandler})(request)`,{URL,Buffer,fixture:{origin,owner},faults,posts,command,sid:f.SID,
    identity:{session_id:f.SID,run_id:f.RID},requests:[],displayReads:[],observed:{latest:0,streams:0},files:new Map(),
    leaked:value => value.includes(owner),uuid:() => true,
    request:{url:() => origin+path,method:() => method,headers:() => headers,postDataJSON:() => JSON.parse(body),postData:() => body}},{timeout:1000});
  assert.equal(Object.values(faults).every(value => value === 0),variant === 'cancel' || variant === 'reconcile');
  if(variant === 'cancel')assert.equal(posts.cancel,1);
  if(variant === 'reconcile')assert.equal(posts.reconcile,1);
});

async function cleanupCase({prior,primary,closeFailure,stopFailure,auditFailure}) {
  const env=prior === undefined ? {} : {PLAYWRIGHT_NO_COPY_PROMPT:prior};
  const calls=[],output=[],cause=new TypeError(PRIVATE);cause.stack=PRIVATE;cause.cause=new Error(PRIVATE);
  let failure;
  try {
    await runInNewContext(`(async () => { ${declarations}; fixture=ownedFixture; context=ownedContext; stage='synthetic failure';identity=syntheticIdentity;terminal=syntheticTerminal;
      Object.assign(posts,{create:1,task:1,cancel:1,reconcile:3});process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';
      try {if(primary)throw cause;} ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)} ${tail.join('\n')} })()`,{
      process:{env},console:{log:value => output.push(value)},cause,primary,
      syntheticIdentity:{session_id:f.SID,run_id:f.RID,operation_id:f.OID},syntheticTerminal:f.OTHER,
      ownedContext:{close:async () => {calls.push('context');assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,'1');if(closeFailure)throw cause;}},
      ownedFixture:{request:async value => {calls.push(value.command);if(auditFailure)throw cause;return {session_id:f.SID,run_id:f.RID,operation_id:f.OID,terminal_operation_id:f.OTHER,
        exact:true,retired:true,prefix_unchanged:true,sequence_count:'9',hits:1,connections:1,requests:1,closed:true,dispatches:0,prepared_results:0,reused:0,result_records:1};},
        stop:async () => {calls.push('fixture');if(stopFailure)throw cause;}},
    },{timeout:1000});
  } catch(error) {failure=error;}
  const inspected=!primary && !closeFailure;
  assert.deepEqual(calls,inspected ? ['context','inspect_cancellation','fixture'] : ['context','fixture']);
  assert.equal([failure?.message,failure?.stack,...output].join('\n').includes(PRIVATE),false);
  if(primary)assert.equal(failure?.message.startsWith('Cancellation failed: synthetic failure; kind=TypeError;'),true);
  else if(closeFailure)assert.equal(failure?.message,'Cancellation browser cleanup failed');
  else if(auditFailure)assert.equal(failure?.message,'Cancellation post-cleanup audit failed');
  else if(stopFailure)assert.equal(failure?.message,'Cancellation fixture cleanup failed');
  else assert.equal(failure,undefined);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env,'PLAYWRIGHT_NO_COPY_PROMPT'),closeFailure || prior !== undefined);
  assert.equal(output[0],`Cancellation cleanup: context=${!closeFailure} fixture=${!stopFailure}`);
}
for(const prior of [undefined,'','owner-prior']) for(const closeFailure of [false,true]) for(const stopFailure of [false,true]) test(`actual primary fatal cleanup keeps guard and priority: prior=${prior === undefined ? 'absent' : 'present'} close=${closeFailure} stop=${stopFailure}`,
  () => cleanupCase({prior,primary:true,closeFailure,stopFailure,auditFailure:false}));
for(const closeFailure of [false,true]) for(const stopFailure of [false,true]) for(const auditFailure of [false,true]) test(`actual success cleanup inspects after context close and before Stop: close=${closeFailure} stop=${stopFailure} audit=${auditFailure}`,
  () => cleanupCase({prior:undefined,primary:false,closeFailure,stopFailure,auditFailure}));

for(const variant of ['public-field','bad-field','private-field','other-hash','private-text','storage','cookie','indexeddb','cache','worker','input','url','history','canary']) test(`actual detached privacy scan excludes only valid public field attributes: ${variant}`,async () => {
  const owner='f'.repeat(64);let original='a'.repeat(64),clones=0,removed=0;
  const dom={querySelectorAll:() => [{getAttribute:() => variant === 'bad-field' ? 'arbitrary' : variant === 'private-field' ? owner : original,
    removeAttribute:() => {removed++;}}],get outerHTML(){return variant === 'other-hash' ? 'b'.repeat(64) : variant === 'private-text' ? PRIVATE : '<main>safe</main>';}};
  const document={documentElement:{cloneNode:() => {clones++;return dom;}},querySelectorAll:() => variant === 'input' ? [{value:owner}] : [],cookie:variant === 'cookie' ? 'synthetic=1' : ''};
  const page={evaluate:async (fn,args) => runInNewContext(`(${fn.toString()})(args)`,{args,document,
    location:{href:variant === 'url' ? 'http://127.0.0.1/'+owner : 'http://127.0.0.1/'},history:{state:variant === 'history' ? owner : null},
    localStorage:{length:variant === 'storage' ? 1 : 0},sessionStorage:{length:0},
    indexedDB:{databases:async () => variant === 'indexeddb' ? [{}] : []},caches:{keys:async () => variant === 'cache' ? ['synthetic'] : []},
    navigator:{serviceWorker:{getRegistrations:async () => variant === 'worker' ? [{}] : []}},
    ...(variant === 'canary' ? {cancellationCanary:1} : {})},{timeout:1000}),locator:() => ({count:async () => 0})};
  let accepted=false;
  try {await runInNewContext(`(async () => {${boundaryHelper};await boundary();})()`,{page,fixture:{owner},markers:[PRIVATE],context:{cookies:async () => []},expect},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,variant === 'public-field');assert.equal(clones,1);assert.equal(original,'a'.repeat(64));
  assert.equal(removed,variant === 'bad-field' || variant === 'private-field' ? 0 : 1);
});

const tick=() => new Promise(resolve => setImmediate(resolve));
async function flush(){for(let n=0;n<5;n++)await tick();}
function supplied(head) {
  const human=f.human({fields:[f.field({field_id:'text',order_key:'0',generation:'2',text:task,total_bytes:String(Buffer.byteLength(task)),to_byte:String(Buffer.byteLength(task))})]});
  return f.page({snapshot_head:head,session:f.session(head),block:f.block({revision:head,human,state:run(head).state,result_recorded:head === '9',
    outcome:head === '9' ? result.outcome : null,summary:head === '9' ? result.summary : null,events_complete:head === '9' ? true : null}),
    entries:[],previous_block:null,live_after:f.cursor('l',head,'3','','')});
}
for(const terminate of ['disconnect','401']) test(`public controller retains signal-versus-terminal, frozen command, three reconciliations and late epoch isolation: ${terminate}`,async t => {
  const calls=[],published=[];let next=0,head='1',owner,cancels=0,unauthorized=false,acceptTask,lateReply;
  const client=createDisplayClient({crypto:{randomUUID:() => [f.OID,f.RID][next++]},fetch:async (path,init) => {
    calls.push({path,init,installed_head:client.snapshot().selected?.store?.observed_head??null});
    if(unauthorized)return new Response('',{status:401});
    if(path === '/v1/settings')return response({api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:true});
    if(path.startsWith('/v1/sessions?'))return response({api_version:1,entries:[],next_after_id:null,has_more:false});
    if(path.endsWith('/conversation'))return response(head === '1' ? f.page({snapshot_head:'1',session:f.session('1'),block:null,entries:[],previous_block:null,live_after:f.cursor('l','1','3','','')}) : supplied(head));
    if(path.includes('/conversation/events?'))return new Response(new ReadableStream({start(controller){owner=controller;},cancel(){cancels++;}}),{headers:{'Content-Type':'text/event-stream'}});
    if(path.endsWith('/runs/reconcile'))return lateReply ? new Promise(resolve => {lateReply=resolve;}) : response(reconciliation(head));
    if(path.endsWith('/cancel'))return new Response(JSON.stringify({api_version:1,session_id:f.SID,run_id:f.RID,disposition:'requested'}),{status:202,headers:{'Content-Type':'application/json'}});
    if(path.endsWith('/runs'))return new Promise(resolve => {acceptTask=resolve;});
    throw Error('Unexpected synthetic request');
  }});
  t.after(() => client.disconnect());client.subscribe(value => published.push(value));
  await client.connect('0123456789abcdef'.repeat(4));await client.selectSession(f.SID);await flush();
  client.setDraft(task);const sending=client.sendTask();await flush();
  const captured=client.snapshot().pending[0];assert.equal(captured.phase,'sending');assert.deepEqual(captured.command.body,command);
  assert.equal(Object.isFrozen(captured.command) && Object.isFrozen(captured.command.body),true);
  assert.throws(() => {captured.command.body.text='changed';},TypeError);
  client.setDraft('retained draft 雪');
  acceptTask(new Response(JSON.stringify({api_version:1,receipt,duplicate:false,warning_code:null,notices:[]}),{status:202,headers:{'Content-Type':'application/json'}}));
  await sending;await flush();
  const pending=client.snapshot().pending[0];assert.equal(pending.phase,'accepted');assert.deepEqual(pending.receipt,receipt);assert.equal(Object.isFrozen(pending.receipt),true);
  assert.equal(client.snapshot().draft,'retained draft 雪');
  const publish=async value => {owner.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`));await flush();};
  head='6';await publish(f.batch([{kind:'block.upsert',block:supplied(head).block}],head));
  await client.reconcileTask(f.OID);await flush();const h6=client.snapshot().selected.run_view;
  assert.deepEqual(h6,run('6'));
  await client.cancelCurrentRun();await flush();
  assert.deepEqual(client.snapshot().selected.cancel,{api_version:1,session_id:f.SID,run_id:f.RID,disposition:'requested'});
  assert.deepEqual(client.snapshot().selected.run_view,h6);
  const beforeH7=calls.length;head='7';await publish(f.batch([{kind:'block.upsert',block:supplied(head).block}],head));
  const paused=client.snapshot();assert.equal(calls.length,beforeH7);assert.deepEqual(paused.selected.run_view,h6);
  assert.equal(paused.selected.store.blocks[0].view.state,'running');assert.equal(paused.selected.store.blocks[0].view.result_recorded,false);
  assert.deepEqual(paused.selected.store.blocks[0].entries,[]);assert.equal(paused.selected.store.blocks[0].human.fields[0].ranges[0].text,task);
  head='9';await publish(f.batch([{kind:'block.upsert',block:supplied(head).block}],head));await client.reconcileTask(f.OID);await flush();
  assert.deepEqual(client.snapshot().selected.run_view,run('9'));
  assert.equal(client.snapshot().selected.store.blocks[0].view.state,'cancelled_locally');
  await client.reconnectLatest();await flush();await client.reconcileTask(f.OID);await flush();
  const rebased=client.snapshot();assert.deepEqual(rebased.selected.run_view,run('9'));assert.equal(rebased.draft,'retained draft 雪');
  assert.deepEqual(rebased.pending,[{...pending,reconciliation:'accepted'}]);assert.deepEqual(rebased.selected.store.blocks[0].entries,[]);
  assert.equal(calls.filter(call => call.path.includes('/conversation/events?')).length,2);
  for(const head of ['1','9']) {
    const streamIndex=calls.findIndex(call => call.path.endsWith(`after=${encodeURIComponent(f.cursor('l',head,'3','',''))}`));
    assert.equal(calls[streamIndex].installed_head,head);
    assert.equal(calls.slice(0,streamIndex).some(call => call.path.endsWith('/conversation')),true);
    assert.equal(published.some(value => value.selected?.store?.observed_head === head && value.selected.observation === 'connecting'),true);
  }
  const postCalls=calls.filter(call => call.init.method === 'POST');
  assert.deepEqual(postCalls.map(call => call.path),[`/v1/sessions/${f.SID}/runs`,`/v1/sessions/${f.SID}/runs/reconcile`,
    `/v1/sessions/${f.SID}/runs/${f.RID}/cancel`,...Array(2).fill(`/v1/sessions/${f.SID}/runs/reconcile`)]);
  for(const call of postCalls)assert.deepEqual(JSON.parse(call.init.body),call.path.endsWith('/cancel') ? {} : command);
  assert.equal(calls.every(call => !/\/(history|operations)(\/|$)/.test(call.path) && !(call.init.method === 'GET' && call.path.includes('/runs/'))),true);
  lateReply=true;const late=client.reconcileTask(f.OID);await flush();const lateCall=calls.at(-1),oldOwner=owner;
  if(terminate === '401'){unauthorized=true;await client.refreshSessions();}else client.disconnect();
  await flush();const cleared=client.snapshot();
  lateReply(response(reconciliation('9')));await late;await flush();
  assert.equal(lateCall.init.signal.aborted,true);assert.throws(() => oldOwner.enqueue(new Uint8Array([1])),TypeError);
  assert.deepEqual(client.snapshot(),cleared);assert.equal(cleared.connection,'disconnected');assert.equal(cleared.selected,null);assert.equal(cleared.draft,'');
  assert.deepEqual(cleared.pending,[]);assert.equal(cleared.settings,null);assert.equal(cleared.catalog,null);assert.equal(cancels,2);
  assert.equal(cleared.error?.category??null,terminate === '401' ? 'authentication' : null);
  assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length,1);
});

test('actual source replaces only raw display proof and retains native H6/H7/H9 gates and three inspections',() => {
  assert.equal(/installCancellationObserver|addInitScript|newCDPSession|cancellationCapture|\.skip\(/.test(text),false);
  assert.equal(text.includes("name:'Read run status'"),false);assert.equal(text.includes("name:'Reload history'"),false);
  assert.equal((text.match(/command:'inspect_cancellation'/g)??[]).length,3);
  for(const action of ['wait_cancellation_pending','wait_cancellation','release_cancellation'])assert.equal(text.includes(`command:'${action}'`),true);
  assert.equal((text.match(/await checkpoint\([1-4]\)/g)??[]).length,4);
  assert.equal(text.includes('if(number !== 2)'),true);
  assert.equal(text.includes('requests.length === beforePaused && posts.reconcile === 1'),true);
  assert.equal(text.includes("name:'Reconcile receipt (read only)',exact:true"),true);
  assert.equal(text.includes("name:'Reconnect latest',exact:true"),true);
  assert.equal(text.includes('rebased === settled'),true);
  assert.equal(text.includes('await fixture?.stop()'),true);assert.equal(text.includes('test.setTimeout(150_000)'),true);
});
