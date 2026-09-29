// SSE body access is identity-only. Only production calls may consume the stream.
export function installReadReconnectObserver({fixture,owner}) {
  const descriptors=[[globalThis,'fetch'],[Object,'freeze'],[Map.prototype,'set'],[TextDecoder.prototype,'decode'],
    [ReadableStream.prototype,'getReader'],[ReadableStreamDefaultReader.prototype,'read']].map(([object,key]) => [object,key,Object.getOwnPropertyDescriptor(object,key)]);
  const nativeFetch=globalThis.fetch;const nativeFreeze=Object.freeze;const nativeSet=Map.prototype.set;const nativeDecode=TextDecoder.prototype.decode;
  const nativeGetReader=ReadableStream.prototype.getReader;const nativeRead=ReadableStreamDefaultReader.prototype.read;
  let bodies=new WeakMap();let readers=new WeakMap();let responses=new WeakSet();let generation=0;let gate;
  const rejected=() => {throw new Error('read reconnect gate rejected');};
  const production=() => /\bat observe \([^\n]*\/assets\/client\.js:\d+:\d+\)/.test(new Error().stack ?? '');
  function invalidate() {
    if(!gate)return;
    gate.signal?.removeEventListener('abort',gate.abort);
    // Cleanup settlement is never network-error evidence and never touches a stale reader.
    gate.reject?.(new Error('read reconnect gate disposed'));
    gate.reject=undefined;gate.resolve=undefined;gate.reader=undefined;gate.args=undefined;gate.signal=undefined;gate.abort=undefined;
    gate.phase='disposed';bodies=new WeakMap();readers=new WeakMap();responses=new WeakSet();
  }
  function restore() {
    invalidate();
    for(const [object,key,descriptor] of descriptors)Object.defineProperty(object,key,descriptor);
  }
  try {
  ReadableStream.prototype.getReader=function(...args) {
    const reader=Reflect.apply(nativeGetReader,this,args);const binding=bodies.get(this);
    if(binding) {
      if(binding !== gate || binding.reader || binding.phase !== 'response' || !production()) {invalidate();rejected();}
      binding.reader=reader;binding.phase='reading';readers.set(reader,binding);
    }
    return reader;
  };
  ReadableStreamDefaultReader.prototype.read=function(...args) {
    const binding=readers.get(this);
    if(!binding || binding.phase === 'released')return Reflect.apply(nativeRead,this,args);
    if(binding !== gate || binding.phase !== 'reading' || binding.signal.aborted || !production()) {invalidate();rejected();}
    if(applied.length === 7) {
      if(!globalThis.readReconnectCapture.verify(7) || ledger.length !== 7 || binding.outstanding !== 0
        || binding.after !== `${sid}:6` || binding.subscription !== 2 || streams !== 2) {invalidate();rejected();}
      binding.phase='held';binding.args=args;binding.site=true;
      return new Promise((resolve,reject) => {binding.resolve=resolve;binding.reject=reject;});
    }
    if(applied.length !== 6) {invalidate();rejected();}
    const result=Reflect.apply(nativeRead,this,args);binding.native++;binding.outstanding++;
    result.then(() => {binding.outstanding--;},() => {binding.outstanding--;});
    return result;
  };
  let selected;let snapshot;let sid;let command;let receipt;let closed=false;let seen=false;let restored=false;
  let streams=0;let taskPosts=0;let receipts=0;let history=0;let creates=0;let otherPosts=0;
  let afters=[];let ledger=[];let applied=[];let applications=[];let reload=false;let partialArmed=false;
  const partial={calls:0,bytes:0,selected:false,delimiter:false,parser:false};
  let headerOffset=0;let headerMatches=true;let previousLF=false;
  const failures=new Set();const reads=new Set();
  const bad=kind => failures.add(kind);
  const same=(a,b) => JSON.stringify(a) === JSON.stringify(b);
  const secret=text => typeof owner === 'string' && (text.includes(owner) || /[0-9a-f]{64}/i.test(text)
    || ['private-project-','private-skill-','private-native','private-data','private-skills','synthetic-replay-','synthetic-account-',
      'principal_digest','history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'].some(s => text.includes(s)));
  const frozen=value => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
  Map.prototype.set=function(key,value) {
    const result=nativeSet.call(this,key,value);
    if(!closed && sid && typeof key === 'string' && /^[1-9][0-9]*$/.test(key) && typeof value === 'string' && value.startsWith('{"api_version":1,')) {
      try {
        const e=JSON.parse(value);
        if(e.session_id !== sid || e.sequence !== key || secret(value))throw new Error();
        const index=Number(key)-1;
        // Copy-on-write Maps reinsert the existing prefix before adding one record.
        if(index < ledger.length) {if(!same(ledger[index],e))throw new Error();return result;}
        if(index < 0 || index >= 64 || index !== ledger.length || ledger.some(old => old.event_id === e.event_id))throw new Error();
        ledger.push(e);
      }catch{bad('ledger');}
    }
    return result;
  };
  Object.freeze=value => {
    const result=nativeFreeze(value);
    if(value && typeof value.connection === 'string' && Array.isArray(value.pending) && Array.isArray(value.recoveries)
      && Object.hasOwn(value,'last_mutation') && Object.hasOwn(value,'draft')) {
      if(!frozen(value))bad('snapshot');
      if(value.selected) {
        selected=value.selected;snapshot=value;seen=true;
        const n=Number(selected.applied_cursor.split(':')[1]);
        if(sid && n > applied.length) {
          if(n !== ledger.length || n !== applied.length+1 && !reload)bad('cursor');
          for(const e of ledger.slice(applied.length,n))applications.push({sequence:e.sequence,event_id:e.event_id});
          applied=ledger.slice(0,n);
        }
      } else if(seen && value.connection === 'disconnected') {
        restored=value.pending.length === 0 && value.recoveries.length === 0 && value.draft === '' && value.last_mutation === null;
        closed=true;selected=undefined;snapshot=undefined;sid=undefined;command=undefined;receipt=undefined;ledger=[];applied=[];applications=[];afters=[];fixture=undefined;owner=undefined;
        restore();
      }
    }
    return result;
  };
  TextDecoder.prototype.decode=function(input,options) {
    const result=nativeDecode.call(this,input,options);
    if(partialArmed && !closed && options?.stream && this.fatal && new Error().stack?.includes('/assets/sse.js')) {
      partial.parser=true;partial.calls++;partial.bytes+=input?.byteLength ?? 0;
      // The production parser calls decode once per line, not once per chunk.
      const header=`event: wi.event\nid: ${sid}:7\n`;
      const count=Math.min(result.length,header.length-headerOffset);
      headerMatches &&= result.slice(0,count) === header.slice(headerOffset,headerOffset+count);
      headerOffset+=count;partial.selected=headerMatches && headerOffset === header.length;
      partial.delimiter ||= /\r\r|\n\n|\r\n\r\n/.test(result) || (previousLF && result.startsWith('\n'));
      previousLF=result.endsWith('\n');
    }
    return result;
  };
  globalThis.readReconnectCapture={
    armGate() {
      if(gate || closed || streams !== 1 || !this.verify(6,'disconnected'))rejected();
      gate={generation:++generation,phase:'armed',after:`${sid}:6`,subscription:2,native:0,outstanding:0,released:0,site:false,nativeRejected:false};
      return generation;
    },
    gate() {return gate ? {generation:gate.generation,phase:gate.phase,subscription:gate.subscription,native:gate.native,
      outstanding:gate.outstanding,released:gate.released,site:gate.site,nativeRejected:gate.nativeRejected,head:applied.length,ledger:ledger.length} : null;},
    releaseGate(token) {
      if(!gate || token !== gate.generation || gate.phase !== 'held' || gate.signal.aborted || gate.released !== 0)rejected();
      const binding=gate;binding.phase='released';binding.released++;binding.native++;binding.outstanding++;
      const resolve=binding.resolve;const reject=binding.reject;binding.resolve=undefined;binding.reject=undefined;
      // Adopt the actual native result/rejection. No substituted error, EOF, or bytes.
      try {
        const result=Reflect.apply(nativeRead,binding.reader,binding.args);binding.args=undefined;
        result.then(value => {binding.outstanding--;resolve(value);},error => {binding.outstanding--;binding.nativeRejected=true;reject(error);});
      } catch(error) {binding.outstanding--;binding.nativeRejected=true;reject(error);}
    },
    dispose() {closed=true;restore();selected=undefined;snapshot=undefined;sid=undefined;command=undefined;receipt=undefined;
      ledger=[];applied=[];applications=[];afters=[];fixture=undefined;owner=undefined;},
    armPartial() {if(partialArmed || applied.length !== 6)throw new Error('read reconnect observer rejected');partialArmed=true;},
    endPartial() {partialArmed=false;return {...partial};},
    identity() {return command && receipt ? {session_id:sid,run_id:command.run_id,operation_id:command.operation_id} : null;},
    sameObservation(session,after) {return !closed && selected?.session_id === session && sid === session && afters.at(-1) === after && streams === 2;},
    ready(n,observation='streaming') {return !closed && !failures.size && selected?.applied_cursor === `${sid}:${n}` && applied.length === n && selected.observation === observation;},
    verify(n,observation='streaming') {
      if(closed || failures.size || !receipt || taskPosts !== 1 || receipts !== 1 || creates !== 1 || otherPosts !== 0 || history !== 1
        || selected?.applied_cursor !== `${sid}:${n}` || selected.observation !== observation || applied.length !== n || ledger.length !== n
        || snapshot.connection !== 'connected' || snapshot.pending.length || snapshot.recoveries.length || snapshot.draft !== ''
        || snapshot.last_mutation?.kind !== 'task' || !same(snapshot.last_mutation.receipt,receipt)
        || selected.display.length !== 1 || selected.display[0].run.run_id !== command.run_id
        || selected.display[0].execution !== 'running' || selected.display[0].result_recorded || selected.display[0].entries.length
        || selected.display[0].user_text !== fixture.task || selected.display[0].run.accepted_sequence !== '2')return false;
      if(observation === 'disconnected' && selected.observation_error?.category !== 'network')return false;
      return applied.every((e,i) => e.sequence === String(i+1) && e.session_id === sid
        && applications.filter(a => a.event_id === e.event_id).length === 1
        && (i < 6 || (e.kind === 'session.renamed' && e.run_id === null && e.data.title === fixture.titles[i-6])));
    },
    matches(audit) {const e=applied[audit.head-1];return !!e && e.event_id === audit.rename_event && e.kind === 'session.renamed';},
    summary() {return {streams,taskPosts,receipts,creates,otherPosts,history,head:applied.length,ledger:ledger.length,
      observation:selected?.observation ?? 'none',afters:afters.map(cursor => Number(cursor.split(':')[1])),partial:{...partial},failures:[...failures]};},
    cleared() {return closed && restored && descriptors.every(([object,key,d]) => {
      const actual=Object.getOwnPropertyDescriptor(object,key);return Reflect.ownKeys(d).every(k => actual[k] === d[k]);
    });},
    async drain() {await Promise.all(reads);},
  };
  globalThis.fetch=async (...args) => {
    const url=new URL(args[0] instanceof Request ? args[0].url : args[0],location.href);const init=args[1];const method=init?.method ?? 'GET';
    if(url.pathname.startsWith('/v1/') && (url.origin !== location.origin || init?.mode !== 'same-origin' || init?.credentials !== 'omit'
      || init?.cache !== 'no-store' || init?.redirect !== 'error' || new Headers(init?.headers).get('authorization') !== `Bearer ${owner}`))bad('request');
    let kind;let binding;
    if(url.pathname.endsWith('/history')) {
      history++;kind='history';sid=url.pathname.split('/')[3];
      if(history !== 1 || url.searchParams.get('after') !== `${sid}:0`)bad('history');
    } else if(url.pathname.endsWith('/events')) {
      streams++;kind='sse';const after=url.searchParams.get('after');afters.push(after);
      if(method !== 'GET' || url.pathname !== `/v1/sessions/${sid}/events` || [...url.searchParams].length !== 1
        || after !== `${sid}:${applied.length}`)bad('stream');
      if(gate?.phase === 'armed') {
        if(streams !== 2 || after !== gate.after || failures.size || !init.signal || init.signal.aborted) {invalidate();rejected();}
        binding=gate;binding.phase='fetch';binding.signal=init.signal;binding.abort=() => invalidate();
        binding.signal.addEventListener('abort',binding.abort,{once:true});
      } else if(gate && gate.phase !== 'disposed')invalidate();
    } else if(method === 'POST') {
      if(url.pathname === '/v1/sessions'){creates++;kind='create';}
      else if(url.pathname === `/v1/sessions/${sid}/runs`) {
        taskPosts++;kind='task';
        try {command=JSON.parse(init.body);if(Object.keys(command).sort().join(',') !== 'operation_id,run_id,text' || command.text !== fixture.task)throw new Error();}
        catch{bad('command');}
      } else {otherPosts++;bad('mutation');}
    }
    const response=await nativeFetch(...args);
    // The original response and body go directly to the production client.
    if(kind === 'sse') {
      if(response.status !== 200 || response.headers.get('content-type') !== 'text/event-stream')bad('sse');
      if(binding) {
        if(closed || binding !== gate || binding.phase !== 'fetch' || binding.signal.aborted || failures.size || responses.has(response)) {invalidate();rejected();}
        const body=response.body;
        if(!body || bodies.has(body)) {invalidate();rejected();}
        responses.add(response);bodies.set(body,binding);binding.phase='response';
      }
      return response;
    }
    if(kind === 'task') {
      const capture=(async () => {
        const reader=response.clone().body.getReader();let bytes=0;let text='';const decoder=new TextDecoder('utf-8',{fatal:true});
        try {
          for(;;){const c=await reader.read();if(c.done)break;bytes+=c.value.byteLength;if(bytes > 4096)throw new Error();text+=decoder.decode(c.value,{stream:true});}
          text+=decoder.decode();if(closed)return;if(secret(text))throw new Error();
          const api=await import('/assets/api.js');const reply=api.validateTaskAcceptedView(JSON.parse(text));
          if(response.status !== 202 || reply.duplicate || reply.warning_code !== null || reply.notices.length
            || reply.receipt.session_id !== sid || reply.receipt.run_id !== command.run_id || reply.receipt.operation_id !== command.operation_id
            || reply.receipt.first_sequence !== '2' || reply.receipt.last_sequence !== '3')throw new Error();
          receipt=reply.receipt;receipts++;
        } finally {reader.releaseLock();}
      })().catch(() => {if(!closed)bad('receipt');}).finally(() => reads.delete(capture));reads.add(capture);
    }
    return response;
  };
  } catch {restore();delete globalThis.readReconnectCapture;throw new Error('read reconnect observer installation rejected');}
}
