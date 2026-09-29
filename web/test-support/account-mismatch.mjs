// Only closed booleans, bounded counters and static failures leave this in-page observer.
export function installAccountMismatchObserver() {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const reads = new Set();
  const failures = new Set();
  const replies = Array.from({ length: 2 }, () => ({ status: null, decoded: false, validated: false, exact: false }));
  const commands = [];
  const bytes = [];
  const actual = [];
  const cleared = [0, 0];
  const finalized = [0, 0];
  let latest;
  let session;
  let firstHead;
  let firstRun;
  let create;
  let count = 0;
  let returned = 0;
  let live = true;
  const serialize = value => JSON.stringify(value, (_key, item) => item instanceof Map ? [...item] : item);
  const receiptExact = (receipt, index) => commands[index] !== undefined && receipt?.operation_id === commands[index].id
    && receipt.session_id === session && receipt.run_id === commands[index].body.run_id
    && receipt.first_sequence === String(index === 0 ? 2n : BigInt(firstHead ?? '0') + 1n)
    && receipt.last_sequence === String(index === 0 ? 3n : BigInt(firstHead ?? '0') + 2n);
  const commandExact = (command, expected) => command !== undefined && Object.isFrozen(command) && Object.isFrozen(command.body)
    && command.kind === 'task' && command.session_id === session && command.id === expected.operation
    && command.body.operation_id === expected.operation && command.body.run_id === expected.run && command.body.text === expected.text
    && Object.keys(command.body).sort().join(',') === 'operation_id,run_id,text';
  const accepted = (run, index) => commands[index] !== undefined && run?.run.run_id === commands[index].body.run_id
    && run.user_text === commands[index].body.text && run.run.accepted.user_text === commands[index].body.text
    && run.run.accepted_sequence === String(index === 0 ? 2n : BigInt(firstHead ?? '0') + 1n);
  const outcomeExact = index => latest?.last_mutation?.kind === 'task' && latest.last_mutation.id === commands[index]?.id
    && receiptExact(latest.last_mutation.receipt, index) && latest.last_mutation.session_id === session
    && actual[index] !== undefined && serialize(latest.last_mutation.reply) === serialize(actual[index])
    && latest.last_mutation.notices.length === 0 && latest.last_mutation.canonical_read_error === null;
  const summaryZero = summary => summary && Object.keys(summary).sort().join(',') ===
    'last_request_id,last_upstream_outcome,model_requests_admitted,model_requests_attempted,new_tool_dispatches,reused_results,tool_results_prepared,turns_finished,turns_started'
    && Object.entries(summary).every(([key, value]) => key.startsWith('last_') ? value === null : value === '0');
  const failed = outcome => outcome?.type === 'failed' && outcome.code === 'history_identity' && Object.keys(outcome).length === 2;
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (live && value?.kind === 'task' && value.session_id === session && value.body) {
      const prior = commands.find(command => command.id === value.id);
      if (prior !== undefined && serialize(prior) !== serialize(value)) failures.add('memory:command');
      if (prior === undefined) {
        if (commands.length === 2) failures.add('memory:limit');
        else commands.push(frozen);
      }
    }
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending)
      && Array.isArray(value.recoveries) && Object.hasOwn(value, 'last_mutation') && Object.hasOwn(value, 'draft')) {
      if (commands.length === 0 && value.last_mutation?.kind === 'create') create = value.last_mutation.id;
      if (value.connection === 'connected') {
        const runs = value.selected?.display ?? [];
        for (const [index, command] of commands.entries()) {
          const pending = [...value.pending, ...value.recoveries].find(item => item.command.id === command.id);
          if (pending && !['sending', 'accepted'].includes(pending.phase)) failures.add('memory:admission');
          if (latest?.draft === command.body.text && value.draft === '') {
            cleared[index] = Math.min(2, cleared[index] + 1);
            if (cleared[index] !== 1 || !(runs.some(run => accepted(run, index)) || (pending?.phase === 'accepted' && receiptExact(pending.receipt, index)))) failures.add('memory:clear');
          }
          if (value.last_mutation?.id === command.id && latest?.last_mutation?.id !== command.id) finalized[index] = Math.min(2, finalized[index] + 1);
        }
        if (firstRun !== undefined && serialize(runs[0]) !== firstRun) failures.add('memory:history');
      }
      latest = frozen;
      if (session !== undefined && value.connection === 'disconnected') {
        live = false; session = undefined; firstHead = undefined; firstRun = undefined; create = undefined;
        commands.length = 0; bytes.length = 0; actual.length = 0;
        Object.freeze = nativeFreeze;
        globalThis.fetch = nativeFetch;
      }
    }
    return frozen;
  };
  globalThis.accountMismatchCapture = {
    select(sid) { if (session !== undefined) throw new Error('observer selection rejected'); session = sid; },
    summary() { return { count, replies: replies.map(reply => ({ ...reply })), failures: [...failures] }; },
    first(expected, head) {
      const display = latest?.selected?.display;
      const run = display?.[0];
      const valid = commands.length === 1 && commandExact(commands[0], expected) && accepted(run, 0)
        && display.length === 1 && run.execution === 'completed' && run.result_recorded === true
        && run.run.finished?.data.outcome.type === 'completed' && run.run.result?.data.outcome.type === 'completed'
        && run.run.result.sequence === head && latest.selected.applied_cursor === `${session}:${head}`;
      if (valid && firstRun === undefined) { firstHead = head; firstRun = serialize(run); }
      return { canonical: valid, command: valid && bytes[0] === JSON.stringify(commands[0].body), outcome: outcomeExact(0),
        once: cleared[0] === 1 && finalized[0] === 1, quiet: latest?.pending.length === 0 && latest.recoveries.length === 0,
        stable: firstRun !== undefined && serialize(run) === firstRun };
    },
    completed({ first, second, draft, head }) {
      const display = latest?.selected?.display;
      const run = display?.[1];
      const terminal = run?.run.finished;
      const result = run?.run.result;
      return {
        commands: commands.length === 2 && commandExact(commands[0], first) && commandExact(commands[1], second),
        bytes: commands.length === 2 && commands.every((command, index) => bytes[index] === JSON.stringify(command.body)),
        fresh: create !== undefined && new Set([create, session, first.operation, first.run, second.operation, second.run]).size === 6,
        firstStable: firstRun !== undefined && serialize(display?.[0]) === firstRun,
        canonical: display?.length === 2 && accepted(run, 1) && run.execution === 'failed' && run.result_recorded === true
          && run.entries.length === 0 && run.run.interrupted === null && run.run.response_observations.length === 0
          && failed(terminal?.data.outcome) && failed(result?.data.outcome) && result.data.events_complete === true && result.data.sink_error === null
          && summaryZero(terminal.data.summary) && summaryZero(result.data.summary)
          && run.run.started_sequence === String(BigInt(firstHead ?? '0') + 3n)
          && terminal.sequence === String(BigInt(firstHead ?? '0') + 5n) && result.sequence === head
          && head === String(BigInt(firstHead ?? '0') + 6n),
        head: latest?.selected?.applied_cursor === `${session}:${head}`,
        outcome: outcomeExact(1), once: cleared.every(value => value === 1) && finalized.every(value => value === 1),
        quiet: latest?.pending.length === 0 && latest.recoveries.length === 0 && latest.selected?.cancel === null
          && latest.selected.run_view === null && latest.selected.observation_error === null,
        draft: latest?.draft === draft,
      };
    },
    cleared() { return !live && latest?.connection === 'disconnected' && latest.draft === '' && latest.pending.length === 0
      && latest.recoveries.length === 0 && latest.selected === null && latest.last_mutation === null
      && commands.length === 0 && bytes.length === 0 && actual.length === 0 && session === undefined && firstRun === undefined
      && firstHead === undefined && create === undefined && Object.freeze === nativeFreeze && globalThis.fetch === nativeFetch; },
    async drain() { while (reads.size !== 0) await Promise.all(reads); },
  };
  globalThis.fetch = async (...args) => {
    const request = args[0];
    const url = new URL(request instanceof Request ? request.url : request, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
    if (!live || session === undefined || url.origin !== location.origin || url.search !== '' || url.hash !== ''
      || method !== 'POST' || url.pathname !== `/v1/sessions/${session}/runs`) return nativeFetch(...args);
    if (count === 2) { failures.add('task:limit'); return nativeFetch(...args); }
    const index = count++;
    if (typeof args[1]?.body === 'string' && new TextEncoder().encode(args[1].body).byteLength <= 4096) bytes[index] = args[1].body;
    else failures.add('task:request');
    const response = await nativeFetch(...args);
    if (returned++ !== index) failures.add('task:order');
    let step = 'status';
    let reader;
    let timer;
    const read = (async () => {
      replies[index].status = response.status === 202 ? 202 : 0;
      if (response.status !== 202) throw new Error();
      step = 'body';
      // Clone before the asynchronous import. Bound bytes and validate UTF-8 before text() decodes the clone.
      reader = response.clone().body.getReader();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 2000); });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      const boundedBody = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await Promise.race([reader.read(), deadline]);
            if (chunk.done) { decoder.decode(); controller.close(); return; }
            size += chunk.value.byteLength;
            if (size > 4096) { step = 'size'; throw new Error(); }
            decoder.decode(chunk.value, { stream: true });
            controller.enqueue(chunk.value);
          } catch { controller.error(new Error('observer body rejected')); }
        },
        cancel() { void reader.cancel().catch(() => {}); },
      });
      const text = await new Response(boundedBody).text();
      if (!live) return;
      step = 'media';
      const api = await Promise.race([import('/assets/api.js'), deadline]);
      api.requireMediaType(response.headers.get('content-type'), 'application/json');
      step = 'json';
      const value = JSON.parse(text);
      replies[index].decoded = true;
      step = 'schema';
      const validated = api.validateTaskAcceptedView(value);
      replies[index].validated = true;
      step = 'exact';
      replies[index].exact = text.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 11
        && receiptExact(value.receipt, index) && value.duplicate === false && value.warning_code === null && value.notices.length === 0;
      if (!replies[index].exact) throw new Error();
      step = 'order';
      if (index === 1 && (actual[0] === undefined || firstHead === undefined)) throw new Error();
      actual[index] = validated;
    })().catch(() => { failures.add(`task:${step}`); }).finally(() => {
      clearTimeout(timer);
      void reader?.cancel().catch(() => {});
      reads.delete(read);
    });
    reads.add(read);
    return response;
  };
}
