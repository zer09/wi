import data from './skill-history-replay.json' with { type:'json' };
import { isDeepStrictEqual } from 'node:util';
import { startScenario } from './cancellation-protocol.mjs';
import { parseControl } from './fixture.mjs';
import { validateConversationPage, parseDisplayCursor } from '../dist/display-api.js';
import { validateTaskCommand, validateUuid } from '../dist/api.js';

export const replayData=Object.freeze(data);
export const replayTemplate='---\nname: presentation\ndescription: synthetic metadata\n---\n'+data.body;
export const replayOutput=JSON.stringify({body:data.body,frontmatter:{description:'synthetic metadata',name:'presentation'},id:'project:presentation'});
const reject=()=>{throw new Error('Skill history replay rejected');};
const equal=(a,b)=>{if(!isDeepStrictEqual(a,b))reject();};
export function replayScenario(raw){
  if(!Object.hasOwn(raw??{},'skill_replay'))return startScenario(raw);
  const {skill_replay,...base}=raw;startScenario(base);
  if(typeof skill_replay!=='boolean'||(skill_replay&&(base.transport!=='websocket'||base.recovered!==false||base.mime!==true
    ||['presentation','mutations','unbound_history','fixed_head','tool_fidelity','lifecycle_failure','cancellation'].some(k=>base[k]===true))))reject();
  return Object.freeze({...raw});
}
export function replayRead(url,sid){
  if(url.pathname==='/v1/settings')return url.search==='';
  if(url.pathname==='/v1/sessions')return url.search==='?limit=32';
  if(!sid)return false;
  const base=`/v1/sessions/${sid}`,params=[...url.searchParams];
  if(url.pathname===base)return url.search==='';
  if(url.pathname===`${base}/conversation`&&url.search==='')return true;
  let kind;
  if(url.pathname===`${base}/conversation`&&params.length===1&&params[0][0]==='before')kind='block';
  else if(url.pathname===`${base}/conversation/events`&&params.length===1&&params[0][0]==='after')kind='live';
  else return false;
  try{parseDisplayCursor(params[0][1],kind,sid);return true;}catch{return false;}
}
export function replayControl(input){
  if(!input||Object.keys(input).sort().join(',')!=='canonical_original,event,historical_call,historical_result,history_exact,id,loader_dispatches,prefix_unchanged,protocol,state')reject();
  if(input.protocol!==1||input.event!=='skill_replay_inspect'||!Number.isSafeInteger(input.id)||input.id<1||input.id>0xffffffff
    ||input.loader_dispatches!==1||input.canonical_original!==true||input.prefix_unchanged!==true)reject();
  const s=parseControl(input.state);
  if(s.id!==input.id||s.event!=='inspect'||![1,2].includes(s.completed)||input.history_exact!==(s.completed===2))reject();
  if(s.completed===1){equal(input.historical_call,null);equal(input.historical_result,null);}
  else{
    equal(input.historical_call,{type:'function_call',id:`item-${data.call_id}`,status:'completed',call_id:data.call_id,name:'load_skill',arguments:data.arguments});
    equal(input.historical_result,{type:'function_call_output',call_id:data.call_id,output:replayOutput});
  }
  return input;
}
export function replayEvidence(input,commands,receipts){
  const v=replayControl(input),s=v.state,tasks=commands.length;
  if(tasks<1||tasks>2||receipts.length!==tasks)reject();
  equal([s.gate,s.completed,s.requests,s.connections,s.auth_loads,s.auth_prepares,s.fresh_parents,s.continuations,s.prepared_exact,
    s.tool_results,s.terminals,s.results],[null,tasks,tasks*2,tasks,tasks,tasks,tasks,tasks,tasks*2,tasks,tasks,tasks]);
  if(!s.fresh_empty||s.restored_history!==(tasks===2)||s.provider_failed||s.read_failure!==null
    ||s.provider_stage!==(tasks===1?'request':'finished')||s.sequence_count!==s.result_sequences.at(-1))reject();
  equal(s.receipts,receipts);equal(s.accepted,receipts.map(r=>({run_id:r.run_id,accepted_sequence:r.first_sequence})));
  if(new Set(commands.map(c=>c.run_id)).size!==tasks||new Set(commands.map(c=>c.operation_id)).size!==tasks)reject();
  for(const [i,c] of commands.entries()){
    validateTaskCommand(c);const r=receipts[i];
    if(c.text!==data.tasks[i]||r.run_id!==c.run_id||r.operation_id!==c.operation_id||r.session_id!==receipts[0].session_id)reject();
    const [first,last]=s.response_finishes.slice(i*2,i*2+2);
    if(!first||!last||first.provenance!=='native_terminal'||last.provenance!=='native_terminal'
      ||!(BigInt(r.first_sequence)<BigInt(first.sequence)&&BigInt(first.sequence)<BigInt(last.sequence)
      &&BigInt(last.sequence)<BigInt(s.terminal_sequences[i])&&BigInt(s.terminal_sequences[i])<BigInt(s.result_sequences[i])))reject();
    if(i&&BigInt(r.first_sequence)<=BigInt(s.result_sequences[i-1]))reject();
  }
  return v;
}
export function replayUnchanged(input,held){
  const v=replayControl(input),strip=value=>{const {id,...rest}=value;const {id:stateId,...state}=rest.state;return {...rest,state};};
  equal(strip(v),strip(held));return true;
}
export function replayPage(input,{sid,workspace,task,command,receipt,state,query={kind:'latest'}}){
  const p=validateConversationPage(input,query,sid),b=p.block;
  validateTaskCommand(command);
  if(![0,1].includes(task)||command.text!==data.tasks[task]||receipt.run_id!==command.run_id||receipt.operation_id!==command.operation_id||receipt.session_id!==sid
    ||p.snapshot_head!==state.sequence_count||p.session.head_sequence!==state.sequence_count||p.session.workspace!==workspace||p.session.title!==data.title
    ||!b||b.run_id!==command.run_id||b.accepted_sequence!==receipt.first_sequence||b.revision!==state.result_sequences[task]
    ||b.state!=='completed'||!b.result_recorded||!b.events_complete||b.sink_error!==null||p.entries.length!==3||p.earlier_activity!==null)reject();
  equal(b.outcome,{type:'completed'});
  const summary=b.summary;
  equal(['turns_started','turns_finished','model_requests_attempted','model_requests_admitted','new_tool_dispatches','tool_results_prepared','reused_results'].map(k=>summary?.[k]),['2','2','2','2','1','1','0']);
  if(summary.last_upstream_outcome!=='terminal_received')reject();validateUuid(summary.last_request_id);
  if(task===0){if(p.previous_block!==null)reject();}
  else if(parseDisplayCursor(p.previous_block,'block',sid)?.sequence!==receipt.first_sequence)reject();
  if(query.kind==='latest'){
    const cursor=parseDisplayCursor(p.live_after,'live',sid);
    if(!cursor||cursor.sequence!==state.sequence_count||cursor.rank!=='3'||cursor.run_id!==''||cursor.entry_id!=='')reject();
  }else if(p.live_after!==null)reject();
  const tool=task===0?'load_skill':'add_numbers',args=task===0?data.arguments:'{"a":42,\r\n "b":8}';
  const specs=[['human',[['text',data.tasks[task]]]],['assistant',[['function_name',tool],['function_arguments',args]]],
    ['tool',[['tool_name',tool],['tool_result',task===0?replayOutput:'{"sum":50}']]],['assistant',[['text',data.answers[task]]]]];
  let prior=0n;
  for(const [i,e] of [b.human,...p.entries].entries()){
    const sequence=BigInt(e.position.sequence);
    if(sequence<=prior||sequence>BigInt(b.revision)||e.entry_id!==`e:${sequence}:0`||e.position.slot!=='0'||e.run_id!==command.run_id
      ||e.kind!==specs[i][0]||e.recorded_state!==(i===0?'accepted':'completed')||e.provisional||e.reference!==null||!e.content_complete||e.earlier_content!==null)reject();
    equal(e.fields.map(f=>[f.kind,f.text]),specs[i][1]);
    equal([e.result_recorded,e.finish_recorded,e.is_error],i===2?[true,true,false]:[null,null,null]);
    if(i===0&&(e.position.sequence!==receipt.first_sequence||e.fields[0].field_id!=='text'))reject();
    for(const f of e.fields){const bytes=String(Buffer.byteLength(f.text));
      if(f.from_byte!=='0'||f.to_byte!==bytes||f.total_bytes!==bytes||f.has_earlier||f.has_later||BigInt(f.generation)<sequence||BigInt(f.generation)>BigInt(b.revision))reject();}
    prior=sequence;
  }
  return p;
}
