import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import * as sse from '../dist/sse.js';
import { applyEvent, createConversation, selectDisplay } from '../dist/state.js';
import { installToolFidelityObserver } from '../test-support/tool-fidelity.mjs';
import { event, json, stream, tick } from './client-fixtures.mjs';
import { sid, rid, oid, otherSid, eid, frame, item, summary } from './wire-fixtures.mjs';

const fixture=JSON.parse(readFileSync(new URL('../test-support/tool-fidelity.json',import.meta.url),'utf8'));
const owner='ab'.repeat(32); const origin='http://127.0.0.1:1234';
const init={method:'GET',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{authorization:`Bearer ${owner}`}};
const plain=value => JSON.parse(JSON.stringify(value,(_,v) => v instanceof Map ? [...v] : v));
const disconnected={connection:'disconnected',pending:[],recoveries:[],last_mutation:null,draft:'',selected:null};
function timeline() {
  const records=[event('session.created',1)]; const tasks=[]; let state=createConversation(sid);state=applyEvent(state,records[0]);
  for(let task=0;task<2;task++) {
    const run=task === 0 ? rid : otherSid; const operation=task === 0 ? oid : eid; const first=records.length+1;
    const push=(kind,data) => {const e={...event(kind,records.length+1,sid,data),run_id:run};records.push(e);state=applyEvent(state,e);};
    push('run.accepted',{user_text:fixture.tasks[task],provider_id:'synthetic',model:'synthetic',available_skills:[],active_skills:[]});
    push('checkpoint',{});push('run.started',{});push('checkpoint',{});
    const turns=task === 0 ? 3 : 2;
    for(let turn=0;turn<turns;turn++) {
      const response=`response-${task}-${turn}`;const request=`request-${task}-${turn}`;const number={turn_id:`turn-${task}-${turn}`,number:String(turn+1)};
      const calls=[];
      if(turn < turns-1) {
        calls.push({call_id:fixture.shared_call,name:'add_numbers',arguments:fixture.arguments[task === 1 ? 2 : turn],origin:'direct',namespace:null,complete:true});
        if(task === 0 && turn === 0) calls.push({call_id:fixture.fixture_call,name:fixture.name,arguments:fixture.fixture_arguments,origin:'direct',namespace:null,complete:true});
      }
      const items=calls.map(call => ({item_id:`item-${call.call_id}`,kind:'function_call',function_call:call,content:[],unsupported_content:false}));
      if(!calls.length) items.push({...item,item_id:'answer',content:[{kind:'text',text:fixture.answers[task]}]});
      push('turn.started',number);push('response.started',{response_id:response});
      push('response.finished',{response_id:response,model:null,outcome:{status:'completed'},output_provenance:'native_terminal',text:calls.length ? '' : fixture.answers[task],items,usage:null});
      for(const call of calls) {
        const tool={call_id:call.call_id,tool_name:call.name,request_id:request};
        if(task === 0 && turn === 1) push('tool.reused',tool);
        else {push('tool.started',tool);push('tool.result',{call_id:call.call_id,request_id:request,
          output:call.name === 'add_numbers' ? fixture.sums[task] : fixture.fixture_output,is_error:false});push('tool.finished',{...tool,is_error:false});}
      }
      push('turn.finished',{...number,response_id:response,outcome:{type:calls.length ? 'tools_prepared' : 'model_completed'},upstream_outcome:'terminal_received'});
    }
    const counters={...summary,turns_started:String(turns),turns_finished:String(turns),model_requests_attempted:String(turns),model_requests_admitted:String(turns),
      new_tool_dispatches:task === 0 ? '2' : '1',tool_results_prepared:task === 0 ? '3' : '1',reused_results:task === 0 ? '1' : '0'};
    push('run.finished',{outcome:{type:'completed'},summary:counters});push('run.result',{outcome:{type:'completed'},summary:counters,events_complete:true,sink_error:null});
    tasks.push({records:records.slice(first-1),command:{operation_id:operation,run_id:run,text:fixture.tasks[task]},
      receipt:{operation_id:operation,session_id:sid,run_id:run,first_sequence:String(first),last_sequence:String(first+1)},
      snapshot:{...disconnected,connection:'connected',selected:{session_id:sid,observation_error:null,applied_cursor:`${sid}:${records.length}`,display:plain(selectDisplay(state))}},
      audit:{session_id:sid,run_id:run,operation_id:operation,completed:task+1,sequence_count:String(records.length),requests:turns,new_dispatches:task === 0 ? 2 : 1,
        result_rows:task === 0 ? 2 : 1,reused:task === 0 ? 1 : 0,prepared_results:task === 0 ? 3 : 1,executions:1,exact:true,prior_unchanged:true}});
  }
  return {records,tasks};
}
function observer(fetch,timer=setTimeout) {
  const source=installToolFidelityObserver.toString().replace("import('/assets/api.js')",'Promise.resolve(validators)').replace("import('/assets/sse.js')",'Promise.resolve(sseModule)');
  const page={fetch,URL,Request,Headers,TextDecoder,setTimeout:timer,clearTimeout,validators:api,sseModule:sse,location:{href:`${origin}/`,origin}};
  runInNewContext(`(${source})(${JSON.stringify({fixture,owner})});globalThis.publish=value => Object.freeze(value);`,page,{timeout:1000});
  page.capture=page.toolFidelityCapture;return page;
}
async function setup() {
  const wire=stream();const script=timeline();let task=0;
  const initial={api_version:1,session_id:sid,through_sequence:'1',next_after:`${sid}:1`,has_more:false,events:[script.records[0]]};
  const page=observer(async url => {
    if(url.includes('/events'))return wire.response;
    if(url.endsWith('/runs'))return json({api_version:1,receipt:script.tasks[task++].receipt,duplicate:false,warning_code:null,notices:[]},202);
    return json(initial);
  });
  await page.fetch(`/v1/sessions/${sid}/history`,init);await page.capture.drain();
  assert.equal(await page.fetch(`/v1/sessions/${sid}/events`,init),wire.response);
  async function advance(index,mutate=() => {}) {
    const t=script.tasks[index];
    await page.fetch(`/v1/sessions/${sid}/runs`,{...init,method:'POST',body:JSON.stringify(t.command)});
    for(const record of t.records) {const copy=structuredClone(record);mutate(copy);wire.push(frame(copy));}
    for(let n=0;n<100 && page.capture.summary().sseEvents < Number(t.audit.sequence_count)-1 && !page.capture.summary().failures.length;n++)await tick();
    page.publish(t.snapshot);
    return t;
  }
  async function close(){page.publish(disconnected);await page.capture.drain();await wire.response.body.cancel();}
  return {page,wire,script,advance,close};
}

