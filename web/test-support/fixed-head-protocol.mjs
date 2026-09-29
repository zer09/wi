const fail = () => { throw new Error('fixture protocol rejected'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
function keys(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
}
export function fixedHeadEvidence(value) {
  keys(value, ['protocol','id','event','session_id','phase','exact','prefix_unchanged','sequence_count','seed_head',
    'renames','acceptances','selections','bindings','connections','requests','tools','completed','auth_loads','auth_prepares']);
  if (value.protocol !== 1 || value.event !== 'fixed_head_inspect' || !Number.isInteger(value.id) || value.id < 1 || value.id > 0xffffffff
    || !uuid(value.session_id) || value.exact !== true || value.prefix_unchanged !== true || value.seed_head !== '1') fail();
  const expected = {
    initial: ['66',65,0,0,0,false], interleaved: ['72',66,1,1,0,false], completed: ['86',66,1,2,1,true],
  }[value.phase];
  if (expected === undefined) fail();
  const [head, renames, opened, requests, tools, completed] = expected;
  if (value.sequence_count !== head || value.renames !== renames || value.requests !== requests || value.tools !== tools || value.completed !== completed
    || ['acceptances','selections','bindings','connections','auth_loads','auth_prepares'].some(key => value[key] !== opened)) fail();
  return value;
}
export function fixedHeadProtocol(enabled) {
  let waiting;
  let last = 0;
  let session;
  let selected = false;
  let gate = 0;
  let driven = 0;
  let finished = false;
  let stopped = false;
  return {
    request(value) {
      if (!enabled) return;
      if (stopped || waiting !== undefined || !Number.isInteger(value.id) || value.id <= last || value.id > 0xffffffff) fail();
      if (last === 0) {
        if (value.id !== 1 || value.command !== undefined || value.fixed_head !== true) fail();
        waiting = { id: value.id, event: 'ready' };
      } else {
        const extra = value.command === 'select' ? ['session_id'] : value.command === 'drive' ? ['gate'] : [];
        keys(value, ['command','id', ...extra]);
        let event;
        if (value.command === 'select') {
          if (selected || value.session_id !== session) fail();
          selected = true; event = 'selected';
        } else if (value.command === 'drive') {
          if (!selected || gate !== driven + 1 || value.gate !== gate || gate > 3 || finished) fail();
          driven = gate; event = 'driven';
        } else if (value.command === 'inspect') event = 'fixed_head_inspect';
        else if (value.command === 'stop') event = 'stopped';
        else fail();
        waiting = { id: value.id, event };
      }
      last = value.id;
    },
    reply(value) {
      if (!enabled) { if (value.event === 'fixed_head_inspect') fail(); return; }
      if (stopped) fail();
      if (value.event === 'model_paused') {
        keys(value, ['protocol','event','gate']);
        if (!selected || finished || value.gate !== gate + 1 || gate !== driven || value.gate > 3) fail();
        gate = value.gate; return;
      }
      if (value.event === 'task_finished') {
        keys(value, ['protocol','event','task']);
        if (finished || driven !== 3 || value.task !== 1) fail();
        finished = true; return;
      }
      if (waiting === undefined || value.id !== waiting.id || value.event !== waiting.event) fail();
      if (value.event === 'ready') {
        if (!uuid(value.session_id)) fail(); session = value.session_id;
      } else if (value.event === 'fixed_head_inspect') {
        fixedHeadEvidence(value);
        if (value.session_id !== session || (finished && value.phase !== 'completed') || (!finished && value.phase === 'completed')) fail();
      } else if (value.event === 'stopped') { if (value.cleaned !== true) fail(); stopped = true; }
      waiting = undefined;
    },
  };
}
