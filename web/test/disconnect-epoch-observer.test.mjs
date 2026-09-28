import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { installDisconnectEpochObserver } from '../test-support/disconnect-epoch.mjs';
import { createClient } from '../dist/client.js';
import { json, event, page as historyPage, stream, tick, token } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';

const a = wire.sid;
const id = n => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const title = 'synthetic A'; const task = 'synthetic task 雪'; const draft = 'unsent draft 雪';
const origin = 'http://127.0.0.1:43210';
const path = `/v1/sessions/${a}/runs`;
const command = {kind:'task',id:id(2),session_id:a,body:{operation_id:id(2),run_id:id(3),text:task}};
const receipt = {operation_id:id(2),session_id:a,run_id:id(3),first_sequence:'2',last_sequence:'3'};
const accepted = {api_version:1,receipt,duplicate:false,warning_code:null,notices:[]};
const empty = {connection:'disconnected',settings:null,catalog:null,catalog_loading:false,pending:[],recoveries:[],draft:'',last_mutation:null,error:null,selected:null};
const state = {...empty,connection:'connected',settings:{},catalog:{}};
const pending = {command,phase:'sending',receipt:null,reply:null,canonical_seen:false,canonical_sequence:null};
const selected = {session_id:a,manifest:{head_sequence:'1'},title,workspace:'/w',applied_cursor:`${a}:1`,through_sequence:'1',
  history_complete:true,display:[],observation:'streaming',observation_error:null,closed_reason:null,run_view:null,cancel:null,cancelling:false};
const plain = value => JSON.parse(JSON.stringify(value));
const init = (method = 'POST',body = command.body) => ({method,body:method === 'POST' ? JSON.stringify(body) : undefined,
  mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:new AbortController().signal});
function observer(fetch, timeout = setTimeout) {
  const events = new EventTarget(); const listeners = new Set();
  const sandbox = {fetch,URL,Request,Headers,setTimeout:timeout,clearTimeout,location:{href:`${origin}/`,origin,hash:`#session=${a}`},
    addEventListener(type,listener) { listeners.add(listener); events.addEventListener(type,listener); },
    removeEventListener(type,listener) { listeners.delete(listener); events.removeEventListener(type,listener); },
    dispatchEvent:event => events.dispatchEvent(event), listenerCount:() => listeners.size};
  runInNewContext(`(${installDisconnectEpochObserver.toString()})(${JSON.stringify({title,task,draft,owner:token})});
    globalThis.publish = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) publish(child); Object.freeze(value); } };`,sandbox,{timeout:1000});
  return sandbox;
}
function seed(p) {
  const c = {kind:'create',id:id(1),session_id:null,body:{operation_id:id(1),title,workspace:'/w'}};
  p.publish(empty);
  p.publish({...state,pending:[{command:c}]});
  p.publish({...state,last_mutation:{kind:'create',id:c.id,session_id:a,receipt:{operation_id:c.id,session_id:a,run_id:null,first_sequence:'1',last_sequence:'1'}}});
  p.publish({...state,selected});
  p.publish({...state,pending:[pending],selected,draft});
}
async function disconnect(p, options) {
  const streamOptions = init('GET'); await p.fetch(`/v1/sessions/${a}/events?after=${a}%3A1`,streamOptions);
  options.signal.dispatchEvent(new Event('abort')); streamOptions.signal.dispatchEvent(new Event('abort'));
  p.publish(empty);
}
const fast = (callback,ms) => setTimeout(callback,ms === 500 ? 0 : ms);

