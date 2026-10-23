import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { decodeJson, validateRenameCommand, validateTaskCommand } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { createDisplayClient } from '../dist/display-client.js';
import * as f from '../test-support/display-fixtures.mjs';

const text = readFileSync(new URL('../e2e/task-fixed-head.spec.mjs',import.meta.url),'utf8');
const source = ts.createSourceFile('fixed-head.js',text,ts.ScriptTarget.Latest,true);
const call = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'test');
const callback = call.expression.arguments[1], attempt = callback.body.statements.find(ts.isTryStatement);
const declarations = callback.body.statements.filter(ts.isVariableStatement).map(node => node.getText(source)).join('\n');
const top = source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n');
const helper = name => attempt.tryBlock.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(source);
const listener = name => attempt.tryBlock.statements.find(ts.isForOfStatement).statement.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'context.on' && node.expression.arguments[0].text === name).expression.arguments[1].getText(source);
const expect = value => ({toBe:expected => assert.equal(value,expected)});
const PRIVATE = 'synthetic-private-rejection-not-for-diagnostics';
const origin = 'http://127.0.0.1:43210', path = `/v1/sessions/${f.SID}`;
const token = '0123456789abcdef'.repeat(4), task = '  Exact 雪\r\n<em>inert</em>\n';
const after = f.cursor('l','66','3','','');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let n=0;n<5;n++) await tick(); }
const reply = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function empty() { return f.page({snapshot_head:'66',session:f.session('66'),block:null,entries:[],previous_block:null,live_after:after}); }
function supplied(head) {
  const human = f.human({entry_id:'e:68:0',position:{sequence:'68',slot:'0'},revision:'68',content_epoch:'68',
    fields:[f.field({field_id:'text',order_key:'0',generation:'68',text:task,total_bytes:String(Buffer.byteLength(task)),to_byte:String(Buffer.byteLength(task))})]});
  const block = f.block({accepted_sequence:'68',revision:head,human});
  const entries = [];
  if (head === '86') entries.push(f.entry({entry_id:'e:73:0',position:{sequence:'73',slot:'0'},revision:'86',content_epoch:'73',
    fields:[f.field({generation:'73'})],recorded_state:'completed',provisional:false}));
  return f.page({snapshot_head:head,session:f.session(head,{title:'Renamed'}),block,entries,previous_block:null,live_after:f.cursor('l',head,'3','','')});
}
function changes(page) { return f.batch([{kind:'session.upsert',session:page.session},{kind:'block.upsert',block:page.block},
  ...page.entries.map(entry => f.upsert(entry,page.block))],page.snapshot_head); }
