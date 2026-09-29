import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControl, stdoutParser } from '../test-support/fixture.mjs';

const value = { protocol: 1, id: 1, event: 'task_inspect', exact: true,
  receipt: { operation_id: '11111111-1111-4111-8111-111111111111', session_id: '22222222-2222-4222-8222-222222222222',
    run_id: '33333333-3333-4333-8333-333333333333', first_sequence: '2', last_sequence: '3' },
  accepted_event_id: '44444444-4444-4444-8444-444444444444', checkpoint_event_id: '55555555-5555-4555-8555-555555555555',
  sequence_count: '6', task_commands: 1, runs: 1, acceptance_events: 1, selection_events: 1, binding_events: 1,
  rename_events: 0, run_state: 'running', deltas: 0, tool_starts: 0, tool_finishes: 0 };

test('one-task audit has a closed bounded wire shape for acceptance and completion', () => {
  for (const change of [{}, { run_state: 'accepted', sequence_count: '3', binding_events: 0 },
    { run_state: 'completed', sequence_count: '26', deltas: 1, tool_starts: 1, tool_finishes: 1 },
    { sequence_count: '9007199254740993' }]) {
    const message = { ...value, ...change };
    assert.deepEqual(parseControl(message), message);
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    assert.ok(bytes.length <= 4096);
    const received = [];
    const parser = stdoutParser(message => received.push(message));
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    parser.end();
    assert.deepEqual(received, [message]);
  }
});

test('one-task audit rejects missing/private fields and incoherent identities, ranges and counts', () => {
  const rejected = message => assert.throws(() => parseControl(message), { message: 'fixture protocol rejected' });
  for (const path of [[], ['receipt']]) {
    for (const field of Object.keys(path.reduce((object, key) => object[key], value))) {
      const changed = structuredClone(value);
      delete path.reduce((object, key) => object[key], changed)[field];
      rejected(changed);
    }
    for (const field of ['text', 'path', 'payload', 'payload_hash', 'owner_instance_id', 'provider_session_id']) {
      const changed = structuredClone(value);
      path.reduce((object, key) => object[key], changed)[field] = 'private-canary';
      rejected(changed);
    }
  }
  for (const field of ['operation_id', 'session_id', 'run_id']) {
    for (const id of [null, 1, 'private-canary', '00000000-0000-0000-0000-000000000000']) {
      rejected({ ...value, receipt: { ...value.receipt, [field]: id } });
    }
  }
  for (const field of ['accepted_event_id', 'checkpoint_event_id']) {
    for (const id of [null, 1, 'private-canary', '00000000-0000-0000-0000-000000000000']) rejected({ ...value, [field]: id });
  }
  for (const field of ['task_commands', 'runs', 'acceptance_events', 'selection_events']) {
    for (const count of [0, 2, '1', -1]) rejected({ ...value, [field]: count });
  }
  for (const field of ['binding_events', 'deltas', 'tool_starts', 'tool_finishes']) {
    for (const count of [-1, 2, '1', null]) rejected({ ...value, [field]: count });
  }
  for (const change of [{ exact: false }, { exact: 'true' }, { rename_events: 1 }, { rename_events: '0' },
    { run_state: 'failed' }, { run_state: 'private-canary' }, { sequence_count: 3 }, { sequence_count: '03' },
    { sequence_count: '2' }, { sequence_count: '9223372036854775808' }, { tool_finishes: 1 },
    { accepted_event_id: value.checkpoint_event_id }, { receipt: { ...value.receipt, first_sequence: '1' } },
    { receipt: { ...value.receipt, last_sequence: '4' } }, { receipt: { ...value.receipt, last_sequence: 3 } }]) rejected({ ...value, ...change });
});
