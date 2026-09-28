// Installed before application modules. Only booleans, bounded counts and static categories leave the page.
export function installIncompleteHistoryObserver({ secrets }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const reads = new Set();
  const failures = new Set();
  const replies = Array.from({ length: 2 }, () => ({ status: null, decoded: false, validated: false, exact: false }));
  const commands = [];
  const requestBytes = [];
  const actualReplies = [];
  let session;
  let latest;
  let priorMutation;
  let firstOutcome;
  let count = 0;
  let returned = 0;
  let finalized = 0;
  let clearCount = 0;
  let clearAccepted = false;
  let sendingDraft = false;
  let truthful = true;
  const receiptExact = receipt => commands[0] !== undefined && receipt?.operation_id === commands[0].id
    && receipt.session_id === session && receipt.run_id === commands[0].body.run_id
    && receipt.first_sequence === '2' && receipt.last_sequence === '3';
  const runExact = value => commands[0] !== undefined && value?.run.run_id === commands[0].body.run_id
    && value.run.accepted_sequence === '2' && value.user_text === commands[0].body.text
    && value.run.accepted.user_text === commands[0].body.text && value.execution === 'accepted' && value.result_recorded === false
    && value.run.started_sequence === null && value.run.finished === null && value.run.result === null
    && value.run.interrupted === null && value.entries.length === 0;
  const commandExact = (command, expected) => command !== undefined && expected !== undefined
    && Object.isFrozen(command) && Object.isFrozen(command.body) && command.kind === 'task'
    && command.id === expected.operation && command.session_id === session
    && command.body.operation_id === expected.operation && command.body.run_id === expected.run && command.body.text === expected.text
    && Object.keys(command.body).sort().join(',') === 'operation_id,run_id,text';
  const outcomeExact = outcome => outcome?.kind === 'task' && outcome.id === commands[0]?.id && outcome.session_id === session
    && receiptExact(outcome.receipt) && receiptExact(outcome.reply?.receipt) && outcome.reply?.api_version === 1
    && outcome.reply.duplicate === false && outcome.reply.warning_code === 'storage.connection_cleanup_failed'
    && outcome.reply.notices.length === 0 && outcome.notices.length === 0 && outcome.canonical_read_error === null
    && actualReplies[0] !== undefined && JSON.stringify(outcome.reply) === JSON.stringify(actualReplies[0]);

  // Snapshots are copies. Observe their contents without replacing the application's command or state.
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (value?.kind === 'task' && value.session_id === session && value.body && !commands.some(command => command.id === value.id)) {
      if (commands.length === 2) failures.add('memory:limit');
      else commands.push(frozen);
    }
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending)
      && Array.isArray(value.recoveries) && Object.hasOwn(value, 'last_mutation') && Object.hasOwn(value, 'draft')) {
      if (commands.length === 0) priorMutation = value.last_mutation;
      if (commands.length !== 0 && value.connection === 'connected') {
        const items = [...value.pending, ...value.recoveries];
        const first = items.find(item => item.command.id === commands[0].id);
        const runs = value.selected?.display ?? [];
        if (first?.phase === 'sending' && value.draft === commands[0].body.text) sendingDraft = true;
        truthful &&= items.every(item => item.command.id === commands[0].id
          ? ['sending', 'accepted'].includes(item.phase)
          : item.command.id === commands[1]?.id && ['sending', 'rejected'].includes(item.phase))
          && runs.every(runExact);
        if (latest?.draft === commands[0].body.text && value.draft === '') {
          clearCount = Math.min(clearCount + 1, 2);
          clearAccepted = runs.some(runExact) || (first?.phase === 'accepted' && receiptExact(first.receipt));
          if (!clearAccepted || clearCount !== 1) failures.add('memory:clear');
        }
        if (value.last_mutation?.id === commands[0].id && latest?.last_mutation?.id !== commands[0].id) {
          finalized = Math.min(finalized + 1, 2);
          firstOutcome ??= value.last_mutation;
        }
        if (firstOutcome !== undefined && JSON.stringify(value.last_mutation) !== JSON.stringify(firstOutcome)) failures.add('memory:outcome');
      }
      latest = frozen;
      if (session !== undefined && value.connection === 'disconnected') {
        commands.length = 0; requestBytes.length = 0; actualReplies.length = 0;
        session = undefined; priorMutation = undefined; firstOutcome = undefined;
        Object.freeze = nativeFreeze;
      }
    }
    return frozen;
  };
  globalThis.incompleteHistoryCapture = {
    select(sid) { session = sid; },
    summary() { return { count, replies: replies.map(reply => ({ ...reply })), failures: [...failures] }; },
    accepted(expected) {
      return {
        commandExact: commands.length === 1 && commandExact(commands[0], expected),
        bytesExact: commands[0] !== undefined && requestBytes[0] === JSON.stringify(commands[0].body),
        distinctIds: priorMutation?.kind === 'create' && new Set([priorMutation.id, session, expected.operation, expected.run]).size === 4,
        clearedOnce: sendingDraft && clearCount === 1 && clearAccepted && latest?.draft === '',
        finalizedOnce: finalized === 1 && firstOutcome !== undefined,
        canonicalOnly: truthful && latest?.selected?.display.length === 1 && runExact(latest.selected.display[0]),
        noPending: latest?.pending.length === 0 && latest.recoveries.length === 0 && latest.selected?.cancel === null,
        headExact: latest?.selected?.session_id === session && latest.selected.applied_cursor === `${session}:3`,
        lastMutationExact: outcomeExact(latest?.last_mutation),
      };
    },
    rejected({ first, second, draft }) {
      const item = latest?.pending[0];
      const reply = actualReplies[1];
      // The client keeps validated safe fields, not the wire-only api_version, in its HTTP error snapshot.
      const expectedError = reply === undefined ? null : {
        code: reply.code, stage: reply.stage, certainty: reply.certainty, acceptance: reply.acceptance, notices: reply.notices,
      };
      return {
        commandsExact: commands.length === 2 && commandExact(commands[0], first) && commandExact(commands[1], second)
          && commandExact(item?.command, second),
        bytesExact: commands.length === 2 && commands.every((command, index) => requestBytes[index] === JSON.stringify(command.body)),
        distinctIds: priorMutation?.kind === 'create'
          && new Set([priorMutation.id, session, first.operation, first.run, second.operation, second.run]).size === 6,
        rejectedOnly: truthful && latest?.pending.length === 1 && item.phase === 'rejected' && latest.recoveries.length === 0,
        errorExact: item?.error?.category === 'http' && item.error.status === 422 && reply !== undefined
          && JSON.stringify(item.error.server) === JSON.stringify(expectedError) && item.notices.length === 0,
        noAcceptance: item?.receipt === null && item.reply === null && item.canonical_seen === false && item.canonical_sequence === null,
        draftExact: latest?.draft === draft,
        firstFinalizedOnce: finalized === 1 && sendingDraft && clearCount === 1 && clearAccepted,
        lastMutationUnchanged: outcomeExact(latest?.last_mutation) && firstOutcome !== undefined
          && JSON.stringify(latest.last_mutation) === JSON.stringify(firstOutcome),
        canonicalOnly: latest?.selected?.display.length === 1 && runExact(latest.selected.display[0])
          && latest.selected.run_view === null && latest.selected.cancel === null && latest.selected.observation_error === null,
        headExact: latest?.selected?.session_id === session && latest.selected.applied_cursor === `${session}:3`,
      };
    },
    cleared() {
      return latest?.connection === 'disconnected' && latest.draft === '' && latest.pending.length === 0
        && latest.recoveries.length === 0 && latest.selected === null && latest.last_mutation === null
        && commands.length === 0 && requestBytes.length === 0 && actualReplies.length === 0
        && session === undefined && priorMutation === undefined && firstOutcome === undefined && Object.freeze === nativeFreeze;
    },
    async drain() { while (reads.size !== 0) await Promise.all(reads); },
  };
  globalThis.fetch = async (...args) => {
    const request = args[0];
    const url = new URL(request instanceof Request ? request.url : request, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
    const selected = session !== undefined && url.origin === location.origin && url.search === '' && url.hash === ''
      && method === 'POST' && url.pathname === `/v1/sessions/${session}/runs`;
    if (!selected) return nativeFetch(...args);
    if (count === 2) { failures.add('task:limit'); return nativeFetch(...args); }
    const index = count++;
    const body = args[1]?.body;
    if (typeof body === 'string' && new TextEncoder().encode(body).byteLength <= 4096) requestBytes[index] = body;
    else failures.add('task:request');
    const response = await nativeFetch(...args);
    if (returned++ !== index) failures.add('task:order');
    const reply = replies[index];
    let step = 'status';
    let reader;
    let timer;
    const read = (async () => {
      const expectedStatus = index === 0 ? 202 : 422;
      reply.status = response.status === expectedStatus ? expectedStatus : 0;
      if (response.status !== expectedStatus) throw new Error();
      step = 'body';
      // Clone before any await: the application can consume its original as soon as fetch returns.
      reader = response.clone().body.getReader();
      step = 'media';
      const api = await import('/assets/api.js');
      api.requireMediaType(response.headers.get('content-type'), 'application/json');
      step = 'body';
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 2000); });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let bytes = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        step = 'size';
        if (bytes > 4096) throw new Error();
        step = 'body';
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      step = 'secret';
      if (secrets.some(secret => text.includes(secret))) throw new Error();
      step = 'json';
      const value = JSON.parse(text);
      reply.decoded = true;
      step = 'schema';
      const validated = index === 0 ? api.validateTaskAcceptedView(value) : api.validateErrorView(value);
      reply.validated = true;
      step = 'exact';
      // Exact schemas have ten and six object fields. Extra separators expose even escaped duplicate keys.
      const fields = text.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length - 1;
      if (index === 0) {
        reply.exact = fields === 10 && receiptExact(value.receipt) && value.duplicate === false
          && value.warning_code === 'storage.connection_cleanup_failed' && value.notices.length === 0;
      } else {
        reply.exact = fields === 6 && value.code === 'invalid_request' && value.stage === 'history'
          && value.certainty === 'not_applicable' && value.acceptance === null && value.notices.length === 0;
      }
      if (!reply.exact) throw new Error();
      step = 'order';
      if (index === 1 && actualReplies[0] === undefined) throw new Error();
      actualReplies[index] = validated;
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
