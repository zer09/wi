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

// Execute the real empty-case prefix and setup.connect without starting its HTTP/browser fixture.
const emptySpec = ts.createSourceFile('display-app.spec.mjs', readFileSync(new URL('../e2e/display-app.spec.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(emptySpec.parseDiagnostics.length, 0);
const emptyCase = emptySpec.statements.find(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
  && s.expression.arguments[0]?.text === 'active empty session and invalid hash never invent messages or mutate; catalog navigation opens display Latest').expression.arguments[1];
const emptyStatements = [...emptyCase.body.statements];
const countIndex = emptyStatements.findIndex(s => s.getText(emptySpec) === 'expect(h.calls).toHaveLength(2);');
const setupIndex = emptyStatements.findIndex(s => ts.isVariableStatement(s) && s.declarationList.declarations[0].name.getText(emptySpec) === 'h');
assert.ok(setupIndex > 0 && countIndex > setupIndex);
const emptyPrefix = emptyStatements.slice(setupIndex + 1, countIndex + 1);
const catalogWait = s => s.getText(emptySpec).includes("name: 'Open synthetic session'");
const setupFunction = emptySpec.statements.find(s => ts.isFunctionDeclaration(s) && s.name.text === 'setup');
const connectMethods = [];
function findConnect(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(emptySpec) === 'connect') connectMethods.push(node);
  ts.forEachChild(node, findConnect);
}
findConnect(setupFunction); assert.equal(connectMethods.length, 1);
const prefixContext = createContext({ f });
const emptyCatalog = runInContext(`(function(){${emptyStatements[0].getText(emptySpec)};return catalog;})()`, prefixContext, { timeout: 1000 });
const casePrefix = runInContext(`(async function(h,expect){${emptyPrefix.map(s => s.getText(emptySpec)).join('\n')}})`, prefixContext, { timeout: 1000 });
const oldCasePrefix = runInContext(`(async function(h,expect){${emptyPrefix.filter(s => !catalogWait(s)).map(s => s.getText(emptySpec)).join('\n')}})`, prefixContext, { timeout: 1000 });
const setupConnect = runInContext(`(function(root,expect,fixture){return ({${connectMethods[0].getText(emptySpec)}}).connect;})`, prefixContext, { timeout: 1000 });
const settingsReply = () => json({api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:false});
const catalogReply = () => json({api_version:1,entries:[emptyCatalog],next_after_id:f.SID,has_more:false});
const heldReply = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
async function microtasks() { for (let i = 0; i < 64; i++) await Promise.resolve(); }
function emptyCaseHarness() {
  const calls = [], settings = heldReply(), catalog = heldReply(), waits = new Set();
  const transport = native(calls, stream(), () => assert.fail('empty prefix cannot submit Task'));
  const realm = appRealm((url, options) => {
    const reply = transport(url, options);
    if (url === '/v1/settings') return settings.promise;
    if (url === '/v1/sessions?limit=32') return catalog.promise;
    return reply;
  });
  realm.location.hash = '#invalid'; realm.dispatch('hashchange');
  const visible = node => {
    if (!node || !realm.root.contains(node)) return false;
    for (let current = node; current; current = current.parent) if (current.hidden) return false;
    return true;
  };
  const locator = name => ({
    nodes: () => realm.root.find(n => n.tag === 'button' && n.textContent === name),
    async click() {
      const nodes = this.nodes(); assert.equal(nodes.length, 1); assert.ok(visible(nodes[0]));
      // The element model does not synthesize a form submit from a button click.
      if (name === 'Connect') submit(realm.field('Owner token')); else nodes[0].dispatch('click');
    },
  });
  let countReached = 0;
  const expect = actual => ({
    async toContainText(text) { assert.ok(actual.element.textContent.includes(text)); },
    toHaveLength(n) { countReached++; assert.equal(actual.length, n); },
    toBeVisible() {
      const ready = () => { const nodes = actual.nodes(); return nodes.length === 1 && visible(nodes[0]); };
      return new Promise((resolve, reject) => waits.add({ready,resolve,reject}));
    },
  });
  const root = {element:realm.root,
    getByLabel(name, options) { assert.deepEqual(plain(options), {exact:true}); return {async fill(value) {realm.field(name).value=value;}}; },
    getByRole(role, options) { assert.equal(role, 'button'); assert.equal(options.exact, true); return locator(options.name); },
  };
  const h = {root,calls,connect:setupConnect(root,expect,{owner:token})};
  return {realm,calls,settings,catalog,visible,locator,expect,h,get countReached(){return countReached;},
    start(prefix = casePrefix) {
      const task = {state:'pending',error:null};
      task.done = prefix(h,expect).then(() => {task.state='fulfilled';}, error => {task.state='rejected';task.error=error;});
      return task;
    },
    async observe() {
      for (let i = 0; i < 4; i++) {
        await microtasks(); for (const wait of [...waits]) if (wait.ready()) {waits.delete(wait);wait.resolve();}
      }
      await microtasks();
    },
    async close() {
      realm.client.disconnect(); settings.resolve(settingsReply()); catalog.resolve(catalogReply());
      for (const wait of waits) wait.reject(Error('bounded visibility observation ended')); waits.clear(); await microtasks();
    },
  };
}

for (const held of ['settings','catalog']) test(`actual empty-case prefix waits for connected catalog with ${held} held, not Disconnect or invalid notice`, async () => {
  const h = emptyCaseHarness(), task = h.start();
  try {
    if (held === 'catalog') h.settings.resolve(settingsReply());
    await h.observe();
    assert.equal(h.realm.client.snapshot().connection, 'connecting');
    assert.ok(h.visible(h.locator('Disconnect').nodes()[0]));
    assert.ok(h.realm.root.textContent.includes('Invalid session fragment ignored.'));
    assert.equal(h.calls.length, held === 'settings' ? 1 : 2);
    assert.equal(h.countReached, 0); assert.equal(task.state, 'pending');
    if (held === 'settings') { h.settings.resolve(settingsReply()); await h.observe(); assert.equal(task.state, 'pending'); assert.equal(h.countReached, 0); }
    h.catalog.resolve(catalogReply()); await h.observe(); await task.done;
    assert.equal(task.state, 'fulfilled'); assert.equal(h.countReached, 1);
    assert.equal(h.realm.client.snapshot().connection, 'connected');
    assert.ok(h.visible(h.locator('Open synthetic session').nodes()[0]));
    assert.deepEqual(h.calls.map(c => c.url), ['/v1/settings','/v1/sessions?limit=32']);
    assert.ok(h.calls.every(c => c.method === 'GET' && c.body === undefined));
    assert.equal(h.realm.field('Owner token').value, ''); assert.equal(h.realm.client.snapshot().selected, null);
    assert.deepEqual([...h.realm.loaded.keys()].sort(), [...modules.keys()].sort());
  } finally { await h.close(); }
});

for (const held of ['settings','catalog']) test(`old actual empty-case prefix reaches immediate count prematurely with ${held} held`, async () => {
  const h = emptyCaseHarness(), task = h.start(oldCasePrefix);
  try {
    if (held === 'catalog') h.settings.resolve(settingsReply());
    await h.observe(); await task.done;
    assert.equal(h.realm.client.snapshot().connection, 'connecting'); assert.equal(h.countReached, 1);
    assert.equal(task.state, held === 'settings' ? 'rejected' : 'fulfilled');
    if (held === 'settings') assert.equal(task.error.code, 'ERR_ASSERTION');
    assert.equal(h.locator('Open synthetic session').nodes().length, 0);
  } finally { await h.close(); }
});

for (const fault of ['missing row','failed settings','failed catalog','invalid catalog','extra call']) test(`actual empty-case readiness cannot pass ${fault}`, async () => {
  const h = emptyCaseHarness(), task = h.start();
  try {
    await h.observe();
    h.settings.resolve(fault === 'failed settings' ? json({api_version:1,code:'storage.unavailable',stage:null,certainty:'not_applicable',acceptance:null,notices:[]},503) : settingsReply());
    await h.observe();
    let reply = catalogReply();
    if (fault === 'missing row') reply = json({api_version:1,entries:[],next_after_id:null,has_more:false});
    if (fault === 'failed catalog') reply = json({api_version:1,code:'storage.unavailable',stage:null,certainty:'not_applicable',acceptance:null,notices:[]},503);
    if (fault === 'invalid catalog') reply = json({api_version:1,entries:[emptyCatalog],next_after_id:null,has_more:false});
    h.catalog.resolve(reply); await microtasks();
    if (fault === 'extra call') { await h.realm.client.refreshSessions(); assert.equal(h.calls.length, 3); }
    await h.observe();
    if (fault === 'extra call') { await task.done; assert.equal(task.state, 'rejected'); assert.equal(task.error.code, 'ERR_ASSERTION'); assert.equal(h.countReached, 1); }
    else {
      assert.equal(task.state, 'pending'); assert.equal(h.countReached, 0);
      assert.equal(h.locator('Open synthetic session').nodes().length, 0);
      assert.equal(h.realm.client.snapshot().connection, fault === 'missing row' ? 'connected' : 'disconnected');
      await h.close(); await task.done; assert.equal(task.state, 'rejected'); assert.equal(task.error.message, 'bounded visibility observation ended');
    }
  } finally { await h.close(); }
});

test('empty-case visibility requires actual attachment and every visible ancestor, not Element.find alone', async () => {
  const h = emptyCaseHarness();
  try {
    const task = h.start(); h.settings.resolve(settingsReply()); h.catalog.resolve(catalogReply()); await h.observe(); await task.done; assert.equal(task.state, 'fulfilled');
    const node = h.locator('Open synthetic session').nodes()[0];
    for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
      ancestor.hidden = true;
      const wait = {state:'pending'}; const done = h.expect(h.locator('Open synthetic session')).toBeVisible().then(() => {wait.state='fulfilled';});
      await h.observe(); assert.equal(wait.state, 'pending'); assert.ok(h.realm.root.find(n => n === node).length === 1);
      ancestor.hidden = false; await h.observe(); await done; assert.equal(wait.state, 'fulfilled');
    }
    const parent = node.parent; node.remove();
    const wait = {state:'pending'}; const done = h.expect({nodes:() => [node]}).toBeVisible().then(() => {wait.state='fulfilled';});
    await h.observe(); assert.equal(wait.state, 'pending'); assert.equal(h.visible(node), false);
    parent.append(node); await h.observe(); await done; assert.equal(wait.state, 'fulfilled');
  } finally { await h.close(); }
});

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
