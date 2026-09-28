// Observe cloned responses and immutable client snapshots without replacing joined replies.
export function installCancellationObserver({fixture,owner}) {
  const nativeFetch=globalThis.fetch;const nativeFreeze=Object.freeze;
  const failures=new Set();const reads=new Set();const readers=new Set();
  let selected;let connection;let session;let command;let receipt;let runView;let runningView;let cancelView;let readCursor;
  let events=[];let state;let stateModule;let prefix;let settled;let settledDisplay;let terminal;
  let started=false;let closed=false;let cleared=false;let generation=0;
  let taskPosts=0;let receipts=0;let cancelPosts=0;let cancels=0;let history=0;let streams=0;let sseEvents=0;let runReads=0;let verified=0;
  const fail=kind => failures.add(kind);
  const plain=value => JSON.parse(JSON.stringify(value,(_,v) => v instanceof Map ? [...v] : v));
  function canonical(value) {
    if(Array.isArray(value))return `[${value.map(canonical)}]`;
    if(value && typeof value === 'object')return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)}}`;
    return JSON.stringify(value);
  }
  const same=(a,b) => canonical(a) === canonical(b);
  const uuid=value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    && value !== '00000000-0000-0000-0000-000000000000';
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
        closed=true;selected=undefined;command=undefined;receipt=undefined;runView=undefined;runningView=undefined;cancelView=undefined;
        session=undefined;state=undefined;prefix=undefined;settled=undefined;settledDisplay=undefined;terminal=undefined;events=[];owner=undefined;fixture=undefined;
        for(const reader of readers)void reader.cancel().catch(() => {});
        Object.freeze=nativeFreeze;globalThis.fetch=nativeFetch;
      }
    }
    return frozen;
  };
  function verify(checkpoint,audit) {
    try {
      const head=events.length;
      if(!Number.isInteger(checkpoint) || checkpoint < 1 || checkpoint > 4 || checkpoint > verified+1 || checkpoint < verified
        || closed || failures.size || taskPosts !== 1 || receipts !== 1 || connection !== 'connected'
        || selected?.observation !== 'streaming' || selected.observation_error !== null || selected.closed_reason !== null
        || selected.session_id !== session || selected.title !== fixture.title || selected.applied_cursor !== `${session}:${head}`
        || selected.display.length !== 1 || !same(selected.display,plain(stateModule.selectDisplay(state)))
        || events.some((e,i) => e.kind !== fixture.kinds[i] || e.sequence !== String(i+1) || e.session_id !== session
          || e.run_id !== (i === 0 ? null : command.run_id)) || new Set(events.map(e => e.event_id)).size !== head) return false;
      if((checkpoint === 1 && head !== 6) || (checkpoint === 2 && ![6,7].includes(head)) || (checkpoint >= 3 && head !== 9))return false;
      if(history !== (checkpoint === 4 ? 2 : 1) || streams !== history || runReads !== (checkpoint < 3 ? 1 : checkpoint-1)
        || cancelPosts !== (checkpoint === 1 ? 0 : 1) || cancels !== cancelPosts) return false;
      if(!same(receipt,{operation_id:command.operation_id,run_id:command.run_id,session_id:session,first_sequence:'2',last_sequence:'3'})
        || events[0].data.title !== fixture.title || events[1].data.user_text !== fixture.task) return false;
      const display=selected.display[0];const run=display.run;
      if(display.execution !== (checkpoint < 3 ? 'running' : 'cancelled_locally') || display.result_recorded !== (checkpoint >= 3)
        || run.interrupted !== null || run.run_id !== command.run_id || run.accepted_sequence !== '2'
        || display.user_text !== fixture.task || display.entries.length !== 0 || run.turns.length !== 1) return false;
      const running={api_version:1,run_id:command.run_id,state:'running',user_text:fixture.task,accepted_sequence:'2',
        terminal_sequence:null,result_sequence:null,result_recorded:false,result:null};
      if(checkpoint < 3 && (!same(runView,running) || !same(selected.run_view,running) || run.finished !== null || run.result !== null))return false;
      if(checkpoint === 1 && (selected.cancel !== null || selected.cancelling || readCursor !== `${session}:6`))return false;
      if(checkpoint >= 2) {
        const cancel={api_version:1,session_id:session,run_id:command.run_id,disposition:'requested'};
        if(!same(cancelView,cancel) || !same(selected.cancel,checkpoint === 4 ? null : cancel) || selected.cancelling
          || !same(runningView,running) || prefix !== canonical(events.slice(0,6)))return false;
      }
      const outcome={type:'cancelled_locally'};
      if(head >= 7 && !same(events[6].data,{turn_id:events[5].data.turn_id,number:'1',response_id:null,
        outcome:{type:'stopped',reason:outcome},upstream_outcome:'unknown'})) return false;
      if(checkpoint >= 3) {
        const request=events[7].data.summary.last_request_id;
        const summary={turns_started:'1',turns_finished:'1',model_requests_attempted:'1',model_requests_admitted:'1',new_tool_dispatches:'0',
          tool_results_prepared:'0',reused_results:'0',last_request_id:request,last_upstream_outcome:'unknown'};
        const result={outcome,summary,events_complete:true,sink_error:null};
        if(typeof request !== 'string' || request.length === 0 || !same(events[7].data,{outcome,summary}) || !same(events[8].data,result)
          || !same(runView,{...running,state:'cancelled_locally',terminal_sequence:'8',result_sequence:'9',result_recorded:true,result})
          || !same(selected.run_view,runView) || readCursor !== `${session}:9`)return false;
        if(checkpoint === 4 && (settled !== canonical(events) || settledDisplay !== canonical(selected.display)))return false;
      }
      if(!audit || !Number.isInteger(audit.id) || audit.id < 1 || audit.id > 0xffffffff)return false;
      let event='cancellation_paused';let count='7';
      if(checkpoint === 1){event='cancellation_pending';count='6';}
      else if(checkpoint >= 3){event='cancellation_inspect';count='9';}
      const expected={protocol:1,id:audit.id,event,session_id:session,run_id:command.run_id,operation_id:command.operation_id,
        sequence_count:count,connections:1,requests:1,closed:checkpoint !== 1,exact:true};
      if(checkpoint >= 2) {
        if(!uuid(audit.terminal_operation_id) || [session,command.run_id,command.operation_id].includes(audit.terminal_operation_id)
          || (terminal !== undefined && terminal !== audit.terminal_operation_id))return false;
        Object.assign(expected,{terminal_operation_id:audit.terminal_operation_id,hits:1});
      }
      if(checkpoint >= 3)Object.assign(expected,{retired:true,dispatches:0,prepared_results:0,reused:0,result_records:1,prefix_unchanged:true});
      if(!same(audit,expected))return false;
      if(checkpoint === 1){runningView=plain(runView);prefix=canonical(events);}
      if(checkpoint === 2)terminal=audit.terminal_operation_id;
      if(checkpoint === 3){settled=canonical(events);settledDisplay=canonical(selected.display);}
      verified=checkpoint;return true;
    } catch {return false;}
  }
  globalThis.cancellationCapture={
    verify,
    ready:head => !closed && selected?.applied_cursor === `${session}:${head}` && events.length === head && selected.observation === 'streaming',
    identity:() => !closed && receipts === 1 ? {session_id:session,run_id:command.run_id,operation_id:command.operation_id} : null,
    summary:() => ({taskPosts,receipts,cancelPosts,cancels,history,streams,sseEvents,runReads,verified,failures:[...failures]}),
    cleared:() => closed && cleared && readers.size === 0 && Object.freeze === nativeFreeze && globalThis.fetch === nativeFetch,
    async drain() {while(reads.size)await Promise.all(reads);},
  };
  function apply(e) {
    if(events.length >= 9 || e.session_id !== session || e.sequence !== String(events.length+1))throw new Error();
    state=stateModule.applyEvent(state,e);events.push(e);
  }
  globalThis.fetch=async (...args) => {
    const url=new URL(args[0] instanceof Request ? args[0].url : args[0],location.href);const init=args[1];const method=init?.method ?? 'GET';
    if(url.pathname.startsWith('/v1/') && (url.origin !== location.origin || init?.mode !== 'same-origin' || init?.credentials !== 'omit'
      || init?.cache !== 'no-store' || init?.redirect !== 'error' || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`))fail('request:options');
    let kind;
    if(url.pathname.endsWith('/history')) {
      kind='history';history++;generation++;
      if(history === 1)session=url.pathname.split('/')[3];
      if(!uuid(session) || history > 2 || (history === 2 && verified !== 3) || method !== 'GET'
        || url.pathname !== `/v1/sessions/${session}/history` || url.searchParams.get('after') !== `${session}:0`)fail('request:history');
      runView=undefined;
    } else if(url.pathname.endsWith('/events')) {
      kind='sse';streams++;
      if(method !== 'GET' || streams !== history || url.pathname !== `/v1/sessions/${session}/events`
        || url.searchParams.get('after') !== `${session}:${history === 1 ? 1 : 9}`)fail('request:stream');
    } else if(url.pathname.endsWith('/runs') && method === 'POST') {
      kind='task';taskPosts++;
      try {
        command=JSON.parse(init.body);
        if(taskPosts !== 1 || url.pathname !== `/v1/sessions/${session}/runs` || url.search !== ''
          || Object.keys(command).sort().join(',') !== 'operation_id,run_id,text' || command.text !== fixture.task
          || ![command.run_id,command.operation_id].every(uuid) || new Set([session,command.run_id,command.operation_id]).size !== 3)throw new Error();
      }catch{fail('request:task');}
    } else if(url.pathname.endsWith('/cancel')) {
      kind='cancel';cancelPosts++;
      if(verified !== 1 || cancelPosts !== 1 || method !== 'POST' || init.body !== '{}' || url.search !== ''
        || url.pathname !== `/v1/sessions/${session}/runs/${command?.run_id}/cancel`)fail('request:cancel');
    } else if(/\/runs\/[^/]+$/.test(url.pathname) && method === 'GET') {
      kind='run';runReads++;readCursor=selected?.applied_cursor;
      if(url.pathname !== `/v1/sessions/${session}/runs/${command?.run_id}` || url.search !== '' || runReads > 3
        || (runReads === 1 ? events.length !== 6 : events.length !== 9 || verified < 2))fail('request:run');
    } else if(method !== 'GET' && !(method === 'POST' && url.pathname === '/v1/sessions'))fail('request:mutation');
    const epoch=generation;const response=await nativeFetch(...args);
    if(kind === undefined)return response;
    const reader=response.clone().body.getReader();readers.add(reader);let aborted=false;let timer;
    const abort=() => {aborted=true;void reader.cancel().catch(() => {});};init?.signal?.addEventListener('abort',abort,{once:true});
    const deadline=new Promise((_,reject) => {timer=setTimeout(() => reject(new Error()),kind === 'sse' ? 60_000 : 5000);});
    const capture=(async () => {
      if(response.status !== (kind === 'task' || kind === 'cancel' ? 202 : 200))throw new Error();
      const api=await Promise.race([import('/assets/api.js'),deadline]);stateModule=await Promise.race([import('/assets/state.js'),deadline]);
      api.requireMediaType(response.headers.get('content-type'),kind === 'sse' ? 'text/event-stream' : 'application/json');
      const parser=kind === 'sse' ? new (await import('/assets/sse.js')).WiSseParser(session,record => {
        if(closed || aborted || epoch !== generation)return;
        if(record.kind !== 'event')throw new Error();apply(record.event);sseEvents++;
      }) : null;
      let bytes=0;let text='';let scan='';const decoder=new TextDecoder('utf-8',{fatal:true});
      while(!closed && !aborted) {
        const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;
        bytes+=chunk.value.byteLength;if(bytes > 64*1024)throw new Error();
        const part=decoder.decode(chunk.value,{stream:true});scan+=part;if(secret(scan)){fail('reply:private');throw new Error();}scan=scan.slice(-128);
        if(parser)parser.push(chunk.value);else text+=part;
      }
      if(closed || aborted || epoch !== generation)return;
      decoder.decode();if(parser){parser.finish();fail('sse:eof');return;}
      if(kind === 'history') {
        const page=api.validateHistoryView(JSON.parse(text));const head=history === 1 ? '1' : '9';
        if(page.session_id !== session || page.through_sequence !== head || page.has_more || page.next_after !== `${session}:${head}`
          || page.events.length !== Number(head) || (history === 2 && canonical(page.events) !== settled))throw new Error();
        events=[];state=stateModule.createConversation(session);for(const e of page.events)apply(e);
      } else if(kind === 'task') {
        const reply=api.validateTaskAcceptedView(JSON.parse(text));if(reply.duplicate || reply.warning_code !== null || reply.notices.length)throw new Error();
        receipt=reply.receipt;receipts++;
      } else if(kind === 'cancel'){cancelView=api.validateCancelView(JSON.parse(text));cancels++;}
      else runView=api.validateRunView(JSON.parse(text));
    })().catch(() => {if(!closed && !aborted)fail(`${kind}:read`);}).finally(() => {
      clearTimeout(timer);init?.signal?.removeEventListener('abort',abort);readers.delete(reader);void reader.cancel().catch(() => {});reads.delete(capture);
    });
    reads.add(capture);return response;
  };
}