// Native Response identity and private comparisons stay inside the test process.
test('disconnect observer holds the same unconsumed Response and exact args across Disconnect until explicit release', async () => {
  const original = json(accepted,202); let args; let calls=0;
  const readText = original.text.bind(original);
  for (const method of ['clone','text','json','arrayBuffer','blob','formData','bytes']) {
    original[method] = () => {throw new Error('body access forbidden');};
  }
  const p=observer(async (...values) => {calls++; args=values; return original;},fast); seed(p);
  const options=init(); let resolved=false;
  const reply=p.fetch(path,options).then(value => {resolved=true; return value;});
  assert.equal(await p.disconnectEpochCapture.wait(),true);
  assert.equal(args[0],path); assert.equal(args[1],options); assert.equal(calls,1);
  assert.equal(original.bodyUsed,false); assert.equal(resolved,false);
  await disconnect(p,options); await tick();
  assert.equal(p.disconnectEpochCapture.summary().disconnected,true);
  assert.equal(p.disconnectEpochCapture.summary().released,false);
  assert.equal(p.disconnectEpochCapture.cleared(),false); assert.equal(p.listenerCount(),1);
  assert.equal(p.disconnectEpochCapture.summary().hashRetained,true);
  assert.equal(resolved,false); assert.equal(original.bodyUsed,false);
  assert.equal(p.disconnectEpochCapture.release(),true);
  assert.equal(await reply,original); assert.equal(original.bodyUsed,false);
  assert.equal(await p.disconnectEpochCapture.drain(),true);
  assert.deepEqual(plain(p.disconnectEpochCapture.summary().failures),[]);
  assert.equal(await readText(),JSON.stringify(accepted));
  p.disconnectEpochCapture.teardown(); assert.equal(p.disconnectEpochCapture.cleared(),true);
  assert.equal(p.listenerCount(),0);
  p.location.hash = ''; p.dispatchEvent(new Event('hashchange'));
  assert.deepEqual(plain(p.disconnectEpochCapture.summary().failures),[]);
});

test('disconnect observer delegates all other requests unchanged and refuses duplicate or extra holds', async () => {
  const replies=[]; const p=observer(async () => {const r=json(accepted,202); replies.push(r); return r;}); seed(p);
  const request=new Request(`${origin}/v1/settings`); const options=init('GET');
  assert.equal(await p.fetch(request,options),replies[0]);
  const first=p.fetch(path,init()); await p.disconnectEpochCapture.wait();
  for (const url of [path,`/v1/sessions/${wire.otherSid}/runs`,`${path}?extra=1`]) {
    const r=await p.fetch(url,init()); assert.equal(r,replies.at(-1)); assert.equal(r.bodyUsed,false);
  }
  p.disconnectEpochCapture.teardown(); assert.equal(await first,replies[1]);
  assert.equal(p.disconnectEpochCapture.summary().counts.holds,1);
  assert.deepEqual(plain(p.disconnectEpochCapture.summary().failures),['request:extra-task','request:task']);
});

test('disconnect observer rejects early/repeated release and reconnect before the finite quiet drain', async () => {
  const p=observer(async () => json(accepted,202),fast); seed(p);
  assert.equal(p.disconnectEpochCapture.release(),false); assert.equal(p.disconnectEpochCapture.reconnect(),false);
  const options=init(); let done=false; const reply=p.fetch(path,options).then(() => {done=true;}); await p.disconnectEpochCapture.wait();
  assert.equal(p.disconnectEpochCapture.release(),false); await tick(); assert.equal(done,false);
  await disconnect(p,options); assert.equal(p.disconnectEpochCapture.release(),true); await reply;
  assert.equal(p.disconnectEpochCapture.release(),false); assert.equal(p.disconnectEpochCapture.reconnect(),false);
  assert.equal(await p.disconnectEpochCapture.drain(),true); assert.equal(p.disconnectEpochCapture.reconnect(),true);
  assert.equal(p.disconnectEpochCapture.reconnect(),false);
  assert.deepEqual(plain(p.disconnectEpochCapture.summary().failures),['hold:order']); p.disconnectEpochCapture.teardown();
});

test('disconnect observer bounds wait, drain and hold timeouts and emergency teardown handles late native fetch', async () => {
  const timers=[];
  const p=observer(async () => json(accepted,202),(callback,ms) => {if(ms === 10_000){timers.push(callback); return 0;} return setTimeout(callback,ms);}); seed(p);
  const reply=p.fetch(path,init()); await p.disconnectEpochCapture.wait(); timers[0]();
  assert.equal((await reply).bodyUsed,false); assert.deepEqual(plain(p.disconnectEpochCapture.summary().failures),['hold:timeout']);
  p.disconnectEpochCapture.teardown(); assert.equal(p.disconnectEpochCapture.cleared(),true);
  const absent=observer(async () => json(accepted,202),(callback) => {queueMicrotask(callback); return 0;});
  assert.equal(await absent.disconnectEpochCapture.wait(),false);
  assert.ok(absent.disconnectEpochCapture.summary().failures.includes('hold:wait')); absent.disconnectEpochCapture.teardown();
  let resolve; const late=observer(() => new Promise(r => {resolve=r;})); seed(late);
  const original=json(accepted,202); const waiting=late.fetch(path,init()); late.disconnectEpochCapture.teardown(); resolve(original);
  assert.equal(await waiting,original); assert.equal(original.bodyUsed,false);
  assert.equal(late.disconnectEpochCapture.summary().counts.holds,0); assert.equal(late.disconnectEpochCapture.cleared(),true);
});

