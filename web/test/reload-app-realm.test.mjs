import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { Element, control } from '../test-support/display-dom.mjs';
import * as f from '../test-support/display-fixtures.mjs';

// Each VM loads the real generated app graph. Only transport and layout are deterministic seams.
const modules = new Map(['api','display-api','sse','display-store','display-client','display-view','app'].map(name => [name,ts.transpileModule(
  readFileSync(new URL(`../dist/${name}.js`,import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}},
).outputText]));
const token = 'ab'.repeat(32);
const plain = value => JSON.parse(JSON.stringify(value));
const empty = {connection:'disconnected',settings:null,catalog:null,catalog_loading:false,error:null,draft:'',pending:[],selected:null};
const latest = () => f.page({ previous_block: null });
const json = (value,status = 200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function stream() {
  let sender, cancelled = 0;
  return {response:new Response(new ReadableStream({start(c){sender=c;},cancel(){cancelled++;}}),{headers:{'Content-Type':'text/event-stream'}}),
    push(batch){sender.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${batch.next_after}\ndata: ${JSON.stringify(batch)}\n\n`));},get cancelled(){return cancelled;}};
}
function appRealm(fetch) {
  const document = {createElement:tag => new Element(tag,document),activeElement:null};
  const root = new Element('main',document), listeners = new Map(), queued = new Map(); let frame = 0;
  document.getElementById = () => root;
  const location = {protocol:'http:',hostname:'127.0.0.1',hash:`#session=${f.SID}`};
  const context = createContext({fetch,crypto:globalThis.crypto,AbortController,TextDecoder,TextEncoder,structuredClone,atob,btoa,URL,Headers,Response,Request,
    document,requestAnimationFrame:cb => {const id=++frame;queued.set(id,cb);return id;},cancelAnimationFrame:id => queued.delete(id),
    window:{location,addEventListener:(name,callback) => listeners.set(name,callback)}});
  const cache = new Map(); let client;
  function load(name) {
    if (!cache.has(name)) {
      assert.ok(modules.has(name),`unexpected runtime module ${name}`); const exports = {}; cache.set(name,exports);
      const evaluate = runInContext(`(function(exports,require){${modules.get(name)}\n})`,context,{timeout:1000});
      evaluate(exports,path => load(path.slice(2,-3)));
      if (name === 'display-client') {
        const createDisplayClient = exports.createDisplayClient;
        exports.createDisplayClient = () => {client=createDisplayClient();return client;};
      }
    }
    return cache.get(name);
  }
  load('app');
  return {root,client,location,loaded:cache,dispatch:name => listeners.get(name)?.(),field:label => control(root,label)};
}
const submit = field => field.parent.parent.dispatch('submit');
async function connect(realm) {realm.field('Owner token').value=token;submit(realm.field('Owner token'));await setImmediate();}
function native(calls,observation,task,first = async () => json(latest())) {
  return async (url,options) => {
    calls.push({url,method:options.method,body:options.body});
    assert.equal(new Headers(options.headers).get('authorization'),`Bearer ${token}`);
    assert.equal(options.credentials,'omit');
    if (url === '/v1/settings') return json({api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:false});
    if (url === '/v1/sessions?limit=32') return json({api_version:1,entries:[],next_after_id:null,has_more:false});
    if (url === `/v1/sessions/${f.SID}/runs` && options.method === 'POST') return task(options);
    if (url === `/v1/sessions/${f.SID}/conversation`) return first();
    if (url === `/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l','4','3','',''))}`) return observation.response;
    assert.fail(`unexpected active-app request ${url}`);
  };
}

test('fresh actual display app realm retains hash but no token/draft/pending; explicit Connect gets matching Latest then SSE without raw replay or automatic mutation', async () => {
  const calls=[[],[]],streams=[stream(),stream()]; let resolveTask, fresh;
  const old=appRealm(native(calls[0],streams[0],() => new Promise(resolve => {resolveTask=resolve;})));
  try {
    await connect(old);assert.equal(old.client.snapshot().selected.session_id,f.SID);
    assert.ok(old.client.snapshot().selected.store, JSON.stringify(old.client.snapshot().selected.observation_error));
    const task=old.field('Task');task.value='exact page-only text 雪\n';task.dispatch('input');submit(task);await setImmediate();
    assert.equal(old.client.snapshot().pending.length,1);
    assert.equal(JSON.parse(calls[0].find(c => c.method === 'POST').body).text,task.value);
    const before=calls[0].length;old.dispatch('beforeunload');old.dispatch('pagehide');await setImmediate();
    assert.deepEqual(plain(old.client.snapshot()),empty);assert.equal(streams[0].cancelled,1);
    fresh=appRealm(native(calls[1],streams[1],() => assert.fail('automatic Task')));
    assert.notEqual(fresh.client,old.client);assert.notEqual(fresh.root,old.root);assert.equal(fresh.location.hash,old.location.hash);
    assert.deepEqual(plain(fresh.client.snapshot()),empty);
    assert.ok(fresh.root.find(n => ['input','textarea','select'].includes(n.tag)).every(n => n.value === ''));
    assert.ok(fresh.root.find(n => ['layout','commands'].includes(n.className)).every(n => n.hidden));
    fresh.dispatch('hashchange');await setImmediate();assert.deepEqual(calls[1],[]);
    fresh.field('Owner token').value=token;await setImmediate();assert.deepEqual(calls[1],[]);
    // The simulated old realm survives unload. Its late completion still has no authority.
    resolveTask(new Response(null,{status:202}));await setImmediate();
    assert.deepEqual(plain(old.client.snapshot()),empty);assert.deepEqual(plain(fresh.client.snapshot()),empty);
    assert.equal(calls[0].length,before);assert.deepEqual(calls[1],[]);
    submit(fresh.field('Owner token'));await setImmediate();
    assert.equal(fresh.field('Owner token').value,'');assert.equal(fresh.client.snapshot().connection,'connected');
    assert.deepEqual(calls[1].map(c => c.url),['/v1/settings','/v1/sessions?limit=32',`/v1/sessions/${f.SID}/conversation`,
      `/v1/sessions/${f.SID}/conversation/events?after=${encodeURIComponent(f.cursor('l','4','3','',''))}`]);
    assert.ok(calls[1].every(c => c.method === 'GET'));
    assert.deepEqual([...fresh.loaded.keys()].sort(),[...modules.keys()].sort());
    assert.deepEqual(plain(fresh.client.snapshot().pending),[]);assert.equal(fresh.client.snapshot().draft,'');
    const updated=f.entry({revision:'5',fields:[f.field({text:'abc live',total_bytes:'8',to_byte:'8'})]});
    streams[1].push(f.batch([f.upsert(updated)],'5'));await setImmediate();
    assert.ok(fresh.root.textContent.includes('abc live'));assert.equal(fresh.client.snapshot().selected.store.live_after,f.cursor('l','5','3','',''));
  } finally {old.client.disconnect();fresh?.client.disconnect();resolveTask?.(new Response(null,{status:202}));}
});

test('late old-realm Latest cannot install display state or attach observation after unload; new realm stays independent', async () => {
  const calls=[[],[]],streams=[stream(),stream()];let resolveLatest;
  const old=appRealm(native(calls[0],streams[0],() => assert.fail('Task'),() => new Promise(resolve => {resolveLatest=resolve;})));
  let fresh;
  try {
    await connect(old);assert.equal(old.client.snapshot().selected.observation,'loading');
    old.dispatch('pagehide');const before=calls[0].length;
    fresh=appRealm(native(calls[1],streams[1],() => assert.fail('Task')));await connect(fresh);
    const state=plain(fresh.client.snapshot());resolveLatest(json(latest()));await setImmediate();
    assert.deepEqual(plain(old.client.snapshot()),empty);assert.deepEqual(plain(fresh.client.snapshot()),state);
    assert.equal(calls[0].length,before);assert.ok(calls[0].every(c => !c.url.includes('/events?')));
    assert.ok(calls.flat().every(c => c.method === 'GET'));
  } finally {old.client.disconnect();fresh?.client.disconnect();resolveLatest?.(json(latest()));}
});
