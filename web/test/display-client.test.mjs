import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDisplayClient } from '../dist/display-client.js';
import { SID, RID, OTHER, OID, FID, SECOND, cursor, field, fragment, entry, human, block, session, page, addressed, batch, upsert, order } from '../test-support/display-fixtures.mjs';
const TOKEN='0123456789abcdef'.repeat(4), NEW_TOKEN='fedcba9876543210'.repeat(4);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function flush(){for(let i=0;i<5;i++)await tick();}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const reply=(value,status=200,media='application/json')=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':media}});
const error=(code='storage.io',certainty='unknown',acceptance=null,notices=[])=>({api_version:1,code,stage:null,certainty,acceptance,notices});
const settings={api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'sse',enable_add_numbers:false};
const catalog=(entries=[],more=false)=>({api_version:1,entries,next_after_id:entries.at(-1)?.session_id??null,has_more:more});
const cat=(sid)=>({session_id:sid,title:'Synthetic',workspace:'/synthetic/project',created_at_ms:'1',updated_at_ms:'2',observed_head_sequence:'4',view:'catalog',availability:'ready',fault_code:null,last_run_id:null,last_run_state:null});
// Cursor JSON must change with session identity, not just the visible UUID fields.
function forSession(value,sid){
  const walk=v=>{if(typeof v==='string'){if(v===SID)return sid;if(v.startsWith('g11')){const [p,s]=v.split('.');const a=JSON.parse(Buffer.from(s,'base64url'));a[1]=sid;return p+'.'+Buffer.from(JSON.stringify(a)).toString('base64url');}return v;}if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,walk(v)]));return v;};return walk(value);
}
function stream(){let owner,cancels=0;const body=new ReadableStream({start(c){owner=c;},cancel(){cancels++;}});return {response:new Response(body,{headers:{'Content-Type':'text/event-stream'}}),push(value){owner.enqueue(new TextEncoder().encode(typeof value==='string'?value:`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`));},close(){owner.close();},get cancels(){return cancels;}};}
function harness(handler=()=>undefined){
  const calls=[],streams=[],ids=[OID,RID,OTHER,'55555555-5555-4555-8555-555555555555'];let n=0;
  const client=createDisplayClient({crypto:{randomUUID:()=>ids[n++]??`66666666-6666-4666-8666-${String(n).padStart(12,'0')}`},fetch:async(path,init)=>{
    const call={path,init};calls.push(call);const custom=handler(call,calls);if(custom!==undefined)return await custom;
    if(path==='/v1/settings')return reply(settings);
    if(path.startsWith('/v1/sessions?'))return reply(catalog());
    if(path.includes('/conversation/events?')){const s=stream();streams.push(s);return s.response;}
    if(path.endsWith('/conversation'))return reply(forSession(page(),path.split('/')[3]));
    if(path===`/v1/sessions/${SID}`)return reply(session());
    throw Error('Unexpected synthetic request');
  }});
  return {client,calls,streams,async open(){await client.connect(TOKEN);await client.selectSession(SID);await flush();},async close(){client.disconnect();await flush();}};
}
function acceptance(call,overrides={}){const body=JSON.parse(call.init.body);return {api_version:1,receipt:{operation_id:body.operation_id,session_id:call.path.split('/')[3],run_id:body.run_id,first_sequence:'2',last_sequence:'9'},duplicate:false,warning_code:null,notices:[],...overrides};}
const pending=h=>h.client.snapshot().pending[0];
function BPage(overrides={}){
  const h=human({entry_id:'e:10:0',position:{sequence:'10',slot:'0'},revision:'10',content_epoch:'10',fields:[field({field_id:'text',order_key:'0',generation:'10',text:'Task B',total_bytes:'6',to_byte:'6'})]});
  const e=entry({entry_id:'e:14:0',position:{sequence:'14',slot:'0'},revision:'14',content_epoch:'14',fields:[field({generation:'14'})]});
  const b=block({accepted_sequence:'10',revision:'14',human:h});
  return page({snapshot_head:'20',session:session('20'),block:b,entries:[e],previous_block:cursor('b','10'),live_after:cursor('l','20','3','',''),...overrides});
}

function latestAt(sid,head){return forSession(page({snapshot_head:head,session:session(head),live_after:cursor('l',head,'3','','')}),sid);}
function publishedIdentities(publications){
  for(const s of publications)if(s.selected?.store){assert.equal(s.selected.store.session_id,s.selected.session_id);assert.equal(s.selected.store.session.session_id,s.selected.session_id);}
}
function matchingObserver(h,sid,head){
  const call=h.calls.filter(c=>c.path.includes('/conversation/events?')).at(-1);
  assert.equal(call.path,`/v1/sessions/${sid}/conversation/events?after=${latestAt(sid,head).live_after}`);
  assert.equal(call.init.signal.aborted,false);
  assert.equal(h.streams.filter(s=>s.cancels===0).length,1);
}
function subscriberAction(client,action){if(action==='selection')return client.selectSession(OTHER);if(action==='reconnect')return client.reconnectLatest();client.disconnect();return Promise.resolve();}
function outerAction(client,action){if(action==='selection')return client.selectSession(SID);return client.reconnectLatest();}

for(const outer of ['selection','rebase'])for(const nested of ['selection','reconnect','disconnect'])for(const schedule of nested==='disconnect'?['inner-first']:['inner-first','outer-first'])test(`loading subscriber ${nested} owns interrupted ${outer}; ${schedule}`,async t=>{
  let armed=false;const reads=[],publications=[];
  const h=harness(c=>{if(armed&&c.path.endsWith('/conversation')){const wait=deferred();reads.push({call:c,wait});return wait.promise;}if(c.path.endsWith('/runs'))return Promise.reject(Error('lost synthetic reply'));});
  t.after(()=>h.close());
  if(outer==='rebase'){await h.open();h.client.setDraft(' \nExact\u0000🙂');await h.client.sendTask();}else await h.client.connect(TOKEN);
  const saved=h.client.snapshot(),start=h.calls.length;let fired=false,inner;
  h.client.subscribe(s=>{publications.push(s);if(armed&&!fired&&s.selected?.session_id===SID&&s.selected.observation==='loading'){fired=true;inner=subscriberAction(h.client,nested);}});
  armed=true;const action=outerAction(h.client,outer);await flush();
  const order=schedule==='inner-first'?[...reads]:[...reads].reverse();
  for(const read of order){read.wait.resolve(reply(latestAt(read.call.path.split('/')[3],read===reads[0]?'20':'10')));await flush();}
  await action;await inner;await flush();
  // Subscribers only record observations. Assertions here cannot be swallowed by emit().
  assert.equal(fired,true);publishedIdentities(publications);
  const now=h.client.snapshot(),calls=h.calls.slice(start);
  assert.equal(reads.length,nested==='disconnect'?0:1,'An interrupted action must not allocate a Latest reader');
  assert.equal(calls.length,nested==='disconnect'?0:2,'Only the owning Latest and matching-H observer may fetch');
  if(nested==='disconnect'){assert.equal(now.connection,'disconnected');assert.equal(now.selected,null);assert.equal(h.streams.filter(s=>s.cancels===0).length,0);return;}
  const sid=nested==='selection'?OTHER:SID;
  assert.equal(now.selected.session_id,sid);assert.equal(now.selected.store.observed_head,'20');assert.equal(now.selected.observation,'streaming');assert.equal(now.selected.observation_error,null);
  matchingObserver(h,sid,'20');assert.deepEqual(now.pending,saved.pending);assert.equal(now.draft,nested==='selection'?'':saved.draft);
  if(outer==='rebase')assert.equal(h.streams[0].cancels,1);
  const installed=publications.find(s=>s.selected?.store?.observed_head==='20');assert.equal(installed.selected.observation,'loading','Install the store before observer publication');
});

for(const outer of ['selection','rebase'])for(const nested of ['selection','reconnect'])for(const failure of ['HTTP','network'])test(`interrupted ${outer} cannot publish ${failure} error after loading subscriber ${nested}`,async t=>{
  let armed=false;const reads=[],publications=[];
  const h=harness(c=>{if(armed&&c.path.endsWith('/conversation')){const wait=deferred();reads.push({call:c,wait});return wait.promise;}});t.after(()=>h.close());
  if(outer==='rebase')await h.open();else await h.client.connect(TOKEN);
  const start=h.calls.length;let fired=false,inner;
  h.client.subscribe(s=>{publications.push(s);if(armed&&!fired&&s.selected?.session_id===SID&&s.selected.observation==='loading'){fired=true;inner=subscriberAction(h.client,nested);}});
  armed=true;const action=outerAction(h.client,outer);await flush();
  reads[0].wait.resolve(reply(latestAt(reads[0].call.path.split('/')[3],'20')));await inner;await flush();const saved=h.client.snapshot(),count=publications.length;
  for(const read of reads.slice(1)){if(failure==='HTTP')read.wait.resolve(reply(error(),503));else read.wait.reject(Error('synthetic ignored-abort failure'));}
  await action;await flush();
  assert.equal(fired,true);assert.deepEqual(h.client.snapshot(),saved,'Interrupted errors must not disconnect the owning observer');assert.equal(publications.length,count);publishedIdentities(publications);
  assert.equal(reads.length,1);assert.equal(h.calls.length-start,2);matchingObserver(h,nested==='selection'?OTHER:SID,'20');
});

