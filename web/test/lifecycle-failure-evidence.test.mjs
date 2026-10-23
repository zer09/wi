import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { decodeJson } from '../dist/api.js';
import { validateTaskReconciliation } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import * as f from '../test-support/display-fixtures.mjs';

const text=readFileSync(new URL('../e2e/lifecycle-failure.spec.mjs',import.meta.url),'utf8');
const source=ts.createSourceFile('lifecycle-failure.js',text,ts.ScriptTarget.Latest,true);
const call=source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'test');
const callback=call.expression.arguments[1];
const attempt=callback.body.statements.find(ts.isTryStatement);
const declarations=callback.body.statements.filter(ts.isVariableStatement).map(node => node.getText(source)).join('\n');
const helpers=attempt.tryBlock.statements.filter(ts.isFunctionDeclaration);
const replyHelper=helpers.find(node => node.name.text === 'readReply').getText(source);
const boundaryHelper=helpers.find(node => node.name.text === 'boundary').getText(source);
const checkpointHelper=helpers.find(node => node.name.text === 'checkpoint').getText(source);
const data=JSON.parse(readFileSync(new URL('../test-support/lifecycle-failure.json',import.meta.url),'utf8'));
const tail=callback.body.statements.slice(callback.body.statements.indexOf(attempt)+1).map(node => node.getText(source));
const PRIVATE='synthetic-private-rejection-stack-and-cause';
const expect=value => ({toBe:expected => assert.equal(value,expected)});
const response=value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const receipt={operation_id:f.OID,session_id:f.SID,run_id:f.RID,first_sequence:'2',last_sequence:'3'};
const task='  Add 17 and 25. 雪\n';
const command={operation_id:f.OID,run_id:f.RID,text:task};
const run=head => ({api_version:1,run_id:f.RID,state:head === '19' ? 'failed' : 'running',user_text:task,
  accepted_sequence:'2',terminal_sequence:head === '19' ? '19' : null,result_sequence:null,result_recorded:false,result:null});
const reconciliation=head => ({api_version:1,state:'accepted',acceptance:receipt,run:run(head)});

