import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as f from '../test-support/display-fixtures.mjs';
import { TASK, TITLE, RENAMED, ANSWER, ARGUMENTS, OUTPUT, nativeProof, pageProof, catalogProof,
  proveActiveRename, proveSavedHistory, ownedWorkspace, runOwned, handshakeProof } from '../test-support/saved-history-active-rename.mjs';

const workspace = '/synthetic/workspace';
const command = { operation_id: f.OID, run_id: f.RID, text: TASK };
const receipt = { operation_id: f.OID, session_id: f.SID, run_id: f.RID, first_sequence: '2', last_sequence: '3' };
const expected = { sid: f.SID, workspace, command, receipt };
function native(completed = false, head = completed ? '21' : '15') {
  return { protocol: 1, id: 1, event: 'inspect', gate: completed ? null : 3, requests: 2, connections: 1,
    auth_loads: 1, auth_prepares: 1, prepared_exact: 2, fresh_parents: 1, continuations: 1, tool_results: 1,
    completed: +completed, terminals: +completed, results: +completed, fresh_empty: true, restored_history: false,
    provider_failed: false, read_failure: null, provider_stage: completed ? 'finished' : 'request_records',
    sequence_count: head, accepted: [{ run_id: f.RID, accepted_sequence: '2' }], receipts: [receipt],
    response_finishes: [{ sequence: '8', provenance: 'native_terminal' }, ...(completed ? [{ sequence: '18', provenance: 'native_terminal' }] : [])],
    terminal_sequences: completed ? ['20'] : [], result_sequences: completed ? ['21'] : [] };
}
function page(completed = false, title = TITLE, head = completed ? '21' : '15') {
  const fields = (facts, sequence) => facts.map(([kind,text], i) => f.field({ kind, text,
    field_id: (i + 1).toString().repeat(64), order_key: f.order(({text:2,function_name:4,function_arguments:5,tool_name:6,tool_result:7})[kind]),
    generation: sequence, total_bytes: String(Buffer.byteLength(text)), to_byte: String(Buffer.byteLength(text)) }));
  const entry = (seq, facts, extra) => f.entry({ entry_id: `e:${seq}:0`, position: { sequence: seq, slot: '0' },
    revision: seq, content_epoch: seq, recorded_state: 'completed', provisional: false, fields: fields(facts,seq), ...extra });
  const summary = { turns_started: '2', turns_finished: '2', model_requests_attempted: '2', model_requests_admitted: '2',
    new_tool_dispatches: '1', tool_results_prepared: '1', reused_results: '0', last_request_id: f.OTHER, last_upstream_outcome: 'terminal_received' };
  return f.page({ snapshot_head: head, session: f.session(head, { title, workspace }), previous_block: null,
    live_after: f.cursor('l', head, '3', '', ''), block: f.block({ revision: completed ? '21' : '4',
      state: completed ? 'completed' : 'running', result_recorded: completed, outcome: completed ? {type:'completed'} : null,
      summary: completed ? summary : null, events_complete: completed ? true : null,
      human: f.human({ fields: [f.field({field_id:'text',order_key:'0',generation:'2',text:TASK,total_bytes:String(Buffer.byteLength(TASK)),to_byte:String(Buffer.byteLength(TASK))})] }) }),
    entries: [entry('7', [['function_name','add_numbers'],['function_arguments',ARGUMENTS]]),
      entry('10', [['tool_name','add_numbers'],['tool_result',OUTPUT]], {kind:'tool',result_recorded:true,finish_recorded:true,is_error:false}),
      entry('14', [['text', completed ? ANSWER : '42 雪']], {recorded_state: completed ? 'completed' : 'in_progress', provisional: !completed})] });
}
function catalog(title = TITLE, head = '1', seedId = f.OTHER) {
  const entry = (session_id, title, workspace, observed_head_sequence) => ({session_id,title,workspace,observed_head_sequence,
    created_at_ms:'1',updated_at_ms:'2',view:'catalog',availability:'ready',fault_code:null,last_run_id:null,last_run_state:null});
  const entries = [entry(f.SID,title,workspace,head),entry(seedId,'Fixture barrier seed',null,'1')]
    .sort((a,b)=>a.session_id.localeCompare(b.session_id));
  return {api_version:1,entries,has_more:false,next_after_id:entries.at(-1).session_id};
}
const dom = c => c.entries.map(e => ({title:e.title,current:String(e.session_id === f.SID),metadata:`Observed head: ${e.observed_head_sequence}\nAvailability: ${e.availability}\nObserved run: ${e.last_run_state ?? 'none'}\nCode: ${e.fault_code ?? 'none'}`}));
function schedule(change = () => {}, seedId = f.OTHER) {
  const calls = [], held = {native:native(),page:page(),dom:'exact active run'}, after = {native:native(false,'16'),page:page(false,RENAMED,'16'),dom:'exact active run'},
    final = {native:native(true),page:page(true,RENAMED),dom:'exact completed run'};
  let refresh = 0;
  const original = catalog(TITLE,'1',seedId);
  const io = {
    async refreshCatalog() { calls.push('refresh'); const value = ++refresh === 1 ? original : catalog(RENAMED,'16',seedId); if(refresh>1)Object.assign(value.entries.find(e=>e.session_id===f.SID),{last_run_id:f.RID,last_run_state:'running'}); return {value,dom:dom(value)}; },
    async startTask() { calls.push('task'); return {command,receipt}; },
    async capture(done, title) { calls.push(done ? 'completed' : title === TITLE ? 'held' : 'renamed'); return done ? final : title === TITLE ? held : after; },
    async catalogDom() { calls.push('catalog-dom'); return dom(original); },
    async rename() { calls.push('rename'); return {status:200,command:{operation_id:f.OTHER,title:RENAMED},value:{api_version:1,
      receipt:{operation_id:f.OTHER,session_id:f.SID,run_id:null,first_sequence:'16',last_sequence:'16'},duplicate:false,warning_code:null,catalog_refresh:'updated'}}; },
    async finish() { calls.push('release'); }, async inspect() { return final.native; },
  };
  change({io,held,after,final,original});
  return {io,calls};
}
for (const [position,seedId] of [['first',f.OTHER],['last','01111111-1111-4111-8111-111111111111']]) {
  test(`actual orchestration requires populated active rename then one normal completion with selected ${position}`, async () => {
    const s=schedule(()=>{},seedId), result=await proveActiveRename(s.io,expected);
    assert.equal(result.final.native.completed,1);
    assert.deepEqual(result.catalogIds,[f.SID,seedId].sort());
    assert.equal(result.refreshedCatalog.next_after_id,result.catalogIds.at(-1));
    assert.deepEqual(s.calls,['refresh','task','held','catalog-dom','rename','renamed','catalog-dom','refresh','release','completed']);
  });
  for (const variant of ['last ID','null','wrong UUID']) {
    test(`actual catalog proof checks ${variant} final cursor with selected ${position}`,()=>{
      const value=catalog(TITLE,'1',seedId);
      if(variant==='null')value.next_after_id=null;
      if(variant==='wrong UUID')value.next_after_id=f.OID;
      const prove=()=>catalogProof(value,dom(value),{...expected,title:TITLE,head:'1'});
      if(variant==='last ID')assert.deepEqual(prove().ids,value.entries.map(e=>e.session_id));
      else assert.throws(prove,{message:'C57:catalog'});
    });
    test(`actual orchestration checks ${variant} cursor before Task with selected ${position}`,async()=>{
      const sentinel=Error('task entry sentinel');
      const s=schedule(({io,original})=>{
        if(variant==='null')original.next_after_id=null;
        if(variant==='wrong UUID')original.next_after_id=f.OID;
        io.startTask=async()=>{s.calls.push('task');throw sentinel;};
      },seedId);
      if(variant==='last ID') {
        await assert.rejects(proveActiveRename(s.io,expected),error=>error===sentinel);
        assert.deepEqual(s.calls,['refresh','task']);
      } else {
        await assert.rejects(proveActiveRename(s.io,expected),{message:'C57:catalog'});
        assert.deepEqual(s.calls,['refresh']);
      }
    });
  }
}
for (const cursor of [null,f.OID]) test(`actual orchestration rejects refreshed ${cursor===null?'null':'wrong UUID'} cursor`,async()=>{
  const s=schedule(({io})=>{
    const refresh=io.refreshCatalog;
    io.refreshCatalog=async()=>{const result=await refresh();if(result.value.entries.some(e=>e.last_run_id))result.value.next_after_id=cursor;return result;};
  });
  await assert.rejects(proveActiveRename(s.io,expected),{message:'C57:catalog'});
  assert.deepEqual(s.calls,['refresh','task','held','catalog-dom','rename','renamed','catalog-dom','refresh']);
});
for (const [name,change] of [
  ['missing created baseline', ({original}) => {original.entries.shift();}],
  ['wrong catalog order', ({original}) => {original.entries.reverse();original.next_after_id=original.entries.at(-1).session_id;}],
  ['extra catalog entry', ({original}) => {original.entries.push({...original.entries[1],session_id:f.OID});original.next_after_id=f.OID;}],
  ['more catalog pages', ({original}) => {original.has_more=true;}],
  ['wrong seed metadata', ({original}) => {original.entries[1].workspace=workspace;}],
  ['wrong selected metadata', ({original}) => {original.entries[0].title=RENAMED;}],
  ['unavailable catalog entry', ({original}) => {original.entries[0].availability='missing';original.entries[0].fault_code='storage.not_found';}],
  ['wrong catalog DOM', ({io}) => {const refresh=io.refreshCatalog;io.refreshCatalog=async()=>{const result=await refresh();result.dom[0].current='false';return result;};}],
  ['catalog publication failed', ({io}) => {const fn=io.rename;io.rename=async()=>{const r=await fn();r.value.catalog_refresh='failed';return r;};}],
  ['wrong operation receipt', ({io}) => {const fn=io.rename;io.rename=async()=>{const r=await fn();r.value.receipt.operation_id=f.OID;return r;};}],
  ['not active', ({held}) => {held.native.gate=null;}],
  ['extra task', ({after}) => {after.native.accepted.push({run_id:f.OTHER,accepted_sequence:'16'});}],
  ['extra request', ({after}) => {after.native.requests++;}],
  ['changed tool count', ({after}) => {after.native.tool_results++;}],
  ['premature result', ({held}) => {held.page.block.result_recorded=true;}],
  ['changed entry generation', ({after}) => {after.page.entries[0].fields[0].generation='8';after.page.entries[0].revision='8';}],
  ['changed normalized DOM', ({after}) => {after.dom+='x';}],
  ['changed receipt', ({after}) => {after.native.receipts=[{...receipt,operation_id:f.OTHER}];}],
  ['extra rename metadata', ({after}) => {after.native.sequence_count='17';}],
  ['not finished', ({final}) => {final.native.provider_stage='close';}],
  ['missing final text', ({final}) => {final.page.entries[2].fields[0].text='42 雪';}],
]) test(`actual orchestration rejects ${name}`, async () => {
  const s=schedule(change);await assert.rejects(proveActiveRename(s.io,expected));
  if(['missing created baseline','wrong catalog order','extra catalog entry','more catalog pages','wrong seed metadata',
    'wrong selected metadata','unavailable catalog entry','wrong catalog DOM'].includes(name)) assert.deepEqual(s.calls,['refresh']);
});
for (const [name,change] of [
  ['empty',p=>{p.entries=[];}],['wrong text',p=>{p.entries[0].fields[0].text+='x';}],
  ['duplicate entry',p=>{p.entries[1]=p.entries[0];}],['wrong order',p=>{p.entries.reverse();}],
  ['partial field',p=>{p.entries[0].content_complete=false;}],['wrong workspace',p=>{p.session.workspace=null;}],
  ['tool error',p=>{p.entries[1].is_error=true;}],['tool not recorded',p=>{p.entries[1].result_recorded=false;}],
  ['wrong epoch',p=>{p.entries[0].content_epoch='2';}],['wrong bytes',p=>{p.entries[0].fields[0].total_bytes='1';}],
]) test(`actual complete-page oracle rejects ${name}`,()=>{
  const p=page();change(p);assert.throws(()=>pageProof(p,{...expected,title:TITLE,native:native()}));
});
test('complete-page and native positive controls use ordinary first-task content',()=>{
  for (const completed of [false,true]) {
    nativeProof(native(completed),{...expected,completed});
    pageProof(page(completed),{...expected,title:TITLE,native:native(completed),completed});
  }
});