for(const outer of ['selection','rebase'])for(const nested of ['selection','reconnect','disconnect'])for(const result of ['success','HTTP','network','401'])for(const schedule of nested==='disconnect'?['after-current']:['before-current','after-current'])test(`ignored-abort ${outer} Latest ${result} after subscriber ${nested}; ${schedule}`,async t=>{
  const stale=deferred(),fresh=deferred(),publications=[];let armed=false,reads=0;
  const h=harness(c=>{if(armed&&c.path.endsWith('/conversation'))return ++reads===1?stale.promise:fresh.promise;});t.after(()=>h.close());
  if(outer==='rebase')await h.open();else await h.client.connect(TOKEN);
  const start=h.calls.length;armed=true;const action=outerAction(h.client,outer);await flush();const oldCall=h.calls.at(-1);
  let fired=false,inner;
  h.client.subscribe(s=>{publications.push(s);if(!fired&&s.selected?.session_id===SID&&s.selected.observation==='loading'){fired=true;inner=subscriberAction(h.client,nested);}});
  // subscribe() immediately publishes the loading snapshot after the old fetch is admitted.
  await flush();assert.equal(oldCall.init.signal.aborted,true);
  let cancels=0;
  const settleStale=async()=>{
    if(result==='network')stale.reject(Error('synthetic ignored-abort failure'));
    else{const value=result==='success'?latestAt(SID,'10'):error(result==='401'?'api.unauthorized':'storage.io');const bytes=new TextEncoder().encode(JSON.stringify(value));const body=new ReadableStream({start(c){c.enqueue(bytes);},cancel(){cancels++;}});stale.resolve(new Response(body,{status:result==='success'?200:result==='401'?401:503,headers:{'Content-Type':'application/json'}}));}
    await action;await flush();
  };
  const settleCurrent=async()=>{if(nested!=='disconnect'){fresh.resolve(reply(latestAt(nested==='selection'?OTHER:SID,'20')));await inner;await flush();}};
  if(schedule==='before-current'){const saved=h.client.snapshot(),count=publications.length;await settleStale();assert.deepEqual(h.client.snapshot(),saved);assert.equal(publications.length,count);await settleCurrent();}
  else{await settleCurrent();const saved=h.client.snapshot(),count=publications.length;await settleStale();assert.deepEqual(h.client.snapshot(),saved);assert.equal(publications.length,count);}
  assert.equal(fired,true);publishedIdentities(publications);assert.equal(reads,nested==='disconnect'?1:2);assert.equal(h.calls.length-start,nested==='disconnect'?1:3);assert.equal(cancels,result==='network'?0:1);
  const now=h.client.snapshot();
  if(nested==='disconnect'){assert.equal(now.connection,'disconnected');assert.equal(now.selected,null);assert.equal(h.streams.filter(s=>s.cancels===0).length,0);}
  else{assert.equal(now.connection,'connected');assert.equal(now.selected.store.observed_head,'20');assert.equal(now.selected.observation_error,null);matchingObserver(h,nested==='selection'?OTHER:SID,'20');}
  if(outer==='rebase')assert.equal(h.streams[0].cancels,1);
});

for(const outer of ['selection','rebase'])for(const nested of ['selection','reconnect','disconnect'])test(`store publication subscriber ${nested} prevents interrupted ${outer} observer`,async t=>{
  let armed=false;const publications=[];
  const h=harness(c=>armed&&c.path.endsWith('/conversation')?reply(latestAt(c.path.split('/')[3],'20')):undefined);t.after(()=>h.close());
  if(outer==='rebase')await h.open();else await h.client.connect(TOKEN);
  const start=h.calls.length;let fired=false,inner;
  h.client.subscribe(s=>{publications.push(s);if(armed&&!fired&&s.selected?.store?.observed_head==='20'&&s.selected.observation==='loading'){fired=true;inner=subscriberAction(h.client,nested);}});
  armed=true;await outerAction(h.client,outer);await inner;await flush();assert.equal(fired,true);publishedIdentities(publications);
  assert.equal(h.calls.length-start,nested==='disconnect'?1:3);assert.equal(h.calls.slice(start).filter(c=>c.path.includes('/conversation/events?')).length,nested==='disconnect'?0:1);
  if(nested==='disconnect'){assert.equal(h.client.snapshot().selected,null);assert.equal(h.streams.filter(s=>s.cancels===0).length,0);}
  else matchingObserver(h,nested==='selection'?OTHER:SID,'20');
  if(outer==='rebase')assert.equal(h.streams[0].cancels,1);
});

