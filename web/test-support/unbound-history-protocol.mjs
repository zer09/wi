const fail = () => { throw new Error('fixture protocol rejected'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
function keys(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
}
export function startScenario(value) {
  // A string entry point lets protocol tests exercise duplicate and escaped field names.
  if (typeof value === 'string') {
    const raw = value;
    if (raw.includes('\\')) fail();
    try { value = JSON.parse(raw); } catch { fail(); }
    if (raw.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length !== Object.keys(value ?? {}).length + 1) fail();
  }
  const optional = ['presentation', 'mutations', 'unbound_history', 'fixed_head'];
  keys(value, ['transport', 'recovered', 'mime', ...optional.filter(key => Object.hasOwn(value ?? {}, key))]);
  if (!['websocket', 'sse'].includes(value.transport) || typeof value.recovered !== 'boolean' || typeof value.mime !== 'boolean'
    || optional.some(key => Object.hasOwn(value, key) && typeof value[key] !== 'boolean')) fail();
  if (value.unbound_history === true && value.fixed_head === true) fail();
  if ((value.unbound_history === true || value.fixed_head === true) && !(value.mutations === true && value.transport === 'websocket'
    && value.recovered === false && value.mime === true && value.presentation !== true)) fail();
  return Object.freeze({ ...value });
}
export function unboundEvidence(value) {
  keys(value, ['protocol', 'id', 'event', 'session_id', 'exact', 'unchanged', 'replay_rejected', 'completed', 'result_recorded',
    'sequence_count', 'seed_head', 'acceptances', 'selections', 'bindings', 'runtime', 'results', 'tools',
    'connections', 'requests', 'auth_loads', 'auth_prepares']);
  if (value.protocol !== 1 || value.event !== 'unbound_history_inspect' || !Number.isSafeInteger(value.id)
    || value.id < 1 || value.id > 0xffffffff || !uuid(value.session_id)
    || ['exact', 'unchanged', 'replay_rejected', 'completed', 'result_recorded'].some(key => value[key] !== true)
    || value.sequence_count !== '9' || value.seed_head !== '1' || value.acceptances !== 1 || value.runtime !== 6 || value.results !== 1
    || ['selections', 'bindings', 'tools', 'connections', 'requests', 'auth_loads', 'auth_prepares'].some(key => value[key] !== 0)) fail();
  return value;
}
export function unboundProtocol(enabled) {
  let lastId = 0;
  let waiting;
  let session;
  let stopped = false;
  return {
    request(value) {
      if (!enabled) return;
      if (stopped || waiting !== undefined || !Number.isSafeInteger(value.id) || value.id <= lastId || value.id > 0xffffffff) fail();
      if (lastId === 0) {
        if (value.command !== undefined || value.id !== 1 || value.unbound_history !== true) fail();
        waiting = { id: value.id, event: 'ready' };
      } else {
        keys(value, ['command', 'id']);
        if (!['inspect', 'stop'].includes(value.command) || session === undefined) fail();
        waiting = { id: value.id, event: value.command === 'inspect' ? 'unbound_history_inspect' : 'stopped' };
      }
      lastId = value.id;
    },
    reply(value) {
      if (!enabled) {
        if (value.event === 'unbound_history_inspect' || (value.event === 'ready' && Object.hasOwn(value, 'session_id'))) fail();
        return;
      }
      if (stopped || waiting === undefined || value.id !== waiting.id || value.event !== waiting.event) fail();
      if (value.event === 'ready') {
        if (!uuid(value.session_id)) fail();
        session = value.session_id;
      } else if (value.event === 'unbound_history_inspect') {
        unboundEvidence(value);
        if (value.session_id !== session) fail();
      } else {
        if (value.cleaned !== true) fail();
        stopped = true;
      }
      waiting = undefined;
    },
  };
}
