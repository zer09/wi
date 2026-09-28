import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { frameCollector, reconnectNetwork } from '../test-support/read-reconnect-network.mjs';
const sid='11111111-1111-4111-8111-111111111111';
const eventId='22222222-2222-4222-8222-222222222222';
const title='Fixture observation B 雪';
const expected={sid,sequence:8,title,eventId};
const value={api_version:1,session_id:sid,sequence:'8',event_id:eventId,created_at_ms:'1',run_id:null,kind:'session.renamed',data:{title}};
const frame=(v=value) => Buffer.from(`event: wi.event\nid: ${sid}:8\ndata: ${JSON.stringify(v)}\n\n`);
function feed(collector,bytes) {collector.push(bytes.toString('base64'),bytes.length);}

test('CDP exact identity survives every byte split, including Unicode and delimiter',() => {
  const bytes=frame();
  for(let i=1;i<bytes.length;i++) {
    const c=frameCollector(expected);feed(c,bytes.subarray(0,i));assert.equal(c.result(),null);feed(c,bytes.subarray(i));
    assert.deepEqual(c.result(),{session_id:sid,sequence:8,event_id:eventId,bytes:bytes.length,chunks:2,exact:true});c.dispose();
  }
});
test('CDP rejects equal-length A substitution, wrong identities, duplicate/private fields and invalid JSON/SSE/UTF-8',() => {
  const bytes=frame();
  const invalid=[frame({...value,data:{title:title.replace(' B ',' A ')}}),frame({...value,session_id:eventId}),frame({...value,event_id:sid}),
    frame({...value,sequence:'7'}),frame({...value,run_id:sid}),frame({...value,private:'hidden'}),frame({...value,data:{title,private:'hidden'}}),
    Buffer.from(bytes.toString().replace('"api_version":1','"api_version":1,"api_version":1')),
    Buffer.from(bytes.toString().replace('"api_version"','"api_\\u0076ersion"')),
    Buffer.from(bytes.toString().replace('wi.event','wi.closed')),Buffer.from(bytes.toString().replace('data: {','data: !')),
    Buffer.concat([bytes,bytes]),Buffer.concat([bytes,Buffer.from('id: partial')]),Buffer.from(bytes)];
  invalid.at(-1)[bytes.indexOf(Buffer.from('雪'))]=0xff;
  for(const bad of invalid) {const c=frameCollector(expected);assert.throws(() => feed(c,bad),/evidence rejected/);c.dispose();}
  assert.equal(invalid[0].length,bytes.length);
});
test('CDP bounds base64 and bytes before allocation and rejects extra chunks after completion',() => {
  for(const data of ['!','abc','AAAA=','A==A','Zh==','A'.repeat(12000)]) {
    const c=frameCollector(expected);assert.throws(() => c.push(data));c.dispose();
  }
  const c=frameCollector(expected);assert.throws(() => c.push(frame().toString('base64'),1));c.dispose();
  const complete=frameCollector(expected);feed(complete,frame());assert.throws(() => feed(complete,Buffer.from('x')));complete.dispose();assert.throws(() => feed(complete,frame()));
});
function fixture() {
  const cdp=new EventEmitter();let detached=false;
  cdp.send=async name => name === 'Network.streamResourceContent' ? {bufferedData:''} : {};
  cdp.detach=async () => {detached=true;};
  const page={evaluate:async () => ({generation:1,phase:'held',subscription:2,outstanding:0,released:0,site:true,head:7,ledger:7})};
  return {cdp,page,context:{newCDPSession:async () => cdp},detached:() => detached};
}
const origin='http://127.0.0.1:1234';
function request(cdp) {
  const url=origin+`/v1/sessions/${sid}/events?after=${sid}:6`;
  cdp.emit('Network.requestWillBeSent',{requestId:'r',type:'Fetch',request:{url,method:'GET',headers:{authorization:'Bearer synthetic'}}});
  cdp.emit('Network.responseReceived',{requestId:'r',type:'Fetch',response:{url,status:200,mimeType:'text/event-stream'}});
}
test('CDP terminal proof correlates exact selected request and stays active after B receipt',async () => {
  const f=fixture();const n=await reconnectNetwork(f.context,f.page,origin,sid,'synthetic');request(f.cdp);
  await n.begin(1,{head:7,rename_event:eventId},title.replace(' B ',' A '),title);
  f.cdp.emit('Network.dataReceived',{requestId:'other',data:'private'});
  const bytes=frame();f.cdp.emit('Network.dataReceived',{requestId:'r',dataLength:bytes.length,data:bytes.toString('base64')});
  await n.received({head:8,rename_count:2,session_id:sid,rename_event:eventId,frame_bytes:bytes.length,yielded_bytes:bytes.length});
  f.cdp.emit('Network.loadingFailed',{requestId:'other'});assert.equal(n.summary().terminal,false);
  f.cdp.emit('Network.loadingFailed',{requestId:'r',type:'Fetch',errorText:'net::ERR_INCOMPLETE_CHUNKED_ENCODING',canceled:false});await n.failed();
  assert.equal(n.summary().failedWhileHeld,true);await n.close();assert.equal(f.detached(),true);assert.deepEqual(f.cdp.eventNames(),[]);
});
for(const failure of [{canceled:true},{blockedReason:'other'},{corsErrorStatus:{}},{errorText:'net::ERR_ABORTED'}]) {
  test(`CDP rejects non-native terminal category ${Object.keys(failure)[0]}`,async () => {
    const f=fixture();const n=await reconnectNetwork(f.context,f.page,origin,sid,'synthetic');request(f.cdp);
    await n.begin(1,{head:7,rename_event:eventId},title,title);const bytes=frame();
    f.cdp.emit('Network.dataReceived',{requestId:'r',dataLength:bytes.length,data:bytes.toString('base64')});
    f.cdp.emit('Network.loadingFailed',{requestId:'r',type:'Fetch',errorText:'net::ERR_INCOMPLETE_CHUNKED_ENCODING',...failure});
    await assert.rejects(n.failed(),/evidence rejected/);await n.close();
  });
}
