import { startScenario as baseScenario, cancellationFlat } from './cancellation-protocol.mjs';
const fail=() => {throw new Error('read reconnect protocol rejected');};
const uuid=v => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
const count=v => Number.isSafeInteger(v) && v >= 0;
const id=v => count(v) && v > 0 && v <= 0xffffffff;
function keys(v,fields) {if(!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...fields].sort().join(','))fail();}
export function startScenario(raw) {
  const v=cancellationFlat(raw);
  if(!Object.hasOwn(v,'read_reconnect'))return baseScenario(v);
  const {read_reconnect,...base}=v;baseScenario(base);
  if(typeof read_reconnect !== 'boolean' || (read_reconnect && (base.transport !== 'websocket' || base.recovered !== false || base.mime !== true
    || ['cancellation','lifecycle_failure','tool_fidelity','mutations','presentation','unbound_history','fixed_head'].some(k => base[k] === true))))fail();
  return Object.freeze({...v});
}
export const steps=['pending',...Array(3).fill(['arm','commit','hit','release','reconnected']).flat(),'finish'];
export function reconnectEvidence(raw) {
  const v=cancellationFlat(raw);
  keys(v,['protocol','id','event','step','window','subscription','session_id','run_id','operation_id','head','rename_count','rename_operation','rename_event','frame_bytes','yielded_bytes','connections','requests','exact']);
  if(v.protocol !== 1 || !id(v.id) || v.event !== 'read_reconnect' || !steps.includes(v.step)
    || ![v.session_id,v.run_id,v.operation_id].every(uuid) || new Set([v.session_id,v.run_id,v.operation_id]).size !== 3
    || !count(v.window) || v.window > 3 || !id(v.subscription) || v.subscription > 4
    || !count(v.rename_count) || v.rename_count > 3 || v.head !== 6+v.rename_count
    || v.connections !== 1 || v.requests !== 1 || v.exact !== true)fail();
  if(v.rename_count === 0) {if(v.rename_operation !== null || v.rename_event !== null)fail();}
  else if(!uuid(v.rename_operation) || !uuid(v.rename_event) || new Set([v.session_id,v.run_id,v.operation_id,v.rename_operation,v.rename_event]).size !== 5)fail();
  const hit=['hit','release'].includes(v.step);
  if(hit) {
    if(!id(v.frame_bytes) || v.frame_bytes > 8192 || !id(v.yielded_bytes)
      || v.yielded_bytes !== (v.window === 1 ? Math.floor((v.frame_bytes-2)/2) : v.frame_bytes))fail();
  } else if(v.frame_bytes !== 0 || v.yielded_bytes !== 0)fail();
  return v;
}
export function reconnectProtocol(enabled) {
  let last=0;let waiting;let selected;let identity;let next=0;let renames=0;let stopped=false;let rename;
  return {
    request(raw) {
      const v=cancellationFlat(raw);
      if(!enabled){if(v.command === 'read_reconnect')fail();return;}
      if(stopped || waiting || !id(v.id) || v.id <= last)fail();
      let event;
      if(last === 0) {
        const {id:n,owner,...scenario}=v;
        if(n !== 1 || typeof owner !== 'string' || !/^[0-9a-f]{64}$/.test(owner) || scenario.transport !== 'web_socket')fail();
        startScenario({...scenario,transport:'websocket'});if(scenario.read_reconnect !== true)fail();event='ready';
      } else if(v.command === 'select') {
        keys(v,['command','id','session_id']);if(selected || !uuid(v.session_id))fail();selected=v.session_id;event='selected';
      } else if(v.command === 'read_reconnect') {
        keys(v,['command','id','step','window','subscription','session_id','run_id','operation_id']);
        const window=next === 0 ? 0 : Math.min(3,Math.floor((next-1)/5)+1);
        const ordinal=v.step === 'pending' ? 1 : window+Number(['reconnected','finish'].includes(v.step));
        if(v.step !== steps[next] || v.window !== window || v.subscription !== ordinal || v.session_id !== selected
          || ![v.session_id,v.run_id,v.operation_id].every(uuid) || new Set([v.session_id,v.run_id,v.operation_id]).size !== 3)fail();
        const task=`${v.run_id}:${v.operation_id}`;if(identity && identity !== task)fail();identity=task;
        if(v.step === 'commit')renames++;
        event='read_reconnect';next++;
      } else if(v.command === 'stop') {keys(v,['command','id']);event='stopped';}
      else fail();
      waiting={...v,event};last=v.id;
    },
    reply(raw) {
      const v=cancellationFlat(raw);
      if(!enabled){if(v.event === 'read_reconnect')fail();return;}
      if(!waiting || v.protocol !== 1 || v.id !== waiting.id || v.event !== waiting.event)fail();
      if(v.event === 'read_reconnect') {
        reconnectEvidence(v);
        for(const k of ['step','window','subscription','session_id','run_id','operation_id'])if(v[k] !== waiting[k])fail();
        if(v.rename_count !== renames)fail();
        if(v.step === 'commit') {if(rename && (rename.operation === v.rename_operation || rename.event === v.rename_event))fail();rename={operation:v.rename_operation,event:v.rename_event};}
        else if(rename && (rename.operation !== v.rename_operation || rename.event !== v.rename_event))fail();
      } else if(v.event === 'ready') {
        keys(v,['protocol','id','event','origin']);if(typeof v.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(v.origin) || new URL(v.origin).origin !== v.origin)fail();
      } else if(v.event === 'stopped') {keys(v,['protocol','id','event','cleaned']);if(v.cleaned !== true)fail();stopped=true;}
      else keys(v,['protocol','id','event']);
      waiting=undefined;
    },
  };
}
