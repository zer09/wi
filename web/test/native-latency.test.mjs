import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runObservation, drainDisplay, resolveNative, cleanupProof, qualifyComparison, observeComparison } from '../test-support/native-latency.mjs';
import { parseControl } from '../test-support/fixture.mjs';
import * as f from '../test-support/display-fixtures.mjs';
import { data, answer, skillOutput } from '../test-support/presentation.mjs';
import { richPartialFacts } from '../test-support/rich-display-parity.mjs';

const stop = {failure:null,stop:{attempted:true,clean_acknowledgment:true,reap_complete:true,sandbox_removed:true,exit_observed:true,
  exit_zero:true,error_latched:false,stderr_empty:true,sigterm:false,sigkill:false}};
const latency = [[0,10,50,30,10,10,0,0,1],...Array.from({length:30},(_,i)=>[1,i,0,0,0,0])];
function completed(command,receipt) {
  const fields=(pairs,seq)=>pairs.map(([kind,text],i)=>f.field({field_id:(i+1).toString(16).repeat(64),order_key:f.order(2,i,0),kind,text,
    generation:String(seq),total_bytes:String(Buffer.byteLength(text)),to_byte:String(Buffer.byteLength(text))}));
  const rich=structuredClone(richPartialFacts);rich[5][1]='{"a":17,\r\n "b":25}';
  const specs=[rich,[['tool_name','add_numbers'],['tool_result','{"sum":42}']],[['tool_name','load_skill'],['tool_result',skillOutput]],
    [['tool_name','add_numbers'],['tool_result','{"error":{"code":"gateway_error"}}']],[['text',answer(0)]]];
  const human=f.human({run_id:command.run_id,fields:[f.field({field_id:'text',order_key:'0',generation:'2',text:data.user,total_bytes:String(Buffer.byteLength(data.user)),to_byte:String(Buffer.byteLength(data.user))})]});
  const entries=specs.map((pairs,i)=>{const seq=8+i*4,tool=i>=1&&i<=3;return f.entry({run_id:command.run_id,entry_id:`e:${seq}:0`,position:{sequence:String(seq),slot:'0'},revision:String(seq),content_epoch:String(seq),
    kind:tool?'tool':'assistant',recorded_state:i===3?'failed':'completed',provisional:false,result_recorded:tool?true:null,finish_recorded:tool?true:null,is_error:tool?i===3:null,fields:fields(pairs,seq)});});
  const summary={turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',new_tool_dispatches:'3',tool_results_prepared:'3',reused_results:'0',last_request_id:f.OID,last_upstream_outcome:'terminal_received'};
  return f.page({snapshot_head:'118',session:f.session('118',{title:data.title}),block:f.block({run_id:command.run_id,accepted_sequence:receipt.first_sequence,revision:'118',human,state:'completed',result_recorded:true,outcome:{type:'completed'},events_complete:true,summary}),
    entries,previous_block:null,live_after:f.cursor('l','118','3','','')});
}
async function peer(t, mode, metrics = false) {
  const rootPath=await mkdtemp(join(tmpdir(),'wi-browser-')),st=await lstat(rootPath,{bigint:true});
  const root={path:rootPath,pid:12345,start:'7',dev:String(st.dev),ino:String(st.ino),verified:true};
  const seen=[],commands=[],receipts=[];let sse,done=false,ids=0;
  const fixture={owner:'12'.repeat(32),bindRoot:async()=>root,evidence:()=>{
      const evidence=structuredClone(stop);if(mode==='timeout-cleanup')evidence.stop.sigterm=true;return evidence;
    },
    request:async c=>{
      seen.push(c.command === 'drive' ? `drive${c.gate}` : c.command);
      if(c.command==='drive'&&sse&&!sse.destroyed){const head=c.gate<7?'3':'120';const value=f.batch([],head);sse.write(`id: ${value.next_after}\nevent: wi.conversation\ndata: ${JSON.stringify(value)}\n\n`);}
      if(c.command==='gate11_diagnostic'&&mode==='old-capture-failure')return {protocol:1,event:'gate11_diagnostic',id:++ids,state:'capture_failed',trace:null};
      if(c.command==='gate11_diagnostic')return {protocol:1,event:'gate11_diagnostic',id:++ids,state:'captured',trace:{admitted_ms:0,consumed_ms:0,snapshot_ms:1,expected_deltas:70,expected_frames:72,await_counts:[72,72,70,70,0,0],committed_counts:[0,70,0,70],count_changes:1,gate_ms:[1,1,1],history:[],truncated:false}};
      if(c.command==='gate11_latency'){
        if(mode==='unavailable')return {protocol:1,event:'gate11_latency',id:++ids,state:'unavailable',page:0,pages:0,rows:[]};
        const rows=structuredClone(latency);if(mode==='truncated')rows[0][6]=1;if(mode==='failed-window')rows[0][7]=1;
        if(metrics){for(const stage of [1,25,26,27])rows[stage+1]=[1,stage,70,0,0,0];rows.push([4,10000,10000,70,70]);}
        return {protocol:1,event:'gate11_latency',id:++ids,state:'captured',page:c.page,pages:2,rows:mode==='capture-failure'?[[99]]:rows.slice(c.page*24,c.page*24+24)};
      }
      return parseControl({protocol:1,id:++ids,event:c.command==='select'?'selected':'driven'});
    },
    wait:async(event,n)=>{seen.push(`${event}${n}`);if(mode.startsWith('timeout')&&n===11)throw new Error('fixture control timed out');if(event==='task_finished')done=true;return parseControl({protocol:1,event,[event==='model_paused'?'gate':'task']:n});},
    inspect:async()=>parseControl({protocol:1,event:'inspect',id:++ids,gate:null,requests:2,connections:1,auth_loads:1,auth_prepares:1,prepared_exact:2,fresh_parents:1,continuations:1,tool_results:3,completed:1,terminals:1,results:1,fresh_empty:true,restored_history:false,
      sequence_count:mode==='wrong-A'?'117':'118',accepted:receipts.map(r=>({run_id:r.run_id,accepted_sequence:r.first_sequence})),receipts,
      response_finishes:[{sequence:'10',provenance:'native_terminal'},{sequence:'100',provenance:'native_terminal'}],terminal_sequences:['117'],result_sequences:['118'],provider_stage:'request',provider_failed:false,read_failure:null}),
    diagnostics:()=>({state:'captured',drive_id:1,truncated:false,history:(mode.startsWith('timeout')
      ? ['drive_request','drive_ack','wait_start','wait_expired'] : ['drive_request','drive_ack','wait_start','gate_parse','gate_match']).map(s=>[0,s])}),
    stop:async()=>{seen.push('stop');if(sse&&!sse.destroyed)await new Promise(resolve=>sse.once('close',resolve));await rm(rootPath,{recursive:true});},
  };
  const server=createServer(async(req,res)=>{
    const authenticated=req.headers.authorization===`Bearer ${fixture.owner}`;
    if(!authenticated){res.writeHead(401);res.end();return;}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/v1/settings')return send({api_version:1,workspaces:['/synthetic/project'],provider_id:'openai-codex',model:'synthetic',provider_transport:'websocket',enable_add_numbers:true});
    if(req.url==='/v1/sessions'){
      let bytes='';for await(const part of req)bytes+=part;const c=JSON.parse(bytes);seen.push('create');
      assert.equal(c.title===data.title&&c.workspace==='/synthetic/project',true);
      return send({api_version:1,session_id:f.SID,receipt:{operation_id:c.operation_id,session_id:f.SID,run_id:null,first_sequence:'1',last_sequence:'1'},duplicate:false,warning_code:null},201);
    }
    if(req.url===`/v1/sessions/${f.SID}/conversation`){seen.push('latest');if(done)return send(completed(commands[0],receipts[0]));return send(f.page({snapshot_head:'1',session:f.session('1',{title:data.title}),block:null,entries:[],previous_block:null,live_after:f.cursor('l','1','3','','')}));}
    if(req.url===`/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l','1','3','',''))}`){
      seen.push('sse');sse=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': drained initial\n\n');return;
    }
    if(req.url===`/v1/sessions/${f.SID}/runs`){
      assert.ok(sse&&!sse.destroyed);let bytes='';for await(const part of req)bytes+=part;
      const c=JSON.parse(bytes);assert.equal(c.text===data.user,true);commands.push(c);seen.push(`post${commands.length}`);
      const first=commands.length===1?'2':mode==='wrong-B'?'118':'119';
      const receipt={operation_id:c.operation_id,session_id:f.SID,run_id:c.run_id,first_sequence:first,last_sequence:String(BigInt(first)+1n)};receipts.push(receipt);
      return send({api_version:1,receipt,duplicate:false,warning_code:null,notices:[]},202);
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));fixture.origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(rootPath,{recursive:true,force:true});});
  return {fixture,seen,commands};
}
for(const mode of ['boundary','timeout','wrong-A','wrong-B','capture-failure','unavailable','truncated','failed-window','timeout-cleanup','old-capture-failure'])test(`controlled HTTP plus fixture driver: ${mode}`,async t=>{
  const {fixture,seen,commands}=await peer(t,mode);
  const result=await runObservation(fixture,{processProbe:async()=>({status:'absent',code:'ENOENT'})});
  const facts=JSON.stringify({failure:result.failure,capture:result.capture,cleanup_valid:result.cleanup.valid,stream:result.cleanup.stream});
  assert.equal(result.valid,mode==='boundary',facts);assert.equal(result.cleanup.valid,mode!=='timeout-cleanup',facts);
  assert.equal(seen.indexOf('sse')<seen.indexOf('post1'),true);assert.equal(seen.filter(s=>s==='sse').length,1);
  assert.equal(seen.some(s=>['drive11','drive12'].includes(s)),false);assert.equal(seen.at(-1),'stop');
  if(mode.startsWith('timeout')){assert.deepEqual(result.failure,{phase:4,gate:10,category:'timeout'});assert.equal(seen.filter(s=>s==='model_paused11').length,1);assert.equal(result.endpoint,'failed');assert.equal(result.capture,'captured');}
  if(mode==='boundary'){assert.deepEqual(result.task_acceptances,[[2,3],[119,120]]);assert.equal(commands.length,2);assert.ok(result.cleanup.stream.frames>0);assert.equal(result.latency.length,31);}
  if(mode==='wrong-A'){assert.equal(commands.length,1);assert.deepEqual(result.failure,{phase:3,gate:6,category:'protocol'});}
  if(mode==='wrong-B')assert.deepEqual(result.failure,{phase:4,gate:0,category:'protocol'});
  if(mode==='capture-failure')assert.equal(result.capture,'rejected');
  if(mode==='unavailable')assert.equal(result.capture,'unavailable');
  if(mode==='old-capture-failure'){assert.equal(result.capture,'rejected');assert.equal(result.latency.length,31);assert.equal(result.diagnostic.native_state,'capture_failed');}
  if(['truncated','failed-window'].includes(mode)){assert.equal(result.capture,'captured');assert.equal(result.endpoint,'boundary');}
  assert.equal(JSON.stringify(result).includes(fixture.owner),false);
});

