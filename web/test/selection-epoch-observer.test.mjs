import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { installSelectionEpochObserver } from '../test-support/selection-epoch.mjs';
import { createClient } from '../dist/client.js';
import { json, event, page as historyPage, stream, tick, token } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';

const a = wire.sid; const b = wire.otherSid;
const id = n => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const titles = ['synthetic A','synthetic B']; const task = 'synthetic task 雪'; const draft = 'B local draft';
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${a}/runs`;
const command = {kind:'task',id:id(3),session_id:a,body:{operation_id:id(3),run_id:id(4),text:task}};
const receipt = {operation_id:id(3),session_id:a,run_id:id(4),first_sequence:'2',last_sequence:'3'};
const accepted = {api_version:1,receipt,duplicate:false,warning_code:null,notices:[]};
const state = {connection:'connected',settings:{},catalog:{},pending:[],recoveries:[],draft:'',last_mutation:null,error:null,selected:null};
const pending = {command,phase:'sending',receipt:null,reply:null,canonical_seen:false,canonical_sequence:null};
const final = {kind:'task',id:id(3),session_id:a,receipt,reply:accepted,notices:[],canonical_read_error:null};
const selected = slot => ({session_id:[a,b][slot],manifest:{head_sequence:'1'},title:titles[slot],workspace:`/w${slot}`,
  applied_cursor:`${[a,b][slot]}:1`,through_sequence:'1',history_complete:true,display:[],observation:'streaming',
  observation_error:null,closed_reason:null,run_view:null,cancel:null,cancelling:false});
const plain = value => JSON.parse(JSON.stringify(value));
const init = (method = 'POST',body = command.body) => ({method,body:method === 'POST' ? JSON.stringify(body) : undefined,
  mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:new AbortController().signal});
function observer(fetch, timeout = setTimeout) {
  const sandbox = {fetch,URL,Request,Headers,setTimeout:timeout,clearTimeout,location:{href:`${origin}/`,origin}};
  runInNewContext(`(${installSelectionEpochObserver.toString()})(${JSON.stringify({titles,task,draft,owner:token})});
    globalThis.publish = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) publish(child); Object.freeze(value); } };`,sandbox,{timeout:1000});
  return sandbox;
}
function seed(p) {
  for (let slot=0; slot<2; slot++) {
    const c = {kind:'create',id:id(slot+1),session_id:null,body:{operation_id:id(slot+1),title:titles[slot],workspace:`/w${slot}`}};
    p.publish({...state,pending:[{command:c}]});
    p.publish({...state,last_mutation:{kind:'create',id:c.id,session_id:[a,b][slot],receipt:{operation_id:c.id,
      session_id:[a,b][slot],run_id:null,first_sequence:'1',last_sequence:'1'}}});
  }
  p.publish({...state,pending:[pending],selected:selected(0)});
}
function canonical(p) { p.publish({...state,recoveries:[{...pending,phase:'accepted',canonical_seen:true,canonical_sequence:'2'}],selected:selected(0)}); }
async function switchB(p) {
  const options = init('GET'); await p.fetch(`/v1/sessions/${a}/events?after=${a}%3A1`,options);
  options.signal.dispatchEvent(new Event('abort'));
  p.publish({...state,recoveries:[{...pending,phase:'accepted',canonical_seen:true,canonical_sequence:'2'}],selected:selected(1)});
}

// Assertions only compare identities internally. The observer's output contains no wire data.
test('selection observer returns the same unconsumed native Response with exact original args only after release', async () => {
  const original = json(accepted,202); let calls=0; let args;
  original.clone = () => { throw new Error('clone forbidden'); };
  const p = observer(async (...values) => { calls++; args=values; return original; }); seed(p);
  const options=init(); let resolved=false;
  const promise=p.fetch(path,options).then(value => {resolved=true; return value;});
  assert.equal(await p.selectionEpochCapture.wait(),true); await tick();
  assert.equal(args[0],path); assert.equal(args[1],options); assert.equal(calls,1);
  assert.equal(original.bodyUsed,false); assert.equal(resolved,false);
  canonical(p); await switchB(p);
  assert.equal(p.selectionEpochCapture.release(),true);
  assert.equal(await promise,original); assert.equal(original.bodyUsed,false);
  assert.equal(await original.text(),JSON.stringify(accepted));
  p.publish({...state,last_mutation:final,selected:selected(1),draft});
  assert.equal(await p.selectionEpochCapture.drain(),true);
  const proof=p.selectionEpochCapture.summary();
  assert.equal(proof.accepted && proof.canonical && proof.bReady && proof.bDraft && proof.aAborted && !proof.taskAborted,true);
  assert.deepEqual(plain(proof.failures),[]);
  p.publish({...state,connection:'disconnected',settings:null,catalog:null});
  assert.equal(p.selectionEpochCapture.cleared(),true);
});

test('selection observer delegates unrelated requests unchanged and holds exactly one task including duplicate/extra attempts', async () => {
  let calls=0; const replies=[];
  const p=observer(async () => {calls++; const r=json(accepted,202); replies.push(r); return r;}); seed(p);
  for (const url of ['/v1/settings',`/v1/sessions/${a}`,`/v1/sessions/${b}/history?after=${b}%3A0&limit=32`]) {
    const value=await p.fetch(url,init('GET')); assert.equal(value,replies.at(-1)); assert.equal(value.bodyUsed,false);
  }
  const first=p.fetch(path,init()); await p.selectionEpochCapture.wait();
  for (const url of [path,`/v1/sessions/${b}/runs`,`${path}?extra=1`]) {
    const value=await p.fetch(url,init()); assert.equal(value,replies.at(-1)); assert.equal(value.bodyUsed,false);
  }
  p.selectionEpochCapture.teardown(); assert.equal(await first,replies[3]); assert.equal(calls,7);
  assert.equal(p.selectionEpochCapture.summary().counts.holds,1);
  assert.deepEqual(plain(p.selectionEpochCapture.summary().failures),['request:extra-task','request:task']);
});

test('selection observer rejects early and repeated release without resolving the held task early', async () => {
  const p=observer(async () => json(accepted,202)); seed(p);
  assert.equal(p.selectionEpochCapture.release(),false);
  let done=false; const reply=p.fetch(path,init()).then(() => {done=true;}); await p.selectionEpochCapture.wait();
  assert.equal(p.selectionEpochCapture.release(),false); await tick(); assert.equal(done,false);
  canonical(p); await switchB(p); assert.equal(p.selectionEpochCapture.release(),true); await reply;
  assert.equal(p.selectionEpochCapture.release(),false);
  assert.deepEqual(plain(p.selectionEpochCapture.summary().failures),['hold:order']); p.selectionEpochCapture.teardown();
});

test('selection observer has finite timeout and teardown releases even when native fetch resolves after teardown', async () => {
  const timers=[];
  const p=observer(async () => json(accepted,202),(callback,ms) => { if (ms === 10_000) {timers.push(callback); return 0;} return setTimeout(callback,ms); }); seed(p);
  const reply=p.fetch(path,init()); await p.selectionEpochCapture.wait(); timers[0]();
  assert.equal((await reply).bodyUsed,false);
  assert.deepEqual(plain(p.selectionEpochCapture.summary().failures),['hold:timeout']); p.selectionEpochCapture.teardown();
  let resolve; const late=observer(() => new Promise(r => {resolve=r;})); seed(late);
  const original=json(accepted,202); const wait=late.fetch(path,init()); late.selectionEpochCapture.teardown(); resolve(original);
  assert.equal(await wait,original); assert.equal(original.bodyUsed,false);
  assert.equal(late.selectionEpochCapture.summary().counts.holds,0);
});

test('selection observer rejects changed immutable command identity and misassociated receipts without private diagnostics', async () => {
  for (const change of [{session_id:b},{id:id(8)},{body:{...command.body,text:'private-canary'}},{body:{...command.body,run_id:id(9)}}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    p.publish({...state,pending:[{...pending,command:{...command,...change}}]});
    assert.ok(p.selectionEpochCapture.summary().failures.includes('state:command'));
    assert.equal(JSON.stringify(p.selectionEpochCapture.summary()).includes('private-canary'),false); p.selectionEpochCapture.teardown();
  }
  for (const change of [{session_id:b},{operation_id:id(9)},{run_id:id(9)},{first_sequence:'3'}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    p.publish({...state,pending:[{...pending,receipt:{...receipt,...change}}]});
    assert.ok(p.selectionEpochCapture.summary().failures.includes('state:receipt')); p.selectionEpochCapture.teardown();
  }
});

test('selection observer rejects stale A snapshots and every B field contamination after switching', async () => {
  for (const [change,category] of [
    [{selected:selected(0)},'state:epoch'], [{draft:task},'state:draft'],
    ...[{title:titles[0]},{display:[{}]},{applied_cursor:`${a}:7`},{through_sequence:'7'},{run_view:{}},
      {cancel:{}},{cancelling:true},{observation_error:{category:'network'}},{closed_reason:'shutdown'},
      {workspace:'/w0'},{manifest:{head_sequence:'7'}}].map(change => [{selected:{...selected(1),...change}},'state:b']),
  ]) {
    const p=observer(async () => json(accepted,202)); seed(p); canonical(p); await switchB(p);
    p.publish({...state,selected:selected(1),...change});
    assert.ok(p.selectionEpochCapture.summary().failures.includes(category)); p.selectionEpochCapture.teardown();
  }
});

test('selection observer bounds diagnostics and rejects unsafe options, oversized bodies, wrong status and consumed replies', async () => {
  for (const options of [{credentials:'include'},{mode:'cors'},{headers:{}},{body:'private-canary'.repeat(4096)}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    const reply=p.fetch(path,{...init(),...options}); await p.selectionEpochCapture.wait(); p.selectionEpochCapture.teardown(); await reply;
    assert.ok(p.selectionEpochCapture.summary().failures.some(f => f === 'request:options' || f === 'request:body'));
    const text=JSON.stringify(p.selectionEpochCapture.summary());
    for (const secret of [token,a,b,id(3),id(4),task,'private-canary']) assert.equal(text.includes(secret),false);
    assert.ok(text.length < 1024);
  }
  for (const used of [false,true]) {
    const r=json(accepted,used ? 202 : 200); if (used) await r.text();
    const p=observer(async () => r); seed(p); const reply=p.fetch(path,init()); await p.selectionEpochCapture.wait();
    p.selectionEpochCapture.teardown(); assert.equal(await reply,r);
    assert.ok(p.selectionEpochCapture.summary().failures.includes('hold:response'));
  }
});

test('actual controller late A HTTP completion after epoch change keeps B snapshot/draft and immutable A command', async () => {
  let serial=0; let taskBody; let taskPosts=0; let original;
  const streams=[stream(),stream()];
  const p=observer(async (url,options) => {
    if (url === '/v1/settings') return json({...wire.settings,workspaces:['/w0','/w1']});
    if (url === '/v1/sessions?limit=32') return json({api_version:1,entries:[],next_after_id:null,has_more:false});
    if (url === '/v1/sessions') {
      const body=JSON.parse(options.body); const slot=titles.indexOf(body.title); const sid=[a,b][slot];
      return json({api_version:1,session_id:sid,receipt:{operation_id:body.operation_id,session_id:sid,run_id:null,
        first_sequence:'1',last_sequence:'1'},duplicate:false,warning_code:null},201);
    }
    if (url === path) {
      taskPosts++; taskBody=JSON.parse(options.body); original=json({...accepted,receipt:{...receipt,operation_id:taskBody.operation_id,run_id:taskBody.run_id}},202);
      return original;
    }
    const slot=url.includes(a) ? 0 : 1; const sid=[a,b][slot];
    if (url.includes('/events?')) return streams[slot].response;
    if (url.includes('/history?')) return json(historyPage([event('session.created',1,sid,{title:titles[slot],workspace:`/w${slot}`})],sid));
    return json({...wire.session,session_id:sid,title:titles[slot],workspace:`/w${slot}`,head_sequence:'1'});
  });
  const client=createClient({fetch:p.fetch,crypto:{randomUUID:() => id(++serial)}});
  client.subscribe(value => p.publish(value)); await client.connect(token);
  for (let slot=0; slot<2; slot++) await client.createSession(titles[slot],`/w${slot}`);
  await client.selectSession(a); await tick(); client.setDraft('edited first'); client.setDraft(task);
  const sending=client.sendTask(); await client.sendTask(); await p.selectionEpochCapture.wait();
  streams[0].push(wire.frame({...event('run.accepted',2,a),run_id:taskBody.run_id,
    data:{...wire.event('run.accepted','2',a).data,user_text:task}})); await tick();
  const captured=client.snapshot().recoveries[0].command;
  await client.selectSession(b); await tick(); client.setDraft(draft);
  const before=client.snapshot().selected;
  assert.equal(streams[0].cancelled,1); assert.equal(original.bodyUsed,false);
  assert.equal(p.selectionEpochCapture.release(),true); await sending;
  assert.equal(await p.selectionEpochCapture.drain(),true);
  const after=client.snapshot(); assert.deepEqual(after.selected,before); assert.equal(after.draft,draft);
  assert.equal(after.last_mutation.session_id,a); assert.equal(after.last_mutation.id,captured.id);
  assert.equal(after.last_mutation.receipt.run_id,captured.body.run_id); assert.equal(captured.body.text,task);
  assert.throws(() => {captured.body.text=draft;},TypeError); assert.equal(taskPosts,1);
  assert.deepEqual(plain(p.selectionEpochCapture.summary().failures),[]);
  client.disconnect(); assert.equal(p.selectionEpochCapture.cleared(),true);
});
