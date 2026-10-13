import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lstat, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { createRestartRoot, workKeys } from '../test-support/restart-display.mjs';
import { files } from '../test-support/interrupted-display-parity.mjs';
import { expectedBlock } from '../test-support/rich-display-parity.mjs';
import { sid, head, facts, previous, digest, seedLegacy, ownedFilesProof, snapshot, legacyProof, upgradedProof, catalogProof, projectionTables, expectedPage, pageProof, entryProof, domProof,
  sameDom, collector, newRecord, newFaults, observationOrder, observerWork, requestProof, handleFacts, cleanupProof, removeUpgradeRoot, publicPrivacy, connectDiagnostics, reportUpgradeFailure } from '../test-support/upgrade-display-parity.mjs';
const clone = structuredClone;
const zero = () => Object.fromEntries(workKeys.map(k=>[k,k==='fresh_empty'?false:0]));
const samples = () => [...Array.from({length:3},(_,i)=>({event:'sample',id:i+1,work:zero()})),{event:'stopped',id:4,work:zero()}];
function cleanup() {
  return {closed:[true,true],rootRemoved:true,handles:{active:0,opens:2,closes:2},processes:[0,1].map(i=>({phase:'observe',pid:0xffffffff-1-i,
    identity:{start_ticks:String(i+1),executable:'/synthetic/fixture'},cwd:'/synthetic/observe',closed:true,reaped:true,stderr_bytes:0,error:false,fallback:false,
    same_start_alive:false,expected_kill:false,code:0,signal:null,drained:true,samples:samples()}))};
}
test('actual independent released schema2 seeder preserves canonical facts, constraints and catalog missing row',async()=>{
  const fixture=await createRestartRoot();
  try {
    const seed=await seedLegacy(fixture),before=snapshot(fixture);
    assert.equal(legacyProof(before,seed),true);assert.equal(catalogProof(fixture),true);assert.equal(await ownedFilesProof(fixture),true);assert.equal(before.version,2);
    assert.equal(before.canonical.events.length,21);assert.equal(before.canonical.commands.length,2);assert.equal(before.canonical.runs.length,2);
    assert.deepEqual(before.canonical.tool_results.map(r=>[r[7],r[8]]),facts.map(f=>[Number(f.is_error),f.tool]));
    assert.deepEqual(before.canonical.runs.map(r=>[r[1],r[2],r[8]]),[[2,'completed',11],[12,'completed',21]]);
    assert.equal(JSON.parse(before.canonical.events[1][8]).input.user_text,facts[0].user);
    for(const change of [s=>{s.version=3;},s=>{s.schema=1;},s=>{s.names=['conversation_projection'];},s=>{s.projection={conversation_projection:[]};},
      s=>{s.canonical.manifest[0][7]=22;},s=>{s.canonical.events[4][8]+=' ';},s=>{s.canonical.commands[0][5]+=' ';},s=>{s.canonical.commands[0][2]='0'.repeat(64);},
      s=>{s.canonical.manifest[0][8]+=' ';},s=>{s.canonical.runs[0][7]+=' ';},s=>{s.canonical.tool_results[1][8]+=' ';},s=>{s.canonical.tool_results[1][7]=0;},s=>{s.definitions.pop();}]) {
      const changed=clone(before);change(changed);assert.throws(()=>legacyProof(changed,seed));
    }
    assert.equal(handleFacts().active,0);assert.equal(handleFacts().opens,handleFacts().closes);
    const invalid=cleanup();invalid.processes[0].fallback=true;
    await assert.rejects(removeUpgradeRoot(fixture,invalid.processes.map(p=>({pid:p.pid,evidence:()=>p})),invalid.closed));
    assert.equal((await lstat(fixture.root)).isDirectory(),true);
    const clean=cleanup();assert.equal(await removeUpgradeRoot(fixture,clean.processes.map(p=>({pid:p.pid,evidence:()=>p})),clean.closed),true);
    await assert.rejects(lstat(fixture.root),e=>e.code==='ENOENT');
  }catch{assert.fail('Seeder or owned cleanup control failed');}
  finally{await rm(fixture.root,{recursive:true,force:true});}
});
for(const path of ['private-data','private-data/sessions',`private-data/sessions/${sid.slice(0,2)}`,`private-data/sessions/${sid.slice(0,2)}/${sid}`,
  'private-data/catalog.sqlite3',`private-data/sessions/${sid.slice(0,2)}/${sid}/session.sqlite3`])test(`actual seeded ownership rejects public mode: ${path}`,async()=>{
  const fixture=await createRestartRoot();
  try{await seedLegacy(fixture);const target=join(fixture.root,path),metadata=await lstat(target);assert.equal(metadata.mode&0o777,metadata.isDirectory()?0o700:0o600);
    await chmod(target,metadata.mode|0o044);await assert.rejects(ownedFilesProof(fixture));assert.equal(handleFacts().active,0);
  }catch{assert.fail('Owned mode control failed');}finally{await rm(fixture.root,{recursive:true,force:true});}
});
function upgraded() {
  const seed={canonical:{manifest:[[1,sid,1,'title',null,42,42,21,'synthetic']]},definitions:[['synthetic']]};
  const value={version:3,schema:3,names:[...projectionTables].sort(),canonical:clone(seed.canonical),definitions:clone(seed.definitions),projection:{
    conversation_projection:[[1,1,21,1]],conversation_blocks:[[],[]],conversation_entries:Array.from({length:6},()=>[]),conversation_fields:Array.from({length:8},()=>[]),conversation_chunks:Array.from({length:8},()=>[])}};
  return {seed,value};
}
test('actual upgraded checker constrains H, full canonical and warm rows',()=>{const {seed,value}=upgraded();assert.equal(upgradedProof(value,seed,clone(value)),true);});
for(const [name,change]of Object.entries({version:v=>{v.version=2;},manifest:v=>{v.schema=2;},missing:v=>{v.names.pop();},watermark:v=>{v.projection.conversation_projection[0][2]=22;},
  canonical:v=>{v.canonical.manifest[0][7]=22;},definitions:v=>{v.definitions[0].push('changed');},block:v=>{v.projection.conversation_blocks.pop();},
  entry:v=>{v.projection.conversation_entries.pop();},field:v=>{v.projection.conversation_fields.pop();},chunk:v=>{v.projection.conversation_chunks.pop();},
  warm:v=>{v.projection.conversation_chunks[0].push('changed');}}))test(`actual upgraded checker rejects ${name}`,()=>{const {seed,value}=upgraded(),held=clone(value);change(value);assert.throws(()=>upgradedProof(value,seed,held));});
