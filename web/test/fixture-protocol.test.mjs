import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactFromCargo, CARGO_ARGS, CHILD_TEST, parseControl, stdoutParser } from '../test-support/fixture.mjs';

const artifact = {
  reason: 'compiler-artifact', target: { name: 'wi', kind: ['lib'], src_path: '/repo/src/lib.rs' },
  profile: { test: true }, manifest_path: '/repo/Cargo.toml', executable: '/build/a-cargo-reported-name',
};
const finished = { reason: 'build-finished', success: true };
const cargo = (...messages) => messages.map(value => JSON.stringify(value)).join('\n');

test('fixture artifact comes only from the exact lib test target and successful Cargo JSON build', () => {
  assert.deepEqual(CARGO_ARGS, ['test', '--lib', '--no-run', '--locked', '--offline', '--message-format=json']);
  assert.equal(artifactFromCargo(cargo({ ...artifact, target: { ...artifact.target, kind: ['bin'] } }, artifact, finished), '/repo'), artifact.executable);
  assert.equal(artifactFromCargo(cargo({ ...artifact, profile: { test: false } }, artifact, finished), '/repo'), artifact.executable);
});

test('artifact discovery fails closed on ambiguity, missing artifact, wrong root and failed build', () => {
  for (const text of [cargo(finished), cargo(artifact, artifact, finished), cargo(artifact), 'not JSON',
    cargo(artifact, { ...finished, success: false }), cargo(artifact, finished, finished),
    cargo({ ...artifact, executable: null }, finished), cargo({ ...artifact, executable: 'relative' }, finished),
    cargo({ ...artifact, manifest_path: '/elsewhere/Cargo.toml' }, finished),
    cargo({ ...artifact, target: { ...artifact.target, src_path: '/elsewhere/src/lib.rs' } }, finished)]) {
    assert.throws(() => artifactFromCargo(text, '/repo'), { message: 'fixture protocol rejected' });
  }
});

