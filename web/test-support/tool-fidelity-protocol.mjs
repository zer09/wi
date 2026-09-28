import { startScenario as baseScenario } from './unbound-history-protocol.mjs';

const fail = () => { throw new Error('fixture protocol rejected'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const id = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
function keys(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
}
function flat(value) {
  if (typeof value !== 'string') return value;
  const raw = value;
  if (raw.includes('\\')) fail();
  try { value = JSON.parse(raw); } catch { fail(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || raw.replace(/"[^"\\]*"/g,'""').split(':').length !== Object.keys(value).length + 1) fail();
  return value;
}
export function startScenario(value) {
  value = flat(value);
  if (!Object.hasOwn(value ?? {}, 'tool_fidelity')) return baseScenario(value);
  const { tool_fidelity, ...base } = value;
  baseScenario(base);
  if (typeof tool_fidelity !== 'boolean' || (tool_fidelity && (base.transport !== 'websocket'
    || base.recovered !== false || base.mime !== true || ['presentation','mutations','unbound_history','fixed_head'].some(key => base[key] === true)))) fail();
  return Object.freeze({ ...value });
}
export function toolFidelityEvidence(value) {
  value = flat(value);
  keys(value, ['protocol','id','event','session_id','run_id','operation_id','completed','sequence_count','requests',
    'new_dispatches','reused','result_rows','prepared_results','executions','exact','prior_unchanged']);
  if (value.protocol !== 1 || !id(value.id) || value.event !== 'tool_fidelity_inspect'
    || ![1,2].includes(value.completed) || ![value.session_id,value.run_id,value.operation_id].every(uuid)
    || new Set([value.session_id,value.run_id,value.operation_id]).size !== 3
    || typeof value.sequence_count !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value.sequence_count)
    || BigInt(value.sequence_count) > 128n || value.executions !== 1 || value.exact !== true || value.prior_unchanged !== true) fail();
  const first = value.completed === 1;
  if (value.requests !== (first ? 3 : 2) || value.new_dispatches !== (first ? 2 : 1) || value.reused !== (first ? 1 : 0)
    || value.result_rows !== (first ? 2 : 1) || value.prepared_results !== (first ? 3 : 1)) fail();
  return value;
}
export function toolFidelityProtocol(enabled) {
  let waiting;
  let last = 0;
  let session;
  let gate = 0;
  let driven = 0;
  let finished = 0;
  let audited = 0;
  let head = 0n;
  let stopped = false;
  const runs = new Set(); const operations = new Set();
  return {
    request(raw) {
      const value = flat(raw);
      if (!enabled) { if (value.command === 'inspect_tool_fidelity') fail(); return; }
      if (stopped || waiting !== undefined || !id(value.id) || value.id <= last) fail();
      let event;
      if (last === 0) {
        const { id: requestId, owner, ...scenario } = value;
        if (requestId !== 1 || typeof owner !== 'string' || !/^[0-9a-f]{64}$/.test(owner) || scenario.transport !== 'web_socket') fail();
        startScenario({ ...scenario, transport:'websocket' });
        if (scenario.tool_fidelity !== true) fail();
        event = 'ready';
      } else {
        const extra = value.command === 'select' ? ['session_id'] : value.command === 'drive' ? ['gate'] : [];
        keys(value, ['command','id',...extra]);
        if (value.command === 'select') {
          if (session !== undefined || !uuid(value.session_id)) fail(); session = value.session_id; event = 'selected';
        } else if (value.command === 'drive') {
          if (session === undefined || gate !== driven+1 || value.gate !== gate || gate > 5 || (gate === 4 && audited !== 1)) fail();
          driven = gate; event = 'driven';
        } else if (value.command === 'inspect_tool_fidelity') {
          if (session === undefined || finished !== audited+1) fail(); event = 'tool_fidelity_inspect';
        } else if (value.command === 'stop') event = 'stopped';
        else fail();
      }
      waiting = { id:value.id,event }; last = value.id;
    },
    reply(raw) {
      const value = flat(raw);
      if (!enabled) { if (value.event === 'tool_fidelity_inspect') fail(); return; }
      if (stopped || value.protocol !== 1) fail();
      if (value.event === 'model_paused') {
        keys(value, ['protocol','event','gate']);
        if (session === undefined || value.gate !== gate+1 || gate !== driven || value.gate > 5) fail();
        gate = value.gate; return;
      }
      if (value.event === 'task_finished') {
        keys(value, ['protocol','event','task']);
        if (value.task !== finished+1 || value.task > 2 || driven !== (value.task === 1 ? 3 : 5)) fail();
        finished = value.task; return;
      }
      if (waiting === undefined || value.id !== waiting.id || value.event !== waiting.event) fail();
      if (value.event === 'tool_fidelity_inspect') {
        toolFidelityEvidence(value);
        if (value.completed !== finished || value.session_id !== session || runs.has(value.run_id) || operations.has(value.operation_id)
          || BigInt(value.sequence_count) <= head) fail();
        runs.add(value.run_id); operations.add(value.operation_id); head = BigInt(value.sequence_count); audited++;
      } else if (value.event === 'ready') {
        keys(value,['protocol','id','event','origin']);
        if (typeof value.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(value.origin)) fail();
        try { if (new URL(value.origin).origin !== value.origin) fail(); } catch { fail(); }
      } else if (value.event === 'stopped') {
        keys(value,['protocol','id','event','cleaned']); if (value.cleaned !== true) fail(); stopped = true;
      } else keys(value,['protocol','id','event']);
      waiting = undefined;
    },
  };
}
