import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { event, json, page as historyPage, stream, tick, token } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';

// This element model exercises real app/view/controller modules, not browser navigation or layout.
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.attributes = {}; this.listeners = {};
    this.text = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.scrollTop = 0; this.clientHeight = 100; this.scrollHeight = 100;
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.replaceChildren(); this.text = text; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  get options() { return this.children; }
  setAttribute(name,value) { this.attributes[name] = value; }
  addEventListener(name,callback) { this.listeners[name] = callback; }
  append(...children) { for (const child of children) this.insertBefore(child,null); }
  insertBefore(child,next) {
    child.remove(); const index = next === null ? this.children.length : this.children.indexOf(next);
    assert.ok(index >= 0); this.children.splice(index,0,child); child.parent = this;
  }
  remove() { if (this.parent !== null) { this.parent.children.splice(this.parent.children.indexOf(this),1); this.parent = null; } }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...children); }
  find(predicate) { return [this,...this.children.flatMap(child => child.find(predicate))].filter(predicate); }
}
const modules = new Map(['api','sse','state','client','view','app'].map(name => [name,ts.transpileModule(
  readFileSync(new URL(`../dist/${name}.js`,import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}},
).outputText]));
const plain = value => JSON.parse(JSON.stringify(value));
const empty = {connection:'disconnected',settings:null,catalog:null,catalog_loading:false,pending:[],recoveries:[],draft:'',last_mutation:null,error:null,selected:null};
function appRealm(fetch) {
  const root = new Element('main'); const listeners = new Map();
  const location = {protocol:'http:',hostname:'127.0.0.1',hash:`#session=${wire.sid}`};
  const context = createContext({fetch,crypto:globalThis.crypto,AbortController,TextDecoder,URL,Headers,Response,Request,
    document:{getElementById:() => root,createElement:tag => new Element(tag)},
    window:{location,addEventListener:(name,callback) => listeners.set(name,callback)}});
  const cache = new Map(); let client;
  function load(name) {
    if (!cache.has(name)) {
      assert.ok(modules.has(name)); const exports = {}; cache.set(name,exports);
      const evaluate = runInContext(`(function(exports,require){${modules.get(name)}\n})`,context,{timeout:1000});
      evaluate(exports,path => load(path.slice(2,-3)));
      if (name === 'client') {
        const createClient = exports.createClient;
        exports.createClient = () => { client = createClient(); return client; };
      }
    }
    return cache.get(name);
  }
  load('app');
  return {root,client,location,dispatch:name => listeners.get(name)?.(),field:label => root.find(node => node.tag === 'label' && node.text === label)[0].children[0]};
}
const submit = form => form.listeners.submit({preventDefault(){}});

test('new actual app realm starts disconnected; retained hash and token entry alone cannot authorize API reads', async () => {
  const calls = [[],[]]; const streams = [stream(),stream()]; let resolveTask;
  const native = index => async (url,options) => {
    calls[index].push(url);
    assert.equal(new Headers(options.headers).get('authorization'),`Bearer ${token}`);
    assert.equal(options.credentials,'omit');
    if (url === '/v1/settings') return json(wire.settings);
    if (url === '/v1/sessions?limit=32') return json({api_version:1,entries:[],next_after_id:null,has_more:false});
    if (url.endsWith('/runs')) return new Promise(resolve => {resolveTask=resolve;});
    if (url.includes('/events?')) return streams[index].response;
    if (url.includes('/history?')) return json(historyPage([event('session.created',1)],wire.sid));
    return json({...wire.session,head_sequence:'1'});
  };
  const old = appRealm(native(0)); let fresh;
  try {
    old.field('Owner token').value=token; submit(old.field('Owner token').parent.parent); await tick();
    assert.equal(old.client.snapshot().selected.session_id,wire.sid);
    old.field('Task').value='unsent page-only text'; old.field('Task').listeners.input();
    submit(old.field('Task').parent.parent); await tick();
    assert.equal(old.client.snapshot().pending.length,1);
    const before = calls[0].length; old.dispatch('beforeunload'); old.dispatch('pagehide'); await tick();
    assert.deepEqual(plain(old.client.snapshot()),empty); assert.equal(streams[0].cancelled,1);
    fresh = appRealm(native(1));
    assert.notEqual(fresh.client,old.client); assert.notEqual(fresh.root,old.root);
    assert.equal(fresh.location.hash,old.location.hash); assert.deepEqual(plain(fresh.client.snapshot()),empty);
    assert.ok(fresh.root.find(node => ['input','textarea','select'].includes(node.tag)).every(node => node.value === ''));
    assert.ok(fresh.root.find(node => ['layout','commands'].includes(node.className)).every(node => node.hidden));
    fresh.dispatch('hashchange'); await tick(); assert.deepEqual(calls[1],[]);
    fresh.field('Owner token').value=token; await tick();
    assert.deepEqual(plain(fresh.client.snapshot()),empty); assert.deepEqual(calls[1],[]);
    // Simulated unload retains this VM, unlike Chromium. The old closure still cannot reach the new app.
    resolveTask(new Response(null,{status:202})); await tick();
    assert.deepEqual(plain(fresh.client.snapshot()),empty); assert.equal(calls[0].length,before); assert.deepEqual(calls[1],[]);
    submit(fresh.field('Owner token').parent.parent); await tick();
    assert.equal(fresh.field('Owner token').value,'');
    assert.equal(fresh.client.snapshot().connection,'connected'); assert.equal(fresh.client.snapshot().selected.session_id,wire.sid);
    assert.deepEqual(calls[1],[
      '/v1/settings','/v1/sessions?limit=32',`/v1/sessions/${wire.sid}`,
      `/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A0&limit=32`,`/v1/sessions/${wire.sid}/events?after=${wire.sid}%3A1`,
    ]);
    assert.deepEqual(plain(fresh.client.snapshot().pending),[]); assert.deepEqual(plain(fresh.client.snapshot().recoveries),[]);
    assert.equal(fresh.client.snapshot().last_mutation,null); assert.equal(fresh.client.snapshot().draft,'');
  } finally { old.client.disconnect(); fresh?.client.disconnect(); resolveTask?.(new Response(null,{status:202})); }
});
