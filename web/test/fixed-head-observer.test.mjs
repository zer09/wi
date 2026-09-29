import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as api from '../dist/api.js';
import * as sse from '../dist/sse.js';
import { applyEvent, createConversation, selectDisplay } from '../dist/state.js';
import { installFixedHeadObserver } from '../test-support/fixed-head.mjs';
import { event, json, stream, tick } from './client-fixtures.mjs';
import { sid, otherSid, frame, response as responseView, item, summary } from './wire-fixtures.mjs';

const origin = 'http://127.0.0.1:43210';
const options = { session:sid, initialTitle:'Fixed head 65', renamedTitle:'renamed', task:'synthetic observer task', answer:'42 雪\r\nanswer',
  argumentsText:'{"a":17,"b":25}', output:'{"sum":42}', owner:'ab'.repeat(32) };
const init = { method:'GET', mode:'same-origin', credentials:'omit', cache:'no-store', redirect:'error', headers:{ authorization:`Bearer ${options.owner}` } };
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => v instanceof Map ? [...v] : v));
const history = index => {
  const start = [1,33,65][index]; const end = [32,64,66][index];
  return { api_version:1, session_id:sid, through_sequence:'66', next_after:`${sid}:${end}`, has_more:index < 2,
    events:Array.from({length:end-start+1}, (_, i) => event(start+i === 1 ? 'session.created' : 'session.renamed', start+i, sid,
      start+i === 1 ? {title:'Fixed head 0',workspace:null} : {title:`Fixed head ${start+i-1}`})) };
};
const path = index => `/v1/sessions/${sid}/history?after=${sid}:${[0,32,64][index]}&limit=32${index ? '&through=66' : ''}`;
const eventsPath = `/v1/sessions/${sid}/events?after=${sid}:66`;
const disconnected = { connection:'disconnected', pending:[], recoveries:[], last_mutation:null, draft:'', selected:null };
function snapshot(sequence, display = []) {
  return { ...disconnected, connection:'connected', selected:{ session_id:sid, applied_cursor:`${sid}:${sequence}`,
    through_sequence:'66', observation_error:null, title:BigInt(sequence) <= 66n ? options.initialTitle : options.renamedTitle, display } };
}
function observer(fetch, timeout = setTimeout) {
  const source = installFixedHeadObserver.toString().replace("import('/assets/api.js')", 'Promise.resolve(validators)')
    .replace("import('/assets/sse.js')", 'Promise.resolve(sseModule)');
  const page = { fetch, URL, URLSearchParams, Request, Headers, TextDecoder, setTimeout:timeout, clearTimeout,
    validators:api, sseModule:sse, location:{href:`${origin}/`,origin} };
  runInNewContext(`(${source})(${JSON.stringify(options)}); globalThis.publish = value => Object.freeze(value);`, page, {timeout:1000});
  page.capture = page.fixedHeadCapture;
  return page;
}
async function pages(page) {
  for (let index=0; index<3; index++) {
    const original = await page.fetch(path(index),init);
    await original.text();
    await page.capture.drain();
    page.publish(snapshot(String([32,64,66][index])));
  }
}
async function close(page) { page.publish(disconnected); await page.capture.drain(); }

