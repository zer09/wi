import test from 'node:test';
import assert from 'node:assert/strict';
import { displayPath, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { WiConversationSseParser, WiSseParser } from '../dist/sse.js';
import { replaceLatest, applyConversationChanges } from '../dist/display-store.js';
import { validateTaskAcceptedView } from '../dist/api.js';
import { SID, RID, OID, OTHER, cursor, batch, page, command } from '../test-support/display-fixtures.mjs';
const encode = s => new TextEncoder().encode(s);
export function frame(value = batch(), id = value.next_after) { return `event: wi.conversation\nid: ${id}\ndata: ${JSON.stringify(value)}\n\n`; }
const acceptance = () => ({ api_version: 1, receipt: { operation_id: OID, session_id: SID, run_id: RID, first_sequence: '2', last_sequence: '9' }, duplicate: false, warning_code: null, notices: [] });

test('display routes encode exact typed tokens and entry segment once', () => {
  assert.equal(displayPath({ kind: 'conversation', session_id: SID, query: { kind: 'latest' } }), `/v1/sessions/${SID}/conversation`);
  for (const [kind, code, parts] of [['before','b',['2']], ['within','s',[RID,'4','0']]]) {
    const token = cursor(code,...parts);
    assert.equal(displayPath({ kind: 'conversation', session_id: SID, query: { kind, cursor: token } }), `/v1/sessions/${SID}/conversation?${kind}=${encodeURIComponent(token)}`);
  }
  assert.equal(displayPath({ kind: 'entry', session_id: SID, run_id: RID, entry_id: 'e:4:0' }), `/v1/sessions/${SID}/conversation/entries/${RID}/e%3A4%3A0`);
  assert.equal(displayPath({ kind: 'reconcile', session_id: SID }), `/v1/sessions/${SID}/runs/reconcile`);
  const live = cursor('l','4','3','','');
  assert.equal(displayPath({ kind: 'display_events', session_id: SID, after: live }), `/v1/sessions/${SID}/conversation/events?after=${live}`);
  for (const route of [
    { kind:'entry',session_id:SID,run_id:RID,entry_id:'e%3A4%3A0' },
    { kind:'entry',session_id:SID,run_id:OTHER.toUpperCase(),entry_id:'../' },
    { kind:'content',session_id:SID,cursor:live },
    { kind:'display_events',session_id:OTHER,after:live },
    { kind:'conversation',session_id:SID,query:{kind:'unexpected',cursor:cursor('s',RID,'4','0')} },
  ]) assert.throws(()=>displayPath(route));
});
test('display acceptance checks general receipt identity without raw first+1 proof', () => {
  assert.deepEqual(validateDisplayTaskAccepted(acceptance(),command),acceptance());
  assert.throws(()=>validateTaskAcceptedView(acceptance()));
  for (const key of ['operation_id','session_id','run_id']) { const v=acceptance();v.receipt[key]=OTHER;assert.throws(()=>validateDisplayTaskAccepted(v,command)); }
  const v=acceptance();v.extra='private';assert.throws(()=>validateDisplayTaskAccepted(v,command));
});
for (const size of [1,2,7,100000]) test(`display shared framing BOM CR LF Unicode split ${size}`,()=>{
  const records=[],parser=new WiConversationSseParser(SID,r=>records.push(r));
  const bytes=encode('\ufeff: heart\r\nretry: 1\r\n\r\n'+frame().replaceAll('\n','\r\n'));
  for(let i=0;i<bytes.length;i+=size)parser.push(bytes.subarray(i,i+size));parser.finish();
  assert.equal(records.length,1);assert.deepEqual(records[0].changes,batch());
});
for (const [name,suffix] of [
  ['malformed JSON','event: wi.conversation\nid: bad\ndata: {\n\n'],
  ['missing id',`event: wi.conversation\ndata: ${JSON.stringify(batch())}\n\n`],
  ['wrong id',frame(batch(),'bad')],['raw event', 'event: wi.event\ndata: {}\n\n'],
]) test(`display keeps good prefix before ${name}`,()=>{
  let store=replaceLatest(page());const parser=new WiConversationSseParser(SID,r=>{if(r.kind==='conversation')store=applyConversationChanges(store,r.changes);});
  assert.throws(()=>parser.push(encode(frame()+suffix)));assert.equal(store.live_after,batch().next_after);assert.equal(parser.done,true);
});
test('display good byte prefix survives later fatal UTF8',()=>{
  const records=[],parser=new WiConversationSseParser(SID,r=>records.push(r));assert.throws(()=>parser.push(Buffer.concat([encode(frame()),Buffer.from([255,10])])));assert.equal(records.length,1);
});
test('display handler failure stops parsing and preserves prior publication',()=>{
  const old=replaceLatest(page());let store=old;const parser=new WiConversationSseParser(SID,()=>{throw Error('private');});
  assert.throws(()=>parser.push(encode(frame())),{message:'protocol.consumer_failed'});assert.strictEqual(store,old);assert.equal(parser.done,true);
});
test('comments and partial EOF do not publish or reconnect; multi-data is JSON whitespace',()=>{
  const records=[],parser=new WiConversationSseParser(SID,r=>records.push(r));
  const value=JSON.stringify(batch()).replace(',\"conversation_version\"',',\n\"conversation_version\"');
  parser.push(encode(': heartbeat\n\nevent: wi.conversation\nid: '+batch().next_after+'\n'+value.split('\n').map(s=>'data: '+s+'\n').join('')+'\n'+frame().slice(0,-1)));parser.finish();assert.equal(records.length,1);
});
for(const kind of ['error','closed'])test(`display ${kind} closes without an ID or cursor`,()=>{
  const records=[],parser=new WiConversationSseParser(SID,r=>records.push(r));
  const value=kind==='closed'?{api_version:1,reason:'shutdown'}:{api_version:1,code:'storage.io',stage:null,certainty:'unknown',acceptance:null,notices:[]};
  parser.push(encode(`event: wi.${kind}\ndata: ${JSON.stringify(value)}\n\n`+frame()));assert.equal(records.length,1);assert.equal(records[0].kind,kind);assert.equal(parser.done,true);
  assert.throws(()=>new WiConversationSseParser(SID,()=>{}).push(encode(`event: wi.${kind}\nid: x\ndata: ${JSON.stringify(value)}\n\n`)));
});
test('raw parser rejects display event but retains its public parser surface',()=>{
  const p=new WiSseParser(SID,()=>{});assert.throws(()=>p.push(encode(frame())));assert.equal(p.done,true);
});
