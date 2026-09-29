import assert from 'node:assert/strict';
import test from 'node:test';
import { reconnectEvidence, reconnectProtocol, startScenario } from '../test-support/read-reconnect-protocol.mjs';
import { parseControl, stdoutParser } from '../test-support/fixture.mjs';
const scenario={transport:'websocket',recovered:false,mime:true,read_reconnect:true};
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const pending={protocol:1,id:3,event:'read_reconnect',step:'pending',window:0,subscription:1,session_id:ids[0],run_id:ids[1],operation_id:ids[2],
  head:6,rename_count:0,rename_operation:null,rename_event:null,frame_bytes:0,yielded_bytes:0,connections:1,requests:1,exact:true};
test('read reconnect exclusive native mode rejects incompatible modes and private/extra fields',() => {
  assert.deepEqual(startScenario(scenario),scenario);
  for(const field of ['cancellation','lifecycle_failure','tool_fidelity','mutations','presentation','unbound_history','fixed_head'])assert.throws(() => startScenario({...scenario,[field]:true}));
  for(const change of [{transport:'sse'},{recovered:true},{mime:false},{owner:'private'},{read_reconnect:1}])assert.throws(() => startScenario({...scenario,...change}));
});
test('read reconnect flat evidence rejects duplicate escaped private and malformed fields before parsing',() => {
  assert.deepEqual(parseControl(pending),pending);
  const valid=JSON.stringify(pending);
  const parser=stdoutParser(v => assert.deepEqual(v,pending));parser.push(Buffer.from(valid+'\n'));parser.end();
  for(const raw of [valid.replace('"id":3','"id":3,"id":3'),valid.replace('"id"','"\\u0069d"'),valid.slice(0,-1),valid.replace('"exact":true','"exact":true,"token":"private"')])assert.throws(() => reconnectEvidence(raw));
  for(const change of [{head:7},{connections:2},{requests:0},{exact:false},{yielded_bytes:1},{rename_event:ids[0]},{session_id:ids[1]},{extra:true}])assert.throws(() => reconnectEvidence({...pending,...change}));
});
function started() {
  const p=reconnectProtocol(true);
  p.request({...scenario,transport:'web_socket',id:1,owner:'a'.repeat(64)});p.reply({protocol:1,id:1,event:'ready',origin:'http://127.0.0.1:1234'});
  p.request({command:'select',id:2,session_id:ids[0]});p.reply({protocol:1,id:2,event:'selected'});return p;
}
const request={command:'read_reconnect',id:3,step:'pending',window:0,subscription:1,session_id:ids[0],run_id:ids[1],operation_id:ids[2]};
test('read reconnect controls fence order identity subscription and stale release',() => {
  for(const change of [{step:'release'},{subscription:2},{session_id:ids[1]},{run_id:ids[0]},{window:1},{extra:true},{id:2}])assert.throws(() => started().request({...request,...change}));
  const p=started();p.request(request);assert.throws(() => p.request({...request,id:4}));p.reply(pending);
  assert.throws(() => p.reply(pending));assert.throws(() => p.request({...request,id:4}));
  const disabled=reconnectProtocol(false);assert.throws(() => disabled.request(request));assert.throws(() => disabled.reply(pending));
});