function ownership(change = () => {}) {
  const root={path:'/synthetic/wi-browser-Control',pid:999,start:'23',dev:'1',ino:'4',verified:true};
  const workspace=root.path+'/.tmpControl/workspace', destination=root.path+'/.tmpControl/workspace-c57-absent';
  const living={pid:999,ppid:process.pid,start:'23',alive:true,cwd:root.path,tmpdir:root.path,exe:'/synthetic/native'};
  const paths=['/','/synthetic',root.path,root.path+'/.tmpControl',workspace];
  const entries=new Map(paths.map((p,i)=>[p,{dev:1n,ino:BigInt(i+2),mode:16832n,isDirectory:()=>true,isSymbolicLink:()=>false}]));
  let effects=0;
  const fs={async lstat(p){if(!entries.has(p))throw Object.assign(Error('absent'),{code:'ENOENT'});return entries.get(p);},async realpath(p){return p;},
    async rename(a,b){effects++;entries.set(b,entries.get(a));entries.delete(a);}};
  const args={fixture:{pid:999},root,workspace,executable:living.exe,completed:native(true),tmpdir:'/synthetic',fs,probe:async()=>({...living})};
  change({args,root,living,entries,workspace,destination,fs});return {args,entries,fs,workspace,destination,effects:()=>effects};
}
for (const [name,change] of [
  ['before completion',({args})=>{args.completed.completed=0;}],['unbound root',({root})=>{root.verified=false;}],
  ['unowned workspace',({args})=>{args.workspace='/other/workspace';}],['wrong native temp shape',({args,root})=>{args.workspace=root.path+'/private-data/workspace';}],
  ['wrong pid',({living})=>{living.pid++;}],['wrong start',({living})=>{living.start='24';}],
  ['wrong exe',({living})=>{living.exe='/other/native';}],['wrong parent',({living})=>{living.ppid++;}],
  ['wrong cwd',({living})=>{living.cwd='/other';}],['wrong tmpdir',({living})=>{living.tmpdir='/other';}],
  ['dead process',({living})=>{living.alive=false;}],['wrong root inode',({root})=>{root.ino='99';}],
  ['symlink ancestry',({entries,root})=>{entries.get(root.path).isSymbolicLink=()=>true;}],
  ['resolved ancestry mismatch',({fs})=>{fs.realpath=async p=>p+'/other';}],
  ['occupied sibling',({entries,destination,workspace})=>{entries.set(destination,entries.get(workspace));}],
]) test(`actual workspace owner rejects ${name} before effect`,async()=>{
  const s=ownership(change);await assert.rejects(ownedWorkspace(s.args));assert.equal(s.effects(),0);
});
test('workspace revalidation rejects identity change between binding and effect',async()=>{
  const s=ownership(),owner=await ownedWorkspace(s.args);s.entries.get(s.workspace).ino=999n;
  await assert.rejects(owner.move());assert.equal(s.effects(),0);
});
test('post-move failure never permits a second effect',async()=>{
  const s=ownership(),owner=await ownedWorkspace(s.args),original=s.fs.rename;
  s.fs.rename=async(...args)=>{await original(...args);s.entries.get(s.destination).ino=999n;};
  await assert.rejects(owner.move());await assert.rejects(owner.move());assert.equal(s.effects(),1);
});
test('real directory move preserves inode and leaves original absent without reading contents',async()=>{
  const path=await mkdtemp(join(tmpdir(),'wi-browser-'));
  try {
    const parent=join(path,'.tmpControl'),workspace=join(parent,'workspace');await mkdir(parent);await mkdir(workspace);
    const s=await lstat(path,{bigint:true}),root={path,pid:999,start:'23',dev:String(s.dev),ino:String(s.ino),verified:true};
    const owner=await ownedWorkspace({fixture:{pid:999},root,workspace,executable:'/synthetic/native',completed:native(true),tmpdir:tmpdir(),
      probe:async()=>({pid:999,ppid:process.pid,start:'23',alive:true,cwd:path,tmpdir:path,exe:'/synthetic/native'})});
    await owner.move();assert.equal(await owner.absent(),true);await assert.rejects(owner.move());
  } finally {await rm(path,{recursive:true,force:true});}
});
test('saved-history orchestration closes original before fresh acquisition and rejects observer work',async()=>{
  const completed={final:{page:page(true),dom:'saved',native:native(true)}},calls=[];
  const io={move:async()=>{calls.push('move');},absent:async()=>{calls.push('absent');},closeOriginal:async()=>{calls.push('close');},
    fresh:async()=>{calls.push('fresh');return {...completed.final,posts:0};}};
  await proveSavedHistory(io,completed);assert.deepEqual(calls,['move','absent','close','fresh','absent']);
  io.fresh=async()=>({...completed.final,posts:1});await assert.rejects(proveSavedHistory(io,completed));
});
for (const failure of ['setup','body','close','publish','none']) test(`actual lifetime handles partial acquisition and ${failure} failure`,async()=>{
  const first=Error('first'),later=Error('later'),calls=[];
  const run=runOwned(async own=>{
    own('fixture',async()=>{calls.push('stop');});
    const close=own('context',async()=>{calls.push('close');if(failure==='close')throw first;});
    if(failure==='setup'||failure==='body')throw first;
    if(failure==='none')await close();
  },async packet=>{calls.push('publish');if(failure==='publish')throw first;assert.equal(packet.success,failure==='none');});
  if(failure==='none')await run;else await assert.rejects(run,error=>error===first);
  assert.equal(calls.includes('stop'),true);assert.equal(calls.includes('close'),true);
  await assert.rejects(runOwned(async own=>{own('context',async()=>{throw later;});throw first;},async()=>{throw later;}),error=>error===first);
});

