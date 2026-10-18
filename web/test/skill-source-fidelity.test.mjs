import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, unlink, lstat, realpath, open, link } from 'node:fs/promises';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { readFileSync, constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parseDisplayCursor } from '../dist/display-api.js';
import { tmpdir } from 'node:os';
import { evaluateSkillCleanup, fixtureRootAbsent } from '../test-support/fixture.mjs';
import * as f from '../test-support/display-fixtures.mjs';
import { data, answer, skillOutput } from '../test-support/presentation.mjs';
import { richPartialFacts, expectedBlock } from '../test-support/rich-display-parity.mjs';
import { TEMPLATE, CHANGED, ownedSkill, completeProof, nativeCompletion, unchangedNative, savedProof,
  observerOrder, strictStop, executableBinding, sha256 } from '../test-support/skill-source-fidelity.mjs';

const commands = [{ operation_id:f.OID,run_id:f.RID,text:data.user },{ operation_id:f.OTHER,run_id:f.OTHER,text:data.user }];
const receipts = commands.map((c,i)=>({operation_id:c.operation_id,session_id:f.SID,run_id:c.run_id,first_sequence:String(i*30+2),last_sequence:String(i*30+3)}));
function native(tasks=2) {
  return {protocol:1,event:'inspect',id:1,gate:null,requests:tasks*2,connections:tasks,auth_loads:tasks,auth_prepares:tasks,prepared_exact:tasks*2,
    fresh_parents:tasks,continuations:tasks,tool_results:tasks*3,completed:tasks,terminals:tasks,results:tasks,fresh_empty:true,restored_history:tasks===2,
    sequence_count:String(tasks*30),accepted:receipts.slice(0,tasks).map(r=>({run_id:r.run_id,accepted_sequence:r.first_sequence})),receipts:receipts.slice(0,tasks),
    response_finishes:Array.from({length:tasks*2},(_,i)=>({sequence:String(Math.floor(i/2)*30+10+i%2*10),provenance:'native_terminal'})),
    terminal_sequences:Array.from({length:tasks},(_,i)=>String(i*30+29)),result_sequences:Array.from({length:tasks},(_,i)=>String(i*30+30)),
    provider_stage:tasks===2?'finished':'request',provider_failed:false,read_failure:null};
}
function page(task=0) {
  const base=task*30,head=String(base+30),c=commands[task],r=receipts[task];
  const rich=structuredClone(richPartialFacts);rich[5][1]=task===0?'{"a":17,\r\n "b":25}':'{"a":42,\r\n "b":8}';
  const specs=[rich,[['tool_name','add_numbers'],['tool_result',task===0?'{"sum":42}':'{"sum":50}']],
    [['tool_name','load_skill'],['tool_result',skillOutput]],[['tool_name','add_numbers'],['tool_result','{"error":{"code":"gateway_error"}}']],[['text',answer(task)]]];
  const fields=(pairs,seq)=>pairs.map(([kind,text],i)=>f.field({field_id:(i+1).toString(16).repeat(64),order_key:f.order(2,i,0),kind,text,
    generation:String(seq),total_bytes:String(Buffer.byteLength(text)),to_byte:String(Buffer.byteLength(text))}));
  const human=f.human({run_id:c.run_id,entry_id:`e:${r.first_sequence}:0`,position:{sequence:r.first_sequence,slot:'0'},revision:r.first_sequence,content_epoch:r.first_sequence,
    fields:[f.field({field_id:'text',order_key:'0',generation:r.first_sequence,text:data.user,total_bytes:String(Buffer.byteLength(data.user)),to_byte:String(Buffer.byteLength(data.user))})]});
  const entries=specs.map((pairs,i)=>{const seq=base+8+i*4,tool=i>=1&&i<=3;return f.entry({run_id:c.run_id,entry_id:`e:${seq}:0`,position:{sequence:String(seq),slot:'0'},
    revision:String(seq),content_epoch:String(seq),kind:tool?'tool':'assistant',recorded_state:i===3?'failed':'completed',provisional:false,
    result_recorded:tool?true:null,finish_recorded:tool?true:null,is_error:tool?i===3:null,fields:fields(pairs,seq)});});
  const summary={turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',new_tool_dispatches:'3',tool_results_prepared:'3',reused_results:'0',last_request_id:f.OID,last_upstream_outcome:'terminal_received'};
  return f.page({snapshot_head:head,session:f.session(head,{title:data.title}),block:f.block({run_id:c.run_id,accepted_sequence:r.first_sequence,revision:head,human,
    state:'completed',result_recorded:true,outcome:{type:'completed'},events_complete:true,summary}),entries,previous_block:task===0?null:f.cursor('b',r.first_sequence),live_after:f.cursor('l',head,'3','','')});
}
const options=(task=0)=>({sid:f.SID,head:String(task*30+30),command:commands[task],receipt:receipts[task],task,workspace:'/synthetic/project',resultSequence:String(task*30+30)});
for(const task of [0,1])test(`full saved main SKILL proof ${task}`,()=>{assert.deepEqual(completeProof(page(task),options(task)),page(task));assert.equal(expectedBlock(page(task)).entries[3].fields[1].ranges[0].text,skillOutput);});
const changes={
  'source substitution':p=>{p.entries[2].fields[1].text=CHANGED;}, 'metadata only':p=>{p.entries[2].fields.pop();},
  'pretty printed':p=>{p.entries[2].fields[1].text=JSON.stringify(JSON.parse(skillOutput),null,2);},
  'qualified ID':p=>{p.entries[2].fields[1].text=skillOutput.replace('project:presentation','presentation');},
  'frontmatter':p=>{p.entries[2].fields[1].text=skillOutput.replace('synthetic metadata','changed');},
  'body':p=>{const value=JSON.parse(skillOutput);value.body='changed';p.entries[2].fields[1].text=JSON.stringify(value);},
  'entry missing':p=>{p.entries.splice(2,1);},'duplicate':p=>{p.entries.push(p.entries[2]);},'entry order':p=>{p.entries.reverse();},
  'field order':p=>{p.entries[2].fields.reverse();},'range':p=>{p.entries[2].fields[1].from_byte='1';},
  'length':p=>{p.entries[2].fields[1].total_bytes='1';},'incomplete':p=>{p.entries[2].content_complete=false;},
  'recording':p=>{p.block.summary.new_tool_dispatches='1';},'error flag':p=>{p.entries[2].is_error=true;},
  'finish':p=>{p.entries[2].finish_recorded=false;},'result':p=>{p.entries[2].result_recorded=false;},
  'provisional':p=>{p.entries[2].provisional=true;},'state':p=>{p.entries[2].recorded_state='unknown';},
  'run':p=>{p.entries[2].run_id=f.OTHER;},'position':p=>{p.entries[2].position.sequence='3';},
  'generation':p=>{p.entries[2].fields[1].generation='1';},'epoch':p=>{p.entries[2].content_epoch='100';},
  'private field':p=>{p.entries[2].private='synthetic';},'same H':p=>{p.snapshot_head='31';p.session.head_sequence='31';},
  'outcome':p=>{p.block.outcome={type:'cancelled_locally'};},'events':p=>{p.block.events_complete=false;},
};
for(const [name,change] of Object.entries(changes))test(`complete oracle rejects ${name}`,()=>{const p=page();change(p);assert.throws(()=>completeProof(p,options()));});
for(const [name,change] of Object.entries({ identity:p=>{p.entries[2].fields[1].field_id='e'.repeat(64);},generation:p=>{p.entries[2].fields[1].generation='25';},epoch:p=>{p.entries[2].content_epoch='25';},revision:p=>{p.entries[2].revision='25';},order:p=>{p.entries[2].fields[1].order_key=f.order(2,20,0);},recording:p=>{p.block.summary.last_request_id=f.OTHER;} }))test(`captured full DTO equality rejects valid changed ${name}`,()=>{const original=page(),p=structuredClone(original);change(p);assert.throws(()=>savedProof(p,original));});
test('typed previous page preserves full A at final H without live reset',()=>{const p=page();Object.assign(p,{snapshot_head:'60',session:f.session('60',{title:data.title}),live_after:null});assert.deepEqual(completeProof(p,{...options(),head:'60',query:{kind:'before',cursor:f.cursor('b','32')}}),p);});
for(const tasks of [1,2])test(`native real protocol ${tasks}`,()=>assert.equal(nativeCompletion(native(tasks),commands.slice(0,tasks),receipts.slice(0,tasks)).completed,tasks));
for(const key of ['gate','requests','connections','auth_loads','auth_prepares','prepared_exact','fresh_parents','continuations','tool_results','completed','terminals','results','fresh_empty','restored_history','sequence_count','provider_stage','provider_failed','read_failure','accepted','receipts','response_finishes','terminal_sequences','result_sequences'])test(`native counters and proof reject ${key}`,()=>{const p=native();if(typeof p[key]==='number')p[key]++;else if(typeof p[key]==='boolean')p[key]=!p[key];else if(Array.isArray(p[key]))p[key]=[];else p[key]='bad';assert.throws(()=>nativeCompletion(p,commands,receipts));assert.throws(()=>unchangedNative(p,nativeCompletion(native(),commands,receipts)));});
test('read-only native equality excludes only control reply ID',()=>{const p=native();p.id=20;assert.equal(unchangedNative(p,nativeCompletion(native(),commands,receipts)),true);});
const order=['latest','newest-rendered','upward-intent','older-request','older-rendered'];
test('newest renders before upward older read',()=>assert.equal(observerOrder(order),true));
for(let i=0;i<order.length;i++)test(`observer sequence rejects missing event ${i}`,()=>{const e=[...order];e.splice(i,1);assert.throws(()=>observerOrder(e));});
for(let i=1;i<order.length;i++)test(`observer sequence rejects reordered event ${i}`,()=>{const e=[...order];[e[0],e[i]]=[e[i],e[0]];assert.throws(()=>observerOrder(e));});
const stop={failure:null,stop:{attempted:true,clean_acknowledgment:true,reap_complete:true,sandbox_removed:true,exit_observed:true,exit_zero:true,error_latched:false,stderr_empty:true,sigterm:false,sigkill:false}};
test('strict clean Stop accepted',()=>assert.equal(strictStop(stop),true));
for(const key of Object.keys(stop.stop))test(`strict cleanup rejects ${key}`,()=>{const p=structuredClone(stop);p.stop[key]=!p.stop[key];assert.throws(()=>strictStop(p));});
test('strict cleanup rejects native failure',()=>assert.throws(()=>strictStop({...stop,failure:{phase:'synthetic'}})));

async function isolated(action) {
  const sandbox=await mkdtemp(join(tmpdir(),'wi-browser-'));
  const workspace=join(sandbox,'.tmpC49control','workspace'),path=join(workspace,'.agents/skills/presentation/SKILL.md');
  await mkdir(join(workspace,'.agents/skills/presentation'),{recursive:true});await writeFile(path,TEMPLATE);
  const live={pid:12345,ppid:process.pid,start:'123',alive:true,cwd:sandbox,tmpdir:sandbox,exe:'/synthetic/fixture'};
  const input={fixture:{pid:12345},workspace,tmpdir:tmpdir(),executable:live.exe,finished:{completed:2,provider_stage:'finished',gate:null},probe:async()=>({...live})};
  let guard;
  try { await action({sandbox,workspace,path,live,input,bind:async()=>{guard=await ownedSkill(input);return guard;}}); }
  finally {if(guard)await guard.close();await rm(sandbox,{recursive:true,force:true});}
}
test('owned no-follow same inode change/readback/delete lifecycle',()=>isolated(async({path,bind})=>{const before=await lstat(path),g=await bind();const changed=await g.change();assert.equal(changed.changed_sha256,sha256(CHANGED));assert.equal(await readFile(path,'utf8'),CHANGED);assert.equal((await lstat(path)).ino,before.ino);await g.observed();assert.equal((await g.delete()).absent,true);await assert.rejects(lstat(path),{code:'ENOENT'});}));
const ownership={
  'wrong PID':({live})=>{live.pid++;},'wrong parent PID':({live})=>{live.ppid++;},'wrong cwd':({live})=>{live.cwd='/synthetic/wrong';},
  'wrong TMPDIR':({live})=>{live.tmpdir='/synthetic/wrong';},'wrong executable':({live})=>{live.exe='/synthetic/other';},'dead PID':({live})=>{live.alive=false;},
  'noncanonical':({input})=>{input.workspace+='/../workspace';},'wrong ancestry':({input})=>{input.tmpdir='/synthetic/wrong';},
  'unfinished':({input})=>{input.finished.completed=1;},'active gate':({input})=>{input.finished.gate=12;},
  'wrong template':async({path})=>{await writeFile(path,TEMPLATE+' ');},'missing template':async({path})=>{await unlink(path);},
  'nonregular':async({path})=>{await unlink(path);await mkdir(path);},
  'file symlink':async({path,sandbox})=>{const target=join(sandbox,'synthetic-target');await writeFile(target,TEMPLATE);await unlink(path);await symlink(target,path);},
  'ancestor symlink':async({workspace})=>{const old=join(workspace,'.agents'),target=join(workspace,'synthetic-agents');await rename(old,target);await symlink(target,old);},
};
for(const [name,change] of Object.entries(ownership))test(`ownership guard rejects before effects: ${name}`,()=>isolated(async(value)=>{await change(value);await assert.rejects(value.bind());if(!['missing template','nonregular'].includes(name)){const bytes=await readFile(value.path,'utf8');assert.equal(bytes,name==='wrong template'?TEMPLATE+' ':TEMPLATE);}}));
for(const name of ['delete before change','observed before change','delete before observation','repeat change','substituted bytes','replaced inode','substituted ancestor','changed process identity'])test(`mutation lifecycle rejects ${name}`,()=>isolated(async({path,workspace,live,bind})=>{
  const g=await bind();
  if(name==='delete before change')return assert.rejects(g.delete());
  if(name==='observed before change')return assert.rejects(g.observed());
  await g.change();
  if(name==='delete before observation')return assert.rejects(g.delete());
  if(name==='repeat change')return assert.rejects(g.change());
  if(name==='substituted bytes')await writeFile(path,CHANGED+' ');
  if(name==='replaced inode'){await rename(path,path+'.old');await writeFile(path,CHANGED);}
  if(name==='substituted ancestor'){const p=join(workspace,'.agents');await rename(p,p+'.old');await mkdir(join(p,'skills/presentation'),{recursive:true});await writeFile(path,CHANGED);}
  if(name==='changed process identity')live.start='124';
  await assert.rejects(g.observed());
}));
test('actual acquired skill handle must close before strict cleanup passes',()=>isolated(async({sandbox,bind})=>{
  const s=await lstat(sandbox,{bigint:true}),root={path:sandbox,pid:12345,start:'123',dev:String(s.dev),ino:String(s.ino),verified:true};
  const g=await bind(),cleanup={root,contexts:2,contexts_expected:2,handle_acquired:true,handle_closed:false,
    fixture:true,root_absent:false,pid_absent:true,evidence:stop};
  assert.throws(()=>evaluateSkillCleanup(cleanup));
  await g.close();cleanup.handle_closed=true;await rm(sandbox,{recursive:true});cleanup.root_absent=await fixtureRootAbsent(root);
  assert.equal(evaluateSkillCleanup(cleanup),true);
}));
const cleanupRoot={path:join(tmpdir(),'wi-browser-C49control'),pid:12345,start:'123',dev:'1',ino:'2',verified:true};
const clean={root:cleanupRoot,contexts:1,contexts_expected:1,handle_acquired:false,handle_closed:null,
  fixture:true,root_absent:true,pid_absent:true,evidence:stop};
for(const [name,change] of Object.entries({
  'unclosed handle':c=>{c.handle_acquired=true;c.handle_closed=false;},'unknown handle':c=>{delete c.handle_acquired;},
  'fabricated optional closure':c=>{c.handle_closed=true;},'remaining root':c=>{c.root_absent=false;},
  'remaining process':c=>{c.pid_absent=false;},'incomplete contexts':c=>{c.contexts=0;},
  'unknown contexts':c=>{delete c.contexts_expected;},'unknown root':c=>{c.root=null;},
  'unverified root':c=>{c.root.verified=false;},'invalid Stop':c=>{c.evidence.stop.exit_zero=false;},
  'no fixture Stop':c=>{c.fixture=false;},
}))test(`actual cleanup evaluator rejects ${name}`,()=>{const c=structuredClone(clean);change(c);assert.throws(()=>evaluateSkillCleanup(c));});
for(const code of ['EACCES','EIO','ENOTDIR'])test(`root absence rejects non-ENOENT ${code}`,async()=>{
  await assert.rejects(fixtureRootAbsent(cleanupRoot,async()=>{throw Object.assign(new Error('synthetic'),{code});}),{code});
});
test('root absence rejects unbound facts before probing',async()=>{
  let probed=false;await assert.rejects(fixtureRootAbsent(null,async()=>{probed=true;}));assert.equal(probed,false);
});

test('normal fixture path-only executable binding works; incorrect optional hash rejects',()=>isolated(async({sandbox})=>{const path=join(sandbox,'fixture');await writeFile(path,'synthetic executable');const b=await executableBinding(path);assert.equal(b.sha256,sha256('synthetic executable'));assert.deepEqual(await executableBinding(path,b.sha256),b);await assert.rejects(executableBinding(path,'0'.repeat(64)));await symlink(path,path+'.link');await assert.rejects(executableBinding(path+'.link'));}));

const skillText=readFileSync(new URL('../test-support/skill-source-fidelity.mjs',import.meta.url),'utf8');
const skillAst=ts.createSourceFile('skill-helper.mjs',skillText,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const skillBindings=['reject','identity','equal'].map(name=>{
  const statements=skillAst.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(skillAst)===name));
  assert.equal(statements.length,1);return statements[0].getText(skillAst);
}).join('\n');
function actualSkill(io={}) {
  return runInNewContext(`${skillBindings}\n${actualFunction(skillText,'ownedSkill')};ownedSkill`,{
    process,Buffer,constants,dirname,basename,join,resolve,relative,sep,isDeepStrictEqual,TEMPLATE,CHANGED,sha256,
    lstat,realpath,open,unlink,...io,
  });
}
async function skillFixture(action) {
  const higher=await mkdtemp(join(tmpdir(),'skill-control-')),shared=join(higher,'private');
  await mkdir(shared,{mode:0o700});
  const sandbox=await mkdtemp(join(shared,'wi-browser-'));
  const workspace=join(sandbox,'.tmpC49control','workspace'),path=join(workspace,'.agents/skills/presentation/SKILL.md');
  await mkdir(dirname(path),{recursive:true});await writeFile(path,TEMPLATE);
  const live={pid:12345,ppid:process.pid,start:'123',alive:true,cwd:sandbox,tmpdir:sandbox,exe:'/synthetic/fixture'};
  const input={fixture:{pid:live.pid},workspace,tmpdir:shared,executable:live.exe,finished:{completed:2,provider_stage:'finished',gate:null},probe:async()=>({...live})};
  let guard;
  try {await action({higher,shared,sandbox,workspace,path,live,input,bind:async(helper=ownedSkill)=>{guard=await helper(input);return guard;}});}
  finally {try {if(guard)await guard.close();}finally {await rm(higher,{recursive:true,force:true});}}
}
const skillPhases=['acquisition','prechange','postsync','observed','predelete'];
for(const level of ['shared','higher'])for(const delta of ['add','remove'])for(const phase of skillPhases)
  test(`shared sibling ${delta} at ${level} survives ${phase}`,()=>skillFixture(async(value)=>{
    const {input,live,bind,sandbox}=value,target=value[level];
    const sibling=level==='shared'?sandbox+'-sibling':join(target,'sibling');
    if(delta==='remove')await mkdir(sibling);
    const before=await lstat(target,{bigint:true});let effects=0;
    const effect=async()=>{
      effects++;if(delta==='add')await mkdir(sibling);else await rm(sibling,{recursive:true});
      const after=await lstat(target,{bigint:true});
      for(const key of ['dev','ino','mode'])assert.equal(after[key],before[key]);
      assert.equal(after.nlink,before.nlink+(delta==='add'?1n:-1n));
    };
    if(phase==='acquisition')input.probe=async()=>{if(effects===0)await effect();return {...live};};
    let helper=ownedSkill;
    if(phase==='postsync')helper=actualSkill({open:async(...args)=>{
      const file=await open(...args);
      return new Proxy(file,{get:(target,key)=>key==='sync'?async()=>{await target.sync();await effect();}:typeof target[key]==='function'?target[key].bind(target):target[key]});
    }});
    const g=await bind(helper);
    if(phase==='prechange')await effect();
    assert.equal((await g.change()).readback_exact,true);
    if(phase==='observed')await effect();
    await g.observed();
    if(phase==='predelete')await effect();
    assert.equal((await g.delete()).absent,true);assert.equal(effects,1);
    assert.equal((await lstat(target,{bigint:true})).nlink,before.nlink+(delta==='add'?1n:-1n));
  }));