for(const mode of ['boundary','timeout','truncated','failed-window','capture-failure','wrong-A','wrong-B','timeout-cleanup'])test(`comparison qualification preserves original driver outcome: ${mode}`,async t=>{
  const {fixture,seen}=await peer(t,mode,true);
  const result=await runObservation(fixture,{processProbe:async()=>({status:'absent',code:'ENOENT'})});
  const evidence=qualifyComparison(result);
  assert.equal(evidence.admissible,['boundary','timeout','truncated'].includes(mode));
  if(evidence.admissible){
    assert.equal(evidence.aggregate_complete,true);assert.equal(evidence.rolling_detail_complete,mode!=='truncated');
    assert.equal(evidence.rows_fetched,10000);assert.equal(evidence.rows_typed_decoded,10000);assert.equal(evidence.successful_barriers,70);
    assert.equal(evidence.timeout_censored,mode==='timeout');assert.equal(evidence.c49_pass,false);
    assert.equal(evidence.historical_reproduction_claim,false);
    assert.equal(result.valid,mode==='boundary');
    const truncated=structuredClone(result);truncated.diagnostic.native.trace.truncated=true;
    assert.equal(qualifyComparison(truncated).rolling_detail_complete,false);
    for(const mutate of [v=>{v.latency.pop();},v=>{v.latency[1][1]=99;},v=>{v.latency[31][2]=10001;},
      v=>{v.latency[0][7]=1;},v=>{v.capture='unavailable';},v=>{v.diagnostic.native_state='capture_failed';},
      v=>{v.latency[31].push('private');},v=>{v.latency[31][3]=71;},v=>{v.cleanup.valid=false;}]){
      const invalid=structuredClone(result);mutate(invalid);assert.equal(qualifyComparison(invalid).admissible,false);
    }
    const partial=structuredClone(result);partial.latency[31][2]=9999;
    assert.equal(qualifyComparison(partial).admissible,false);
    partial.latency[27]=[1,26,70,0,0,1];
    const pending=qualifyComparison(partial);assert.equal(pending.admissible,true);assert.equal(pending.pending_reconstructions,1);
  }
  assert.equal(seen.at(-1),'stop');assert.equal(seen.includes('drive11'),false);
});

