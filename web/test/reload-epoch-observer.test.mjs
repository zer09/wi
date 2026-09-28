import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { installReloadEpochObserver } from '../test-support/reload-epoch.mjs';
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
function observer(fetch, {timeout = setTimeout, reloaded = false} = {}) {
  const listeners = new Map();
  const sandbox = {fetch,URL,Request,Headers,setTimeout:timeout,clearTimeout,location:{href:`${origin}/`,origin,hash:`#session=${a}`},
    performance:{getEntriesByType:() => [{type:reloaded ? 'reload' : 'navigate'}]},
    document:{querySelector:() => ({value:token})},
    addEventListener:(type,listener) => listeners.set(type,listener), removeEventListener:type => listeners.delete(type),
    dispatch:(type,event) => listeners.get(type)?.(event), listenerCount:() => listeners.size};
  runInNewContext(`(${installReloadEpochObserver.toString()})(${JSON.stringify({title,task,draft,owner:token})});
    globalThis.publish = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) publish(child); Object.freeze(value); } };`,sandbox,{timeout:1000});
  return sandbox;
}
function seed(p) {
  const c = {kind:'create',id:id(1),session_id:null,body:{operation_id:id(1),title,workspace:'/w'}};
  p.publish(empty); p.publish({...state,pending:[{command:c}]});
  p.publish({...state,last_mutation:{kind:'create',id:c.id,session_id:a,receipt:{operation_id:c.id,session_id:a,run_id:null,first_sequence:'1',last_sequence:'1'}}});
  p.publish({...state,selected}); p.publish({...state,pending:[pending],selected,draft});
}

test('reload observer delegates exact original args and holds the same unconsumed 202 before simulated unload', async () => {
  const original = json(accepted,202); let args; let calls=0;
  const readText = original.text.bind(original);
  for (const method of ['clone','text','json','arrayBuffer','blob','formData','bytes']) original[method] = () => {throw new Error('body access forbidden');};
  const p=observer(async (...values) => {calls++; args=values; return original;}); seed(p);
  const options=init(); let resolved=false;
  const reply=p.fetch(path,options).then(value => {resolved=true; return value;});
  assert.equal(await p.reloadEpochCapture.wait(),true);
  assert.equal(args[0],path); assert.equal(args[1],options); assert.equal(calls,1);
  assert.equal(original.bodyUsed,false); assert.equal(resolved,false);
  for (const name of ['beforeunload','pagehide']) p.dispatch(name);
  p.publish(empty); await tick();
  assert.equal(p.reloadEpochCapture.summary().unconsumed,true);
  assert.equal(p.reloadEpochCapture.summary().emergencyReleased,false); assert.equal(resolved,false);
  assert.deepEqual(plain(p.reloadEpochCapture.summary().failures),[]);
  // VM unload does not destroy a realm. Emergency cleanup proves identity, not a post-reload callback.
  p.reloadEpochCapture.teardown(); assert.equal(await reply,original); assert.equal(original.bodyUsed,false);
  assert.equal(await readText(),JSON.stringify(accepted)); assert.equal(p.listenerCount(),0);
  assert.equal(p.reloadEpochCapture.summary().cleared,true);
});

test('reload observer forwards every nonheld request unchanged and diagnoses duplicate or extra tasks without another hold', async () => {
  const calls=[]; const replies=[];
  const p=observer(async (...args) => {calls.push(args); const r=json(accepted,202); replies.push(r); return r;}); seed(p);
  const request=new Request(`${origin}/v1/settings`); const options=init('GET');
  assert.equal(await p.fetch(request,options),replies[0]); assert.equal(calls[0][0],request); assert.equal(calls[0][1],options);
  const first=p.fetch(path,init()); await p.reloadEpochCapture.wait();
  for (const url of [path,`/v1/sessions/${wire.otherSid}/runs`,`${path}?extra=1`]) {
    const options=init(); const r=await p.fetch(url,options);
    assert.equal(r,replies.at(-1)); assert.equal(r.bodyUsed,false); assert.equal(calls.at(-1)[0],url); assert.equal(calls.at(-1)[1],options);
  }
  p.reloadEpochCapture.teardown(); assert.equal(await first,replies[1]);
  assert.equal(p.reloadEpochCapture.summary().counts.holds,1);
  assert.deepEqual(plain(p.reloadEpochCapture.summary().failures),['request:extra-task','request:task']);
});

