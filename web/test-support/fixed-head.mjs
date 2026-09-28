// Installed before app modules. Retain only bounded counters, cursor transitions and truth flags.
export function installFixedHeadObserver({ session, initialTitle, renamedTitle, task, answer, argumentsText, output, owner }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const reads = new Set();
  const readers = new Set();
  const failures = new Set();
  const pageCounts = [];
  const pageEnds = [];
  const applied = [];
  const delivered = [];
  let epoch = 0;
  let closed = false;
  let started = false;
  let pageRequests = 0;
  let streams = 0;
  let cursor = '0';
  let deliveredCursor = '66';
  let noEarly = true;
  let reduced = true;
  let checkpoint = false;
  let taskReceipt = false;
  let renameReceipt = false;
  let cleared = false;
  const posts = { rename: 0, task: 0 };
  const secret = text => /[0-9a-f]{64}/i.test(text) || ['synthetic-replay-','synthetic-account-','private-operator-',
    'private-project-','private-skill-','private-native','private-data','private-skills','principal_digest','history_digest',
    'encrypted_content','opaque_response','provider_session_id','prepared_request'].some(marker => text.includes(marker));
  const fail = category => { failures.add(category); };
  const sequence = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,2})$/.test(value) && BigInt(value) <= 128n;
  function reducedState(selected, next) {
    const n = BigInt(next);
    if (selected.observation_error !== null || selected.through_sequence !== '66' || selected.title !== (n <= 66n ? initialTitle : renamedTitle)) return false;
    if (n < 68n) return selected.display.length === 0;
    if (selected.display.length !== 1) return false;
    const display = selected.display[0];
    const run = display.run;
    if (display.user_text !== task || run.accepted.user_text !== task || run.accepted_sequence !== '68') return false;
    if (n === 68n || n === 69n) return run.started_sequence === null && display.entries.length === 0;
    if (run.started_sequence !== '70' || run.interrupted !== null || run.response_observations.length !== 0) return false;
    const turns = run.turns.map(([, turn]) => turn);
    if (turns.length !== Number(n >= 72n) + Number(n >= 79n)) return false;
    if (n >= 72n && (turns[0].started.sequence !== '72' || (turns[0].finished?.sequence ?? null) !== (n >= 78n ? '78' : null))) return false;
    if (n >= 79n && (turns[1].started.sequence !== '79' || (turns[1].finished?.sequence ?? null) !== (n >= 84n ? '84' : null))) return false;
    const responses = display.entries.filter(e => e.kind === 'response');
    if (responses.length !== Number(n >= 73n) + Number(n >= 80n)) return false;
    if (n >= 73n && (responses[0].response.started_sequence !== '73' || (responses[0].response.authoritative !== null) !== (n >= 74n))) return false;
    if (n >= 74n && !responses[0].sections.some(s => s.text === argumentsText)) return false;
    if (n >= 80n) {
      const response = responses[1].response;
      if (response.started_sequence !== '80' || (response.authoritative !== null) !== (n >= 83n)) return false;
      if (n === 81n && response.items.length !== 1) return false;
      if (n === 82n && !responses[1].sections.some(s => s.provisional && s.text === answer.split('\r')[0])) return false;
    }
    const tools = display.entries.filter(e => e.kind === 'tool');
    if (tools.length !== Number(n >= 75n)) return false;
    if (n >= 75n && (tools[0].tool.started.sequence !== '75' || tools[0].tool.reuses.length !== 0
      || (tools[0].tool.result?.sequence ?? null) !== (n >= 76n ? '76' : null)
      || (tools[0].tool.finished?.sequence ?? null) !== (n >= 77n ? '77' : null))) return false;
    if (n >= 76n) {
      const tools = display.entries.filter(e => e.kind === 'tool');
      if (tools.length !== 1 || tools[0].tool.result?.data.output !== output || tools[0].tool.result?.data.is_error !== false) return false;
    }
    if (n >= 83n) {
      if (responses.length !== 2 || responses[1].sections.filter(s => s.text === answer).length !== 1) return false;
      if (!responses[0].sections.some(s => s.text.includes(argumentsText))) return false;
    }
    if (display.execution !== (n >= 85n ? 'completed' : 'running')
      || (run.finished?.sequence ?? null) !== (n >= 85n ? '85' : null)
      || display.result_recorded !== (n === 86n) || (run.result?.sequence ?? null) !== (n === 86n ? '86' : null)) return false;
    return true;
  }
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    try {
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending) && Array.isArray(value.recoveries)
      && Object.hasOwn(value, 'last_mutation') && Object.hasOwn(value, 'draft')) {
      if (value.selected?.session_id === session) {
        started = true;
        const selected = value.selected;
        const next = selected.applied_cursor?.slice(session.length + 1);
        if (!sequence(next) || selected.applied_cursor !== `${session}:${next}`) { fail('state:cursor'); return frozen; }
        else if (next !== cursor) {
          if (closed) fail('state:late');
          const pageNext = { '0':'32', '32':'64', '64':'66' };
          const expected = pageNext[cursor] ?? (BigInt(cursor) + 1n).toString();
          if (next !== expected || applied.length >= 128) fail('state:sequence');
          else applied.push(next);
          if (BigInt(next) > 66n && streams !== 1) { noEarly = false; fail('state:early'); }
          if (!reducedState(selected, next)) { reduced = false; fail('state:reducer'); }
          cursor = next;
        }
        if (streams === 0 && (BigInt(next ?? '0') > 66n || selected.display.length !== 0 || selected.title === renamedTitle)) {
          noEarly = false; fail('state:early');
        }
      } else if (started && value.connection === 'disconnected') {
        cleared = value.selected === null && value.draft === '' && value.pending.length === 0 && value.recoveries.length === 0 && value.last_mutation === null;
        closed = true; epoch++;
        for (const reader of readers) void reader.cancel().catch(() => {});
        Object.freeze = nativeFreeze; globalThis.fetch = nativeFetch;
        owner = undefined; session = undefined; task = undefined; answer = undefined; argumentsText = undefined;
        initialTitle = undefined; renamedTitle = undefined; output = undefined;
      }
    }
    } catch { reduced = false; fail('state:shape'); }
    return frozen;
  };
  globalThis.fixedHeadCapture = {
    summary: () => ({ pageRequests, streams, pageCounts: [...pageCounts], pageEnds: [...pageEnds], applied: [...applied], delivered: [...delivered],
      noEarly, reduced, checkpoint, taskReceipt, renameReceipt, posts: { ...posts }, failures: [...failures] }),
    cleared: () => cleared && closed && readers.size === 0 && Object.freeze === nativeFreeze && globalThis.fetch === nativeFetch,
    async drain() { while (reads.size !== 0) await Promise.all(reads); },
  };
  globalThis.fetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
    const init = args[1];
    const method = init?.method ?? 'GET';
    const authenticated = url.pathname.startsWith('/v1/');
    if (authenticated && (url.origin !== location.origin || init?.mode !== 'same-origin' || init?.credentials !== 'omit'
      || init?.cache !== 'no-store' || init?.redirect !== 'error' || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`)) fail('request:options');
    let kind;
    let pageIndex;
    const path = `/v1/sessions/${session}`;
    if (url.pathname === `${path}/history` && method === 'GET') {
      kind = 'page'; pageIndex = pageRequests; pageRequests = Math.min(4, pageRequests + 1);
      const after = ['0','32','64'][pageIndex];
      const expected = new URLSearchParams({ after: `${session}:${after}`, limit:'32' });
      if (pageIndex > 0) expected.set('through','66');
      if (pageIndex >= 3 || url.searchParams.size !== expected.size || [...expected].some(([key,value]) => url.searchParams.get(key) !== value)
        || streams !== 0 || cursor !== after) fail('page:request');
    } else if (url.pathname === `${path}/events` && method === 'GET') {
      kind = 'sse'; streams = Math.min(2, streams + 1);
      if (streams !== 1 || pageRequests !== 3 || cursor !== '66' || url.searchParams.size !== 1 || url.searchParams.get('after') !== `${session}:66`) fail('sse:attach');
    } else if (method === 'POST') {
      if (url.pathname === `${path}/rename`) { kind = 'rename'; posts.rename = Math.min(2, posts.rename + 1); }
      else if (url.pathname === `${path}/runs`) { kind = 'task'; posts.task = Math.min(2, posts.task + 1); }
      else fail('request:mutation');
      if (posts.rename > 1 || posts.task > 1 || streams !== 1) fail('request:mutation');
    }
    const generation = epoch;
    const response = await nativeFetch(...args);
    if (kind === undefined || (kind === 'page' && pageIndex >= 3) || (kind === 'sse' && streams > 1)
      || (kind === 'task' && posts.task > 1) || (kind === 'rename' && posts.rename > 1)) return response;
    if (closed || generation !== epoch) { fail('reply:late'); return response; }
    const reader = response.clone().body.getReader(); readers.add(reader);
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), kind === 'sse' ? 60_000 : 5000); });
    const capture = (async () => {
      if (response.status !== (kind === 'task' ? 202 : 200)) throw new Error();
      const api = await Promise.race([import('/assets/api.js'), deadline]);
      api.requireMediaType(response.headers.get('content-type'), kind === 'sse' ? 'text/event-stream' : 'application/json');
      let bytes = 0;
      let text = '';
      let scan = '';
      const decoder = new TextDecoder('utf-8', { fatal:true });
      const parser = kind === 'sse' ? new (await import('/assets/sse.js')).WiSseParser(session, record => {
        if (record.kind !== 'event') { if (!closed) fail('sse:control'); return; }
        const e = record.event;
        if (closed || generation !== epoch) { fail('reply:late'); return; }
        if (!sequence(e.sequence) || e.sequence !== (BigInt(deliveredCursor) + 1n).toString() || delivered.length >= 128) { fail('sse:sequence'); return; }
        deliveredCursor = e.sequence; delivered.push(e.sequence);
        if (e.sequence === '69') {
          checkpoint = e.kind === 'checkpoint' && Object.keys(e.data).length === 0;
          if (!checkpoint) fail('sse:checkpoint');
        }
      }) : null;
      while (!closed) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > (kind === 'sse' ? 256 * 1024 : 64 * 1024)) throw new Error();
        const part = decoder.decode(chunk.value, { stream:true });
        scan += part;
        if (secret(scan)) { fail('reply:private'); throw new Error(); }
        scan = scan.slice(-128);
        if (parser) parser.push(chunk.value); else text += part;
      }
      decoder.decode();
      if (closed || generation !== epoch) { if (kind !== 'sse') fail('reply:late'); return; }
      if (parser) { parser.finish(); fail('sse:eof'); return; }
      const value = JSON.parse(text);
      if (kind === 'page') {
        const page = api.validateHistoryView(value);
        const before = ['0','32','64'][pageIndex];
        const end = ['32','64','66'][pageIndex];
        const count = ['32','32','2'][pageIndex];
        if (pageIndex !== pageCounts.length || page.session_id !== session || page.through_sequence !== '66' || page.next_after !== `${session}:${end}`
          || page.has_more !== (pageIndex < 2) || String(page.events.length) !== count) fail('page:metadata');
        let last = BigInt(before);
        for (const event of page.events) {
          if (BigInt(event.sequence) !== ++last || last > 66n || event.run_id !== null
            || event.kind !== (last === 1n ? 'session.created' : 'session.renamed')
            || event.data.title !== `Fixed head ${last - 1n}`) fail('page:sequence');
        }
        if (last.toString() !== end) fail('page:sequence');
        if (pageCounts.length < 3) { pageCounts.push(String(page.events.length)); pageEnds.push(end); }
      } else {
        const reply = kind === 'task' ? api.validateTaskAcceptedView(value) : api.validateRenameView(value);
        const receipt = reply.receipt;
        const exact = receipt.session_id === session && receipt.first_sequence === (kind === 'task' ? '68' : '67')
          && receipt.last_sequence === (kind === 'task' ? '69' : '67') && reply.duplicate === false && reply.warning_code === null
          && (kind === 'task' ? receipt.run_id !== null && reply.notices.length === 0 : receipt.run_id === null && reply.catalog_refresh === 'updated');
        if (!exact) fail('reply:receipt');
        if (kind === 'task') taskReceipt = exact; else renameReceipt = exact;
      }
    })().catch(() => { if (!closed) fail(`${kind}:read`); }).finally(() => {
      clearTimeout(timer); readers.delete(reader); void reader.cancel().catch(() => {}); reads.delete(capture);
    });
    reads.add(capture);
    return response;
  };
}
