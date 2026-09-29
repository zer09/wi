// Installed before app modules. The held reply is the native Response, never a copy or a fixture reply.
export function installSelectionEpochObserver({ titles, task, draft, owner }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const failures = new Set();
  const creations = [];
  const sessions = [];
  const signals = [];
  const counts = { create:0, task:0, other:0, holds:0, aManifest:0, aHistory:0, aEvents:0, bManifest:0, bHistory:0, bEvents:0 };
  let command = null;
  let held = null;
  let received = false;
  let released = false;
  let returned = false;
  let canonical = false;
  let accepted = false;
  let switched = false;
  let bReady = false;
  let bDraft = false;
  let bSnapshot = null;
  let reopen = false;
  let aAborted = false;
  let taskAborted = false;
  let drained = false;
  let closed = false;
  let cleared = false;
  let unlock;
  let timer;
  const gate = new Promise(resolve => { unlock = resolve; });
  const fail = category => { failures.add(category); };
  const bump = name => { counts[name] = Math.min(8, counts[name] + 1); };
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  const sameCommand = value => command !== null && value.kind === 'task' && value.id === command.id
    && value.session_id === sessions[0] && value.body.operation_id === command.id
    && value.body.run_id === command.body.run_id && value.body.text === task
    && Object.isFrozen(value) && Object.isFrozen(value.body);
  const sameReceipt = value => value?.operation_id === command?.id && value?.session_id === sessions[0]
    && value?.run_id === command?.body.run_id && value?.first_sequence === '2' && value?.last_sequence === '3';
  function release() {
    released = true;
    clearTimeout(timer);
    unlock();
  }
  function teardown() {
    release(); closed = true;
    for (const [signal, listener] of signals) signal.removeEventListener('abort', listener);
    signals.length = 0;
    globalThis.fetch = nativeFetch; Object.freeze = nativeFreeze;
    held = null; command = null; bSnapshot = null; creations.length = 0; sessions.length = 0;
    titles = undefined; task = undefined; draft = undefined; owner = undefined;
  }
  // All controls terminate even if the application never reaches the expected state.
  async function waitFor(predicate, category) {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return true;
      if (closed) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fail(category); release(); return false;
  }
  function snapshot(value) {
    for (const item of [...value.pending, ...value.recoveries]) {
      const c = item.command;
      if (c.kind === 'create') {
        if (!creations.some(known => known.id === c.id)) {
          const slot = creations.length;
          if (slot >= 2 || c.body.title !== titles[slot] || !uuid(c.id) || c.body.operation_id !== c.id) fail('state:create');
          else creations.push(c);
        }
      } else if (c.kind === 'task') {
        if (command === null) {
          if (sessions.length !== 2 || c.session_id !== sessions[0] || !uuid(c.id) || !uuid(c.body.run_id)
            || c.id === c.body.run_id || creations.some(known => known.id === c.id || known.id === c.body.run_id)) fail('state:command');
          command = c;
        }
        if (!sameCommand(c)) fail('state:command');
        if (item.receipt !== null && !sameReceipt(item.receipt)) fail('state:receipt');
        if (item.canonical_seen) {
          if (item.canonical_sequence !== '2' || item.phase !== 'accepted') fail('state:canonical');
          canonical = true;
        }
      } else fail('state:mutation');
    }
    const mutation = value.last_mutation;
    if (mutation?.kind === 'create') {
      const slot = creations.findIndex(c => c.id === mutation.id);
      if (slot < 0 || !uuid(mutation.session_id) || mutation.receipt?.operation_id !== mutation.id
        || mutation.receipt?.session_id !== mutation.session_id || mutation.receipt?.run_id !== null
        || mutation.receipt?.first_sequence !== '1' || mutation.receipt?.last_sequence !== '1') fail('state:create');
      else if (sessions[slot] === undefined) {
        if (sessions.includes(mutation.session_id)) fail('state:create');
        sessions[slot] = mutation.session_id;
      } else if (sessions[slot] !== mutation.session_id) fail('state:create');
    } else if (mutation?.kind === 'task') {
      if (!returned || !canonical || mutation.id !== command?.id || mutation.session_id !== sessions[0]
        || !sameReceipt(mutation.receipt) || !sameReceipt(mutation.reply?.receipt)
        || mutation.reply?.duplicate !== false || mutation.reply?.warning_code !== null
        || mutation.reply?.notices.length !== 0 || mutation.canonical_read_error !== null
        || value.pending.length !== 0 || value.recoveries.length !== 0) fail('state:receipt');
      else accepted = true;
    }
    const selected = value.selected;
    if (command !== null && selected?.session_id === sessions[1]) {
      switched = true;
      if (selected.display.length !== 0 || selected.run_view !== null || selected.cancel !== null || selected.cancelling
        || selected.observation_error !== null || selected.closed_reason !== null || value.error !== null) fail('state:b');
      if (selected.title !== null && selected.title !== titles[1]) fail('state:b');
      if (selected.observation === 'streaming') {
        if (selected.title !== titles[1] || selected.workspace !== creations[1].body.workspace
          || selected.manifest?.head_sequence !== '1' || selected.applied_cursor !== `${sessions[1]}:1`
          || selected.through_sequence !== '1' || !selected.history_complete) fail('state:b');
        const next = JSON.stringify(selected);
        if (bSnapshot !== null && next !== bSnapshot) fail('state:b');
        bSnapshot = next; bReady = true;
      }
      if (value.draft === draft) bDraft = true;
      else if (value.draft !== '' || (bDraft && !reopen)) fail('state:draft');
      if (command.body.text !== task) fail('state:command');
    } else if (switched && !reopen && selected !== null) fail('state:epoch');
  }
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (!value || typeof value.connection !== 'string' || !Array.isArray(value.pending)
      || !Array.isArray(value.recoveries) || !Object.hasOwn(value, 'last_mutation') || !Object.hasOwn(value, 'draft')) return frozen;
    try {
      if (value.connection === 'disconnected' && command !== null) {
        cleared = value.selected === null && value.draft === '' && value.pending.length === 0 && value.recoveries.length === 0
          && value.last_mutation === null && value.settings === null && value.catalog === null;
        if (!cleared) fail('state:clear');
        teardown();
      } else snapshot(value);
    } catch { fail('state:shape'); }
    return frozen;
  };
  globalThis.selectionEpochCapture = {
    summary: () => ({ counts:{...counts}, received, released, returned, command:command !== null, canonical, accepted,
      switched, bReady, bDraft, aAborted, taskAborted, drained, failures:[...failures] }),
    wait: () => waitFor(() => received, 'hold:wait'),
    release() {
      if (!received || released || !bReady || !aAborted) { fail('hold:order'); return false; }
      release(); return true;
    },
    async drain() {
      drained = await waitFor(() => returned && accepted, 'hold:drain');
      await new Promise(resolve => setTimeout(resolve, 0));
      return drained;
    },
    reopen() { if (!drained || !bDraft) { fail('hold:order'); return false; } reopen = true; return true; },
    cleared: () => cleared && closed && command === null && held === null && signals.length === 0
      && globalThis.fetch === nativeFetch && Object.freeze === nativeFreeze,
    teardown,
  };
  globalThis.fetch = async (...args) => {
    let hold = false;
    try {
      const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
      const init = args[1]; const method = init?.method ?? 'GET';
      if (url.pathname.startsWith('/v1/')) {
        if (url.origin !== location.origin || init?.mode !== 'same-origin' || init?.credentials !== 'omit'
          || init?.cache !== 'no-store' || init?.redirect !== 'error'
          || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`) fail('request:options');
        if (method === 'POST') {
          if (url.pathname === '/v1/sessions') { bump('create'); if (counts.create > 2) fail('request:create'); }
          else if (/\/runs$/.test(url.pathname)) {
            bump('task');
            if (counts.task !== 1) fail('request:extra-task');
            if (url.pathname !== `/v1/sessions/${sessions[0]}/runs` || url.search !== '' || url.hash !== '') fail('request:task');
            else if (counts.task === 1) hold = true;
            if (typeof init.body !== 'string' || init.body.length > 4096) fail('request:body');
            else {
              const body = JSON.parse(init.body);
              if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || body.operation_id !== command?.id
                || body.run_id !== command?.body.run_id || body.text !== task) fail('request:body');
            }
            if (hold) {
              const listener = () => { taskAborted = true; fail('request:task-abort'); };
              init.signal.addEventListener('abort', listener, {once:true}); signals.push([init.signal, listener]);
            }
          } else { bump('other'); fail('request:mutation'); }
        } else if (method === 'GET') {
          for (const [slot, sid] of sessions.entries()) {
            const base = `/v1/sessions/${sid}`;
            const side = slot === 0 ? 'a' : 'b';
            if (url.pathname === base) bump(`${side}Manifest`);
            if (url.pathname === `${base}/history`) bump(`${side}History`);
            if (url.pathname === `${base}/events`) {
              bump(`${side}Events`);
              if (slot === 0 && counts.aEvents === 1) {
                const listener = () => { aAborted = true; };
                init.signal.addEventListener('abort', listener, {once:true}); signals.push([init.signal, listener]);
              }
            }
          }
          if (/\/(operations|runs)\//.test(url.pathname)) { bump('other'); fail('request:reconcile'); }
        } else { bump('other'); fail('request:method'); }
      }
    } catch { fail('request:shape'); }
    // Preserve argument and response identity. Never clone, consume or replace a response.
    const response = await nativeFetch(...args);
    if (!hold || closed) return response;
    bump('holds'); held = response; received = true;
    if (response.status !== 202 || response.bodyUsed) fail('hold:response');
    timer = setTimeout(() => { fail('hold:timeout'); release(); }, 10_000);
    await gate;
    if (!closed && (held !== response || response.bodyUsed)) fail('hold:response');
    held = null; returned = true;
    return response;
  };
}