// Unit-only DTOs exercise the observer. Joined evidence uses no substituted response.
function timeline() {
  const tool = {call_id:'call',tool_name:'add_numbers',request_id:'request'};
  const final = { ...responseView, outcome:{status:'completed'}, output_provenance:'native_terminal', usage:null };
  const counters = { ...summary, turns_started:'2',turns_finished:'2',model_requests_attempted:'2',model_requests_admitted:'2',new_tool_dispatches:'1',tool_results_prepared:'1',reused_results:'0' };
  const result = { outcome:{type:'completed'}, summary:counters, events_complete:true, sink_error:null };
  const turn = n => ({turn_id:`turn-${n}`,number:String(n)});
  const message = {...item, item_id:'answer', content:[]};
  const specs = [
    ['session.renamed',{title:options.renamedTitle}],
    ['run.accepted',{user_text:options.task,provider_id:'synthetic',model:'synthetic',available_skills:[],active_skills:[]}],
    ['checkpoint',{}],['run.started',{}],['checkpoint',{}],['turn.started',turn(1)],
    ['response.started',{response_id:'first'}],
    ['response.finished',{...final,response_id:'first',text:'',items:[{item_id:'call',kind:'function_call',content:[],unsupported_content:false,
      function_call:{call_id:'call',name:'add_numbers',arguments:options.argumentsText,origin:'direct',namespace:null,complete:true}}]}],
    ['tool.started',tool],['tool.result',{call_id:'call',request_id:'request',output:options.output,is_error:false}],['tool.finished',{...tool,is_error:false}],
    ['turn.finished',{...turn(1),response_id:'first',outcome:{type:'tools_prepared'},upstream_outcome:'terminal_received'}],
    ['turn.started',turn(2)],['response.started',{response_id:'second'}],
    ['response.item.started',{response_id:'second',output_index:'0',item:message}],
    ['response.delta',{response_id:'second',item_id:'answer',output_index:'0',content_index:'0',summary_index:null,kind:'text',delta:options.answer.split('\r')[0]}],
    ['response.finished',{...final,response_id:'second',text:options.answer,items:[{...message,content:[{kind:'text',text:options.answer}]}]}],
    ['turn.finished',{...turn(2),response_id:'second',outcome:{type:'model_completed'},upstream_outcome:'terminal_received'}],
    ['run.finished',{outcome:result.outcome,summary:counters}],['run.result',result],
  ];
  let state = createConversation(sid);
  for (let index=0; index<3; index++) for (const e of history(index).events) state = applyEvent(state,e);
  return specs.map(([kind,data],index) => {
    const e = event(kind,index+67,sid,data); state = applyEvent(state,e);
    return {event:e,state:snapshot(e.sequence,plain(selectDisplay(state)))};
  });
}

test('fixed-head observer passes original responses through and retains only bounded public proof', async () => {
  const wire = stream(); let requests = 0;
  const page = observer(async url => { requests++; return url.includes('/events?') ? wire.response : json(history(requests-1)); });
  await pages(page);
  assert.equal(await page.fetch(eventsPath,init),wire.response);
  const records = timeline();
  for (const record of records) { wire.push(frame(record.event)); page.publish(record.state); }
  for (let n=0; n<100 && page.capture.summary().delivered.length < 20; n++) await tick();
  const proof = plain(page.capture.summary());
  assert.equal(requests,4);
  assert.deepEqual(proof.pageCounts,['32','32','2']); assert.deepEqual(proof.pageEnds,['32','64','66']);
  assert.deepEqual(proof.applied,['32','64','66',...records.map(r => r.event.sequence)]);
  assert.deepEqual(proof.delivered,records.map(r => r.event.sequence)); assert.deepEqual(proof.failures,[]);
  assert.ok(proof.noEarly && proof.reduced && proof.checkpoint);
  assert.equal(JSON.stringify(proof).includes(sid),false); assert.equal(JSON.stringify(proof).includes(options.task),false);
  await close(page); assert.equal(page.capture.cleared(),true); assert.deepEqual(plain(page.capture.summary()),proof);
  await wire.response.body.cancel();
});

test('fixed-head observer detects cursor jumps, regressions, invalid identities and early post-head application without throwing', async () => {
  for (const next of ['31','64','67','not-a-sequence','129']) {
    const page = observer(async () => json(history(0)));
    assert.doesNotThrow(() => page.publish({...snapshot('32'),selected:{...snapshot('32').selected,applied_cursor:`${sid}:${next}`}}));
    assert.ok(page.capture.summary().failures.length > 0); await close(page);
  }
  const page = observer(async () => json(history(0)));
  page.publish(snapshot('32')); page.publish(snapshot('64')); page.publish(snapshot('32'));
  page.publish({...snapshot('66'),selected:{...snapshot('66').selected,applied_cursor:`${otherSid}:66`}});
  assert.ok(page.capture.summary().failures.includes('state:sequence'));
  assert.ok(page.capture.summary().failures.includes('state:cursor')); await close(page);
});