test('transient shared membership is only a neutral contrast',()=>skillFixture(async({shared,bind})=>{
  const g=await bind(),sibling=join(shared,'transient');await mkdir(sibling);await rm(sibling,{recursive:true});
  await g.change();await g.observed();assert.equal((await g.delete()).absent,true);
}));
for(const level of ['sandbox','invocation','workspace','agents','skills','presentation'])for(const delta of ['add','remove'])
  test(`owned directory ${level} still rejects actual ${delta}`,()=>skillFixture(async({sandbox,workspace,path,bind})=>{
    const target={sandbox,invocation:dirname(workspace),workspace,agents:join(workspace,'.agents'),skills:join(workspace,'.agents/skills'),presentation:dirname(path)}[level];
    const child=join(target,'sibling');if(delta==='remove')await mkdir(child);
    const before=await lstat(target,{bigint:true}),g=await bind();
    if(delta==='add')await mkdir(child);else await rm(child,{recursive:true});
    assert.equal((await lstat(target,{bigint:true})).nlink,before.nlink+(delta==='add'?1n:-1n));
    await assert.rejects(g.change());assert.equal(await readFile(path,'utf8'),TEMPLATE);
  }));
for(const phase of skillPhases)test(`every ancestor keeps strict nonmembership checks at ${phase}`,()=>skillFixture(async(value)=>{
  const {path,input,live}=value,dirs=[];
  for(let p=dirname(path);;p=dirname(p)){dirs.unshift(p);if(p===sep)break;}
  for(const directory of dirs)for(const field of ['dev','ino','mode','type','symlink','canonical',...(directory===value.sandbox||directory.startsWith(value.sandbox+sep)?['nlink']:[])]){
    let armed=false,hits=0,closed=0,g;
    const helper=actualSkill({
      lstat:async(p,...args)=>{
        const s=await lstat(p,...args);if(!armed||p!==directory||field==='canonical')return s;
        hits++;return new Proxy(s,{get:(target,key)=>{
          if(key===field&&['dev','ino','mode','nlink'].includes(field))return target[key]+1n;
          if(field==='type'&&key==='isDirectory')return ()=>false;
          if(field==='symlink'&&key==='isSymbolicLink')return ()=>true;
          return typeof target[key]==='function'?target[key].bind(target):target[key];
        }});
      },
      realpath:async p=>{if(armed&&p===directory&&field==='canonical'){hits++;return p+'-alias';}return realpath(p);},
      open:async(...args)=>{
        const file=await open(...args);
        return new Proxy(file,{get:(target,key)=>{
          if(key==='sync')return async()=>{await target.sync();if(phase==='postsync')armed=true;};
          if(key==='close')return async()=>{closed++;await target.close();};
          return typeof target[key]==='function'?target[key].bind(target):target[key];
        }});
      },
    });
    const probe=async()=>{if(phase==='acquisition')armed=true;return {...live};};
    try {
      if(phase==='acquisition')await assert.rejects(helper({...input,probe}));
      else {
        await writeFile(path,TEMPLATE);g=await helper(input);
        if(phase==='prechange')armed=true;
        if(['prechange','postsync'].includes(phase))await assert.rejects(g.change());
        else {await g.change();if(phase==='observed')armed=true;
          if(phase==='observed')await assert.rejects(g.observed());
          else {await g.observed();armed=true;await assert.rejects(g.delete());}}
      }
      assert.ok(hits>0,`${field} observation reached`);
    } finally {if(g)await g.close();}
    assert.equal(closed,1);
  }
}));
for(const phase of ['acquisition','prechange'])test(`skill hardlink rejects at ${phase}`,()=>skillFixture(async({path,bind})=>{
  let g;if(phase==='prechange')g=await bind();await link(path,path+'.link');
  if(g)await assert.rejects(g.change());else await assert.rejects(bind());
  assert.equal(await readFile(path,'utf8'),TEMPLATE);
}));
test('identical-byte replacement rejects with original inode still held',()=>skillFixture(async({path,bind})=>{
  const original=await lstat(path,{bigint:true}),g=await bind();await rename(path,path+'.original');await writeFile(path,TEMPLATE);
  assert.notEqual((await lstat(path,{bigint:true})).ino,original.ino);
  assert.equal((await lstat(path+'.original',{bigint:true})).ino,original.ino);
  await assert.rejects(g.change());assert.equal(await readFile(path,'utf8'),TEMPLATE);assert.equal(await readFile(path+'.original','utf8'),TEMPLATE);
}));
test('same-length unexpected bytes reject before write',()=>skillFixture(async({path,bind})=>{
  const g=await bind(),changed=TEMPLATE.replace('synthetic','Synthetic');assert.equal(Buffer.byteLength(changed),Buffer.byteLength(TEMPLATE));
  await writeFile(path,changed);await assert.rejects(g.change());assert.equal(await readFile(path,'utf8'),changed);
}));
for(const fault of ['named-held','short-read','nofollow-race','short-write','truncate','sync'])test(`actual file boundary rejects ${fault} and closes`,()=>skillFixture(async({path,sandbox,input})=>{
  let closed=0,g;
  const helper=actualSkill({open:async(p,flags)=>{
    assert.equal(p,path);assert.equal(flags,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    if(fault==='nofollow-race'){
      const target=join(sandbox,'target');await writeFile(target,TEMPLATE);await unlink(path);await symlink(target,path);
      try {return await open(p,flags);}catch(error){assert.equal(error.code,'ELOOP');throw error;}
    }
    const file=await open(p,flags);
    return new Proxy(file,{get:(target,key)=>{
      if(key==='close')return async()=>{closed++;await target.close();};
      if(fault==='named-held'&&key==='stat')return async(...args)=>{const s=await target.stat(...args);return new Proxy(s,{get:(s,k)=>k==='ino'?s.ino+1n:typeof s[k]==='function'?s[k].bind(s):s[k]});};
      if(fault==='short-read'&&key==='read')return async(...args)=>({...await target.read(...args),bytesRead:0});
      if(fault==='short-write'&&key==='write')return async()=>({bytesWritten:0});
      if(fault===key&&['truncate','sync'].includes(key))return async()=>{throw Error('synthetic file failure');};
      return typeof target[key]==='function'?target[key].bind(target):target[key];
    }});
  }});
  try {
    if(['named-held','short-read','nofollow-race'].includes(fault))await assert.rejects(helper(input));
    else {g=await helper(input);await assert.rejects(g.change());}
  } finally {if(g)await g.close();}
  assert.equal(closed,fault==='nofollow-race'?0:1);
}));

const sourceText=readFileSync(new URL('../e2e/skill-source-fidelity.spec.mjs',import.meta.url),'utf8');
function sourceGuard(text) {
  const source=ts.createSourceFile('skill-source-fidelity.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),calls=[];
  function visit(n){if(ts.isCallExpression(n))calls.push(n);ts.forEachChild(n,visit);}visit(source);
  const named=n=>calls.filter(c=>c.expression.getText(source)===n),one=n=>{assert.equal(named(n).length,1);return named(n)[0];};
  one('test');const fixture=one('startFixture');assert.equal(fixture.arguments[1].getText(source),"{ transport: 'websocket', recovered: false, mime: true, presentation: true }");
  assert.equal(fixture.arguments.length,3);assert.equal(fixture.arguments[2].getText(source),'{ gate11Diagnostics: true }');
  assert.equal(named('captureGate11').length,2);assert.ok(named('captureGate11').every(c=>ts.isAwaitExpression(c.parent)));
  assert.ok(ts.isCallExpression(one('requireGate11')));
  for(const n of ['ownedSkill','guard.change','guard.observed','guard.delete','fixture.stop','strictStop','observerOrder'])assert.ok(ts.isAwaitExpression(one(n).parent)||['strictStop','observerOrder'].includes(n));
  assert.ok(one('guard.change').pos<one('guard.observed').pos&&one('guard.observed').pos<one('guard.delete').pos);
  assert.ok(text.indexOf("stage='fixed-boundary'")<one('ownedSkill').pos);
  assert.ok(one('fixture.bindRoot').pos<text.indexOf('for(const task of [0,1])'));
  assert.ok(ts.isAwaitExpression(one('fixture.bindRoot').parent));
  assert.ok(one('fixtureRootAbsent').pos>one('fixture.stop').pos);
  assert.ok(ts.isAwaitExpression(one('fixtureRootAbsent').parent));
  one('evaluateSkillCleanup');
  assert.ok(text.includes('handle_acquired:false, handle_closed:null')&&text.includes('cleanup.handle_acquired=true;cleanup.handle_closed=false;'));
  assert.ok(text.indexOf("for(const task of [0,1])")<text.indexOf("stage='fixed-boundary'"));
  assert.ok(text.includes("for(const index of [1,2])"));assert.equal(named('browser.newContext').length,2);
  assert.equal(named('freshHandshake').length,2);assert.equal(named('executableBinding').length,2);
  assert.ok(one('guard.change').pos>text.indexOf("provider_stage).toBe('finished')"));
  const main=one('test').arguments[1].body, execution=main.statements.find(ts.isTryStatement);
  const observers=execution.tryBlock.statements.find(n=>ts.isForOfStatement(n)&&n.expression.getText(source)==='[1,2]');
  assert.ok(observers);assert.equal(observers.initializer.getText(source),'const index');
  const key=one('page.keyboard.press');assert.equal(key.arguments.length,1);assert.equal(key.arguments[0].getText(source),"'Home'");
  assert.ok(ts.isAwaitExpression(key.parent));assert.ok(key.parent.parent.parent===observers.statement);
  assert.equal(calls.filter(c=>c.expression.getText(source)==='transcript(page).focus').length,1);
  assert.ok(text.includes('newest:false,intent:false,prekey:null,setup_reads:null'));
  const permits=[];function permissions(n){if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&n.left.getText(source)==='r.intent')permits.push(n);ts.forEachChild(n,permissions);}permissions(source);
  assert.equal(permits.length,1);assert.equal(permits[0].getText(source),'r.intent=true');
  assert.ok(permits[0].parent.parent===observers.statement);
  const phases=['setup-top','transcript-focus','layout-settled','pre-key-sample','pre-key-focus','pre-key-geometry','setup-reads','key-dispatch','older-request-wait','older-request-route','older-request-cursor'];
  let position=-1;for(const phase of phases){const next=observers.getText(source).indexOf(`check='${phase}'`);assert.ok(next>position);position=next;}
  const collectors=calls.filter(c=>c.expression.getText(source)==='context.on'&&c.arguments[0].getText(source)==="'request'");assert.equal(collectors.length,1);
  const observe=execution.tryBlock.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='observer');assert.ok(observe);
  assert.ok(collectors[0].parent.parent===observe.body);
  assert.equal(named('observer').length,2);assert.ok(named('observer').every(c=>ts.isAwaitExpression(c.parent)));
  assert.equal(named('observer').filter(c=>c.arguments.map(n=>n.getText(source)).join(',')==='contexts[index],index').length,1);
  const declaration=name=>source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name);
  // Pin the active AST regions so orphan copies cannot replace the executed proof.
  const pin=(node,hash)=>assert.equal(sha256(node.getText(source).replace(/\s+/g,'')),hash);
  pin(observers,'87946d109cd13e87aae4143e592a648acde17039d7f2467aa356e431d6176b8d');
  pin(collectors[0].arguments[1],'f8c5ef56c4d440356f0f3b274677632242d1a4d8cd4f7f888f871c8fb8cfe6f6');
  pin(declaration('backwardRead'),'2d27bc46823671c68ef309a8d1868e0702114d758f9037ac5201ffb139f9b231');
  pin(declaration('intentFacts'),'cd9b5c21e5b125ed3b76464a06a2ec082f52b64a4987e92d3f00a8540966f572');
  pin(declaration('boundary'),'b00b9787a98208e20906e962401c5e989ad487bf2e0cf77249ea9bf800c3da87');
  pin(execution.catchClause,'b7ee4d29f6f58ed2e152f054c8826d2b2cffb9381b174f2c895ac0a8246bcb70');
  pin(execution.finallyBlock,'ba852efccb62682d22f1fdccd90d636bd594e08c05abea0235a45e45345f8420');
  assert.equal(sha256(execution.tryBlock.statements.slice(execution.tryBlock.statements.indexOf(observers)+1).map(n=>n.getText(source)).join('').replace(/\s+/g,'')),
    '59a6b8c123e38ea3b34a0f51465c75b3372f579c03e64f1209cf24a7cd94a727');
  const watchdog=one('test.setTimeout');assert.equal(watchdog.arguments.length,1);assert.equal(watchdog.arguments[0].getText(source),'180_000');
  assert.equal(watchdog.parent.parent,one('test').arguments[1].body);
  for(const c of calls)if(c!==watchdog)assert.equal(/(?:fulfill|newCDPSession|setTimeout|setDefaultTimeout|dispatchEvent|evaluateHandle)$|^test\.(?:skip|only|fixme)$/.test(c.expression.getText(source)),false);
  assert.equal(/freshReply\.(?:body|text|json)\s*\(/.test(text),false);
  return true;
}
test('actual source keeps one unchanged fixture, two explicit tasks and post-completion guarded mutations',()=>assert.equal(sourceGuard(sourceText),true));
for(const [name,change] of Object.entries({missingRoot:s=>s.replace('await fixture.bindRoot()','null'),missingRootCheck:s=>s.replace('await fixtureRootAbsent(cleanup.root)','true'),missingCleanupEvaluator:s=>s.replace('evaluateSkillCleanup({...cleanup,evidence})','Boolean(cleanup)'),fabricatedHandle:s=>s.replace('handle_acquired:false, handle_closed:null','handle_acquired:false, handle_closed:true')}))test(`actual source guard rejects cleanup ${name}`,()=>{const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));});
for(const [name,change] of Object.entries({missingOptIn:s=>s.replace(', { gate11Diagnostics: true }',''),disabledCapture:s=>s.replace('gate11Diagnostics: true','gate11Diagnostics: false'),missingExport:s=>s.replace('await captureGate11(fixture)','null'),ignoredDiagnostic:s=>s.replace('requireGate11(report)','Boolean(report)')}))test(`actual source guard rejects diagnostic ${name}`,()=>{const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));});
for(const [name,change] of Object.entries({watchdog:s=>s.replace('test.setTimeout(180_000);','test.setTimeout(240_000);'),missingWatchdog:s=>s.replace('test.setTimeout(180_000);',''),extraWatchdog:s=>s.replace('test.setTimeout(180_000);','test.setTimeout(180_000);test.setTimeout(180_000);'),fixture:s=>s.replace('presentation: true','presentation: false'),mutation:s=>s.replace('await guard.change()','guard.change()'),deletion:s=>s.replace('await guard.delete()','guard.delete()'),stop:s=>s.replace('await fixture.stop()','fixture.stop()'),order:s=>s.replace('observerOrder(r.events)','Boolean(r.events)'),skip:s=>s.replace("test('saved main", "test.only('saved main"),injection:s=>s.replace("await page.keyboard.press('Home')","await page.dispatchEvent('keydown',{})"),sdk:s=>s.replace("check='handshake';","await freshReply.body();check='handshake';"),loop:s=>s.replace('for(const task of [0,1])','for(const task of [0,1,2])')}))test(`actual source guard rejects ${name}`,()=>{const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));});
const parsed=ts.createSourceFile('skill.mjs',sourceText,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const allow=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='allowedRequest').getText(parsed).replace('export ','');
for(const [method,path,permission,accepted] of [
  ['GET','/v1/settings',null,true],['GET',`/v1/sessions/${f.SID}/conversation`,null,true],
  ['GET',`/v1/sessions/${f.SID}/conversation?before=${f.cursor('b','32')}`,null,true],
  ['GET',`/v1/sessions/${f.SID}/conversation?within=${f.cursor('s',f.RID,'8','0')}`,null,true],
  ['GET',`/v1/sessions/${f.SID}/conversation/content?cursor=${f.cursor('c',f.RID,'e:8:0','8',f.FID,'8','1')}`,null,true],
  ['GET',`/v1/sessions/${f.SID}/history`,null,false],['GET',`/v1/sessions/${f.SID}/events`,null,false],
  ['GET',`/v1/sessions/${f.SID}/conversation?before=${f.cursor('l','30','3','','')}`,null,false],
  ['GET',`/v1/sessions/${f.SID}/conversation?before=${f.cursor('b','32')}&extra=1`,null,false],
  ['POST','/v1/sessions','create',true],['POST',`/v1/sessions/${f.SID}/runs`,'first',true],['POST',`/v1/sessions/${f.SID}/runs`,'second',true],
  ['POST',`/v1/sessions/${f.SID}/runs`,null,false],['POST',`/v1/sessions/${f.SID}/runs/reconcile`,null,false],['POST',`/v1/sessions/${f.SID}/runs/${f.RID}/cancel`,null,false],
])test(`actual typed request boundary ${method}/${path}`,()=>{let result=false;try{result=runInNewContext(`${allow};allowedRequest(method,url,sid,permission)`,{method,url:new URL(path,'http://127.0.0.1:1234'),sid:f.SID,permission,parseDisplayCursor});}catch{result=false;}assert.equal(result,accepted);});