function handshake() {
  const origin='http://127.0.0.1:1234',url=`${origin}/v1/sessions/${f.SID}/conversation`,value=page(true);
  const request={url:()=>url,method:()=> 'GET'},response={request:()=>request,url:()=>url,status:()=>200};
  const stream={url:()=>`${url}/events?after=${encodeURIComponent(value.live_after)}`,method:()=> 'GET'};
  for(const key of ['body','json','text'])Object.defineProperty(response,key,{get(){assert.fail('no original body');}});
  return {origin,sid:f.SID,page:value,snapshots:[{request,response,index:1}],streams:[{request:stream,response:{request:()=>stream,status:()=>200},index:2}]};
}
for(const variant of ['valid','reverse','missing','status','cursor','identity'])test(`actual handshake guards ${variant} without original body reads`,()=>{
  const h=handshake();
  if(variant==='reverse')h.streams[0].index=0;
  if(variant==='missing')h.snapshots=[];
  if(variant==='status')h.snapshots[0].response.status=()=>500;
  if(variant==='cursor')h.page.live_after+='x';
  if(variant==='identity')h.snapshots[0].request={...h.snapshots[0].request};
  if(variant==='valid')assert.equal(handshakeProof(h),true);else assert.throws(()=>handshakeProof(h));
});

