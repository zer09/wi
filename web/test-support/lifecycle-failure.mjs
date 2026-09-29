// Read cloned HTTP/SSE responses and immutable snapshots. Never replace joined replies.
export function installLifecycleFailureObserver({fixture,owner}) {
  const nativeFetch=globalThis.fetch; const nativeFreeze=Object.freeze;
  const failures=new Set(); const reads=new Set(); const readers=new Set();
  let selected; let connection; let session; let command; let receipt; let runView; let readCursor;
  let events=[]; let state; let stateModule; let settled; let settledDisplay;
  let started=false; let closed=false; let cleared=false; let generation=0;
  let taskPosts=0; let receiptCount=0; let history=0; let streams=0; let sseEvents=0; let runReads=0; let verified=0;
  const fail=kind => failures.add(kind);
  const plain=value => JSON.parse(JSON.stringify(value,(_,v) => v instanceof Map ? [...v] : v));
  function canonical(value) {
    if(Array.isArray(value))return `[${value.map(canonical)}]`;
    if(value && typeof value === 'object')return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)}}`;
    return JSON.stringify(value);
  }
  const same=(a,b) => canonical(a) === canonical(b);
  const secret=text => text.includes(owner) || /[0-9a-f]{64}/i.test(text) || ['synthetic-replay-','synthetic-account-','private-operator-',
    'private-project-','private-skill-','private-native','private-data','private-skills','principal_digest','history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'].some(s => text.includes(s));
  Object.freeze=value => {
    const frozen=nativeFreeze(value);
    if(value && typeof value.connection === 'string' && Array.isArray(value.pending) && Array.isArray(value.recoveries)
      && Object.hasOwn(value,'last_mutation') && Object.hasOwn(value,'draft')) {
      connection=value.connection;
      if(value.selected !== null) {selected=value.selected;started=true;}
      else if(started && connection === 'disconnected') {
        cleared=value.draft === '' && value.pending.length === 0 && value.recoveries.length === 0 && value.last_mutation === null;
        closed=true;selected=undefined;command=undefined;receipt=undefined;runView=undefined;session=undefined;state=undefined;
        settled=undefined;settledDisplay=undefined;events=[];owner=undefined;fixture=undefined;
        for(const reader of readers) void reader.cancel().catch(() => {});
        Object.freeze=nativeFreeze;globalThis.fetch=nativeFetch;
      }
    }
    return frozen;
  };
  function verify(checkpoint,audit) {
    try {
      let head=19;
      if(checkpoint === 1)head=13;
      else if(checkpoint === 2)head=16;
      if(closed || failures.size || taskPosts !== 1 || receiptCount !== 1 || connection !== 'connected'
        || selected?.observation !== 'streaming' || selected.observation_error !== null || selected.closed_reason !== null
        || selected.session_id !== session || selected.applied_cursor !== `${session}:${head}` || events.length !== head
        || selected.display.length !== 1 || !same(selected.display,plain(stateModule.selectDisplay(state)))
        || events.some((e,i) => e.kind !== fixture.kinds[i] || e.sequence !== String(i+1) || e.session_id !== session
          || e.run_id !== (i === 0 ? null : command.run_id)) || new Set(events.map(e => e.event_id)).size !== head) return false;
      if(receipt.operation_id !== command.operation_id || receipt.run_id !== command.run_id || receipt.session_id !== session
        || receipt.first_sequence !== '2' || receipt.last_sequence !== '3' || events[1].data.user_text !== fixture.task) return false;
      const display=selected.display[0]; const run=display.run;
      if(display.execution !== (checkpoint < 3 ? 'running' : 'failed') || display.result_recorded || run.result !== null || run.interrupted !== null
        || run.run_id !== command.run_id || run.accepted_sequence !== '2' || display.user_text !== fixture.task) return false;
      const response=events[7].data; const call=response.items[0]?.function_call;
      if(response.response_id !== fixture.first_response || response.outcome.status !== 'completed' || response.output_provenance !== 'native_terminal'
        || response.items.length !== 1 || response.text !== '' || !same(call,{call_id:fixture.call_id,name:'add_numbers',arguments:fixture.arguments,origin:'direct',namespace:null,complete:true})) return false;
      const request=events[8].data.request_id;
      if(typeof request !== 'string' || events[9].data.request_id !== request || events[10].data.request_id !== request
        || events[8].data.tool_name !== 'add_numbers' || events[10].data.tool_name !== 'add_numbers'
        || [8,9,10].some(i => events[i].data.call_id !== fixture.call_id) || events[9].data.output !== fixture.output
        || events[9].data.is_error !== false || events[10].data.is_error !== false) return false;
      const turns=run.turns.map(([,t]) => t);
      if(turns.length !== 2 || events[5].data.number !== '1' || events[12].data.number !== '2'
        || events[5].data.turn_id === events[12].data.turn_id || !same(events[11].data,{turn_id:events[5].data.turn_id,number:'1',
          response_id:fixture.first_response,outcome:{type:'tools_prepared'},upstream_outcome:'terminal_received'})) return false;
      const responses=display.entries.filter(e => e.kind === 'response'); const tools=display.entries.filter(e => e.kind === 'tool');
      if(responses.length !== (checkpoint === 1 ? 1 : 2) || !same(responses[0].response.authoritative,response)
        || responses[0].response.failure !== null || responses[0].response.closed_sequence !== null
        || tools.length !== 1 || tools[0].sections.length !== 1 || tools[0].sections[0].text !== fixture.output
        || tools[0].sections[0].is_error !== false || tools[0].tool.reuses.length !== 0) return false;
      if(checkpoint >= 2) {
        if(!same(events[13].data,{response_id:fixture.second_response}) || !same(events[14].data,{response_id:fixture.second_response,output_index:'0',
          item:{item_id:fixture.item_id,kind:'message',function_call:null,content:[],unsupported_content:false}})
          || !same(events[15].data,{response_id:fixture.second_response,item_id:fixture.item_id,output_index:'0',content_index:'0',summary_index:null,kind:'text',delta:fixture.partial})) return false;
        const second=responses[1];
        if(second.response.authoritative !== null || second.response.closed_sequence !== null || second.sections.length !== 1
          || second.sections[0].text !== fixture.partial || second.sections[0].provisional !== true) return false;
        if(checkpoint === 2 && second.response.failure !== null) return false;
      }
      if(checkpoint >= 3) {
        const failure={code:'unexpected_end',upstream_outcome:'unknown'};const outcome={type:'failed',code:'provider_request_failed'};
        const summary={turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',new_tool_dispatches:'1',
          tool_results_prepared:'1',reused_results:'0',last_request_id:events[18].data.summary.last_request_id,last_upstream_outcome:'unknown'};
        if(typeof summary.last_request_id !== 'string' || summary.last_request_id === request || !same(events[16].data,failure)
          || !same(events[17].data,{turn_id:events[12].data.turn_id,number:'2',response_id:fixture.second_response,outcome:{type:'stopped',reason:outcome},upstream_outcome:'unknown'})
          || !same(events[18].data,{outcome,summary}) || !same(responses[1].response.failure,{sequence:'17',data:failure})) return false;
        if(!audit || audit.exact !== true || audit.prior_unchanged !== true || audit.retired !== true || audit.hits !== 1 || audit.sequence_count !== '19'
          || audit.session_id !== session || audit.run_id !== command.run_id || audit.operation_id !== command.operation_id
          || typeof audit.final_operation_id !== 'string' || audit.final_operation_id === command.operation_id
          || audit.connections !== 1 || audit.requests !== 2 || audit.dispatches !== 1 || audit.result_rows !== 1 || audit.prepared_results !== 1 || audit.reused !== 0) return false;
        if(settled === undefined) {settled=canonical(events);settledDisplay=canonical(selected.display);}
        else if(settled !== canonical(events) || settledDisplay !== canonical(selected.display)) return false;
        if(checkpoint === 4 && (history !== 2 || streams !== 2)) return false;
      }
      if(runView === undefined || !same(selected.run_view,runView) || selected.applied_cursor !== readCursor || runView.run_id !== command.run_id
        || runView.user_text !== fixture.task || runView.accepted_sequence !== '2' || runView.state !== display.execution
        || runView.terminal_sequence !== (checkpoint < 3 ? null : '19') || runView.result_recorded !== false
        || runView.result_sequence !== null || runView.result !== null) return false;
      verified=Math.max(verified,checkpoint);return true;
    } catch {return false;}
  }
  globalThis.lifecycleCapture={
    verify,
    ready:head => !closed && selected?.applied_cursor === `${session}:${head}` && events.length === head && selected.observation === 'streaming',
    identity:() => !closed && receiptCount === 1 ? {session_id:session,run_id:command.run_id,operation_id:command.operation_id} : null,
    summary:() => ({taskPosts,receipts:receiptCount,history,streams,sseEvents,runReads,verified,failures:[...failures]}),
    cleared:() => closed && cleared && readers.size === 0 && Object.freeze === nativeFreeze && globalThis.fetch === nativeFetch,
    async drain() {while(reads.size) await Promise.all(reads);},
  };
  function apply(e) {
    if(events.length >= 19 || e.session_id !== session || e.sequence !== String(events.length+1)) throw new Error();
    state=stateModule.applyEvent(state,e);events.push(e);
  }
  globalThis.fetch=async (...args) => {
    const url=new URL(args[0] instanceof Request ? args[0].url : args[0],location.href);const init=args[1];const method=init?.method ?? 'GET';
    if(url.pathname.startsWith('/v1/') && (url.origin !== location.origin || init?.mode !== 'same-origin' || init?.credentials !== 'omit'
      || init?.cache !== 'no-store' || init?.redirect !== 'error' || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`)) fail('request:options');
    let kind;
    if(url.pathname.endsWith('/history')) {
      kind='history';history++;generation++;session=url.pathname.split('/')[3];
      if(history > 2 || url.searchParams.get('after') !== `${session}:0`) fail('request:history');
      runView=undefined;
    } else if(url.pathname.endsWith('/events')) {
      kind='sse';streams++;
      if(streams !== history || url.searchParams.get('after') !== `${session}:${history === 1 ? 1 : 19}`) fail('request:stream');
    } else if(url.pathname.endsWith('/runs') && method === 'POST') {
      kind='task';taskPosts++;
      try {command=JSON.parse(init.body);if(taskPosts !== 1 || Object.keys(command).sort().join(',') !== 'operation_id,run_id,text' || command.text !== fixture.task) throw new Error();}
      catch {fail('request:task');}
    } else if(/\/runs\/[^/]+$/.test(url.pathname) && method === 'GET') {kind='run';runReads++;readCursor=selected?.applied_cursor;}
    else if(method === 'POST' && url.pathname !== '/v1/sessions') fail('request:mutation');
    const epoch=generation;const response=await nativeFetch(...args);
    if(kind === undefined) return response;
    const reader=response.clone().body.getReader();readers.add(reader);let aborted=false;let timer;
    const abort=() => {aborted=true;void reader.cancel().catch(() => {});};init?.signal?.addEventListener('abort',abort,{once:true});
    const deadline=new Promise((_,reject) => {timer=setTimeout(() => reject(new Error()),kind === 'sse' ? 60_000 : 5000);});
    const capture=(async () => {
      if(response.status !== (kind === 'task' ? 202 : 200)) throw new Error();
      const api=await Promise.race([import('/assets/api.js'),deadline]);
      stateModule=await Promise.race([import('/assets/state.js'),deadline]);
      api.requireMediaType(response.headers.get('content-type'),kind === 'sse' ? 'text/event-stream' : 'application/json');
      const parser=kind === 'sse' ? new (await import('/assets/sse.js')).WiSseParser(session,record => {
        if(closed || aborted || epoch !== generation) return;
        if(record.kind !== 'event') throw new Error();apply(record.event);sseEvents++;
      }) : null;
      let bytes=0;let text='';let scan='';const decoder=new TextDecoder('utf-8',{fatal:true});
      while(!closed && !aborted) {
        const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done) break;
        bytes+=chunk.value.byteLength;if(bytes > 256*1024) throw new Error();
        const part=decoder.decode(chunk.value,{stream:true});scan+=part;if(secret(scan)) {fail('reply:private');throw new Error();}scan=scan.slice(-128);
        if(parser) parser.push(chunk.value);else text+=part;
      }
      if(closed || aborted || epoch !== generation) return;
      decoder.decode();if(parser) {parser.finish();fail('sse:eof');return;}
      if(kind === 'history') {
        const page=api.validateHistoryView(JSON.parse(text));const head=history === 1 ? '1' : '19';
        if(page.session_id !== session || page.through_sequence !== head || page.has_more || page.events.length !== Number(head)) throw new Error();
        if(history === 2 && canonical(page.events) !== settled) throw new Error();
        events=[];state=stateModule.createConversation(session);for(const e of page.events) apply(e);
      } else if(kind === 'task') {
        const reply=api.validateTaskAcceptedView(JSON.parse(text));if(reply.duplicate || reply.warning_code !== null || reply.notices.length) throw new Error();
        receipt=reply.receipt;receiptCount++;
      } else runView=api.validateRunView(JSON.parse(text));
    })().catch(() => {if(!closed && !aborted) fail(`${kind}:read`);}).finally(() => {
      clearTimeout(timer);init?.signal?.removeEventListener('abort',abort);readers.delete(reader);void reader.cancel().catch(() => {});reads.delete(capture);
    });
    reads.add(capture);return response;
  };
}