const intentChanges={
  missingFocus:s=>s.replace("await transcript(page).focus();",''),
  earlyFocus:s=>s.replace("await transcript(page).focus();",'').replace("check='setup-top';","await transcript(page).focus();check='setup-top';"),
  missingSetup:s=>s.replace('await transcript(page).evaluate(n=>{n.scrollTop=0;});',''),
  missingSettling:s=>s.replace("check='layout-settled';await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));",''),
  missingFocusCheck:s=>s.replace('expect(r.prekey.focused).toBe(true);',''),
  missingGeometry:s=>s.replace('r.prekey.top<=96','true'),
  earlyGeometry:s=>s.replace("check='pre-key-geometry';", "check='setup-top';"),
  sampleBeforeFocus:s=>{const sample="r.prekey=await transcript(page).evaluate(n=>({focused:document.activeElement===n,top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight}));";return s.replace(sample,'').replace("check='transcript-focus';",sample+"check='transcript-focus';");},
  orphanGeometry:s=>s.replace('r.prekey.top<=96','true')+"\nfunction orphanGeometry(r){return r.prekey.top<=96;}\n",
  initialPermission:s=>s.replace('newest:false,intent:false','newest:false,intent:true'),
  classifyContent:s=>s.replace("if (url.pathname === `${base}/content`) return 'content';","if (url.pathname === `${base}/content`) return null;"),
  earlyPermission:s=>s.replace("check='setup-top';","r.intent=true;check='setup-top';").replace("r.intent=true;await page.keyboard.press('Home');","await page.keyboard.press('Home');"),
  missingFalseCheck:s=>s.replace("check='setup-reads';expect(r.intent).toBe(false);","check='setup-reads';"),
  missingZero:s=>s.replace("r.setup_reads=r.older.length;expect(r.older.length).toBe(0);",'r.setup_reads=r.older.length;'),
  earlyZero:s=>s.replace("r.setup_reads=r.older.length;expect(r.older.length).toBe(0);",'').replace("check='setup-top';","r.setup_reads=r.older.length;expect(r.older.length).toBe(0);check='setup-top';"),
  missingCount:s=>s.replace("await expect.poll(()=>r.older.length).toBe(1);",''),
  relaxedCount:s=>s.replace("await expect.poll(()=>r.older.length).toBe(1);","await expect.poll(()=>r.older.length).toBeGreaterThan(0);"),
  missingFinalCount:s=>s.replace('r.older.length===1&&readOnly(r.requests)','readOnly(r.requests)'),
  omittedContent:s=>s.replace("if(kind!==null){","if(kind!==null&&kind!=='content'){"),
  missingRoute:s=>s.replace("expect(r.older[0].kind).toBe('block');",''),
  missingCollectorPermission:s=>s.replace('!r.newest||!r.intent','!r.newest'),
  missingCollectorCount:s=>s.replace('||r.older.length!==1',''),
  missingCollectorRoute:s=>s.replace("||kind!=='block'",''),
  replacedHome:s=>s.replace("page.keyboard.press('Home')","page.keyboard.press('PageUp')"),
  repeatedHome:s=>s.replace("await page.keyboard.press('Home');","await page.keyboard.press('Home');await page.keyboard.press('Home');"),
  unawaitedHome:s=>s.replace("await page.keyboard.press('Home');","page.keyboard.press('Home');"),
  orphanHome:s=>s.replace("await page.keyboard.press('Home');",'').replace("test.use({", "async function orphan(page){await page.keyboard.press('Home');}\ntest.use({"),
  orphanCollector:s=>s.replace("async function observer(context,index) {","async function orphanCollector(context,index) {"),
  orphanRegistration:s=>{const registration=`context.on('request',${requestCollector(s)});`;return s.replace(registration,`function orphanCollector(context){${registration}}`);},
  orphanObservers:s=>s.replace('for(const index of [1,2])','async function orphanObservers(){for(const index of [1,2])').replace("check='assets';", "}check='assets';"),
  extraObserver:s=>s.replace('for(const index of [1,2])','for(const index of [1,2,3])'),
  missingCursor:s=>s.replace('encodeURIComponent(before.cursor)','encodeURIComponent(saved[0].previous_block)'),
  missingOlderFidelity:s=>s.replace('savedProof(older,saved[0]);',''),
  missingNewestFidelity:s=>s.replace('savedProof(newest,saved[1]);',''),
  missingLayout:s=>s.replace('expect(await normalizedDom(run(page,0))).toBe(dom[0]);',''),
  missingChronology:s=>s.replace('toEqual(commands.map(c=>c.run_id))','toEqual([])'),
  missingReadOnly:s=>s.replace('&&readOnly(r.requests)',''),
  missingLive:s=>s.replace('savedProof(await displayedBlock(run(a,task)),expectedBlock(saved[task]));',''),
  missingNative:s=>s.replace('unchangedNative(await fixture.inspect(),final);',''),
  missingObserverPrivacy:s=>s.replace('await boundary(page,contexts[index],fixture.owner,markers);check=\'native-unchanged\';',"check='native-unchanged';"),
  missingFinalPrivacy:s=>s.replace('for(let i=0;i<pages.length;i++)await boundary(pages[i],contexts[i],fixture.owner,markers);',''),
  missingAssets:s=>s.replace('await Promise.all(assetReads);',''),
  missingFaults:s=>s.replace('Object.values(faults).every(n=>n===0)','true'),
  missingStorage:s=>s.replace('localStorage.length === 0','true'),
  missingDrain:s=>s.replace('strictStop(evidence);',''),
  rawError:s=>s.replace('JSON.stringify(records.slice(1).map(r=>intentFacts(r,faults)))','JSON.stringify(error)'),
  rawStack:s=>s.replace('JSON.stringify(records.slice(1).map(r=>intentFacts(r,faults)))','error.stack'),
  rawURL:s=>s.replace('intentFacts(r,faults))','r.older[0].request.url())'),
  rawRequest:s=>s.replace('intentFacts(r,faults))','r.older[0].request)'),
  rawDOM:s=>s.replace('intentFacts(r,faults))','page.content())'),
  rawCredential:s=>s.replace('intentFacts(r,faults))','fixture.owner)'),
  failureBrowserCall:s=>s.replace('console.log(`Skill fidelity input failure:', 'await pages[1].content();console.log(`Skill fidelity input failure:'),
  diagnosticEscape:s=>s.replace("catch{console.log('Skill fidelity diagnostic unavailable');}","catch{throw error;}"),
};
for(const [name,change] of Object.entries(intentChanges))test(`actual shared observer guard rejects ${name}`,()=>{
  const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));
});
function actualFunction(text,name) {
  const source=ts.createSourceFile('actual.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const functions=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name.text===name);assert.equal(functions.length,1);
  return functions[0].getText(source).replace('export ','');
}
function requestCollector(text) {
  const source=ts.createSourceFile('actual.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),callbacks=[];
  function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='context.on'&&n.arguments[0].getText(source)==="'request'")callbacks.push(n.arguments[1]);ts.forEachChild(n,visit);}visit(source);
  assert.equal(callbacks.length,1);return callbacks[0].getText(source);
}
const base=`/v1/sessions/${f.SID}/conversation`,origin='http://127.0.0.1:1234';
function collect(text,index,path,intent=false,newest=true,prior=0) {
  const r={requests:[],snapshots:[],streams:[],older:Array.from({length:prior},()=>({kind:'block'})),events:[],newest,intent,permission:null};
  const faults={external:0,private:0,request:0,collector:0},fixture={origin,owner:'synthetic'},request={url:()=>origin+path,method:()=> 'GET',headers:()=>({authorization:'Bearer synthetic'})};
  runInNewContext(`${actualFunction(text,'backwardRead')};(${requestCollector(text)})(request)`,{r,faults,fixture,index,sid:f.SID,URL,request,files:new Map(),leaked:()=>false,allowedRequest:()=>true});
  assert.equal(faults.collector,0);return {r,faults};
}
for(const index of [1,2])for(const [path,kind] of [[`${base}?before=synthetic`,'block'],[`${base}?within=synthetic`,'activity'],[`${base}/content?cursor=synthetic`,'content'],[`${base}?extra=synthetic`,'other']]){
  test(`actual observer ${index} collector rejects setup ${kind}`,()=>{const {r,faults}=collect(sourceText,index,path);assert.equal(r.older.length,1);assert.equal(r.older[0].kind,kind);assert.equal(faults.request,1);assert.deepEqual(r.events,['older-request']);});
  test(`actual observer ${index} collector permits only one post-key block: ${kind}`,()=>{const {r,faults}=collect(sourceText,index,path,true);assert.equal(r.older.length,1);assert.equal(faults.request,kind==='block'?0:1);});
}
for(const index of [1,2]){
  test(`actual observer ${index} collector rejects pre-newest and repeated reads`,()=>{assert.equal(collect(sourceText,index,base+'?before=synthetic',true,false).faults.request,1);assert.equal(collect(sourceText,index,base+'?before=synthetic',true,true,1).faults.request,1);});
  test(`actual observer ${index} latest/live are not backward reads`,()=>{for(const path of [base,base+'/events?after=synthetic']){const {r,faults}=collect(sourceText,index,path);assert.equal(r.older.length,0);assert.equal(faults.request,0);}});
}
for(const [name,change] of Object.entries({
  content:text=>text.replace("if (url.pathname === `${base}/content`) return 'content';","if (url.pathname === `${base}/content`) return null;"),
  permission:text=>text.replace('!r.newest||!r.intent','!r.newest'),
  activity:text=>text.replace("kind!=='block'","kind==='other'"),
  count:text=>text.replace('||r.older.length!==1',''),
}))test(`actual collector negative control ${name}`,()=>{
  const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));
  assert.throws(()=>{const {r,faults}=collect(changed,1,base+(name==='content'?'/content?cursor=synthetic':name==='activity'?'?within=synthetic':'?before=synthetic'),name!=='permission',true,name==='count'?1:0);assert.equal(r.older.length,name==='count'?2:1);assert.equal(faults.request,1);});
});
function diagnostics(text,r,faults={collector:0,request:0}) {
  return JSON.parse(JSON.stringify(runInNewContext(`${actualFunction(text,'intentFacts')};intentFacts(r,faults)`,{r,faults})));
}
const diagnosticRecord={prekey:{focused:true,top:0,height:1200,viewport:600},intent:false,newest:true,setup_reads:0,older:[]};
test('actual pre-key diagnostics contain only bounded allowlisted facts',()=>{
  assert.deepEqual(diagnostics(sourceText,diagnosticRecord),{available:true,focused:true,top:0,height:1200,viewport:600,intent:false,newest:true,setup_reads:0,backward_reads:0,routes:[],collector_faults:0,request_faults:0});
  assert.equal(diagnostics(sourceText,{...diagnosticRecord,prekey:null}).available,false);
  assert.equal(diagnostics(sourceText,{...diagnosticRecord,prekey:{...diagnosticRecord.prekey,top:2**40}}).top,1_000_000_000);
  const raw='synthetic private error stack URL DOM credential';
  const value=diagnostics(sourceText,{...diagnosticRecord,prekey:{focused:raw,top:Infinity,height:NaN,viewport:raw},setup_reads:-1,older:Array.from({length:8},()=>({kind:raw,request:raw})),raw},{collector:Infinity,request:2**40});
  assert.equal(JSON.stringify(value).includes(raw),false);assert.equal(value.top,null);assert.equal(value.height,null);assert.equal(value.viewport,null);assert.equal(value.setup_reads,null);assert.equal(value.collector_faults,null);assert.equal(value.request_faults,1_000_000);assert.deepEqual(value.routes,['other','other','other','other']);
});
for(const [name,change] of Object.entries({
  raw:r=>r.replace('collector_faults:count(faults.collector)','raw:r.raw,collector_faults:count(faults.collector)'),
  unbounded:r=>r.replace('r.older.slice(0,4)','r.older'),
  route:r=>r.replace("['block','activity','content','other'].includes(q.kind) ? q.kind : 'other'",'q.kind'),
  count:r=>r.replace('Math.min(n,1_000_000)','n'),
}))test(`actual diagnostics negative control ${name}`,()=>{
  const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));
  const r={...diagnosticRecord,raw:'synthetic private',older:Array.from({length:8},()=>({kind:'synthetic private'}))};
  assert.throws(()=>{const v=diagnostics(changed,r,{collector:0,request:2**40});assert.equal(JSON.stringify(v).includes('synthetic private'),false);assert.ok(v.routes.length<=4);assert.ok(v.request_faults<=1_000_000);});
});
