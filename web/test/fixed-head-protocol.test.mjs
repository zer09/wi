import assert from 'node:assert/strict';
import test from 'node:test';
import { startScenario } from '../test-support/unbound-history-protocol.mjs';
import { fixedHeadEvidence, fixedHeadProtocol } from '../test-support/fixed-head-protocol.mjs';
import { parseControl, startFixture, stdoutParser } from '../test-support/fixture.mjs';
const sid = '12345678-1234-4234-8234-123456789abc';
const scenario = { transport:'websocket',recovered:false,mime:true,mutations:true,fixed_head:true };
const evidence = {protocol:1,id:3,event:'fixed_head_inspect',session_id:sid,phase:'initial',exact:true,prefix_unchanged:true,
  sequence_count:'66',seed_head:'1',renames:65,acceptances:0,selections:0,bindings:0,connections:0,requests:0,tools:0,completed:false,auth_loads:0,auth_prepares:0};

test('fixed-head start rejects malformed, duplicate, escaped, private and incompatible input before spawning', async () => {
  assert.deepEqual(startScenario(scenario),scenario);
  assert.equal(startScenario({transport:'sse',recovered:true,mime:false}).fixed_head,undefined);
  const invalid = ['{','null','[]','{}', ...Object.keys(scenario).flatMap(field => [
    `{${JSON.stringify(field)}:${JSON.stringify(scenario[field])},${JSON.stringify(scenario).slice(1)}`,
    JSON.stringify(scenario).replace(`"${field}"`,`"\\u${field.charCodeAt(0).toString(16).padStart(4,'0')}${field.slice(1)}"`),
  ])];
  for (const [field,value] of [['fixed_head',null],['fixed_head',1],['fixed_head','true'],['mutations',false],['transport','sse'],
    ['recovered',true],['mime',false],['presentation',true],['unbound_history',true],['path','private'],['digest','private'],['owner','private'],['session_id',sid]]) invalid.push({...scenario,[field]:value});
  for (const bad of invalid) {
    assert.throws(() => startScenario(bad),/fixture protocol rejected/);
    await assert.rejects(startFixture('/must-not-spawn',bad),/fixture protocol rejected/);
  }
});
test('fixed-head raw evidence rejects duplicate and escaped keys before JSON decoding loses them', () => {
  const raw = JSON.stringify(evidence);
  let count = 0;
  stdoutParser(() => { count++; }).push(Buffer.from(`${raw}\n`));
  assert.equal(count, 1);
  for (const key of Object.keys(evidence)) {
    const duplicate = `{${JSON.stringify(key)}:${JSON.stringify(evidence[key])},${raw.slice(1)}\n`;
    const escaped = raw.replace(`"${key}"`, `"\\u${key.charCodeAt(0).toString(16).padStart(4,'0')}${key.slice(1)}"`);
    for (const input of [duplicate, `${escaped}\n`]) assert.throws(() => stdoutParser(() => { count++; }).push(Buffer.from(input)), /fixture protocol rejected/);
  }
  assert.equal(count, 1);
});
test('fixed-head public evidence is closed and exact', () => {
  assert.deepEqual(parseControl(evidence),evidence);
  for (const key of Object.keys(evidence)) {
    const missing = {...evidence}; delete missing[key];
    assert.throws(() => fixedHeadEvidence(missing));
    assert.throws(() => fixedHeadEvidence({...evidence,[key]:null}));
  }
  for (const key of ['digest','identity','payload','path','token']) assert.throws(() => fixedHeadEvidence({...evidence,[key]:'private'}));
  for (const sequence_count of ['65','67','066',66,'9007199254740993']) assert.throws(() => fixedHeadEvidence({...evidence,sequence_count}));
});
function ready() {
  const protocol = fixedHeadProtocol(true);
  protocol.request({...scenario,id:1});
  protocol.reply({protocol:1,id:1,event:'ready',session_id:sid});
  return protocol;
}
test('fixed-head controls reject other modes, duplicates, wrong identity, ordering and teardown replies', () => {
  for (const command of ['inspect_task','inspect_mutations','seed_input_framing','replay_head','rotate_account','arm_acceptance','arm_acceptance_unknown','arm_acceptance_warning']) {
    assert.throws(() => ready().request({command,id:2}));
  }
  assert.throws(() => ready().request({command:'drive',id:2,gate:1}));
  assert.throws(() => ready().request({command:'select',id:2,session_id:'private'}));
  const p = ready(); p.request({command:'select',id:2,session_id:sid});
  assert.throws(() => p.request({command:'inspect',id:3}));
  assert.throws(() => p.reply({protocol:1,id:1,event:'selected'}));
  p.reply({protocol:1,id:2,event:'selected'});
  assert.throws(() => p.reply({protocol:1,id:2,event:'selected'}));
  assert.throws(() => p.request({command:'select',id:3,session_id:sid}));
  p.reply({protocol:1,event:'model_paused',gate:1});
  assert.throws(() => p.reply({protocol:1,event:'model_paused',gate:1}));
  for (const gate of [0,2,4]) assert.throws(() => p.request({command:'drive',id:3,gate}));
  for (let gate=1; gate<=3; gate++) {
    p.request({command:'drive',id:gate+2,gate}); p.reply({protocol:1,event:'driven',id:gate+2});
    if (gate<3) p.reply({protocol:1,event:'model_paused',gate:gate+1});
  }
  p.reply({protocol:1,event:'task_finished',task:1});
  assert.throws(() => p.reply({protocol:1,event:'task_finished',task:1}));
  p.request({command:'stop',id:6}); p.reply({protocol:1,id:6,event:'stopped',cleaned:true});
  assert.throws(() => p.reply(evidence)); assert.throws(() => p.request({command:'inspect',id:7}));
  assert.throws(() => fixedHeadProtocol(false).reply(evidence));
});
