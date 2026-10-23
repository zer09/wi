import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { apiPath, validateTaskCommand } from '../dist/api.js';
import { parseControl, stdoutParser } from '../test-support/fixture.mjs';
import { ownedSkill, CHANGED } from '../test-support/skill-source-fidelity.mjs';
import { replayData as data, replayTemplate, replayOutput, replayScenario, replayControl, replayEvidence, replayPage, replayUnchanged, replayRead } from '../test-support/skill-history-replay.mjs';
import * as f from '../test-support/display-fixtures.mjs';
const commands=[{operation_id:f.OID,run_id:f.RID,text:data.tasks[0]},{operation_id:f.OTHER,run_id:f.OTHER,text:data.tasks[1]}];
const receipts=commands.map((c,i)=>({operation_id:c.operation_id,run_id:c.run_id,session_id:f.SID,first_sequence:String(i*30+2),last_sequence:String(i*30+3)}));
function evidence(tasks=2){
  const state={protocol:1,event:'inspect',id:1,gate:null,requests:tasks*2,connections:tasks,auth_loads:tasks,auth_prepares:tasks,prepared_exact:tasks*2,
    fresh_parents:tasks,continuations:tasks,tool_results:tasks,completed:tasks,terminals:tasks,results:tasks,fresh_empty:true,restored_history:tasks===2,
    sequence_count:String(tasks*30),accepted:receipts.slice(0,tasks).map(r=>({run_id:r.run_id,accepted_sequence:r.first_sequence})),receipts:receipts.slice(0,tasks),
    response_finishes:Array.from({length:tasks*2},(_,i)=>({sequence:String(Math.floor(i/2)*30+10+i%2*10),provenance:'native_terminal'})),
    terminal_sequences:Array.from({length:tasks},(_,i)=>String(i*30+29)),result_sequences:Array.from({length:tasks},(_,i)=>String(i*30+30)),
    provider_stage:tasks===1?'request':'finished',provider_failed:false,read_failure:null};
  return {protocol:1,event:'skill_replay_inspect',id:1,state,loader_dispatches:1,canonical_original:true,prefix_unchanged:true,history_exact:tasks===2,
    historical_call:tasks===1?null:{type:'function_call',id:`item-${data.call_id}`,status:'completed',call_id:data.call_id,name:'load_skill',arguments:data.arguments},
    historical_result:tasks===1?null:{type:'function_call_output',call_id:data.call_id,output:replayOutput}};
}
for(const tasks of [1,2])test(`actual replay control and native counts ${tasks}`,()=>{
  const e=evidence(tasks);assert.equal(replayEvidence(e,commands.slice(0,tasks),receipts.slice(0,tasks)),e);assert.equal(parseControl(e),e);
  const values=[],parser=stdoutParser(v=>values.push(v));parser.push(Buffer.from(JSON.stringify(e)+'\n'));parser.end();assert.deepEqual(values,[e]);
});
const changes={
  'replacement historical output':e=>{e.historical_result.output=CHANGED;},'missing historical result':e=>{e.historical_result=null;},
  'wrong result call':e=>{e.historical_result.call_id='wrong';},'wrong call correlation':e=>{e.historical_call.call_id='wrong';},
  'manual result extra':e=>{e.historical_result.manual=true;},'wrong call arguments':e=>{e.historical_call.arguments='{}';},
  'loader rerun':e=>{e.loader_dispatches=2;},'changed canonical':e=>{e.canonical_original=false;},'changed prefix':e=>{e.prefix_unchanged=false;},
  'absent actual B request':e=>{e.history_exact=false;},'state control identity':e=>{e.state.id=2;},'unknown field':e=>{e.extra=true;},
  'nested protocol omitted':e=>{delete e.state.protocol;},
  'provider request omitted':e=>{e.state.requests=3;},'tool rerun':e=>{e.state.tool_results=3;},'uncompleted B':e=>{e.state.results=1;},
  'receipt mismatch':e=>{e.state.receipts[1].operation_id=f.OID;},'history missing':e=>{e.state.restored_history=false;},
};
for(const [name,change] of Object.entries(changes))test(`replay evidence rejects ${name}`,()=>{const e=structuredClone(evidence());change(e);assert.throws(()=>replayEvidence(e,commands,receipts));});
test('unchanged reads ignore only control IDs',()=>{const a=evidence(),b=structuredClone(a);b.id=5;b.state.id=5;assert.equal(replayUnchanged(b,a),true);b.state.sequence_count='61';assert.throws(()=>replayUnchanged(b,a));});
const scenario={transport:'websocket',recovered:false,mime:true,skill_replay:true};
test('actual request collector admits the current limit-32 catalog route',()=>{
  const source=ts.createSourceFile('case.mjs',readFileSync(new URL('../e2e/skill-history-replay.spec.mjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const callbacks=[];
  function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='context.on'&&node.arguments[0]?.getText(source)==="'request'")callbacks.push(node.arguments[1]);ts.forEachChild(node,visit);}visit(source);
  assert.equal(callbacks.length,1);
  const traffic={faults:0},origin='http://127.0.0.1:12345',owner='synthetic-owner';
  const request={url:()=>origin+apiPath({kind:'sessions'}),method:()=> 'GET',headers:()=>({authorization:`Bearer ${owner}`})};
  runInNewContext(`(${callbacks[0].getText(source)})(request)`,{URL,request,traffic,fixture:{origin,owner},leaked:()=>false,replayRead,sid:f.SID});
  assert.equal(traffic.faults,0);
});
for(const [path,allowed] of [
  [apiPath({kind:'sessions'}),true],['/v1/sessions',false],['/v1/sessions?limit=33',false],['/v1/sessions?limit=32&extra=1',false],
  ['/v1/settings',true],['/v1/settings?x=1',false],[`/v1/sessions/${f.SID}`,true],
  [`/v1/sessions/${f.SID}/conversation`,true],[`/v1/sessions/${f.SID}/history`,false],
  [`/v1/sessions/${f.SID}/conversation?before=${f.cursor('b','32')}`,true],
  [`/v1/sessions/${f.SID}/conversation?before=invalid`,false],
  [`/v1/sessions/${f.SID}/conversation/events?after=${f.cursor('l','60','3','','')}`,true],
])test(`read allowlist ${path}`,()=>assert.equal(replayRead(new URL(path,'http://127.0.0.1:12345'),f.SID),allowed));
test('bounded native WS replay scenario accepted',()=>assert.deepEqual(replayScenario(scenario),scenario));
for(const [key,value] of Object.entries({transport:'sse',recovered:true,mime:false,skill_replay:1,presentation:true,mutations:true,tool_fidelity:true,cancellation:true,lifecycle_failure:true,unbound_history:true,fixed_head:true,unknown:true}))test(`scenario rejects ${key}`,()=>assert.throws(()=>replayScenario({...scenario,[key]:value})));
function page(task=0){
  const base=task*30,r=receipts[task],command=commands[task],tool=task===0?'load_skill':'add_numbers';
  const pairs=[['human',[['text',data.tasks[task]]]],['assistant',[['function_name',tool],['function_arguments',task===0?data.arguments:'{"a":42,\r\n "b":8}']]],
    ['tool',[['tool_name',tool],['tool_result',task===0?replayOutput:'{"sum":50}']]],['assistant',[['text',data.answers[task]]]]];
  const entries=pairs.map(([kind,pairs],i)=>{const seq=String(i===0?base+2:base+7+i*4);return f.entry({kind,run_id:command.run_id,entry_id:`e:${seq}:0`,position:{sequence:seq,slot:'0'},revision:seq,content_epoch:seq,
    provisional:false,recorded_state:i===0?'accepted':'completed',result_recorded:i===2?true:null,finish_recorded:i===2?true:null,is_error:i===2?false:null,
    fields:pairs.map(([kind,text],j)=>f.field({field_id:i===0?'text':String(j+1).repeat(64),order_key:i===0?'0':f.order(2,j,0),kind,text,generation:seq,total_bytes:String(Buffer.byteLength(text)),to_byte:String(Buffer.byteLength(text))}))});});
  const head=String(base+30),summary={turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',new_tool_dispatches:'1',tool_results_prepared:'1',reused_results:'0',last_request_id:f.OID,last_upstream_outcome:'terminal_received'};
  return f.page({snapshot_head:head,session:f.session(head,{title:data.title}),block:f.block({run_id:command.run_id,accepted_sequence:r.first_sequence,revision:head,human:entries[0],state:'completed',result_recorded:true,outcome:{type:'completed'},summary,events_complete:true}),
    entries:entries.slice(1),previous_block:task===0?null:f.cursor('b',r.first_sequence),live_after:f.cursor('l',head,'3','','')});
}
const options=task=>({sid:f.SID,workspace:'/synthetic/project',task,command:commands[task],receipt:receipts[task],state:evidence(task+1).state});
for(const task of [0,1])test(`exact completed display ${task}`,()=>assert.deepEqual(replayPage(page(task),options(task)),page(task)));
for(const [name,change] of Object.entries({
  'replacement output':p=>{p.entries[1].fields[1].text=CHANGED;},'duplicate answer':p=>{p.entries.push(p.entries[2]);},'wrong run':p=>{p.entries[1].run_id=f.OTHER;},
  'reordered rows':p=>{p.entries.reverse();},'wrong tool':p=>{p.entries[1].fields[0].text='add_numbers';},'result flag':p=>{p.entries[1].is_error=true;},
  'incomplete output':p=>{p.entries[1].content_complete=false;},'missing result':p=>{p.entries[1].result_recorded=false;},'loader redispatch':p=>{p.block.summary.new_tool_dispatches='2';},
  'wrong receipt':p=>{p.block.accepted_sequence='3';},'changed content':p=>{p.entries[2].fields[0].text='duplicate';},'wrong head':p=>{p.snapshot_head='31';},
}))test(`display oracle rejects ${name}`,()=>{const p=page();change(p);assert.throws(()=>replayPage(p,options(0)));});
async function owned(action){
  const root=await mkdtemp(join(tmpdir(),'wi-browser-')),workspace=join(root,'.tmpReplay','workspace'),path=join(workspace,'.agents/skills/presentation/SKILL.md');
  await mkdir(dirname(path),{recursive:true});await writeFile(path,replayTemplate);
  const live={pid:12345,ppid:process.pid,start:'123',alive:true,cwd:root,tmpdir:root,exe:'/synthetic/fixture'};
  const input={fixture:{pid:live.pid},workspace,tmpdir:tmpdir(),executable:live.exe,finished:evidence(1).state,beforeNextTask:true,probe:async()=>({...live})};
  let guard;
  try{await action({root,workspace,path,live,input,bind:async()=>{guard=await ownedSkill(input);return guard;}});}
  finally{if(guard)await guard.close();await rm(root,{recursive:true,force:true});}
}
test('owned before-B mutation preserves valid metadata and exact changed readback',()=>owned(async({path,bind})=>{const guard=await bind();assert.equal((await guard.change()).readback_exact,true);assert.equal(await readFile(path,'utf8'),CHANGED);await guard.observed();}));
for(const [name,change] of Object.entries({
  'B already completed':v=>{v.input.finished=evidence(2).state;},'A unfinished':v=>{v.input.finished.completed=0;},'active model':v=>{v.input.finished.gate=3;},
  'wrong process':v=>{v.live.start='';},'foreign parent':v=>{v.live.ppid++;},'wrong template':v=>writeFile(v.path,CHANGED),
  'symlink':async v=>{await rename(v.path,v.path+'.original');await symlink(v.path+'.original',v.path);},
  'hardlink':v=>link(v.path,v.path+'.alias'),
}))test(`before-B ownership rejects ${name} without mutation`,()=>owned(async v=>{await change(v);const before=await readFile(v.path);await assert.rejects(v.bind());assert.deepEqual(await readFile(v.path),before);}));