test('selection publishes exactly Latest B before matching-H stream; no older/raw/head requests',async()=>{
  const h=harness();let rendered=false;h.client.subscribe(s=>{if(s.selected?.store){rendered=true;assert.ok(!h.calls.some(c=>c.path.includes('/history')));}});
  await h.open();assert.equal(rendered,true);assert.deepEqual(h.calls.map(c=>c.path),['/v1/settings','/v1/sessions?limit=32',`/v1/sessions/${SID}/conversation`,`/v1/sessions/${SID}/conversation/events?after=${cursor('l','4','3','','')}`]);
  assert.equal(h.client.snapshot().selected.store.blocks.length,1);await h.close();
});
test('snapshot-head attach race, metadata, private watermark and new block use supplied display state',async()=>{
  const h=harness();await h.open();const s=h.streams[0];
  s.push(batch([upsert(entry({revision:'6',fields:[field({text:'abcdef',total_bytes:'6',to_byte:'6'})]}),block({revision:'6'}))],'6'));await flush();
  assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].fields[0].ranges[0].text,'abcdef');
  s.push(batch([{kind:'session.upsert',session:session('7',{title:'Renamed'})}],'7'));s.push(batch([],'8'));await flush();
  assert.equal(h.client.snapshot().selected.store.session.title,'Renamed');assert.equal(h.client.snapshot().selected.store.observed_head,'8');
  const p=BPage();const next={...p.block,run_id:OTHER,human:{...p.block.human,run_id:OTHER}};
  s.push(batch([{kind:'block.upsert',block:next}],'20'));await flush();assert.equal(h.client.snapshot().selected.store.blocks[1].view.run_id,OTHER);
  assert.equal(h.client.snapshot().selected.observation,'streaming');await h.close();
});
test('empty session remains empty until self-contained new block arrives',async()=>{
  const h=harness(c=>c.path.endsWith('/conversation')?reply(page({block:null,entries:[],previous_block:null})):undefined);await h.open();
  assert.equal(h.client.snapshot().selected.store.blocks.length,0);await h.client.loadOlder();assert.equal(h.calls.length,4);
  h.streams[0].push(batch([{kind:'block.upsert',block:BPage().block}],'20'));await flush();assert.equal(h.client.snapshot().selected.store.blocks.length,1);await h.close();
});
test('requests keep bearer only in headers and exact same-origin protected init',async()=>{
  const h=harness();await h.open();for(const c of h.calls){assert.ok(c.path.startsWith('/v1/'));assert.ok(!c.path.includes(TOKEN));assert.equal(c.init.headers.Authorization,`Bearer ${TOKEN}`);for(const [key,value] of Object.entries({credentials:'omit',redirect:'error',cache:'no-store',mode:'same-origin',referrerPolicy:'no-referrer'}))assert.equal(c.init[key],value);assert.equal(c.init.method,'GET');}
  assert.ok(!JSON.stringify(h.client.snapshot()).includes(TOKEN));const snap=h.client.snapshot();assert.throws(()=>snap.selected.store.blocks.push({}));await h.close();assert.equal(h.client.snapshot().draft,'');assert.equal(h.client.snapshot().pending.length,0);
});
for(const [name,response] of [
  ['bad media',()=>reply(page(),200,'text/html')],['bad status',()=>reply(page(),201)],['unknown DTO',()=>reply({...page(),private:'private'})],
  ['bad UTF8',()=>new Response(Uint8Array.of(255),{headers:{'Content-Type':'application/json'}})],
  ['wrong session',()=>reply(forSession(page(),OTHER))],['bad version',()=>reply({...page(),conversation_version:2})],
  ['wrong error DTO',()=>reply({...error(),private:'private'},503)],
])test(`Latest rejects ${name} before observation`,async()=>{const h=harness(c=>c.path.endsWith('/conversation')?response():undefined);await h.open();assert.equal(h.client.snapshot().selected.store,null);assert.equal(h.client.snapshot().selected.observation,'disconnected');assert.equal(h.calls.length,3);assert.equal(h.client.snapshot().selected.observation_error.category,'protocol');await h.close();});
for(const mode of ['selection','rebase','connection'])test(`stale ignored-abort Latest ${mode} cannot publish or attach`,async()=>{
  const old=deferred();let reads=0;const h=harness(c=>c.path.endsWith('/conversation')&&++reads===1?old.promise:undefined);
  await h.client.connect(TOKEN);const waiting=h.client.selectSession(SID);await flush();
  if(mode==='selection')await h.client.selectSession(OTHER);else if(mode==='rebase')await h.client.reconnectLatest();else{await h.client.connect(NEW_TOKEN);await h.client.selectSession(OTHER);}
  await flush();const saved=h.client.snapshot();old.resolve(reply(page({session:session('4',{title:'Old'})})));await waiting;await flush();
  assert.deepEqual(h.client.snapshot(),saved);assert.equal(h.streams.length,1);await h.close();
});
test('old401 response cannot clear a new connection',async()=>{
  const old=deferred();let reads=0;const h=harness(c=>c.path==='/v1/settings'&&++reads===1?old.promise:undefined);
  const a=h.client.connect(TOKEN);await flush();await h.client.connect(NEW_TOKEN);old.resolve(reply(error('api.unauthorized'),401));await a;await flush();assert.equal(h.client.snapshot().connection,'connected');assert.equal(h.calls.at(-1).init.headers.Authorization,`Bearer ${NEW_TOKEN}`);await h.close();
});
for(const mode of ['selection','rebase','connection'])test(`stale ignored-abort SSE response ${mode} cannot change current observer`,async()=>{
  const old=deferred();let reads=0;const h=harness(c=>c.path.includes('/conversation/events?')&&++reads===1?old.promise:undefined);await h.open();
  if(mode==='selection')await h.client.selectSession(OTHER);else if(mode==='rebase')await h.client.reconnectLatest();else{await h.client.connect(NEW_TOKEN);await h.client.selectSession(OTHER);}
  await flush();const saved=h.client.snapshot();const late=stream();old.resolve(late.response);await flush();assert.deepEqual(h.client.snapshot(),saved);assert.equal(late.cancels,1);await h.close();
});
test('failed explicit fresh-Latest rebase retains stale window, draft and pending identity; no retry or cancel',async()=>{
  let failRebase=false;const h=harness(c=>c.path.endsWith('/conversation')&&failRebase?Promise.reject(Error('private')):c.path.endsWith('/runs')?Promise.reject(Error('lost')):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();const old=h.client.snapshot();failRebase=true;await h.client.reconnectLatest();await flush();const now=h.client.snapshot();assert.deepEqual(now.selected.store,old.selected.store);assert.equal(now.draft,'Task');assert.deepEqual(now.pending,old.pending);assert.equal(now.selected.observation,'disconnected');assert.equal(now.selected.observation_error.category,'network');assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);await h.close();
});
test('successful rebase resets older window only after success and preserves pending command and draft',async()=>{
  const rebase=deferred();let reads=0;const h=harness(c=>c.path.endsWith('/conversation')&&++reads===2?rebase.promise:c.path.endsWith('/runs')?Promise.reject(Error('lost')):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();const old=h.client.snapshot();const wait=h.client.reconnectLatest();await flush();assert.deepEqual(h.client.snapshot().selected.store,old.selected.store);rebase.resolve(reply(page({snapshot_head:'6',session:session('6'),live_after:cursor('l','6','3','','')})));await wait;await flush();assert.equal(h.client.snapshot().selected.store.live_after,cursor('l','6','3','',''));assert.equal(h.client.snapshot().draft,'Task');assert.deepEqual(h.client.snapshot().pending,old.pending);assert.equal(h.streams[0].cancels,1);assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);await h.close();
});
for(const ending of ['EOF','closed','error'])test(`${ending} freezes display without execution completion, reconnect, retry or cancel`,async()=>{
  const h=harness();await h.open();const saved=h.client.snapshot().selected.store;
  if(ending==='EOF')h.streams[0].close();else h.streams[0].push(`event: wi.${ending}\ndata: ${JSON.stringify(ending==='closed'?{api_version:1,reason:'shutdown'}:error())}\n\n`);await flush();assert.deepEqual(h.client.snapshot().selected.store,saved);assert.equal(h.client.snapshot().selected.observation,'disconnected');assert.equal(h.calls.length,4);await h.close();
});
test('one older admission completes content then activity then previous block with exact provenance',async()=>{
  const p=BPage(),token=cursor('c',RID,'e:14:0','14',FID,'14','3');p.entries=[{...p.entries[0],fields:[fragment('def',3,6,{generation:'14'})],earlier_content:token,content_complete:false}];p.earlier_activity=cursor('s',RID,'14','0');
  const read=deferred();let contentCalls=0;
  const h=harness(c=>{
    if(c.path.endsWith('/conversation'))return reply(p);
    if(c.path.includes('/conversation/content?')){contentCalls++;return read.promise;}
    if(c.path.includes('?within='))return reply({...p,entries:[entry({entry_id:'e:12:0',position:{sequence:'12',slot:'0'},revision:'12',content_epoch:'12',fields:[field({generation:'12'})]})],earlier_activity:null,live_after:null});
    if(c.path.includes('?before=')){const e=entry({run_id:OTHER});return reply(page({block:block({run_id:OTHER,human:human({run_id:OTHER})}),entries:[e],snapshot_head:'20',session:session('20'),previous_block:null,live_after:null}));}
  });await h.open();const after=h.client.snapshot().selected.store.live_after;const a=h.client.loadOlder();const b=h.client.loadOlder();await flush();assert.equal(contentCalls,1);assert.equal(h.client.snapshot().selected.older_loading,true);
  read.resolve(reply(addressed({...p.entries[0],fields:[fragment('abc',0,6,{generation:'14'})],earlier_content:null},p.block,'20')));await a;await b;
  assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].content_complete,true);assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].fields[0].ranges[0].text,'abcdef');
  await h.client.loadOlder();await h.client.loadOlder();assert.equal(h.client.snapshot().selected.store.blocks.length,2);assert.equal(h.client.snapshot().selected.store.live_after,after);
  assert.deepEqual(h.calls.slice(4).map(c=>c.path.split('/conversation')[1].split('=')[0]),['/content?cursor','?within','?before']);assert.equal(h.client.snapshot().selected.store.blocks[1].activity_snapshot_head,'20');await h.close();
});
test('live frames continue during backward read; page H and delayed post-H admission remain separate',async()=>{
  const old=deferred(),p=BPage({earlier_activity:cursor('s',RID,'14','0')});const h=harness(c=>c.path.endsWith('/conversation')?reply(p):c.path.includes('?within=')?old.promise:undefined);await h.open();const wait=h.client.loadOlder();await flush();
  const e=entry({entry_id:'e:21:0',position:{sequence:'21',slot:'0'},revision:'21',content_epoch:'21',fields:[field({generation:'21'})]});h.streams[0].push(batch([upsert(e,{...p.block,revision:'21'})],'21'));await flush();
  assert.equal(h.client.snapshot().selected.store.blocks[0].entries.length,2);old.resolve(reply({...p,snapshot_head:'22',session:session('22'),entries:[entry({entry_id:'e:12:0',position:{sequence:'12',slot:'0'},revision:'12',content_epoch:'12',fields:[field({generation:'12'})]})],earlier_activity:null,live_after:null}));await wait;
  const late=entry({entry_id:'e:20:1',position:{sequence:'20',slot:'1'},revision:'23',content_epoch:'20',fields:[field({generation:'20'})]});h.streams[0].push(batch([upsert(late,{...p.block,revision:'23'})],'23'));await flush();
  const store=h.client.snapshot().selected.store;assert.equal(store.blocks[0].activity_snapshot_head,'20');assert.equal(store.blocks[0].entries.some(e=>e.view.entry_id==='e:20:1'),false);assert.equal(store.live_after,cursor('l','23','3','',''));await h.close();
});
test('content409 affects only addressed operation and explicit compact refresh, not live or unrelated state',async()=>{
  const p=page();p.entries=[entry({fields:[fragment('bc',1,3)],content_complete:false,earlier_content:cursor('c',RID,'e:4:0','4',FID,'4','1')})];
  const h=harness(c=>c.path.endsWith('/conversation')?reply(p):c.path.includes('/content?')?reply(error('api.conversation_cursor_stale','not_applicable'),409):c.path.includes('/entries/')?reply(addressed(entry({revision:'6',content_epoch:'6',fields:[field({generation:'6',text:'new'})]}),block({revision:'6'}),'6')):undefined);await h.open();await h.client.loadOlder();assert.equal(h.client.snapshot().selected.content_operations[0].state,'changed');const count=h.calls.length;await h.client.loadOlder();assert.equal(h.calls.length,count);
  h.streams[0].push(batch([],'5'));await flush();assert.equal(h.client.snapshot().selected.observation,'streaming');await h.client.refreshEntry(RID,'e:4:0');assert.equal(h.client.snapshot().selected.content_operations.length,0);assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].fields[0].ranges[0].text,'new');assert.equal(h.client.snapshot().selected.store.live_after,cursor('l','5','3','',''));await h.close();
});
test('addressed refresh of unchanged complete entry is a successful explicit read',async()=>{
  const h=harness(c=>c.path.includes('/entries/')?reply(addressed()):undefined);await h.open();await h.client.refreshEntry(RID,'e:4:0');assert.equal(h.client.snapshot().selected.content_operations.length,0);await h.close();
});
test('zero-progress content response is local failure and cannot silently loop or kill stream',async()=>{
  const p=page();p.entries=[entry({fields:[fragment('bc',1,3)],content_complete:false,earlier_content:cursor('c',RID,'e:4:0','4',FID,'4','1')})];const h=harness(c=>c.path.endsWith('/conversation')?reply(p):c.path.includes('/content?')?reply(addressed(p.entries[0])):undefined);await h.open();const saved=h.client.snapshot().selected.store;await h.client.loadOlder();assert.deepEqual(h.client.snapshot().selected.store,saved);assert.equal(h.client.snapshot().selected.content_operations[0].error.category,'protocol');assert.equal(h.client.snapshot().selected.observation,'streaming');await h.close();
});
for(const kind of ['invalid later entity','UTF8 overlap conflict'])test(`live ${kind} rejects whole frame with prior store/cursor intact`,async()=>{
  const h=harness();await h.open();const saved=h.client.snapshot().selected.store;
  const e=kind==='invalid later entity'?{...entry({revision:'6'}),private:'private'}:entry({revision:'6',fields:[field({text:'xyz'})]});
  h.streams[0].push(batch([{kind:'session.upsert',session:session('6',{title:'Must not publish'})},upsert(e,block({revision:'6'}))],'6'));await flush();assert.deepEqual(h.client.snapshot().selected.store,saved);assert.equal(h.client.snapshot().selected.observation,'disconnected');await h.close();
});
test('good complete frame prefix survives later malformed suffix in the controller',async()=>{
  const h=harness();await h.open();h.streams[0].push(`event: wi.conversation\nid: ${batch().next_after}\ndata: ${JSON.stringify(batch())}\n\nevent: wi.conversation\ndata: {\n\n`);await flush();assert.equal(h.client.snapshot().selected.store.live_after,batch().next_after);assert.equal(h.client.snapshot().selected.observation,'disconnected');await h.close();
});
test('Send publishes immutable pending before await, protects duplicate submit and uses exact original retry body',async()=>{
  const wait=deferred();let posts=0;const h=harness(c=>c.path.endsWith('/runs')?(++posts===1?wait.promise:reply(acceptance(c),202)):undefined);await h.open();h.client.setDraft(' \nTask\u0000🙂');const sending=h.client.sendTask();await h.client.sendTask();assert.equal(pending(h).phase,'sending');assert.ok(Object.isFrozen(pending(h).command.body));await flush();assert.equal(posts,1);const body=h.calls.at(-1).init.body;
  h.client.setDraft('Edited');wait.reject(Error('private lost'));await sending;assert.equal(pending(h).phase,'uncertain');await h.client.retryCommand(pending(h).command.id);assert.equal(h.calls.at(-1).init.body,body);assert.equal(pending(h).phase,'accepted');assert.equal(h.client.snapshot().draft,'Edited');assert.equal(posts,2);await h.close();
});
for(const [certainty,phase] of [['not_committed','rejected'],['unknown','uncertain']])test(`Task ${certainty} retains exact command as ${phase}`,async()=>{
  const h=harness(c=>c.path.endsWith('/runs')?reply(error('storage.io',certainty),503):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();assert.equal(pending(h).phase,phase);assert.equal(pending(h).command.body.text,'Task');await h.close();
});
test('matching acceptance in an error proves acceptance with notices, no execution completion',async()=>{
  const notice={scope:'project',source_label:'synthetic',kind:'skipped_symlink'};
  const h=harness(c=>c.path.endsWith('/runs')?reply(error('storage.io','unknown',acceptance(c).receipt,[notice]),503):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();assert.equal(pending(h).phase,'accepted');assert.deepEqual(pending(h).notices,[notice]);assert.equal(h.client.snapshot().selected.store.blocks[0].view.state,'running');await h.close();
});
test('202 cleanup warning/notices survive rebase; receipt proves acceptance without range proof',async()=>{
  const notice={scope:'project',source_label:'synthetic',kind:'skipped_symlink'};
  const h=harness(c=>c.path.endsWith('/runs')?reply(acceptance(c,{warning_code:'storage.connection_cleanup_failed',notices:[notice]}),202):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();assert.equal(pending(h).phase,'accepted');assert.equal(pending(h).reply.warning_code,'storage.connection_cleanup_failed');const old=pending(h);h.client.setDraft('Next');await h.client.reconnectLatest();assert.deepEqual(pending(h),old);assert.equal(h.client.snapshot().draft,'Next');await h.close();
});
test('acceptance commit unknown retains frozen original command and edited draft until Disconnect clears bookkeeping',async t=>{
  const text='  Unknown acceptance 雪\n<em>task & inert</em>\n  ',edit='  edited but not sent 雪\n<em>unsent</em>  ';
  const wait=deferred();
  const h=harness(c=>{
    if(c.path.endsWith('/conversation'))return reply(page({snapshot_head:'1',session:session('1'),block:null,entries:[],previous_block:null,live_after:cursor('l','1','3','','')}));
    if(c.path.endsWith('/runs'))return wait.promise;
  });t.after(()=>h.close());await h.open();h.client.setDraft(text);
  const sending=h.client.sendTask(),command=pending(h).command;
  assert.ok(Object.isFrozen(command));assert.ok(Object.isFrozen(command.body));
  assert.deepEqual(command,{id:OID,kind:'task',session_id:SID,body:{operation_id:OID,run_id:RID,text}});
  assert.equal(new Set([SID,OID,RID]).size,3);
  await flush();const call=h.calls.find(c=>c.init.method==='POST');
  assert.equal(call.init.body,JSON.stringify(command.body));assert.equal(call.path,`/v1/sessions/${SID}/runs`);
  wait.resolve(reply({...error('storage.commit_unknown'),stage:'acceptance'},503));await sending;
  assert.equal(pending(h).phase,'uncertain');assert.equal(h.client.snapshot().draft,text);
  h.client.setDraft(edit);await flush();
  assert.deepEqual(pending(h).command,command);assert.ok(Object.isFrozen(pending(h).command.body));
  assert.equal(Buffer.byteLength(pending(h).command.body.text),Buffer.byteLength(text));
  assert.equal(h.client.snapshot().draft,edit);assert.equal(pending(h).receipt,null);assert.equal(pending(h).reply,null);
  assert.deepEqual(pending(h).notices,[]);assert.equal(pending(h).reconciliation,null);
  assert.equal(pending(h).error.server.certainty,'unknown');assert.deepEqual(h.client.snapshot().selected.store.blocks,[]);
  assert.equal(h.client.snapshot().selected.run_view,null);assert.equal(h.client.snapshot().selected.cancel,null);
  await h.close();const cleared=h.client.snapshot();
  assert.equal(cleared.connection,'disconnected');assert.equal(cleared.draft,'');assert.deepEqual(cleared.pending,[]);
  assert.equal(cleared.selected,null);assert.equal(cleared.settings,null);assert.equal(cleared.catalog,null);assert.equal(cleared.error,null);
  assert.equal(h.streams[0].cancels,1);assert.equal(h.calls.find(c=>c.path.includes('/conversation/events?')).init.signal.aborted,true);
  assert.equal(call.init.body,JSON.stringify(command.body));assert.equal(command.body.text,text);
  assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);
});
test('cleanup warning reply alone clears matching draft once; live acceptance cannot invent a receipt or clear later edits',async t=>{
  const text='  Add 17 and 25. 雪\n<em>task & inert</em>\n',edit='  edited but not sent 雪\n<em>unsent</em>  ';
  const wait=deferred();
  const h=harness(c=>{
    if(c.path.endsWith('/conversation'))return reply(page({snapshot_head:'1',session:session('1'),block:null,entries:[],previous_block:null,live_after:cursor('l','1','3','','')}));
    if(c.path.endsWith('/runs'))return wait.promise;
  });t.after(()=>h.close());await h.open();
  const transitions=[];let previous=h.client.snapshot().draft;
  const off=h.client.subscribe(s=>{if(s.draft!==previous){transitions.push({from:previous,to:s.draft,phase:s.pending[0]?.phase,receipt:s.pending[0]?.receipt});previous=s.draft;}});t.after(off);
  h.client.setDraft(text);const sending=h.client.sendTask(),command=pending(h).command;
  assert.ok(Object.isFrozen(command));assert.ok(Object.isFrozen(command.body));
  assert.deepEqual(command,{id:OID,kind:'task',session_id:SID,body:{operation_id:OID,run_id:RID,text}});
  await flush();const call=h.calls.find(c=>c.init.method==='POST');assert.equal(call.init.body,JSON.stringify(command.body));
  const acceptedBlock=block({revision:'2',state:'accepted',human:human({fields:[field({field_id:'text',order_key:'0',generation:'2',text,total_bytes:String(Buffer.byteLength(text)),to_byte:String(Buffer.byteLength(text))})]})});
  h.streams[0].push(batch([{kind:'block.upsert',block:acceptedBlock}],'3'));await flush();
  assert.equal(h.client.snapshot().selected.store.blocks[0].view.state,'accepted');
  assert.equal(h.client.snapshot().draft,text);assert.equal(pending(h).phase,'sending');
  assert.equal(pending(h).receipt,null);assert.equal(pending(h).reply,null);assert.equal(transitions.filter(x=>x.to==='').length,0);
  const actual=acceptance(call,{receipt:{operation_id:OID,session_id:SID,run_id:RID,first_sequence:'2',last_sequence:'3'},warning_code:'storage.connection_cleanup_failed'});
  wait.resolve(reply(actual,202));await sending;
  assert.equal(h.client.snapshot().draft,'');assert.equal(pending(h).phase,'accepted');assert.deepEqual(pending(h).receipt,actual.receipt);
  assert.deepEqual(pending(h).reply,actual);assert.deepEqual(pending(h).command,command);assert.ok(Object.isFrozen(pending(h).command.body));
  assert.deepEqual(transitions.filter(x=>x.to===''),[{from:text,to:'',phase:'accepted',receipt:actual.receipt}]);
  h.client.setDraft(edit);
  for(const head of ['4','5']){h.streams[0].push(batch([{kind:'block.upsert',block:{...acceptedBlock,revision:head}}],head));await flush();}
  assert.equal(h.client.snapshot().draft,edit);assert.equal(transitions.filter(x=>x.to==='').length,1);
  assert.deepEqual(pending(h).reply,actual);assert.deepEqual(pending(h).command,command);assert.deepEqual(pending(h).notices,[]);
  const facts=h.client.snapshot().selected.store.blocks[0].view;
  assert.equal(facts.state,'accepted');assert.equal(facts.result_recorded,false);assert.equal(facts.outcome,null);assert.equal(facts.summary,null);
  assert.equal(facts.events_complete,null);assert.equal(facts.sink_error,null);assert.equal(h.client.snapshot().selected.run_view,null);
  assert.equal(call.init.body,JSON.stringify(command.body));assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);
  off();await h.close();assert.deepEqual(h.client.snapshot().pending,[]);
});
for(const result of ['accepted','not_found','conflict','read_failure'])test(`off-screen protected reconcile ${result} preserves exact body and never walks raw history`,async()=>{
  const h=harness(c=>{
    if(c.path.endsWith('/runs'))return Promise.reject(Error('lost'));
    if(c.path.endsWith('/reconcile')){
      if(result==='conflict')return reply(error('storage.command_conflict','not_committed'),409);
      if(result==='read_failure')return reply(error(),503);
      if(result==='not_found')return reply({api_version:1,state:'not_found',acceptance:null,run:null});
      const a=acceptance(c);return reply({api_version:1,state:'accepted',acceptance:a.receipt,run:{api_version:1,run_id:a.receipt.run_id,state:'running',user_text:JSON.parse(c.init.body).text,accepted_sequence:'2',terminal_sequence:null,result_sequence:null,result_recorded:false,result:null}});
    }
  });await h.open();h.client.setDraft('Task');await h.client.sendTask();const command=pending(h).command,body=h.calls.at(-1).init.body;await h.client.selectSession(OTHER);h.client.setDraft('Other draft');const window=h.client.snapshot().selected.store;await h.client.reconcileTask(command.id);
  assert.equal(h.calls.at(-1).init.body,body);assert.equal(h.calls.at(-1).path,`/v1/sessions/${SID}/runs/reconcile`);assert.equal(h.calls.at(-1).init.method,'POST');assert.deepEqual(h.client.snapshot().selected.store,window);assert.equal(h.client.snapshot().selected.run_view,null);assert.equal(h.client.snapshot().draft,'Other draft');
  assert.equal(pending(h).phase,result==='accepted'?'accepted':result==='conflict'?'conflict':'uncertain');if(result==='not_found')assert.equal(pending(h).reconciliation,'not_found');if(result==='read_failure')assert.equal(pending(h).error.category,'http');assert.ok(!h.calls.some(c=>/\/history|\/operations|\/events\?/.test(c.path)&&!c.path.includes('/conversation/')));await h.close();
});
for(const key of ['operation_id','session_id','run_id','text'])test(`reconcile rejects wrong returned ${key}`,async()=>{
  const h=harness(c=>{if(c.path.endsWith('/runs'))return Promise.reject(Error('lost'));if(c.path.endsWith('/reconcile')){const a=acceptance(c),body=JSON.parse(c.init.body),run={api_version:1,run_id:body.run_id,state:'running',user_text:body.text,accepted_sequence:'2',terminal_sequence:null,result_sequence:null,result_recorded:false,result:null};if(key==='text')run.user_text='Wrong';else a.receipt[key]=OTHER;return reply({api_version:1,state:'accepted',acceptance:a.receipt,run});}});await h.open();h.client.setDraft('Task');await h.client.sendTask();await h.client.reconcileTask(pending(h).command.id);assert.notEqual(pending(h).phase,'accepted');assert.equal(pending(h).error.category,'protocol');await h.close();
});
test('reconcile not_found cannot revoke known acceptance; reload construction never submits',async()=>{
  const h=harness(c=>c.path.endsWith('/runs')?reply(acceptance(c),202):c.path.endsWith('/reconcile')?reply({api_version:1,state:'not_found',acceptance:null,run:null}):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();const receipt=pending(h).receipt;await h.client.reconcileTask(pending(h).command.id);assert.equal(pending(h).phase,'accepted');assert.deepEqual(pending(h).receipt,receipt);const fresh=harness();assert.equal(fresh.calls.length,0);assert.equal(fresh.client.snapshot().pending.length,0);await h.close();await fresh.close();
});
for(const mode of ['selection','rebase'])test(`late task receipt after ${mode} updates only captured bookkeeping, not draft/store`,async()=>{
  const wait=deferred();const h=harness(c=>c.path.endsWith('/runs')?wait.promise:undefined);await h.open();h.client.setDraft('Task');const send=h.client.sendTask();await flush();const call=h.calls.at(-1);
  if(mode==='selection')await h.client.selectSession(OTHER);else await h.client.reconnectLatest();h.client.setDraft('Task');const saved=h.client.snapshot().selected.store;wait.resolve(reply(acceptance(call),202));await send;assert.equal(pending(h).phase,'accepted');assert.equal(h.client.snapshot().draft,'Task');assert.deepEqual(h.client.snapshot().selected.store,saved);await h.close();
});
test('discarded and aborted waiters never auto-retry; stale receipts cannot recreate commands',async()=>{
  const wait=deferred();const h=harness(c=>c.path.endsWith('/runs')?wait.promise:undefined);await h.open();h.client.setDraft('Task');const send=h.client.sendTask();await flush();const call=h.calls.at(-1),id=pending(h).command.id;h.client.discardCommand(id);wait.resolve(reply(acceptance(call),202));await send;await flush();assert.equal(h.client.snapshot().pending.length,0);assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);await h.close();
});
test('explicit Cancel alone posts empty body for server active state; disconnect only stops reader',async()=>{
  const h=harness(c=>c.path.endsWith('/cancel')?reply({api_version:1,session_id:SID,run_id:RID,disposition:'requested'},202):undefined);await h.open();await h.client.cancelCurrentRun();assert.equal(h.calls.at(-1).init.body,'{}');assert.equal(h.client.snapshot().selected.cancel.disposition,'requested');assert.equal(h.client.snapshot().selected.store.blocks[0].view.state,'running');await h.close();assert.equal(h.calls.filter(c=>c.path.endsWith('/cancel')).length,1);
});
test('invalid IDs reject before fetch; completed server blocks cannot be cancelled',async()=>{
  const h=harness(c=>c.path.endsWith('/conversation')?reply(page({block:block({state:'completed'})})):undefined);await h.open();const n=h.calls.length;await h.client.readRun('bad');await h.client.refreshEntry(RID,'../');await h.client.selectSession('bad');await h.client.cancelCurrentRun();assert.equal(h.calls.length,n);await h.close();
});
test('catalog ID keysets and explicit refresh stay as-of; create rename refresh and addressed run retain exact DTOs',async()=>{
  let lists=0;const h=harness(c=>{
    if(c.path.startsWith('/v1/sessions?')){lists++;if(lists===1)return reply(catalog([cat(SID)],true));if(c.path.includes('after_id='))return reply(catalog([cat(OTHER)]));return reply(catalog());}
    if(c.path==='/v1/sessions'&&c.init.method==='POST'){const b=JSON.parse(c.init.body);return reply({api_version:1,session_id:SID,receipt:{operation_id:b.operation_id,session_id:SID,run_id:null,first_sequence:'1',last_sequence:'1'},duplicate:false,warning_code:null},201);}
    if(c.path.endsWith('/rename')){const b=JSON.parse(c.init.body);return reply({api_version:1,receipt:{operation_id:b.operation_id,session_id:SID,run_id:null,first_sequence:'5',last_sequence:'5'},duplicate:false,warning_code:null,catalog_refresh:'failed'});}
    if(c.path.endsWith('/refresh'))return reply({api_version:1,session_id:SID,disposition:'updated'});
    if(c.path===`/v1/sessions/${SID}/runs/${RID}`)return reply({api_version:1,run_id:RID,state:'running',user_text:'Task',accepted_sequence:'2',terminal_sequence:null,result_sequence:null,result_recorded:false,result:null});
  });await h.open();await h.client.loadMoreSessions();assert.equal(h.client.snapshot().catalog.entries.length,2);assert.ok(h.calls.some(c=>c.path===`/v1/sessions?limit=32&after_id=${SID}`));await h.client.refreshSessions();assert.equal(h.client.snapshot().catalog.entries.length,0);
  await h.client.createSession(' \nTitle','/synthetic/project');await h.client.renameSession('Exact\nRename');await h.client.refreshCatalog();await h.client.readRun(RID);assert.equal(h.client.snapshot().selected.run_view.user_text,'Task');assert.equal(h.client.snapshot().pending.filter(p=>p.phase==='accepted').length,3);assert.equal(JSON.parse(h.calls.find(c=>c.path.endsWith('/rename')).init.body).title,'Exact\nRename');await h.close();
});
test('descriptor chain stays navigable after byte frontier clears; exact consumed content provenance finishes layout',async()=>{
  const token=cursor('c',RID,'e:4:0','4',FID,'4','2');
  const tail=entry({fields:[fragment('c',2,3)],earlier_content:token,content_complete:false});let reads=0;
  const h=harness(c=>c.path.endsWith('/conversation')?reply(page({entries:[tail]})):c.path.includes('/content?')?reply(addressed(entry({fields:[reads++===0?fragment('abc',0,3):fragment('ab',0,3)],earlier_content:null,content_complete:false}))):undefined);
  await h.open();await h.client.loadOlder();const loaded=h.client.snapshot().selected.store.blocks[0].entries[0];
  assert.equal(loaded.earlier_content,null);assert.equal(loaded.content_complete,false);assert.equal(loaded.content_traversal.earlier_content,token);
  await h.client.loadOlder();assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].content_complete,true);assert.equal(reads,2);
  assert.equal(h.calls.at(-1).path,`/v1/sessions/${SID}/conversation/content?cursor=${token}`);await h.close();
});
test('many empty descriptor fragments advance one read at a time before any older block',async()=>{
  const fields=[FID,SECOND,'c'.repeat(64)].map((id,i)=>field({field_id:id,order_key:order(2,BigInt(i)),kind:'unsupported',text:'',total_bytes:'0',to_byte:'0'}));
  const piece=i=>entry({fields:[fields[i]],earlier_content:i===0?null:cursor('c',RID,'e:4:0','4',fields[i].field_id,'4','0'),content_complete:i===0});let reads=0;
  const h=harness(c=>c.path.endsWith('/conversation')?reply(page({entries:[piece(2)]})):c.path.includes('/content?')?reply(addressed(piece(1-reads++))):undefined);
  await h.open();await h.client.loadOlder();assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].content_complete,false);await h.client.loadOlder();assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].fields.length,3);assert.equal(h.client.snapshot().selected.store.blocks[0].entries[0].content_complete,true);assert.equal(reads,2);assert.ok(!h.calls.some(c=>c.path.includes('?before=')));await h.close();
});
for(const mode of ['selection','rebase','connection'])test(`stale older read after ${mode} cannot publish or release newer admission`,async()=>{
  const old=deferred();const h=harness(c=>c.path.includes('?before=')?old.promise:undefined);await h.open();const wait=h.client.loadOlder();await flush();
  if(mode==='selection')await h.client.selectSession(OTHER);else if(mode==='rebase')await h.client.reconnectLatest();else{await h.client.connect(NEW_TOKEN);await h.client.selectSession(OTHER);}
  await flush();const saved=h.client.snapshot();old.resolve(reply(page({block:null,entries:[],previous_block:null,live_after:null})));await wait;await flush();assert.deepEqual(h.client.snapshot(),saved);await h.close();
});
for(const mode of ['selection','rebase','connection'])test(`ignored-abort old SSE reader completion after ${mode} cannot apply frames or shutdown`,async()=>{
  const read=deferred();let releases=0,cancels=0,events=0;
  const body={getReader:()=>({read:()=>read.promise,cancel:async()=>{cancels++;},releaseLock:()=>{releases++;}}),cancel:async()=>{cancels++;}};
  const h=harness(c=>c.path.includes('/conversation/events?')&&++events===1?{status:200,headers:new Headers({'Content-Type':'text/event-stream'}),body}:undefined);await h.open();
  if(mode==='selection')await h.client.selectSession(OTHER);else if(mode==='rebase')await h.client.reconnectLatest();else{await h.client.connect(NEW_TOKEN);await h.client.selectSession(OTHER);}
  await flush();const saved=h.client.snapshot();read.resolve({done:false,value:new TextEncoder().encode('event: wi.closed\ndata: {"api_version":1,"reason":"shutdown"}\n\n')});await flush();assert.deepEqual(h.client.snapshot(),saved);assert.ok(cancels>=1);assert.equal(releases,1);await h.close();
});
test('live append during content read preserves fixed boundary and current field bytes',async()=>{
  const wait=deferred(),token=cursor('c',RID,'e:4:0','4',FID,'4','3');const tail=entry({fields:[fragment('def',3,6)],content_complete:false,earlier_content:token});
  const h=harness(c=>c.path.endsWith('/conversation')?reply(page({entries:[tail]})):c.path.includes('/content?')?wait.promise:undefined);await h.open();const older=h.client.loadOlder();await flush();
  h.streams[0].push(batch([upsert(entry({revision:'6',fields:[fragment('ghi',6,9)],content_complete:false,earlier_content:cursor('c',RID,'e:4:0','4',FID,'4','6')}),block({revision:'6'}))],'6'));await flush();
  wait.resolve(reply(addressed(entry({fields:[fragment('abc',0,6)],earlier_content:null,content_complete:false}),block({revision:'6'}),'6')));await older;
  const s=h.client.snapshot().selected.store,e=s.blocks[0].entries[0];assert.equal(e.fields[0].ranges[0].text,'abcdefghi');assert.equal(e.view.revision,'6');assert.equal(e.fields[0].total_bytes,'9');assert.equal(e.content_complete,false);assert.equal(s.live_after,cursor('l','6','3','',''));assert.equal(h.calls.at(-1).path,`/v1/sessions/${SID}/conversation/content?cursor=${token}`);await h.close();
});
test('aborting a command waiter retains uncertainty and requires explicit retry',async()=>{
  const wait=deferred();let posts=0;const h=harness(c=>c.path.endsWith('/runs')?(++posts===1?wait.promise:reply(acceptance(c),202)):undefined);await h.open();h.client.setDraft('Task');const send=h.client.sendTask();await flush();const id=pending(h).command.id,call=h.calls.at(-1);h.client.abortCommandWaiter(id);await send;assert.equal(pending(h).phase,'uncertain');assert.equal(pending(h).error.category,'aborted');wait.resolve(reply(acceptance(call),202));await flush();assert.equal(pending(h).phase,'uncertain');assert.equal(posts,1);await h.client.retryCommand(id);assert.equal(posts,2);assert.equal(pending(h).phase,'accepted');await h.close();
});
test('a not_committed retry reply cannot revoke an earlier unknown Task',async()=>{
  let n=0;const h=harness(c=>c.path.endsWith('/runs')?reply(error('storage.io',++n===1?'unknown':'not_committed'),503):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();await h.client.retryCommand(pending(h).command.id);assert.equal(pending(h).phase,'uncertain');await h.close();
});
for(const status of [200,201,204])test(`Task wrong success status ${status} is not acceptance`,async()=>{
  const h=harness(c=>c.path.endsWith('/runs')?(status===204?new Response(null,{status,headers:{'Content-Type':'application/json'}}):reply(acceptance(c),status)):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();assert.equal(pending(h).phase,'uncertain');assert.equal(pending(h).receipt,null);assert.equal(pending(h).error.category,'protocol');await h.close();
});
test('metadata late receipt does not request manifest or mutate another selected session',async()=>{
  const wait=deferred();const h=harness(c=>c.path.endsWith('/rename')?wait.promise:undefined);await h.open();const rename=h.client.renameSession('Exact');await flush();const call=h.calls.at(-1),oid=JSON.parse(call.init.body).operation_id;await h.client.selectSession(OTHER);await flush();const saved=h.client.snapshot().selected;
  wait.resolve(reply({api_version:1,receipt:{operation_id:oid,session_id:SID,run_id:null,first_sequence:'5',last_sequence:'5'},duplicate:false,warning_code:'storage.connection_cleanup_failed',catalog_refresh:'not_attempted'}));await rename;assert.equal(pending(h).phase,'accepted');assert.deepEqual(h.client.snapshot().selected,saved);assert.ok(!h.calls.some(c=>c.path===`/v1/sessions/${SID}`));await h.close();
});
test('catalog rejects descending ID pages rather than regrouping or inventing recency',async()=>{
  const h=harness(c=>c.path.startsWith('/v1/sessions?')?reply(catalog([cat(OTHER),cat(SID)])):undefined);await h.client.connect(TOKEN);assert.equal(h.client.snapshot().connection,'disconnected');assert.equal(h.client.snapshot().error.category,'protocol');await h.close();
});
test('fresh connection401 clears memory; invalid Connect cannot fetch',async()=>{
  const h=harness(c=>c.path==='/v1/settings'?reply(error('api.unauthorized'),401):undefined);await h.client.connect(TOKEN);assert.equal(h.client.snapshot().connection,'disconnected');assert.equal(h.client.snapshot().error.category,'authentication');const n=h.calls.length;await h.client.connect('bad');assert.equal(h.calls.length,n);assert.equal(h.client.snapshot().error.category,'invalid_token');await h.close();
});
test('newer metadata alone cannot disguise a zero-progress older content contradiction',async()=>{
  const token=cursor('c',RID,'e:4:0','4',FID,'4','1');const tail=entry({fields:[fragment('bc',1,3)],content_complete:false,earlier_content:token});
  const h=harness(c=>c.path.endsWith('/conversation')?reply(page({entries:[tail]})):c.path.includes('/content?')?reply(addressed({...tail,revision:'6'},block({revision:'6'}),'6')):undefined);await h.open();const old=h.client.snapshot().selected.store;await h.client.loadOlder();assert.deepEqual(h.client.snapshot().selected.store,old);assert.equal(h.client.snapshot().selected.content_operations[0].error.category,'protocol');assert.equal(h.client.snapshot().selected.observation,'streaming');await h.close();
});
test('accepted Task cannot be retried and every explicit POST keeps protected init and exact closed body',async()=>{
  const h=harness(c=>c.path.endsWith('/runs')?reply(acceptance(c),202):undefined);await h.open();h.client.setDraft('Task');await h.client.sendTask();const id=pending(h).command.id,n=h.calls.length;await h.client.retryCommand(id);assert.equal(h.calls.length,n);assert.equal(h.client.snapshot().error.category,'invalid_action');
  const c=h.calls.at(-1);assert.equal(c.init.method,'POST');assert.equal(c.init.headers['Content-Type'],'application/json');assert.equal(c.init.headers.Accept,'application/json');assert.equal(c.init.headers.Authorization,`Bearer ${TOKEN}`);assert.equal(c.init.credentials,'omit');assert.equal(c.init.redirect,'error');assert.equal(c.init.cache,'no-store');assert.equal(c.init.mode,'same-origin');assert.equal(c.init.referrerPolicy,'no-referrer');assert.deepEqual(JSON.parse(c.init.body),pending(h).command.body);await h.close();
});
for(const [name,response] of [['media',()=>reply({},200,'text/plain')],['status',()=>reply({},202)],['http error',()=>reply(error(),503)],['null stream',()=>new Response(null,{headers:{'Content-Type':'text/event-stream'}})]])test(`display observation rejects ${name} safely and retains snapshot`,async()=>{
  const h=harness(c=>c.path.includes('/conversation/events?')?response():undefined);await h.open();assert.equal(h.client.snapshot().selected.store.blocks.length,1);assert.equal(h.client.snapshot().selected.observation,'disconnected');assert.ok(h.client.snapshot().selected.observation_error);assert.equal(h.calls.length,4);await h.close();
});
for(const action of ['readRun','cancelCurrentRun'])test(`stale ${action} completion cannot change new selected UI`,async()=>{
  const wait=deferred();const h=harness(c=>c.path===`/v1/sessions/${SID}/runs/${RID}`||c.path.endsWith('/cancel')?wait.promise:undefined);await h.open();const pending=action==='readRun'?h.client.readRun(RID):h.client.cancelCurrentRun();await flush();await h.client.selectSession(OTHER);await flush();const saved=h.client.snapshot().selected;
  wait.resolve(action==='readRun'?reply({api_version:1,run_id:RID,state:'running',user_text:'Task',accepted_sequence:'2',terminal_sequence:null,result_sequence:null,result_recorded:false,result:null}):reply({api_version:1,session_id:SID,run_id:RID,disposition:'requested'},202));await pending;await flush();assert.deepEqual(h.client.snapshot().selected,saved);await h.close();
});
for(const action of ['disconnect','discard'])test(`reconcile publication cannot recreate a command after subscriber ${action}`,async()=>{
  const h=harness(c=>{if(c.path.endsWith('/runs'))return Promise.reject(Error('lost'));if(c.path.endsWith('/reconcile')){const a=acceptance(c),body=JSON.parse(c.init.body);return reply({api_version:1,state:'accepted',acceptance:a.receipt,run:{api_version:1,run_id:body.run_id,state:'running',user_text:body.text,accepted_sequence:'2',terminal_sequence:null,result_sequence:null,result_recorded:false,result:null}});}});await h.open();h.client.setDraft('Task');await h.client.sendTask();const id=pending(h).command.id;let fired=false;
  h.client.subscribe(s=>{if(!fired&&s.pending.some(p=>p.command?.id===id&&p.phase==='accepted')){fired=true;if(action==='disconnect')h.client.disconnect();else h.client.discardCommand(id);}});
  await h.client.reconcileTask(id);assert.equal(fired,true);assert.equal(h.client.snapshot().pending.length,0);if(action==='disconnect'){assert.equal(h.client.snapshot().connection,'disconnected');assert.equal(h.client.snapshot().selected,null);}await h.close();
});
// Each reentrant subscriber only records or acts. Assert after every callback returns.
function consumers(client,predicate,action){
  let armed=false,fired=false,obsolete=null,inner;
  const deliveries=[],states=[[],[],[]],off=[];
  for(let index=0;index<3;index++)off.push(client.subscribe(s=>{
    states[index].push(s);deliveries.push({index,state:s});
    if(index===0&&armed&&!fired&&predicate(s)){fired=true;obsolete=s;inner=action(s);}
  }));
  return {arm(){armed=true;},async finish(){await inner;await flush();},check(){
    assert.equal(fired,true,'The nested action must reach the tested boundary');
    assert.equal(deliveries.some(d=>d.index>0&&d.state===obsolete),false,'A later consumer must never receive the superseded publication, even transiently');
    for(const seen of states)assert.deepEqual(seen.at(-1),client.snapshot());
  },close(){for(const unsubscribe of off)unsubscribe();}};
}
function reconcileReply(call,receipt=acceptance(call).receipt,text=JSON.parse(call.init.body).text){return {api_version:1,state:'accepted',acceptance:receipt,run:{api_version:1,run_id:JSON.parse(call.init.body).run_id,state:'running',user_text:text,accepted_sequence:receipt.first_sequence,terminal_sequence:null,result_sequence:null,result_recorded:false,result:null}};}

for(const boundary of ['clearing','connecting'])for(const nested of ['disconnect','valid Connect','invalid Connect'])for(const outer of boundary==='clearing'?['valid','invalid']:['valid'])test(`Connect ${outer} ${boundary} subscriber ${nested} owns credentials and readers`,async t=>{
  const h=harness();t.after(()=>h.close());await h.open();
  let armed=false,fired=false,inner;const publications=[];
  const off=h.client.subscribe(s=>{publications.push(s);if(armed&&!fired&&s.connection===(boundary==='clearing'?'disconnected':'connecting')){fired=true;if(nested==='disconnect')h.client.disconnect();else inner=h.client.connect(nested==='valid Connect'?NEW_TOKEN:'bad');}});t.after(off);
  const start=h.calls.length;armed=true;await h.client.connect(outer==='valid'?TOKEN:'bad');await inner;await flush();
  assert.equal(fired,true);const calls=h.calls.slice(start),now=h.client.snapshot();
  assert.equal(calls.length,nested==='valid Connect'?2:0,'Interrupted Connect must not allocate or fetch outer readers');
  for(const c of calls)assert.ok(c.init.headers.Authorization===`Bearer ${NEW_TOKEN}`,'Only the nested credential owns requests');
  assert.equal(now.connection,nested==='valid Connect'?'connected':'disconnected');
  assert.equal(now.error?.category??null,nested==='invalid Connect'?'invalid_token':null);
  assert.equal(h.streams[0].cancels,1);assert.equal(now.selected,null);assert.equal(now.draft,'');assert.deepEqual(now.pending,[]);
  assert.ok(!JSON.stringify(publications).includes(TOKEN)&&!JSON.stringify(publications).includes(NEW_TOKEN));
  if(nested==='valid Connect'){await h.client.refreshSessions();assert.ok(h.calls.at(-1).init.headers.Authorization===`Bearer ${NEW_TOKEN}`,'Refresh must keep nested credential ownership');}
});

for(const invalid of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), TOKEN+'\n', null, 7])test(`invalid Connect admission type ${typeof invalid}, length ${invalid?.length??'none'}`,async t=>{
  const h=harness();t.after(()=>h.close());await h.client.connect(invalid);assert.equal(h.calls.length,0);assert.equal(h.client.snapshot().connection,'disconnected');assert.equal(h.client.snapshot().error.category,'invalid_token');
});