test('comparison rejects invalid mode before a fixture spawn',async()=>{
  for(const mode of [undefined,null,false,'full','baseline ','Baseline'])await assert.rejects(observeComparison('/must-not-execute',mode),{message:'Native latency rejected'});
});

test('native process cleanup probes distinguish absence, reuse and unknown states',async()=>{
  const root={pid:12345,start:'7'},missing=()=>{throw Object.assign(new Error('synthetic'),{code:'ENOENT'});};
  assert.deepEqual(await resolveNative(root,{read:missing,exists:missing}),{status:'absent',code:'ENOENT'});
  for(const code of ['ENOENT','ESRCH']){
    const race=()=>{throw Object.assign(new Error('synthetic'),{code});};
    assert.equal((await resolveNative(root,{read:race,exists:missing})).status,'absent');
    assert.equal((await resolveNative(root,{read:race,exists:async()=>({})})).status,'unknown');
    for(const probeCode of ['ESRCH','EACCES','EIO'])assert.equal((await resolveNative(root,{read:race,exists:()=>{throw Object.assign(new Error('synthetic'),{code:probeCode});}})).status,'unknown');
  }
  assert.equal((await resolveNative(root,{read:missing,exists:async()=>({})})).status,'unknown');
  for(const code of ['EACCES','EIO','ENOTDIR'])assert.equal((await resolveNative(root,{read:async()=>{throw Object.assign(new Error('synthetic'),{code});}})).status,'unknown');
  const stat=`12345 (space name) S 1 ${Array(17).fill('0').join(' ')} 8`;
  assert.equal((await resolveNative(root,{read:async()=>stat})).status,'reused');
  assert.equal((await resolveNative(root,{read:async()=>stat.replace(/8$/,'7')})).status,'present');
  assert.equal((await resolveNative(root,{read:async()=>'malformed'})).status,'unknown');
});
test('cleanup cannot erase original failure or accept fallback signals',()=>{
  const clean={stream:{closed:true,released:true,failed:false},root_absent:true,process:{status:'absent',code:'ENOENT'},fixture:stop};
  assert.equal(cleanupProof(clean),true);
  for(const key of ['closed','released'])assert.throws(()=>cleanupProof({...clean,stream:{...clean.stream,[key]:false}}));
  for(const status of ['present','unknown'])assert.throws(()=>cleanupProof({...clean,process:{status}}));
  for(const key of ['sigterm','sigkill','error_latched'])assert.throws(()=>cleanupProof({...clean,fixture:{...stop,stop:{...stop.stop,[key]:true}}}));
});
test('display drain rejects wrong media and cursor/session identity before Task submission',async()=>{
  const latest=f.page({snapshot_head:'1',live_after:f.cursor('l','1','3','','')});
  for(const type of ['application/json','text/plain'])await assert.rejects(drainDisplay({origin:'http://127.0.0.1:1',owner:'synthetic'},f.SID,latest,async()=>new Response('',{headers:{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})));
  await assert.rejects(drainDisplay({origin:'http://127.0.0.1:1',owner:'synthetic'},f.OTHER,latest,()=>{throw new Error('must not fetch');}));
});
test('continuous SSE drain rejects malformed DTO and preserves a closed/released failure',async()=>{
  const latest=f.page({snapshot_head:'1',live_after:f.cursor('l','1','3','','')});
  const bad=f.batch([],'2');bad.session_id=f.OTHER;
  const source=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`id: ${bad.next_after}\nevent: wi.conversation\ndata: ${JSON.stringify(bad)}\n\n`));}});
  const stream=await drainDisplay({origin:'http://127.0.0.1:1',owner:'synthetic'},f.SID,latest,async()=>new Response(source,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}));
  await assert.rejects(stream.guard(new Promise(()=>{})),{message:'Native latency display failed'});
  assert.equal(stream.facts().failed,true);await assert.rejects(stream.close());
});
test('actual native driver has no browser imports, direct storage seeding or later C49 actions',async()=>{
  const text=await readFile(new URL('../test-support/native-latency.mjs',import.meta.url),'utf8');
  assert.equal(/@playwright|skill-source-fidelity\.spec|ownedSkill|guard\.change|guard\.delete|newContext|CDP|discoverFixture|test\.skip/.test(text),false);
  assert.ok(text.includes('for (const task of [0,1])')&&text.includes('const last = task === 0 ? 6 : 10'));
  assert.ok(text.indexOf('stream = await drainDisplay')<text.indexOf('for (const task of [0,1])'));
  assert.ok(text.indexOf('await stream.close()')<text.indexOf('await fixture.stop()'));
});
