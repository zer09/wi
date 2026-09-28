import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { installReadReconnectObserver } from '../test-support/read-reconnect.mjs';
const sid='11111111-1111-4111-8111-111111111111';
const owner='a'.repeat(64);
function realm() {
  let touches=0;
  const response={status:200,headers:new Headers({'content-type':'text/event-stream'}),clone(){touches++;throw new Error();},get body(){touches++;throw new Error();}};
  const local=(Base,key) => {class Local extends Base {}Object.defineProperty(Local.prototype,key,Object.getOwnPropertyDescriptor(Base.prototype,key));return Local;};
  const ctx=createContext({URL,Request,Headers,TextDecoder:local(TextDecoder,'decode'),ReadableStream:local(ReadableStream,'getReader'),
    ReadableStreamDefaultReader:local(ReadableStreamDefaultReader,'read'),location:{href:'http://127.0.0.1:1234/',origin:'http://127.0.0.1:1234'},fetch:async () => response,
    input:{fixture:{title:'test',task:'task',titles:['A','B','C']},owner},sid,owner});
  runInContext(`(${installReadReconnectObserver.toString()})(input)`,ctx);
  const evaluate=code => runInContext(code,ctx);
  return {evaluate,touches:() => touches};
}
const options=`{mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{authorization:'Bearer '+owner}}`;
const frozen=`function freeze(v){if(v && typeof v === 'object')for(const x of Object.values(v))freeze(x);return Object.freeze(v);}`;
const snapshot=n => `freeze({connection:'connected',pending:[],recoveries:[],last_mutation:null,draft:'',selected:{session_id:sid,applied_cursor:sid+':${n}',observation:'streaming'}})`;
test('read reconnect observer never accesses the SSE body and restores instrumented globals on Disconnect',async () => {
  const r=realm();await r.evaluate(`fetch('/v1/sessions/'+sid+'/history?after='+sid+':0',${options})`);
  r.evaluate(frozen+snapshot(0));await r.evaluate(`fetch('/v1/sessions/'+sid+'/events?after='+sid+':0',${options})`);
  assert.equal(r.touches(),0);
  r.evaluate(`freeze({connection:'disconnected',pending:[],recoveries:[],last_mutation:null,draft:'',selected:null})`);
  assert.equal(r.evaluate('readReconnectCapture.cleared()'),true);assert.equal(r.touches(),0);
});
test('read reconnect observer distinguishes copied production ledger prefixes from new application',async () => {
  const r=realm();await r.evaluate(`fetch('/v1/sessions/'+sid+'/history?after='+sid+':0',${options})`);
  r.evaluate(frozen+snapshot(0));
  r.evaluate(`const e={api_version:1,session_id:sid,sequence:'1',event_id:'22222222-2222-4222-8222-222222222222'};let ledger=new Map();ledger.set('1',JSON.stringify(e));`+snapshot(1));
  r.evaluate('ledger=new Map(ledger)');
  assert.equal(r.evaluate('readReconnectCapture.summary().failures.length'),0);
  assert.equal(r.evaluate('readReconnectCapture.summary().head'),1);
  r.evaluate(`ledger.set('1',JSON.stringify({...e,event_id:sid}))`);
  assert.equal(r.evaluate('readReconnectCapture.summary().failures[0]'),'ledger');
});
