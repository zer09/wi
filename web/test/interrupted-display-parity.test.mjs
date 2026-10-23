import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as f from '../test-support/display-fixtures.mjs';
import { data } from '../test-support/presentation.mjs';
import { richPartialFacts, expectedBlock } from '../test-support/rich-display-parity.mjs';
import { workKeys } from '../test-support/restart-display.mjs';
import { interruptedSnapshot, displayProof, sameDom, collector, newRecord, newFaults, files, publicPrivacy,
  responseHeaders, recoveryOrder, observerWork, browserRequests, cleanupProof, storedHead } from '../test-support/interrupted-display-parity.mjs';

const command = { operation_id: f.OID, run_id: f.RID, text: data.user };
function partial() {
  const indexes = [[0,0,null,0],[1,0,0,null],[2,1,0,null],[3,1,1,null],[4,2,null,null],[5,2,null,null],
    [4,3,null,null],[5,3,null,null],[4,4,null,null],[5,4,null,null],[8,5,null,null]];
  const fields = richPartialFacts.map(([kind,text],i) => { const [rank,output,content,summary] = indexes[i];
    return f.field({field_id:(i+1).toString(16).repeat(64),kind,text,total_bytes:String(Buffer.byteLength(text)),
      to_byte:String(Buffer.byteLength(text)),order_key:f.order(rank,output,content,summary)}); });
  const human = f.human({fields:[f.field({field_id:'text',order_key:'0',generation:'2',text:data.user,
    total_bytes:String(Buffer.byteLength(data.user)),to_byte:String(Buffer.byteLength(data.user))})]});
  return f.page({snapshot_head:'23',session:f.session('23',{title:data.title}),block:f.block({human,revision:'23'}),
    entries:[f.entry({fields,revision:'23'})],previous_block:null,live_after:f.cursor('l','23','3','','')});
}
function interrupted() {
  const p = partial();p.snapshot_head='24';p.session.head_sequence='24';p.session.updated_at_ms='3';
  p.block.state='interrupted';p.block.revision='24';p.entries[0].recorded_state='interrupted';p.entries[0].revision='24';
  p.live_after=f.cursor('l','24','3','','');return p;
}
test('same H24 snapshot preserves rich H23 bytes and matches both exact displays', () => {
  const b=interruptedSnapshot(interrupted(),partial()),c=interruptedSnapshot(interrupted(),partial(),b);
  assert.deepEqual(b,c);assert.equal(displayProof(expectedBlock(b),b),true);assert.equal(sameDom('exact','exact'),true);
});
const changes = {
  H:p=>{p.snapshot_head='25';p.session.head_sequence='25';p.live_after=f.cursor('l','25','3','','');},
  running:p=>{p.block.state='running';},assistant:p=>{p.entries[0].recorded_state='in_progress';},
  result:p=>{p.block.result_recorded=true;},outcome:p=>{p.block.outcome={type:'completed'};},
  human:p=>{p.block.human.recorded_state='interrupted';},anchor:p=>{p.block.human.entry_id='e:3:0';},
  run:p=>{p.block.run_id=f.OTHER;},session:p=>{p.session_id=f.OTHER;},
  identity:p=>{p.entries[0].fields[0].field_id='f'.repeat(64);},entry:p=>{p.entries[0].entry_id='e:5:0';},
  text:p=>{p.entries[0].fields[0].text+=' ';},user:p=>{p.block.human.fields[0].text+=' ';},
  missing:p=>{p.entries[0].fields.splice(1,1);},reordered:p=>{p.entries[0].fields.reverse();},
  duplicate:p=>{p.entries.push(p.entries[0]);},absent:p=>{p.entries=[];},
  epoch:p=>{p.entries[0].content_epoch='5';},generation:p=>{p.entries[0].fields[0].generation='5';},
  range:p=>{p.entries[0].fields[0].from_byte='1';},length:p=>{p.entries[0].fields[0].total_bytes='1';},
  order:p=>{p.entries[0].fields[0].order_key=f.order(0,6,null,0);},provisional:p=>{p.entries[0].provisional=false;},
  metadata:p=>{p.block.summary={};},private:p=>{p.entries[0].secret='synthetic';},
};
for(const [name,change] of Object.entries(changes)) test(`actual interrupted snapshot rejects ${name}`,()=>{
  const p=interrupted();change(p);assert.throws(()=>interruptedSnapshot(p,partial(),interrupted()));
});
for(const [name,change]of Object.entries({missing:v=>v.entries.pop(),order:v=>v.entries.reverse(),fields:v=>v.entries[1].fields.reverse(),
  identity:v=>{v.entries[0].entry_id='wrong';},text:v=>{v.entries[1].fields[0].ranges[0].text+=' ';},
  status:v=>{v.status='Execution: completed.';},generation:v=>{v.entries[1].fields[0].metadata+=' ';}}))test(`actual DOM assertion rejects ${name}`,()=>{
  const v=expectedBlock(interrupted());change(v);assert.throws(()=>displayProof(v,interrupted()));
});
for(const [b,c]of [['',''],['b','c'],[null,null]])test('normalized DOM equality rejects absent/changed markup',()=>assert.throws(()=>sameDom(b,c)));

