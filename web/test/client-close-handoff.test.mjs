import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import * as f from '../test-support/display-fixtures.mjs';
import { decodeJson, validateTaskCommand, validateUuid } from '../dist/api.js';
import { validateConversationPage } from '../dist/display-api.js';
import { expectedBlock, displayedBlock, freshHandshake } from '../test-support/rich-display-parity.mjs';
import { TITLE, TASKS, ANSWERS, ARGUMENTS, OUTPUTS, publicProof, acceptedTask, nativeBarrier, nativeState,
  unchangedNative, allowedRequest, handoffOrder, strictStop } from '../test-support/client-close-handoff.mjs';

const commands = [{ operation_id: f.OID, run_id: f.RID, text: TASKS[0] }, { operation_id: f.OTHER, run_id: f.OTHER, text: TASKS[1] }];
const receipts = commands.map((c, i) => ({ operation_id: c.operation_id, session_id: f.SID, run_id: c.run_id, first_sequence: String(i * 30 + 2), last_sequence: String(i * 30 + 3) }));
const accepted = task => ({ api_version: 1, receipt: receipts[task], duplicate: false, warning_code: null, notices: [] });
function field(kind, text, sequence, index) {
  return f.field({ field_id: String(index + 1).repeat(64), order_key: f.order(kind === 'function_name' ? 4 : kind === 'function_arguments' ? 5 : kind === 'tool_name' ? 7 : kind === 'tool_result' ? 8 : 2),
    kind, text, generation: String(sequence), total_bytes: String(Buffer.byteLength(text)), to_byte: String(Buffer.byteLength(text)) });
}
function page(task = 0, completed = true) {
  const receipt = receipts[task], base = task * 30, head = String(base + (completed ? 30 : 6));
  const human = f.human({ run_id: commands[task].run_id, entry_id: `e:${receipt.first_sequence}:0`, position: { sequence: receipt.first_sequence, slot: '0' },
    revision: receipt.first_sequence, content_epoch: receipt.first_sequence, fields: [f.field({ field_id: 'text', order_key: '0', generation: receipt.first_sequence,
      text: TASKS[task], total_bytes: String(Buffer.byteLength(TASKS[task])), to_byte: String(Buffer.byteLength(TASKS[task])) })] });
  const specs = [ ['assistant', [['function_name','add_numbers'], ['function_arguments',ARGUMENTS[task]]]],
    ['tool', [['tool_name','add_numbers'],['tool_result',OUTPUTS[task]]]], ['assistant', [['text',ANSWERS[task]]]] ];
  const entries = completed ? specs.map(([kind, fields], i) => {
    const sequence = base + 8 + i * 6;
    return f.entry({ run_id: commands[task].run_id, entry_id: `e:${sequence}:0`, position: { sequence: String(sequence), slot: '0' },
      revision: String(sequence), content_epoch: String(sequence), kind, recorded_state: 'completed', provisional: false,
      result_recorded: kind === 'tool' ? true : null, finish_recorded: kind === 'tool' ? true : null, is_error: kind === 'tool' ? false : null,
      fields: fields.map(([fieldKind, text], index) => field(fieldKind, text, sequence, index)) });
  }) : [];
  const summary = { turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',new_tool_dispatches:'1',tool_results_prepared:'1',reused_results:'0',last_request_id:f.OID,last_upstream_outcome:'terminal_received' };
  return f.page({ snapshot_head: head, session: f.session(head,{ title: TITLE }), block: f.block({ run_id: commands[task].run_id,
    accepted_sequence: receipt.first_sequence, revision: head, human, state: completed ? 'completed' : 'running', result_recorded: completed,
    outcome: completed ? {type:'completed'} : null, summary: completed ? summary : null, events_complete: completed ? true : null }), entries,
    previous_block: task === 0 ? null : f.cursor('b',receipt.first_sequence), live_after: f.cursor('l',head,'3','','') });
}
const options = (task = 0, completed = true) => ({ sid: f.SID, head: String(task * 30 + (completed ? 30 : 6)), command: commands[task], receipt: receipts[task], task, completed, workspace:'/synthetic/project' });
for (const [task,completed] of [[0,false],[0,true],[1,true]]) test(`closed public proof constrains nonempty joined block ${task}/${completed}`, () => {
  assert.equal(isDeepStrictEqual(publicProof(page(task,completed),options(task,completed)),page(task,completed)),true);
});
const changes = {
  empty:p=>{p.block=null;p.entries=[];}, human:p=>{p.block.human.fields=[];}, 'human bytes':p=>{p.block.human.fields[0].text+=' ';},
  run:p=>{p.block.run_id=f.OTHER;}, identity:p=>{p.entries[0].entry_id='e:9:0';}, 'human identity':p=>{p.block.human.entry_id='e:3:0';},
  session:p=>{p.session_id=f.OTHER;}, 'nested session':p=>{p.session.session_id=f.OTHER;}, head:p=>{p.snapshot_head='31';p.session.head_sequence='31';},
  live:p=>{p.live_after=f.cursor('l','31','3','','');}, rank:p=>{p.live_after=f.cursor('l','30','0','','');}, title:p=>{p.session.title+=' ';},
  workspace:p=>{p.session.workspace='/wrong';}, state:p=>{p.block.state='running';}, result:p=>{p.block.result_recorded=false;},
  outcome:p=>{p.block.outcome=null;}, summary:p=>{p.block.summary.model_requests_admitted='1';}, 'summary absent':p=>{p.block.summary=null;},
  'request absent':p=>{p.block.summary.last_request_id=null;}, upstream:p=>{p.block.summary.last_upstream_outcome='unknown';},
  'events incomplete':p=>{p.block.events_complete=false;}, revision:p=>{p.block.revision='29';}, privacy:p=>{p.block.private='synthetic';},
  'entry order':p=>{p.entries.reverse();}, 'entry missing':p=>{p.entries.pop();}, 'extra answer':p=>{p.entries.push(structuredClone(p.entries[2]));},
  kind:p=>{p.entries[0].kind='notice';}, provisional:p=>{p.entries[0].provisional=true;}, recorded:p=>{p.entries[0].recorded_state='unknown';},
  reference:p=>{p.entries[1].reference={run_id:f.RID,entry_id:'e:8:0'};}, tool:p=>{p.entries[1].is_error=true;},
  finish:p=>{p.entries[1].finish_recorded=false;}, 'tool result absent':p=>{p.entries[1].result_recorded=false;},
  arguments:p=>{p.entries[0].fields[1].text='{"a":17,"b":25}';}, output:p=>{p.entries[1].fields[1].text+=' ';}, answer:p=>{p.entries[2].fields[0].text=ANSWERS[0].split('\r')[0];},
  'field order':p=>{p.entries[0].fields.reverse();}, 'field identity':p=>{p.entries[0].fields[0].field_id='unknown';},
  bytes:p=>{p.entries[1].fields[1].total_bytes='1';}, range:p=>{p.entries[1].fields[1].from_byte='1';},
  content:p=>{p.entries[1].content_complete=false;}, 'earlier block':p=>{p.previous_block=f.cursor('b','2');},
};
for (const [name,change] of Object.entries(changes)) test(`independent completed oracle rejects ${name}`, () => {
  const value=page();change(value);assert.throws(()=>publicProof(value,options()));
});
for (const [name,change] of Object.entries({ state:p=>{p.block.state='accepted';}, result:p=>{p.block.result_recorded=true;}, activity:p=>{p.entries=page().entries;}, outcome:p=>{p.block.outcome={type:'completed'};} })) test(`running gate rejects ${name}`,()=>{const p=page(0,false);change(p);assert.throws(()=>publicProof(p,options(0,false)));});
for(const [name,change] of Object.entries({ missing:p=>{p.previous_block=null;}, wrong:p=>{p.previous_block=f.cursor('b','2');} }))test(`second block cursor rejects ${name}`,()=>{const p=page(1);change(p);assert.throws(()=>publicProof(p,options(1)));});
for(const [name,change] of Object.entries({ duplicate:p=>{p.duplicate=true;}, wrong:p=>{p.receipt={...p.receipt,operation_id:f.OTHER};}, missing:p=>{delete p.receipt;}, private:p=>{p.private='synthetic';}, warning:p=>{p.warning_code='storage.cleanup_warning';} }))test(`closed Task receipt rejects ${name}`,()=>{const p=accepted(0);change(p);assert.throws(()=>acceptedTask(p,commands[0],f.SID,0));});
test('closed Task receipts retain exact identities and task bytes',()=>{for(const task of [0,1])assert.deepEqual(acceptedTask(accepted(task),commands[task],f.SID,task),receipts[task]);assert.throws(()=>acceptedTask(accepted(0),{...commands[0],text:TASKS[0]+' '},f.SID,0));});

function native(tasks=2,gate=null,completed=tasks) {
  const requests=gate??tasks*2,tools=gate===null?tasks:Math.floor(gate/2);
  return { protocol:1,event:'inspect',id:1,gate,requests,connections:tasks,auth_loads:tasks,auth_prepares:tasks,prepared_exact:requests,
    fresh_parents:tasks,continuations:tools,tool_results:tools,completed,terminals:completed,results:completed,fresh_empty:true,restored_history:tasks===2,
    sequence_count:String(tasks*30),accepted:receipts.slice(0,tasks).map(r=>({run_id:r.run_id,accepted_sequence:r.first_sequence})),receipts:receipts.slice(0,tasks),
    response_finishes:Array.from({length:gate===null?tasks*2:gate-1},(_,i)=>({sequence:String(Math.floor(i/2)*30+10+(i%2)*10),provenance:'native_terminal'})),
    terminal_sequences:Array.from({length:completed},(_,i)=>String(i*30+29)),result_sequences:Array.from({length:completed},(_,i)=>String(i*30+30)),
    provider_stage:tasks===2&&gate===null?'finished':'request',provider_failed:false,read_failure:null };
}
for(const [tasks,gate,completed] of [[1,1,0],[1,2,0],[1,null,1],[2,3,1],[2,4,1],[2,null,2]])test(`actual protocol native barrier ${tasks}/${gate}/${completed}`,()=>{assert.deepEqual(nativeBarrier(native(tasks,gate,completed),commands.slice(0,tasks),receipts.slice(0,tasks),gate,completed),nativeState(native(tasks,gate,completed)));});
const nativeChanges = { ...Object.fromEntries(['requests','connections','auth_loads','auth_prepares','prepared_exact','fresh_parents','continuations','tool_results','completed','terminals','results'].map(k=>[k,p=>{p[k]--;} ])),
  provenance:p=>{p.response_finishes[0].provenance='validated_output_item_done';}, order:p=>{p.terminal_sequences[0]='19';}, head:p=>{p.sequence_count='61';},
  'fresh history':p=>{p.fresh_empty=false;}, restoration:p=>{p.restored_history=false;}, failure:p=>{p.provider_failed=true;}, read:p=>{p.read_failure='query_busy';},
  stage:p=>{p.provider_stage='reply';}, receipts:p=>{p.receipts.reverse();}, 'accepted identity':p=>{p.accepted[0].run_id=f.OTHER;}, private:p=>{p.private='synthetic';} };
for(const [name,change] of Object.entries(nativeChanges))test(`native fidelity rejects ${name}`,()=>{const p=native();change(p);assert.throws(()=>nativeBarrier(p,commands,receipts,null,2));});
test('client closure and reads exclude only native control reply id',()=>{const held=nativeState(native(1,1,0)),changed=native(1,1,0);changed.id=2;assert.equal(unchangedNative(changed,held),true);for(const key of Object.keys(held).filter(k=>typeof held[k]==='number')){const p=native(1,1,0);p[key]++;assert.throws(()=>unchangedNative(p,held));}});

const events=['send-a','gate1-ready','a-closed','b-connected','b-running','drive1','tool1-ready','drive2','b-completed1','send-b','gate3-ready','drive3','tool2-ready','drive4','b-completed2','a-reopened','a-connected','final-parity'];
for(const [name,change] of Object.entries({ valid:()=>{}, 'no closure':p=>{p.events.splice(2,1);}, 'late closure':p=>{[p.events[2],p.events[5]]=[p.events[5],p.events[2]];}, 'early send':p=>{[p.events[8],p.events[9]]=[p.events[9],p.events[8]];}, 'third task':p=>{p.commands.push(commands[1]);}, 'missing receipt':p=>{p.receipts.pop();}, 'shared context':p=>{p.contexts[2]=p.contexts[0];}, 'not reopened':p=>{p.events.splice(15,1);} }))test(`lifecycle order rejects ${name}`,()=>{const p={events:[...events],contexts:[{},{},{}],commands:[...commands],receipts:[...receipts]};change(p);if(name==='valid')assert.equal(handoffOrder(p.events,p.contexts,p.commands,p.receipts),true);else assert.throws(()=>handoffOrder(p.events,p.contexts,p.commands,p.receipts));});
const stop={failure:null,stop:{attempted:true,clean_acknowledgment:true,reap_complete:true,sandbox_removed:true,exit_observed:true,exit_zero:true,error_latched:false,stderr_empty:true,sigterm:false,sigkill:false}};
test('strict owned Stop accepts only fully reaped clean native acknowledgment',()=>assert.equal(strictStop(stop),true));
for(const key of Object.keys(stop.stop))test(`strict Stop rejects ${key}`,()=>{const p=structuredClone(stop);p.stop[key]=!p.stop[key];assert.throws(()=>strictStop(p));});

function handshake(){const origin='http://127.0.0.1:1234',url=`${origin}/v1/sessions/${f.SID}/conversation`,value=page(1);const request={method:()=> 'GET',url:()=>url};const reply={request:()=>request,url:()=>url,status:()=>200};for(const key of ['body','text','json'])Object.defineProperty(reply,key,{get(){assert.fail('No SDK body consumption claim');}});return {origin,sid:f.SID,head:'60',value,reply,snapshots:[{request,index:0,response:reply}],streams:[{request:{method:()=> 'GET',url:()=>`${url}/events?after=${encodeURIComponent(value.live_after)}`},index:1,response:reply}]};}
for(const [name,change] of Object.entries({ valid:()=>{}, request:h=>{h.reply={...h.reply,request:()=>({...h.snapshots[0].request})};}, response:h=>{h.streams[0].response={...h.reply};}, order:h=>{h.streams[0].index=0;}, missing:h=>{h.streams=[];}, head:h=>{h.head='61';}, session:h=>{h.sid=f.OTHER;}, cursor:h=>{h.value.live_after=f.cursor('l','61','3','','');}, duplicate:h=>{h.snapshots.push(h.snapshots[0]);} }))test(`original fresh handshake ${name}`,()=>{const h=handshake();change(h);if(name==='valid')assert.equal(freshHandshake(h),true);else assert.throws(()=>freshHandshake(h));});
for(const permission of [null,'create','first','second'])for(const path of ['/v1/sessions',`/v1/sessions/${f.SID}/runs`,`/v1/sessions/${f.SID}/runs/reconcile`,`/v1/sessions/${f.SID}/runs/${f.RID}/cancel`])test(`request permission ${permission}/${path}`,()=>assert.equal(allowedRequest('POST',new URL(path,'http://127.0.0.1:1234'),f.SID,permission),permission==='create'&&path==='/v1/sessions'||['first','second'].includes(permission)&&path.endsWith('/runs')));
for(const path of [`/v1/sessions/${f.SID}/history`,`/v1/sessions/${f.SID}/events`,`/v1/sessions/${f.SID}/conversation/events?after=wrong`,`/v1/sessions/${f.SID}/conversation?before=${f.cursor('b','32')}&extra=1`])test(`request rejects raw/wrong cursor ${path}`,()=>{assert.throws(()=>{if(!allowedRequest('GET',new URL(path,'http://127.0.0.1:1234'),f.SID,null))throw Error('rejected');});});

function domNode(value) {
  const leaf = textContent => ({ textContent });
  return { dataset: { run: value.run_id }, querySelector: selector => leaf(selector === ':scope > .metadata' ? value.status : value.recording),
    querySelectorAll: () => value.entries.map(entry => ({ dataset: { entry: entry.entry_id }, querySelector: selector => leaf(selector === 'h4' ? entry.kind : entry.state),
      querySelectorAll: selector => selector === ':scope > .metadata' ? [leaf(entry.state),leaf(entry.content)] : entry.fields.map(field => ({ dataset: { field: field.field_id },
        querySelector: selector => leaf(selector === 'h5,summary' ? field.kind : field.metadata), querySelectorAll: () => field.ranges.map(range => ({ dataset: { range: range.range },textContent:range.text })) })) })) };
}
for(const [name,change]of Object.entries({ valid:()=>{}, run:v=>{v.run_id=f.OTHER;}, identity:v=>{v.entries[1].entry_id='e:9:0';}, 'field ID':v=>{v.entries[1].fields[0].field_id='c'.repeat(64);}, metadata:v=>{v.entries[2].fields[1].metadata+=' ';}, order:v=>{v.entries.reverse();}, bytes:v=>{v.entries[3].fields[0].ranges[0].text+=' ';}, result:v=>{v.status='Execution: running. Final result not recorded.';} }))test(`unchanged generic DOM helper detects ${name}`,async()=>{const expected=expectedBlock(publicProof(page(),options())),current=structuredClone(expected);change(current);const actual=await displayedBlock({evaluate:fn=>fn(domNode(current))});assert.equal(isDeepStrictEqual(actual,expected),name==='valid');});

const sourceText=readFileSync(new URL('../e2e/client-close-handoff.spec.mjs',import.meta.url),'utf8');
function parse(text){return ts.createSourceFile('handoff.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);}
function sourceGuard(text){
 const source=parse(text),calls=[];function visit(n){if(ts.isCallExpression(n))calls.push(n);ts.forEachChild(n,visit);}visit(source);
 const named=name=>calls.filter(c=>c.expression.getText(source)===name),one=name=>{assert.equal(named(name).length,1);return named(name)[0];};
 one('test');const start=one('startFixture');assert.equal(start.arguments[1].getText(source),"{ transport: 'websocket', recovered: false, mime: true }");
 assert.equal(named('browser.newContext').length,3);assert.equal(named('publicProof').length,5);assert.equal(named('freshHandshake').length,2);
 assert.equal(named('toolReady').length,2);assert.equal(named('freshMemory').length,2);one('handoffOrder');one('strictStop');one('fixture.stop');
 const push=n=>named('events.push').find(c=>c.arguments[0].text===n);for(const event of events)assert.ok(push(event));
 assert.deepEqual(named('events.push').map(c=>c.arguments[0].text),events);
 const before=(a,b)=>assert.ok(a.pos<b.pos);
 const close=named('contextA.close');assert.equal(close.length,2);assert.ok(ts.isAwaitExpression(close[0].parent));
 const drives=named('fixture.request').filter(c=>c.arguments[0]?.getText(source).includes("command: 'drive'"));assert.equal(drives.length,4);
 for(const [i,c]of drives.entries()){assert.ok(ts.isAwaitExpression(c.parent));assert.equal(c.arguments[0].getText(source),`{ command: 'drive', gate: ${i+1} }`);}
 before(push('gate1-ready'),close[0]);before(close[0],named('browser.newContext')[1]);before(close[0],drives[0]);
 const fills=calls.filter(c=>c.expression.getText(source).endsWith('.fill')&&c.arguments[0]?.getText(source)==='TASKS[1]');assert.equal(fills.length,1);before(fills[0],push('send-b'));
 const ready=named('ready');assert.equal(ready.length,5);assert.ok(ts.isAwaitExpression(ready[2].parent));assert.equal(ready[2].arguments.map(a=>a.getText(source)).join(','),'b,firstProof,0');
 const sends=calls.filter(c=>c.expression.getText(source)==="button(a, 'Send').click"||c.expression.getText(source)==="button(b, 'Send').click");assert.equal(sends.length,2);before(ready[2],sends[1]);before(push('b-completed1'),push('send-b'));before(push('b-completed2'),named('browser.newContext')[2]);
 const stopCall=one('fixture.stop');assert.ok(ts.isAwaitExpression(stopCall.parent));before(stopCall,one('strictStop'));
 assert.equal(named('test.setTimeout').length,0);
 for(const c of calls){const expr=c.expression.getText(source);assert.equal(/(?:fulfill|newCDPSession|setDefaultTimeout|setDefaultNavigationTimeout)$|^test\.(?:skip|only|fixme)$|^(?:eval|Function)$/.test(expr),false);}
 assert.equal(/(?:bReply|aReply)\.(?:body|text|json)\s*\(/.test(text),false);
 const imports=source.statements.filter(ts.isImportDeclaration);const rich=imports.find(n=>n.moduleSpecifier.text==='../test-support/rich-display-parity.mjs');assert.ok(rich);assert.deepEqual(rich.importClause.namedBindings.elements.map(e=>e.name.text),['expectedBlock','displayedBlock','normalizedDom','freshHandshake','readOnly']);
 return true;
}
test('actual scenario AST retains closure, completed DOM before later Send, three contexts and strict Stop',()=>assert.equal(sourceGuard(sourceText),true));
const sourceChanges={ fixture:s=>s.replace('mime: true }','mime: true, presentation: true }'), context:s=>s.replace('reopenedA = await browser.newContext','reopenedA = await browser.newPage'), closure:s=>s.replace('await contextA.close(); cleanup.a = true;','contextA.close(); cleanup.a = true;'), gate:s=>s.replace("{ command: 'drive', gate: 1 }","{ command: 'drive', gate: 2 }"),
  'early continuation':s=>s.replace("stage = 'close-a'; await contextA.close(); cleanup.a = true; events.push('a-closed');","stage = 'close-a'; cleanup.a = true; events.push('a-closed');").replace("events.push('drive1');", "await contextA.close(); events.push('drive1');"),
  readiness:s=>s.replace('await ready(b, firstProof, 0);','ready(b, firstProof, 0);'), 'missing readiness':s=>s.replace('await ready(b, firstProof, 0);',''), 'second Send':s=>s.replace("button(b, 'Send').click()","button(b, 'Cancel').click()"), stop:s=>s.replace('await fixture.stop();','fixture.stop();'), 'strict Stop':s=>s.replace('strictStop(evidence)','Boolean(evidence)'), timeout:s=>s.replace("stage = 'create';","test.setTimeout(180_000); stage = 'create';"), substitution:s=>s.replace('await route.continue()','await route.fulfill({})'), skip:s=>s.replace("test('submitter", "test.only('submitter"), 'SDK body':s=>s.replace("check = 'handshake'; expect(freshHandshake", "await aReply.body(); check = 'handshake'; expect(freshHandshake") };
for(const [name,change]of Object.entries(sourceChanges))test(`actual source guard rejects ${name}`,()=>{const changed=change(sourceText);assert.notEqual(changed,sourceText);assert.throws(()=>sourceGuard(changed));});
const source=parse(sourceText),helper=name=>source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name).getText(source);
function nestedHelper(name) { let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name.text===name)found=n;ts.forEachChild(n,visit);}visit(source);assert.ok(found);return found.getText(source); }
for(const variant of ['read','explicit-second','before-send','cancel','third-task','wrong-task','cookie','wrong-origin','wrong-auth','raw-history','collector'])test(`actual observer callback enforces ${variant}`,async()=>{
 const listeners={},record={requests:[],snapshots:[],streams:[],assets:new Set(),permission:variant==='explicit-second'?'second':null};
 const faults={external:0,request:0,response:0,console:0,page:0,private:0,collector:0},currentCommands=variant==='third-task'?[...commands]:[commands[0]];
 const context={route:async()=>{},on:(name,fn)=>{listeners[name]=fn;},newPage:async()=>({on:()=>{}})};
 const origin='http://127.0.0.1:1234';
 // The classic VM needs the module URL supplied explicitly; callback logic stays unchanged.
 const observerSource = nestedHelper('observer'); assert.equal(observerSource.split('import.meta.url').length, 2);
 await runInNewContext(`${observerSource.replace('import.meta.url','moduleUrl')};observer(context,1)`,{context,fixture:{origin,owner:'synthetic-owner'},records:[{},record],faults,files:new Map(),sid:f.SID,workspace:'/synthetic/project',leaked:()=>false,allowedRequest,validateTaskCommand,validateUuid,TITLE,TASKS,commands:currentCommands,URL,moduleUrl:new URL('../e2e/client-close-handoff.spec.mjs',import.meta.url).href});
 let method='GET',path=`/v1/sessions/${f.SID}/conversation`;
 if(['explicit-second','before-send','third-task','wrong-task'].includes(variant)){method='POST';path=`/v1/sessions/${f.SID}/runs`;}
 if(variant==='cancel'){method='POST';path=`/v1/sessions/${f.SID}/runs/${f.RID}/cancel`;}
 if(variant==='raw-history')path=`/v1/sessions/${f.SID}/history`;
 const headers={authorization:variant==='wrong-auth'?'Bearer wrong':'Bearer synthetic-owner'};if(variant==='cookie')headers.cookie='synthetic';if(variant==='wrong-origin')headers.origin='http://127.0.0.1:9999';
 listeners.request({url:()=>origin+path,method:()=>method,headers:()=>headers,postDataJSON:()=>variant==='collector'?null:{...commands[1],text:variant==='wrong-task'?'wrong':TASKS[1]}});
 if(variant==='collector')listeners.request({url:()=>{throw Error('synthetic');}});
 assert.equal(Object.values(faults).every(v=>v===0),['read','explicit-second'].includes(variant));
 if(variant==='explicit-second')assert.deepEqual(currentCommands,commands);
});
for(const variant of ['valid','bad-status','bad-media','bad-dto','bad-utf8','too-large','body-rejected'])test(`actual typed HTTP callback retains strict read ${variant}`,async()=>{
 let calls=0,reads=0;const p=page();if(variant==='bad-dto')p.private='synthetic';let bytes=Buffer.from(JSON.stringify(p));if(variant==='bad-utf8')bytes=Buffer.from([255]);if(variant==='too-large')bytes=Buffer.alloc(512*1024+1);
 const fetch=async(url,init)=>{calls++;assert.equal(url,`http://127.0.0.1:1234/v1/sessions/${f.SID}/conversation`);assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer synthetic-owner');return {status:variant==='bad-status'?503:200,headers:new Headers({'Cache-Control':'no-store','Content-Type':variant==='bad-media'?'text/plain':'application/json'}),arrayBuffer:async()=>{reads++;if(variant==='body-rejected')throw Error('synthetic rejection');return bytes;}};};
 const promise=runInNewContext(`${helper('latestProof')};latestProof(fixture,sid)`,{fetch,fixture:{origin:'http://127.0.0.1:1234',owner:'synthetic-owner'},sid:f.SID,TextDecoder,AbortSignal,decodeJson,validateConversationPage,expect:value=>({toBe:expected=>assert.equal(value,expected)})});
 if(variant==='valid')assert.deepEqual(await promise,p);else await assert.rejects(promise);assert.equal(calls,1);assert.equal(reads,variant==='bad-status'?0:1);
});
test('joined constants stay bound to actual native default producer, not presentation fixture',()=>{
 const nativeSource=readFileSync(new URL('../../src/providers/openai_codex/tests/replay/http_api_joined/browser.rs',import.meta.url),'utf8');
 for(const [name,values]of Object.entries({TASKS,ANSWERS,ARGUMENTS,OUTPUTS})){const block=nativeSource.match(new RegExp(`const ${name}: \\[&str; 2\\] = ([\\s\\S]*?);`))[1];const strings=[...block.matchAll(/"(?:\\.|[^"\\])*"/g)].map(m=>JSON.parse(m[0]));assert.deepEqual(values,strings);}
 assert.ok(nativeSource.includes('tool.output() == text'));assert.ok(nativeSource.includes('tool.is_error() == is_error'));assert.ok(nativeSource.includes('assert_request(&body, &context, None, prepared)'));
});
