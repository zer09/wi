// Each document installs its own observer before app modules. No state crosses the reload.
export function installReloadEpochObserver({ title, task, draft, owner }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const failures = new Set();
  const counts = { create:0, task:0, other:0, holds:0, settings:0, list:0, manifest:0, history:0, events:0, quiet:0 };
  const reloaded = performance.getEntriesByType('navigation')[0]?.type === 'reload';
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  let session = reloaded && uuid(location.hash.slice(9)) && location.hash.startsWith('#session=') ? location.hash.slice(9) : null;
  let creation = null;
  let command = null;
  let held = null;
  let initialized = false;
  let initialEmpty = false;
  let empty = false;
  let ready = false;
  let canonical = false;
  let draftSeen = false;
  let received = false;
  let returned = false;
  let emergencyReleased = false;
  let leaving = false;
  let explicitConnect = false;
  let reopened = false;
  let closed = false;
  let unlock;
  let timer;
  const gate = new Promise(resolve => { unlock = resolve; });
  const fail = category => { failures.add(category); };
  const bump = name => { counts[name] = Math.min(32,counts[name] + 1); };
  const isEmpty = value => value.connection === 'disconnected' && value.settings === null && value.catalog === null
    && value.catalog_loading === false && value.selected === null && value.draft === '' && value.pending.length === 0
    && value.recoveries.length === 0 && value.last_mutation === null && value.error === null;
  const hashRetained = () => session !== null && location.hash === `#session=${session}`;
  const unconsumed = () => held !== null && held.status === 202 && !held.bodyUsed;
  function leave() { leaving = true; } // Do not release the Response on unload. The browser destroys this realm.
  function click(event) {
    if (!reloaded || closed || event.target?.tagName !== 'BUTTON' || event.target.textContent !== 'Connect') return;
    if (document.querySelector('input[type="password"]')?.value !== owner || !empty || !hashRetained() || explicitConnect) fail('state:connect');
    explicitConnect = true;
  }
  globalThis.addEventListener('beforeunload',leave);
  globalThis.addEventListener('pagehide',leave);
  globalThis.addEventListener('click',click,true);
  function release() { emergencyReleased = true; clearTimeout(timer); unlock(); }
  function teardown() {
    release(); closed = true;
    globalThis.removeEventListener('beforeunload',leave);
    globalThis.removeEventListener('pagehide',leave);
    globalThis.removeEventListener('click',click,true);
    globalThis.fetch = nativeFetch; Object.freeze = nativeFreeze;
    held = null; command = null; creation = null; session = null;
    title = undefined; task = undefined; draft = undefined; owner = undefined;
  }
  function snapshot(value) {
    empty = isEmpty(value);
    if (!initialized) { initialized = true; initialEmpty = empty; if (!empty) fail('state:initial'); }
    if (leaving) return;
    if (reloaded) {
      if (!hashRetained()) fail('state:hash');
      if (!explicitConnect && !empty) fail('state:epoch');
      if (value.pending.length !== 0 || value.recoveries.length !== 0 || value.last_mutation !== null
        || value.draft !== '' || value.error !== null) fail('state:revived');
      const s = value.selected;
      if (s?.observation === 'streaming') {
        if (!explicitConnect || s.session_id !== session || s.title !== title || !value.settings.workspaces.includes(s.workspace)
          || s.manifest?.head_sequence !== '20' || s.applied_cursor !== `${session}:20` || s.through_sequence !== '20'
          || !s.history_complete || s.display.length !== 1 || s.display[0].user_text !== task
          || s.display[0].execution !== 'completed' || !s.display[0].result_recorded || s.observation_error !== null
          || s.run_view !== null || s.cancel !== null || s.cancelling || s.closed_reason !== null) fail('state:reopen');
        else reopened = true;
      }
      return;
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
  globalThis.reloadEpochCapture = {
    summary: () => ({ counts:{...counts}, reloaded, initialized, initialEmpty, empty, ready, canonical, draftSeen,
      received, unconsumed:unconsumed(), returned, emergencyReleased, leaving, explicitConnect, reopened,
      hashRetained:hashRetained(), closed, cleared:closed && held === null && command === null && creation === null && session === null
        && owner === undefined && task === undefined && title === undefined && draft === undefined
        && globalThis.fetch === nativeFetch && Object.freeze === nativeFreeze, failures:[...failures] }),
    async wait() {
      for (let i=0; i<500; i++) {
        if (received) return true;
        if (closed) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      fail('hold:wait'); release(); return false;
    },
    teardown,
  };
  globalThis.fetch = async (...args) => {
    let hold = false;
    try {
      const url = new URL(args[0] instanceof Request ? args[0].url : args[0],location.href);
      const init = args[1]; const method = init?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
      if (url.origin !== location.origin) fail('request:external');
      if (url.pathname.startsWith('/v1/')) {
        if (reloaded && !explicitConnect) { bump('quiet'); fail('request:quiet'); }
        if (init?.mode !== 'same-origin' || init?.credentials !== 'omit' || init?.cache !== 'no-store' || init?.redirect !== 'error'
          || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`) fail('request:options');
        if (method === 'POST') {
          if (url.pathname === '/v1/sessions') { bump('create'); if (counts.create !== 1 || reloaded) fail('request:create'); }
          else if (/\/runs$/.test(url.pathname)) {
            bump('task');
            if (counts.task !== 1 || reloaded) fail('request:extra-task');
            if (url.pathname !== `/v1/sessions/${session}/runs` || url.search !== '' || url.hash !== '') fail('request:task');
            else if (counts.task === 1 && !reloaded) hold = true;
            if (typeof init.body !== 'string' || init.body.length > 4096) fail('request:body');
            else {
              const body = JSON.parse(init.body);
              if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || body.operation_id !== command?.id
                || body.run_id !== command?.body.run_id || body.text !== task) fail('request:body');
            }
          } else { bump('other'); fail('request:mutation'); }
        } else if (method === 'GET') {
          const base = `/v1/sessions/${session}`;
          if (url.pathname === '/v1/settings') bump('settings');
          else if (url.pathname === '/v1/sessions') bump('list');
          else if (url.pathname === base) bump('manifest');
          else if (url.pathname === `${base}/history`) bump('history');
          else if (url.pathname === `${base}/events`) bump('events');
          else { bump('other'); fail('request:read'); }
        } else { bump('other'); fail('request:method'); }
      }
    } catch { fail('request:shape'); }
    const response = await nativeFetch(...args);
    if (!hold || closed) return response;
    bump('holds'); held = response; received = true;
    if (!unconsumed()) fail('hold:response');
    timer = setTimeout(() => { fail('hold:timeout'); release(); },10_000);
    await gate;
    clearTimeout(timer);
    if (!closed && (held !== response || !unconsumed())) fail('hold:response');
    held = null; returned = true;
    return response;
  };
}