test('disconnect observer detects every revived field and connection epoch contamination without private diagnostics', async () => {
  for (const change of [{connection:'connected'},{settings:{}},{catalog:{}},{catalog_loading:true},{selected},
    {draft:task},{pending:[pending]},{recoveries:[pending]},{last_mutation:{receipt}},{error:{raw:'private-canary'}}]) {
    const p=observer(async () => json(accepted,202),fast); seed(p); const options=init();
    const reply=p.fetch(path,options); await p.disconnectEpochCapture.wait(); await disconnect(p,options);
    p.disconnectEpochCapture.release(); await reply; p.publish({...empty,...change});
    assert.equal(await p.disconnectEpochCapture.drain(),false);
    assert.ok(p.disconnectEpochCapture.summary().failures.includes('state:epoch'));
    assert.equal(JSON.stringify(p.disconnectEpochCapture.summary()).includes('private-canary'),false); p.disconnectEpochCapture.teardown();
  }
});

test('disconnect observer rejects cleared, retargeted and transiently changed hashes without retaining identities in diagnostics', async () => {
  for (const hash of ['',`#session=${wire.otherSid}`,`#session=${a}&extra=1`]) {
    const p=observer(async () => json(accepted,202),fast); seed(p); const options=init();
    const reply=p.fetch(path,options); await p.disconnectEpochCapture.wait(); await disconnect(p,options);
    p.location.hash=hash; p.dispatchEvent(new Event('hashchange'));
    p.location.hash=`#session=${a}`; p.dispatchEvent(new Event('hashchange'));
    assert.equal(p.disconnectEpochCapture.release(),true); await reply;
    assert.equal(await p.disconnectEpochCapture.drain(),false); assert.equal(p.disconnectEpochCapture.reconnect(),false);
    assert.ok(p.disconnectEpochCapture.summary().failures.includes('state:hash'));
    const text=JSON.stringify(p.disconnectEpochCapture.summary());
    for (const value of [a,wire.otherSid,token,task,draft]) assert.equal(text.includes(value),false);
    p.disconnectEpochCapture.teardown(); assert.equal(p.disconnectEpochCapture.cleared(),true); assert.equal(p.listenerCount(),0);
  }
});

test('disconnect observer checks the retained hash again at explicit reconnect', async () => {
  const p=observer(async () => json(accepted,202),fast); seed(p); const options=init();
  const reply=p.fetch(path,options); await p.disconnectEpochCapture.wait(); await disconnect(p,options);
  p.disconnectEpochCapture.release(); await reply; assert.equal(await p.disconnectEpochCapture.drain(),true);
  p.location.hash='';
  assert.equal(p.disconnectEpochCapture.reconnect(),false);
  assert.ok(p.disconnectEpochCapture.summary().failures.includes('state:hash')); p.disconnectEpochCapture.teardown();
});

test('disconnect observer detects requests throughout disconnection including navigation, reconciliation and cancel', async () => {
  const p=observer(async () => json(accepted,202),fast); seed(p); const options=init();
  const reply=p.fetch(path,options); await p.disconnectEpochCapture.wait(); await disconnect(p,options);
  p.disconnectEpochCapture.release(); await reply;
  for(const url of ['/','/v1/settings',`${path}/${id(3)}`,`/v1/sessions/${a}/operations/${id(2)}`]) await p.fetch(url,init('GET'));
  await p.fetch(`${path}/${id(3)}/cancel`,init());
  assert.equal(await p.disconnectEpochCapture.drain(),false); assert.equal(p.disconnectEpochCapture.summary().counts.quiet,5);
  assert.equal(p.disconnectEpochCapture.reconnect(),false); p.disconnectEpochCapture.teardown();
});

