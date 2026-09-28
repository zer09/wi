import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControl, stdoutParser, startFixture } from '../test-support/fixture.mjs';
import { startScenario, unboundEvidence, unboundProtocol } from '../test-support/unbound-history-protocol.mjs';
const sid = '12345678-1234-4234-8234-123456789abc';
const scenario = { transport: 'websocket', recovered: false, mime: true, mutations: true, unbound_history: true };
const ready = { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345', session_id: sid };
const evidence = { protocol: 1, id: 2, event: 'unbound_history_inspect', session_id: sid, exact: true, unchanged: true,
  replay_rejected: true, completed: true, result_recorded: true, sequence_count: '9', seed_head: '1', acceptances: 1,
  selections: 0, bindings: 0, runtime: 6, results: 1, tools: 0, connections: 0, requests: 0, auth_loads: 0, auth_prepares: 0 };
const rejected = callback => assert.throws(callback, { message: 'fixture protocol rejected' });
const stream = raw => { const parser = stdoutParser(() => {}); parser.push(Buffer.from(`${raw}\n`)); parser.end(); };

test('unbound start is optional false, restricted to mutations WS native MIME, and rejects private/malformed/duplicate fields before spawning', async () => {
  assert.deepEqual(startScenario(scenario), scenario);
  assert.deepEqual(startScenario({ transport: 'sse', recovered: true, mime: false }), { transport: 'sse', recovered: true, mime: false });
  assert.equal(startScenario({ ...scenario, unbound_history: false }).unbound_history, false);
  const bad = [null, [], {}, ...['transport', 'recovered', 'mime'].map(field => Object.fromEntries(Object.entries(scenario).filter(([key]) => key !== field)))];
  for (const field of ['unbound_history', 'presentation', 'mutations', 'recovered', 'mime']) for (const value of [null, 'true', 1, {}, []]) bad.push({ ...scenario, [field]: value });
  for (const change of [{ mutations: false }, { presentation: true }, { transport: 'sse' }, { recovered: true }, { mime: false },
    ...['owner', 'id', 'session_id', 'prompt', 'provider', 'path', 'command', 'native', 'digest'].map(key => ({ [key]: 'private-canary' }))]) bad.push({ ...scenario, ...change });
  for (const value of bad) {
    rejected(() => startScenario(value));
    await assert.rejects(startFixture('must-not-spawn', value), { message: 'fixture protocol rejected' });
  }
  const raw = JSON.stringify(scenario);
  for (const field of Object.keys(scenario)) for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
    rejected(() => startScenario(`{"${spelling}":${JSON.stringify(scenario[field])},${raw.slice(1)}`));
  }
});

test('unbound replies expose only checked public session identity and closed evidence, including raw duplicate negatives', () => {
  assert.equal(parseControl(ready), ready); assert.equal(parseControl(evidence), evidence);
  for (const value of [ready, evidence]) {
    stream(JSON.stringify(value));
    for (const field of [...Object.keys(value), 'private']) {
      const bad = { ...value };
      if (field === 'private') bad.private = 'private-canary'; else delete bad[field];
      // Plain ready remains valid for all older scenarios; the mode guard rejects its missing session.
      if (!(value === ready && field === 'session_id')) rejected(() => parseControl(bad));
    }
    for (const field of Object.keys(value)) for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
      rejected(() => stream(`{"${spelling}":${JSON.stringify(value[field])},${JSON.stringify(value).slice(1)}`));
    }
    for (const session_id of [null, 1, '', 'private-canary', '00000000-0000-0000-0000-000000000000', sid.toUpperCase()]) rejected(() => parseControl({ ...value, session_id }));
  }
  for (const field of Object.keys(evidence).filter(key => !['event', 'session_id'].includes(key))) {
    for (const bad of [null, 'private-canary', {}, [], -1]) rejected(() => unboundEvidence({ ...evidence, [field]: bad }));
  }
  for (const field of ['exact', 'unchanged', 'replay_rejected', 'completed', 'result_recorded']) rejected(() => unboundEvidence({ ...evidence, [field]: false }));
  for (const field of ['connections', 'requests', 'auth_loads', 'auth_prepares', 'selections', 'bindings', 'tools']) rejected(() => unboundEvidence({ ...evidence, [field]: 1 }));
});

function opened() {
  const protocol = unboundProtocol(true);
  protocol.request({ ...scenario, id: 1 }); protocol.reply(ready);
  return protocol;
}
test('unbound mode permits only ordered inspect and stop, rejects wrong mode, unsolicited/duplicate replies and post-stop actions', () => {
  const protocol = opened();
  protocol.request({ command: 'inspect', id: 2 }); protocol.reply(evidence);
  protocol.request({ command: 'stop', id: 3 }); protocol.reply({ protocol: 1, id: 3, event: 'stopped', cleaned: true });
  rejected(() => protocol.request({ command: 'inspect', id: 4 }));
  for (const command of ['select', 'drive', 'arm_acceptance', 'arm_acceptance_unknown', 'arm_acceptance_warning', 'rotate_account',
    'wait_acceptance', 'release_acceptance', 'inspect_task', 'inspect_mutations', 'seed_input_framing', 'replay_head']) rejected(() => opened().request({ command, id: 2 }));
  for (const id of [0, 1, -1, 1.5, '2', null, 4294967296]) rejected(() => opened().request({ command: 'inspect', id }));
  rejected(() => opened().request({ command: 'inspect', id: 2, text: 'private' }));
  rejected(() => opened().reply(evidence));
  for (const bad of [{ ...evidence, id: 3 }, { ...evidence, session_id: '23456789-1234-4234-8234-123456789abc' }, ready]) {
    const protocol = opened(); protocol.request({ command: 'inspect', id: 2 }); rejected(() => protocol.reply(bad));
  }
  const pending = opened(); pending.request({ command: 'inspect', id: 2 }); rejected(() => pending.request({ command: 'stop', id: 3 }));
  for (const value of [ready, evidence]) rejected(() => unboundProtocol(false).reply(value));
  const missing = unboundProtocol(true); missing.request({ ...scenario, id: 1 });
  const { session_id: _sid, ...ordinaryReady } = ready; rejected(() => missing.reply(ordinaryReady));
});
