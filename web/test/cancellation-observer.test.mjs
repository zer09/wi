import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import * as sse from '../dist/sse.js';
import * as stateModule from '../dist/state.js';
import { installCancellationObserver } from '../test-support/cancellation.mjs';
import { event, json, stream, tick } from './client-fixtures.mjs';
import { sid, rid, oid, otherSid, frame } from './wire-fixtures.mjs';
const fixture=JSON.parse(readFileSync(new URL('../test-support/cancellation.json',import.meta.url),'utf8'));
const owner='ab'.repeat(32);const origin='http://127.0.0.1:1234';
const init={method:'GET',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{authorization:`Bearer ${owner}`}};
const plain=value => JSON.parse(JSON.stringify(value,(_,v) => v instanceof Map ? [...v] : v));
const disconnected={connection:'disconnected',pending:[],recoveries:[],last_mutation:null,draft:'',selected:null};
const receipt={operation_id:oid,session_id:sid,run_id:rid,first_sequence:'2',last_sequence:'3'};
const command={operation_id:oid,run_id:rid,text:fixture.task};
const cancel={api_version:1,session_id:sid,run_id:rid,disposition:'requested'};
const outcome={type:'cancelled_locally'};
const summary={turns_started:'1',turns_finished:'1',model_requests_attempted:'1',model_requests_admitted:'1',new_tool_dispatches:'0',
  tool_results_prepared:'0',reused_results:'0',last_request_id:'request-one',last_upstream_outcome:'unknown'};
const result={outcome,summary,events_complete:true,sink_error:null};
function audit(number) {
  const value={protocol:1,id:number+3,event:'cancellation_pending',session_id:sid,run_id:rid,operation_id:oid,sequence_count:'6',connections:1,requests:1,closed:false,exact:true};
  if(number >= 2)Object.assign(value,{event:'cancellation_paused',sequence_count:'7',closed:true,terminal_operation_id:otherSid,hits:1});
  if(number >= 3)Object.assign(value,{event:'cancellation_inspect',sequence_count:'9',dispatches:0,prepared_results:0,result_records:1,reused:0,retired:true,prefix_unchanged:true});
  return value;
}
function timeline() {
  const records=[event('session.created',1,sid,{title:fixture.title,workspace:null})];
  const push=(kind,data) => records.push({...event(kind,records.length+1,sid,structuredClone(data)),run_id:rid});
  push('run.accepted',{user_text:fixture.task,provider_id:'synthetic',model:'synthetic',available_skills:[],active_skills:[]});
  push('checkpoint',{});push('run.started',{});push('checkpoint',{});push('turn.started',{turn_id:'turn-one',number:'1'});
  push('turn.finished',{turn_id:'turn-one',number:'1',response_id:null,outcome:{type:'stopped',reason:outcome},upstream_outcome:'unknown'});
  push('run.finished',{outcome,summary});push('run.result',result);return records;
}
function view(head) {return {api_version:1,run_id:rid,state:head < 9 ? 'running' : 'cancelled_locally',user_text:fixture.task,accepted_sequence:'2',
  terminal_sequence:head < 9 ? null : '8',result_sequence:head < 9 ? null : '9',result_recorded:head === 9,result:head < 9 ? null : result};}
