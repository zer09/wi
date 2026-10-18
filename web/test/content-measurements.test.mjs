import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { contentFacts, knownText, totalBytes, suffix, contentCursor, customProjection, partialDom, partialDomProof, resolveFixture, reserveOutput,
  contentCollector, contentWork, contentDiagnostics, contentPhases, browserTree, retireTree, removable, sourceGuard } from '../test-support/content-measurements.mjs';
import { facts, sid, expectedPage, seedLegacy, snapshot, legacyProof, ownedFilesProof, handleFacts, sessionPath, digest, newFaults, projectionTables } from '../test-support/upgrade-display-parity.mjs';
import { expectedBlock } from '../test-support/rich-display-parity.mjs';
import { createRestartRoot, terminalProof, workKeys } from '../test-support/restart-display.mjs';
import { observerWork } from '../test-support/upgrade-display-parity.mjs';
import { files } from '../test-support/interrupted-display-parity.mjs';
import { resources, acquireResource, acquireObserver, identity } from '../test-support/display-measurements.mjs';
import { mountDisplayView } from '../dist/display-view.js';
import { replaceLatest, mergeEntryPage } from '../dist/display-store.js';
import { model, controller } from '../test-support/display-dom.mjs';

const origin='http://127.0.0.1:1234', owner='synthetic-owner', base=`/v1/sessions/${sid}/conversation`;
const timing={startTime:1234,requestStart:2,responseStart:8,responseEnd:12};
const sizes={requestBodySize:0,requestHeadersSize:90,responseBodySize:65000,responseHeadersSize:70};
const trap=()=>assert.fail('API body access forbidden');
function request(suffix='', extra={}) {return {url:()=>`${origin}${base}${suffix}`,method:()=> 'GET',headers:()=>({authorization:`Bearer ${owner}`}),
  timing:()=>({...timing}),sizes:async()=>({...sizes}),body:trap,json:trap,text:trap,arrayBuffer:trap,...extra};}
function response(q,extra={}) {return {request:()=>q,url:q.url,status:()=>200,headers:()=>({'content-type':q.url().includes('/events')?'text/event-stream':'application/json',
  'cache-control':'no-store','x-content-type-options':'nosniff'}),body:trap,json:trap,text:trap,arrayBuffer:trap,...extra};}
