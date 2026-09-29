import { lifecycleFlat, startScenario as baseScenario } from './lifecycle-failure-protocol.mjs';
const fail = () => { throw new Error('fixture protocol rejected'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const id = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
export function cancellationFlat(raw) {
  const value = lifecycleFlat(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}
function keys(value, fields) {
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
}
export function startScenario(raw) {
  const value = cancellationFlat(raw);
  if (!Object.hasOwn(value, 'cancellation')) return baseScenario(value);
  const { cancellation, ...base } = value;
  baseScenario(base);
  if (typeof cancellation !== 'boolean' || (cancellation && (base.transport !== 'websocket' || base.recovered !== false || base.mime !== true
    || ['mutations','presentation','unbound_history','fixed_head','tool_fidelity','lifecycle_failure'].some(key => base[key] === true)))) fail();
  return Object.freeze({...value});
}
export function cancellationEvidence(raw) {
  const v = cancellationFlat(raw);
  const pending = v.event === 'cancellation_pending';
  const inspect = v.event === 'cancellation_inspect';
  keys(v, ['protocol','id','event','session_id','run_id','operation_id','sequence_count','connections','requests','closed','exact',
    ...pending ? [] : ['terminal_operation_id','hits'],
    ...inspect ? ['retired','dispatches','prepared_results','reused','result_records','prefix_unchanged'] : []]);
  const ids = [v.session_id,v.run_id,v.operation_id,...pending ? [] : [v.terminal_operation_id]];
  if (v.protocol !== 1 || !id(v.id) || (!pending && !inspect && v.event !== 'cancellation_paused')
    || !ids.every(uuid) || new Set(ids).size !== ids.length || v.connections !== 1 || v.requests !== 1 || v.exact !== true
    || v.closed !== !pending || (!pending && v.hits !== 1)) fail();
  let head = '7';
  if (pending) head = '6';
  else if (inspect) head = '9';
  if (v.sequence_count !== head || (inspect && (v.retired !== true || v.dispatches !== 0 || v.prepared_results !== 0
    || v.reused !== 0 || v.result_records !== 1 || v.prefix_unchanged !== true))) fail();
  return v;
}
export function cancellationProtocol(enabled) {
  let last = 0; let stage = 0; let waiting; let session; let task; let terminal; let stopped = false;
  return {
    request(raw) {
      const v = cancellationFlat(raw);
      if (!enabled) { if (v.command?.includes('cancellation')) fail(); return; }
      if (stopped || waiting !== undefined || !id(v.id) || v.id <= last) fail();
      let event;
      if (last === 0) {
        const { id:requestId, owner, ...scenario } = v;
        if (requestId !== 1 || typeof owner !== 'string' || !/^[0-9a-f]{64}$/.test(owner) || scenario.transport !== 'web_socket') fail();
        startScenario({...scenario,transport:'websocket'});
        if (scenario.cancellation !== true) fail();
        event = 'ready';
      } else {
        const extras = {select:['session_id'],wait_cancellation_pending:['session_id','run_id','operation_id'],release_cancellation:['terminal_operation_id']};
        keys(v, ['id','command',...extras[v.command] ?? []]);
        if (v.command === 'select') {
          if (stage !== 0 || !uuid(v.session_id)) fail(); session = v.session_id; stage = 1; event = 'selected';
        } else if (v.command === 'arm_cancellation') {
          if (stage !== 1) fail(); stage = 2; event = 'cancellation_armed';
        } else if (v.command === 'wait_cancellation_pending') {
          if (stage !== 2 || v.session_id !== session || !uuid(v.run_id) || !uuid(v.operation_id) || new Set([session,v.run_id,v.operation_id]).size !== 3) fail();
          task = {run_id:v.run_id,operation_id:v.operation_id}; stage = 3; event = 'cancellation_pending';
        } else if (v.command === 'wait_cancellation') {
          if (stage !== 3) fail(); stage = 4; event = 'cancellation_paused';
        } else if (v.command === 'release_cancellation') {
          if (stage !== 4 || v.terminal_operation_id !== terminal) fail(); stage = 5; event = 'cancellation_released';
        } else if (v.command === 'inspect_cancellation') {
          if (stage < 5 || stage > 7) fail(); stage++; event = 'cancellation_inspect';
        } else if (v.command === 'stop') event = 'stopped';
        else fail();
      }
      last = v.id; waiting = {id:v.id,event};
    },
    reply(raw) {
      const v = cancellationFlat(raw);
      if (!enabled) { if (v.event?.startsWith('cancellation_')) fail(); return; }
      if (stopped || v.protocol !== 1 || !waiting || v.id !== waiting.id || v.event !== waiting.event) fail();
      if (['cancellation_pending','cancellation_paused','cancellation_inspect'].includes(v.event)) {
        cancellationEvidence(v);
        if (v.session_id !== session || v.run_id !== task.run_id || v.operation_id !== task.operation_id) fail();
        if (v.event === 'cancellation_paused') terminal = v.terminal_operation_id;
        else if (v.event === 'cancellation_inspect' && v.terminal_operation_id !== terminal) fail();
      } else if (v.event === 'ready') {
        keys(v, ['protocol','id','event','origin']);
        if (typeof v.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(v.origin)) fail();
        try { if (new URL(v.origin).origin !== v.origin) fail(); } catch { fail(); }
      } else if (v.event === 'stopped') {
        keys(v, ['protocol','id','event','cleaned']); if (v.cleaned !== true) fail(); stopped = true;
      } else keys(v, ['protocol','id','event']);
      waiting = undefined;
    },
  };
}
