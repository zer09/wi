// Installed before application modules. Only booleans, bounded counts and static categories leave the page.
export function installAcceptanceWarningObserver({ secrets }) {
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
  let requestBytes;
  let actualReply;
  let sendingDraft = false;
  let clearCount = 0;
  let clearAccepted = false;
  let truthful = true;
  const receiptExact = receipt => captured !== undefined && receipt?.operation_id === captured.id
    && receipt.session_id === session && receipt.run_id === captured.body.run_id
    && receipt.first_sequence === '2' && receipt.last_sequence === '3';
  const runExact = value => value?.run.run_id === captured?.body.run_id && value?.run.accepted_sequence === '2'
    && value?.user_text === captured?.body.text && value?.run.accepted.user_text === captured?.body.text;

  // Observe the actual immutable command and snapshots; never replace application state.
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (value?.kind === 'task' && value.session_id === session && value.body && captured === undefined) captured = frozen;
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending)
      && Array.isArray(value.recoveries) && Object.hasOwn(value, 'last_mutation') && Object.hasOwn(value, 'draft')) {
      if (captured === undefined) priorMutation = value.last_mutation;
      if (captured !== undefined && value.connection === 'connected') {
        const commands = [...value.pending, ...value.recoveries];
        const item = commands.find(item => item.command.id === captured.id);
        const runs = value.selected?.display ?? [];
        if (item?.phase === 'sending' && value.draft === captured.body.text) sendingDraft = true;
        truthful &&= commands.every(item => ['sending', 'accepted'].includes(item.phase))
          && runs.every(run => run.execution === 'accepted' && !run.result_recorded);
        if (latest?.draft === captured.body.text && value.draft === '') {
          clearCount = Math.min(clearCount + 1, 2);
          // A stored receipt or canonical run proves acceptance; a dispatch ID does not.
          clearAccepted = runs.some(runExact) || (item?.phase === 'accepted' && receiptExact(item.receipt));
          if (!clearAccepted || clearCount !== 1) failures.add('memory:clear');
        }
      }
      latest = frozen;
      if (session !== undefined && value.connection === 'disconnected') {
        captured = undefined; priorMutation = undefined; session = undefined; requestBytes = undefined; actualReply = undefined;
        Object.freeze = nativeFreeze;
      }
    }
    return frozen;
  };
  globalThis.acceptanceWarningCapture = {
    select(sid) { session = sid; },
    summary() { return { count, reply: { ...reply }, failures: [...failures] }; },
    memory({ operation, run, text }) {
      const outcome = latest?.last_mutation;
      const display = latest?.selected?.display;
      const canonical = display?.[0];
      return {
        capturedFrozen: captured !== undefined && Object.isFrozen(captured) && Object.isFrozen(captured.body),
        commandExact: captured !== undefined && captured.kind === 'task' && captured.id === operation && captured.session_id === session
          && captured.body.operation_id === operation && captured.body.run_id === run && captured.body.text === text
          && Object.keys(captured.body).sort().join(',') === 'operation_id,run_id,text',
        bytesExact: captured !== undefined && requestBytes === JSON.stringify(captured.body),
        distinctIds: priorMutation?.kind === 'create' && new Set([priorMutation.id, operation, run, session]).size === 4,
        draftClearedByAcceptance: sendingDraft && clearCount === 1 && clearAccepted && latest?.draft === '',
        acceptedOnly: truthful && latest?.error === null && latest?.selected?.observation_error === null
          && display?.length === 1 && runExact(canonical) && canonical.execution === 'accepted' && canonical.result_recorded === false
          && canonical.run.started_sequence === null && canonical.run.finished === null && canonical.run.result === null
          && canonical.run.interrupted === null && canonical.entries.length === 0,
        noPending: latest?.pending.length === 0 && latest?.recoveries.length === 0 && latest?.selected?.cancel === null,
        headExact: latest?.selected?.session_id === session && latest.selected.applied_cursor === `${session}:3`,
        lastMutationExact: outcome?.kind === 'task' && outcome.id === operation && outcome.session_id === session
          && receiptExact(outcome.receipt) && receiptExact(outcome.reply?.receipt) && outcome.reply?.api_version === 1
          && outcome.reply.duplicate === false && outcome.reply.warning_code === 'storage.connection_cleanup_failed'
          && outcome.reply.notices.length === 0 && outcome.notices.length === 0 && outcome.canonical_read_error === null
          && actualReply !== undefined && JSON.stringify(outcome.reply) === JSON.stringify(actualReply),
      };
    },
    cleared() {
      return latest?.connection === 'disconnected' && latest.draft === '' && latest.pending.length === 0
        && latest.recoveries.length === 0 && latest.selected === null && latest.last_mutation === null
        && captured === undefined && priorMutation === undefined && session === undefined
        && requestBytes === undefined && actualReply === undefined && Object.freeze === nativeFreeze;
    },
    async drain() { while (reads.size !== 0) await Promise.all(reads); },
  };
  globalThis.fetch = async (...args) => {
    const request = args[0];
    const url = new URL(request instanceof Request ? request.url : request, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
    const selected = session !== undefined && url.origin === location.origin && url.search === '' && url.hash === ''
      && method === 'POST' && url.pathname === `/v1/sessions/${session}/runs`;
    // The client passes an immutable JSON string, not a Request stream. Keep it only in page memory.
    if (selected && requestBytes === undefined && typeof args[1]?.body === 'string' && args[1].body.length <= 4096) requestBytes = args[1].body;
    const response = await nativeFetch(...args);
    if (!selected) return response;
    if (count === 1) { failures.add('task:limit'); return response; }
    count++;
    let step = 'status';
    let reader;
    let timer;
    const read = (async () => {
      reply.status = response.status === 202 ? 202 : 0;
      if (response.status !== 202) throw new Error();
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
      const validated = api.validateTaskAcceptedView(value);
      reply.validated = true;
      step = 'exact';
      // Five top-level and five receipt fields; duplicate JSON keys cannot hide behind JSON.parse.
      reply.exact = body.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 11
        && value.api_version === 1 && receiptExact(value.receipt) && value.duplicate === false
        && value.warning_code === 'storage.connection_cleanup_failed' && value.notices.length === 0;
      if (!reply.exact) throw new Error();
      actualReply = validated;
    })().catch(() => { failures.add(`task:${step}`); }).finally(() => {
      clearTimeout(timer);
      // Tee cancellation must not wait for, or cancel, the application's original response.
      void reader?.cancel().catch(() => {});
      reads.delete(read);
    });
    reads.add(read);
    return response;
  };
}
