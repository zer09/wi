// Observe original responses and immutable client snapshots without replacing either.
export function installToolFidelityObserver({ fixture, owner }) {
  const nativeFetch = globalThis.fetch;
  const nativeFreeze = Object.freeze;
  const failures = new Set(); const reads = new Set(); const readers = new Set();
  const commands = []; const receipts = []; const events = [];
  let selected; let session; let closed = false; let cleared = false; let started = false;
  let history = 0; let streams = 0; let sseEvents = 0; let verified = 0; let firstDisplay;
  const fail = category => { failures.add(category); };
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const secret = text => text.includes(owner) || /[0-9a-f]{64}/i.test(text) || ['synthetic-replay-','synthetic-account-',
    'private-operator-','private-project-','private-skill-','private-native','private-data','private-skills','principal_digest',
    'history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'].some(v => text.includes(v));
  Object.freeze = value => {
    const frozen = nativeFreeze(value);
    if (value && typeof value.connection === 'string' && Array.isArray(value.pending) && Array.isArray(value.recoveries)
      && Object.hasOwn(value,'last_mutation') && Object.hasOwn(value,'draft')) {
      if (value.selected !== null) { selected = value.selected; started = true; }
      else if (started && value.connection === 'disconnected') {
        cleared = value.draft === '' && value.pending.length === 0 && value.recoveries.length === 0 && value.last_mutation === null;
        closed = true; selected = undefined; session = undefined; firstDisplay = undefined;
        commands.length = 0; receipts.length = 0; events.length = 0;
        owner = undefined; fixture = undefined;
        for (const reader of readers) void reader.cancel().catch(() => {});
        Object.freeze = nativeFreeze; globalThis.fetch = nativeFetch;
      }
    }
    return frozen;
  };
  function verify(audit) {
    try {
      if (closed || failures.size || selected?.observation_error !== null || audit.exact !== true || audit.prior_unchanged !== true
        || audit.session_id !== session || selected.session_id !== session || selected.applied_cursor !== `${session}:${audit.sequence_count}`
        || events.at(-1)?.sequence !== audit.sequence_count || selected.display.length !== audit.completed
        || commands.length !== audit.completed || receipts.filter(Boolean).length !== audit.completed) return false;
      for (let task=0; task<audit.completed; task++) {
        const command = commands[task]; const receipt = receipts[task]; const display = selected.display[task]; const run = display.run;
        const records = events.filter(e => e.run_id === command.run_id);
        const ofKind = kind => records.filter(e => e.kind === kind);
        const first = task === 0; const dispatches = first ? 2 : 1; const reused = first ? 1 : 0; const turns = first ? 3 : 2;
        if (receipt.run_id !== command.run_id || receipt.operation_id !== command.operation_id || receipt.session_id !== session
          || run.run_id !== command.run_id || run.accepted_sequence !== receipt.first_sequence || records[0]?.kind !== 'run.accepted'
          || records[0].sequence !== receipt.first_sequence || records[0].data.user_text !== fixture.tasks[task]
          || BigInt(receipt.last_sequence) !== BigInt(receipt.first_sequence)+1n || records[1]?.kind !== 'checkpoint'
          || display.user_text !== fixture.tasks[task] || display.execution !== 'completed' || !display.result_recorded) return false;
        if (task === audit.completed-1 && (audit.run_id !== command.run_id || audit.operation_id !== command.operation_id
          || audit.requests !== turns || audit.new_dispatches !== dispatches || audit.reused !== reused
          || audit.result_rows !== dispatches || audit.prepared_results !== dispatches+reused || audit.executions !== 1)) return false;
        for (const [kind,count] of [['tool.started',dispatches],['tool.result',dispatches],['tool.finished',dispatches],['tool.reused',reused],
          ['response.finished',turns],['run.finished',1],['run.result',1]]) if (ofKind(kind).length !== count) return false;
        const responses = ofKind('response.finished');
        const intentions = responses.flatMap(e => e.data.items.map(item => ({ event:e, call:item.function_call })).filter(i => i.call !== null));
        const expected = first ? [[fixture.shared_call,'add_numbers',fixture.arguments[0]], [fixture.fixture_call,fixture.name,fixture.fixture_arguments],
          [fixture.shared_call,'add_numbers',fixture.arguments[1]]] : [[fixture.shared_call,'add_numbers',fixture.arguments[2]]];
        if (intentions.length !== expected.length || intentions.some(({call},index) => !same([call.call_id,call.name,call.arguments],expected[index]) || !call.complete)) return false;
        const renderedResponses = display.entries.filter(e => e.kind === 'response');
        if (renderedResponses.length !== turns || renderedResponses.some((e,index) => !same(e.response.authoritative,responses[index].data))
          || expected.some(([, ,args]) => renderedResponses.flatMap(e => e.sections).filter(s => s.text === args).length !== 1)) return false;
        if (renderedResponses.flatMap(e => e.sections).filter(s => s.text === fixture.answers[task]).length !== 1) return false;
        const toolEntries = display.entries.filter(e => e.kind === 'tool');
        if (run.tools.length !== dispatches || toolEntries.length !== dispatches) return false;
        for (let slot=0;slot<dispatches;slot++) {
          const [call,name] = expected[slot]; const output = slot === 0 ? fixture.sums[task] : fixture.fixture_output;
          const find = kind => ofKind(kind).find(e => e.data.call_id === call);
          const start = find('tool.started'); const result = find('tool.result'); const finish = find('tool.finished');
          if (!start || !result || !finish || start.data.tool_name !== name || finish.data.tool_name !== name
            || typeof start.data.request_id !== 'string' || start.data.request_id !== result.data.request_id || start.data.request_id !== finish.data.request_id
            || result.data.output !== output || result.data.is_error !== false || finish.data.is_error !== false
            || BigInt(intentions[slot].event.sequence) >= BigInt(start.sequence) || BigInt(start.sequence) >= BigInt(result.sequence)
            || BigInt(result.sequence) >= BigInt(finish.sequence)) return false;
          const tool = run.tools.find(([id]) => id === call)?.[1]; const entry = toolEntries.find(e => e.tool.call_id === call);
          if (!tool || !entry || !same(tool,entry.tool) || tool.tool_name !== name || !same(tool.started,{sequence:start.sequence,data:start.data})
            || !same(tool.result,{sequence:result.sequence,data:result.data}) || !same(tool.finished,{sequence:finish.sequence,data:finish.data})
            || entry.sections.length !== 1 || entry.sections[0].text !== output || entry.sections[0].is_error !== false) return false;
          const reuses = ofKind('tool.reused').filter(e => e.data.call_id === call);
          if (reuses.length !== (first && slot === 0 ? 1 : 0) || !same(tool.reuses,reuses.map(e => ({sequence:e.sequence,data:e.data})))) return false;
          for (const reuse of reuses) if (Object.keys(reuse.data).sort().join(',') !== 'call_id,request_id,tool_name'
            || reuse.data.tool_name !== name || typeof reuse.data.request_id !== 'string' || reuse.data.request_id === result.data.request_id
            || BigInt(reuse.sequence) <= BigInt(responses[1].sequence) || BigInt(responses[1].sequence) <= BigInt(finish.sequence)) return false;
        }
        const result = ofKind('run.result')[0]; const terminal = ofKind('run.finished')[0];
        if (!same(run.result,{sequence:result.sequence,data:result.data}) || !same(run.finished,{sequence:terminal.sequence,data:terminal.data})
          || result.data.outcome.type !== 'completed' || result.data.events_complete !== true || result.data.sink_error !== null
          || !same(result.data.summary,terminal.data.summary)) return false;
        for (const [key,count] of [['new_tool_dispatches',dispatches],['tool_results_prepared',dispatches+reused],['reused_results',reused],
          ['model_requests_attempted',turns],['model_requests_admitted',turns]]) if(result.data.summary[key] !== String(count)) return false;
      }
      if (audit.completed === 2 && (commands[0].run_id === commands[1].run_id || commands[0].operation_id === commands[1].operation_id
        || firstDisplay !== JSON.stringify(selected.display[0]))) return false;
      if (audit.completed === 1) firstDisplay = JSON.stringify(selected.display[0]);
      verified = audit.completed; return true;
    } catch { return false; }
  }
  let taskPosts = 0; let receiptCount = 0;
  globalThis.toolFidelityCapture = {
    verify,
    summary: () => ({taskPosts,receipts:receiptCount,history,streams,sseEvents,verified,failures:[...failures]}),
    cleared: () => closed && cleared && readers.size === 0 && Object.freeze === nativeFreeze && globalThis.fetch === nativeFetch,
    async drain() { while(reads.size) await Promise.all(reads); },
  };
  function apply(event) {
    if (event.session_id !== session || event.sequence !== String(events.length+1) || events.length >= 128) throw new Error();
    events.push(event);
  }
  globalThis.fetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : args[0],location.href);
    const init = args[1]; const method = init?.method ?? 'GET'; let kind; let task;
    if (url.pathname.startsWith('/v1/') && (url.origin !== location.origin || init?.mode !== 'same-origin' || init?.credentials !== 'omit'
      || init?.cache !== 'no-store' || init?.redirect !== 'error' || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`)) fail('request:options');
    if (url.pathname.endsWith('/history')) { kind='history'; history++; session = url.pathname.split('/')[3]; }
    else if (url.pathname.endsWith('/events')) { kind='sse'; streams++; if(streams !== 1) fail('request:stream'); }
    else if (url.pathname.endsWith('/runs') && method === 'POST') {
      kind='task'; task=taskPosts++;
      try {
        const command=JSON.parse(init.body);
        if (task >= 2 || Object.keys(command).sort().join(',') !== 'operation_id,run_id,text' || command.text !== fixture.tasks[task]
          || typeof command.run_id !== 'string' || typeof command.operation_id !== 'string') throw new Error();
        commands.push(command);
      } catch { fail('request:task'); }
    }
    const response = await nativeFetch(...args);
    if (kind === undefined) return response;
    if (closed) { fail('reply:late'); return response; }
    const reader = response.clone().body.getReader(); readers.add(reader);
    let timer;
    const deadline = new Promise((_,reject) => {timer=setTimeout(() => reject(new Error()),kind === 'sse' ? 60_000 : 5000);});
    const capture = (async () => {
      if(response.status !== (kind === 'task' ? 202 : 200)) throw new Error();
      const api = await Promise.race([import('/assets/api.js'),deadline]);
      api.requireMediaType(response.headers.get('content-type'),kind === 'sse' ? 'text/event-stream' : 'application/json');
      const parser = kind === 'sse' ? new (await import('/assets/sse.js')).WiSseParser(session,record => {
        if(closed) return;
        if(record.kind !== 'event') throw new Error(); apply(record.event); sseEvents++;
      }) : null;
      let bytes=0; let text=''; let scan=''; const decoder=new TextDecoder('utf-8',{fatal:true});
      while(!closed) {
        const chunk=await Promise.race([reader.read(),deadline]); if(chunk.done) break;
        bytes+=chunk.value.byteLength; if(bytes > 256*1024) throw new Error();
        const part=decoder.decode(chunk.value,{stream:true}); scan+=part;
        if(secret(scan)) {fail('reply:private');throw new Error();} scan=scan.slice(-128);
        if(parser) parser.push(chunk.value); else text+=part;
      }
      if(closed) return;
      decoder.decode();
      if(parser) {parser.finish();fail('sse:eof');return;}
      if(kind === 'history') {
        const page=api.validateHistoryView(JSON.parse(text));
        if(history !== 1 || page.session_id !== session || page.through_sequence !== '1' || page.has_more || page.events.length !== 1) throw new Error();
        for(const e of page.events) apply(e);
      } else {
        const reply=api.validateTaskAcceptedView(JSON.parse(text));
        if(reply.duplicate || reply.warning_code !== null || reply.notices.length !== 0) throw new Error();
        receipts[task]=reply.receipt;receiptCount++;
      }
    })().catch(() => {if(!closed) fail(`${kind}:read`);}).finally(() => {
      clearTimeout(timer);readers.delete(reader);void reader.cancel().catch(() => {});reads.delete(capture);
    });
    reads.add(capture);return response;
  };
}
