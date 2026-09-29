// Runs in the page before application modules. No body, command, or private diagnostic leaves this observer.
export function installUnboundHistoryObserver({ secrets, legacyText, legacyAnswer }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const reads = new Set();
  const failures = new Set();
  const reply = { status: null, decoded: false, validated: false, exact: false };
  let session;
  let latest;
  let baseline;
  let command;
  let requestBytes;
  let actualReply;
  let count = 0;
  let sending = false;
  let truthful = true;
  let epoch = 0;
  const legacy = state => state?.selected?.session_id === session && state.selected.applied_cursor === `${session}:9`
    && state.selected.through_sequence === '9' && state.selected.display.length === 1
    && state.selected.display.every(value => value.user_text === legacyText && value.run.accepted.user_text === legacyText
      && value.execution === 'completed' && value.result_recorded === true && value.run.accepted_sequence === '2'
      && value.run.finished?.sequence === '8' && value.run.result?.sequence === '9' && value.run.interrupted === null
      && value.entries.length === 1 && value.entries[0].kind === 'response'
      && value.entries[0].sections.length === 1 && value.entries[0].sections[0].text === legacyAnswer)
    && state.selected.run_view === null && state.selected.cancel === null && state.selected.observation_error === null;
  const commandExact = (value, expected) => value !== undefined && Object.isFrozen(value) && Object.isFrozen(value.body)
    && value.kind === 'task' && value.id === expected.operation && value.session_id === session
    && value.body.operation_id === expected.operation && value.body.run_id === expected.run && value.body.text === expected.text
    && Object.keys(value.body).sort().join(',') === 'operation_id,run_id,text';
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (value?.kind === 'task' && value.session_id === session && value.body) {
      if (command === undefined) command = frozen;
      else if (command.id !== value.id) failures.add('memory:command');
    }
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending)
      && Array.isArray(value.recoveries) && Object.hasOwn(value, 'last_mutation') && Object.hasOwn(value, 'draft')) {
      if (command !== undefined && value.connection === 'connected') {
        truthful &&= value.pending.length === 1 && value.recoveries.length === 0 && value.last_mutation === null
          && value.pending.every(item => item.command.id === command.id && ['sending', 'rejected'].includes(item.phase));
        sending ||= value.pending[0]?.phase === 'sending' && value.draft === command.body.text;
      }
      latest = frozen;
      if (session !== undefined && value.connection === 'disconnected') {
        session = undefined; command = undefined; baseline = undefined; requestBytes = undefined; actualReply = undefined;
        epoch++; Object.freeze = nativeFreeze; globalThis.fetch = nativeFetch;
      }
    }
    return frozen;
  };
  globalThis.unboundHistoryCapture = {
    select(sid) {
      if (session !== undefined || count !== 0) { failures.add('selection:order'); return; }
      session = sid;
    },
    legacy() {
      if (!legacy(latest) || latest.pending.length !== 0 || latest.recoveries.length !== 0 || latest.last_mutation !== null) return false;
      baseline ??= JSON.stringify(latest.selected.display);
      return true;
    },
    summary() { return { count, reply: { ...reply }, failures: [...failures] }; },
    rejected({ operation, run, text, draft }) {
      const expected = { operation, run, text };
      const item = latest?.pending[0];
      const server = actualReply === undefined ? null : { code: actualReply.code, stage: actualReply.stage,
        certainty: actualReply.certainty, acceptance: actualReply.acceptance, notices: actualReply.notices };
      return {
        commandExact: commandExact(command, expected) && commandExact(item?.command, expected),
        bytesExact: command !== undefined && requestBytes === JSON.stringify(command.body),
        freshIds: legacy(latest) && new Set([session, latest.selected.display[0].run.run_id, operation, run]).size === 4,
        rejectedOnly: truthful && sending && latest?.pending.length === 1 && item.phase === 'rejected' && latest.recoveries.length === 0,
        errorExact: actualReply !== undefined && item?.error?.category === 'http' && item.error.status === 422
          && JSON.stringify(item.error.server) === JSON.stringify(server) && item.notices.length === 0,
        noAcceptance: item?.receipt === null && item.reply === null && item.canonical_seen === false && item.canonical_sequence === null,
        draftExact: latest?.draft === draft,
        noLastMutation: latest?.last_mutation === null,
        canonicalUnchanged: baseline !== undefined && legacy(latest) && JSON.stringify(latest.selected.display) === baseline,
      };
    },
    cleared() { return latest?.connection === 'disconnected' && latest.draft === '' && latest.pending.length === 0
      && latest.recoveries.length === 0 && latest.selected === null && latest.last_mutation === null && session === undefined
      && command === undefined && baseline === undefined && requestBytes === undefined && actualReply === undefined
      && Object.freeze === nativeFreeze && globalThis.fetch === nativeFetch; },
    async drain() { while (reads.size !== 0) await Promise.all(reads); },
  };
  globalThis.fetch = async (...args) => {
    const request = args[0];
    const url = new URL(request instanceof Request ? request.url : request, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
    const selected = session !== undefined && method === 'POST' && url.origin === location.origin && url.search === '' && url.hash === ''
      && url.pathname === `/v1/sessions/${session}/runs`;
    if (!selected) return nativeFetch(...args);
    if (count === 1) { failures.add('task:limit'); return nativeFetch(...args); }
    count++;
    if (baseline === undefined || command === undefined) failures.add('task:order');
    const body = args[1]?.body;
    if (typeof body === 'string' && new TextEncoder().encode(body).byteLength <= 4096) requestBytes = body;
    else failures.add('task:request');
    const generation = epoch;
    const response = await nativeFetch(...args);
    let step = 'status';
    let reader;
    let timer;
    const read = (async () => {
      reply.status = response.status === 422 ? 422 : 0;
      if (response.status !== 422) throw new Error();
      // Clone before an await so the application can consume its original immediately.
      reader = response.clone().body.getReader();
      step = 'media';
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 2000); });
      const api = await Promise.race([import('/assets/api.js'), deadline]);
      api.requireMediaType(response.headers.get('content-type'), 'application/json');
      step = 'body';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      // Bound and validate the clone before text() accumulates it. This never touches the original body.
      const bounded = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await Promise.race([reader.read(), deadline]);
            if (chunk.done) { decoder.decode(); controller.close(); return; }
            bytes += chunk.value.byteLength;
            step = 'size';
            if (bytes > 4096) throw new Error();
            step = 'body';
            decoder.decode(chunk.value, { stream: true });
            controller.enqueue(chunk.value);
          } catch { controller.error(new Error()); }
        },
      });
      const text = await Promise.race([new Response(bounded).text(), deadline]);
      step = 'secret';
      if (secrets.some(secret => text.includes(secret))) throw new Error();
      step = 'json';
      const value = JSON.parse(text);
      reply.decoded = true;
      step = 'schema';
      const validated = api.validateErrorView(value);
      reply.validated = true;
      step = 'exact';
      reply.exact = text.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 7
        && value.api_version === 1 && value.code === 'invalid_request' && value.stage === 'history'
        && value.certainty === 'not_applicable' && value.acceptance === null && value.notices.length === 0;
      if (!reply.exact) throw new Error();
      step = 'order';
      if (epoch !== generation || baseline === undefined || command === undefined) throw new Error();
      actualReply = validated;
    })().catch(() => { failures.add(`task:${step}`); }).finally(() => {
      clearTimeout(timer);
      // A tee cancellation must not await or cancel the application's original branch.
      void reader?.cancel().catch(() => {});
      reads.delete(read);
    });
    reads.add(read);
    return response;
  };
}
