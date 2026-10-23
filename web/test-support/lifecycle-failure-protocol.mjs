import { startScenario as baseScenario } from './tool-fidelity-protocol.mjs';
const fail = () => { throw new Error('fixture protocol rejected'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const id = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
function keys(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
}
export function lifecycleFlat(raw) {
  if (typeof raw !== 'string') return raw;
  if (raw.includes('\\')) fail();
  let value; try { value = JSON.parse(raw); } catch { fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || raw.replace(/"[^"\\]*"/g,'""').split(':').length !== Object.keys(value).length+1) fail();
  return value;
}
export function startScenario(raw) {
  const value = lifecycleFlat(raw);
  if (!Object.hasOwn(value ?? {},'lifecycle_failure')) return baseScenario(value);
  const { lifecycle_failure, ...base } = value;
  baseScenario(base);
  if (typeof lifecycle_failure !== 'boolean' || (lifecycle_failure && (base.transport !== 'websocket' || base.recovered !== false || base.mime !== true
    || ['mutations','presentation','unbound_history','fixed_head','tool_fidelity'].some(key => base[key] === true)))) fail();
  return Object.freeze({...value});
}
export function lifecycleEvidence(raw) {
  const v = lifecycleFlat(raw);
  const base = ['protocol','id','event','session_id','run_id','operation_id','final_operation_id','hits','exact'];
  const inspect = v?.event === 'lifecycle_failure_inspect';
  keys(v,[...base,...inspect ? ['sequence_count','connections','requests','dispatches','prepared_results','result_rows','reused','retired','prior_unchanged'] : []]);
  if (v.protocol !== 1 || !id(v.id) || (!inspect && v.event !== 'lifecycle_failure_paused') || v.hits !== 1 || v.exact !== true
    || ![v.session_id,v.run_id,v.operation_id,v.final_operation_id].every(uuid)
    || new Set([v.session_id,v.run_id,v.operation_id,v.final_operation_id]).size !== 4) fail();
  if (inspect && (v.sequence_count !== '19' || v.connections !== 1 || v.requests !== 2 || v.dispatches !== 1 || v.prepared_results !== 1
    || v.result_rows !== 1 || v.reused !== 0 || v.retired !== true || v.prior_unchanged !== true)) fail();
  return v;
}
export function lifecycleProtocol(enabled) {
  let last = 0; let stage = 0; let waiting; let session; let task; let finalOperation; let gate = 0; let driven = 0; let stopped = false;
  return {
    request(raw) {
      const v = lifecycleFlat(raw);
      if (!enabled) { if (v.command?.includes('lifecycle_failure')) fail(); return; }
      if (stopped || waiting !== undefined || !id(v.id) || v.id <= last) fail();
      let event;
      if (last === 0) {
        const { id:requestId, owner, ...scenario } = v;
        if (requestId !== 1 || typeof owner !== 'string' || !/^[0-9a-f]{64}$/.test(owner) || scenario.transport !== 'web_socket') fail();
        startScenario({...scenario,transport:'websocket'}); if (scenario.lifecycle_failure !== true) fail(); event = 'ready';
      } else {
        const extras = {select:['session_id'],drive:['gate'],wait_lifecycle_failure:['session_id','run_id','operation_id'],release_lifecycle_failure:['final_operation_id']};
        keys(v,['id','command',...extras[v.command] ?? []]);
        if (v.command === 'select') {
          if (stage !== 0 || !uuid(v.session_id)) fail(); session = v.session_id; stage = 1; event = 'selected';
        } else if (v.command === 'arm_lifecycle_failure') {
          if (stage !== 1) fail(); stage = 2; event = 'lifecycle_failure_armed';
        } else if (v.command === 'drive') {
          if (gate !== driven+1 || v.gate !== gate || stage !== gate+1 || gate > 2) fail(); driven = gate; stage++; event = 'driven';
        } else if (v.command === 'wait_lifecycle_failure') {
          if (stage !== 4 || v.session_id !== session || !uuid(v.run_id) || !uuid(v.operation_id) || new Set([session,v.run_id,v.operation_id]).size !== 3) fail();
          task = {run_id:v.run_id,operation_id:v.operation_id}; stage = 5; event = 'lifecycle_failure_paused';
        } else if (v.command === 'release_lifecycle_failure') {
          if (stage !== 5 || v.final_operation_id !== finalOperation) fail(); stage = 6; event = 'lifecycle_failure_released';
        } else if (v.command === 'inspect_lifecycle_failure') {
          if (stage !== 6 && stage !== 7) fail(); stage++; event = 'lifecycle_failure_inspect';
        } else if (v.command === 'stop') event = 'stopped';
        else fail();
      }
      last = v.id; waiting = {id:v.id,event};
    },
    reply(raw) {
      const v = lifecycleFlat(raw);
      if (!enabled) { if (v.event?.startsWith('lifecycle_failure_')) fail(); return; }
      if (stopped || v.protocol !== 1) fail();
      if (v.event === 'model_paused') {
        keys(v,['protocol','event','gate']);
        if (v.gate !== gate+1 || gate !== driven || v.gate > 2 || stage !== v.gate+1) fail(); gate = v.gate; return;
      }
      if (!waiting || v.id !== waiting.id || v.event !== waiting.event) fail();
      if (['lifecycle_failure_paused','lifecycle_failure_inspect'].includes(v.event)) {
        lifecycleEvidence(v);
        if (v.session_id !== session || v.run_id !== task.run_id || v.operation_id !== task.operation_id) fail();
        if (v.event === 'lifecycle_failure_paused') finalOperation = v.final_operation_id;
        else if (v.final_operation_id !== finalOperation) fail();
      } else if (v.event === 'ready') {
        keys(v,['protocol','id','event','origin']);
        if (typeof v.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(v.origin)) fail();
        try { if (new URL(v.origin).origin !== v.origin) fail(); } catch { fail(); }
      } else if (v.event === 'stopped') {
        keys(v,['protocol','id','event','cleaned']); if (v.cleaned !== true) fail(); stopped = true;
      } else keys(v,['protocol','id','event']);
      waiting = undefined;
    },
  };
}