for(const variant of ['valid','status','body','size','utf8','media','json','extra','identity','result']) test(`actual reply helper keeps reconciliation closed: ${variant}`,async () => {
  const value=reconciliation('19');
  if(variant === 'extra')value.private=PRIVATE;
  if(variant === 'identity')value.run.user_text='changed';
  if(variant === 'result')value.run.result_recorded=true;
  const cause=new Error(PRIVATE);
  const reply={status:() => variant === 'status' ? 202 : 200,
    headers:() => ({'content-type':variant === 'media' ? 'text/plain' : 'application/json'}),
    body:async () => {
      if(variant === 'body')throw cause;
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

for(const prior of [undefined,'','owner-prior']) for(const closeFailure of [false,true]) for(const stopFailure of [false,true]) test(`actual fatal cleanup preserves privacy guard and first failure: prior=${prior === undefined ? 'absent' : 'present'} close=${closeFailure} stop=${stopFailure}`,async () => {
  const env=prior === undefined ? {} : {PLAYWRIGHT_NO_COPY_PROMPT:prior};
  const calls=[],output=[],cause=new TypeError(PRIVATE);cause.stack=PRIVATE;cause.cause=new Error(PRIVATE);
  let failure;
  try {
    await runInNewContext(`(async () => { ${declarations}; fixture=ownedFixture; context=ownedContext; stage='synthetic failure';
      process.env.PLAYWRIGHT_NO_COPY_PROMPT='1'; try {throw cause;} ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
      ${tail.join('\n')} })()`,{
      process:{env},console:{log:value => output.push(value)},cause,
      ownedContext:{close:async () => {calls.push('context');assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,'1');if(closeFailure)throw cause;}},
      ownedFixture:{stop:async () => {calls.push('fixture');if(stopFailure)throw cause;}},
    },{timeout:1000});
  } catch(error) {failure=error;}
  assert.deepEqual(calls,['context','fixture']);
  assert.equal(failure?.message.startsWith('Lifecycle failure failed: synthetic failure; kind=TypeError;'),true);
  assert.equal([failure?.message,failure?.stack,...output].join('\n').includes(PRIVATE),false);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,closeFailure ? '1' : prior);
  assert.equal(Object.hasOwn(env,'PLAYWRIGHT_NO_COPY_PROMPT'),closeFailure || prior !== undefined);
  assert.deepEqual(output,[`Lifecycle failure cleanup: context=${!closeFailure} fixture=${!stopFailure}`]);
});

for(const variant of ['public-field','bad-field','private-field','other-hash','private-text','storage']) test(`actual detached privacy scan permits only public field attributes: ${variant}`,async () => {
  const owner='f'.repeat(64);let original='a'.repeat(64),clones=0,removed=0;
  const safe=variant === 'public-field';
  const dom={querySelectorAll:() => [{getAttribute:() => variant === 'bad-field' ? 'arbitrary' : variant === 'private-field' ? owner : original,
    removeAttribute:() => {removed++;}}],get outerHTML(){return variant === 'other-hash' ? 'b'.repeat(64) : variant === 'private-text' ? PRIVATE : '<main>safe</main>';}};
  const document={documentElement:{cloneNode:() => {clones++;return dom;}},querySelectorAll:() => [],cookie:''};
  const page={evaluate:async (fn,args) => runInNewContext(`(${fn.toString()})(args)`,{args,document,location:{href:'http://127.0.0.1/'},history:{state:null},
    localStorage:{length:variant === 'storage' ? 1 : 0},sessionStorage:{length:0},indexedDB:{databases:async () => []},caches:{keys:async () => []},navigator:{serviceWorker:{getRegistrations:async () => []}}},{timeout:1000}),
    locator:() => ({count:async () => 0})};
  let accepted=false;
  try {await runInNewContext(`(async () => {${boundaryHelper};await boundary();})()`,{page,fixture:{owner},markers:[PRIVATE],context:{cookies:async () => []},expect},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,safe);assert.equal(clones,1);assert.equal(original,'a'.repeat(64));
  assert.equal(removed,variant === 'bad-field' || variant === 'private-field' ? 0 : 1);
});

const tick=() => new Promise(resolve => setImmediate(resolve));
async function flush(){for(let n=0;n<5;n++)await tick();}
function supplied(head) {
  const human=f.human({fields:[f.field({field_id:'text',order_key:'0',generation:'2',text:task,total_bytes:String(Buffer.byteLength(task)),to_byte:String(Buffer.byteLength(task))})]});
  return f.page({snapshot_head:head,session:f.session(head),block:f.block({revision:head,human,state:head === '19' ? 'failed' : 'running'}),
    entries:[],previous_block:null,live_after:f.cursor('l',head,'3','','')});
}
for(const terminate of ['disconnect','401']) test(`public controller keeps immutable command and four actual reconciliation RunViews through rebase; ${terminate}`,async t => {
  const calls=[],published=[];let next=0,head='1',owner,cancels=0,unauthorized=false;
  const client=createDisplayClient({crypto:{randomUUID:() => [f.OID,f.RID][next++]},fetch:async (path,init) => {
    calls.push({path,init,installed_head:client.snapshot().selected?.store?.observed_head??null});
    if(unauthorized)return new Response('',{status:401});
    if(path === '/v1/settings')return response({api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:true});
    if(path.startsWith('/v1/sessions?'))return response({api_version:1,entries:[],next_after_id:null,has_more:false});
    if(path.endsWith('/conversation'))return response(head === '1' ? f.page({snapshot_head:'1',session:f.session('1'),block:null,entries:[],previous_block:null,live_after:f.cursor('l','1','3','','')}) : supplied(head));
    if(path.includes('/conversation/events?'))return new Response(new ReadableStream({start(controller){owner=controller;},cancel(){cancels++;}}),{headers:{'Content-Type':'text/event-stream'}});
    if(path.endsWith('/runs/reconcile'))return response(reconciliation(head));
    if(path.endsWith('/runs'))return new Response(JSON.stringify({api_version:1,receipt,duplicate:false,warning_code:null,notices:[]}),{status:202,headers:{'Content-Type':'application/json'}});
    throw Error('Unexpected synthetic request');
  }});
  t.after(() => client.disconnect());client.subscribe(value => published.push(value));
  await client.connect('0123456789abcdef'.repeat(4));await client.selectSession(f.SID);await flush();
  client.setDraft(task);await client.sendTask();await flush();
  const pending=client.snapshot().pending[0];
  assert.deepEqual(pending.command.body,command);assert.deepEqual(pending.receipt,receipt);
  assert.equal(Object.isFrozen(pending.command) && Object.isFrozen(pending.command.body) && Object.isFrozen(pending.receipt),true);
  assert.throws(() => {pending.command.body.text='changed';},TypeError);
  for(const barrier of ['13','16','19','19']) {
    const rebase=barrier === '19' && head === '19';head=barrier;
    if(rebase) {
      client.setDraft('retained draft 雪');await client.reconnectLatest();await flush();
      assert.equal(client.snapshot().draft,'retained draft 雪');assert.deepEqual(client.snapshot().pending,[{...pending,reconciliation:'accepted'}]);
    } else {
      const suppliedPage=supplied(head),value=f.batch([{kind:'block.upsert',block:suppliedPage.block}],head);
      owner.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`));await flush();
    }
    const count=calls.length;await client.reconcileTask(f.OID);await flush();
    assert.equal(calls.length,count+1);assert.equal(calls.at(-1).path,`/v1/sessions/${f.SID}/runs/reconcile`);
    assert.equal(calls.at(-1).init.method,'POST');assert.deepEqual(JSON.parse(calls.at(-1).init.body),command);
    const snapshot=client.snapshot();assert.deepEqual(snapshot.selected.run_view,run(head));
    assert.equal(snapshot.pending[0].phase,'accepted');assert.equal(snapshot.pending[0].reconciliation,'accepted');
    assert.deepEqual(snapshot.pending[0].command,pending.command);assert.deepEqual(snapshot.pending[0].receipt,receipt);
    assert.equal(snapshot.selected.store.blocks[0].view.state,run(head).state);
    assert.equal(snapshot.selected.store.blocks[0].view.result_recorded,false);
  }
  assert.deepEqual(calls.filter(call => call.init.method === 'POST').map(call => call.path),[`/v1/sessions/${f.SID}/runs`,...Array(4).fill(`/v1/sessions/${f.SID}/runs/reconcile`)]);
  assert.equal(calls.filter(call => call.path.includes('/conversation/events?')).length,2);
  for(const head of ['1','19']) {
    const latestIndex=calls.findIndex(call => call.path.endsWith('/conversation') && (head === '1' || calls.indexOf(call)>3));
    const streamIndex=calls.findIndex(call => call.path.endsWith(`after=${encodeURIComponent(f.cursor('l',head,'3','',''))}`));
    assert.equal(latestIndex < streamIndex,true);
    assert.equal(calls[streamIndex].installed_head,head);
  }
  const installed=published.findIndex(value => value.selected?.store?.observed_head === '19' && value.selected.observation === 'connecting');
  assert.equal(installed >= 0,true);
  assert.equal(calls.every(call => !/\/(history|operations)(\/|$)/.test(call.path) && !(call.init.method === 'GET' && call.path.includes('/runs/'))),true);
  const before=calls.length;
  if(terminate === '401'){unauthorized=true;await client.reconcileTask(f.OID);}else client.disconnect();
  await flush();
  const cleared=client.snapshot();assert.equal(cleared.connection,'disconnected');assert.equal(cleared.selected,null);assert.equal(cleared.draft,'');assert.deepEqual(cleared.pending,[]);
  assert.equal(cleared.settings,null);assert.equal(cleared.catalog,null);assert.equal(cancels,2);assert.equal(calls.length,before+(terminate === '401' ? 1 : 0));
  assert.equal(cleared.error?.category??null,terminate === '401' ? 'authentication' : null);
});

// Execute the current checkpoint and fatal cleanup, with finite asynchronous polling and locator seams.
async function checkpointCase(number,{samples,entry=number === 1 ? 2 : 3,failAt,failEntry=null,invalid,closeFailure=false,stopFailure=false}={}) {
  const failed=number >= 3,execution=failed ? 'failed' : 'running',last=number === 1 ? 2 : 3;
  const fields=[[data.task],['add_numbers',data.arguments],['add_numbers',data.output]];
  if(number >= 2)fields.push(failed ? ['Request failed',data.partial] : [data.partial]);
  const states=['Recorded state: accepted; Provisional: false','Recorded state: completed; Provisional: false',
    'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false'];
  if(number >= 2)states.push(`Recorded state: ${failed ? 'failed' : 'in_progress'}; Provisional: true`);
  const command={operation_id:f.OID,run_id:f.RID,text:data.task};
  const details=failed ? `Run: ${f.RID}\nAccepted sequence: 2\nOutcome: failed\nCode: provider_request_failed\nEvents complete: not recorded\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 1\ntool_results_prepared: 1\nreused_results: 0\nlast_request_id: ${f.OID}\nlast_upstream_outcome: unknown`
    : `Run: ${f.RID}\nAccepted sequence: 2\nOutcome: not recorded\nEvents complete: not recorded\nSink error: none\nSummary not recorded.`;
  const calls=[],output=[],visits=[],polls=[],exactChecks=[],occurrenceChecks=[],counts=new Map(),env={};
  const cause=new TypeError(PRIVATE);cause.stack=PRIVATE;cause.cause=new Error(PRIVATE);
  let inspect;
  function touch(operation) {
    const state=inspect();visits.push({check:state.check,index:state.index,operation});
    if(state.check === failAt && state.index === failEntry)throw cause;
  }
  const leaf=(text='') => ({text,first(){return this;},locator(){return this;},filter(){return this;},
    click:async () => touch('click'),evaluate:async () => {touch('evaluate');return false;},textContent:async () => {touch('text');return text;}});
  const tool=leaf(data.output),recording=leaf(details);
  const entries={evaluateAll:async fn => {touch('ids-read');return fn(['e:2:0','e:7:0','e:9:0','e:14:0'].slice(0,last+1).map(entry=>({dataset:{entry}})));},
    nth:index => ({locator:selector => {
      if(selector === ':scope > .metadata')return leaf(states[index]);
      if(selector === 'details[data-field]')return tool;
      assert.equal(selector,'[data-field] pre');
      return {allTextContents:async () => {touch('fields-read');const count=counts.get(index)??0;counts.set(index,count+1);
        const value=index === entry && samples ? samples[Math.min(count,samples.length-1)] : fields[index];
        polls.push({index,value});return value;}};
    }})};
  const runLocator={count:async () => {touch('count');return 1;},getAttribute:async () => {touch('identity');return f.RID;},
    textContent:async () => {touch('run-text');return 'safe';},evaluate:async fn => {touch('parity');return fn({cloneNode:()=>({querySelectorAll:()=>[],outerHTML:'safe parity'})});},
    locator:selector => {
      if(selector === '.entry')return entries;
      if(selector === '.entry > h4')return {allTextContents:async () => {touch('headings');return ['Human','assistant','tool','assistant'].slice(0,last+1);}};
      if(selector === ':scope > .metadata')return leaf(`Execution: ${execution}. Final result not recorded.`);
      assert.equal(selector,':scope > details > pre');return recording;
    }};
  const reply={status:() => {touch('reply-status');return 200;},headers:() => ({'content-type':'application/json'}),
    body:async () => {touch('reply-body');return Buffer.from(JSON.stringify({api_version:1,state:'accepted',acceptance:receipt,
      run:{...run(failed ? '19' : '16'),user_text:data.task}}));},
    url:() => `http://127.0.0.1/v1/sessions/${f.SID}/runs/reconcile`,request:() => ({method:() => 'POST'})};
  const page={getByText:() => leaf(),waitForResponse:async fn => {touch('wait-response');assert.equal(fn(reply),true);return reply;},
    locator:() => leaf(`Read-only run view: ${f.RID}\nExecution: ${execution}\nResult recorded: false\nTerminal sequence: ${failed ? '19' : 'none'}\nResult sequence: none`)};
  const taskArticle={getByRole:() => leaf(),locator:selector => leaf(selector === 'h3' ? 'task: accepted' : selector === 'details pre' ? data.task
    : `Accepted receipt (not completion)\nOperation: ${f.OID}\nSession: ${f.SID}\nRun: ${f.RID}\nSequences: 2 to 3\n\nWarning: none; duplicate: false\n\nReconciliation: accepted\n\nAccepted is not completed.`)};
  const boundedExpect=value => ({toBe:expected => {touch('assert');assert.equal(value,expected);},toBeVisible:async () => touch('visible')});
  boundedExpect.poll=sample => ({toBe:async expected => {
    for(let attempt=0;attempt<4;attempt++){const value=await sample();touch('poll-result');if(Object.is(value,expected))return;}
    throw cause;
  }});
  let failure;
  try {
    await runInNewContext(`(async () => {${declarations};fixture=ownedFixture;context=ownedContext;
      process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';${replyHelper};${checkpointHelper};
      bind(() => ({check,index:entryIndex,stage,observed:{...observed}}));
      try {if(invalid){check=invalid.check;entryIndex=invalid.index;throw cause;}await checkpoint(number);}
      ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)} ${tail.join('\n')} })()`,{
      number,invalid,cause,data,command,receipt,sid:f.SID,page,taskArticle,status:leaf('connected; observation: streaming'),
      transcript:{locator:() => runLocator},fixture:undefined,expect:boundedExpect,isDeepStrictEqual:(left,right) => isDeepStrictEqual(JSON.parse(JSON.stringify(left)),JSON.parse(JSON.stringify(right))),
      decodeJson,TextDecoder,validateTaskReconciliation,
      uuid:value => typeof value === 'string' && value === f.OID,
      exact:async (locator,expected) => {touch('exact');exactChecks.push({check:inspect().check,index:inspect().index,expected});assert.equal(locator.text,expected);},
      occurrences:async (_locator,text,count) => {touch('occurrences');occurrenceChecks.push({text,count});},boundary:async () => touch('privacy'),
      bind:value => {inspect=value;},process:{env},console:{log:value => output.push(value)},
      ownedContext:{close:async () => {calls.push('context');assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,'1');if(closeFailure)throw cause;}},
      ownedFixture:{origin:'http://127.0.0.1',stop:async () => {calls.push('fixture');if(stopFailure)throw cause;}},

    },{timeout:1000});
  } catch(error) {failure=error;}
  assert.deepEqual(calls,['context','fixture']);assert.equal(Object.hasOwn(env,'PLAYWRIGHT_NO_COPY_PROMPT'),closeFailure);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,closeFailure ? '1' : undefined);
  assert.equal([failure?.message,failure?.stack,...output].join('\n').includes(PRIVATE),false);
  assert.equal(output.includes(`Lifecycle failure cleanup: context=${!closeFailure} fixture=${!stopFailure}`),true);
  return {failure,visits,polls,exactChecks,occurrenceChecks,state:inspect()};
}

for(const number of [1,2,3,4]) test(`actual checkpoint ${number} retries absent fields then installs exact ordered content`,async () => {
  const expected=number === 1 ? ['add_numbers',data.output] : number === 2 ? [data.partial] : ['Request failed',data.partial];
  const result=await checkpointCase(number,{samples:[[],expected]});
  assert.equal(result.failure,undefined);
  assert.deepEqual(result.polls.filter(sample=>sample.index === (number === 1 ? 2 : 3)).map(sample=>sample.value),[[],expected]);
  assert.equal(result.state.observed.reads,1);assert.equal(result.state.observed.verified,1);
  assert.deepEqual(result.exactChecks.filter(check=>check.check === 'entry-metadata').map(check=>check.expected),[
    'Recorded state: accepted; Provisional: false','Recorded state: completed; Provisional: false',
    'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false',
    ...(number === 1 ? [] : [`Recorded state: ${number === 2 ? 'in_progress' : 'failed'}; Provisional: true`])]);
  assert.deepEqual(result.occurrenceChecks.map(check=>check.count),[1,1,1,number === 1 ? 0 : 1]);
  assert.equal(result.visits.filter(visit=>visit.check === 'entry-fields').every(visit=>Number.isInteger(visit.index)&&visit.index>=0&&visit.index<4),true);
  assert.equal(result.visits.filter(visit=>!['entry-metadata','entry-fields'].includes(visit.check)).every(visit=>visit.index===null),true);
});

for(const number of [1,2,3,4]) for(const variant of ['missing','bytes','order','count']) test(`actual checkpoint ${number} exhausts finite polling for persistent ${variant}`,async () => {
  let wrong;
  if(variant === 'missing')wrong=[];
  if(variant === 'bytes')wrong=['wrong bytes'];
  if(variant === 'order')wrong=number <= 2 ? [data.output,'add_numbers'] : [data.partial,'Request failed'];
  if(variant === 'count')wrong=number === 1 ? ['add_numbers',data.output,data.output] : number === 2 ? [data.partial,data.partial] : ['Request failed',data.partial,data.partial];
  const entry=number === 1 || (number === 2 && variant === 'order') ? 2 : 3;
  const result=await checkpointCase(number,{samples:[wrong],entry});
  assert.equal(result.failure?.message.startsWith(`Lifecycle failure failed: checkpoint ${number} display; kind=TypeError; check=entry-fields; entry=${entry};`),true);
  assert.equal(result.polls.filter(sample=>sample.index === entry).length,4);
  assert.equal(result.state.observed.reads,0);assert.equal(result.state.observed.verified,0);
});

const checkSites=['status','run-count','run-identity','execution','headings','entry-ids-read','entry-ids','tool-open','tool-click',
  'tool-visible','tool-output','task-occurrences','argument-occurrences','output-occurrences','partial-occurrences','request-id-read',
  'request-id','recording','storage-error-absent','reconcile-action','reconcile-reply','reconcile-acceptance','reconcile-run','run-view',
  'task-state','task-body','task-receipt','privacy','parity-dom'];
for(const check of checkSites) test(`actual checkpoint attributes failure before ${check}`,async () => {
  const result=await checkpointCase(3,{failAt:check});
  const stage=['reconcile-action','reconcile-reply','reconcile-acceptance','reconcile-run','run-view','task-state','task-body','task-receipt','privacy','parity-dom'].includes(check)
    ? 'checkpoint 3 read-only reconcile' : 'checkpoint 3 display';
  assert.equal(result.failure?.message.startsWith(`Lifecycle failure failed: ${stage}; kind=TypeError; check=${check}; entry=none;`),true);
});
for(const check of ['entry-metadata','entry-fields']) for(const index of [0,1,2,3]) test(`actual checkpoint attributes ${check} entry ${index} before action`,async () => {
  const result=await checkpointCase(2,{failAt:check,failEntry:index});
  assert.equal(result.failure?.message.startsWith(`Lifecycle failure failed: checkpoint 2 display; kind=TypeError; check=${check}; entry=${index};`),true);
});

for(const closeFailure of [false,true]) for(const stopFailure of [false,true]) test(`actual checkpoint failure stays first through cleanup close=${closeFailure} stop=${stopFailure}`,async () => {
  const result=await checkpointCase(2,{failAt:'entry-fields',failEntry:3,closeFailure,stopFailure});
  assert.equal(result.failure?.message.startsWith('Lifecycle failure failed: checkpoint 2 display; kind=TypeError; check=entry-fields; entry=3;'),true);
});

const rejected={toString(){throw new Error(PRIVATE);},valueOf(){throw new Error(PRIVATE);}};
for(const check of [PRIVATE,rejected,undefined,null,1]) for(const index of [PRIVATE,rejected,undefined,-1,4,0.5,NaN,Infinity]) test(`actual closed diagnostic rejects invalid check/index types ${typeof check}/${typeof index}`,async () => {
  const result=await checkpointCase(2,{invalid:{check,index}});
  assert.equal(result.failure?.message.startsWith('Lifecycle failure failed: startup; kind=TypeError; check=other; entry=other;'),true);
});
for(const index of [PRIVATE,rejected,undefined,-1,4,0.5,NaN,Infinity]) test(`actual entry diagnostic rejects invalid bounded index ${typeof index}`,async () => {
  const result=await checkpointCase(2,{invalid:{check:'entry-fields',index}});
  assert.equal(result.failure?.message.startsWith('Lifecycle failure failed: startup; kind=TypeError; check=entry-fields; entry=other;'),true);
});
test('actual non-entry diagnostic rejects stale entry index',async () => {
  const result=await checkpointCase(2,{invalid:{check:'tool-open',index:3}});
  assert.equal(result.failure?.message.includes('check=tool-open; entry=other;'),true);
});

test('actual case retains joined producer gates, audits and public display graph without browser-internal capture',() => {
  assert.equal(text.includes('installLifecycleFailureObserver'),false);
  assert.equal(/addInitScript|newCDPSession|globalThis\.(fetch|lifecycleCapture)\s*=|Object\.freeze\s*=|\.skip\(/.test(text),false);
  assert.equal((text.match(/command:'inspect_lifecycle_failure'/g)??[]).length,2);
  assert.equal((text.match(/await checkpoint\([1-4]\)/g)??[]).length,4);
  assert.equal(text.includes("name:'Reconcile receipt (read only)',exact:true"),true);
  assert.equal(text.includes("name:'Reconnect latest',exact:true"),true);
  assert.equal(text.includes("name:'Read run status'"),false);
  assert.equal(text.includes('await fixture?.stop()'),true);
  assert.equal(text.includes("test.setTimeout(150_000)"),true);
});