for(const admission of ['clearing subscriber','ordinary settings','ordinary catalog'])for(const result of ['success','HTTP','network','401'])for(const schedule of ['before settings','during catalog','after catalog'])test(`obsolete Connect ${admission} ${result}; ${schedule}`,async t=>{
  const old=deferred(),freshSettings=deferred(),freshCatalog=deferred();let oldCatalog=0,freshCatalogReads=0;
  // No old fetch owns this promise after the guard. Still observe its synthetic rejection.
  old.promise.catch(()=>{});
  const h=harness(c=>{
    const fresh=c.init.headers.Authorization===`Bearer ${NEW_TOKEN}`;
    if(c.path==='/v1/settings')return fresh?freshSettings.promise:admission==='ordinary catalog'?reply({...settings,model:'old'}):old.promise;
    if(c.path.startsWith('/v1/sessions?')){if(fresh)return ++freshCatalogReads===1?freshCatalog.promise:reply(catalog([cat(OTHER)]));oldCatalog++;return admission==='ordinary catalog'?old.promise:reply(catalog([cat(SID)]));}
  });t.after(()=>h.close());
  const publications=[];let nested,fired=false,armed=false;
  const off=h.client.subscribe(s=>{publications.push(s);if(armed&&!fired&&admission==='clearing subscriber'&&s.connection==='disconnected'){fired=true;nested=h.client.connect(NEW_TOKEN);}});t.after(off);
  armed=true;const outer=h.client.connect(TOKEN);await flush();
  if(admission!=='clearing subscriber'){nested=h.client.connect(NEW_TOKEN);await flush();}
  const staleCall=h.calls.find(c=>c.init.headers.Authorization===`Bearer ${TOKEN}`&&(admission==='ordinary catalog'?c.path.startsWith('/v1/sessions?'):c.path==='/v1/settings'));
  let cancels=0;
  const settleOld=async()=>{
    const saved=h.client.snapshot(),count=publications.length;
    if(result==='network')old.reject(Error('synthetic old failure'));
    else{const value=result==='success'?(admission==='ordinary catalog'?catalog([cat(SID)]):{...settings,model:'old'}):error(result==='401'?'api.unauthorized':'storage.io');const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify(value)));},pull(c){c.close();},cancel(){cancels++;}},{highWaterMark:0});old.resolve(new Response(body,{status:result==='success'?200:result==='401'?401:503,headers:{'Content-Type':'application/json'}}));}
    await outer;await flush();
    assert.deepEqual(h.client.snapshot(),saved,'An obsolete settlement must not mutate current settings/catalog');assert.equal(publications.length,count);
  };
  if(schedule==='before settings')await settleOld();
  freshSettings.resolve(reply({...settings,model:'fresh'}));await flush();
  if(schedule==='during catalog')await settleOld();
  freshCatalog.resolve(reply(catalog([cat(OTHER)])));await nested;await flush();
  if(schedule==='after catalog')await settleOld();
  const now=h.client.snapshot();assert.equal(now.connection,'connected');assert.equal(now.settings.model,'fresh');assert.equal(now.error,null);assert.equal(now.catalog.entries[0].session_id,OTHER);
  if(admission==='clearing subscriber'){assert.equal(fired,true);assert.equal(staleCall,undefined,'Interrupted outer Connect must never admit an old reader');assert.equal(oldCatalog,0);assert.equal(cancels,0);}
  else{assert.ok(staleCall);assert.equal(staleCall.init.signal.aborted,true);assert.equal(cancels,result==='network'?0:1);}
  assert.equal(h.calls.filter(c=>c.path.startsWith('/v1/sessions?')&&c.init.headers.Authorization===`Bearer ${NEW_TOKEN}`).length,1);
  assert.ok(!publications.some(s=>s.connection==='connected'&&s.settings?.model==='old'));
  for(const c of h.calls.filter(c=>c.init.headers.Authorization===`Bearer ${NEW_TOKEN}`))assert.equal(c.init.signal.aborted,false);
  await h.client.refreshSessions();assert.ok(h.calls.at(-1).init.headers.Authorization===`Bearer ${NEW_TOKEN}`,'Explicit refresh keeps current credential ownership');assert.equal(h.client.snapshot().error,null);assert.equal(h.client.snapshot().catalog.entries[0].session_id,OTHER);
});