for(const index of [0,1])test(`actual exact legacy ${index} DTO, addressed entry and DOM oracle`,()=>{
  const p=expectedPage(index);assert.equal(pageProof(p,index),p);assert.equal(domProof(expectedBlock(p),index),true);
  for(const entry of [p.block.human,...p.entries])assert.equal(entryProof({api_version:1,conversation_version:1,session_id:sid,snapshot_head:head,block:p.block,entry},index,entry).entry,entry);
});
const changes={H:p=>{p.snapshot_head='22';},session:p=>{p.session_id=facts[0].run;},run:p=>{p.block.run_id=facts[0].run;},accepted:p=>{p.block.accepted_sequence='11';},
  human:p=>{p.block.human.fields[0].text+=' ';},answer:p=>{p.entries[0].fields[0].text+=' ';},output:p=>{p.entries[1].fields[1].text+=' ';},is_error:p=>{p.entries[1].is_error=false;},
  toolResult:p=>{p.entries[1].result_recorded=false;},toolFinish:p=>{p.entries[1].finish_recorded=false;},result:p=>{p.block.result_recorded=false;},state:p=>{p.block.state='running';},
  entry:p=>{p.entries[0].entry_id='e:14:0';},field:p=>{p.entries[0].fields[0].field_id='f'.repeat(64);},order:p=>{p.entries.reverse();},group:p=>{p.entries.push(p.block.human);},
  duplicate:p=>{p.entries.push(clone(p.entries[0]));},epoch:p=>{p.entries[1].content_epoch='17';},generation:p=>{p.entries[1].fields[1].generation='16';},
  range:p=>{p.entries[1].fields[1].from_byte='1';},total:p=>{p.entries[0].fields[0].total_bytes='1';},provisional:p=>{p.entries[0].provisional=true;},
  cursor:p=>{p.previous_block=null;},live:p=>{p.live_after=null;},recorded:p=>{p.entries[1].recorded_state='completed';},revision:p=>{p.entries[1].revision='19';},
  content:p=>{p.entries[0].content_complete=false;},fields:p=>{p.entries[1].fields.reverse();},private:p=>{p.internal='private-native';}};
for(const[name,change]of Object.entries(changes))test(`actual supplied-fact DTO rejects ${name}`,()=>{const p=expectedPage(1);change(p);assert.throws(()=>pageProof(p,1));});
for(const[name,change]of Object.entries({identity:p=>{p.entry.entry_id='e:14:0';},H:p=>{p.snapshot_head='22';},block:p=>{p.block.result_recorded=false;},output:p=>{p.entry.fields[1].text+=' ';}}))test(`actual addressed checker rejects ${name}`,()=>{
  const page=expectedPage(1),entry=clone(page.entries[1]),p={api_version:1,conversation_version:1,session_id:sid,snapshot_head:head,block:clone(page.block),entry:clone(entry)};
  change(p);assert.throws(()=>entryProof(p,1,entry));
});
for(const[name,change]of Object.entries({human:v=>{v.entries[0].fields[0].ranges[0].text+=' ';},output:v=>{v.entries[2].fields[1].ranges[0].text+=' ';},state:v=>{v.entries[2].state='completed';},
  duplicate:v=>{v.entries.push(clone(v.entries[1]));},order:v=>{v.entries.reverse();},ID:v=>{v.entries[1].entry_id='e:99:0';},result:v=>{v.status='Execution: completed. Final result not recorded.';},
  generation:v=>{v.entries[2].fields[1].metadata+=' ';},range:v=>{v.entries[1].fields[0].ranges[0].range='text:1';}}))test(`actual DOM checker rejects ${name}`,()=>{const v=expectedBlock(expectedPage(1));change(v);assert.throws(()=>domProof(v,1));});
for(const[a,b]of [['',''],['a','b'],[null,null]])test('actual normalized DOM checker rejects absent or different content',()=>assert.throws(()=>sameDom(a,b)));
const origin='http://127.0.0.1:1234',base=`/v1/sessions/${sid}/conversation`,owner='synthetic-owner';
function request(path=base,method='GET',extra={}){return {url:()=>origin+path,method:()=>method,headers:()=>({authorization:`Bearer ${owner}`,...extra})};}
function response(req,type='application/json',status=200,extra={}){return {url:req.url,request:()=>req,status:()=>status,
  headers:()=>({'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff',...extra}),body:()=>{throw new Error('No original body read');}};}
