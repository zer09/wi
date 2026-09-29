// Installed before app modules. Only the first A task reply waits; its body is never read or copied.
export function installDisconnectEpochObserver({ title, task, draft, owner }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const failures = new Set();
  const signals = [];
  const counts = { create:0, task:0, other:0, holds:0, settings:0, list:0, manifest:0, history:0, events:0, quiet:0 };
  let creation = null;
  let session = null;
  let command = null;
  let held = null;
  let ready = false;
  let canonical = false;
  let draftSeen = false;
  let received = false;
  let released = false;
  let returned = false;
  let unconsumed = false;
  let disconnected = false;
  let empty = false;
  let hashRetained = false;
  let listening = true;
  let taskAborted = false;
  let streamAborted = false;
  let drained = false;
  let reconnect = false;
  let reopened = false;
  let closed = false;
  let unlock;
  let timer;
  const gate = new Promise(resolve => { unlock = resolve; });
  const fail = category => { failures.add(category); };
  const bump = name => { counts[name] = Math.min(32, counts[name] + 1); };
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  const isEmpty = value => value.connection === 'disconnected' && value.settings === null && value.catalog === null
    && value.catalog_loading === false && value.selected === null && value.draft === '' && value.pending.length === 0
    && value.recoveries.length === 0 && value.last_mutation === null && value.error === null;
  function checkHash() {
    if (closed || !disconnected) return;
    hashRetained = location.hash === `#session=${session}`;
    if (!hashRetained) fail('state:hash');
  }
  globalThis.addEventListener('hashchange',checkHash);
  function release() { released = true; clearTimeout(timer); unlock(); }
  function teardown() {
    release(); closed = true;
    globalThis.removeEventListener('hashchange',checkHash); listening = false;
    for (const [signal, listener] of signals) signal.removeEventListener('abort', listener);
    signals.length = 0;
    globalThis.fetch = nativeFetch; Object.freeze = nativeFreeze;
    held = null; command = null; creation = null; session = null;
    title = undefined; task = undefined; draft = undefined; owner = undefined;
  }
  async function waitFor(predicate, category) {
    for (let i=0; i<500; i++) {
      if (predicate()) return true;
      if (closed) break;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    fail(category); release(); return false;
  }
  function snapshot(value) {
    if (disconnected) {
      checkHash();
      empty = isEmpty(value);
      if (!reconnect && !empty) fail('state:epoch');
      if (value.pending.length !== 0 || value.recoveries.length !== 0 || value.last_mutation !== null
        || value.draft !== '' || value.error !== null) fail('state:revived');
      if (reconnect && value.selected?.observation === 'streaming') {
        const s = value.selected;
        if (s.session_id !== session || s.title !== title || s.workspace !== creation.body.workspace
          || s.manifest?.head_sequence !== '20' || s.applied_cursor !== `${session}:20` || s.through_sequence !== '20'
          || !s.history_complete || s.display.length !== 1 || s.display[0].user_text !== task
          || s.display[0].run.run_id !== command.body.run_id || s.display[0].execution !== 'completed'
          || !s.display[0].result_recorded || s.observation_error !== null || s.run_view !== null
          || s.cancel !== null || s.cancelling || s.closed_reason !== null) fail('state:reopen');
        else reopened = true;
      }
      return;
    }
    if (value.connection === 'disconnected' && command !== null) {
      disconnected = true; empty = isEmpty(value); checkHash();
      if (!received || released || !empty || !taskAborted || !streamAborted || !draftSeen) fail('state:disconnect');
      return; // Keep the hooks installed so the late completion remains observable.
    }
    for (const item of [...value.pending,...value.recoveries]) {
      const c = item.command;
      if (c.kind === 'create') {
        if (creation === null) creation = c;
        if (c.id !== creation.id || !uuid(c.id) || c.body.operation_id !== c.id || c.body.title !== title
          || c.body.workspace !== creation.body.workspace || !Object.isFrozen(c) || !Object.isFrozen(c.body)) fail('state:create');
      } else if (c.kind === 'task') {
        if (command === null) command = c;
        if (!ready || c.id !== command.id || !uuid(c.id) || !uuid(c.body.run_id) || c.id === c.body.run_id
          || c.id === creation?.id || c.body.run_id === creation?.id || c.session_id !== session
          || c.body.operation_id !== c.id || c.body.run_id !== command.body.run_id || c.body.text !== task
          || !Object.isFrozen(c) || !Object.isFrozen(c.body)) fail('state:command');
        if (item.receipt !== null || item.reply !== null) fail('state:early-reply');
        if (item.canonical_seen) {
          if (item.canonical_sequence !== '2' || item.phase !== 'accepted') fail('state:canonical');
          canonical = true;
        }
      } else fail('state:mutation');
    }
    const m = value.last_mutation;
    if (m?.kind === 'create') {
      const r = m.receipt;
      if (m.id !== creation?.id || !uuid(m.session_id) || r?.operation_id !== m.id || r?.session_id !== m.session_id
        || r?.run_id !== null || r?.first_sequence !== '1' || r?.last_sequence !== '1') fail('state:create');
      else if (session === null) session = m.session_id;
      else if (session !== m.session_id) fail('state:create');
    } else if (m !== null) fail('state:early-reply');
    const s = value.selected;
    if (command === null && s?.observation === 'streaming') {
      if (s.session_id !== session || s.title !== title || s.workspace !== creation?.body.workspace
        || s.manifest?.head_sequence !== '1' || s.applied_cursor !== `${session}:1` || s.through_sequence !== '1'
        || !s.history_complete || s.display.length !== 0) fail('state:initial');
      else ready = true;
    }
    if (command !== null && value.draft === draft) draftSeen = true;
  }
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (!value || typeof value.connection !== 'string' || !Array.isArray(value.pending)
      || !Array.isArray(value.recoveries) || !Object.hasOwn(value,'last_mutation') || !Object.hasOwn(value,'draft')) return frozen;
    try { snapshot(value); } catch { fail('state:shape'); }
    return frozen;
  };
  globalThis.disconnectEpochCapture = {
    summary: () => ({ counts:{...counts}, ready, canonical, draftSeen, received, released, returned, unconsumed,
      disconnected, empty, hashRetained, taskAborted, streamAborted, drained, reconnect, reopened, failures:[...failures] }),
    wait: () => waitFor(() => received,'hold:wait'),
    release() {
      checkHash();
      if (closed || !received || released || !disconnected || !empty || !hashRetained || !taskAborted || !streamAborted) { fail('hold:order'); return false; }
      release(); return true;
    },
    async drain() {
      if (!released || !disconnected || reconnect) { fail('hold:order'); return false; }
      if (!await waitFor(() => returned,'hold:drain')) return false;
      // A macrotask lets the controller discard the stale reply; the quiet window also catches timers.
      await new Promise(resolve => setTimeout(resolve,500));
      checkHash();
      drained = !closed && empty && hashRetained && unconsumed && counts.quiet === 0
        && !failures.has('state:epoch') && !failures.has('state:revived') && !failures.has('state:hash');
      return drained;
    },
    reconnect() {
      checkHash();
      if (closed || !drained || reconnect || !empty || !hashRetained || counts.quiet !== 0 || failures.has('state:hash')) { fail('hold:order'); return false; }
      reconnect = true; return true;
    },
    cleared: () => closed && !listening && held === null && command === null && creation === null && session === null && signals.length === 0
      && owner === undefined && task === undefined && title === undefined && draft === undefined
      && globalThis.fetch === nativeFetch && Object.freeze === nativeFreeze,
    teardown,
  };
  globalThis.fetch = async (...args) => {
    let hold = false;
    try {
      if (disconnected && (!reconnect || empty)) { bump('quiet'); fail('request:quiet'); }
      const url = new URL(args[0] instanceof Request ? args[0].url : args[0],location.href);
      const init = args[1]; const method = init?.method ?? 'GET';
      if (url.origin !== location.origin) fail('request:external');
      if (url.pathname.startsWith('/v1/')) {
        if (init?.mode !== 'same-origin' || init?.credentials !== 'omit' || init?.cache !== 'no-store' || init?.redirect !== 'error'
          || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`) fail('request:options');
        if (method === 'POST') {
          if (url.pathname === '/v1/sessions') { bump('create'); if (counts.create !== 1) fail('request:create'); }
          else if (/\/runs$/.test(url.pathname)) {
            bump('task');
            if (counts.task !== 1) fail('request:extra-task');
            if (url.pathname !== `/v1/sessions/${session}/runs` || url.search !== '' || url.hash !== '') fail('request:task');
            else if (counts.task === 1) hold = true;
            if (typeof init.body !== 'string' || init.body.length > 4096) fail('request:body');
            else {
              const body = JSON.parse(init.body);
              if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || body.operation_id !== command?.id
                || body.run_id !== command?.body.run_id || body.text !== task) fail('request:body');
            }
            if (hold) {
              const listener = () => { taskAborted = true; };
              init.signal.addEventListener('abort',listener,{once:true}); signals.push([init.signal,listener]);
            }
          } else { bump('other'); fail('request:mutation'); }
        } else if (method === 'GET') {
          const base = `/v1/sessions/${session}`;
          if (url.pathname === '/v1/settings') bump('settings');
          else if (url.pathname === '/v1/sessions') bump('list');
          else if (url.pathname === base) bump('manifest');
          else if (url.pathname === `${base}/history`) bump('history');
          else if (url.pathname === `${base}/events`) {
            bump('events');
            if (counts.events === 1) {
              const listener = () => { streamAborted = true; };
              init.signal.addEventListener('abort',listener,{once:true}); signals.push([init.signal,listener]);
            }
          } else { bump('other'); fail('request:read'); }
        } else { bump('other'); fail('request:method'); }
      }
    } catch { fail('request:shape'); }
    const response = await nativeFetch(...args);
    if (!hold || closed) return response;
    bump('holds'); held = response; received = true;
    if (response.status !== 202 || response.bodyUsed) fail('hold:response');
    timer = setTimeout(() => { fail('hold:timeout'); release(); },10_000);
    await gate;
    unconsumed = held === response && !response.bodyUsed;
    if (!closed && !unconsumed) fail('hold:response');
    held = null; returned = true;
    return response;
  };
}