function networkCase(){const faults=newFaults();return {faults,network:contentCollector({origin,owner,faults})};}
async function initialNetwork(c) {
  const q=request('',{timing:trap,sizes:trap});c.network.request(q);c.network.response(response(q));c.network.finished(q);
  const s=request(`/events?after=${encodeURIComponent(expectedPage(1).live_after)}`,{timing:trap,sizes:trap});c.network.request(s);c.network.response(response(s));
  await c.network.drain();return {q,s};
}
async function contentNetwork(c,extra={},replyExtra={}) {
  const cursor=contentCursor(180000);c.network.arm(cursor);const q=request(`?cursor=${encodeURIComponent(cursor)}`,extra);
  // The content path differs from the conversation path used by the request fixture.
  const url=q.url;q.url=()=>url().replace('/conversation?','/conversation/content?');
  c.network.request(q);const r=response(q,replyExtra);c.network.response(r);c.network.finished(q);await c.network.drain();return {q,r};
}
test('C53 actual default/custom SQLite seeding preserves immutable accepted inputs and recomputes command fingerprints',async t=>{
  const exported=structuredClone(facts);let defaultSeed;
  for(const custom of [false,true])await t.test(custom?'custom':'default',async()=>{
    const fixture=await createRestartRoot();
    try {
      const seed=custom?await seedLegacy(fixture,contentFacts()):await seedLegacy(fixture);legacyProof(snapshot(fixture),seed);await ownedFilesProof(fixture);
      const accepted=seed.canonical.events.filter(r=>r[2]==='run.accepted');assert.equal(accepted.length,2);
      for(const [i,row] of accepted.entries()){
        const payload=JSON.parse(row[8]), input=payload.input;
        assert.equal(input.user_text,custom&&i===1?knownText:facts[i].user);assert.equal(input.prepared_request.options.transport,'web_socket');
        const command=seed.canonical.commands.find(c=>c[3]===row[0]);
        assert.equal(command[2],digest(JSON.stringify({method:'accept_run',session_id:sid,run_id:facts[i].run,input})));
      }
      if(custom){assert.deepEqual(seed.definitions,defaultSeed.definitions);assert.deepEqual(seed.canonical.events.slice(0,11),defaultSeed.canonical.events.slice(0,11));}
      else defaultSeed=seed;
      const db=new DatabaseSync(sessionPath(fixture));
      try {for(const query of ['DELETE FROM events','UPDATE events SET payload_json=payload_json','DELETE FROM commands','UPDATE commands SET receipt_json=receipt_json'])assert.throws(()=>db.exec(query));}
      finally{db.close();}
      assert.deepEqual(snapshot(fixture),seed.before);assert.deepEqual(facts,exported);assert.equal(handleFacts().active,0);
    }finally{await fs.rm(fixture.root,{recursive:true});}
  });
  assert.equal(handleFacts().opens,handleFacts().closes);assert.equal(totalBytes,192000);assert.ok(totalBytes>3*32768);
  const cloned=contentFacts();assert.notEqual(cloned,facts);cloned[0].user='changed only in test';assert.deepEqual(facts,exported);
});
function dom(from=180000) {
  const value=expectedBlock(expectedPage(1));
  for(const entry of value.entries){entry.incomplete_visible=false;for(const field of entry.fields)field.gaps=[];}
  const h=value.entries[0];h.content='Content or field descriptors incomplete. Reads do not imply execution completion. Earlier field descriptors are not loaded.';h.incomplete_visible=true;
  h.fields[0].metadata=`Recorded bytes: ${totalBytes}; generation: 12`;h.fields[0].ranges=[{range:`text:${from}`,text:suffix(from)}];
  h.fields[0].gaps=[{range:'gap:0',text:`Missing bytes [0, ${from})`}];return value;
}
test('C53 partial DOM oracle proves known scalar suffix, prepend, retained tail and exact independent cursor',()=>{
  const initial=partialDomProof(dom()),after=partialDomProof(dom(160000),initial);
  assert.equal(after.retained_tail,true);assert.ok(after.from_byte<initial.from_byte);
  const decoded=JSON.parse(Buffer.from(contentCursor(initial.from_byte).slice(5),'base64url').toString());
  assert.deepEqual(decoded,[1,sid,facts[1].run,'e:12:0','12','text','12','180000']);
});
test('C53 partial DOM oracle rejects false gaps, metadata, activity, progress, duplicate entries/fields and altered retained bytes',async t=>{
  const mutations=[
    ['identity',v=>v.run_id='wrong'],['block state',v=>v.status='running'],['generation',v=>v.entries[0].fields[0].metadata='Recorded bytes: 192000; generation: 13'],
    ['field',v=>v.entries[0].fields[0].field_id='wrong'],['missing prefix',v=>v.entries[0].fields[0].gaps=[]],
    ['false gap',v=>v.entries[0].fields[0].gaps[0].text='Missing bytes [0, 1)'],['hidden incomplete',v=>v.entries[0].incomplete_visible=false],
    ['complete lie',v=>v.entries[0].content='Content complete.'],
    ['former base-only label',v=>v.entries[0].content='Content or field descriptors incomplete. Reads do not imply execution completion.'],
    ['altered descriptor label',v=>v.entries[0].content+=' altered'],['duplicate entry',v=>v.entries.push(structuredClone(v.entries[0]))],
    ['duplicate field',v=>v.entries[0].fields.push(structuredClone(v.entries[0].fields[0]))],['duplicate range',v=>v.entries[0].fields[0].ranges.push(structuredClone(v.entries[0].fields[0].ranges[0]))],
    ['altered tail',v=>v.entries[0].fields[0].ranges[0].text+='x'],['activity changed',v=>v.entries[1].fields[0].ranges[0].text+='x'],
  ];
  for(const [name,mutate] of mutations)await t.test(name,()=>{const v=dom();mutate(v);assert.throws(()=>partialDomProof(v));});
  const initial=partialDomProof(dom());assert.throws(()=>partialDomProof(dom(),initial));assert.throws(()=>partialDomProof(dom(190000),initial));
  assert.throws(()=>partialDomProof(dom(140000),initial));assert.throws(()=>partialDomProof(dom(160000),{...initial,tail_sha256:'bad'}));
  const bytes=Buffer.from(knownText),at=bytes.indexOf(Buffer.from('雪'));
  assert.throws(()=>suffix(at+1));assert.throws(()=>suffix(-1));assert.throws(()=>contentCursor(0));assert.throws(()=>contentCursor(totalBytes));
});
// Adapt only selectors used by the real extraction to the existing offline element model.
function extractionNode(node) {
  for(const n of node.find(()=>true)) {
    n.tagName=n.tag.toUpperCase();
    n.querySelectorAll=selector=>{
      if(selector===':scope > .metadata')return n.children.filter(c=>c.className.split(' ').includes('metadata'));
      if(selector===':scope > details > pre')return n.children.filter(c=>c.tag==='details').flatMap(c=>c.children.filter(p=>p.tag==='pre'));
      const selectors=selector.split(',').map(s=>s.trim());
      return n.children.flatMap(c=>c.find(v=>selectors.some(s=>s==='[data-field]'?v.dataset.field!==undefined:s==='[data-range]'?v.dataset.range!==undefined:s.startsWith('.')?v.className.split(' ').includes(s.slice(1)):v.tag===s)));
    };
    n.querySelector=selector=>n.querySelectorAll(selector)[0]??null;
  }
  return {evaluate:async action=>action(node)};
}
function rendered(t) {
  const page=expectedPage(1),human=page.block.human,field=human.fields[0];
  Object.assign(field,{total_bytes:String(totalBytes),from_byte:'180000',to_byte:String(totalBytes),text:suffix(180000),has_earlier:true});
  human.earlier_content=contentCursor(180000);human.content_complete=false;
  let store=replaceLatest(page,sid);
  const state=()=>({connection:'connected',settings:{workspaces:[page.session.workspace],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket'},
    catalog:{entries:[],has_more:false},catalog_loading:false,error:null,draft:'',pending:[],
    selected:{session_id:sid,store,manifest:null,observation:'streaming',observation_error:null,closed_reason:null,older_loading:false,older_error:null,content_operations:[],run_view:null,cancel:null,cancelling:false}});
  const d=model(t),c=controller(state()),view=mountDisplayView(d.root,c.client,()=>{},true,d.layout);t.after(()=>view.dispose());
  const run=()=>extractionNode(d.root.find(n=>n.dataset.run===facts[1].run)[0]);
  return {run,store:()=>store,prepend(){
    const entry=structuredClone(human);Object.assign(entry.fields[0],{from_byte:'160000',to_byte:'180000',text:suffix(160000,180000),has_later:true});
    entry.earlier_content=contentCursor(160000);
    store=mergeEntryPage(store,{api_version:1,conversation_version:1,session_id:sid,snapshot_head:'21',block:page.block,entry},
      {session_id:sid,run_id:human.run_id,entry_id:human.entry_id},{kind:'content',cursor:human.earlier_content});c.publish(state());
  }};
}
test('C53R1 actual built store/renderer extraction passes the real partial and prepend oracle',async t=>{
  const h=rendered(t);assert.equal(h.store().blocks[0].human.content_start_loaded,false);
  const extracted=await partialDom(h.run()),initial=partialDomProof(extracted);assert.equal(initial.from_byte,180000);
  const label=extracted.entries[0].content;
  for(const content of [label.replace(' Earlier field descriptors are not loaded.',''),label.replace('not loaded','loaded')])
    assert.throws(()=>partialDomProof({...extracted,entries:[{...extracted.entries[0],content},...extracted.entries.slice(1)]}));
  h.prepend();assert.equal(h.store().blocks[0].human.content_start_loaded,false);
  const after=partialDomProof(await partialDom(h.run()),initial);assert.equal(after.from_byte,160000);assert.equal(after.retained_tail,true);
});
function projected(seed) {
  const p={conversation_projection:[[1,1,21,1]],conversation_blocks:[],conversation_entries:[],conversation_fields:[],conversation_chunks:[]};
  for(const page of [expectedPage(0),expectedPage(1)]){
    p.conversation_blocks.push([page.block.run_id]);
    for(const e of [page.block.human,...page.entries]){
      p.conversation_entries.push([e.run_id,e.entry_id,'00',Number(e.position.sequence),Number(e.position.slot),Number(e.revision),Number(e.content_epoch),e.kind,'{}']);
      for(const f of e.fields){const value=e.run_id===facts[1].run&&e.kind==='human'?knownText:f.text,bytes=Buffer.from(value);
        p.conversation_fields.push([e.run_id,e.entry_id,f.field_id,f.order_key,Number(f.generation),bytes.length,f.kind,'{}']);
        let start=0;while(start<bytes.length){let end=Math.min(start+8192,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
          p.conversation_chunks.push([e.run_id,e.entry_id,f.field_id,start,bytes.subarray(start,end).toString('hex')]);start=end;}
      }
    }
  }
  return {version:3,schema:3,names:[...projectionTables].sort(),canonical:seed.canonical,definitions:seed.definitions,projection:p};
}
test('C53 custom projection validator binds epoch12, full custom chunks and generic canonical/DDL preservation',async t=>{
  const seed={canonical:{manifest:[[1,sid,1,'title',null,42,42,21]],events:Array(21).fill([])},definitions:[['immutable']]};
  const value=projected(seed);const proof=customProjection(value,seed);assert.equal(proof.total_bytes,192000);assert.ok(proof.chunks>8);customProjection(value,seed,value);
  const mutations=[['epoch',v=>v.projection.conversation_entries.find(r=>r[1]==='e:12:0')[6]++],
    ['generation',v=>v.projection.conversation_fields.find(r=>r[1]==='e:12:0')[4]++],['bytes',v=>v.projection.conversation_fields.find(r=>r[1]==='e:12:0')[5]++],
    ['gap',v=>v.projection.conversation_chunks.at(-1)[3]++],['table',v=>v.names.pop()],['head',v=>v.projection.conversation_projection[0][2]++],
    ['canonical',v=>v.canonical.extra=true],['DDL',v=>v.definitions=[]],['text',v=>v.projection.conversation_chunks[0][4]='78']];
  for(const [name,mutate]of mutations)await t.test(name,()=>{const v=structuredClone(value);mutate(v);assert.throws(()=>customProjection(v,seed,value));});
});
test('C53 actual public collector measures only content, awaits sizes and keeps accounting after publication',async()=>{
  const c=networkCase(),{s}=await initialNetwork(c);await contentNetwork(c);
  const proof=c.network.proof();assert.equal(proof.operations.content.timing.total_ms,10);assert.deepEqual(proof.operations.content.sizes,sizes);
  assert.equal(proof.operations.latest.timing,undefined);assert.equal(proof.operations.sse.timing,undefined);
  assert.equal(proof.operations.content.identity_match,true);assert.equal(proof.counts.content,1);
  c.network.closing();c.network.failed(s);c.network.proof();
  c.network.request(request('/content?cursor=late'));assert.throws(()=>c.network.proof());assert.equal(c.network.facts().counts.content,2);
});
test('C53 original collector rejects metadata and response protection defects without touching bodies',async t=>{
  const defects=[['status',{}, {status:()=>500}],['identity',{}, {request:()=>request()}],['response URL',{}, {url:()=>`${origin}${base}/content?cursor=wrong`}],
    ['media',{}, {headers:()=>({'content-type':'text/plain'})}],['cache',{}, {headers:()=>({'content-type':'application/json','cache-control':'public'})}],
    ['size unavailable',{sizes:async()=>{throw new Error('unavailable');}},{}],['size missing',{sizes:async()=>({})},{}],
    ['page cap',{sizes:async()=>({...sizes,responseBodySize:524289})},{}],['timing missing',{timing:()=>({})},{}],
    ['timing reversed',{timing:()=>({...timing,responseEnd:1})},{}],['nonfinite',{timing:()=>({...timing,responseStart:Infinity})},{}]];
  for(const [name,q,r] of defects)await t.test(name,async()=>{const c=networkCase();await initialNetwork(c);await contentNetwork(c,q,r);assert.throws(()=>c.network.proof());});
});
test('C53 collector rejects route, query, method, duplicate, early, failed and premature finish identities',async t=>{
  for(const name of ['query','origin','method','headers','before','within','entry','early','duplicate-request','duplicate-response','duplicate-finish','premature','failed','wrong-finished','stream-failed'])await t.test(name,async()=>{
    const c=networkCase(),{s}=await initialNetwork(c),cursor=contentCursor(180000);
    if(name!=='early')c.network.arm(cursor);
    let q=request(`/content?cursor=${encodeURIComponent(cursor)}`);
    if(name==='query')q=request('/content?cursor=wrong&extra=1');
    if(name==='origin')q=request('/content',{url:()=>`http://127.0.0.1:1235${base}/content`});
    if(name==='method')q=request('/content',{method:()=> 'POST'});
    if(name==='headers')q=request('/content',{headers:()=>({cookie:'forbidden'})});
    if(name==='before')q=request('?before=wrong');if(name==='within')q=request('?within=wrong');if(name==='entry')q=request('/entries/run/entry');
    c.network.request(q);if(name==='duplicate-request')c.network.request(q);
    const r=response(q);if(name!=='premature')c.network.response(r);if(name==='duplicate-response')c.network.response(r);
    c.network.finished(q);if(name==='duplicate-finish')c.network.finished(q);
    if(name==='failed')c.network.failed(q);if(name==='wrong-finished')c.network.finished(request('/content?cursor=other'));if(name==='stream-failed')c.network.failed(s);
    await c.network.drain();assert.throws(()=>c.network.proof());
  });
});
test('C53 delayed public size promises cannot pass before completion and drain awaits all work',async()=>{
  const c=networkCase();await initialNetwork(c);const cursor=contentCursor(180000);c.network.arm(cursor);let resolve;
  const q=request(`/content?cursor=${encodeURIComponent(cursor)}`,{sizes:()=>new Promise(r=>{resolve=r;})});c.network.request(q);c.network.response(response(q));c.network.finished(q);
  assert.equal(c.network.ready('content'),false);assert.throws(()=>c.network.proof());let drained=false;const drain=c.network.drain().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);resolve(sizes);await drain;assert.equal(c.network.ready('content'),true);c.network.proof();
});
test('C53 unresolved sizes fail finitely, rather than become zero or block cleanup forever',async()=>{
  const c=networkCase();await initialNetwork(c);await contentNetwork(c,{sizes:()=>new Promise(()=>{})});assert.throws(()=>c.network.proof());assert.equal(c.network.facts().pending,0);
});
test('C53 external routing aborts instead of fulfilling and does not publish URLs or credentials',async()=>{
  const c=networkCase();let aborted=0,continued=0;
  const route=url=>({request:()=>({url:()=>url}),abort:async()=>aborted++,continue:async()=>continued++,fulfill:trap});
  await c.network.route(route('https://invalid.example/'));await c.network.route(route(`${origin}/`));assert.equal(aborted,1);assert.equal(continued,1);
  const value=JSON.stringify(c.network.facts());assert.ok(!value.includes(owner)&&!value.includes(origin));
});
const ident=(pid,ppid)=>({state:'present',pid,ppid,start_ticks:'42',executable:'/synthetic/browser',cwd:'/synthetic'});
function procFixture(){const values=new Map();const add=(pid,ppid)=>{values.set(`/proc/${pid}/stat`,`${pid} (name) S ${ppid} ${Array(17).fill('0').join(' ')} 42 0 0`);
  values.set(`/proc/${pid}/exe`,'/synthetic/browser');values.set(`/proc/${pid}/cwd`,'/synthetic');values.set(`/proc/${pid}`,true);};
  const read=async p=>{assert.ok(!p.endsWith('/status'));if(!values.has(p))throw {code:'ENOENT'};return values.get(p);};
  return {values,add,io:{readFile:read,readlink:read,lstat:read,readdir:async()=>[...values.keys()].filter(p=>/^\/proc\/\d+$/.test(p)).map(p=>p.split('/').at(-1))}};}
test('C53 finite browser ancestry discovers only validated descendants without memory reads and independently retires them',async()=>{
  const f=procFixture();f.add(2,1);f.add(3,2);f.add(4,3);f.add(5,9);
  const tree=await browserTree(ident(2,1),f.io);assert.deepEqual(tree.members.map(i=>i.pid),[2,3,4]);assert.deepEqual(tree.errors,{enumeration:0,stat:0,identity:0});
  await assert.rejects(retireTree(tree.members,f.io));f.values.clear();const retired=await retireTree(tree.members,f.io);assert.ok(retired.every(i=>i.retirement==='absent'));
  assert.equal(removable(false,false,{active:0,opens:2,closes:2},[retired[0]],retired),true);
  for(const [failure,fallback,handles,native,browser] of [[true,false,{active:0,opens:2,closes:2},retired,retired],[false,true,{active:0,opens:2,closes:2},retired,retired],
    [false,false,{active:1,opens:2,closes:1},retired,retired],[false,false,{active:0,opens:2,closes:2},[],retired],
    [false,false,{active:0,opens:2,closes:2},retired,[{retirement:'unknown'}]]])assert.equal(removable(failure,fallback,handles,native,browser),false);
});
test('C53 unvalidated ancestry and unknown retirement never authorize signals or root removal',async()=>{
  const f=procFixture();f.add(2,1);f.add(3,2);f.io.readlink=async p=>p==='/proc/3/exe'?'/changed':f.values.get(p);
  // A stable child executable may differ from the root; changing identity during discovery must reject instead.
  let reads=0;const original=f.io.readFile;f.io.readFile=async p=>p==='/proc/3/stat'&&++reads>1?f.values.get(p).replace('S 2','S 9'):original(p);
  await assert.rejects(browserTree(ident(2,1),f.io));await assert.rejects(retireTree([{state:'unknown',pid:3}],f.io));
});
test('C53 repaired acquireObserver owns input/close before initialization and rejected identities cannot grant signals',async t=>{
  for(const step of ['candidate','root','input','close'])await t.test(step,async()=>{
    const child=new EventEmitter(),events=[];child.pid=900;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.write=()=>events.push('write');child.stdin.end=()=>{events.push('end');if(step==='input')throw new Error('input');queueMicrotask(()=>child.emit('close',0,null));};
    child.kill=()=>{events.push('signal');queueMicrotask(()=>child.emit('close',0,'SIGKILL'));};
    const candidate={...ident(900,process.pid),executable:'/synthetic/native',cwd:'/synthetic/observe'};
    const observer=acquireObserver({executable:'/synthetic/native'},{root:'/synthetic'},{spawnChild:()=>child,
      readIdentity:async()=>step==='candidate'?{...candidate,executable:'/rejected'}:candidate,
      checkRoot:async()=>{throw new Error('root rejected');},waitBounded:async p=>{if(step==='close')throw new Error('close unavailable');return p;}});
    await assert.rejects(observer.initialize());
    if(['input','close'].includes(step))await assert.rejects(observer.emergency());else await observer.emergency();
    assert.ok(events.includes('end'));if(step==='candidate')assert.ok(!events.includes('signal'));assert.equal(observer.evidence().identity!==null,step!=='candidate');
  });
});

const specPath=new URL('../e2e/content-measurements.spec.mjs',import.meta.url);
async function specCase(options={}){
  const source=await fs.readFile(specPath,'utf8'),ast=ts.createSourceFile('case.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const script=ast.statements.filter(s=>!ts.isImportDeclaration(s)).map(s=>s.getText(ast)).join('\n').replaceAll('import.meta.url',JSON.stringify(specPath.href));
  const saved=new Map(),events=[],failure=new Error('synthetic unpublished'),publication=new Error('publication unpublished');let callback,cleanupResult,serverClosed=false,clicked=false;
  let collected,diagnostic,established,contentRequest,releaseMetadata,disposing=false,finalPreparation=false,cleanupCompleted=false,injection;
  const handlers=new Map(),serializationAttempts=[];
  const getterFails=option=>option===true||option==='final'&&finalPreparation;
  function injectSse() {
    events.push('sse-failed');handlers.get('requestfailed')(established);
    let strict=false,safe=false;
    try{collected.network.proof();strict=true;}catch{}
    try{collected.network.cleanupProof();safe=true;}catch{}
    injection={context_started:events.includes('context-close'),facts:collected.network.facts(),faults:collected.faults.collector,strict,safe};
  }
  function injectCleanup() {
    const before=collected.network.facts();events.push('cleanup-injected');
    if(options.cleanupSchedule.includes('-pending-')){
      contentRequest=request(`/content?cursor=${encodeURIComponent(contentCursor(180000))}`,{sizes:()=>new Promise((resolve,reject)=>{
        releaseMetadata=()=>{events.push('metadata-settled');if(options.cleanupSchedule.endsWith('reject'))reject(publication);else resolve(sizes);};
      })});
      handlers.get('request')(contentRequest);handlers.get('response')(response(contentRequest));handlers.get('requestfinished')(contentRequest);
    }else if(options.cleanupSchedule.endsWith('duplicate'))handlers.get('request')(contentRequest);
    else handlers.get('requestfailed')(contentRequest);
    injection={before,facts:collected.network.facts(),faults:collected.faults.collector};
  }
  async function cleanupAwait(seam) {
    if(!options.cleanupSchedule?.startsWith(`${seam}-`))return;
    events.push(`${seam}-held`);
    await new Promise(resolve=>queueMicrotask(()=>{injectCleanup();events.push(`${seam}-release`);resolve();}));
  }
  const renderedDom=options.rendererTest?rendered(options.rendererTest):null;
  const zeroWork=()=>Object.fromEntries(workKeys.map(k=>[k,k==='fresh_empty'?false:0]));
  const workRecord=event=>({event,work:zeroWork()});
  const locator={locator:()=>locator,evaluate:async()=>({height:1000,viewport:100,top:900}),click:async()=>{},fill:async()=>{}};
  const connectLocator={...locator,click:async()=>{established=(await initialNetwork(collected)).s;}};
  const page={on:()=>{},goto:async()=>{
      for(const [path,[asset,mime]]of files){const q=request('',{url:()=>origin+path});collected.network.request(q);
        collected.network.response(response(q,{headers:()=>({'content-type':mime,'cache-control':'no-store','x-content-type-options':'nosniff'}),body:()=>fs.readFile(new URL('../'+asset,import.meta.url))}));}
      await collected.network.drain();
    },evaluate:async()=>{},locator:()=>locator,getByLabel:()=>locator,
    getByRole:(role,options)=>options.name==='Load older'?{...locator,click:async()=>{events.push('content-click');clicked=true;renderedDom?.prepend();
      contentRequest=request(`/content?cursor=${encodeURIComponent(contentCursor(180000))}`);collected.network.request(contentRequest);collected.network.response(response(contentRequest));collected.network.finished(contentRequest);await collected.network.drain();
    }}:options.name==='Connect'?connectLocator:locator};
  const parentReads=[],forwarded=[],removed=[];
  const env=new Proxy({WI_C3A_FIXTURE:'/synthetic/native',WI_BROWSER_FIXTURE_PARENT:'/synthetic/private-parent',...options.env},{
    get(target,key){if(key==='WI_BROWSER_FIXTURE_PARENT'){parentReads.push(key);events.push('parent-read');}return target[key];},
  });const raise=step=>{events.push(step);if(options.injected===step)throw failure;};
  const browserIdentity={...ident(901,process.pid)},nativeIdentity={...ident(900,process.pid),executable:'/synthetic/native',cwd:'/synthetic/observe'};
  const native={closed:false,input_ended:false,fallback:false,identity:nativeIdentity,samples:[],reaped:true,stderr_bytes:0,stdout_bytes:1,
    error:false,drained:true,expected_kill:false,same_start_alive:false,code:0,signal:null,cleanup_errors:[]};
  const observer={pid:900,origin,sample:async()=>{native.samples.push(workRecord('sample'));},initialize:async()=>{raise('initialize');native.samples.push(workRecord('sample'));return nativeIdentity;},stop:async()=>{raise('native-stop');native.closed=true;native.input_ended=true;native.samples.push(workRecord('stopped'));
      if(options.nativeDefect==='input')native.input_ended=false;if(options.nativeDefect==='close')native.closed=false;if(options.nativeDefect==='fallback')native.fallback=true;
      if(options.nativeDefect==='work')native.samples[0].work.tool_executions=1;
    },
    emergency:async()=>{events.push('native-emergency');native.closed=true;native.input_ended=true;native.fallback=true;},
    evidence:()=>{if(getterFails(options.evidenceGetter))throw publication;return native;}};
  const expectation=value=>({toEqual:expected=>assert.deepEqual(value,expected),toBe:expected=>assert.equal(value,expected),toContain:expected=>assert.ok(value.includes(expected)),
    toHaveValue:async()=>{},toHaveCount:async()=>{},toHaveText:async()=>{}});
  expectation.poll=fn=>({toBe:async expected=>assert.equal(await fn(),expected)});
  const binding={executable:'/synthetic/native',sha256:'a'.repeat(64)};
  let bindingReads=0;
  const values={
    test:Object.assign((name,cb)=>{events.push('collected');callback=cb;},{use:()=>{}}),expect:expectation,
    chromium:{launchServer:async()=>{raise('launch');return {process:()=>({pid:901}),wsEndpoint:()=> 'unpublished endpoint',close:async()=>{raise('server-close');serverClosed=true;}};},
      connect:async()=>{raise('connect');return {version:()=> '145.0.7632.6',close:async()=>{raise('browser-close');if(options.sseSchedule==='post-close')injectSse();},newContext:async()=>{raise('context');return {close:async()=>{raise('context-close');if(options.sseSchedule==='close-initiation')injectSse();},
        setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{},route:async()=>{},on:(name,fn)=>handlers.set(name,fn),newPage:async()=>{raise('page');if(options.success)return page;throw failure;}};}};}},
    JSON:{...JSON,stringify:(value,...args)=>{
      const name=value?.steps?'CLEANUP.json':value?.observation?'MEASUREMENTS.json':value?.fresh_cases?'BROWSER_RESULT.json':null;
      if(name)serializationAttempts.push(name);
      if(options.serialization&&value?.first_operation||options.serializationArtifact===name&&name!==null)throw publication;
      return JSON.stringify(value,...args);
    }},
    readFile:async()=>source,writeFile:async(path,raw,opts)=>{const name=path.split('/').at(-1);events.push(`save:${name}`);assert.equal(opts.flag,'wx');assert.equal(opts.mode,0o600);
      if(options.publication===name)throw publication;saved.set(name,JSON.parse(raw));},join,rm:async(path,flags)=>{events.push('root-remove');removed.push(path);assert.equal(path,'/synthetic');assert.deepEqual(flags,{recursive:true});if(options.cleanupSchedule==='rm-started')injectCleanup();},lstat:async()=>{throw {code:'ENOENT'};},
    discoverFixture:async()=>{events.push('discovery');return '/synthetic/native';},nativeBinding:async()=>{bindingReads++;if(cleanupCompleted)finalPreparation=true;
      if(disposing&&!cleanupCompleted)await cleanupAwait('binding');return options.bindingChanged&&bindingReads>=2?{...binding,sha256:'b'.repeat(64)}:binding;},
    createRestartRoot:async(...args)=>{forwarded.push(args);raise('root');if(options.allocator){
      const value=await options.allocator(...args);
      // A broken forwarding regression must not leak its unexpected unit root.
      await fs.rm(value.root,{recursive:true});throw new Error('Invalid parent unexpectedly acquired root');
    }return {root:'/synthetic',owner};},rootProof:async()=>{disposing=true;events.push('root-proof');if(options.cleanupSchedule==='before-proof')injectCleanup();},terminalProof,sid,head:'21',title:'Title',
    seedLegacy:async()=>{raise('seed');return {};},snapshot:()=>({}),legacyProof:()=>{},catalogProof:()=>{},observerWork,contentWork,ownedFilesProof:async()=>{if(disposing)await cleanupAwait('files');},
    handleFacts:()=>options.handles?{active:1,opens:2,closes:1}:{active:0,opens:2,closes:2},boundary:async()=>{},newFaults,
    identity:async()=>{raise('identity');return options.rejectedIdentity?{...browserIdentity,ppid:1}:browserIdentity;},
    retirement:async()=>({...nativeIdentity,retirement:options.retirement?'unknown':'absent'}),
    resources:fn=>{const r=resources(fn),cleanup=r.cleanup;r.cleanup=async()=>{cleanupResult=await cleanup();cleanupCompleted=true;return cleanupResult;};return r;},acquireResource,acquireObserver:()=>observer,
    contentFacts,totalBytes,contentCursor,customProjection:()=>({schema:3}),partialDom:async()=>{const value=renderedDom?await partialDom(renderedDom.run()):dom(clicked?160000:180000);if(options.badLabel)value.entries[0].content='Content or field descriptors incomplete. Reads do not imply execution completion.';return value;},partialDomProof,
    contentDiagnostics:(read,f)=>{const d=contentDiagnostics(read,f);diagnostic=d;return {...d,operation:(name,action)=>d.operation(name,async()=>{raise(name);return action();})};},
    contentCollector:args=>{const network=contentCollector(args),arm=network.arm,closing=network.closing,drain=network.drain,facts=network.facts;
      network.arm=cursor=>{events.push('armed');return arm(cursor);};network.closing=()=>{events.push('closing');closing();};
      network.drain=async()=>{raise('drain');const pending=drain();
        if(releaseMetadata){events.push('drain-pending');const release=releaseMetadata;releaseMetadata=null;queueMicrotask(release);}
        await pending;events.push('drained');};
      if(options.browserFault)args.faults.console++;
      network.facts=()=>{if(getterFails(options.factsGetter))throw publication;const value=facts();
        if(options.countsGetter){const counts=value.counts;Object.defineProperty(value,'counts',{enumerable:true,get(){if(getterFails(options.countsGetter))throw publication;return counts;}});}return value;};
      collected={network,faults:args.faults};return network;},
    browserTree:async()=>{events.push('tree');const calls=events.filter(e=>e==='tree').length;if(options.discovery&&calls>=2)throw failure;
      if(options.sseSchedule==='held-discovery'&&calls===3){events.push('discovery-held');await new Promise(resolve=>queueMicrotask(()=>{injectSse();events.push('discovery-release');resolve();}));}
      events.push('tree-complete');return {members:[browserIdentity,...(calls>=2?[ident(902,901)]:[])],errors:{enumeration:0,stat:0,identity:0}};},
    retireTree:async members=>{events.push('retire-tree');if(options.retirement||!serverClosed)throw failure;return members.map(i=>({...i,retirement:'absent'}));},removable,sourceGuard:()=>true,
    resolveFixture:(e,d)=>{events.push('binding');return resolveFixture(e,d,async()=>binding);},reserveOutput:info=>reserveOutput(info,{mkdir:async()=>{events.push('reserve');if(options.occupied)throw failure;},writeFile:async(path,raw,opts)=>{
      events.push('marker');assert.equal(opts.flag,'wx');assert.equal(opts.mode,0o600);if(options.marker)throw publication;saved.set('C53.once.json',JSON.parse(raw));}}),process:{env,pid:process.pid},URL,
  };
  new Function(...Object.keys(values),script)(...Object.values(values));let error;
  assert.equal(parentReads.length,0);events.push('invoke');
  try{await callback({}, {outputPath:name=>{assert.equal(name,'c53-evidence');events.push('output');return '/synthetic/evidence';}});}catch(caught){error=caught;}
  assert.equal(events.filter(e=>e==='collected').length,1);if(options.success&&!options.injected&&!options.badLabel&&!options.discovery&&!options.nativeDefect&&!options.publication&&!options.serializationArtifact&&!options.factsGetter&&!options.countsGetter&&!options.evidenceGetter&&options.sseSchedule!=='held-discovery'&&!options.cleanupSchedule&&!options.bindingChanged&&!options.handles&&!options.rejectedIdentity)assert.equal(error,undefined);else assert.ok(error);
  assert.ok(!JSON.stringify([...saved.values()]).includes(failure.message));
  return {saved,events,error,first:cleanupResult.error,failure,publication,native,collected,serializationAttempts,packet:diagnostic.packet(),injection,forwarded,parentReads,removed};
}
test('C53 actual callback requires and forwards the designated runtime parent at the original root boundary',async t=>{
  const admitted=await specCase({success:true,env:{WI_BROWSER_FIXTURE_PARENT:'/synthetic/designated-parent'}});
  assert.deepEqual(admitted.forwarded,[['/synthetic/designated-parent']]);assert.equal(admitted.parentReads.length,1);
  assert.ok(admitted.events.indexOf('marker')<admitted.events.indexOf('binding'));
  assert.ok(admitted.events.indexOf('binding')<admitted.events.indexOf('parent-read'));
  assert.ok(admitted.events.indexOf('parent-read')<admitted.events.indexOf('root'));
  assert.deepEqual(admitted.removed,['/synthetic']);assert.equal(admitted.saved.get('BROWSER_RESULT.json').status,'PASS');
  const missing=await specCase({env:{WI_BROWSER_FIXTURE_PARENT:undefined}});
  assert.equal(missing.first.message,'Browser fixture parent required');assert.equal(missing.error,missing.first);
  assert.deepEqual(missing.forwarded,[]);assert.equal(missing.parentReads.length,1);assert.ok(missing.events.includes('binding'));
  for(const event of ['root','seed','initialize','launch','root-remove'])assert.equal(missing.events.includes(event),false);
  for(const parent of ['', 'relative', '/synthetic/invalid\0', '\ud800'])await t.test('invalid parent has no root or native work',async()=>{
    const c=await specCase({env:{WI_BROWSER_FIXTURE_PARENT:parent},allocator:createRestartRoot});
    assert.deepEqual(c.forwarded,[[parent]]);assert.equal(c.first.message,'Restart display rejected');assert.equal(c.error,c.first);
    for(const event of ['seed','initialize','launch','root-remove'])assert.equal(c.events.includes(event),false);
  });
});
test('C53 actual callback successful seam performs exactly one accessible click after admission and publishes normal cleanup',async()=>{
  const c=await specCase({success:true});assert.equal(c.first,null);assert.equal(c.saved.get('BROWSER_RESULT.json').status,'PASS');
  assert.equal(c.events.filter(e=>e==='content-click').length,1);assert.ok(c.events.indexOf('armed')<c.events.indexOf('content-click'));
  assert.ok(c.events.indexOf('closing')<c.events.indexOf('context-close'));assert.ok(c.events.indexOf('native-stop')<c.events.indexOf('root-remove'));
});
test('C53 actual callback reserves ordinary output and marker before supplied/optional/conditional fixture binding',async t=>{
  for(const variant of ['ordinary','digest','absent','bad-digest','mismatch','empty-path'])await t.test(variant,async()=>{
    const env={};if(variant==='digest')env.WI_C47_FIXTURE_SHA256='a'.repeat(64);if(variant==='absent')env.WI_C3A_FIXTURE=undefined;
    if(variant==='bad-digest')env.WI_C47_FIXTURE_SHA256='bad';if(variant==='mismatch')env.WI_C47_FIXTURE_SHA256='b'.repeat(64);if(variant==='empty-path')env.WI_C3A_FIXTURE='';
    const c=await specCase({env,injected:'seed'});assert.ok(c.events.indexOf('reserve')<c.events.indexOf('marker'));
    const allowed=['ordinary','digest','absent'].includes(variant);assert.equal(c.events.includes('seed'),allowed);assert.equal(c.events.includes('launch'),false);
    assert.equal(c.events.includes('discovery'),variant==='absent');if(allowed)assert.equal(c.first,c.failure);
  });
  for(const option of [{occupied:true},{marker:true}]){const c=await specCase(option);assert.ok(!c.events.includes('root'));assert.ok(!c.events.includes('launch'));assert.equal(c.saved.size,0);}
});
test('C53 actual callback preserves first failure, continues all acquired closures and retains roots on cleanup/retirement faults',async t=>{
  for(const step of ['seed','initialize','identity','connect','context','page','context-close','browser-close','server-close','native-stop','drain'])await t.test(step,async()=>{
    const c=await specCase({injected:step});assert.equal(c.first,c.failure);assert.equal(c.saved.get('BROWSER_RESULT.json').status,'FAILED');
    if(step!=='seed')assert.ok(c.events.includes('native-stop'));if(!['seed','initialize'].includes(step))assert.ok(c.events.includes('server-close'));
    if(['context-close','browser-close','server-close','native-stop','drain'].includes(step))assert.ok(!c.events.includes('root-remove'));
  });
  const unknown=await specCase({retirement:true});assert.ok(!unknown.events.includes('root-remove'));assert.equal(unknown.saved.get('CLEANUP.json').pass,false);
});
test('C53 actual callback publication failures continue later publication and never skip cleanup or replace first failure',async t=>{
  for(const name of ['SEED.json','FAILURE_BEFORE_CLEANUP.json','CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'])await t.test(name,async()=>{
    const c=await specCase({publication:name,injected:name==='FAILURE_BEFORE_CLEANUP.json'?'initialize':undefined});
    assert.equal(c.first,name==='SEED.json'?c.publication:c.failure);assert.equal(c.saved.has(name),false);
    if(name!=='SEED.json')assert.ok(c.events.includes('native-stop'));
    if(name!=='BROWSER_RESULT.json')assert.equal(c.saved.get('BROWSER_RESULT.json').status,'FAILED');
    assert.deepEqual(c.serializationAttempts,['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json']);
  });
});
test('C53R1 every actual callback operation freezes at first rejection and preserves the original error',async t=>{
  for(const name of contentPhases)await t.test(name,async()=>{
    const c=await specCase({success:true,injected:name}),packet=c.saved.get('FAILURE_BEFORE_CLEANUP.json');
    assert.equal(c.error,c.failure);assert.equal(packet.first_operation,name);assert.equal(packet.phases[name],'failed');
    const index=contentPhases.indexOf(name);
    for(const earlier of contentPhases.slice(0,index))assert.equal(packet.phases[earlier],'resolved');
    for(const later of contentPhases.slice(index+1))assert.equal(packet.phases[later],'not_started');
    assert.deepEqual(c.saved.get('BROWSER_RESULT.json').first_failure,packet);
    assert.equal(c.saved.get('BROWSER_RESULT.json').status,'FAILED');
    const measurement=c.saved.get('MEASUREMENTS.json');assert.equal(measurement.body_success,false);
    for(const key of ['initial','after','geometry','projection','network'])assert.equal(measurement[key],null);
    const cleanup=c.saved.get('CLEANUP.json');assert.equal(cleanup.pass,true);assert.equal(cleanup.body_success,false);assert.equal(cleanup.final_discovery,true);
    assert.ok(c.events.indexOf('tree')<c.events.indexOf('context-close'));assert.equal(cleanup.browser_retirement.length,2);
    if(index<contentPhases.indexOf('content_click'))assert.equal(c.events.includes('content-click'),false);
  });
});
test('C53R1 real callback oracle rejects the former label and safe early zero-work cleanup removes only the new owned root',async()=>{
  const c=await specCase({success:true,badLabel:true});assert.equal(c.saved.get('FAILURE_BEFORE_CLEANUP.json').first_operation,'partial_dom_poll');
  assert.equal(c.native.samples.length,2);contentWork(c.native.samples);assert.throws(()=>observerWork(c.native.samples));
  assert.equal(c.saved.get('CLEANUP.json').pass,true);assert.ok(c.events.includes('root-remove'));assert.equal(c.events.includes('content-click'),false);
});
test('C53R1 full callback success keeps real strict one-content/four-record proof and final preclose discovery',async t=>{
  const c=await specCase({success:true,rendererTest:t});observerWork(c.native.samples);assert.equal(c.native.samples.length,4);c.collected.network.proof();
  const cleanup=c.saved.get('CLEANUP.json');assert.equal(cleanup.body_success,true);assert.equal(cleanup.pass,true);assert.equal(cleanup.final_discovery,true);
  assert.equal(cleanup.browser_retirement.length,2);assert.ok(c.events.lastIndexOf('tree')<c.events.indexOf('context-close'));
});
test('C53R1 real callback retains new roots for final discovery, identity, retirement, native input/close/fallback/work, handles and binding gaps',async t=>{
  for(const variant of ['discovery','retirement','rejectedIdentity','handles','bindingChanged','browserFault','input','close','fallback','work'])await t.test(variant,async()=>{
    const options={success:true,injected:'session_title'};
    if(['input','close','fallback','work'].includes(variant))options.nativeDefect=variant;else options[variant]=true;
    const c=await specCase(options);assert.ok(!c.events.includes('root-remove'));assert.equal(c.saved.get('CLEANUP.json').pass,false);
    assert.equal(c.saved.get('BROWSER_RESULT.json').status,'FAILED');
    if(variant!=='rejectedIdentity')assert.equal(c.error,c.failure);
    assert.ok(c.events.includes('server-close'));assert.ok(c.events.includes('native-stop'));
  });
});
test('C53R1 content work cleanup rejects missing, malformed and nonzero records without changing shared success proof',async t=>{
  const work=()=>Object.fromEntries(workKeys.map(k=>[k,k==='fresh_empty'?false:0]));
  const pair=()=>[{event:'sample',work:work()},{event:'stopped',work:work()}];
  contentWork(pair());assert.throws(()=>observerWork(pair()));
  const full=[...pair().slice(0,1),...pair().slice(0,1),...pair()];contentWork(full);observerWork(full);
  const variants=[['missing',v=>v.pop()],['bad start',v=>v[0].event='stopped'],['bad end',v=>v[1].event='sample'],
    ['missing work',v=>delete v[0].work],['missing key',v=>delete v[0].work.auth_loads],['extra key',v=>v[1].work.extra=0],
    ['boolean counter',v=>v[0].work.completed=false],['nonzero',v=>v[1].work.tool_executions=1],['fresh empty',v=>v[0].work.fresh_empty=true]];
  for(const[name,mutate]of variants)await t.test(name,()=>{const v=pair();mutate(v);assert.throws(()=>contentWork(v));});
});
test('C53R1 cleanup collector accepts absence only when never requested and rejects unfinished or late/failing originals',async t=>{
  const empty=networkCase();empty.network.cleanupProof();assert.throws(()=>empty.network.proof());
  const initial=networkCase(),{s}=await initialNetwork(initial);initial.network.cleanupProof();assert.throws(()=>initial.network.proof());
  initial.network.closing();initial.network.failed(s);initial.network.cleanupProof();
  for(const name of ['unfinished-latest','unfinished-sse','unfinished-content','failed-content','late-duplicate','early-content','bad-metadata','collector-fault'])await t.test(name,async()=>{
    const c=networkCase();
    if(name==='unfinished-latest'){c.network.request(request());}
    else if(name==='unfinished-sse'){const q=request();c.network.request(q);c.network.response(response(q));c.network.finished(q);await c.network.drain();c.network.request(request(`/events?after=${encodeURIComponent(expectedPage(1).live_after)}`));}
    else {await initialNetwork(c);const q=request(`/content?cursor=${encodeURIComponent(contentCursor(180000))}`);
      if(name!=='early-content')c.network.arm(contentCursor(180000));c.network.request(q);
      if(name!=='unfinished-content'){c.network.response(response(q,name==='bad-metadata'?{status:()=>500}:{}));c.network.finished(q);}
      if(name==='failed-content')c.network.failed(q);if(name==='late-duplicate'){await c.network.drain();c.network.request(q);}
      if(name==='collector-fault')c.network.failed(request('/unknown'));
    }
    await c.network.drain();assert.throws(()=>c.network.cleanupProof());
  });
  const asset=networkCase();let failAsset;
  const [assetPath,[assetFile,assetMime]]=files.entries().next().value;
  const assetRequest=request('',{url:()=>origin+assetPath});asset.network.request(assetRequest);
  asset.network.response(response(assetRequest,{headers:()=>({'content-type':assetMime,'cache-control':'no-store','x-content-type-options':'nosniff'}),body:()=>new Promise((_,reject)=>{failAsset=reject;})}));
  assert.equal(asset.network.facts().pending,1);assert.throws(()=>asset.network.cleanupProof());
  const assetDrain=asset.network.drain();failAsset(new Error('unpublished asset failure'));await assetDrain;
  assert.equal(asset.network.facts().pending,0);assert.throws(()=>asset.network.cleanupProof());assert.ok(assetFile);
  const delayed=networkCase();await initialNetwork(delayed);delayed.network.arm(contentCursor(180000));let resolve;
  const q=request(`/content?cursor=${encodeURIComponent(contentCursor(180000))}`,{sizes:()=>new Promise(r=>{resolve=r;})});
  delayed.network.request(q);delayed.network.response(response(q));delayed.network.finished(q);assert.throws(()=>delayed.network.cleanupProof());
  let drained=false;const drain=delayed.network.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);resolve(sizes);await drain;delayed.network.cleanupProof();
  delayed.network.failed(q);assert.throws(()=>delayed.network.cleanupProof());
});
test('C53R1 first diagnostic owns finite scalars before sibling settlements, getters, serialization or publication',async()=>{
  const c=networkCase();await initialNetwork(c);let resolve,secondError=new Error('unpublished second'),original=new Error('unpublished first');
  const faults=c.faults,d=contentDiagnostics(()=>c.network.facts(),faults);
  const pending=d.operation('token_fill',()=>new Promise(r=>{resolve=r;}));
  await assert.rejects(d.operation('session_title',()=>{throw original;}),error=>error===original);
  const packet=d.packet(),saved=JSON.stringify(packet);assert.equal(packet.phases.token_fill,'pending');assert.equal(packet.counts.content,0);
  resolve();await pending;faults.page=99;c.network.request(request('/content?cursor=late'));
  await assert.rejects(d.operation('content_ready',()=>Promise.reject(secondError)),error=>error===secondError);
  assert.equal(d.freeze('outside_path'),packet);assert.equal(JSON.stringify(packet),saved);
  assert.throws(()=>{packet.counts.content=20;});assert.throws(()=>{packet.phases.token_fill='resolved';});
  let reads=0;const bad=contentDiagnostics(()=>{reads++;throw new Error('private getter');},new Proxy({},{get(){throw new Error('private fault');}}));
  await assert.rejects(bad.operation('fresh_goto',()=>{throw original;}),error=>error===original);
  assert.equal(reads,1);assert.equal(bad.packet().counts.latest,'unavailable');assert.equal(bad.packet().faults.page,'unavailable');
  assert.ok(!JSON.stringify(bad.packet()).includes('private getter')&&!JSON.stringify(bad.packet()).includes('private fault'));assert.equal(bad.packet().operations.latest.status,'unavailable');
  const reentrant=contentDiagnostics(()=>{assert.equal(reentrant.freeze('content_ready'),null);return {counts:{latest:Infinity,sse:-1,content:1000001},operations:{latest:{identity_match:true,status:500}},pending:0,failed:false};},{});
  await assert.rejects(reentrant.operation('session_title',()=>{throw original;}),error=>error===original);
  assert.equal(reentrant.packet().first_operation,'session_title');assert.equal(reentrant.packet().counts.latest,'unavailable');assert.equal(reentrant.packet().operations.latest.status,500);
  const publication=await specCase({success:true,injected:'session_title',publication:'FAILURE_BEFORE_CLEANUP.json'});
  assert.equal(publication.error,publication.failure);assert.equal(publication.saved.get('BROWSER_RESULT.json').first_failure.first_operation,'session_title');
  const serialization=await specCase({success:true,injected:'session_title',serialization:true});assert.equal(serialization.error,serialization.failure);
});
test('C53R1 M1 actual callback isolates persistent and final-only evidence getters with truthful independent artifacts',async t=>{
  for(const getter of ['factsGetter','countsGetter','evidenceGetter'])for(const schedule of [true,'final'])await t.test(`${getter} ${schedule}`,async()=>{
    const c=await specCase({success:true,injected:'session_title',[getter]:schedule});assert.equal(c.error,c.failure);
    const first=c.saved.get('FAILURE_BEFORE_CLEANUP.json');assert.equal(first.first_operation,'session_title');
    assert.deepEqual(c.packet,first);assert.ok(Object.isFrozen(c.packet));
    for(const step of ['context-close','browser-close','server-close','native-stop'])assert.ok(c.events.includes(step));
    for(const name of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json']){
      assert.ok(c.serializationAttempts.includes(name));assert.ok(c.events.includes(`save:${name}`));assert.ok(c.saved.has(name));
    }
    const cleanup=c.saved.get('CLEANUP.json'),measurement=c.saved.get('MEASUREMENTS.json'),result=c.saved.get('BROWSER_RESULT.json');
    const removed=schedule==='final'||getter==='countsGetter';
    assert.equal(c.events.includes('root-remove'),removed);assert.equal(cleanup.root_removed,removed);assert.equal(cleanup.pass,removed);
    assert.equal(cleanup.retained_root,removed?null:'/synthetic');assert.equal(result.cleanup,removed);assert.equal(result.status,'FAILED');
    assert.deepEqual(result.first_failure,first);assert.deepEqual(cleanup.first_failure,first);assert.ok(result.preparation_failures.length>0);
    assert.equal(measurement.body_success,false);for(const key of ['network','initial','after','geometry','projection'])assert.equal(measurement[key],null);
    if(getter==='evidenceGetter'){assert.equal(cleanup.native,null);assert.equal(cleanup.availability.native,'unavailable');assert.notEqual(result.counts,null);}
    else {assert.equal(result.counts,null);assert.equal(result.availability.counts,'unavailable');assert.notEqual(cleanup.native,null);}
    if(schedule==='final')assert.ok(cleanup.steps.every(step=>step.ok));
  });
});
test('C53R1 M1 final-only getter faults after successful body fail evidence without inventing root retention',async t=>{
  for(const getter of ['factsGetter','countsGetter','evidenceGetter'])await t.test(getter,async()=>{
    const c=await specCase({success:true,[getter]:'final'});assert.equal(c.error,c.publication);
    const cleanup=c.saved.get('CLEANUP.json'),result=c.saved.get('BROWSER_RESULT.json');
    assert.equal(cleanup.body_success,true);assert.equal(cleanup.root_removed,true);assert.equal(cleanup.retained_root,null);assert.equal(cleanup.pass,true);
    assert.equal(result.status,'FAILED');assert.equal(result.cleanup,true);assert.ok(result.preparation_failures.length>0);
    for(const name of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'])assert.ok(c.events.includes(`save:${name}`));
    if(getter!=='evidenceGetter'){assert.equal(c.saved.get('MEASUREMENTS.json').network,null);assert.equal(c.saved.get('MEASUREMENTS.json').availability.network,'unavailable');}
  });
});
test('C53R1 M1 artifact serialization faults do not suppress later independent attempts or replace the first packet',async t=>{
  for(const name of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'])await t.test(name,async()=>{
    const c=await specCase({success:true,injected:'session_title',serializationArtifact:name});assert.equal(c.error,c.failure);
    assert.equal(c.saved.has(name),false);assert.deepEqual(c.packet,c.saved.get('FAILURE_BEFORE_CLEANUP.json'));
    assert.deepEqual(c.serializationAttempts,['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json']);
    for(const later of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'].slice(['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'].indexOf(name)+1))assert.ok(c.events.includes(`save:${later}`));
    if(name!=='BROWSER_RESULT.json'){const result=c.saved.get('BROWSER_RESULT.json');assert.equal(result.status,'FAILED');assert.deepEqual(result.artifact_failures,[{artifact:name,phase:'serialization'}]);}
  });
});
test('C53R1 M1 actual acquired-context close boundary rejects held-discovery SSE failure and accepts close cancellations',async t=>{
  for(const sseSchedule of ['held-discovery','close-initiation','post-close'])await t.test(sseSchedule,async()=>{
    const c=await specCase({success:true,sseSchedule}),preclose=sseSchedule==='held-discovery';
    assert.equal(c.injection.context_started,!preclose);assert.equal(c.injection.facts.failed,preclose);assert.equal(c.injection.faults,preclose?1:0);
    assert.equal(c.injection.strict,!preclose);assert.equal(c.injection.safe,!preclose);
    assert.ok(c.events.lastIndexOf('tree-complete')<c.events.indexOf('closing'));assert.equal(c.events.indexOf('closing')+1,c.events.indexOf('context-close'));
    const cleanup=c.saved.get('CLEANUP.json'),result=c.saved.get('BROWSER_RESULT.json');
    assert.equal(cleanup.body_success,true);assert.equal(cleanup.pass,!preclose);assert.equal(cleanup.root_removed,!preclose);assert.equal(result.status,preclose?'FAILED':'PASS');
    assert.equal(cleanup.retained_root,preclose?'/synthetic':null);assert.equal(c.events.includes('root-remove'),!preclose);
    for(const step of ['context-close','browser-close','server-close','native-stop','retire-tree'])assert.ok(c.events.includes(step));
    observerWork(c.native.samples);assert.equal(c.native.samples.length,4);
    if(preclose){assert.ok(c.events.indexOf('discovery-held')<c.events.indexOf('sse-failed'));assert.ok(c.events.indexOf('sse-failed')<c.events.indexOf('discovery-release'));
      assert.ok(cleanup.steps.some(step=>step.name==='collector-drain'&&!step.ok));assert.ok(cleanup.steps.some(step=>step.name==='root'&&!step.ok));assert.throws(()=>c.collected.network.proof());}
    else c.collected.network.proof();
  });
});
test('C53R1 M2 actual root disposer retains pre-deletion original failures and duplicates without replacing the first error or packet',async t=>{
  for(const cleanupSchedule of ['before-proof','files-failed','binding-failed','files-duplicate','binding-duplicate','rm-started'])for(const injected of [undefined,'zero_faults'])await t.test(`${cleanupSchedule} ${injected??'completed body'}`,async()=>{
    const c=await specCase({success:true,cleanupSchedule,injected}),removed=cleanupSchedule==='rm-started';
    const cleanup=c.saved.get('CLEANUP.json'),result=c.saved.get('BROWSER_RESULT.json');
    assert.equal(c.injection.before.failed,false);assert.equal(c.injection.before.pending,0);assert.equal(c.injection.before.counts.content,1);
    assert.equal(c.injection.facts.failed,true);assert.equal(c.injection.faults,1);
    assert.equal(result.counts.content,cleanupSchedule.endsWith('duplicate')?2:1);assert.throws(()=>c.collected.network.proof());
    assert.equal(c.events.includes('root-remove'),removed);assert.equal(cleanup.root_removed,removed);assert.equal(cleanup.retained_root,removed?null:'/synthetic');
    assert.equal(cleanup.pass,false);assert.equal(result.cleanup,false);assert.equal(result.status,'FAILED');
    assert.equal(cleanup.steps.find(step=>step.name==='root').ok,removed);assert.ok(cleanup.steps.some(step=>step.name==='final-collector'&&!step.ok));
    assert.equal(c.error,injected?c.failure:c.first);assert.ok(Object.isFrozen(c.packet));
    assert.deepEqual(cleanup.first_failure,c.packet);assert.deepEqual(result.first_failure,c.packet);
    if(injected){assert.equal(c.packet.first_operation,injected);assert.equal(c.packet.collector_failed,false);
      assert.deepEqual(c.saved.get('FAILURE_BEFORE_CLEANUP.json'),c.packet);assert.equal(c.saved.get('MEASUREMENTS.json').body_success,false);}
    else {assert.equal(c.packet.first_operation,'outside_path');assert.equal(c.packet.collector_failed,true);observerWork(c.native.samples);}
    for(const step of ['context-close','browser-close','server-close','native-stop','retire-tree'])assert.ok(c.events.includes(step));
    for(const name of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'])assert.ok(c.saved.has(name));
    assert.deepEqual(c.serializationAttempts,['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json']);
    if(cleanupSchedule.startsWith('files-')||cleanupSchedule.startsWith('binding-')){
      const seam=cleanupSchedule.split('-')[0];assert.ok(c.events.indexOf('root-proof')<c.events.indexOf(`${seam}-held`));
      assert.ok(c.events.indexOf(`${seam}-held`)<c.events.indexOf('cleanup-injected'));assert.ok(c.events.indexOf('cleanup-injected')<c.events.indexOf(`${seam}-release`));
    }
    if(removed)assert.ok(c.events.indexOf('root-remove')<c.events.indexOf('cleanup-injected'));
    for(const key of ['setup_content','before','within','entry','mutations','helper_http'])assert.equal(result.counts[key],0);
  });
});
test('C53R1 M2 final pre-deletion drain waits for real pending content metadata and retains on rejection',async t=>{
  for(const seam of ['files','binding'])for(const outcome of ['reject','resolve'])await t.test(`${seam} ${outcome}`,async()=>{
    const c=await specCase({success:true,injected:'content_click',cleanupSchedule:`${seam}-pending-${outcome}`}),removed=outcome==='resolve';
    const cleanup=c.saved.get('CLEANUP.json'),result=c.saved.get('BROWSER_RESULT.json');
    assert.equal(c.injection.before.counts.content,0);assert.equal(c.injection.before.failed,false);assert.equal(c.injection.before.pending,0);
    assert.equal(c.injection.facts.counts.content,1);assert.equal(c.injection.facts.pending,1);assert.equal(c.injection.facts.failed,false);
    assert.ok(c.events.indexOf(`${seam}-release`)<c.events.indexOf('drain-pending'));assert.ok(c.events.indexOf('drain-pending')<c.events.indexOf('metadata-settled'));
    assert.equal(c.collected.network.facts().pending,0);assert.equal(c.collected.network.facts().failed,!removed);
    assert.equal(c.events.includes('root-remove'),removed);assert.equal(cleanup.root_removed,removed);assert.equal(cleanup.retained_root,removed?null:'/synthetic');
    if(removed)assert.ok(c.events.indexOf('metadata-settled')<c.events.indexOf('root-remove'));
    assert.equal(cleanup.steps.find(step=>step.name==='root').ok,removed);assert.equal(cleanup.pass,removed);assert.equal(result.cleanup,removed);assert.equal(result.status,'FAILED');
    assert.equal(c.error,c.failure);assert.equal(c.first,c.failure);assert.equal(c.packet.first_operation,'content_click');assert.equal(c.packet.counts.content,0);
    assert.equal(c.packet.collector_failed,false);assert.equal(c.packet.pending,0);assert.ok(Object.isFrozen(c.packet));
    assert.deepEqual(c.saved.get('FAILURE_BEFORE_CLEANUP.json'),c.packet);assert.deepEqual(result.first_failure,c.packet);assert.deepEqual(cleanup.first_failure,c.packet);
    const measurement=c.saved.get('MEASUREMENTS.json');assert.equal(measurement.body_success,false);for(const key of ['network','initial','after','geometry','projection'])assert.equal(measurement[key],null);
    for(const step of ['context-close','browser-close','server-close','native-stop','retire-tree'])assert.ok(c.events.includes(step));
    for(const name of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'])assert.ok(c.saved.has(name));
  });
});
test('C53R1 M1 close admission does not exempt unmatched, reply-less or non-SSE failures',async t=>{
  for(const name of ['unmatched','reply-less','non-SSE'])await t.test(name,async()=>{
    const c=networkCase();let failed;
    if(name==='reply-less'){
      const q=request();c.network.request(q);c.network.response(response(q));c.network.finished(q);await c.network.drain();
      failed=request(`/events?after=${encodeURIComponent(expectedPage(1).live_after)}`);c.network.request(failed);
    }else {const {q}=await initialNetwork(c);failed=name==='unmatched'?request(`/events?after=${encodeURIComponent(expectedPage(1).live_after)}`):q;}
    c.network.closing();c.network.failed(failed);assert.equal(c.faults.collector,1);assert.equal(c.network.facts().failed,true);
    assert.throws(()=>c.network.cleanupProof());assert.throws(()=>c.network.proof());
  });
});
test('C53R1 successful body publication failure never publishes a passing verdict or replaces the publication error',async t=>{
  for(const name of ['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json'])await t.test(name,async()=>{
    const c=await specCase({success:true,publication:name});assert.equal(c.error,c.publication);assert.ok(c.events.includes('root-remove'));
    assert.deepEqual(c.serializationAttempts,['CLEANUP.json','MEASUREMENTS.json','BROWSER_RESULT.json']);
    if(name!=='BROWSER_RESULT.json'){const result=c.saved.get('BROWSER_RESULT.json');assert.equal(result.status,'FAILED');assert.deepEqual(result.artifact_failures,[{artifact:name,phase:'write'}]);}
  });
});
test('C53R1 actual finite browser discovery rejects enumeration/stat/anchor gaps before retirement authority',async t=>{
  for(const kind of ['enumeration','stat','anchor'])await t.test(kind,async()=>{
    const f=procFixture();f.add(2,1);f.add(3,2);
    if(kind==='enumeration')f.io.readdir=async()=>{throw new Error('unavailable');};
    if(kind==='stat'){const read=f.io.readFile;f.io.readFile=async p=>{if(p==='/proc/3/stat')throw new Error('gap');return read(p);};}
    if(kind==='anchor')f.values.set('/proc/2/exe','/changed');await assert.rejects(browserTree(ident(2,1),f.io));
  });
});
test('C53 private output reservation is exclusive and actual directory/marker modes are correct',async()=>{
  const fixture=await createRestartRoot();const output=join(fixture.root,'evidence');
  try {assert.equal(await reserveOutput({outputPath:name=>{assert.equal(name,'c53-evidence');return output;}}),output);
    assert.equal((await fs.lstat(output)).mode&0o777,0o700);assert.equal((await fs.lstat(join(output,'C53.once.json'))).mode&0o777,0o600);
    await assert.rejects(reserveOutput({outputPath:()=>output}));await assert.rejects(reserveOutput({outputPath:()=> 'relative'}));
  }finally{await fs.rm(fixture.root,{recursive:true});}
});
test('C53 specific static privacy guards bind the actual sources without assignment-only fixture paths',async t=>{
  const spec=await fs.readFile(specPath,'utf8'),helper=await fs.readFile(new URL('../test-support/content-measurements.mjs',import.meta.url),'utf8');sourceGuard(spec,helper);
  for(const text of ['q.body()','q.json()','q.text()','q.arrayBuffer()','newCDPSession()','q._channel','test.skip()','globalThis.fetch = f','fetch(url)','sampler(probe)','memoryProbe()','console.log(owner)'])await t.test(text,()=>{
    const changed=helper.replace('export function sourceGuard',`${text};\nexport function sourceGuard`);assert.throws(()=>sourceGuard(spec,changed));
    assert.throws(()=>sourceGuard(`${spec}\n${text}`,helper));
  });
  for(const old of ["context.on('requestfailed', network.failed)","reserveOutput(testInfo)","name: 'Load older', exact: true","host: '127.0.0.1'"])
    assert.throws(()=>sourceGuard(spec.replace(old,''),helper));
  assert.ok(!spec.includes('/home/'));assert.ok(!spec.includes('WI_C53_EVIDENCE'));assert.ok(!spec.includes('upgradedProof'));
});