function collecting(){const record=newRecord(),faults=newFaults(),assetReads=[],c=collector({origin,owner,record,faults,assetReads});return {record,faults,assetReads,c};}
function handshake(){const h=collecting(),req=request(),reply=response(req),stream=request(`${base}/events?after=${encodeURIComponent(expectedPage(1).live_after)}`);
  h.c.request(req);h.c.response(reply);h.c.request(stream);h.c.response(response(stream,'text/event-stream'));return {...h,reply};}
function finished(){const h=handshake(),r=h.record;r.newest=true;r.events.push('newest-rendered');r.intent=true;r.events.push('upward-intent');
  h.c.request(request(`${base}?before=${encodeURIComponent(previous)}`));r.events.push('older-rendered');r.assets=new Set(files.keys());r.prekey={focused:true,top:0,height:800,viewport:500};r.setup_reads=0;return h;}
test('actual callback collector and ordering bind original response before helpers and after-H stream without body reads',async()=>{
  const h=handshake(),order=observationOrder();order.selected();order.displayed(h.record,h.reply);let calls=0;
  assert.equal(await order.read(async()=>{calls++;return 7;}),7);assert.equal(calls,1);order.handshake(h.record,h.reply,expectedPage(1),origin);
  const f=finished();assert.equal(requestProof(f.record),true);assert.equal(f.faults.collector,0);assert.equal(f.faults.request,0);
});
test('actual guard rejects helper-first without executing callback',async()=>{const order=observationOrder();order.selected();let calls=0;await assert.rejects(order.read(async()=>{calls++;}));assert.equal(calls,0);});
for(const[name,change]of Object.entries({missing:h=>{h.record.snapshots=[];},early:h=>{h.record.streams[0].index=-1;},request:h=>{h.record.snapshots[0].request=request();},
  response:h=>{h.record.snapshots[0].response=response(request());},stream:h=>{h.record.streams[0].reply=response(request(),'text/event-stream');},unbound:h=>{h.record.streams[0].response=null;},
  cursor:h=>{h.record.streams[0].request.url=()=>origin+base+'/events?after=wrong';},status:h=>{h.reply.status=()=>401;}}))test(`actual original handshake rejects ${name}`,()=>{
  const h=handshake(),order=observationOrder();change(h);order.selected();assert.throws(()=>{order.displayed(h.record,h.reply);order.handshake(h.record,h.reply,expectedPage(1),origin);});
});
for(const mode of ['unselected','older-first','duplicate','no-handshake','finish-twice','read-after-finish'])test(`actual ordering rejects ${mode}`,async()=>{
  const h=handshake(),order=observationOrder();if(mode!=='unselected')order.selected();if(mode==='older-first')h.record.older.push({});
  if(['unselected','older-first'].includes(mode)){assert.throws(()=>order.displayed(h.record,h.reply));return;}
  order.displayed(h.record,h.reply);if(mode==='duplicate'){assert.throws(()=>order.displayed(h.record,h.reply));return;}
  if(mode==='no-handshake'){assert.throws(()=>order.finish(finished().record));return;}
  order.handshake(h.record,h.reply,expectedPage(1),origin);order.finish(finished().record);
  if(mode==='finish-twice')assert.throws(()=>order.finish(finished().record));else await assert.rejects(order.read(async()=>true));
});
for(const[path,method]of [[base,'POST'],[base,'PUT'],[base,'PATCH'],[base,'DELETE'],[`/v1/sessions/${sid}/runs`,'POST'],[`/v1/sessions/${sid}/runs/reconcile`,'POST'],
  [`/v1/sessions/${sid}/runs/${facts[1].run}/cancel`,'POST'],[`/v1/sessions/${sid}/history`,'GET'],[`${base}/content?cursor=x`,'GET'],[base+'?within=x','GET'],[base+'?before=x','GET']])test(`actual collector rejects ${method}/${path}`,()=>{
  const h=collecting();h.c.request(request(path,method));assert(h.faults.request>0);
});
for(const name of ['early','no-intent','wrong-cursor','extra'])test(`actual older collector rejects ${name}`,()=>{
  const h=handshake();h.record.newest=name!=='early';h.record.intent=name!=='no-intent';const path=`${base}?before=${name==='wrong-cursor'?'wrong':encodeURIComponent(previous)}`;
  h.c.request(request(path));if(name==='extra')h.c.request(request(path));assert(h.faults.request>0);
});
for(const[name,extra]of Object.entries({missing:{authorization:undefined},wrong:{authorization:'wrong'},cookie:{cookie:'synthetic'},origin:{origin:'https://external.invalid'}}))test(`actual collector rejects access ${name}`,()=>{
  const h=collecting();h.c.request(request(base,'GET',extra));assert.equal(h.faults.request,1);
});
for(const[name,extra]of Object.entries({cache:{'cache-control':'public'},cookie:{'set-cookie':'synthetic'},media:{'content-type':'text/plain'},nosniff:{'x-content-type-options':undefined}}))test(`actual response callback rejects ${name}`,()=>{
  const h=handshake();h.c.response(response(h.record.snapshots[0].request,'application/json',200,extra));assert.equal(h.faults.collector,1);
});
test('actual route callback aborts external requests and latches route failures',async()=>{const h=collecting();let aborted=0,continued=0;
  await h.c.route({request:()=>({url:()=> 'https://external.invalid/'}),abort:async()=>{aborted++;}});
  await h.c.route({request,continue:async()=>{continued++;}});await h.c.route({request:()=>{throw new Error('synthetic');}});
  assert.equal(aborted,1);assert.equal(continued,1);assert.equal(h.faults.external,1);assert.equal(h.faults.collector,1);
});
test('actual asset callback reads only compiled bytes and detects mismatches',async()=>{
  const h=collecting(),req=request('/assets/wi.css'),reply=response(req,'text/css; charset=utf-8');reply.body=async()=>readFileSync(new URL('../style.css',import.meta.url));
  h.c.response(reply);await Promise.all(h.assetReads);assert.equal(h.record.assets.has('/assets/wi.css'),true);assert.equal(h.faults.response,0);
  reply.body=async()=>Buffer.from('wrong');h.c.response(reply);await Promise.all(h.assetReads);assert.equal(h.faults.response,1);
});
for(const secret of [owner,'private-native','principal_digest','f'.repeat(64)])test('actual public privacy rejects private facts',()=>assert.throws(()=>publicPrivacy({text:secret},owner)));
test('actual public privacy permits only allowlisted field identity',()=>{assert.equal(publicPrivacy(expectedPage(1),owner),true);assert.throws(()=>publicPrivacy({other:'f'.repeat(64)},owner));});
for(const[name,change]of Object.entries({mutation:r=>{r.requests.push({method:'POST'});},Latest:r=>{r.snapshots.push({});},stream:r=>{r.streams=[];},older:r=>{r.older.push({});},
  asset:r=>{r.assets.delete('/');},setup:r=>{r.setup_reads=1;},focus:r=>{r.prekey.focused=false;},top:r=>{r.prekey.top=97;},overflow:r=>{r.prekey.height=400;},order:r=>{r.events.reverse();}}))test(`actual final request guard rejects ${name}`,()=>{
  const h=finished();change(h.record);assert.throws(()=>requestProof(h.record));
});
for(const key of workKeys)test(`actual observer-work assertion rejects ${key}`,()=>{const s=samples();s[1].work[key]=key==='fresh_empty'?true:1;assert.throws(()=>observerWork(s));});
test('actual observer-work boundary rejects incomplete samples',()=>{assert.equal(observerWork(samples()),true);assert.throws(()=>observerWork(samples().slice(1)));assert.throws(()=>observerWork(samples().reverse()));});
test('actual cleanup requires two normal drains, handles closed and owned root absent',()=>assert.equal(cleanupProof(cleanup()),true));
for(const index of [0,1])for(const key of ['closed','reaped','stderr_bytes','error','fallback','same_start_alive','expected_kill','code','signal','drained'])test(`actual cleanup rejects observer ${index}/${key}`,()=>{
  const c=cleanup();c.processes[index][key]=typeof c.processes[index][key]==='boolean'?!c.processes[index][key]:key==='signal'?'SIGTERM':1;assert.throws(()=>cleanupProof(c));
});
for(const[name,change]of Object.entries({context:c=>{c.closed[1]=false;},root:c=>{c.rootRemoved=false;},handle:c=>{c.handles.active=1;},counts:c=>{c.handles.closes=1;},
  pid:c=>{c.processes[1].pid=c.processes[0].pid;},identity:c=>{delete c.processes[1].identity.start_ticks;},executable:c=>{c.processes[1].identity.executable='wrong';},
  phase:c=>{c.processes[0].phase='produce';},work:c=>{c.processes[1].samples[1].work.completed=1;}}))test(`actual strict cleanup rejects ${name}`,()=>{const c=cleanup();change(c);assert.throws(()=>cleanupProof(c));});