for(const boundary of ['selection','rebase','store','observer','SSE entry','SSE watermark','older','pending','accepted','uncertain','reconciling','reconciled','discard','draft','transient selection'])test(`synchronous publication supersession across ${boundary} reaches every consumer`,async t=>{
  const h=harness(c=>{
    if(c.path.endsWith('/runs'))return boundary==='uncertain'||boundary==='reconciling'||boundary==='reconciled'?reply(error(),503):reply(acceptance(c),202);
    if(c.path.endsWith('/reconcile'))return reply(reconcileReply(c));
    if(c.path.includes('?before='))return reply(page({block:null,entries:[],previous_block:null,live_after:null}));
  });t.after(()=>h.close());
  if(['selection','store','observer','transient selection'].includes(boundary))await h.client.connect(TOKEN);else await h.open();
  if(['reconciling','reconciled','discard'].includes(boundary)){h.client.setDraft('Exact');await h.client.sendTask();}
  const predicates={
    selection:s=>s.selected?.observation==='loading',rebase:s=>s.selected?.observation==='loading',store:s=>s.selected?.store&&s.selected.observation==='loading',observer:s=>s.selected?.observation==='connecting',
    'SSE entry':s=>s.selected?.store?.observed_head==='6','SSE watermark':s=>s.selected?.store?.observed_head==='5',older:s=>s.selected?.store?.previous_block===null,
    pending:s=>s.pending.some(p=>p.phase==='sending'),accepted:s=>s.pending.some(p=>p.phase==='accepted'),uncertain:s=>s.pending.some(p=>p.phase==='uncertain'),
    reconciling:s=>s.pending.some(p=>p.phase==='reconciling'),reconciled:s=>s.pending.some(p=>p.reconciliation==='accepted'),discard:s=>s.pending.length===0,draft:s=>s.draft==='outer',
    'transient selection':s=>s.selected?.session_id===SID&&s.selected.observation==='loading',
  };
  const watch=consumers(h.client,predicates[boundary],s=>{
    if(boundary==='transient selection')return h.client.selectSession(OTHER);
    if(['selection','rebase','store','observer','SSE entry'].includes(boundary))return h.client.disconnect();
    if(['pending','accepted','uncertain','reconciling','reconciled'].includes(boundary))return h.client.discardCommand(s.pending[0].command.id);
    return h.client.setDraft('nested');
  });t.after(()=>watch.close());watch.arm();const start=h.calls.length;
  if(['selection','store','observer','transient selection'].includes(boundary))await h.client.selectSession(SID);
  else if(boundary==='rebase')await h.client.reconnectLatest();
  else if(boundary==='SSE entry')h.streams[0].push(batch([upsert(entry({revision:'6',fields:[field({text:'abcdef',total_bytes:'6',to_byte:'6'})]}),block({revision:'6'}))],'6'));
  else if(boundary==='SSE watermark')h.streams[0].push(batch([],'5'));
  else if(boundary==='older')await h.client.loadOlder();
  else if(boundary==='reconciling'||boundary==='reconciled')await h.client.reconcileTask(pending(h).command.id);
  else if(boundary==='discard')h.client.discardCommand(pending(h).command.id);
  else if(boundary==='draft')h.client.setDraft('outer');
  else{h.client.setDraft('Exact');await h.client.sendTask();}
  await watch.finish();watch.check();
  const calls=h.calls.slice(start);
  if(['selection','rebase','pending','reconciling','draft','discard'].includes(boundary))assert.equal(calls.length,0);
  if(boundary==='store'||boundary==='observer')assert.equal(calls.length,1);
  if(boundary==='transient selection'){assert.equal(calls.length,2);assert.ok(calls.every(c=>c.path.includes(OTHER)));}
  if(boundary==='older'){assert.equal(h.client.snapshot().selected.store.live_after,cursor('l','4','3','',''));assert.equal(h.client.snapshot().selected.observation,'streaming');}
  assert.equal(calls.filter(c=>c.path.endsWith('/cancel')||c.path.includes('/history')).length,0);
});

