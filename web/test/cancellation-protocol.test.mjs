import assert from 'node:assert/strict';
import test from 'node:test';
import { cancellationEvidence, cancellationProtocol, startScenario } from '../test-support/cancellation-protocol.mjs';
import { stdoutParser } from '../test-support/fixture.mjs';
const sid='11111111-1111-4111-8111-111111111111';const rid='22222222-2222-4222-8222-222222222222';
const oid='33333333-3333-4333-8333-333333333333';const terminal='44444444-4444-4444-8444-444444444444';
const other='55555555-5555-4555-8555-555555555555';
const scenario={transport:'websocket',recovered:false,mime:true,cancellation:true};
const reply=(id,event,extra={}) => ({protocol:1,id,event,...extra});
const task={session_id:sid,run_id:rid,operation_id:oid};
const pending=reply(4,'cancellation_pending',{...task,sequence_count:'6',connections:1,requests:1,closed:false,exact:true});
const paused=reply(5,'cancellation_paused',{...task,terminal_operation_id:terminal,sequence_count:'7',connections:1,requests:1,closed:true,hits:1,exact:true});
const audit=id => reply(id,'cancellation_inspect',{...task,terminal_operation_id:terminal,hits:1,exact:true,sequence_count:'9',
  connections:1,requests:1,closed:true,dispatches:0,prepared_results:0,result_records:1,reused:0,retired:true,prefix_unchanged:true});
function flow() {return [
  ['request',{...scenario,transport:'web_socket',id:1,owner:'ab'.repeat(32)}],['reply',reply(1,'ready',{origin:'http://127.0.0.1:1234'})],
  ['request',{command:'select',id:2,session_id:sid}],['reply',reply(2,'selected')],
  ['request',{command:'arm_cancellation',id:3}],['reply',reply(3,'cancellation_armed')],
  ['request',{command:'wait_cancellation_pending',id:4,...task}],['reply',pending],
  ['request',{command:'wait_cancellation',id:5}],['reply',paused],
  ['request',{command:'release_cancellation',id:6,terminal_operation_id:terminal}],['reply',reply(6,'cancellation_released')],
  ['request',{command:'inspect_cancellation',id:7}],['reply',audit(7)],
  ['request',{command:'inspect_cancellation',id:8}],['reply',audit(8)],
  ['request',{command:'inspect_cancellation',id:9}],['reply',audit(9)],
  ['request',{command:'stop',id:10}],['reply',reply(10,'stopped',{cleaned:true})],
];}
function until(index) {const p=cancellationProtocol(true);for(const [method,v] of flow().slice(0,index))p[method](v);return p;}
const rejected=fn => assert.throws(fn,error => error.message === 'fixture protocol rejected');
test('exclusive cancellation protocol accepts the closed flow and distinct terminal append identity',() => {
  assert.deepEqual(startScenario(scenario),scenario);
  const p=cancellationProtocol(true);for(const [method,v] of flow())p[method](JSON.stringify(v));
  for(const v of [pending,paused,audit(7)])assert.deepEqual(cancellationEvidence(JSON.stringify(v)),v);
});
test('cancellation start rejects incompatible missing duplicate escaped malformed and private fields',() => {
  for(const key of ['transport','recovered','mime']) {const v={...scenario};delete v[key];rejected(() => startScenario(v));}
  for(const [key,v] of [['lifecycle_failure',true],['tool_fidelity',true],['mutations',true],['presentation',true],['unbound_history',true],['fixed_head',true],
    ['transport','sse'],['mime',false],['recovered',true],['cancellation',null],['private',false]])rejected(() => startScenario({...scenario,[key]:v}));
  const raw=JSON.stringify(scenario);
  for(const key of Object.keys(scenario)) {
    rejected(() => startScenario(`{"${key}":${JSON.stringify(scenario[key])},${raw.slice(1)}`));
    rejected(() => startScenario(raw.replace(`"${key}"`,`"\\u${key.charCodeAt(0).toString(16).padStart(4,'0')}${key.slice(1)}"`)));
  }
});
test('every cancellation control and message rejects missing extra duplicate escaped malformed and duplicate delivery',() => {
  for(const [index,[method,v]] of flow().entries()) {
    for(const key of Object.keys(v)) {
      const missing={...v};delete missing[key];rejected(() => until(index)[method](missing));
      const raw=JSON.stringify(v);
      rejected(() => until(index)[method](`{"${key}":${JSON.stringify(v[key])},${raw.slice(1)}`));
      rejected(() => until(index)[method](raw.replace(`"${key}"`,`"\\u${key.charCodeAt(0).toString(16).padStart(4,'0')}${key.slice(1)}"`)));
    }
    rejected(() => until(index)[method]({...v,private:false}));
    for(const bad of ['null','[]','{','{}'])rejected(() => until(index)[method](bad));
    for(const id of [0,-1,1.5,'2',4294967296,null])rejected(() => until(index)[method]({...v,id}));
    const p=until(index);p[method](v);rejected(() => p[method](v));
  }
});
test('cancellation controls reject order identity counters unsolicited evidence and competing modes',() => {
  for(const [index,[method,v]] of flow().entries())if(index > 2 && method === 'request' && v.command !== 'stop')rejected(() => until(2)[method](v));
  for(const index of [6,7,9,13,15,17])for(const key of ['session_id','run_id','operation_id']) {
    const [method,v]=flow()[index];if(index === 6 && key !== 'session_id')continue;
    rejected(() => until(index)[method]({...v,[key]:other}));
  }
  for(const index of [9,10,13,15,17]) {
    const [method,v]=flow()[index];rejected(() => until(index)[method]({...v,terminal_operation_id:index === 9 ? oid : other}));
  }
  for(const v of [pending,paused,audit(7)])for(const key of Object.keys(v))rejected(() => cancellationEvidence({...v,[key]:null}));
  const off=cancellationProtocol(false);rejected(() => off.request({command:'arm_cancellation'}));rejected(() => off.reply(paused));
  for(const command of ['arm_acceptance','arm_lifecycle_failure','drive','inspect'])rejected(() => until(4).request({command,id:3}));
  rejected(() => until(8).reply(paused));rejected(() => until(18).request({command:'inspect_cancellation',id:10}));
  rejected(() => until(6).reply({protocol:1,event:'model_paused',gate:1}));
});
test('stdout cancellation parser rejects ambiguous raw messages before JSON loses their keys',() => {
  for(const [,v] of flow().filter(([method]) => method === 'reply')) {
    const raw=JSON.stringify(v);const key=Object.keys(v)[0];
    for(const bad of [`{"${key}":${JSON.stringify(v[key])},${raw.slice(1)}`,raw.replace(`"${key}"`,`"\\u0070${key.slice(1)}"`)])
      rejected(() => stdoutParser(() => {}).push(Buffer.from(`${bad}\n`)));
    let parsed;stdoutParser(value => {parsed=value;}).push(Buffer.from(`${raw}\n`));assert.deepEqual(parsed,v);
  }
});