test('disconnect observer validates immutable command, options, body, status and bounded private diagnostics', async () => {
  for(const change of [{session_id:wire.otherSid},{id:id(8)},{body:{...command.body,text:'private-canary'}},{body:{...command.body,run_id:id(9)}}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    p.publish({...state,pending:[{...pending,command:{...command,...change}}]});
    assert.ok(p.disconnectEpochCapture.summary().failures.includes('state:command')); p.disconnectEpochCapture.teardown();
  }
  for(const options of [{credentials:'include'},{mode:'cors'},{headers:{}},{body:'private-canary'.repeat(4096)}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    const reply=p.fetch(path,{...init(),...options}); await p.disconnectEpochCapture.wait(); p.disconnectEpochCapture.teardown(); await reply;
    assert.ok(p.disconnectEpochCapture.summary().failures.some(f => ['request:options','request:body'].includes(f)));
    const text=JSON.stringify(p.disconnectEpochCapture.summary());
    for(const secret of [token,a,id(2),id(3),task,'private-canary']) assert.equal(text.includes(secret),false);
    assert.ok(text.length < 1024);
  }
  for(const used of [false,true]) {
    const r=json(accepted,used ? 202 : 200); if(used) await r.text();
    const p=observer(async () => r); seed(p); const reply=p.fetch(path,init()); await p.disconnectEpochCapture.wait();
    p.disconnectEpochCapture.teardown(); assert.equal(await reply,r);
    assert.ok(p.disconnectEpochCapture.summary().failures.includes('hold:response'));
  }
});

test('actual controller Disconnect aborts task and A stream, drops command and draft, fences stale 202, and requires explicit reconnect', async () => {
  let serial=0; let taskBody; let original; let discarded=0;
  const calls=[]; const streams=[stream(),stream()]; let streamIndex=0;
  const p=observer(async (url,options) => {
    calls.push(url);
    if(url === '/v1/settings') return json({...wire.settings,workspaces:['/w']});
    if(url === '/v1/sessions?limit=32') return json({api_version:1,entries:[],next_after_id:null,has_more:false});
    if(url === '/v1/sessions') {
      const body=JSON.parse(options.body);
      return json({api_version:1,session_id:a,receipt:{operation_id:body.operation_id,session_id:a,run_id:null,first_sequence:'1',last_sequence:'1'},duplicate:false,warning_code:null},201);
    }
    if(url === path) {
      taskBody=JSON.parse(options.body);
      original=new Response(new ReadableStream({cancel(){discarded++;}}),{status:202,headers:{'Content-Type':'application/json'}});
      return original;
    }
    if(url.includes('/events?')) return streams[streamIndex++].response;
    if(url.includes('/history?')) return json(historyPage([event('session.created',1,a,{title,workspace:'/w'})],a));
    return json({...wire.session,session_id:a,title,workspace:'/w',head_sequence:'1'});
  });
  const client=createClient({fetch:p.fetch,crypto:{randomUUID:() => id(++serial)}});
  client.subscribe(value => p.publish(value)); await client.connect(token); await client.createSession(title,'/w');
  await client.selectSession(a); await tick(); client.setDraft('edited first'); client.setDraft(task);
  const sending=client.sendTask(); await client.sendTask(); await p.disconnectEpochCapture.wait();
  streams[0].push(wire.frame({...event('run.accepted',2,a),run_id:taskBody.run_id,
    data:{...wire.event('run.accepted','2',a).data,user_text:task}})); await tick();
  const captured=client.snapshot().recoveries[0].command;
  assert.equal(captured.body.text,task); assert.throws(() => {captured.body.text=draft;},TypeError);
  client.setDraft(draft); const requests=calls.length; client.disconnect(); await sending; await tick();
  assert.deepEqual(client.snapshot(),empty); assert.equal(original.bodyUsed,false);
  assert.equal(streams[0].cancelled,1);
  const held=p.disconnectEpochCapture.summary();
  assert.equal(held.taskAborted && held.streamAborted && held.empty && held.canonical,true);
  assert.equal(held.returned || held.released,false); assert.equal(p.disconnectEpochCapture.cleared(),false);
  assert.equal(p.disconnectEpochCapture.release(),true); assert.equal(await p.disconnectEpochCapture.drain(),true);
  assert.equal(discarded,1); assert.deepEqual(client.snapshot(),empty); assert.equal(calls.length,requests);
  assert.equal(calls.filter(url => url === path).length,1);
  assert.deepEqual(plain(p.disconnectEpochCapture.summary().failures),[]);
  assert.equal(p.disconnectEpochCapture.reconnect(),true); await client.connect(token);
  assert.equal(client.snapshot().connection,'connected'); assert.equal(client.snapshot().selected,null);
  assert.deepEqual(calls.slice(requests),['/v1/settings','/v1/sessions?limit=32']);
  assert.deepEqual(client.snapshot().pending,[]); assert.deepEqual(client.snapshot().recoveries,[]); assert.equal(client.snapshot().last_mutation,null);
  client.disconnect(); p.disconnectEpochCapture.teardown(); assert.equal(p.disconnectEpochCapture.cleared(),true);
});