function snapshot(records,head,number) {
  let state=stateModule.createConversation(sid);for(const e of records.slice(0,head))state=stateModule.applyEvent(state,e);
  return {...disconnected,connection:'connected',selected:{session_id:sid,title:fixture.title,observation:'streaming',observation_error:null,closed_reason:null,
    applied_cursor:`${sid}:${head}`,display:plain(stateModule.selectDisplay(state)),run_view:view(head),cancel:number === 1 || number === 4 ? null : cancel,cancelling:false}};
}
function observer(fetch,timer=setTimeout) {
  const source=installCancellationObserver.toString().replace("import('/assets/api.js')",'Promise.resolve(validators)')
    .replace("import('/assets/sse.js')",'Promise.resolve(sseModule)').replace("import('/assets/state.js')",'Promise.resolve(stateReducers)');
  const page={fetch,URL,Request,Headers,TextDecoder,Map,setTimeout:timer,clearTimeout,validators:api,sseModule:sse,stateReducers:stateModule,location:{href:`${origin}/`,origin}};
  runInNewContext(`(${source})(${JSON.stringify({fixture,owner})});globalThis.publish=value => Object.freeze(value);`,page,{timeout:1000});
  page.capture=page.cancellationCapture;return page;
}
async function setup({mutate=() => {},cancelReply=cancel,cancelStatus=202,cancelPath=`/v1/sessions/${sid}/runs/${rid}/cancel`,cancelBody='{}'}={}) {
  const records=timeline();const original=structuredClone(records);for(const e of records)mutate(e);
  let head=1;let emitted=1;let wire=stream();let controller=new AbortController();let historyCalls=0;
  const page=observer(async url => {
    if(url.includes('/events'))return wire.response;
    if(url.endsWith('/runs'))return json({api_version:1,receipt,duplicate:false,warning_code:null,notices:[]},202);
    if(url.endsWith('/cancel'))return json(cancelReply,cancelStatus);
    if(url.includes('/runs/'))return json(view(head));
    historyCalls++;const count=historyCalls === 1 ? 1 : 9;
    return json({api_version:1,session_id:sid,through_sequence:String(count),next_after:`${sid}:${count}`,has_more:false,events:records.slice(0,count)});
  });
  await page.fetch(`/v1/sessions/${sid}/history?after=${sid}:0`,init);await page.capture.drain();
  await page.fetch(`/v1/sessions/${sid}/events?after=${sid}:1`,{...init,signal:controller.signal});
  await page.fetch(`/v1/sessions/${sid}/runs`,{...init,method:'POST',body:JSON.stringify(command)});
  async function publish(number,pausedHead=7) {
    if(number === 1)head=6;
    else if(number === 2)head=pausedHead;
    else head=9;
    if(number === 2)await page.fetch(cancelPath,{...init,method:'POST',body:cancelBody});
    while(emitted < head)wire.push(frame(records[emitted++]));
    for(let n=0;n<100 && page.capture.summary().sseEvents < head-1 && !page.capture.summary().failures.length;n++)await tick();
    const snap=snapshot(original,head,number);page.publish(snap);
    // The paused checkpoint retains the earlier real read; it never issues a GET.
    if(number !== 2)await page.fetch(`/v1/sessions/${sid}/runs/${rid}`,init);
    for(let n=0;n<30;n++)await tick();page.publish(snap);return snap;
  }
  async function reload() {
    controller.abort();await tick();await wire.response.body.cancel();wire=stream();controller=new AbortController();
    await page.fetch(`/v1/sessions/${sid}/history?after=${sid}:0`,init);for(let n=0;n<30;n++)await tick();
    await page.fetch(`/v1/sessions/${sid}/events?after=${sid}:9`,{...init,signal:controller.signal});return publish(4);
  }
  async function close() {page.publish(disconnected);controller.abort();await page.capture.drain();await wire.response.body.cancel();}
  return {page,publish,reload,close};
}
test('cancellation observer retains pre-cancel RunView through a paused writer then validates terminal and reload',async () => {
  for(const pausedHead of [6,7]) {
    const f=await setup();try {
      for(const number of [1,2,3]) {await f.publish(number,pausedHead);assert.equal(f.page.capture.verify(number,audit(number)),true,`checkpoint=${number}; counts=${JSON.stringify(f.page.capture.summary())}`);}
      await f.reload();assert.equal(f.page.capture.verify(4,audit(4)),true);
      const proof=plain(f.page.capture.summary());assert.deepEqual(proof,{taskPosts:1,receipts:1,cancelPosts:1,cancels:1,history:2,streams:2,sseEvents:8,runReads:3,verified:4,failures:[]});
      for(const v of [owner,sid,rid,oid,fixture.task])assert.equal(JSON.stringify(proof).includes(v),false);
    } finally {await f.close();}
    assert.equal(f.page.capture.cleared(),true);assert.equal(f.page.capture.identity(),null);
  }
});
test('cancellation observer rejects skipped checkpoints corrupted snapshots identities audit counts and terminal rewrites',async () => {
  const f=await setup();try {
    await f.publish(1);assert.equal(f.page.capture.verify(3,audit(3)),false);assert.equal(f.page.capture.verify(1,audit(1)),true);
    const snap=await f.publish(2);assert.equal(f.page.capture.verify(2,audit(2)),true);
    for(const change of [s => {s.selected.observation='disconnected';},s => {s.selected.observation_error={};},s => {s.selected.applied_cursor=`${sid}:8`;},
      s => {s.selected.display[0].run.result={};},s => {s.selected.display[0].result_recorded=true;},s => {s.selected.display[0].execution='cancelled_locally';},
      s => {s.selected.run_view.state='cancelled_locally';},s => {s.selected.cancel.disposition='not_tracked';}]) {
      const bad=structuredClone(snap);change(bad);f.page.publish(bad);assert.equal(f.page.capture.verify(2,audit(2)),false);
    }
    f.page.publish(snap);
    for(const [key,v] of [['session_id',otherSid],['operation_id',otherSid],['terminal_operation_id',oid],['hits',2],['requests',2],['closed',false],['private',true]])
      assert.equal(f.page.capture.verify(2,{...audit(2),[key]:v}),false);
    const final=await f.publish(3);assert.equal(f.page.capture.verify(3,audit(3)),true);
    for(const state of ['completed','failed','interrupted']) {const bad=structuredClone(final);bad.selected.run_view.state=state;f.page.publish(bad);assert.equal(f.page.capture.verify(3,audit(3)),false);}
    f.page.publish(final);
    for(const [key,v] of [['retired',false],['result_records',0],['prepared_results',1],['prefix_unchanged',false],['reused',1]])
      assert.equal(f.page.capture.verify(3,{...audit(3),[key]:v}),false);
  }finally{await f.close();}
});
test('cancellation observer rejects wrong cancel path body status identity and duplicate command',async () => {
  for(const options of [{cancelPath:`/v1/sessions/${otherSid}/runs/${rid}/cancel`},{cancelPath:`/v1/sessions/${sid}/runs/${otherSid}/cancel`},
    {cancelBody:'{ }'},{cancelBody:'{"extra":true}'},{cancelStatus:200},{cancelReply:{...cancel,run_id:otherSid}},
    {cancelReply:{...cancel,disposition:'not_tracked'}},{cancelReply:{...cancel,private:'secret'}}]) {
    const f=await setup(options);try {await f.publish(1);assert.equal(f.page.capture.verify(1,audit(1)),true);await f.publish(2);assert.equal(f.page.capture.verify(2,audit(2)),false);}finally{await f.close();}
  }
  const f=await setup();try {
    await f.publish(1);assert.equal(f.page.capture.verify(1,audit(1)),true);await f.publish(2);assert.equal(f.page.capture.verify(2,audit(2)),true);
    await f.page.fetch(`/v1/sessions/${sid}/runs/${rid}/cancel`,{...init,method:'POST',body:'{}'});
    assert.equal(f.page.capture.verify(2,audit(2)),false);
  }finally{await f.close();}
});
test('cancellation observer rejects changed canonical output summary order and private bytes',async () => {
  for(const mutate of [e => {if(e.kind === 'run.accepted')e.data.user_text='changed';},e => {if(e.kind === 'turn.finished')e.data.upstream_outcome='terminal_received';},
    e => {if(e.kind === 'run.finished')e.data.summary.model_requests_admitted='0';},e => {if(e.kind === 'run.result')e.data.outcome={type:'completed'};},
    e => {if(e.kind === 'run.result')e.data.summary.tool_results_prepared='1';},e => {if(e.kind === 'run.result')e.sequence='8';},
    e => {if(e.kind === 'run.result')e.data.private='principal_digest';}]) {
    const f=await setup({mutate});try {for(const n of [1,2,3]){await f.publish(n);if(!f.page.capture.verify(n,audit(n)))break;}assert.notEqual(f.page.capture.summary().verified,3);}finally{await f.close();}
  }
});
test('cancellation observer rejects a public run read during terminal pause and releases failed readers',async () => {
  const f=await setup();try {
    await f.publish(1);assert.equal(f.page.capture.verify(1,audit(1)),true);await f.publish(2);
    await f.page.fetch(`/v1/sessions/${sid}/runs/${rid}`,init);assert.equal(f.page.capture.verify(2,audit(2)),false);
  }finally{await f.close();}
  for(const response of [json({private:'principal_digest'}),json('x'.repeat(64*1024+1)),json({},500),new Response('{')]) {
    const page=observer(async () => response);await page.fetch(`/v1/sessions/${sid}/history?after=${sid}:0`,init);await page.capture.drain();
    assert.ok(page.capture.summary().failures.length);page.publish({...disconnected,connection:'connected',selected:{}});page.publish(disconnected);await page.capture.drain();assert.equal(page.capture.cleared(),true);
  }
});