test('publication preserves synchronous delivery, exception isolation, unsubscribe and read-only snapshot reentrancy',async t=>{
  const h=harness();t.after(()=>h.close());await h.open();const first=[],last=[];let thrown=0,readonly=0;
  const off1=h.client.subscribe(s=>{first.push(s);h.client.snapshot();readonly++;});
  const off2=h.client.subscribe(()=>{thrown++;throw Error('synthetic view failure');});
  const off3=h.client.subscribe(s=>last.push(s));t.after(()=>{off1();off2();off3();});
  h.client.setDraft('synchronous');assert.equal(first.at(-1).draft,'synchronous');assert.equal(last.at(-1).draft,'synchronous');assert.equal(thrown,2);assert.equal(readonly,2);
  assert.ok(Object.isFrozen(last.at(-1).selected.store.blocks));assert.throws(()=>last.at(-1).pending.push({}));
  off3();h.client.setDraft('next');assert.equal(first.at(-1).draft,'next');assert.equal(last.at(-1).draft,'synchronous');assert.equal(thrown,3);
});

const readOutcomes=['HTTP unknown','HTTP not_committed','HTTP not_applicable','network','extra DTO','media','UTF8','status','operation identity','session identity','run identity','text identity','command conflict','error acceptance conflict','accepted','error acceptance','not_found'];
for(const prior of ['rejected','uncertain','accepted'])for(const outcome of readOutcomes)test(`read-only reconcile retains original ${prior} truth after ${outcome}, off-screen exact bookkeeping`,async t=>{
  const waiting=deferred(),notice={scope:'project',source_label:'synthetic',kind:'skipped_symlink'},readNotice={scope:'project',source_label:'read',kind:'directory_name_mismatch'};
  const h=harness(c=>{
    if(c.path.endsWith('/runs'))return prior==='accepted'?reply(acceptance(c,{warning_code:'storage.connection_cleanup_failed',notices:[notice]}),202):reply(error('storage.io',prior==='rejected'?'not_committed':'unknown',null,[notice]),503);
    if(c.path.endsWith('/reconcile'))return waiting.promise;
  });t.after(()=>h.close());await h.open();const text=' \nExact\u0000🙂';h.client.setDraft(text);await h.client.sendTask();const original=pending(h),command=original.command,body=h.calls.at(-1).init.body;
  assert.equal(original.phase,prior);await h.client.reconnectLatest();await flush();assert.deepEqual(pending(h),original);
  await h.client.selectSession(OTHER);await flush();h.client.setDraft('Other draft');const selected=h.client.snapshot().selected;
  const read=h.client.reconcileTask(command.id);assert.equal(pending(h).phase,'reconciling');await flush();const call=h.calls.at(-1);
  assert.equal(call.path,`/v1/sessions/${SID}/runs/reconcile`);assert.equal(call.init.body,body);assert.deepEqual(JSON.parse(body),command.body);
  let diagnostic=null,phase=prior,receipt=original.receipt,reconciliation=null;
  if(outcome.startsWith('HTTP ')){diagnostic='http';waiting.resolve(reply(error('storage.io',outcome.slice(5),null,[readNotice]),503));}
  else if(outcome==='network'){diagnostic='network';waiting.reject(Error('synthetic read failure'));}
  else if(outcome==='command conflict'){phase='conflict';diagnostic='http';waiting.resolve(reply(error('storage.command_conflict','not_committed',null,[readNotice]),409));}
  else if(outcome==='error acceptance conflict'){phase='conflict';diagnostic='conflict';waiting.resolve(reply(error('storage.io','unknown',{...acceptance(call).receipt,operation_id:OTHER},[readNotice]),503));}
  else if(outcome==='accepted'){phase='accepted';receipt=acceptance(call).receipt;reconciliation='accepted';waiting.resolve(reply(reconcileReply(call)));}
  else if(outcome==='error acceptance'){phase='accepted';receipt=acceptance(call).receipt;diagnostic='http';waiting.resolve(reply(error('storage.io','unknown',receipt,[readNotice]),503));}
  else if(outcome==='not_found'){reconciliation='not_found';waiting.resolve(reply({api_version:1,state:'not_found',acceptance:null,run:null}));}
  else{
    diagnostic='protocol';let value=reconcileReply(call);
    if(outcome==='extra DTO')value.private='must reject';
    if(outcome.endsWith('identity')){const key=outcome.split(' ')[0];if(key==='text')value.run.user_text='Wrong';else value.acceptance[key+'_id']=OTHER;}
    if(outcome==='UTF8')waiting.resolve(new Response(Uint8Array.of(255),{headers:{'Content-Type':'application/json'}}));
    else waiting.resolve(reply(value,outcome==='status'?202:200,outcome==='media'?'text/plain':'application/json'));
  }
  await read;await flush();const now=pending(h);
  assert.equal(now.phase,phase,'Read failure cannot weaken known original-write truth');assert.equal(now.error?.category??null,diagnostic);assert.deepEqual(now.receipt,receipt);assert.deepEqual(now.command,command);assert.equal(now.command.body.text,text);assert.equal(now.reconciliation,reconciliation);
  assert.ok(now.notices.some(n=>n.source_label==='synthetic'));if(outcome.startsWith('HTTP ')||outcome.startsWith('error acceptance')||outcome==='command conflict')assert.ok(now.notices.some(n=>n.source_label==='read'));
  if(prior==='accepted')assert.equal(now.reply.warning_code,'storage.connection_cleanup_failed');
  assert.deepEqual(h.client.snapshot().selected,selected);assert.equal(h.client.snapshot().draft,'Other draft');
  assert.equal(h.calls.filter(c=>c.path.endsWith('/runs')&&c.init.method==='POST').length,1);assert.equal(h.calls.filter(c=>c.path.endsWith('/reconcile')).length,1);assert.equal(h.calls.filter(c=>c.init.method==='POST').length,2);
  assert.equal(h.calls.filter(c=>/\/history|\/operations|\/cancel|\/events\?/.test(c.path)&&!c.path.includes('/conversation/')).length,0);
  await h.client.loadOlder();assert.equal(h.calls.filter(c=>c.path.endsWith('/runs')).length,1);
});

