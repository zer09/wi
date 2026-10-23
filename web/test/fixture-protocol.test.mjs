import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactFromCargo, CARGO_ARGS, CHILD_TEST, parseControl, stdoutParser, gate11Options, gate11Evidence,
  gate11Witness, captureGate11, requireGate11, startFixture, bounded, fixtureRootAbsent, evaluateSkillCleanup,
  latencyEvidence, captureLatency } from '../test-support/fixture.mjs';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const diagnosticScenario = {transport:'websocket',recovered:false,mime:true,presentation:true};
const diagnostic = {protocol:1,event:'gate11_diagnostic',id:3,state:'captured',trace:{admitted_ms:0,consumed_ms:1,snapshot_ms:10,
  expected_deltas:70,expected_frames:72,await_counts:[3,3,2,2,1,1],committed_counts:[0,1,0,2],count_changes:3,
  gate_ms:[8,9,10],history:[[1,'send',3,1,null],[2,'sent',3,1,null],[3,'read',3,1,null],[4,'read_done',3,1,null],
    [5,'count',3,1,0],[6,'pace',3,1,null],[7,'paced',3,1,null],[8,'count',3,1,2]],truncated:false}};

test('gate11 options are separate, default off and retain the exact presentation scenario',()=>{
  assert.equal(gate11Options({},diagnosticScenario),false);
  assert.equal(gate11Options({gate11Diagnostics:false},diagnosticScenario),false);
  assert.equal(gate11Options({gate11Diagnostics:true},diagnosticScenario),true);
  for(const options of [null,[],{gate11Diagnostics:'true'},{gate11Diagnostics:true,private:'canary'}])assert.throws(()=>gate11Options(options,diagnosticScenario));
  for(const change of [{presentation:false},{transport:'sse'},{recovered:true},{mime:false},
    ...['mutations','unbound_history','fixed_head','tool_fidelity','lifecycle_failure','cancellation'].map(k=>({[k]:true}))]) {
    assert.throws(()=>gate11Options({gate11Diagnostics:true},{...diagnosticScenario,...change}));
  }
});

test('final polling options require diagnostics, native timing and the exact scenario',()=>{
  for(const mode of ['baseline','incremental']){
    const options={gate11Diagnostics:true,nativeLatency:true,finalPolling:mode};
    assert.equal(gate11Options(options,diagnosticScenario),true);
    for(const key of ['gate11Diagnostics','nativeLatency'])assert.throws(()=>gate11Options({...options,[key]:false},diagnosticScenario));
    for(const change of [{presentation:false},{transport:'sse'},{recovered:true},{mime:false},
      ...['mutations','unbound_history','fixed_head','tool_fidelity','lifecycle_failure','cancellation'].map(k=>({[k]:true}))])assert.throws(()=>gate11Options(options,{...diagnosticScenario,...change}));
  }
  for(const mode of [undefined,null,true,0,'full','Baseline','incremental '])assert.throws(()=>gate11Options({gate11Diagnostics:true,nativeLatency:true,finalPolling:mode},diagnosticScenario));
});

test('gate11 bounded DTO supports send/read/pacing stalls and exact committed under/overshoot',()=>{
  assert.deepEqual(parseControl(diagnostic),diagnostic);
  for(const [phase,index] of [['send',0],['read',2],['pace',4]]){
    const value=structuredClone(diagnostic);value.trace.await_counts[index+1]--;value.trace.gate_ms=[null,null,null];
    value.trace.history=[[1,phase,3,1,null]];assert.deepEqual(gate11Evidence(value),value);
  }
  for(const count of [0,1,2]){
    const value=structuredClone(diagnostic);value.trace.committed_counts=[count,count,count,count];value.trace.count_changes=1;
    value.trace.history=[[1,'count',3,1,count]];assert.equal(gate11Evidence(value).trace.committed_counts[1],count);
  }
  for(const state of ['disabled','unavailable','capture_failed'])assert.equal(gate11Evidence({...diagnostic,state,trace:null}).state,state);
  const bytes=Buffer.from(JSON.stringify(diagnostic)+'\n');assert.ok(bytes.length<4096);
  for(let split=0;split<=bytes.length;split++){const seen=[],p=stdoutParser(v=>seen.push(v));p.push(bytes.subarray(0,split));p.push(bytes.subarray(split));p.end();assert.deepEqual(seen,[diagnostic]);}
});