function stream() {
  let owner,cancels=0;
  const response = new Response(new ReadableStream({start(c){owner=c;},cancel(){cancels++;}}),{headers:{'Content-Type':'text/event-stream'}});
  return {response,push:value => owner.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${value.next_after}\ndata: ${JSON.stringify(value)}\n\n`)),cancels:() => cancels};
}

test('two public controllers publish H66 before the matching stream and coalesced held attachment converges without raw reads or POST',async t => {
  const wires=[stream(),stream()],calls=[[],[]],publications=[[],[]];
  let release;
  const held = new Promise(resolve => {release=resolve;});
  const clients = wires.map((wire,index) => createDisplayClient({fetch:async (url,init) => {
    calls[index].push({url,init,installed:clients[index].snapshot().selected?.store?.observed_head??null});
    if (url === '/v1/settings') return reply({api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:true});
    if (url === '/v1/sessions?limit=32') return reply({api_version:1,entries:[],next_after_id:null,has_more:false});
    if (url === `${path}/conversation`) return reply(empty());
    assert.equal(url,`${path}/conversation/events?after=${after}`);
    if (index === 0) await held;
    return wire.response;
  }}));
  t.after(() => {release();for (const client of clients) client.disconnect();});
  for (const [index,client] of clients.entries()) client.subscribe(value => publications[index].push(value));
  for (const index of [1,0]) {await clients[index].connect(token);await clients[index].selectSession(f.SID);await flush();}
  for (const index of [0,1]) {
    assert.equal(calls[index].at(-1).installed,'66');
    const installed=publications[index].find(value => value.selected?.store !== null && value.selected?.store !== undefined);
    assert.equal(installed.selected.observation,'loading');assert.equal(installed.selected.store.blocks.length,0);
    assert.deepEqual(calls[index].map(call => call.url),['/v1/settings','/v1/sessions?limit=32',`${path}/conversation`,`${path}/conversation/events?after=${after}`]);
    for (const call of calls[index]) {
      assert.equal(call.init.method,'GET');assert.equal(call.init.headers.Authorization,`Bearer ${token}`);
      for (const [key,value] of Object.entries({credentials:'omit',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})) assert.equal(call.init[key],value);
    }
  }
  const at72=supplied('72');wires[1].push(changes(at72));await flush();
  assert.equal(clients[0].snapshot().selected.store.observed_head,'66');assert.equal(clients[0].snapshot().selected.store.blocks.length,0);
  wires[0].push(changes(at72));release();await flush();
  assert.deepEqual(clients[0].snapshot().selected.store,clients[1].snapshot().selected.store);
  assert.equal(clients[0].snapshot().selected.store.observed_head,'72');
  const at86=supplied('86');for (const wire of wires) wire.push(changes(at86));await flush();
  assert.deepEqual(clients[0].snapshot().selected.store,clients[1].snapshot().selected.store);
  assert.equal(clients[0].snapshot().selected.store.live_after,at86.live_after);
  assert.equal(clients[0].snapshot().selected.store.blocks[0].entries[0].fields[0].ranges[0].text,'abc');
  for (const client of clients) {await client.loadOlder();client.disconnect();} await flush();
  assert.deepEqual(calls.map(calls => calls.length),[4,4]);assert.deepEqual(wires.map(wire => wire.cancels()),[1,1]);
  for (const client of clients) {const state=client.snapshot();assert.equal(state.selected,null);assert.deepEqual(state.pending,[]);assert.equal(JSON.stringify(state).includes(token),false);}
});

test('public controller rejects conflicting application atomically and retains prior cursor and fields',async t => {
  const wire=stream();
  const client=createDisplayClient({fetch:async url => {
    if (url === '/v1/settings') return reply({api_version:1,workspaces:['/synthetic/project'],provider_id:'synthetic',model:'synthetic',provider_transport:'websocket',enable_add_numbers:true});
    if (url === '/v1/sessions?limit=32') return reply({api_version:1,entries:[],next_after_id:null,has_more:false});
    if (url === `${path}/conversation`) return reply(supplied('86'));
    assert.equal(url,`${path}/conversation/events?after=${f.cursor('l','86','3','','')}`);return wire.response;
  }});
  t.after(() => client.disconnect());await client.connect(token);await client.selectSession(f.SID);await flush();
  const before=client.snapshot().selected.store;
  const entry={...supplied('86').entries[0],revision:'87',fields:[f.field({generation:'73',text:'xyz'})]};
  wire.push(f.batch([f.upsert(entry,{...supplied('86').block,revision:'87'})],'87'));await flush();
  const state=client.snapshot();assert.deepEqual(state.selected.store,before);assert.equal(state.selected.observation,'disconnected');
  assert.equal(state.selected.observation_error.category,'protocol');assert.equal(wire.cancels(),1);
});

for (const variant of ['valid','query','raw','cursor','auth','extra-body','identity','repeat']) test(`actual request collector enforces the fixed-head allowlist: ${variant}`,() => {
  const faults={external:0,request:0,private:0,collector:0},network=[{settings:0,list:0,manifest:0,latest:0,events:0,rename:0,task:0,other:0}];
  let url=`${origin}${path}/runs`,body={operation_id:f.OID,run_id:f.RID,text:task},method='POST';
  if (variant === 'query') url+='?extra=1';
  if (variant === 'raw') {url=`${origin}${path}/history`;method='GET';}
  if (variant === 'cursor') {url=`${origin}${path}/conversation/events?after=${f.cursor('l','72','3','','')}`;method='GET';}
  if (variant === 'extra-body') body.private=PRIVATE;
  if (variant === 'identity') body.run_id='00000000-0000-0000-0000-000000000000';
  const request={url:() => url,method:() => method,headers:() => ({authorization:variant === 'auth' ? 'Bearer invalid' : `Bearer ${token}`,'content-type':'application/json'}),postDataBuffer:() => Buffer.from(JSON.stringify(body))};
  const commands={rename:null,task:null},handshakes=[[]];
  const execute=() => runInNewContext(`(${listener('request')})(request)`,{request,URL,Buffer,fixture:{owner:token,origin},sid:f.SID,path,after,index:1,
    network:[{},network[0]],faults,files:new Map(),commands,handshakes:[[],handshakes[0]],paused:true,continued:false,
    leaked:() => false,TASK:task,RENAMED:'Renamed',validateRenameCommand,validateTaskCommand,parseDisplayCursor},{timeout:1000});
  execute();if (variant === 'repeat') execute();
  assert.equal(Object.values(faults).some(value => value>0)||network[0].other>0,variant !== 'valid');
  if (variant === 'valid') assert.deepEqual(commands.task,body);
});

for (const variant of ['valid','extra','wrong-session','media','size']) test(`actual reply helper validates closed matching H66: ${variant}`,async () => {
  const value=empty();if (variant === 'extra') value.private=PRIVATE;if (variant === 'wrong-session') value.session_id=f.OTHER;
  const response={status:() => 200,headers:() => ({'content-type':variant === 'media' ? 'text/plain' : 'application/json'}),
    body:async () => variant === 'size' ? Buffer.alloc(524289) : Buffer.from(JSON.stringify(value))};
  let accepted=false;
  try {await runInNewContext(`(async () => {${helper('readReply')};return readReply(response,200,v=>validateConversationPage(v,{kind:'latest'},sid));})()`,
    {expect,response,decodeJson,validateConversationPage,TextDecoder,sid:f.SID},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,variant === 'valid');
});

for (const variant of ['valid','identity','extra','completion']) test(`actual Task202 helper preserves closed receipt identity, not completion: ${variant}`,async () => {
  const value={api_version:1,receipt:{operation_id:f.OID,session_id:f.SID,run_id:f.RID,first_sequence:'68',last_sequence:'69'},duplicate:false,warning_code:null,notices:[]};
  if (variant === 'identity') value.receipt.run_id=f.OTHER;
  if (variant === 'extra') value.private=PRIVATE;
  if (variant === 'completion') value.completed=true;
  const response={status:() => 202,headers:() => ({'content-type':'application/json'}),body:async () => Buffer.from(JSON.stringify(value))};
  let accepted=false;
  try {await runInNewContext(`(async () => {${helper('readReply')};return readReply(response,202,v=>validateDisplayTaskAccepted(v,command),4096);})()`,
    {expect,response,decodeJson,validateDisplayTaskAccepted,TextDecoder,command:{operation_id:f.OID,session_id:f.SID,run_id:f.RID}},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,variant === 'valid');
});

test('actual route holds and forwards only the original A stream after installed snapshot',async () => {
  const loop=attempt.tryBlock.statements.find(ts.isForOfStatement);
  const registration=loop.statement.statements.find(node => ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)
    && ts.isCallExpression(node.expression.expression) && node.expression.expression.expression.getText(source) === 'context.route');
  const routeSource=registration.expression.expression.arguments[1].getText(source);
  let release,forwarded=0;
  const hold=new Promise(resolve => {release=resolve;});
  const request={url:() => `${origin}${path}/conversation/events?after=${after}`,method:() => 'GET'};
  const route={request:() => request,continue:async () => {forwarded++;},abort:async () => assert.fail('unexpected abort')};
  const faults={external:0,request:0,collector:0},observed={handshakes:0};
  const context={URL,route,fixture:{origin},path,index:0,pages:[{evaluate:async () => true}],TITLE:'Fixed head 65',
    handshakes:[['snapshot','stream']],faults,observed,hold,paused:false,continued:false};
  const handler=runInNewContext(`(${routeSource})`,context,{timeout:1000});
  const pending=handler(route);await flush();assert.equal(context.paused,true);assert.equal(forwarded,0);
  release();await pending;assert.equal(context.continued,true);assert.equal(forwarded,1);
  assert.equal(observed.handshakes,1);assert.deepEqual(Object.values(faults),[0,0,0]);
});

for (const html of [false,true]) test(`actual asset collector retains exact bytes/MIME and applies CSP only to HTML: ${html}`,async () => {
  const asset=html ? '/' : '/assets/app.js',file=html ? 'index.html' : 'dist/app.js';
  const faults={response:0,private:0,collector:0},reads=[],sets=[new Set()];
  const bytes=Buffer.from('synthetic compiled bytes');
  const headers={'content-type':html ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    'referrer-policy':'no-referrer','cache-control':'no-store','x-content-type-options':'nosniff'};
  if (html) headers['content-security-policy']="default-src 'none'";
  const response={url:() => origin+asset,status:() => 200,body:async () => bytes,headers:() => headers};
  runInNewContext(`(${listener('response').replaceAll('import.meta.url','sourceUrl')})(response)`,
    {response,URL,sourceUrl:new URL('../e2e/task-fixed-head.spec.mjs',import.meta.url).href,path,index:0,handshakes:[[]],
      files:new Map([[asset,file]]),assetReads:reads,assetSets:sets,faults,readFile:async () => bytes,leaked:() => false},{timeout:1000});
  await Promise.all(reads);assert.deepEqual(Object.values(faults),[0,0,0]);assert.deepEqual([...sets[0]],[asset]);
});

test('actual normalization retains stable identity, chronological order, fields and recorded flags',async () => {
  const page=supplied('86');const expected=runInNewContext(`${top};expectedBlock(page)`,{page},{timeout:1000});
  const plain=JSON.parse(JSON.stringify(expected));
  function field(value) {return {dataset:{field:value.field_id},querySelector:selector => ({textContent:selector === 'h5,summary' ? value.kind : value.metadata}),querySelectorAll:() => value.text.map(textContent => ({textContent}))};}
  function entry(value) {return {dataset:{entry:value.entry_id},querySelector:selector => ({textContent:selector === 'h4' ? value.kind : value.state}),querySelectorAll:() => value.fields.map(field)};}
  const node={dataset:{run:plain.run_id},querySelector:selector => ({textContent:selector === ':scope > .metadata' ? plain.status : plain.recording}),querySelectorAll:() => plain.entries.map(entry)};
  const result=await runInNewContext(`${top};displayedBlock(run)`,{run:{evaluate:async fn => fn(node)}},{timeout:1000});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),plain);
  assert.equal(plain.entries[0].entry_id,'e:68:0');assert.equal(plain.entries[0].fields[0].text[0],task);
  assert.equal(plain.entries[1].state,'Recorded state: completed; Provisional: false');
  node.querySelectorAll=() => [...plain.entries].reverse().map(entry);
  const reversed=await runInNewContext(`${top};displayedBlock(run)`,{run:{evaluate:async fn => fn(node)}},{timeout:1000});
  assert.notDeepEqual(JSON.parse(JSON.stringify(reversed)),plain);
});

for (const variant of ['public-field','bad-field','private-field','other-hash','private-text','storage']) test(`actual detached privacy scan limits the public field exemption: ${variant}`,async () => {
  const owner='f'.repeat(64);let removed=0;
  const dom={querySelectorAll:() => [{getAttribute:() => variant === 'bad-field' ? 'arbitrary' : variant === 'private-field' ? owner : 'a'.repeat(64),removeAttribute:() => {removed++;}}],
    get outerHTML(){return variant === 'other-hash' ? 'b'.repeat(64) : variant === 'private-text' ? PRIVATE : '<main>safe</main>';}};
  const document={documentElement:{cloneNode:() => dom},querySelectorAll:() => [],cookie:''};
  const page={evaluate:async (fn,args) => runInNewContext(`(${fn.toString()})(args)`,{args,document,location:{href:origin},history:{state:null},
    localStorage:{length:variant === 'storage' ? 1 : 0},sessionStorage:{length:0},indexedDB:{databases:async () => []},caches:{keys:async () => []},navigator:{serviceWorker:{getRegistrations:async () => []}}},{timeout:1000}),locator:() => ({count:async () => 0})};
  let accepted=false;try {await runInNewContext(`(async () => {${helper('boundary')};await boundary(page,context);})()`,{page,context:{cookies:async () => []},fixture:{owner},markers:[PRIVATE],expect},{timeout:1000});accepted=true;} catch {}
  assert.equal(accepted,variant === 'public-field');assert.equal(removed,['bad-field','private-field'].includes(variant)?0:1);
});

for (const variant of ['clean','a-close','b-close','stop']) test(`actual release and cleanup keep the first failure and exact guard: ${variant}`,async () => {
  const env={PLAYWRIGHT_NO_COPY_PROMPT:'owner-prior'},calls=[],output=[];
  const cause=Object.assign(new Error(PRIVATE),{name:'TimeoutError',cause:PRIVATE});cause.stack=PRIVATE;
  let failure;
  try {await runInNewContext(`(async () => {${top};${declarations};fixture=ownedFixture;contextA=a;contextB=b;release=()=>calls.push('release');
    process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';try {throw cause;} ${attempt.catchClause.getText(source)} finally ${attempt.finallyBlock.getText(source)}
    console.log('done');if(failure)throw failure;})()`,{process:{env},console:{log:value => output.push(value)},cause,calls,
    a:{close:async () => {calls.push('a');assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,'1');if (variant === 'a-close') throw cause;}},
    b:{close:async () => {calls.push('b');assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,'1');if (variant === 'b-close') throw cause;}},
    ownedFixture:{stop:async () => {calls.push('stop');if (variant === 'stop') throw cause;}},
  },{timeout:1000});} catch (error) {failure=error;}
  assert.deepEqual(calls,['release','a','b','stop']);assert.equal(failure.message.startsWith('Fixed head failed: startup; kind=TimeoutError;'),true);
  assert.equal([failure.message,...output].join('\n').includes(PRIVATE),false);
  assert.equal(env.PLAYWRIGHT_NO_COPY_PROMPT,['a-close','b-close'].includes(variant)?'1':'owner-prior');
});

test('actual finite classifier never evaluates message, stack, cause or name accessors',() => {
  const cause={get name(){throw Error(PRIVATE);},get message(){throw Error(PRIVATE);},get stack(){throw Error(PRIVATE);},get cause(){throw Error(PRIVATE);}};
  assert.equal(runInNewContext(`${top};failureKind(cause)`,{cause},{timeout:1000}),'other');
});

test('replacement source retains one native case and no raw observer, substitution or replay machinery',() => {
  assert.equal(source.statements.filter(node => ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(source)==='test').length,1);
  for (const banned of ['installFixedHeadObserver','addInitScript','newCDPSession','route.fulfill','/history','globalThis.fixedHeadCapture','pageCounts','applied_cursor']) assert.equal(text.includes(banned),false,banned);
  for (const gate of [1,2,3]) assert.equal(text.includes(`command:'drive',gate:${gate}`),true);
  assert.equal(text.includes('fixed_head:true'),true);
});
