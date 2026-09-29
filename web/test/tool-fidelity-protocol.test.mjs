import assert from 'node:assert/strict';
import test from 'node:test';
import { startScenario, toolFidelityEvidence, toolFidelityProtocol } from '../test-support/tool-fidelity-protocol.mjs';
import { parseControl, stdoutParser } from '../test-support/fixture.mjs';

const sid = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const operation = '33333333-3333-4333-8333-333333333333';
const scenario = {transport:'websocket',recovered:false,mime:true,tool_fidelity:true};
const start = {...scenario,transport:'web_socket',id:1,owner:'a'.repeat(64)};
const evidence = {protocol:1,id:8,event:'tool_fidelity_inspect',session_id:sid,run_id:run,operation_id:operation,completed:1,
  sequence_count:'30',requests:3,new_dispatches:2,reused:1,result_rows:2,prepared_results:3,executions:1,exact:true,prior_unchanged:true};
const rejects = callback => assert.throws(callback, /^Error: fixture protocol rejected$/);
function malformed(value, parse) {
  const raw = JSON.stringify(value);
  for (const field of Object.keys(value)) {
    const missing = {...value}; delete missing[field]; rejects(() => parse(JSON.stringify(missing)));
    rejects(() => parse(`{"${field}":${JSON.stringify(value[field])},${raw.slice(1)}`));
    rejects(() => parse(raw.replace(`"${field}"`,`"\\u${field.charCodeAt(0).toString(16).padStart(4,'0')}${field.slice(1)}"`)));
  }
  rejects(() => parse(JSON.stringify({...value,extra:true})));
  for (const raw of ['null','[]','{}','{','false']) rejects(() => parse(raw));
}
function setup() {
  const p = toolFidelityProtocol(true);
  p.request(start); p.reply({protocol:1,id:1,event:'ready',origin:'http://127.0.0.1:1234'});
  p.request({command:'select',id:2,session_id:sid}); p.reply({protocol:1,id:2,event:'selected'});
  return p;
}
function complete(p) {
  for (let gate=1;gate<=3;gate++) {
    p.reply({protocol:1,event:'model_paused',gate});
    p.request({command:'drive',id:gate+2,gate}); p.reply({protocol:1,event:'driven',id:gate+2});
  }
  p.reply({protocol:1,event:'task_finished',task:1}); p.request({command:'inspect_tool_fidelity',id:8});
}
test('exclusive scenario and raw outgoing audit controls reject missing unknown duplicate escaped and incompatible fields', () => {
  assert.deepEqual(startScenario(JSON.stringify(scenario)),scenario);
  // Optional scenario flag may be absent in all existing tests.
  for (const field of ['transport','recovered','mime']) {const bad={...scenario};delete bad[field];rejects(() => startScenario(bad));}
  for (const [field,value] of [['transport','sse'],['mime',false],['recovered',true],['tool_fidelity',1],['tool_fidelity',null],
    ...['mutations','presentation','fixed_head','unbound_history'].map(key => [key,true])]) rejects(() => startScenario({...scenario,[field]:value}));
  const parse = raw => {const p=toolFidelityProtocol(true);p.request(raw);};
  malformed(start,parse);
  const audit = raw => {const p=setup();completeWithoutAudit(p);p.request(raw);};
  function completeWithoutAudit(p) {
    for(let gate=1;gate<=3;gate++){p.reply({protocol:1,event:'model_paused',gate});p.request({command:'drive',id:gate+2,gate});p.reply({protocol:1,event:'driven',id:gate+2});}
    p.reply({protocol:1,event:'task_finished',task:1});
  }
  malformed({command:'inspect_tool_fidelity',id:8},audit);
  for (const id of [0,-1,1,2,5,1.5,'8',null,4294967296]) rejects(() => audit(JSON.stringify({command:'inspect_tool_fidelity',id})));
  for (const command of ['inspect','inspect_task','rotate_account','arm_acceptance','replay_head']) rejects(() => setup().request({command,id:3}));
});
test('closed raw audit response detects duplicates before JSON.parse can discard them', () => {
  assert.deepEqual(toolFidelityEvidence(JSON.stringify(evidence)),evidence);
  assert.deepEqual(parseControl(evidence),evidence);
  const parse = raw => stdoutParser(() => {}).push(Buffer.from(`${raw}\n`));
  malformed(evidence,parse);
  for (const [field,value] of [['id',0],['id',4294967296],['requests',2],['new_dispatches',1],['reused',0],['result_rows',3],['prepared_results',2],
    ['executions',0],['exact',false],['prior_unchanged',false],['sequence_count','01'],['sequence_count',30],['sequence_count','129'],
    ['session_id','bad'],['run_id',sid],['operation_id',run],['completed',3],['output','private'],['is_error',false]]) {
    rejects(() => parse(JSON.stringify({...evidence,[field]:value})));
  }
});
test('audit reply must be solicited once with the selected session and matching ID', () => {
  rejects(() => setup().reply(evidence));
  rejects(() => toolFidelityProtocol(false).reply(evidence));
  rejects(() => toolFidelityProtocol(false).request({command:'inspect_tool_fidelity',id:8}));
  for (const patch of [{id:9},{session_id:operation},{completed:2,requests:2,new_dispatches:1,reused:0,result_rows:1,prepared_results:1}]) {
    const p=setup();complete(p);rejects(() => p.reply({...evidence,...patch}));
  }
  const p=setup();complete(p);p.reply(evidence);rejects(() => p.reply(evidence));
  rejects(() => p.request({command:'inspect_tool_fidelity',id:9}));
  p.request({command:'stop',id:10});p.reply({protocol:1,event:'stopped',id:10,cleaned:true});
  rejects(() => p.reply(evidence));rejects(() => p.request({command:'stop',id:11}));
});
test('two-run protocol validates later gates and distinct audit identities', () => {
  for (const duplicate of ['run_id','operation_id',null]) {
    const p=setup();complete(p);p.reply(evidence);
    for (let gate=4;gate<=5;gate++) {p.reply({protocol:1,event:'model_paused',gate});p.request({command:'drive',id:gate+5,gate});p.reply({protocol:1,event:'driven',id:gate+5});}
    p.reply({protocol:1,event:'task_finished',task:2});p.request({command:'inspect_tool_fidelity',id:11});
    const second={...evidence,id:11,run_id:'44444444-4444-4444-8444-444444444444',operation_id:'55555555-5555-4555-8555-555555555555',
      completed:2,sequence_count:'50',requests:2,new_dispatches:1,reused:0,result_rows:1,prepared_results:1};
    if(duplicate){second[duplicate]=evidence[duplicate];rejects(() => p.reply(second));}else p.reply(second);
  }
});
