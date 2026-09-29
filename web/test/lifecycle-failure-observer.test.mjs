import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import * as sse from '../dist/sse.js';
import * as stateModule from '../dist/state.js';
import { installLifecycleFailureObserver } from '../test-support/lifecycle-failure.mjs';
import { event, json, stream, tick } from './client-fixtures.mjs';
import { sid, rid, oid, otherSid, frame, summary } from './wire-fixtures.mjs';
const fixture=JSON.parse(readFileSync(new URL('../test-support/lifecycle-failure.json',import.meta.url),'utf8'));
const owner='ab'.repeat(32);const origin='http://127.0.0.1:1234';
const init={method:'GET',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{authorization:`Bearer ${owner}`}};
const plain=value => JSON.parse(JSON.stringify(value,(_,v) => v instanceof Map ? [...v] : v));
const disconnected={connection:'disconnected',pending:[],recoveries:[],last_mutation:null,draft:'',selected:null};
const receipt={operation_id:oid,session_id:sid,run_id:rid,first_sequence:'2',last_sequence:'3'};
const command={operation_id:oid,run_id:rid,text:fixture.task};
const audit={session_id:sid,run_id:rid,operation_id:oid,final_operation_id:otherSid,hits:1,exact:true,sequence_count:'19',connections:1,requests:2,
  dispatches:1,prepared_results:1,result_rows:1,reused:0,retired:true,prior_unchanged:true};
function timeline() {
  const records=[event('session.created',1)];
  const push=(kind,data) => records.push({...event(kind,records.length+1,sid,data),run_id:rid});
  push('run.accepted',{user_text:fixture.task,provider_id:'synthetic',model:'synthetic',available_skills:[],active_skills:[]});
  push('checkpoint',{});push('run.started',{});push('checkpoint',{});
  push('turn.started',{turn_id:'turn-one',number:'1'});push('response.started',{response_id:fixture.first_response});
  push('response.finished',{response_id:fixture.first_response,model:null,outcome:{status:'completed'},output_provenance:'native_terminal',text:'',usage:null,
    items:[{item_id:'call-item',kind:'function_call',function_call:{call_id:fixture.call_id,name:'add_numbers',arguments:fixture.arguments,complete:true,origin:'direct',namespace:null},content:[],unsupported_content:false}]});
  const tool={call_id:fixture.call_id,tool_name:'add_numbers',request_id:'request-one'};
  push('tool.started',tool);push('tool.result',{call_id:fixture.call_id,request_id:'request-one',output:fixture.output,is_error:false});
  push('tool.finished',{...tool,is_error:false});
  push('turn.finished',{turn_id:'turn-one',number:'1',response_id:fixture.first_response,outcome:{type:'tools_prepared'},upstream_outcome:'terminal_received'});
  push('turn.started',{turn_id:'turn-two',number:'2'});push('response.started',{response_id:fixture.second_response});
  push('response.item.started',{response_id:fixture.second_response,output_index:'0',item:{item_id:fixture.item_id,kind:'message',content:[],function_call:null,unsupported_content:false}});
  push('response.delta',{response_id:fixture.second_response,item_id:fixture.item_id,output_index:'0',content_index:'0',summary_index:null,kind:'text',delta:fixture.partial});
  push('response.failed',{code:'unexpected_end',upstream_outcome:'unknown'});
  const outcome={type:'failed',code:'provider_request_failed'};
  push('turn.finished',{turn_id:'turn-two',number:'2',response_id:fixture.second_response,outcome:{type:'stopped',reason:outcome},upstream_outcome:'unknown'});
  push('run.finished',{outcome,summary:{...summary,turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',
    new_tool_dispatches:'1',tool_results_prepared:'1',reused_results:'0',last_request_id:'request-two',last_upstream_outcome:'unknown'}});
  return records;
}
function view(head) {return {api_version:1,run_id:rid,state:head < 19 ? 'running' : 'failed',user_text:fixture.task,accepted_sequence:'2',
  terminal_sequence:head < 19 ? null : '19',result_sequence:null,result_recorded:false,result:null};}