test('child control parser accepts only closed safe event shapes', () => {
  for (const value of [
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345' },
    { protocol: 1, event: 'model_paused', gate: 1 },
    { protocol: 1, event: 'model_paused', gate: 8 },
    { protocol: 1, event: 'model_paused', gate: 12 },
    { protocol: 1, event: 'task_finished', task: 2 },
    { protocol: 1, id: 2, event: 'stopped', cleaned: true },
    { protocol: 1, id: 3, event: 'acceptance_paused' },
  ]) assert.deepEqual(parseControl(value), value);
  for (const value of [
    { protocol: 1, id: 1, event: 'ready', origin: 'http://localhost:12345' },
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:65536' },
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345/path' },
    { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345', token: 'never forward this' },
    { protocol: 1, event: 'model_paused', gate: 0 },
    { protocol: 1, event: 'model_paused', gate: 13 },
    { protocol: 1, event: 'model_paused', gate: 1.5 },
    { protocol: 1, event: 'model_paused', gate: '1' },
    { protocol: 1, event: 'model_paused', gate: 8, text: 'never forward' },
    { protocol: 1, id: 2, event: 'stopped', cleaned: false },
    { protocol: 1, id: 2, event: 'unknown' },
    { protocol: 2, event: 'task_finished', task: 2 },
  ]) assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
});

test('inspection accepts only counters, IDs, booleans and sequence strings, never saved private payloads', () => {
  const value = { protocol: 1, id: 2, event: 'inspect', connections: 0, requests: 0, gate: null, completed: 0,
    fresh_empty: false, restored_history: false, fresh_parents: 0, continuations: 0, prepared_exact: 0,
    auth_loads: 0, auth_prepares: 0, sequence_count: '1', accepted: [], receipts: [], tool_results: 0, terminals: 0, results: 0,
    response_finishes: [], terminal_sequences: [], result_sequences: [], provider_stage: null, provider_failed: false, read_failure: null };
  assert.deepEqual(parseControl(value), value);
  for (let gate = 1; gate <= 12; gate++) {
    assert.equal(parseControl({ ...value, gate }).gate, gate);
    assert.equal(parseControl({ protocol: 1, event: 'model_paused', gate }).gate, gate);
  }
  const completed = { ...value, terminals: 1, results: 1, terminal_sequences: ['9007199254740993'], result_sequences: ['9007199254740994'],
    response_finishes: [{ sequence: '9007199254740992', provenance: 'native_terminal' }] };
  assert.deepEqual(parseControl(completed), completed);
  assert.deepEqual(parseControl({ ...completed, response_finishes: [{ sequence: '2', provenance: 'validated_output_item_done' }] }).results, 1);
  for (const changed of [{ requests: -1 }, { sequence_count: 1 }, { instructions: 'never forward' },
    { gate: 13 }, { gate: 1.5 }, { provider_stage: 'private detail' }, { provider_failed: 'false' }, { read_failure: 'private detail' },
    { response_finishes: [{ sequence: '2', provenance: 'unknown' }] },
    { response_finishes: [{ sequence: '2', provenance: 'native_terminal', text: 'never forward' }] },
    { response_finishes: [{ sequence: 2, provenance: 'native_terminal' }] },
    { terminal_sequences: ['01'] }, { result_sequences: ['3'] }, { result_sequences: [3] },
    { results: 3, result_sequences: ['1', '2', '3'] },
    { receipts: [{ operation_id: 'bad' }] }, { accepted: [{ run_id: 'bad', accepted_sequence: '2' }] }]) {
    assert.throws(() => parseControl({ ...value, ...changed }), { message: 'fixture protocol rejected' });
  }
});

const receipt = { operation_id: '11111111-1111-4111-8111-111111111111',
  session_id: '22222222-2222-4222-8222-222222222222', run_id: null, first_sequence: '1', last_sequence: '1' };
const rename = { ...receipt, operation_id: '33333333-3333-4333-8333-333333333333', first_sequence: '2', last_sequence: '2' };
const rename2 = { ...receipt, operation_id: '44444444-4444-4444-8444-444444444444', first_sequence: '3', last_sequence: '3' };
const eventIds = ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const entry = { slot: 0, receipt, sequence_count: '3', rename_events: 2, renames: [rename, rename2],
  rename_event_ids: eventIds, exact: true, catalog_head_sequence: '2', catalog_current: false };
const second = { slot: 1, receipt: { ...receipt, operation_id: '77777777-7777-4777-8777-777777777777',
  session_id: '88888888-8888-4888-8888-888888888888' }, sequence_count: '1', rename_events: 0, renames: [],
  rename_event_ids: [], exact: true, catalog_head_sequence: '1', catalog_current: true };
const mutation = { protocol: 1, id: 1, event: 'mutation_inspect', max_input_bytes: 1048576,
  session_count: 2, seed_sessions: 1, creations: [entry] };

test('mutation inspection accepts exact empty, seed, creation and current/stale rename evidence within 4096 bytes', () => {
  for (const seed_sessions of [0, 1]) {
    for (const creations of [[], [{ ...second, slot: 0 }], [entry], [entry, second],
      [{ ...entry, catalog_head_sequence: '1' }], [{ ...entry, catalog_head_sequence: '3', catalog_current: true }]]) {
      const value = { ...mutation, seed_sessions, session_count: creations.length + seed_sessions, creations };
      assert.deepEqual(parseControl(value), value);
      const line = Buffer.from(`${JSON.stringify(value)}\n`);
      assert.ok(line.length <= 4096);
      const received = [];
      const parser = stdoutParser(value => received.push(value));
      parser.push(line); parser.end();
      assert.deepEqual(received, [value]);
    }
  }
});

test('mutation inspection rejects unknown, private and missing fields at every level with static diagnostics', () => {
  for (const value of [
    { ...mutation, token: 'private-canary' }, { ...mutation, payload: { title: 'private-canary' } },
    ...[{ title: 'private-canary' }, { workspace: '/private-canary' }, { text: 'private-canary' }, { body: {} },
      { receipt: { ...receipt, private: 'private-canary' } }, { renames: [{ ...rename, payload_hash: 'private-canary' }, rename2] }]
      .map(change => ({ ...mutation, creations: [{ ...entry, ...change }] })),
  ]) assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
  for (const path of [[], ['creations', 0], ['creations', 0, 'receipt'], ['creations', 0, 'renames', 0]]) {
    const original = path.reduce((value, key) => value[key], mutation);
    for (const field of Object.keys(original)) {
      const value = structuredClone(mutation);
      delete path.reduce((object, key) => object[key], value)[field];
      assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
    }
  }
});

test('mutation inspection rejects incoherent counts, slots, event IDs, catalog heads and receipts', () => {
  for (const change of [
    { sequence_count: 3 }, { sequence_count: '03' }, { sequence_count: '2' }, { sequence_count: '4' },
    { sequence_count: '9007199254740993' }, { slot: 1 }, { slot: '0' }, { exact: 'true' }, { exact: false },
    { catalog_current: null }, { catalog_current: true }, { catalog_head_sequence: '3' },
    { catalog_head_sequence: '0' }, { catalog_head_sequence: '4' }, { catalog_head_sequence: '02' },
    { catalog_head_sequence: 2 }, { catalog_head_sequence: '-1' }, { catalog_head_sequence: '9007199254740993' },
    { rename_events: 1 }, { rename_events: '2' }, { renames: [rename, rename] },
    { rename_event_ids: null }, { rename_event_ids: [eventIds[0]] }, { rename_event_ids: [...eventIds, eventIds[0]] },
    { rename_event_ids: [eventIds[0], eventIds[0]] }, { rename_event_ids: ['private-canary', eventIds[1]] },
    { rename_event_ids: [null, eventIds[1]] }, { rename_event_ids: ['00000000-0000-0000-0000-000000000000', eventIds[1]] },
    { receipt: { ...receipt, operation_id: 'invalid' } }, { receipt: { ...receipt, session_id: null } },
    { receipt: { ...receipt, operation_id: '00000000-0000-0000-0000-000000000000' } },
    { receipt: { ...receipt, run_id: receipt.session_id } }, { receipt: { ...receipt, first_sequence: '0', last_sequence: '0' } },
    { renames: [{ ...rename, first_sequence: '3', last_sequence: '3' }, rename2] },
    { renames: [{ ...rename, session_id: rename.operation_id }, rename2] },
    { renames: [{ ...rename, operation_id: receipt.operation_id }, rename2] },
    { renames: [{ ...rename, last_sequence: '3' }, rename2] },
  ]) assert.throws(() => parseControl({ ...mutation, creations: [{ ...entry, ...change }] }), { message: 'fixture protocol rejected' });
  for (const change of [
    { max_input_bytes: 0 }, { max_input_bytes: '1048576' }, { session_count: '2' }, { session_count: 1 },
    { session_count: 3 }, { session_count: -1 }, { seed_sessions: '1' }, { seed_sessions: -1 },
    { seed_sessions: 2, session_count: 3 }, { seed_sessions: 0 }, { creations: [] },
    { session_count: 3, creations: [entry, { ...second, slot: 0 }] },
    { session_count: 3, creations: [entry, { ...second, slot: 2 }] },
    { session_count: 3, creations: [entry, { ...second, receipt }] },
    { session_count: 3, creations: [entry, { ...entry, slot: 1 }] },
    { session_count: 4, creations: [entry, second, { ...second, slot: 2 }] },
  ]) assert.throws(() => parseControl({ ...mutation, ...change }), { message: 'fixture protocol rejected' });
});

test('stdout parser handles arbitrary chunks and counts harness text without retaining it', () => {
  const received = [];
  const parser = stdoutParser(value => received.push(value));
  const event = { protocol: 1, id: 1, event: 'ready', origin: 'http://127.0.0.1:12345' };
  const text = `\nrunning 1 test\ntest ${CHILD_TEST} ... ${JSON.stringify(event)}\nok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.10s\n\n`;
  for (const byte of Buffer.from(text)) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(received, [event]);
  assert.equal(parser.harnessLines, 6);
});

test('stdout parser rejects partial EOF, oversized lines, unknown harness text and raw secrets with static diagnostics', () => {
  for (const buffer of [Buffer.from('x'.repeat(4097)), Buffer.from('private-canary\n'), Buffer.from('{bad}\n'), Buffer.from([255, 10])]) {
    assert.throws(() => stdoutParser(() => {}).push(buffer), { message: 'fixture protocol rejected' });
  }
  const parser = stdoutParser(() => {});
  parser.push(Buffer.from('{'));
  assert.throws(() => parser.end(), { message: 'fixture protocol rejected' });
  assert.throws(() => stdoutParser(() => {}).push(Buffer.from('\n'.repeat(17))), { message: 'fixture protocol rejected' });
});