test('gate11 DTO rejects malformed limits, private fields, absent fields and impossible clock/count order',()=>{
  const changes=[{expected_deltas:129},{expected_frames:131},{snapshot_ms:600001},{consumed_ms:11},{admitted_ms:1},
    {await_counts:[0,1,0,0,0,0]},{await_counts:[0,0,0,0,0,1000001]},{await_counts:[]},{committed_counts:[0,null,0,0]},
    {committed_counts:[0,1,2,3]},{committed_counts:[0,1000001,0,1000001]},{count_changes:0},
    {gate_ms:[null,1,null]},{gate_ms:[5,4,6]},{gate_ms:[1,2,11]},{history:Array(13).fill([1,'send',1,0,null])},
    {history:[[2,'send',1,0,null],[1,'sent',1,0,null]]},{history:[[1,'send',131,0,null]]},
    {history:[[1,'count',1,0,null]]},{history:[[1,'send',1,0,1]]},{history:[[1,'private-canary',1,0,null]]},
    {truncated:'false'},{path:'/private-canary'},{token:'private-canary'},{payload:{text:'private-canary'}}];
  for(const change of changes)assert.throws(()=>gate11Evidence({...diagnostic,trace:{...diagnostic.trace,...change}}),{message:'fixture protocol rejected'});
  for(const parent of [diagnostic,diagnostic.trace])for(const key of Object.keys(parent)){
    const v=structuredClone(diagnostic);delete (parent===diagnostic?v:v.trace)[key];assert.throws(()=>gate11Evidence(v));
  }
  for(const change of [{id:0},{id:0x100000000},{state:'healthy'},{state:'unavailable'},{error:'private-canary'}])assert.throws(()=>gate11Evidence({...diagnostic,...change}));
  for(const duplicate of [JSON.stringify(diagnostic).replace('"admitted_ms":0','"admitted_ms":0,"admitted_ms":0'),
    JSON.stringify(diagnostic).replace('"state":"captured"','"state":"captured","state":"captured"'),
    JSON.stringify(diagnostic).replace('admitted_ms','\\u0061dmitted_ms')])assert.throws(()=>stdoutParser(()=>{}).push(Buffer.from(duplicate+'\n')));
});

const latencyRows = [[0,10,50,30,10,10,0,0,1],...Array.from({length:30},(_,i)=>[1,i,1,40,40,0]),
  [3,1,1,1],[2,25,1,1,1,0,30,0,1]];
const latencyPage = (page,rows=latencyRows,pages=Math.ceil(rows.length/24)) => ({protocol:1,event:'gate11_latency',id:page+1,state:'captured',page,pages,rows:rows.slice(page*24,page*24+24)});
test('native latency pages are numeric, frozen, ordered and bounded',async()=>{
  const requests=[];
  const rows=await captureLatency({request:async c=>{requests.push(c);return latencyPage(c.page);}});
  assert.deepEqual(rows,latencyRows);assert.deepEqual(requests,[{command:'gate11_latency',page:0},{command:'gate11_latency',page:1}]);
  assert.throws(()=>{rows[0][0]=1;},TypeError);
  const seen=[],p=stdoutParser(v=>seen.push(v)),line=Buffer.from(JSON.stringify(latencyPage(0))+'\n');
  for(const byte of line)p.push(Buffer.from([byte]));p.end();assert.equal(seen.length,1);
  assert.equal(gate11Options({nativeLatency:true,gate11Diagnostics:true},diagnosticScenario),true);
  assert.throws(()=>gate11Options({nativeLatency:true},diagnosticScenario));
  for(const state of ['disabled','unavailable','capture_failed']){
    const dto={protocol:1,event:'gate11_latency',id:1,state,page:0,pages:0,rows:[]};
    assert.deepEqual(latencyEvidence(dto),dto);
    await assert.rejects(captureLatency({request:async()=>dto}),{message:`fixture latency ${state}`});
  }
});
test('native latency pages reject hidden fields, malformed rows and changing frozen order',async()=>{
  for(const change of [{page:-1},{pages:35},{page:2},{rows:[]},{rows:[[4]]},{rows:[[1,30,0,0,0,0]]},
    {rows:[[2,25,1,1,71,0,0,0,0]]},{rows:[[0,50,10,0,0,0,0,0,0]]},{rows:[[1,0,1,1,2,0]]},{rows:[[3,0,0,0]]},
    {rows:[[2,25,1,1,1,2,1,0,0]]},{rows:[[2,25,1,1,1,0,1,2,0]]},{private:'canary'}])assert.throws(()=>latencyEvidence({...latencyPage(0),...change}));
  for(const change of [v=>({...v,page:0}),v=>({...v,pages:3}),v=>({...v,rows:v.rows.slice(1)})]){
    await assert.rejects(captureLatency({request:async c=>c.page===0?latencyPage(0):change(latencyPage(1))}));
  }
  for(const text of [JSON.stringify(latencyPage(0)).replace('"page":0','"page":0,"page":0'),
    JSON.stringify(latencyPage(0)).replace('page','\\u0070age')])assert.throws(()=>stdoutParser(()=>{}).push(Buffer.from(text+'\n')));
});