const spec=readFileSync(new URL('../e2e/upgrade-display-parity.spec.mjs',import.meta.url),'utf8');
function sourceGuard(text){
  const ast=ts.createSourceFile('upgrade.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),calls=[];
  function visit(n){if(ts.isCallExpression(n))calls.push(n);ts.forEachChild(n,visit);}visit(ast);
  const named=name=>calls.filter(c=>c.expression.getText(ast)===name),one=name=>{assert.equal(named(name).length,1);return named(name)[0];};
  assert(ts.isArrowFunction(one('test').arguments[1]));assert(text.includes('for (const index of [0,1])'));
  for(const name of ['seedLegacy','startRestartProcess','process.stopObserver','removeUpgradeRoot'])assert(ts.isAwaitExpression(one(name).parent));
  assert.equal(named('browser.newContext').length,1);assert.deepEqual(named('context.on').map(c=>c.arguments.map(a=>a.getText(ast))),[["'request'",'c.request'],["'response'",'c.response']]);
  assert(one('order.displayed').pos<one('order.handshake').pos);assert(one('process.stopObserver').pos<one('removeUpgradeRoot').pos);
  assert(text.includes('return order.read(async()=>'));assert(text.includes('await c.route(route)'));assert(text.includes('legacyProof(before,seed)'));
  assert.deepEqual(named('connect.operation').map(c=>c.arguments[0].getText(ast)),["'latest_response'","'token_fill'","'connect_click'","'token_cleared'","'streaming_status'","'sse_200'"]);
  for(const c of named('connect.operation'))assert(ts.isArrowFunction(c.arguments[1]));
  const latest=one('page.waitForResponse');assert.equal(latest.parent.getText(ast),'()=>page.waitForResponse(q=>r.snapshots.some(s=>s.request===q.request()))');
  assert(text.includes("connect=undefined;"));assert(text.indexOf('connect=undefined;')<one('startRestartProcess').pos);
  assert(text.includes("check='connect';connect=connectDiagnostics(index,r,faults);"));
  assert(text.includes("await Promise.all([connect.operation('latest_response'"));
  assert.equal(one('reportUpgradeFailure').getText(ast),'reportUpgradeFailure(error,stage,check,connect)');
  assert(ts.isCatchClause(one('reportUpgradeFailure').parent.parent.parent.parent));
  assert.equal(digest(text.replace(/\s+/g,'')),'a2e0e474f7275cb212506f6860598cfc92f5e666fef4023339b83d9bf3fb68b6');
  for(const c of calls)assert(!/(?:newCDPSession|fulfill|dispatchEvent|setTimeout|setDefaultTimeout)$|^test\.(?:only|skip|fixme)$/.test(c.expression.getText(ast)));
  return true;
}
test('actual new case registers seeder, original handshake, independent checker, collector, older action and strict cleanup',()=>assert.equal(sourceGuard(spec),true));
const sourceChanges={seed:s=>s.replace('await seedLegacy(fixture)','null'),premature:s=>s.replace('legacyProof(before,seed)','true'),
  oneBrowser:s=>s.replace('for (const index of [0,1])','for (const index of [0])'),shared:s=>s.replace('await browser.newContext(','contexts[0] || await browser.newContext('),
  guard:s=>s.replace('return order.read(async()=>','return (async()=>'),original:s=>s.replace('order.displayed(r,reply)','true'),handshake:s=>s.replace('order.handshake(r,reply,latest,process.origin)','true'),
  collector:s=>s.replace("context.on('request',c.request)","context.on('request',()=>{})"),response:s=>s.replace("context.on('response',c.response)","context.on('response',()=>{})"),
  route:s=>s.replace('await c.route(route)','true'),DTO:s=>s.replace('pageProof(v,1)','v'),entry:s=>s.replace('entryProof(v,1,entry)','v'),DOM:s=>s.replace('domProof(await displayedBlock(run(task)),task)','true'),
  exact:s=>s.replace('sameDom(newestDom,dom[1])','true'),snapshot:s=>s.replace('upgradedProof(upgraded,seed,held)','true'),
  cursor:s=>s.replace('expect(latest.previous_block).toBe(previous)','true'),setup:s=>s.replace('expect(r.setup_reads).toBe(0)','true'),intent:s=>s.replace("await page.keyboard.press('Home')",'true'),
  work:s=>s.replace('await process.sample()','true'),assets:s=>s.replace('await Promise.all(assetReads)','true'),privacy:s=>s.replace('await boundary(page,context,fixture.owner)','true'),
  requests:s=>s.replace('requestProof(r)','true'),stop:s=>s.replace('await process.stopObserver()','process.stopObserver()'),cleanup:s=>s.replace('cleanupProof({closed,rootRemoved,processes:processes.map(p=>p.evidence()),handles:handleFacts()})','true'),
  body:s=>s.replace('order.displayed(r,reply)','await reply.body();order.displayed(r,reply)'),raw:s=>s.replace('dom:dom.map(digest)','dom'),token:s=>s.replace('head,preOpen,canonical:','owner:fixture.owner,head,preOpen,canonical:'),
  skip:s=>s.replace("test('genuine legacy","test.skip('genuine legacy"),timeout:s=>s.replace("let fixture, seed, held","test.setTimeout(180000);let fixture, seed, held")};
for(const[name,change]of Object.entries(sourceChanges))test(`actual case registration sensitivity rejects ${name}`,()=>{const value=change(spec);assert.notEqual(value,spec);assert.throws(()=>sourceGuard(value));});
for(const[name,change]of Object.entries({reset:s=>s.replace('connect=undefined;',''),controller:s=>s.replace('connectDiagnostics(index,r,faults)','connectDiagnostics(0,r,faults)'),
  latest:s=>s.replace("connect.operation('latest_response',()=>page.waitForResponse","connect.operation('token_fill',()=>page.waitForResponse"),
  fill:s=>s.replace("await connect.operation('token_fill'","connect.operation('token_fill'"),click:s=>s.replace("await connect.operation('connect_click'","connect.operation('connect_click'"),
  cleared:s=>s.replace("connect.operation('token_cleared'","connect.operation('sse_200'"),status:s=>s.replace("connect.operation('streaming_status'","connect.operation('sse_200'"),
  streamingCount:s=>s.replace('await expect(locator).toHaveCount(1)','true'),streamingText:s=>s.replace("exact(status,'connected; observation: streaming')","true"),
  sse:s=>s.replace('expect.poll(()=>r.streams[0]?.reply?.status()).toBe(200)','true'),catch:s=>s.replace('reportUpgradeFailure(error,stage,check,connect)','reportUpgradeFailure(error,stage,check,undefined)')}))
  test(`actual diagnostic source integration rejects ${name}`,()=>{const value=change(spec);assert.notEqual(value,spec);assert.throws(()=>sourceGuard(value));});

const phases=['latest_response','token_fill','connect_click','token_cleared','streaming_status','sse_200'];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function packet(diagnostic) {let value;diagnostic.emit(()=>{},p=>{value=p;return JSON.stringify(p);});return value;}
function connectSource() {
  const ast=ts.createSourceFile('upgrade.mjs',spec,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let clause;function visit(n){if(ts.isCatchClause(n)&&n.getText(ast).includes('reportUpgradeFailure'))clause=n;ts.forEachChild(n,visit);}visit(ast);
  const start=spec.indexOf("check='connect';"),end=spec.indexOf("check='original-b';"),cleanup=clause.parent.finallyBlock;
  return {operations:spec.slice(start,end),catch:clause.getText(ast),finally:cleanup.getText(ast)};
}
// Execute the registered operation block and its real catch/finally, with synthetic actions only.
async function actualConnect(h, options={}) {
  const calls=[],logs=[],failures=options.failures??{},index=options.index??0;
  let caught;
  const action=(phase,value)=>{calls.push(phase);const fail=failures[phase];if(fail?.sync)throw fail.error;if(fail)return Promise.reject(fail.error);return options.pending?.[phase]?.promise??Promise.resolve(value);};
  const page={waitForResponse:predicate=>{assert.equal(predicate(h.reply),true);return action('latest_response',h.reply);},
    getByLabel:(name,exact)=>{assert.equal(name,'Owner token');assert.deepEqual(exact,{exact:true});return {fill:token=>{assert.equal(token,owner);return action('token_fill');}};},
    getByRole:(role,props)=>{assert.equal(role,'button');assert.deepEqual(props,{name:'Connect',exact:true});return {click:()=>action('connect_click')};}};
  const status={textContent:()=>{calls.push('streaming_text');return options.streamingText??'connected; observation: streaming';}};
  const expect=locator=>({toHaveValue:value=>{assert.equal(value,'');return action('token_cleared');},toHaveCount:count=>{assert.equal(locator,status);assert.equal(count,1);return action('streaming_status');}});
  expect.poll=read=>({toBe:async value=>{if(value===200)await action('sse_200');assert.equal(await read(),value);}});
  const exact=new Function('expect',spec.slice(spec.indexOf('async function exact('),spec.indexOf('test.use('))+'return exact;')(expect);
  const parts=connectSource(),log=line=>{logs.push(line);options.log?.(line);};
  const report=(error,stage,check,diagnostic)=>{caught=error;options.beforeCatch?.();
    if(options.serialize){const original=diagnostic;diagnostic={emit:log=>original.emit(log,options.serialize)};}
    return reportUpgradeFailure(error,stage,check,diagnostic,log);};
  const invoke=new Function('page','expect','exact','status','index','r','faults','connectDiagnostics','reportUpgradeFailure','console','onCleanup',`return (async()=>{
    let connect,failure,stage=index===0?'upgrade':'reopen',check='fresh',rootRemoved=true;
    const fixture={owner:${JSON.stringify(owner)}},closed=[false],contexts=[{close:async()=>onCleanup()}],processes=[];
    const handleFacts=()=>({active:0,opens:0,closes:0}),cleanupProof=()=>true;
    try { ${parts.operations} } ${parts.catch} finally ${parts.finally}
    return {connect,failure,closed};
  })();`);
  const result=await invoke(page,expect,exact,status,index,h.record,h.faults,connectDiagnostics,report,{log},()=>options.cleanup?.());
  return {...result,caught,calls,logs};
}
test('actual operation block retains concurrent Latest/fill and fill-before-click registration',async()=>{
  const h=handshake(),fill=deferred(),latest=deferred();const run=actualConnect(h,{pending:{token_fill:fill,latest_response:latest}});
  fill.resolve();latest.resolve(h.reply);const result=await run;
  assert.deepEqual(result.calls,['latest_response','token_fill','connect_click','token_cleared','streaming_status','streaming_text','sse_200']);
  assert.equal(result.failure,undefined);assert.equal(packet(result.connect),undefined);assert.deepEqual(result.closed,[true]);
});
for(const phase of phases)for(const sync of [false,true])test(`actual operation/catch/cleanup attributes ${phase}/${sync?'sync':'async'}`,async()=>{
  const h=handshake(),error={message:'synthetic timed out secret'},result=await actualConnect(h,{failures:{[phase]:{error,sync}}});
  assert.equal(result.caught,error);assert.equal(result.failure.message,'Upgrade parity failed: upgrade/connect');assert.deepEqual(result.closed,[true]);
  const value=packet(result.connect);assert.equal(value.first_phase,phase);assert.equal(value.phases[phase],'failed');assert.equal(value.iteration,0);assert.equal(value.stage,'upgrade');
  for(const later of phases.slice(Math.max(2,phases.indexOf(phase))+1))assert.equal(value.phases[later],'not_started');
  if(phase==='token_fill'){assert.equal(value.phases.connect_click,'not_started');assert.equal(value.phases.token_cleared,'not_started');}
  assert(result.logs.some(l=>l.startsWith('Upgrade parity Connect diagnostic: {')));assert(result.logs.some(l=>l.includes('"timeout":true')));
  assert(result.logs.some(l=>l.startsWith('Upgrade parity cleanup:')));assert(!result.logs.join().includes('secret'));
});
test('actual exact streaming text rejection leaves SSE wait not_started',async()=>{
  const result=await actualConnect(handshake(),{streamingText:'not streaming'});
  assert.equal(packet(result.connect).first_phase,'streaming_status');assert.equal(packet(result.connect).phases.sse_200,'not_started');assert.deepEqual(result.closed,[true]);
});
test('actual SSE status assertion does not treat an observed error response as success',async()=>{
  const h=handshake();h.record.streams[0].reply.status=()=>422;
  const result=await actualConnect(h),p=packet(result.connect);assert.equal(p.first_phase,'sse_200');assert.equal(p.sse.status,422);assert.equal(p.phases.latest_response,'resolved');
});
test('actual Latest rejection freezes a pending fill without waiting for settlement or outer catch',async()=>{
  const h=handshake(),fill=deferred(),error={message:'synthetic'},result=await actualConnect(h,{pending:{token_fill:fill},failures:{latest_response:{error}},
    beforeCatch:()=>{h.faults.collector=99;h.record.snapshots[0].response.status=()=>500;},cleanup:()=>{h.record.streams=[];}});
  const frozen=packet(result.connect);assert.equal(frozen.phases.token_fill,'pending');assert.equal(frozen.phases.connect_click,'not_started');assert.equal(frozen.latest.status,200);assert.equal(frozen.faults.collector,0);assert.equal(frozen.counts.streams,1);
  fill.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(packet(result.connect),frozen);assert(result.calls.includes('connect_click'));
});
for(const sync of [true,false])test(`first operation rejection wins competing ${sync?'sync':'async'} errors with original identity`,async()=>{
  const h=handshake(),first={},second={},result=await actualConnect(h,{failures:{latest_response:{error:first,sync},token_fill:{error:second,sync}}});
  assert.equal(result.caught,first);assert.equal(packet(result.connect).first_phase,'latest_response');
  assert.equal(packet(result.connect).phases.token_fill,sync?'not_started':'pending');
});
test('synchronous fill rejection can win before an earlier registered asynchronous Latest rejection',async()=>{
  const h=handshake(),latest={},fill={},result=await actualConnect(h,{failures:{latest_response:{error:latest},token_fill:{error:fill,sync:true}}});
  // Promise.all propagates Latest here, but fill's own handler froze the earlier cutoff.
  assert.equal(packet(result.connect).first_phase,'token_fill');assert.equal(packet(result.connect).phases.latest_response,'pending');assert.equal(result.caught,latest);
});
test('owned packet holds only frozen finite scalars after late responses, record replacement and cleanup',async()=>{
  const h=handshake(),d=connectDiagnostics(0,h.record,h.faults),error={},latest=deferred();
  const waiting=d.operation('latest_response',()=>latest.promise);await assert.rejects(d.operation('token_fill',()=>{throw error;}),e=>e===error);
  const before=packet(d);latest.resolve(h.reply);await waiting;h.record.requests.push({});h.record.snapshots[0].request=request();h.record.snapshots[0].response=response(request());h.faults.private=5;
  assert.deepEqual(packet(d),before);assert.equal(before.phases.latest_response,'pending');
  function visit(value){if(value&&typeof value==='object'){assert(Object.isFrozen(value));for(const item of Object.values(value))visit(item);}else assert(['string','number','boolean'].includes(typeof value));}visit(before);
});
async function failedPacket(h,index=0){const d=connectDiagnostics(index,h.record,h.faults),error={};await assert.rejects(d.operation('token_fill',()=>Promise.reject(error)),e=>e===error);return packet(d);}
test('actual collector identity and finite counts/faults are copied without application success inference',async()=>{
  const h=handshake();h.faults.page=2;const p=await failedPacket(h);
  assert.deepEqual(p.latest,{request:true,response:true,identity_match:true,status:200,media:'json'});assert.deepEqual(p.sse,{request:true,response:true,identity_match:true,status:200,media:'sse'});
  assert.deepEqual(p.counts,{requests:2,snapshots:1,streams:1,older:0});assert.equal(p.faults.page,2);assert.equal(p.phases.latest_response,'not_started');
  assert(!JSON.stringify(p).includes('body'));assert(!JSON.stringify(p).includes('migration'));
});
for(const [name,change,expected]of [
  ['no-request',h=>{h.record.snapshots=[];}, {request:false,response:false,identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
  ['no-response',h=>{h.record.snapshots[0].response=null;},{request:true,response:false,identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
  ['same-url-wrong-request',h=>{h.record.snapshots[0].response=response(request());},{request:true,response:true,identity_match:false,status:'unavailable',media:'unavailable'}],
  ['throwing-request',h=>{h.reply.request=()=>{throw {};};},{request:true,response:true,identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
  ['missing-record',h=>{delete h.record.snapshots;},{request:'unavailable',response:'unavailable',identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
])test(`actual diagnostic exact Latest presence rejects inference from ${name}`,async()=>{const h=handshake();change(h);assert.deepEqual((await failedPacket(h)).latest,expected);});
for(const [name,change,expected]of [
  ['absent',h=>{h.record.streams=[];},{request:false,response:false,identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
  ['missing-reply',h=>{h.record.streams[0].reply=null;},{request:true,response:false,identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
  ['same-url-wrong-request',h=>{h.record.streams[0].reply=response(request(`${base}/events`),'text/event-stream');},{request:true,response:true,identity_match:false,status:'unavailable',media:'unavailable'}],
  ['missing-metadata',h=>{delete h.record.streams;},{request:'unavailable',response:'unavailable',identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
  ['throwing-reply',h=>{Object.defineProperty(h.record.streams[0],'reply',{get(){throw {};}});},{request:true,response:'unavailable',identity_match:'unavailable',status:'unavailable',media:'unavailable'}],
])test(`actual diagnostic exact SSE presence rejects inference from ${name}`,async()=>{const h=handshake();change(h);assert.deepEqual((await failedPacket(h)).sse,expected);});
for(const [name,status,expected]of [['ok',204,204],['unauthorized',401,401],['unavailable-display',422,422],['server-error',500,500],['string','secret','unavailable'],['NaN',NaN,'unavailable'],['infinite',Infinity,'unavailable'],['zero',0,'unavailable'],['missing',undefined,'unavailable']])
  test(`actual diagnostic numeric status ${name}`,async()=>{const h=handshake();h.reply.status=()=>status;h.record.streams[0].reply.status=()=>status;const p=await failedPacket(h);assert.equal(p.latest.status,expected);assert.equal(p.sse.status,expected);});
for(const [name,type,expected]of [['json','application/json; charset=utf-8','json'],['sse','text/event-stream; charset=utf-8','sse'],['other','secret-token raw/private','other'],['missing',undefined,'missing'],['empty','','missing'],['nonstring',{},'unavailable']])
  test(`actual diagnostic closed media ${name}`,async()=>{const h=handshake();h.reply.headers=()=>({'content-type':type});h.record.streams[0].reply.headers=h.reply.headers;const p=await failedPacket(h);assert.equal(p.latest.media,expected);assert.equal(p.sse.media,expected);assert(!JSON.stringify(p).includes('secret-token'));});
for(const [name,change]of Object.entries({status:h=>{h.reply.status=()=>{throw {};};},media:h=>{h.reply.headers=()=>{throw {};};},request:h=>{Object.defineProperty(h.record.snapshots[0],'request',{get(){throw {};}});},
  response:h=>{Object.defineProperty(h.record.snapshots[0],'response',{get(){throw {};}});},records:h=>{Object.defineProperty(h.record,'snapshots',{get(){throw {};}});},fault:h=>{Object.defineProperty(h.faults,'collector',{get(){throw {};}});}}))
  test(`actual diagnostic throwing ${name} metadata is unavailable and does not replace rejection`,async()=>{const h=handshake();change(h);const p=await failedPacket(h);assert(JSON.stringify(p).includes('unavailable'));assert.equal(p.first_phase,'token_fill');});
for(const value of ['secret',-1,NaN,Infinity,undefined])test('actual diagnostic invalid finite counters are unavailable',async()=>{const h=handshake();h.faults.private=value;h.record.requests={length:value};const p=await failedPacket(h);assert.equal(p.faults.private,'unavailable');assert.equal(p.counts.requests,'unavailable');});
test('actual diagnostic never reads original body, URL, raw headers, DOM or exception payload',async()=>{
  const h=handshake();let forbidden=0;
  for(const reply of [h.reply,h.record.streams[0].reply]){
    for(const key of ['url','body','text','json','allHeaders','finished'])Object.defineProperty(reply,key,{get(){forbidden++;throw {};}});
    reply.headers=()=>Object.defineProperty({'content-type':'private-token/raw'},'authorization',{get(){forbidden++;throw {};}});
  }
  const error=Object.defineProperty({},'message',{get(){throw 'private-error-token';}}),result=await actualConnect(h,{failures:{token_fill:{error}}});
  assert.equal(result.caught,error);assert.equal(forbidden,0);assert(result.logs.some(l=>l.includes('"timeout":"unavailable"')));
  assert(!result.logs.join().includes('private-token'));assert(!result.logs.join().includes('private-error-token'));assert.equal(packet(result.connect).latest.media,'other');
});
test('serialization and emission failures cannot prevent existing finite failure/cleanup reporting',async()=>{
  const h=handshake(),d=connectDiagnostics(0,h.record,h.faults),error={};await assert.rejects(d.operation('token_fill',()=>{throw error;}),e=>e===error);
  const lines=[];d.emit(line=>lines.push(line),()=>{throw 'private-serialization';});assert.deepEqual(lines,['Upgrade parity Connect diagnostic: unavailable']);
  let calls=0;d.emit(()=>{calls++;throw 'private-log';});assert.equal(calls,2);
  const unavailable=Object.defineProperty({},'emit',{get(){throw 'private-getter';}});
  assert.equal(reportUpgradeFailure(error,'upgrade','connect',unavailable,l=>lines.push(l)).message,'Upgrade parity failed: upgrade/connect');assert(lines.at(-1).startsWith('Upgrade parity failure:'));
  for(const options of [{serialize:()=>{throw 'private-serialization';}},{log:line=>{if(line.startsWith('Upgrade parity Connect diagnostic:'))throw 'private-log';}}]){
    const result=await actualConnect(h,{...options,failures:{token_fill:{error}}});
    assert.equal(result.caught,error);assert.deepEqual(result.closed,[true]);assert(result.logs.some(l=>l.startsWith('Upgrade parity failure:')));assert(result.logs.some(l=>l.startsWith('Upgrade parity cleanup:')));
  }
  assert.doesNotThrow(()=>reportUpgradeFailure(error,'upgrade','connect',d,()=>{throw 'private-log';}));
});
test('diagnostic identity labels cannot emit malicious iteration/stage/check strings',async()=>{
  const p=await failedPacket(handshake(),'private-token');assert.equal(p.iteration,'unavailable');assert.equal(p.stage,'unavailable');
  const lines=[];const error=reportUpgradeFailure({},'private-stage','private-check',undefined,l=>lines.push(l));assert.equal(error.message,'Upgrade parity failed: unavailable/unavailable');assert(!lines.join().includes('private-'));
});
test('fresh iteration/reopen controller has no first-open settlement or packet inheritance',async()=>{
  const first=await actualConnect(handshake());assert.equal(first.failure,undefined);assert.equal(packet(first.connect),undefined);
  const h=handshake(),error={},second=await actualConnect(h,{index:1,failures:{token_fill:{error,sync:true}}});const p=packet(second.connect);
  assert.equal(p.iteration,1);assert.equal(p.stage,'reopen');assert.equal(p.first_phase,'token_fill');assert.equal(p.phases.connect_click,'not_started');
  const reset=new Function('connect','index','stage','check',spec.slice(spec.indexOf('connect=undefined;'),spec.indexOf('expect(await nativeBinding(binding.executable))'))+'return connect;');
  assert.equal(reset(second.connect,1),undefined);
  const lines=[];reportUpgradeFailure(error,'reopen','pre-spawn',undefined,l=>lines.push(l));assert.equal(lines.length,1);assert(lines[0].startsWith('Upgrade parity failure:'));
});