test('reload observer bounds missing-response wait, held-response timeout and emergency teardown with a late native reply', async () => {
  const timers=[];
  const p=observer(async () => json(accepted,202),{timeout:(callback,ms) => {if(ms === 10_000){timers.push(callback); return 0;} return setTimeout(callback,ms);}}); seed(p);
  const reply=p.fetch(path,init()); await p.reloadEpochCapture.wait(); timers[0]();
  assert.equal((await reply).bodyUsed,false); assert.deepEqual(plain(p.reloadEpochCapture.summary().failures),['hold:timeout']);
  p.reloadEpochCapture.teardown(); assert.equal(p.reloadEpochCapture.summary().cleared,true);
  const absent=observer(async () => json(accepted,202),{timeout:callback => {queueMicrotask(callback); return 0;}});
  assert.equal(await absent.reloadEpochCapture.wait(),false);
  assert.ok(absent.reloadEpochCapture.summary().failures.includes('hold:wait')); absent.reloadEpochCapture.teardown();
  let resolve; const late=observer(() => new Promise(r => {resolve=r;})); seed(late);
  const original=json(accepted,202); const waiting=late.fetch(path,init()); late.reloadEpochCapture.teardown(); resolve(original);
  assert.equal(await waiting,original); assert.equal(original.bodyUsed,false);
  assert.equal(late.reloadEpochCapture.summary().counts.holds,0); assert.equal(late.reloadEpochCapture.summary().cleared,true);
});