const origin='http://127.0.0.1:1234',base=`/v1/sessions/${f.SID}/conversation`,owner='synthetic-owner';
const headers=type=>({'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});
function request(path=base,method='GET',extra={}) {return {url:()=>origin+path,method:()=>method,
  headers:()=>({authorization:`Bearer ${owner}`,...extra}),postDataJSON:()=>command};}
function response(req,type='application/json',status=200,extra={}) {return {url:req.url,request:()=>req,status:()=>status,headers:()=>({...headers(type),...extra}),body:()=>{throw new Error('Body must not be observed');}};}
function collecting(index=1) {
  const record=newRecord(),faults=newFaults(),assetReads=[],accepted=[];
  const c=collector({origin,owner,index,record,faults,assetReads,session:()=>f.SID,permission:()=> 'task',command:()=>undefined,acceptCommand:v=>accepted.push(v)});
  return {record,faults,c,assetReads,accepted};
}
function handshake() {
  const h=collecting(),req=request(),reply=response(req),stream=request(`${base}/events?after=${encodeURIComponent(interrupted().live_after)}`);
  h.c.request(req);h.c.response(reply);h.c.request(stream);h.c.response(response(stream,'text/event-stream'));
  return {...h,reply,input:{origin,sid:f.SID,head:'24',value:interrupted(),snapshots:h.record.snapshots,streams:h.record.streams,reply}};
}
test('actual collector binds Request/Response/stream and never reads Latest body',()=>{const h=handshake();assert.equal(h.faults.collector,0);
  const order=recoveryOrder();order.selected();order.displayed(1,h.record,h.reply,'Execution: interrupted. Final result not recorded.');order.handshake(1,h.input);
});
for(const index of [1,2])for(const [path,method]of [[`${base}/../runs`,'POST'],[`/v1/sessions/${f.SID}/runs`,'POST'],
  [`/v1/sessions/${f.SID}/runs/reconcile`,'POST'],[`/v1/sessions/${f.SID}/runs/${f.RID}/cancel`,'POST'],[base,'DELETE'],[base+'?before=x','GET'],[`/v1/sessions/${f.SID}/history`,'GET']])test(`observer ${index} actual collector rejects ${method}/${path}`,()=>{
  const h=collecting(index);h.c.request(request(path,method));
  const taskPath = new URL(path,origin).pathname.endsWith('/runs') && method==='POST';
  assert.equal(h.faults.request,taskPath?2:1);assert.equal(h.accepted.length,0);
});
for(const [name,extra]of Object.entries({missing:{authorization:undefined},cookie:{cookie:'synthetic'},foreign:{origin:'https://external.invalid'},wrong:{authorization:'Bearer wrong'}}))test(`actual access collector rejects ${name}`,()=>{
  const h=collecting();h.c.request(request(base,'GET',extra));assert.equal(h.faults.request,1);
});
test('actual collector latches malformed request and external/private URL failures',()=>{
  const h=collecting();h.c.request({url:()=> 'malformed'});assert.equal(h.faults.collector,1);
  h.c.request({...request(),url:()=>`https://external.invalid/${owner}`});assert.equal(h.faults.external,1);assert.equal(h.faults.private,1);
});
for(const [name,change]of Object.entries({missing:h=>{h.record.snapshots=[];},early:h=>{h.record.streams[0].index=-1;},
  request:h=>{h.record.snapshots[0].request=request();},response:h=>{h.record.snapshots[0].response=response(request());},
  stream:h=>{h.record.streams[0].reply=response(request(),'text/event-stream');},unbound:h=>{h.record.streams[0].response=null;},
  cursor:h=>{h.record.streams[0].request.url=()=>origin+base+'/events?after='+encodeURIComponent(f.cursor('l','23','3','',''));},
  streamStatus:h=>{h.record.streams[0].reply.status=()=>401;}}))test(`actual original handshake rejects ${name}`,()=>{
  const h=handshake();change(h);const order=recoveryOrder();order.selected();assert.throws(()=>{order.displayed(1,h.record,h.reply,'Execution: interrupted. Final result not recorded.');order.handshake(1,h.input);});
});
for(const [name,extra]of Object.entries({cache:{'cache-control':'public'},nosniff:{'x-content-type-options':undefined},cookie:{'set-cookie':'synthetic'},media:{'content-type':'text/plain'}}))test(`actual response callback latches ${name}`,()=>{
  const h=collecting(),req=request();h.c.request(req);const r=response(req,'application/json',200,extra);h.c.response(r);assert.equal(h.faults.collector,1);assert.throws(()=>responseHeaders(r,'application/json'));
});
test('actual response callback latches denied access without payload reading',()=>{const h=collecting(),req=request();h.c.request(req);h.c.response(response(req,'application/json',401));assert.equal(h.faults.collector,1);});
test('actual route aborts external traffic and catches route failure',async()=>{
  const h=collecting();let aborted=0,continued=0;await h.c.route({request:()=>({...request(),url:()=> 'https://external.invalid'}),abort:async()=>{aborted++;}});
  await h.c.route({request,continue:async()=>{continued++;}});await h.c.route({request:()=>{throw new Error('synthetic');}});
  assert.equal(aborted,1);assert.equal(continued,1);assert.equal(h.faults.external,1);assert.equal(h.faults.collector,1);
});
for(const secret of [owner,'private-native','principal_digest','f'.repeat(64)])test('actual public privacy rejects private scalar',()=>assert.throws(()=>publicPrivacy({text:secret},owner)));
test('actual privacy permits only field ID exemption',()=>{assert.equal(publicPrivacy(interrupted(),owner),true);assert.throws(()=>publicPrivacy({other:f.FID},owner));});

test('actual recovery guard prevents first-open helper inversion',async()=>{let calls=0;const order=recoveryOrder();order.selected();await assert.rejects(order.read(async()=>{calls++;}));assert.equal(calls,0);});
test('actual two-browser original recovery precedes independent reads and both handshakes',async()=>{
  const order=recoveryOrder(),b=handshake(),c=handshake();order.selected();
  order.displayed(1,b.record,b.reply,'Execution: interrupted. Final result not recorded.');assert.equal(await order.read(async()=>7),7);order.handshake(1,b.input);
  order.displayed(2,c.record,c.reply,'Execution: interrupted. Final result not recorded.');await order.read(async()=>8);order.handshake(2,c.input);
  assert.deepEqual(order.finish(),['selected','b-original-interrupted','helper-read','b-handshake','c-original-interrupted','helper-read','c-handshake']);
});
for(const kind of ['unselected','C first','wrong status','no C','missing handshake','C before B handshake','wrong H'])test(`actual recovery guard rejects ${kind}`,async()=>{
  const order=recoveryOrder(),b=handshake(),c=handshake();
  if(kind!=='unselected')order.selected();
  if(['unselected','C first','wrong status'].includes(kind)){assert.throws(()=>order.displayed(kind==='C first'?2:1,b.record,b.reply,kind==='wrong status'?'Execution: running.':'Execution: interrupted. Final result not recorded.'));return;}
  order.displayed(1,b.record,b.reply,'Execution: interrupted. Final result not recorded.');await order.read(async()=>0);
  if(kind==='wrong H'){assert.throws(()=>order.handshake(1,{...b.input,head:'23'}));return;}
  if(kind!=='C before B handshake'&&kind!=='missing handshake')order.handshake(1,b.input);
  if(kind!=='no C'){order.displayed(2,c.record,c.reply,'Execution: interrupted. Final result not recorded.');order.handshake(2,c.input);}
  assert.throws(()=>order.finish());
});
const zero=()=>Object.fromEntries(workKeys.map(k=>[k,k==='fresh_empty'?false:0]));
const samples=()=>[...Array.from({length:4},(_,i)=>({event:'sample',id:i+1,work:zero()})),{event:'stopped',id:5,work:zero()}];
for(const key of workKeys)test(`actual no-work assertion rejects ${key}`,()=>{const s=samples();s[2].work[key]=key==='fresh_empty'?true:1;assert.throws(()=>observerWork(s));});
test('actual work assertion rejects missing boundaries and accepts all zero samples',()=>{assert.equal(observerWork(samples()),true);assert.throws(()=>observerWork(samples().slice(1)));assert.throws(()=>observerWork(samples().reverse()));});
function records() {return [0,1,2].map(i=>({requests:[...(i===0?[{method:'POST',path:'/v1/sessions'},{method:'POST',path:`/v1/sessions/${f.SID}/runs`}]:[]),{method:'GET',path:base}],snapshots:[{}],streams:[{}],assets:new Set(files.keys())}));}
test('actual final request assertion accepts 2/0/0 POST and full assets',()=>assert.equal(browserRequests(records(),newFaults()),true));
for(const key of Object.keys(newFaults()))test(`actual final request assertion rejects ${key} fault`,()=>{const faults=newFaults();faults[key]=1;assert.throws(()=>browserRequests(records(),faults));});
for(const kind of ['POST','mutation','cancel','extra Latest','missing SSE','missing asset'])test(`actual final accounting rejects ${kind}`,()=>{
  const r=records();if(kind==='POST'||kind==='mutation')r[1].requests.push({method:kind==='POST'?'POST':'DELETE',path:base});
  if(kind==='cancel')r[0].requests.push({method:'POST',path:base+'/cancel'});if(kind==='extra Latest')r[2].snapshots.push({});
  if(kind==='missing SSE')r[1].streams=[];if(kind==='missing asset')r[2].assets.delete('/');assert.throws(()=>browserRequests(r,newFaults()));
});
function cleanup() {const terminal={closed:true,reaped:true,stderr_bytes:0,error:false,fallback:false,same_start_alive:false};return {closed:[true,true,true],rootRemoved:true,
  producer:{...terminal,phase:'produce',pid:100,identity:{start_ticks:'1',executable:'/synthetic/fixture'},cwd:'/synthetic/produce',expected_kill:true,code:null,signal:'SIGKILL',drained:false},
  observer:{...terminal,phase:'observe',pid:101,identity:{start_ticks:'2',executable:'/synthetic/fixture'},cwd:'/synthetic/observe',expected_kill:false,code:0,signal:null,drained:true,samples:samples()}};}
test('actual strict cleanup requires expected kill and normal zero-work drain',()=>assert.equal(cleanupProof(cleanup()),true));
for(const process of ['producer','observer'])for(const key of ['closed','reaped','stderr_bytes','error','fallback','same_start_alive','expected_kill','code','signal'])test(`actual cleanup rejects ${process}/${key}`,()=>{
  const c=cleanup();c[process][key]=typeof c[process][key]==='boolean'?!c[process][key]:key==='stderr_bytes'?1:key==='signal'?'SIGTERM':7;assert.throws(()=>cleanupProof(c));
});
for(const kind of ['context','root','drain','identity','PID','work'])test(`actual cleanup rejects ${kind}`,()=>{const c=cleanup();
  if(kind==='context')c.closed[2]=false;if(kind==='root')c.rootRemoved=false;if(kind==='drain')c.observer.drained=false;
  if(kind==='identity')c.observer.identity.executable='/synthetic/other';if(kind==='PID')c.observer.pid=c.producer.pid;
  if(kind==='work')c.observer.samples[0].work.completed=1;assert.throws(()=>cleanupProof(c));
});
for(const kind of ['exact','wrong H','missing','duplicate','query failure'])test(`actual shutdown head read closes handle: ${kind}`,()=>{
  let closed=0,queries=[];
  const database={prepare:sql=>{queries.push(sql);if(kind==='query failure')throw new Error('synthetic');return {all:()=>kind==='missing'?[]:kind==='duplicate'?[{head_sequence:24},{head_sequence:24}]:[{head_sequence:kind==='wrong H'?25:24}]};},close:()=>{closed++;}};
  if(kind==='exact')assert.equal(storedHead(database,'24'),true);else assert.throws(()=>storedHead(database,'24'));
  assert.equal(closed,1);assert.deepEqual(queries,['SELECT head_sequence FROM manifest']);
});
const spec=readFileSync(new URL('../e2e/interrupted-display-parity.spec.mjs',import.meta.url),'utf8');
const digest=text=>createHash('sha256').update(text.replace(/\s+/g,'')).digest('hex');
function sourceGuard(text) {
  const ast=ts.createSourceFile('interrupted.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),calls=[];
  function visit(n){if(ts.isCallExpression(n))calls.push(n);ts.forEachChild(n,visit);}visit(ast);
  const named=name=>calls.filter(c=>c.expression.getText(ast)===name),one=name=>{assert.equal(named(name).length,1);return named(name)[0];};
  const scenario=one('test');assert.ok(ts.isArrowFunction(scenario.arguments[1]));
  for(const name of ['discoverFixture','nativeBinding','producer.killProducer','observer.stopObserver','removeRestartRoot','shutdownHead'])assert.ok(ts.isAwaitExpression(one(name).parent));
  assert.equal(named('browser.newContext').length,2);assert.ok(text.includes('for (const index of [1,2])'));
  const order=one('order.displayed');assert.ok(order.pos<one('order.handshake').pos);
  assert.ok(one('shutdownHead').pos>one('observer.stopObserver').pos&&one('shutdownHead').pos<one('removeRestartRoot').pos);
  assert.equal(named('publicJson').length,1);assert.ok(one('publicJson').pos>text.indexOf('const action = async () =>'));
  assert.deepEqual(named('context.on').map(c=>c.arguments.map(a=>a.getText(ast))),[["'request'",'c.request'],["'response'",'c.response']]);
  // Pin the executed callback and registrations, not an orphan copy of required assertions.
  assert.equal(digest(text),'58dec3251680cc30b8c670052e3474784e5d5f23866c9dee9041c6bea4fe733b');
  for(const c of calls)assert.equal(/(?:newCDPSession|fulfill|dispatchEvent|setTimeout|setDefaultTimeout)$|^test\.(?:only|skip|fixme)$/.test(c.expression.getText(ast)),false);
  return true;
}
test('actual case binds one Task, owned kill, two concurrently connected fresh observers and strict cleanup',()=>assert.equal(sourceGuard(spec),true));
const sourceChanges={
  noKill:s=>s.replace('await producer.killProducer()','true'),unawaitedKill:s=>s.replace('await producer.killProducer()','producer.killProducer()'),
  extraTask:s=>s.replace("button(a, 'Send').click()","button(a, 'Send').click(); button(a, 'Send').click()"),
  closeB:s=>s.replace('for (const index of [1,2])','await contexts[1].close(); for (const index of [1,2])'),
  missingC:s=>s.replace('for (const index of [1,2])','for (const index of [1])'),
  sharedContext:s=>s.replace("contexts[index] = await browser.newContext({ serviceWorkers: 'block' })",'contexts[index] = contexts[0]'),
  earlyRead:s=>s.replace('await observer.sample(); order.selected();','await publicJson(observer, fixture.owner, `/v1/sessions/${sid}/conversation`, value=>value); await observer.sample(); order.selected();'),
  guardBypass:s=>s.replace('return order.read(action)','return action()'),
  recovered:s=>s.replace('order.displayed(index, records[index], originalLatest, await transcript(page).locator(\'.run > .metadata\').textContent())','true'),
  handshake:s=>s.replace('order.handshake(index,','Boolean(index,'),
  DTO:s=>s.replace('interruptedSnapshot(value, before, saved[0])','value'),
  DOM:s=>s.replace('displayProof(await displayedBlock(run), proof)','true'),
  exactDOM:s=>s.replace('sameDom(dom[0], dom[1])','true'),
  finalB:s=>s.replace("await exact(status(pages[1]), 'connected; observation: streaming')",'true'),
  native:s=>s.replace('await observer.sample()','true'),work:s=>s.replace('observerWork(observer.samples)','true'),
  receipt:s=>s.replace('receiptProof(value, proof, command, receipt)','value'),
  stable:s=>s.replace('stableProof(value, saved[0])','value'),
  shutdownH:s=>s.replace('await shutdownHead(fixture, sid)','true'),
  requests:s=>s.replace('browserRequests(records, faults)','true'),
  privacy:s=>s.replace('await boundary(page, contexts[index], fixture.owner)','true'),
  assets:s=>s.replace('await Promise.all(assetReads)','true'),
  cleanup:s=>s.replace('cleanupProof({ closed, rootRemoved, producer: producer.evidence(), observer: observer.evidence() })','true'),
  drain:s=>s.replace('await observer.stopObserver()','observer.stopObserver()'),
  fallback:s=>s.replace('if (failure) {','if (true) {'),
  bodyFallback:s=>s.replace('order.displayed(index,','await originalLatest.body(); order.displayed(index,'),
  rawError:s=>s.replace('} catch {\n    failure = new Error','} catch (error) {\n    console.log(error.stack); failure = new Error'),
  rawDOM:s=>s.replace('dom:dom.map(hash)','dom'),
  token:s=>s.replace('head:\'24\',pre_head:',"owner:fixture.owner,head:'24',pre_head:"),
  timeout:s=>s.replace('let fixture, producer, observer','test.setTimeout(180000); let fixture, producer, observer'),
  skip:s=>s.replace("test('two independently", "test.skip('two independently"),
};
for(const [name,change]of Object.entries(sourceChanges))test(`actual case source guard rejects ${name}`,()=>{
  const changed=change(spec);assert.notEqual(changed,spec);assert.throws(()=>sourceGuard(changed));
});
