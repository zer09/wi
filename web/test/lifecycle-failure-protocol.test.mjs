import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleEvidence, lifecycleProtocol, startScenario } from '../test-support/lifecycle-failure-protocol.mjs';
import { stdoutParser } from '../test-support/fixture.mjs';
const sid='11111111-1111-4111-8111-111111111111';const rid='22222222-2222-4222-8222-222222222222';
const oid='33333333-3333-4333-8333-333333333333';const final='44444444-4444-4444-8444-444444444444';
const other='55555555-5555-4555-8555-555555555555';
const scenario={transport:'websocket',recovered:false,mime:true,lifecycle_failure:true};
const reply=(id,event,extra={}) => ({protocol:1,id,event,...extra});
const task={session_id:sid,run_id:rid,operation_id:oid};
const paused=reply(6,'lifecycle_failure_paused',{...task,final_operation_id:final,hits:1,exact:true});
const audit=id => reply(id,'lifecycle_failure_inspect',{...task,final_operation_id:final,hits:1,exact:true,sequence_count:'19',
  connections:1,requests:2,dispatches:1,prepared_results:1,result_rows:1,reused:0,retired:true,prior_unchanged:true});
function flow() {return [
  ['request',{...scenario,transport:'web_socket',id:1,owner:'ab'.repeat(32)}],['reply',reply(1,'ready',{origin:'http://127.0.0.1:1234'})],
  ['request',{command:'select',id:2,session_id:sid}],['reply',reply(2,'selected')],
  ['request',{command:'arm_lifecycle_failure',id:3}],['reply',reply(3,'lifecycle_failure_armed')],
  ['reply',{protocol:1,event:'model_paused',gate:1}],['request',{command:'drive',id:4,gate:1}],['reply',reply(4,'driven')],
  ['reply',{protocol:1,event:'model_paused',gate:2}],['request',{command:'drive',id:5,gate:2}],['reply',reply(5,'driven')],
  ['request',{command:'wait_lifecycle_failure',id:6,...task}],['reply',paused],
  ['request',{command:'release_lifecycle_failure',id:7,final_operation_id:final}],['reply',reply(7,'lifecycle_failure_released')],
  ['request',{command:'inspect_lifecycle_failure',id:8}],['reply',audit(8)],
  ['request',{command:'inspect_lifecycle_failure',id:9}],['reply',audit(9)],
  ['request',{command:'stop',id:10}],['reply',reply(10,'stopped',{cleaned:true})],
];}
function until(index) {const p=lifecycleProtocol(true);for(const [method,v] of flow().slice(0,index))p[method](v);return p;}
const rejected=fn => assert.throws(fn,error => error.message === 'fixture protocol rejected');
test('exclusive lifecycle protocol accepts the closed flow and distinct final append identity',() => {
  assert.deepEqual(startScenario(scenario),scenario);
  const p=lifecycleProtocol(true);for(const [method,v] of flow())p[method](JSON.stringify(v));
  assert.deepEqual(lifecycleEvidence(JSON.stringify(audit(8))),audit(8));
});
test('lifecycle start rejects incompatible missing duplicate escaped malformed and unknown fields',() => {
  for(const key of ['transport','recovered','mime']) {const v={...scenario};delete v[key];rejected(() => startScenario(v));}
  for(const [key,v] of [['tool_fidelity',true],['mutations',true],['presentation',true],['unbound_history',true],['fixed_head',true],
    ['transport','sse'],['mime',false],['recovered',true],['lifecycle_failure',null],['extra',false]])rejected(() => startScenario({...scenario,[key]:v}));
  const raw=JSON.stringify(scenario);
  for(const key of Object.keys(scenario)) {
    rejected(() => startScenario(`{"${key}":${JSON.stringify(scenario[key])},${raw.slice(1)}`));
    rejected(() => startScenario(raw.replace(`"${key}"`,`"\\u${key.charCodeAt(0).toString(16).padStart(4,'0')}${key.slice(1)}"`)));
  }
});
test('every lifecycle control and message rejects missing extra duplicate escaped malformed and duplicate delivery',() => {
  for(const [index,[method,v]] of flow().entries()) {
    for(const key of Object.keys(v)) {
      if(index === 0 && key === 'lifecycle_failure')continue;
      const missing={...v};delete missing[key];rejected(() => until(index)[method](missing));
      const raw=JSON.stringify(v);
      rejected(() => until(index)[method](`{"${key}":${JSON.stringify(v[key])},${raw.slice(1)}`));
      rejected(() => until(index)[method](raw.replace(`"${key}"`,`"\\u${key.charCodeAt(0).toString(16).padStart(4,'0')}${key.slice(1)}"`)));
    }
    rejected(() => until(index)[method]({...v,extra:false}));
    for(const bad of ['null','[]','{','{}'])rejected(() => until(index)[method](bad));
    const p=until(index);p[method](v);rejected(() => p[method](v));
  }
});
test('lifecycle controls reject out-of-order competing wrong-session wrong-operation and unsolicited evidence',() => {
  for(const [index,[method,v]] of flow().entries())if(index > 2 && method === 'request' && v.command !== 'stop')rejected(() => until(2)[method](v));
  for(const index of [12,13,17,19])for(const key of ['session_id','run_id','operation_id']) {
    const [method,v]=flow()[index];if(index === 12 && key !== 'session_id')continue;
    rejected(() => until(index)[method]({...v,[key]:other}));
  }
  for(const index of [13,14,17,19]) {
    const [method,v]=flow()[index];rejected(() => until(index)[method]({...v,final_operation_id:index === 13 ? oid : other}));
  }
  for(const key of Object.keys(audit(8)).filter(k => !['event','id','protocol','session_id','run_id','operation_id','final_operation_id'].includes(k)))rejected(() => lifecycleEvidence({...audit(8),[key]:null}));
  const off=lifecycleProtocol(false);rejected(() => off.request({command:'arm_lifecycle_failure'}));rejected(() => off.reply(paused));
  rejected(() => until(4).request({command:'arm_acceptance',id:3}));rejected(() => until(6).reply(paused));
});
test('stdout lifecycle parser rejects ambiguous raw messages before JSON loses their keys',() => {
  for(const v of [paused,audit(8),reply(2,'selected'),{protocol:1,event:'model_paused',gate:1}]) {
    const raw=JSON.stringify(v);const key=Object.keys(v)[0];
    for(const bad of [`{"${key}":${JSON.stringify(v[key])},${raw.slice(1)}`,raw.replace(`"${key}"`,`"\\u0070${key.slice(1)}"`)])
      rejected(() => stdoutParser(() => {}).push(Buffer.from(`${bad}\n`)));
  }
});