test('reload observer detects immutable identity, exact body, request options and non-202 or consumed replies with bounded diagnostics', async () => {
  for(const change of [{session_id:wire.otherSid},{id:id(8)},{body:{...command.body,text:'private-canary'}},{body:{...command.body,run_id:id(9)}}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    p.publish({...state,pending:[{...pending,command:{...command,...change}}]});
    assert.ok(p.reloadEpochCapture.summary().failures.includes('state:command')); p.reloadEpochCapture.teardown();
  }
  for(const options of [{credentials:'include'},{mode:'cors'},{headers:{}},{body:'private-canary'.repeat(4096)},
    {body:JSON.stringify({...command.body,text:'private-canary'})},{body:JSON.stringify({...command.body,extra:true})}]) {
    const p=observer(async () => json(accepted,202)); seed(p);
    const reply=p.fetch(path,{...init(),...options}); await p.reloadEpochCapture.wait();
    assert.ok(p.reloadEpochCapture.summary().failures.some(f => ['request:options','request:body'].includes(f)));
    const text=JSON.stringify(p.reloadEpochCapture.summary());
    for(const secret of [token,a,id(2),id(3),task,draft,'private-canary']) assert.equal(text.includes(secret),false);
    assert.ok(text.length < 1024); p.reloadEpochCapture.teardown(); await reply;
  }
  for(const used of [false,true]) {
    const r=json(accepted,used ? 202 : 200); if(used) await r.text();
    const p=observer(async () => r); seed(p); const reply=p.fetch(path,init()); await p.reloadEpochCapture.wait();
    assert.equal(p.reloadEpochCapture.summary().unconsumed,false); p.reloadEpochCapture.teardown(); assert.equal(await reply,r);
    assert.ok(p.reloadEpochCapture.summary().failures.includes('hold:response'));
  }
});

test('fresh reload observer rejects every revived field and all API work before explicit owner Connect, but permits public GETs', async () => {
  for (const change of [{connection:'connected'},{settings:{}},{catalog:{}},{catalog_loading:true},{selected},
    {draft:task},{pending:[pending]},{recoveries:[pending]},{last_mutation:{receipt}},{error:{raw:'private-canary'}}]) {
    const p=observer(async () => json(accepted,202),{reloaded:true}); p.publish(empty); p.publish({...empty,...change});
    assert.ok(p.reloadEpochCapture.summary().failures.includes('state:epoch'));
    assert.equal(JSON.stringify(p.reloadEpochCapture.summary()).includes('private-canary'),false); p.reloadEpochCapture.teardown();
  }
  const p=observer(async () => json(accepted,202),{reloaded:true}); p.publish(empty);
  await p.fetch('/',init('GET')); assert.deepEqual(plain(p.reloadEpochCapture.summary().failures),[]);
  for(const url of ['/v1/settings',`/v1/sessions/${a}/operations/${id(2)}`,`${path}/${id(3)}/cancel`,path]) await p.fetch(url,init(url.endsWith('settings') ? 'GET' : 'POST'));
  assert.equal(p.reloadEpochCapture.summary().counts.quiet,4); assert.equal(p.reloadEpochCapture.summary().counts.holds,0);
  for(let i=0; i<100; i++) await p.fetch('/v1/settings',init('GET'));
  assert.equal(p.reloadEpochCapture.summary().counts.settings,32); assert.ok(JSON.stringify(p.reloadEpochCapture.summary()).length < 1024);
  p.reloadEpochCapture.teardown(); assert.equal(p.listenerCount(),0);
  const fresh=observer(async () => json(wire.settings),{reloaded:true}); fresh.publish(empty);
  fresh.dispatch('click',{target:{tagName:'INPUT',textContent:''}}); assert.equal(fresh.reloadEpochCapture.summary().explicitConnect,false);
  fresh.dispatch('click',{target:{tagName:'BUTTON',textContent:'Connect'}});
  await fresh.fetch('/v1/settings',init('GET')); assert.deepEqual(plain(fresh.reloadEpochCapture.summary().failures),[]);
  fresh.reloadEpochCapture.teardown();
});

test('actual controller keeps one immutable task before simulated unload; a separate client cannot inherit its token or command', async () => {
  let serial=0; let taskBody; const calls=[]; const s=stream(); const original=json(accepted,202);
  const p=observer(async (url,options) => {
    calls.push(url);
    if(url === '/v1/settings') return json({...wire.settings,workspaces:['/w']});
    if(url === '/v1/sessions?limit=32') return json({api_version:1,entries:[],next_after_id:null,has_more:false});
    if(url === '/v1/sessions') {
      const body=JSON.parse(options.body);
      return json({api_version:1,session_id:a,receipt:{operation_id:body.operation_id,session_id:a,run_id:null,first_sequence:'1',last_sequence:'1'},duplicate:false,warning_code:null},201);
    }
    if(url === path) {taskBody=JSON.parse(options.body); return original;}
    if(url.includes('/events?')) return s.response;
    if(url.includes('/history?')) return json(historyPage([event('session.created',1,a,{title,workspace:'/w'})],a));
    return json({...wire.session,session_id:a,title,workspace:'/w',head_sequence:'1'});
  });
  const client=createClient({fetch:p.fetch,crypto:{randomUUID:() => id(++serial)}});
  client.subscribe(value => p.publish(value)); await client.connect(token); await client.createSession(title,'/w');
  await client.selectSession(a); await tick(); client.setDraft('edited first'); client.setDraft(task);
  const sending=client.sendTask(); await client.sendTask(); await p.reloadEpochCapture.wait();
  s.push(wire.frame({...event('run.accepted',2,a),run_id:taskBody.run_id,data:{...wire.event('run.accepted','2',a).data,user_text:task}})); await tick();
  const captured=client.snapshot().recoveries[0].command;
  assert.equal(captured.body.text,task); assert.throws(() => {captured.body.text=draft;},TypeError);
  client.setDraft(draft); const requests=calls.length; p.dispatch('beforeunload'); client.disconnect(); await sending;
  assert.deepEqual(client.snapshot(),empty); assert.equal(s.cancelled,1); assert.equal(original.bodyUsed,false);
  assert.equal(p.reloadEpochCapture.summary().unconsumed,true); assert.equal(p.reloadEpochCapture.summary().canonical,true);
  const fresh=createClient({fetch:() => {throw new Error('fresh page must not fetch');}});
  assert.deepEqual(fresh.snapshot(),empty);
  // Only this simulated realm remains executable. Chromium destruction is proved in the joined test.
  p.reloadEpochCapture.teardown(); await tick();
  assert.deepEqual(fresh.snapshot(),empty); assert.equal(calls.length,requests); assert.equal(calls.filter(url => url === path).length,1);
  assert.deepEqual(plain(p.reloadEpochCapture.summary().failures),[]);
});