const source=ts.createSourceFile('case.mjs',readFileSync(new URL('../e2e/saved-history-active-rename.spec.mjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let contextSource;
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='makeContext')contextSource=node.getText(source);ts.forEachChild(node,visit);}
visit(source);
for(const failure of ['route','page','privacy','close','none'])test(`actual spec acquisition and context-close callback handles ${failure}`,async()=>{
  const calls=[],first=Error('first');
  const context={route:async()=>{if(failure==='route')throw first;},on(){},newPage:async()=>{if(failure==='page')throw first;return {on(){}};},close:async()=>{calls.push('close');if(failure==='close')throw first;}};
  const make=runInNewContext(`(${contextSource.replaceAll('import.meta.url', JSON.stringify(new URL('../e2e/saved-history-active-rename.spec.mjs',import.meta.url).href))})`,{browser:{newContext:async()=>context},fixture:{owner:'synthetic-owner'},records:[],markers:[],files:new Map(),assets:[],faults:{},URL,
    boundary:async()=>{calls.push('privacy');if(failure==='privacy')throw first;}});
  const work=runOwned(async own=>{await make(own,false);},async()=>{calls.push('publish');});
  if(failure==='none')await work;else await assert.rejects(work,error=>error===first);
  assert.equal(calls.filter(c=>c==='close').length,1);
  assert.equal(calls.at(-1),'publish');
});
