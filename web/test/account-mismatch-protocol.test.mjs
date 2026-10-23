import assert from 'node:assert/strict';
import test from 'node:test';
import { accountMismatchProtocol, mismatchEvidence, rotationRequest } from '../test-support/account-mismatch-protocol.mjs';
import { parseControl, stdoutParser } from '../test-support/fixture.mjs';
const sid = '12345678-1234-4234-8234-123456789abc';
const ids = ['23456789', '3456789a', '456789ab', '56789abc'].map(prefix => `${prefix}-1234-4234-8234-123456789abc`);
const scenario = { mutations: true, transport: 'websocket', recovered: false, mime: true };
const receipt = { operation_id: ids[0], session_id: sid, run_id: ids[1], first_sequence: '2', last_sequence: '3' };
const audit = { protocol: 1, id: 7, event: 'account_mismatch_inspect', exact: true,
  receipt: { ...receipt, operation_id: ids[2], run_id: ids[3], first_sequence: '21', last_sequence: '22' },
  first_head: '20', sequence_count: '26', second_records: 6, run_state: 'failed', code: 'history_identity',
  result_recorded: true, history_unchanged: true, identity_checked: true, socket_closed: true, seed_head: '1' };
const ack = { protocol: 1, id: 6, event: 'account_rotated' };
function ready(options = scenario, complete = true) {
  const protocol = accountMismatchProtocol(options);
  protocol.reply({ event: 'mutation_inspect', creations: [{ exact: true, sequence_count: '1', receipt }] });
  protocol.request({ command: 'select', session_id: sid, id: 2 });
  protocol.reply({ event: 'selected', id: 2 });
  protocol.request({ command: 'inspect_task', id: 3 });
  protocol.reply({ event: 'task_inspect', id: 3, exact: true, run_state: complete ? 'completed' : 'running', receipt, sequence_count: '20' });
  return protocol;
}
const rejects = callback => assert.throws(callback, error => error.message === 'fixture protocol rejected');
test('account mismatch requires selected audited completion, exact scenario, one ordered rotation and matching acknowledgement', () => {
  const protocol = ready();
  protocol.request({ command: 'rotate_account', id: 6 }); protocol.reply(ack);
  protocol.request({ command: 'inspect_task', id: 7 }); protocol.reply(audit);
  rejects(() => protocol.reply(ack)); rejects(() => protocol.reply(audit));
  rejects(() => protocol.request({ command: 'rotate_account', id: 8 }));
  for (const options of [{ ...scenario, mutations: false }, { ...scenario, transport: 'sse' }, { ...scenario, recovered: true },
    { ...scenario, mime: false }, { ...scenario, presentation: true }]) rejects(() => ready(options).request({ command: 'rotate_account', id: 6 }));
  rejects(() => ready(scenario, false).request({ command: 'rotate_account', id: 6 }));
  rejects(() => accountMismatchProtocol(scenario).request({ command: 'rotate_account', id: 1 }));
  for (const id of [0, -1, 1.5, '1', null, 4294967296]) rejects(() => rotationRequest({ command: 'rotate_account', id }));
  for (const key of ['token', 'account', 'principal_digest', 'owner', 'session_id', 'step']) rejects(() => rotationRequest({ command: 'rotate_account', id: 6, [key]: 'private-canary' }));
  for (const key of ['command', 'id']) {
    const value = { command: 'rotate_account', id: 6 }; delete value[key]; rejects(() => rotationRequest(value));
  }
  for (const command of ['arm_acceptance', 'wait_acceptance', 'release_acceptance', 'arm_acceptance_unknown', 'arm_acceptance_warning', 'seed_input_framing', 'replay_head']) {
    const prior = ready(); prior.request({ command, id: 4 }); rejects(() => prior.request({ command: 'rotate_account', id: 6 }));
  }
  for (const command of ['select', 'drive', 'inspect_mutations', 'arm_acceptance', 'arm_acceptance_unknown', 'arm_acceptance_warning', 'seed_input_framing', 'replay_head']) {
    const after = ready(); after.request({ command: 'rotate_account', id: 6 }); rejects(() => after.request({ command, id: 7 }));
  }
  const ordered = ready(); rejects(() => ordered.request({ command: 'rotate_account', id: 3 }));
  const wrong = ready(); wrong.request({ command: 'rotate_account', id: 6 }); rejects(() => wrong.reply({ ...ack, id: 5 }));
});

test('account mismatch evidence is closed, relational and rejects every missing/extra/private field', () => {
  assert.equal(parseControl(audit), audit);
  for (const key of [...Object.keys(audit), 'private']) {
    const value = structuredClone(audit); if (key === 'private') value[key] = 'private-canary'; else delete value[key];
    rejects(() => mismatchEvidence(value));
  }
  for (const key of [...Object.keys(receipt), 'private']) {
    const value = structuredClone(audit); if (key === 'private') value.receipt[key] = 'private-canary'; else delete value.receipt[key];
    rejects(() => mismatchEvidence(value));
  }
  for (const change of [{ id: 0 }, { protocol: 2 }, { sequence_count: '27' }, { first_head: '020' }, { second_records: 7 },
    { code: 'provider_error' }, { run_state: 'completed' }, { seed_head: '2' }, ...['exact', 'result_recorded', 'history_unchanged', 'identity_checked', 'socket_closed'].map(key => ({ [key]: false }))]) {
    rejects(() => mismatchEvidence({ ...audit, ...change }));
  }
  for (const change of [{ operation_id: sid }, { session_id: 'private-canary' }, { run_id: null }, { first_sequence: '20' }, { last_sequence: '23' }]) {
    rejects(() => mismatchEvidence({ ...audit, receipt: { ...audit.receipt, ...change } }));
  }
});

test('account mismatch wire parser rejects ordinary and escaped duplicates, private fields, UTF-8, size and truncation', () => {
  for (const value of [ack, audit]) {
    const parser = stdoutParser(() => {}); parser.push(Buffer.from(`${JSON.stringify(value)}\n`)); parser.end();
    for (const [object, nested] of [[value, false], ...(value === audit ? [[value.receipt, true]] : [])]) for (const key of Object.keys(object)) {
      for (const spelling of [key, `\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}`]) {
        const dup = `{"${spelling}":${JSON.stringify(object[key])},${JSON.stringify(object).slice(1)}`;
        const raw = nested ? JSON.stringify(value).replace(JSON.stringify(object), dup) : dup;
        rejects(() => stdoutParser(() => {}).push(Buffer.from(`${raw}\n`)));
      }
    }
  }
  for (const value of [{ ...ack, token: 'private-canary' }, { ...ack, id: 4294967296 }]) rejects(() => parseControl(value));
  rejects(() => stdoutParser(() => {}).push(Buffer.from([0xff, 10])));
  rejects(() => stdoutParser(() => {}).push(Buffer.alloc(4097, 32)));
  const partial = stdoutParser(() => {}); partial.push(Buffer.from('{')); rejects(() => partial.end());
});
