const fail=() => {throw new Error('read reconnect network evidence rejected');};
const LIMIT=8192;
const uuid=value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);

function decode(data,remaining,length) {
  // Check encoded bounds before allocating decoded storage.
  if(typeof data !== 'string' || data.length > 4*Math.ceil(remaining/3) || data.length%4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))fail();
  const size=data.length/4*3-(data.endsWith('==') ? 2 : Number(data.endsWith('=')));
  if(size > remaining || (length !== undefined && (!Number.isSafeInteger(length) || length !== size)))fail();
  const bytes=Buffer.from(data,'base64');
  if(bytes.toString('base64') !== data){bytes.fill(0);fail();}
  return bytes;
}

export function frameCollector({sid,sequence,title,eventId}) {
  if(!uuid(sid) || ![7,8].includes(sequence) || typeof title !== 'string' || (eventId !== undefined && !uuid(eventId)))fail();
  let buffer=Buffer.alloc(LIMIT);let used=0;let complete;let chunks=0;let disposed=false;
  return {
    push(data,length) {
      if(disposed || complete)fail();
      const bytes=decode(data,LIMIT-used,length);
      try {bytes.copy(buffer,used);used+=bytes.length;if(bytes.length)chunks++;} finally {bytes.fill(0);}
      // A split UTF-8 codepoint remains bytes until the complete SSE delimiter arrives.
      const end=buffer.subarray(0,used).indexOf('\n\n');
      if(end < 0)return;
      if(end !== used-2)fail();
      let text;
      try {text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));} catch {fail();}
      const prefix=`event: wi.event\nid: ${sid}:${sequence}\ndata: `;
      if(!text.startsWith(prefix))fail();
      const raw=text.slice(prefix.length,-2);let value;
      try {value=JSON.parse(raw);} catch {fail();}
      // Round-trip equality rejects duplicate keys, escaped keys, whitespace tricks,
      // and alternate encodings before a JSON parser can hide their spelling.
      if(JSON.stringify(value) !== raw || Object.keys(value).sort().join(',') !== 'api_version,created_at_ms,data,event_id,kind,run_id,sequence,session_id'
        || value.api_version !== 1 || value.session_id !== sid || value.sequence !== String(sequence) || !uuid(value.event_id)
        || (eventId !== undefined && value.event_id !== eventId) || value.run_id !== null || value.kind !== 'session.renamed'
        || typeof value.created_at_ms !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.created_at_ms) || value.created_at_ms.length > 19
        || BigInt(value.created_at_ms) > 9223372036854775807n || !value.data || Object.keys(value.data).join(',') !== 'title' || value.data.title !== title)fail();
      complete={session_id:sid,sequence,event_id:value.event_id,bytes:used,chunks,exact:true};
      buffer.fill(0);buffer=undefined;value=undefined;text=undefined;title=undefined;eventId=undefined;
    },
    result() {return complete ? {...complete} : null;},
    empty() {return used === 0;},
    dispose() {buffer?.fill(0);buffer=undefined;complete=undefined;title=undefined;eventId=undefined;sid=undefined;disposed=true;},
  };
}