test('fixed-head observer rejects advancing before the corresponding reducer effects at every visible transition', async () => {
  const records = timeline();
  for (let index=0; index<records.length; index++) {
    if (records[index].event.kind === 'checkpoint') continue; // Checkpoints deliberately have no visible effect.
    const wire = stream(); let count = 0;
    const page = observer(async url => url.includes('/events?') ? wire.response : json(history(count++)));
    await pages(page); await page.fetch(eventsPath,init);
    for (const r of records.slice(0,index)) page.publish(r.state);
    const bad = structuredClone(records[index].state);
    const previous = index === 0 ? snapshot('66').selected : records[index-1].state.selected;
    bad.selected.display = previous.display; bad.selected.title = previous.title;
    page.publish(bad);
    assert.ok(page.capture.summary().failures.includes('state:reducer'),`transition ${index+67}`);
    await close(page); await wire.response.body.cancel();
  }
});

test('fixed-head observer rejects wrong page heads, counts, cursors, order, metadata and post-head contamination', async () => {
  for (const mutate of [v => {v.through_sequence='67';},v => {v.events.pop();},v => {v.next_after=`${sid}:31`;},
    v => {v.has_more=false;},v => {v.events.reverse();},v => {v.events[0].data.title='wrong';},
    v => {v.events[0]=event('session.renamed',67,sid,{title:options.renamedTitle});},v => {v.session_id=otherSid;}]) {
    const bad = history(0); mutate(bad);
    const page = observer(async () => json(bad));
    await page.fetch(path(0),init); await page.capture.drain();
    assert.ok(page.capture.summary().failures.length > 0); assert.deepEqual(plain(page.capture.summary().applied),[]); await close(page);
  }
});

test('fixed-head observer rejects duplicate/gapped SSE, checkpoint payloads, control frames and EOF', async () => {
  for (const body of [frame(event('session.renamed',68,sid,{title:'renamed'})),
    frame(event('session.renamed',67,sid,{title:'renamed'})).repeat(2),
    frame(event('session.renamed',67,sid,{title:'renamed'}))+frame(event('run.accepted',68))+frame(event('checkpoint',69,sid,{extra:true})),
    'event: wi.closed\ndata: {"api_version":1,"reason":"shutdown"}\n\n', ': heartbeat\n\n']) {
    let count=0;
    const page = observer(async url => url.includes('/events?') ? new Response(body,{headers:{'content-type':'text/event-stream'}}) : json(history(count++)));
    await pages(page); await page.fetch(eventsPath,init); await page.capture.drain();
    assert.ok(page.capture.summary().failures.length > 0); await close(page);
  }
});

test('fixed-head observer bounds clones, rejects private/malformed replies and cancels stalled clone reads', async () => {
  for (const reply of [new Response('{'),json({private:'principal_digest'}),json('x'.repeat(65537)),json(history(0),500)]) {
    const page = observer(async () => reply); await page.fetch(path(0),init); await page.capture.drain();
    assert.ok(page.capture.summary().failures.length > 0); await close(page);
  }
  let cancelled=0;
  const original=json(history(0)); original.clone=() => ({body:{getReader:() => ({read:() => new Promise(() => {}),cancel:async () => {cancelled++;}})}});
  const page=observer(async () => original, callback => setTimeout(callback,10));
  assert.equal(await page.fetch(path(0),init),original); await page.capture.drain(); assert.equal(cancelled,1);
  assert.deepEqual(plain(page.capture.summary().failures),['page:read']);
  for (let i=0; i<10; i++) await page.fetch(path(0),init);
  await page.capture.drain(); assert.equal(page.capture.summary().pageRequests,4); await close(page);
});

test('fixed-head observer fences late replies and restores native hooks on Disconnect', async () => {
  let release; const page=observer(() => new Promise(resolve => {release=resolve;}));
  page.publish(snapshot('32'));
  const pending=page.fetch(path(0),init); await close(page); release(json(history(0))); await pending;
  assert.ok(page.capture.summary().failures.includes('reply:late')); assert.equal(page.capture.cleared(),true);
});