test('numeric whole-window work row is closed and cannot replace complete ordered stage aggregates',async()=>{
  const rows=[...latencyRows.slice(0,31),[4,10000,10000,70,70],...latencyRows.slice(31)];
  assert.deepEqual(await captureLatency({request:async c=>latencyPage(c.page,rows)}),rows);
  const partial=structuredClone(rows);partial[0][6]=1;
  assert.deepEqual(await captureLatency({request:async c=>latencyPage(c.page,partial)}),partial);
  for(const row of [[4],[4,2,3,1,1],[4,1,1,71,71],[4,1,1,2,1],[4,600000001,1,1,1],[4,1,1,1,1,'private']])assert.throws(()=>latencyEvidence(latencyPage(0,[row])));
  for(const changed of [[...rows,[4,1,1,1,1]],[...rows.slice(0,31),...rows.slice(32),rows[31]],
    [rows[0],...rows.slice(2,31),rows[1],...rows.slice(31)]])await assert.rejects(captureLatency({request:async c=>latencyPage(c.page,changed)}));
  const text=JSON.stringify(rows);assert.equal(/private|payload|SQL|token|task-|uuid/.test(text),false);
});

test('gate11 node witness has a separate monotonic origin, finite history and explicit capture failure',()=>{
  let clock=1000;const w=gate11Witness(true,()=>clock);
  assert.equal(w.snapshot().state,'unavailable');w.mark('drive_request',7);clock+=2;w.mark('drive_ack');clock+=3;w.mark('wait_start');clock+=20000;w.mark('wait_expired');
  const frozen=w.snapshot();clock++;w.mark('gate_parse');w.mark('gate_queue');
  assert.deepEqual(frozen.history,[[0,'drive_request'],[2,'drive_ack'],[5,'wait_start'],[20005,'wait_expired']]);
  assert.throws(()=>frozen.history.push([1,'private']),TypeError);assert.throws(()=>{frozen.history[0][1]='private';},TypeError);
  for(let n=0;n<20;n++)w.mark('gate_match');assert.equal(w.snapshot().history.length,16);assert.equal(w.snapshot().truncated,true);
  clock=0;w.mark('gate_parse');assert.equal(w.snapshot().state,'capture_failed');
  const off=gate11Witness(false);off.mark('private');assert.equal(off.snapshot().state,'disabled');
  const bad=gate11Witness(true,()=>{throw new Error('synthetic-private');});bad.mark('drive_request',1);assert.equal(bad.snapshot().state,'capture_failed');
});

test('gate11 successful boundary requires complete witnesses, not only a captured status',()=>{
  const node={state:'captured',truncated:false,history:['drive_request','drive_ack','wait_start','gate_parse','gate_match'].map(s=>[0,s])};
  const native={...diagnostic,trace:{...diagnostic.trace,await_counts:[72,72,70,70,0,0],committed_counts:[0,70,0,70]}};
  const report={observation:'boundary',node,native_state:'captured',native};requireGate11(report);
  for(const change of [{consumed_ms:null},{expected_deltas:0},{gate_ms:[1,2,null]},
    {await_counts:[72,71,70,70,0,0]},{committed_counts:[0,69,0,69]}]){
    assert.throws(()=>requireGate11({...report,native:{...native,trace:{...native.trace,...change}}}),{message:'fixture diagnostic failed'});
  }
  assert.throws(()=>requireGate11({...report,node:{...node,history:[]}}),{message:'fixture diagnostic failed'});
  assert.throws(()=>requireGate11({...report,node:{...node,truncated:true}}),{message:'fixture diagnostic failed'});
});

test('gate11 original timeout callback records expiry without replacing the fixed failure',async()=>{
  const w=gate11Witness(true);w.mark('drive_request',1);w.mark('wait_start');
  await assert.rejects(bounded(new Promise(()=>{}),1,'fixture control timed out',()=>w.mark('wait_expired')),{message:'fixture control timed out'});
  assert.equal(w.snapshot().history.at(-1)[1],'wait_expired');
});