// Receipt means page-target Network-domain receipt before native JS read, not TCP
// acknowledgement. Owned byte buffers are zeroed; JS/Chromium strings are not.
export async function reconnectNetwork(context,page,origin,sid,owner) {
  const cdp=await context.newCDPSession(page);
  let requestId;let response=false;let bad=false;let active=false;let terminal=false;let collector;let disposed=false;
  let identity;let baseline=false;let generation;let failedWhileHeld=false;
  let baselineBytes=0;let selectedChunks=0;let futureChunks=0;let futureBytes=0;let dataBearingChunks=0;
  const listeners=[];
  const on=(name,callback) => {const guarded=event => {try{callback(event);}catch{bad=true;collector?.dispose();}};listeners.push([name,guarded]);cdp.on(name,guarded);};
  on('Network.requestWillBeSent',event => {
    const url=new URL(event.request.url);
    if(url.origin !== origin || url.pathname !== `/v1/sessions/${sid}/events`)return;
    if(requestId || event.type !== 'Fetch' || event.redirectResponse || event.request.method !== 'GET'
      || url.searchParams.size !== 1 || url.searchParams.get('after') !== `${sid}:6`)fail();
    const authorization=Object.entries(event.request.headers).filter(([name]) => name.toLowerCase() === 'authorization');
    if(authorization.length !== 1 || authorization[0][1] !== `Bearer ${owner}`)fail();
    requestId=event.requestId;owner=undefined;
  });
  on('Network.responseReceived',event => {
    if(event.requestId !== requestId)return;
    const url=new URL(event.response.url);
    if(response || event.type !== 'Fetch' || event.response.status !== 200 || event.response.mimeType !== 'text/event-stream'
      || url.origin !== origin || url.pathname !== `/v1/sessions/${sid}/events` || url.searchParams.size !== 1
      || url.searchParams.get('after') !== `${sid}:6`)fail();
    response=true;
  });
  on('Network.dataReceived',event => {
    if(event.requestId !== requestId)return;
    selectedChunks++;
    if(terminal)fail();
    if(!active)return;
    futureChunks++;
    if(!Number.isSafeInteger(event.dataLength) || event.dataLength < 0 || event.dataLength > LIMIT-futureBytes)fail();
    futureBytes+=event.dataLength;
    if(typeof event.data !== 'string' || !event.data.length || !collector)fail();
    dataBearingChunks++;
    collector.push(event.data,event.dataLength);
    identity=collector.result();
  });
  on('Network.loadingFinished',event => {if(event.requestId === requestId)bad=true;});
  on('Network.loadingFailed',event => {
    if(event.requestId !== requestId)return;
    if(terminal || !active || !identity || event.canceled || event.blockedReason || event.corsErrorStatus
      || event.type !== 'Fetch' || event.errorText !== 'net::ERR_INCOMPLETE_CHUNKED_ENCODING')fail();
    terminal=true;
  });
  async function wait(predicate) {
    const end=Date.now()+8000;
    while(!predicate()){if(bad || disposed || Date.now() >= end)fail();await new Promise(resolve => setTimeout(resolve,10));}
    if(bad || disposed)fail();
  }
  async function held() {
    const value=await page.evaluate(() => globalThis.readReconnectCapture.gate());
    if(!value || value.generation !== generation || value.phase !== 'held' || value.subscription !== 2 || value.outstanding !== 0
      || value.released !== 0 || !value.site || value.head !== 7 || value.ledger !== 7)fail();
  }
  async function close() {
    if(disposed)return;disposed=true;
    for(const [name,callback] of listeners)cdp.off(name,callback);listeners.length=0;
    collector?.dispose();collector=undefined;identity=undefined;owner=undefined;requestId=undefined;sid=undefined;origin=undefined;
    try {await cdp.detach();} catch {throw new Error('read reconnect network cleanup rejected');}
  }
  try {await cdp.send('Network.enable');} catch {await close();fail();}
  return {
    async begin(token,a,titleA,titleB) {
      if(generation || !Number.isSafeInteger(token) || token < 1 || a.head !== 7 || !uuid(a.rename_event))fail();
      generation=token;await wait(() => !!requestId && response);await held();
      let result=await cdp.send('Network.streamResourceContent',{requestId});
      const initial=frameCollector({sid,sequence:7,title:titleA,eventId:a.rename_event});
      try {
        initial.push(result.bufferedData);
        if(!initial.empty() && !initial.result())fail();baselineBytes=initial.result()?.bytes ?? 0;baseline=true;
      } finally {initial.dispose();result=undefined;}
      collector=frameCollector({sid,sequence:8,title:titleB});active=true;
    },
    async received(audit) {
      await wait(() => !!identity);await held();
      if(audit.head !== 8 || audit.rename_count !== 2 || audit.rename_event !== identity.event_id || audit.session_id !== identity.session_id
        || audit.frame_bytes !== identity.bytes || audit.yielded_bytes !== identity.bytes)fail();
    },
    async failed() {await wait(() => terminal);await held();failedWhileHeld=true;},
    summary() {return {request:!!requestId,response,baseline,generation,bytes:identity?.bytes ?? 0,chunks:identity?.chunks ?? 0,
      identity:!!identity,terminal,failedWhileHeld,bad,baselineBytes,selectedChunks,futureChunks,futureBytes,dataBearingChunks};},
    close,
  };
}