test('observer validates actual-shaped DTOs and pure reducer state across two runs without exporting payloads',async () => {
  const f=await setup();
  for(let task=0;task<2;task++){const t=await f.advance(task);assert.equal(f.page.capture.verify(t.audit),true);}
  const proof=plain(f.page.capture.summary());assert.deepEqual(proof.failures,[]);assert.equal(proof.verified,2);
  for(const value of [sid,rid,oid,fixture.tasks[0],fixture.fixture_output,owner])assert.equal(JSON.stringify(proof).includes(value),false);
  await f.close();assert.equal(f.page.capture.cleared(),true);assert.deepEqual(plain(f.page.capture.summary()),proof);
});
test('observer rejects fabricated flags outputs reuse effects arguments and run correlation in reducer snapshots',async () => {
  const f=await setup();const t=await f.advance(0);assert.equal(f.page.capture.verify(t.audit),true);
  const changes=[s => {s.selected.display[0].run.tools[0][1].result.data.is_error=true;},
    s => {s.selected.display[0].run.tools[1][1].result.data.output=JSON.parse(fixture.fixture_output).error;},
    s => {s.selected.display[0].run.tools[0][1].reuses=[];},s => {s.selected.display[0].entries.push(s.selected.display[0].entries[1]);},
    s => {s.selected.display[0].run.run_id=otherSid;},s => {s.selected.display[0].run.tools[0][1].result.data.request_id='later';},
    s => {s.selected.display[0].entries[0].sections[0].text=JSON.stringify(JSON.parse(fixture.arguments[0]));},
    s => {s.selected.display[0].run.result.data.summary.new_tool_dispatches='3';},s => {s.selected.applied_cursor=`${sid}:1`;},
    s => {s.selected.display[0].result_recorded=false;}];
  for(const change of changes){const bad=structuredClone(t.snapshot);change(bad);f.page.publish(bad);assert.equal(f.page.capture.verify(t.audit),false);}
  f.page.publish(t.snapshot);assert.equal(f.page.capture.verify(t.audit),true);
  const second=await f.advance(1);assert.equal(f.page.capture.verify(second.audit),true);
  const missing=structuredClone(second.snapshot);missing.selected.display.shift();f.page.publish(missing);assert.equal(f.page.capture.verify(second.audit),false);
  await f.close();
});
test('observer rejects corrupt actual-stream identities flags output and invented reuse payload fields',async () => {
  for(const mutate of [e => {if(e.kind === 'tool.result')e.data.is_error=true;},e => {if(e.kind === 'tool.result')e.data.output='changed';},
    e => {if(e.kind === 'tool.reused')e.data.output=fixture.sums[0];},e => {if(e.kind === 'tool.reused')e.data.is_error=false;},
    e => {if(e.kind === 'tool.reused')e.data.request_id='request-0-0';},e => {if(e.kind === 'tool.started')e.data.tool_name='wrong';},
    e => {if(e.kind === 'response.finished' && e.data.items[0]?.function_call)e.data.items[0].function_call.arguments='{}';}]) {
    const f=await setup();const t=await f.advance(0,mutate);assert.equal(f.page.capture.verify(t.audit),false);await f.close();
  }
});
test('observer bounds clone reads sanitizes private failures and restores hooks on Disconnect',async () => {
  for(const response of [json({private:'principal_digest'}),json('x'.repeat(256*1024+1)),json({},500),new Response('{')]) {
    const page=observer(async () => response);await page.fetch(`/v1/sessions/${sid}/history`,init);await page.capture.drain();
    assert.ok(page.capture.summary().failures.length);page.publish({...disconnected,connection:'connected',selected:{}});page.publish(disconnected);await page.capture.drain();
  }
  let cancelled=0;const response=json({});response.clone=() => ({body:{getReader:() => ({read:() => new Promise(() => {}),cancel:async () => {cancelled++;}})}});
  const page=observer(async () => response,callback => setTimeout(callback,10));
  assert.equal(await page.fetch(`/v1/sessions/${sid}/history`,init),response);await page.capture.drain();
  assert.equal(cancelled,1);assert.deepEqual(plain(page.capture.summary().failures),['history:read']);
  page.publish({...disconnected,connection:'connected',selected:{}});page.publish(disconnected);assert.equal(page.capture.cleared(),true);
});