async function diagnosticPeer(t, mode, options = {gate11Diagnostics:true}){
  const root=await mkdtemp(join(tmpdir(),'wi-gate11-peer-')), executable=join(root,'peer.mjs'), metadata=join(root,'owned.json');
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const mode=${JSON.stringify(mode)}, dto=${JSON.stringify({...diagnostic,trace:{...diagnostic.trace,await_counts:[72,72,70,70,1,1],committed_counts:[0,70,0,70],history:[[7,'count',72,70,70]]}})};
fs.writeFileSync(${JSON.stringify(metadata)},JSON.stringify({pid:process.pid,sandbox:process.cwd()}));
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const lines=readline.createInterface({input:process.stdin});lines.on('close',()=>process.stdout.end(()=>process.exit(0)));
lines.on('line',line=>{const c=JSON.parse(line);
if(!c.command){if(${options.gate11Diagnostics === true ? 'c.gate11_diagnostics!==true' : "Object.hasOwn(c,'gate11_diagnostics')"})process.exit(7);
if(${Object.hasOwn(options,'finalPolling') ? `c.final_polling!==${JSON.stringify(options.finalPolling)}||c.native_latency!==true` : "Object.hasOwn(c,'final_polling')"})process.exit(8);
send({protocol:1,id:c.id,event:'ready',origin:'http://127.0.0.1:1'});}
else if(c.command==='drive'){const values=[{protocol:1,id:c.id,event:'driven'}];if(mode==='buffered')values.push({protocol:1,event:'model_paused',gate:11});process.stdout.write(values.map(v=>JSON.stringify(v)).join('\\n')+'\\n');}
else if(c.command==='gate11_diagnostic'){if(mode==='late')send({protocol:1,event:'model_paused',gate:11});send({...dto,id:c.id,...(mode==='malformed'?{trace:null}:{})});}
else if(c.command==='stop')send({protocol:1,id:c.id,event:'stopped',cleaned:true});
});`,{mode:0o700});
  t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=await startFixture(executable,diagnosticScenario,options);
  t.after(()=>fixture.stop().catch(()=>{}));
  return {fixture,owned:JSON.parse(await readFile(metadata,'utf8'))};
}
for(const mode of ['buffered','late','malformed'])test(`gate11 real owned pipes distinguish ${mode} delivery and retain strict cleanup`,async t=>{
  const {fixture,owned}=await diagnosticPeer(t,mode);await fixture.request({command:'drive',gate:10});
  let original=null;
  if(mode==='buffered')await fixture.wait('model_paused',11);
  if(mode==='late'){
    await assert.rejects(fixture.wait('model_paused',11),{message:'fixture control timed out'});
    original={stage:'task-2',check:'paused-11',timeout:true,fixture_failed:false,body_protocol:false};
  }
  const report=await captureGate11(fixture,original);
  if(mode==='malformed'){
    assert.equal(report.native_state,'rejected');assert.throws(()=>requireGate11(report),{message:'fixture diagnostic failed'});
    await assert.rejects(fixture.stop(),{message:'fixture shutdown failed'});
  }else{
    requireGate11(report);await fixture.stop();
    assert.equal(fixture.evidence().stop.clean_acknowledgment,true);assert.equal(fixture.evidence().stop.exit_zero,true);
    if(mode==='buffered')assert.deepEqual(report.node.history.map(r=>r[1]).filter(s=>s.startsWith('gate_')),['gate_parse','gate_queue','gate_match']);
    else{
      assert.equal(report.observation,'post_failure');assert.deepEqual(report.failure,original);
      assert.equal(report.node.history.at(-1)[1],'wait_expired');assert.ok(!report.node.history.some(r=>r[1]==='gate_parse'));
      assert.ok(fixture.diagnostics().history.some(r=>r[1]==='gate_parse'));
    }
  }
  assert.equal(fixture.evidence().stop.reap_complete,true);assert.equal(fixture.evidence().stop.sandbox_removed,true);
  assert.throws(()=>process.kill(owned.pid,0),{code:'ESRCH'});await assert.rejects(access(owned.sandbox),{code:'ENOENT'});
});

for(const options of [{},{gate11Diagnostics:false}])test(`gate11 actual caller keeps opt-in ${JSON.stringify(options)} absent on owned pipes`,async t=>{
  const {fixture}=await diagnosticPeer(t,'default',options);
  for(const gate of [1,4,7,10])assert.equal((await fixture.request({command:'drive',gate})).event,'driven');
  await assert.rejects(fixture.request({command:'gate11_diagnostic'}),{message:'fixture protocol rejected'});
  assert.deepEqual(fixture.diagnostics(),{state:'disabled',drive_id:null,truncated:false,history:[]});
  await fixture.stop();assert.equal(fixture.evidence().stop.exit_zero,true);
});

test('ordinary Task B polling stays independent from diagnostic and latency options',async()=>{
  const source=await readFile(new URL('../../src/providers/openai_codex/tests/replay/http_api_joined/browser.rs',import.meta.url),'utf8');
  const presentation=await readFile(new URL('../../src/providers/openai_codex/tests/replay/http_api_joined/browser/presentation.rs',import.meta.url),'utf8');
  assert.ok(source.includes('let cursor = if presentation {\n                presentation::ordinary_cursor(gate, &records, diagnostic.as_deref())'));
  assert.ok(source.includes('presentation::reply(&mut wire, &db, id, partial, trace, cursor).await;'));
  assert.ok(source.includes('presentation::reply(&mut wire, &db, id, reply, None, None).await;'));
  assert.ok(presentation.includes('if gate != 10 || trace.is_some_and(|t| t.polling.is_some())'));
  assert.ok(presentation.includes('Some(FinalCursor::new(records, "task-1-final"))'));
  assert.ok(presentation.includes('db.records_after(cursor.sequence),\n                        );\n                        if let Some(read) = &read {\n                            read.scope(poll).await\n                        } else {\n                            poll.await'));
  for(const options of [{},{gate11Diagnostics:true}]){
    assert.equal(gate11Options(options,diagnosticScenario),options.gate11Diagnostics===true);
    assert.equal(Object.hasOwn(options,'nativeLatency'),false);
    assert.equal(Object.hasOwn(options,'finalPolling'),false);
  }
});

for(const finalPolling of ['baseline','incremental'])test(`actual owned synthetic pipes transmit closed final polling ${finalPolling}`,async t=>{
  const {fixture}=await diagnosticPeer(t,'default',{gate11Diagnostics:true,nativeLatency:true,finalPolling});
  await fixture.stop();assert.equal(fixture.evidence().stop.exit_zero,true);
});

test('gate11 pre-guard failure keeps original disposition and verifies actual owned root cleanup',async t=>{
  const {fixture,owned}=await diagnosticPeer(t,'buffered'), root=await fixture.bindRoot();
  assert.equal(root.path,owned.sandbox);assert.equal(root.pid,owned.pid);
  await assert.rejects(fixtureRootAbsent(root));
  const original=new Error('synthetic pre-guard gate11 failure');
  await fixture.stop();
  assert.throws(()=>process.kill(owned.pid,0),{code:'ESRCH'});
  const cleanup={root,contexts:1,contexts_expected:1,handle_acquired:false,handle_closed:null,
    fixture:true,root_absent:await fixtureRootAbsent(root),pid_absent:true,evidence:fixture.evidence()};
  assert.equal(evaluateSkillCleanup(cleanup),true);assert.equal(original.message,'synthetic pre-guard gate11 failure');
});

test('gate11 unavailable/rejected exports freeze original failure before post-failure requests',async()=>{
  const facts={stage:'task-2',check:'paused-11',timeout:true},w=gate11Witness(true);w.mark('drive_request',2);w.mark('wait_expired');
  for(const state of ['unavailable','capture_failed','disabled','rejected']){
    const fixture={diagnostics:()=>w.snapshot(),request:async()=>{facts.check='later';w.mark('gate_parse');if(state==='rejected')throw new Error('synthetic-private');return{...diagnostic,state,trace:null};}};
    facts.check='paused-11';const report=await captureGate11(fixture,facts);
    assert.equal(report.failure.check,'paused-11');assert.equal(report.native_state,state);
    assert.throws(()=>requireGate11(report),{message:'fixture diagnostic failed'});
    assert.ok(!JSON.stringify(report).includes('synthetic-private'));
  }
  const report=await captureGate11({diagnostics:()=>{throw new Error('private');},request:async()=>({...diagnostic,state:'unavailable',trace:null})},facts);
  assert.equal(report.node.state,'capture_failed');
});

const artifact = {
  reason: 'compiler-artifact', target: { name: 'wi', kind: ['lib'], src_path: '/repo/src/lib.rs' },
  profile: { test: true }, manifest_path: '/repo/Cargo.toml', executable: '/build/a-cargo-reported-name',
};
const finished = { reason: 'build-finished', success: true };
const cargo = (...messages) => messages.map(value => JSON.stringify(value)).join('\n');

test('fixture artifact comes only from the exact lib test target and successful Cargo JSON build', () => {
  assert.deepEqual(CARGO_ARGS, ['test', '--lib', '--no-run', '--locked', '--offline', '--message-format=json']);
  assert.equal(artifactFromCargo(cargo({ ...artifact, target: { ...artifact.target, kind: ['bin'] } }, artifact, finished), '/repo'), artifact.executable);
  assert.equal(artifactFromCargo(cargo({ ...artifact, profile: { test: false } }, artifact, finished), '/repo'), artifact.executable);
});

test('artifact discovery fails closed on ambiguity, missing artifact, wrong root and failed build', () => {
  for (const text of [cargo(finished), cargo(artifact, artifact, finished), cargo(artifact), 'not JSON',
    cargo(artifact, { ...finished, success: false }), cargo(artifact, finished, finished),
    cargo({ ...artifact, executable: null }, finished), cargo({ ...artifact, executable: 'relative' }, finished),
    cargo({ ...artifact, manifest_path: '/elsewhere/Cargo.toml' }, finished),
    cargo({ ...artifact, target: { ...artifact.target, src_path: '/elsewhere/src/lib.rs' } }, finished)]) {
    assert.throws(() => artifactFromCargo(text, '/repo'), { message: 'fixture protocol rejected' });
  }
});

test('child control parser accepts only closed safe event shapes', () => {
  for (const value of [
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345' },
    { protocol: 1, event: 'model_paused', gate: 1 },
    { protocol: 1, event: 'model_paused', gate: 8 },
    { protocol: 1, event: 'model_paused', gate: 12 },
    { protocol: 1, event: 'task_finished', task: 2 },
    { protocol: 1, id: 2, event: 'stopped', cleaned: true },
    { protocol: 1, id: 3, event: 'acceptance_paused' },
  ]) assert.deepEqual(parseControl(value), value);
  for (const value of [
    { protocol: 1, id: 1, event: 'ready', origin: 'http://localhost:12345' },
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:65536' },
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345/path' },
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345', token: 'never forward this' },
    { protocol: 1, event: 'model_paused', gate: 0 },
    { protocol: 1, event: 'model_paused', gate: 13 },
    { protocol: 1, event: 'model_paused', gate: 1.5 },
    { protocol: 1, event: 'model_paused', gate: '1' },
    { protocol: 1, event: 'model_paused', gate: 8, text: 'never forward' },
    { protocol: 1, id: 2, event: 'stopped', cleaned: false },
    { protocol: 1, id: 2, event: 'unknown' },
    { protocol: 2, event: 'task_finished', task: 2 },
  ]) assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
});

test('inspection accepts only counters, IDs, booleans and sequence strings, never saved private payloads', () => {
  const value = { protocol: 1, id: 2, event: 'inspect', connections: 0, requests: 0, gate: null, completed: 0,
    fresh_empty: false, restored_history: false, fresh_parents: 0, continuations: 0, prepared_exact: 0,
    auth_loads: 0, auth_prepares: 0, sequence_count: '1', accepted: [], receipts: [], tool_results: 0, terminals: 0, results: 0,
    response_finishes: [], terminal_sequences: [], result_sequences: [], provider_stage: null, provider_failed: false, read_failure: null };
  assert.deepEqual(parseControl(value), value);
  for (let gate = 1; gate <= 12; gate++) {
    assert.equal(parseControl({ ...value, gate }).gate, gate);
    assert.equal(parseControl({ protocol: 1, event: 'model_paused', gate }).gate, gate);
  }
  const completed = { ...value, terminals: 1, results: 1, terminal_sequences: ['9007199254740993'], result_sequences: ['9007199254740994'],
    response_finishes: [{ sequence: '9007199254740992', provenance: 'native_terminal' }] };
  assert.deepEqual(parseControl(completed), completed);
  assert.deepEqual(parseControl({ ...completed, response_finishes: [{ sequence: '2', provenance: 'validated_output_item_done' }] }).results, 1);
  for (const changed of [{ requests: -1 }, { sequence_count: 1 }, { instructions: 'never forward' },
    { gate: 13 }, { gate: 1.5 }, { provider_stage: 'private detail' }, { provider_failed: 'false' }, { read_failure: 'private detail' },
    { response_finishes: [{ sequence: '2', provenance: 'unknown' }] },
    { response_finishes: [{ sequence: '2', provenance: 'native_terminal', text: 'never forward' }] },
    { response_finishes: [{ sequence: 2, provenance: 'native_terminal' }] },
    { terminal_sequences: ['01'] }, { result_sequences: ['3'] }, { result_sequences: [3] },
    { results: 3, result_sequences: ['1', '2', '3'] },
    { receipts: [{ operation_id: 'bad' }] }, { accepted: [{ run_id: 'bad', accepted_sequence: '2' }] }]) {
    assert.throws(() => parseControl({ ...value, ...changed }), { message: 'fixture protocol rejected' });
  }
});

const receipt = { operation_id: '11111111-1111-4111-8111-111111111111',
  session_id: '22222222-2222-4222-8222-222222222222', run_id: null, first_sequence: '1', last_sequence: '1' };
const rename = { ...receipt, operation_id: '33333333-3333-4333-8333-333333333333', first_sequence: '2', last_sequence: '2' };
const rename2 = { ...receipt, operation_id: '44444444-4444-4444-8444-444444444444', first_sequence: '3', last_sequence: '3' };
const eventIds = ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const entry = { slot: 0, receipt, sequence_count: '3', rename_events: 2, renames: [rename, rename2],
  rename_event_ids: eventIds, exact: true, catalog_head_sequence: '2', catalog_current: false };
const second = { slot: 1, receipt: { ...receipt, operation_id: '77777777-7777-4777-8777-777777777777',
  session_id: '88888888-8888-4888-8888-888888888888' }, sequence_count: '1', rename_events: 0, renames: [],
  rename_event_ids: [], exact: true, catalog_head_sequence: '1', catalog_current: true };
const mutation = { protocol: 1, id: 1, event: 'mutation_inspect', max_input_bytes: 1048576,
  session_count: 2, seed_sessions: 1, creations: [entry] };

test('mutation inspection accepts exact empty, seed, creation and current/stale rename evidence within 4096 bytes', () => {
  for (const seed_sessions of [0, 1]) {
    for (const creations of [[], [{ ...second, slot: 0 }], [entry], [entry, second],
      [{ ...entry, catalog_head_sequence: '1' }], [{ ...entry, catalog_head_sequence: '3', catalog_current: true }]]) {
      const value = { ...mutation, seed_sessions, session_count: creations.length + seed_sessions, creations };
      assert.deepEqual(parseControl(value), value);
      const line = Buffer.from(`${JSON.stringify(value)}\n`);
      assert.ok(line.length <= 4096);
      const received = [];
      const parser = stdoutParser(value => received.push(value));
      parser.push(line); parser.end();
      assert.deepEqual(received, [value]);
    }
  }
});

test('mutation inspection rejects unknown, private and missing fields at every level with static diagnostics', () => {
  for (const value of [
    { ...mutation, token: 'private-canary' }, { ...mutation, payload: { title: 'private-canary' } },
    ...[{ title: 'private-canary' }, { workspace: '/private-canary' }, { text: 'private-canary' }, { body: {} },
      { receipt: { ...receipt, private: 'private-canary' } }, { renames: [{ ...rename, payload_hash: 'private-canary' }, rename2] }]
      .map(change => ({ ...mutation, creations: [{ ...entry, ...change }] })),
  ]) assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
  for (const path of [[], ['creations', 0], ['creations', 0, 'receipt'], ['creations', 0, 'renames', 0]]) {
    const original = path.reduce((value, key) => value[key], mutation);
    for (const field of Object.keys(original)) {
      const value = structuredClone(mutation);
      delete path.reduce((object, key) => object[key], value)[field];
      assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
    }
  }
});

test('mutation inspection rejects incoherent counts, slots, event IDs, catalog heads and receipts', () => {
  for (const change of [
    { sequence_count: 3 }, { sequence_count: '03' }, { sequence_count: '2' }, { sequence_count: '4' },
    { sequence_count: '9007199254740993' }, { slot: 1 }, { slot: '0' }, { exact: 'true' }, { exact: false },
    { catalog_current: null }, { catalog_current: true }, { catalog_head_sequence: '3' },
    { catalog_head_sequence: '0' }, { catalog_head_sequence: '4' }, { catalog_head_sequence: '02' },
    { catalog_head_sequence: 2 }, { catalog_head_sequence: '-1' }, { catalog_head_sequence: '9007199254740993' },
    { rename_events: 1 }, { rename_events: '2' }, { renames: [rename, rename] },
    { rename_event_ids: null }, { rename_event_ids: [eventIds[0]] }, { rename_event_ids: [...eventIds, eventIds[0]] },
    { rename_event_ids: [eventIds[0], eventIds[0]] }, { rename_event_ids: ['private-canary', eventIds[1]] },
    { rename_event_ids: [null, eventIds[1]] }, { rename_event_ids: ['00000000-0000-0000-0000-000000000000', eventIds[1]] },
    { receipt: { ...receipt, operation_id: 'invalid' } }, { receipt: { ...receipt, session_id: null } },
    { receipt: { ...receipt, operation_id: '00000000-0000-0000-0000-000000000000' } },
    { receipt: { ...receipt, run_id: receipt.session_id } }, { receipt: { ...receipt, first_sequence: '0', last_sequence: '0' } },
    { renames: [{ ...rename, first_sequence: '3', last_sequence: '3' }, rename2] },
    { renames: [{ ...rename, session_id: rename.operation_id }, rename2] },
    { renames: [{ ...rename, operation_id: receipt.operation_id }, rename2] },
    { renames: [{ ...rename, last_sequence: '3' }, rename2] },
  ]) assert.throws(() => parseControl({ ...mutation, creations: [{ ...entry, ...change }] }), { message: 'fixture protocol rejected' });
  for (const change of [
    { max_input_bytes: 0 }, { max_input_bytes: '1048576' }, { session_count: '2' }, { session_count: 1 },
    { session_count: 3 }, { session_count: -1 }, { seed_sessions: '1' }, { seed_sessions: -1 },
    { seed_sessions: 2, session_count: 3 }, { seed_sessions: 0 }, { creations: [] },
    { session_count: 3, creations: [entry, { ...second, slot: 0 }] },
    { session_count: 3, creations: [entry, { ...second, slot: 2 }] },
    { session_count: 3, creations: [entry, { ...second, receipt }] },
    { session_count: 3, creations: [entry, { ...entry, slot: 1 }] },
    { session_count: 4, creations: [entry, second, { ...second, slot: 2 }] },
  ]) assert.throws(() => parseControl({ ...mutation, ...change }), { message: 'fixture protocol rejected' });
});

// Terminal labels describe only the caught control failure, never provider or SQL text.
const terminalPairs = {
  unknown: ['control_other'], selection: ['invariant'], connect: ['connect_busy', 'connect_other'],
  events_query: ['query_busy', 'query_other'], events_decode: ['decode'],
  receipts_query: ['query_busy', 'query_other'], receipts_decode: ['decode'],
};
const terminal = { protocol: 1, event: 'fixture_failed', phase: 'unknown', category: 'control_other' };
test('fatal fixture events admit only the finite closed phase/category pairs across every chunk split', () => {
  for (const [phase, categories] of Object.entries(terminalPairs)) for (const category of categories) {
    const value = { ...terminal, phase, category };
    assert.deepEqual(parseControl(value), value);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    for (let split = 0; split <= bytes.length; split++) {
      const seen = [], parser = stdoutParser(value => seen.push(value));
      parser.push(bytes.subarray(0, split)); parser.push(bytes.subarray(split)); parser.end();
      assert.deepEqual(seen, [value]);
    }
  }
});
test('fatal fixture events reject missing/private/extra fields, types, unknown and mismatched labels', () => {
  for (const key of Object.keys(terminal)) { const value = { ...terminal }; delete value[key]; assert.throws(() => parseControl(value)); }
  for (const change of [{ protocol: '1' }, { event: null }, { phase: null }, { category: 1 }, { phase: 'private-canary' },
    { category: 'private-canary' }, { phase: 'connect', category: 'query_busy' }, { id: 1 }, { path: '/private-canary' },
    { payload: {} }, { error: 'private-canary' }, { headers: {} }, { token: 'private-canary' }]) {
    assert.throws(() => parseControl({ ...terminal, ...change }), { message: 'fixture protocol rejected' });
  }
});
test('fatal fixture framing rejects duplicate and escaped keys, partial EOF and existing byte limits', () => {
  const line = JSON.stringify(terminal);
  for (const key of Object.keys(terminal)) {
    const duplicate = line.slice(0, -1) + `,${JSON.stringify(key)}:${JSON.stringify(terminal[key])}}`;
    const escaped = duplicate.replace(`,\"${key}\":`, `,\"\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}\":`);
    for (const text of [duplicate, escaped]) assert.throws(() => stdoutParser(() => {}).push(Buffer.from(text + '\n')));
  }
  assert.throws(() => stdoutParser(() => {}).push(Buffer.from(line.replace('phase', '\\u0070hase') + '\n')));
  const parser = stdoutParser(() => {}); parser.push(Buffer.from(line)); assert.throws(() => parser.end());
  assert.throws(() => stdoutParser(() => {}).push(Buffer.from(line + ' '.repeat(4096) + '\n')));
  assert.throws(() => stdoutParser(() => {}).push(Buffer.alloc(64 * 1024 + 1)));
});

test('stdout parser handles arbitrary chunks and counts harness text without retaining it', () => {
  const received = [];
  const parser = stdoutParser(value => received.push(value));
  const event = { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345' };
  const text = `\nrunning 1 test\ntest ${CHILD_TEST} ... ${JSON.stringify(event)}\nok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.10s\n\n`;
  for (const byte of Buffer.from(text)) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(received, [event]);
  assert.equal(parser.harnessLines, 6);
});

test('stdout parser rejects partial EOF, oversized lines, unknown harness text and raw secrets with static diagnostics', () => {
  for (const buffer of [Buffer.from('x'.repeat(4097)), Buffer.from('private-canary\n'), Buffer.from('{bad}\n'), Buffer.from([255, 10])]) {
    assert.throws(() => stdoutParser(() => {}).push(buffer), { message: 'fixture protocol rejected' });
  }
  const parser = stdoutParser(() => {});
  parser.push(Buffer.from('{'));
  assert.throws(() => parser.end(), { message: 'fixture protocol rejected' });
  assert.throws(() => stdoutParser(() => {}).push(Buffer.from('\n'.repeat(17))), { message: 'fixture protocol rejected' });
});