for(const result of ['accepted','error acceptance'])test(`read-only receipt conflict preserves original known receipt after ${result}`,async t=>{
  const h=harness(c=>{if(c.path.endsWith('/runs'))return reply(acceptance(c),202);if(c.path.endsWith('/reconcile')){const receipt={...acceptance(c).receipt,last_sequence:'10'};return result==='accepted'?reply(reconcileReply(c,receipt)):reply(error('storage.io','unknown',receipt),503);}});t.after(()=>h.close());await h.open();h.client.setDraft('Exact');await h.client.sendTask();const original=pending(h);await h.client.reconcileTask(original.command.id);assert.equal(pending(h).phase,'conflict');assert.deepEqual(pending(h).receipt,original.receipt);assert.deepEqual(pending(h).command,original.command);assert.equal(h.calls.filter(c=>c.path.endsWith('/runs')).length,1);
});

for(const boundary of ['reconciling','accepted','reconciled'])for(const nested of ['disconnect','discard','selection','rebase'])test(`reconciliation ownership after ${boundary} subscriber ${nested} protects bookkeeping`,async t=>{
  const h=harness(c=>c.path.endsWith('/runs')?reply(error('storage.io','not_committed'),503):c.path.endsWith('/reconcile')?reply(reconcileReply(c)):undefined);t.after(()=>h.close());await h.open();h.client.setDraft('Exact');await h.client.sendTask();const id=pending(h).command.id;
  const watch=consumers(h.client,s=>s.pending.some(p=>p.command.id===id&&(boundary==='reconciled'?p.reconciliation==='accepted':p.phase===boundary)),()=>{
    if(nested==='disconnect')return h.client.disconnect();if(nested==='discard')return h.client.discardCommand(id);if(nested==='selection')return h.client.selectSession(OTHER);return h.client.reconnectLatest();
  });t.after(()=>watch.close());watch.arm();await h.client.reconcileTask(id);await watch.finish();watch.check();
  const now=h.client.snapshot();if(nested==='disconnect'||nested==='discard')assert.deepEqual(now.pending,[]);else{assert.equal(now.pending[0].phase,'accepted');assert.equal(now.pending[0].reconciliation,'accepted');assert.equal(now.selected.run_view,null);}
  assert.equal(h.calls.filter(c=>c.path.endsWith('/reconcile')).length,boundary==='reconciling'&&(nested==='disconnect'||nested==='discard')?0:1);assert.equal(h.calls.filter(c=>c.path.endsWith('/runs')).length,1);assert.equal(h.calls.filter(c=>c.path.endsWith('/cancel')||c.path.includes('/history')).length,0);
});

test('generated controller has no runtime raw reducer/client dependency or automatic browser storage',()=>{
  const source=fs.readFileSync(new URL('../dist/display-client.js',import.meta.url),'utf8');assert.ok(!/from ['"]\.\/(?:client|state)\.js/.test(source));assert.ok(!/localStorage|sessionStorage|EventSource|document\.|window\./.test(source));
});