function snapshot(records,head) {
  let state=stateModule.createConversation(sid);for(const e of records.slice(0,head))state=stateModule.applyEvent(state,e);
  return {...disconnected,connection:'connected',selected:{session_id:sid,observation:'streaming',observation_error:null,closed_reason:null,
    applied_cursor:`${sid}:${head}`,display:plain(stateModule.selectDisplay(state)),run_view:view(head)}};
}
function observer(fetch,timer=setTimeout) {
  const source=installLifecycleFailureObserver.toString().replace("import('/assets/api.js')",'Promise.resolve(validators)')
    .replace("import('/assets/sse.js')",'Promise.resolve(sseModule)').replace("import('/assets/state.js')",'Promise.resolve(stateReducers)');
  const page={fetch,URL,Request,Headers,TextDecoder,Map,setTimeout:timer,clearTimeout,validators:api,sseModule:sse,stateReducers:stateModule,location:{href:`${origin}/`,origin}};
  runInNewContext(`(${source})(${JSON.stringify({fixture,owner})});globalThis.publish=value => Object.freeze(value);`,page,{timeout:1000});
  page.capture=page.lifecycleCapture;return page;
}
async function setup(mutate=() => {}) {
  const records=timeline();const original=structuredClone(records);for(const e of records)mutate(e);
  let head=1;let emitted=1;let wire=stream();let controller=new AbortController();let historyCalls=0;
  const page=observer(async url => {
    if(url.includes('/events'))return wire.response;
    if(url.endsWith('/runs'))return json({api_version:1,receipt,duplicate:false,warning_code:null,notices:[]},202);
    if(url.includes('/runs/'))return json(view(head));
    historyCalls++;const count=historyCalls === 1 ? 1 : 19;
    return json({api_version:1,session_id:sid,through_sequence:String(count),next_after:`${sid}:${count}`,has_more:false,events:records.slice(0,count)});
  });
  await page.fetch(`/v1/sessions/${sid}/history?after=${sid}:0`,init);await page.capture.drain();
  await page.fetch(`/v1/sessions/${sid}/events?after=${sid}:1`,{...init,signal:controller.signal});
  await page.fetch(`/v1/sessions/${sid}/runs`,{...init,method:'POST',body:JSON.stringify(command)});
  async function publish(number) {
    head=19;
    if(number === 1)head=13;
    else if(number === 2)head=16;
    while(emitted < head)wire.push(frame(records[emitted++]));
    for(let n=0;n<150 && page.capture.summary().sseEvents < head-1 && !page.capture.summary().failures.length;n++)await tick();
    const snap=snapshot(original,head);page.publish(snap);
    await page.fetch(`/v1/sessions/${sid}/runs/${rid}`,init);
    for(let n=0;n<30;n++)await tick();page.publish(snap);return snap;
  }
  async function reload() {
    controller.abort();await tick();await wire.response.body.cancel();wire=stream();controller=new AbortController();
    await page.fetch(`/v1/sessions/${sid}/history?after=${sid}:0`,init);
    for(let n=0;n<30;n++)await tick();
    await page.fetch(`/v1/sessions/${sid}/events?after=${sid}:19`,{...init,signal:controller.signal});
    return publish(4);
  }
  async function close() {page.publish(disconnected);controller.abort();await page.capture.drain();await wire.response.body.cancel();}
  return {page,publish,reload,close};
}
test('lifecycle observer preserves original responses validates four checkpoints and erases private state',async () => {
  const f=await setup();
  for(const number of [1,2,3]){await f.publish(number);assert.equal(f.page.capture.verify(number,audit),true,`checkpoint=${number}; counts=${JSON.stringify(f.page.capture.summary())}`);}
  await f.reload();assert.equal(f.page.capture.verify(4,audit),true);
  const proof=plain(f.page.capture.summary());assert.deepEqual(proof,{taskPosts:1,receipts:1,history:2,streams:2,sseEvents:18,runReads:4,verified:4,failures:[]});
  for(const v of [owner,sid,rid,oid,fixture.task,fixture.partial,fixture.output])assert.equal(JSON.stringify(proof).includes(v),false);
  await f.close();assert.equal(f.page.capture.cleared(),true);assert.equal(f.page.capture.identity(),null);
});
test('lifecycle observer rejects corrupted snapshots fault counts public result and cursor movement',async () => {
  const f=await setup();const snap=await f.publish(3);assert.equal(f.page.capture.verify(3,audit),true,`counts=${JSON.stringify(f.page.capture.summary())}`);
  for(const change of [s => {s.selected.observation='disconnected';},s => {s.selected.observation_error={};},s => {s.selected.applied_cursor=`${sid}:20`;},
    s => {s.selected.display[0].run.result={};},s => {s.selected.display[0].result_recorded=true;},s => {s.selected.display[0].execution='interrupted';},
    s => {s.selected.display[0].entries[2].response.authoritative={};},s => {s.selected.display[0].entries[2].sections[0].text='corrupt';},
    s => {s.selected.display[0].run.finished.data.summary.new_tool_dispatches='2';},s => {s.selected.run_view.result_recorded=true;}]) {
    const bad=structuredClone(snap);change(bad);f.page.publish(bad);assert.equal(f.page.capture.verify(3,audit),false);
  }
  f.page.publish(snap);
  for(const [key,v] of [['session_id',otherSid],['operation_id',otherSid],['final_operation_id',oid],['retired',false],['hits',2],['requests',3],['prior_unchanged',false],['reused',1]])
    assert.equal(f.page.capture.verify(3,{...audit,[key]:v}),false);
  await f.close();
});
test('lifecycle observer rejects corrupt stream bytes identities order counters failure and tool data',async () => {
  for(const change of [e => {if(e.kind === 'response.delta')e.data.delta='changed';},e => {if(e.kind === 'response.failed')e.data.upstream_outcome='terminal_received';},
    e => {if(e.kind === 'response.failed')e.data.code='transport';},e => {if(e.kind === 'tool.result')e.data.output='changed';},
    e => {if(e.kind === 'tool.finished')e.data.is_error=true;},e => {if(e.kind === 'turn.finished' && e.data.number === '2')e.data.turn_id='turn-one';},
    e => {if(e.kind === 'run.finished')e.data.summary.model_requests_admitted='3';},e => {if(e.kind === 'response.delta')e.sequence='18';}]) {
    const f=await setup(change);await f.publish(3);assert.equal(f.page.capture.verify(3,audit),false);await f.close();
  }
});
test('lifecycle observer bounds and sanitizes failed cloned reads',async () => {
  for(const response of [json({private:'principal_digest'}),json('x'.repeat(256*1024+1)),json({},500),new Response('{')]) {
    const page=observer(async () => response);await page.fetch(`/v1/sessions/${sid}/history?after=${sid}:0`,init);await page.capture.drain();
    assert.ok(page.capture.summary().failures.length);page.publish({...disconnected,connection:'connected',selected:{}});page.publish(disconnected);await page.capture.drain();
  }
});
