// Installed before application modules. Only booleans, counts and static categories leave the page.
export function installAcceptanceUnknownObserver({ secrets }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const failures = new Set();
  const reads = new Set();
  const reply = { status: null, decoded: false, validated: false, exact: false };
  let count = 0;
  let session;
  let captured;
  let latest;
  let priorMutation;

  // Observe the actual frozen command and published snapshots, without replacing either.
  // The view does not show run_id, so DOM text alone cannot prove its retention.
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (value?.kind === 'task' && value.session_id === session && value.body && captured === undefined) captured = frozen;
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending)
      && Array.isArray(value.recoveries) && Object.hasOwn(value, 'last_mutation') && Object.hasOwn(value, 'draft')) {
      latest = frozen;
      if (captured === undefined) priorMutation = value.last_mutation;
      if (session !== undefined && value.connection === 'disconnected') {
        captured = undefined; priorMutation = undefined; session = undefined;
        Object.freeze = nativeFreeze;
      }
    }
    return frozen;
  };
  globalThis.acceptanceUnknownCapture = {
    select(sid) { session = sid; },
    summary() { return { count, reply: { ...reply }, failures: [...failures] }; },
    memory({ operation, run, text, draft }) {
      const item = latest?.pending[0];
      const command = item?.command;
      return {
        uncertain: latest?.pending.length === 1 && item.phase === 'uncertain',
        capturedFrozen: captured !== undefined && Object.isFrozen(captured) && Object.isFrozen(captured.body),
        commandExact: captured !== undefined && command !== undefined
          && [captured, command].every(value => value.kind === 'task' && value.id === operation
            && value.session_id === session && value.body.operation_id === operation
            && value.body.run_id === run && value.body.text === text),
        draftExact: latest?.draft === draft,
        noAcceptance: item?.receipt === null && item.reply === null && item.canonical_seen === false
          && item.canonical_sequence === null && latest.recoveries.length === 0,
        lastMutationUnchanged: priorMutation?.kind === 'create'
          && JSON.stringify(latest?.last_mutation) === JSON.stringify(priorMutation),
        noRun: latest?.selected?.display.length === 0 && latest.selected.run_view === null
          && latest.selected.cancel === null && latest.selected.applied_cursor === `${session}:1`,
      };
    },
    cleared() {
      return latest?.connection === 'disconnected' && latest.draft === '' && latest.pending.length === 0
        && latest.recoveries.length === 0 && latest.selected === null && latest.last_mutation === null
        && captured === undefined && priorMutation === undefined && session === undefined && Object.freeze === nativeFreeze;
    },
    async drain() { while (reads.size !== 0) await Promise.all(reads); },
  };
  globalThis.fetch = async (...args) => {
    const request = args[0];
    const url = new URL(request instanceof Request ? request.url : request, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
    const selected = session !== undefined && url.origin === location.origin && url.search === '' && url.hash === ''
      && method === 'POST' && url.pathname === `/v1/sessions/${session}/runs`;
    const response = await nativeFetch(...args);
    if (!selected) return response;
    if (count === 1) { failures.add('task:limit'); return response; }
    count++;
    let step = 'status';
    let reader;
    let timer;
    const read = (async () => {
      reply.status = response.status === 503 ? 503 : 0;
      if (response.status !== 503) throw new Error();
      step = 'media';
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error();
      step = 'body';
      reader = response.clone().body.getReader();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 2000); });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let body = '';
      let bytes = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        step = 'size';
        if (bytes > 4096) throw new Error();
        step = 'body';
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      step = 'secret';
      if (secrets.some(secret => body.includes(secret))) throw new Error();
      step = 'json';
      const value = JSON.parse(body);
      reply.decoded = true;
      step = 'schema';
      const api = await import('/assets/api.js');
      api.validateErrorView(value);
      reply.validated = true;
      step = 'exact';
      reply.exact = body.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 7
        && value.api_version === 1 && value.code === 'storage.commit_unknown' && value.stage === 'acceptance'
        && value.certainty === 'unknown' && value.acceptance === null && value.notices.length === 0;
      if (!reply.exact) throw new Error();
    })().catch(() => { failures.add(`task:${step}`); }).finally(() => {
      clearTimeout(timer);
      // Do not await tee cancellation: the application's original body has independent ownership.
      void reader?.cancel().catch(() => {});
      reads.delete(read);
    });
    reads.add(read);
    return response;
  };
}
