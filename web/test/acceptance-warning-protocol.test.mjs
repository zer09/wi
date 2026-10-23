import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceWarningRequest, acceptanceWarningProtocol, acceptanceUnknownProtocol, parseControl, stdoutParser } from '../test-support/fixture.mjs';

const rejected = { message: 'fixture protocol rejected' };
const request = { command: 'arm_acceptance_warning', id: 3 };
const reply = { protocol: 1, event: 'acceptance_warning_armed', id: 3 };
const sid = '12345678-1234-4234-8234-123456789abc';
const audit = { event: 'mutation_inspect', creations: [{ exact: true, sequence_count: '1', receipt: { session_id: sid } }] };
const selection = { command: 'select', id: 2, session_id: sid };
const acknowledgement = { protocol: 1, event: 'selected', id: 2 };
const selected = protocol => { protocol.reply(audit); protocol.request(selection); protocol.reply(acknowledgement); };
const incompatible = ['arm_acceptance', 'wait_acceptance', 'release_acceptance', 'replay_head', 'seed_input_framing', 'drive', 'arm_acceptance_unknown'];

test('acceptance-warning producer and consumer accept only the bounded closed control', () => {
  for (const id of [1, 0xffffffff]) {
    assert.deepEqual(acceptanceWarningRequest({ ...request, id }), { ...request, id });
    assert.deepEqual(parseControl({ ...reply, id }), { ...reply, id });
    const seen = [];
    const parser = stdoutParser(value => seen.push(value));
    const bytes = Buffer.from(`${JSON.stringify({ ...reply, id })}\n`);
    assert.ok(bytes.length < 4096);
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    parser.end();
    assert.deepEqual(seen, [{ ...reply, id }]);
  }
  for (const [validate, original] of [[acceptanceWarningRequest, request], [parseControl, reply]]) {
    for (const value of [null, [], 1, 'private-canary']) assert.throws(() => validate(value), rejected);
    for (const change of [
      ...[0, -1, 0x100000000, 1.5, '1', null, NaN, Infinity].map(id => ({ id })),
      { text: 'private-canary' }, { owner: 'private-canary' }, { session_id: 'private-canary' },
      { point: 'WriteClosed' }, { record: 'Acceptance' }, { action: 'Io' }, { step: 'arm' }, { protocol: 2 },
    ]) assert.throws(() => validate({ ...original, ...change }), rejected);
    for (const field of Object.keys(original)) {
      const value = { ...original }; delete value[field];
      assert.throws(() => validate(value), rejected);
    }
  }
});

test('acceptance-warning raw acknowledgement rejects duplicate keys, escaped keys, malformed and private messages', () => {
  const text = JSON.stringify(reply);
  for (const field of Object.keys(reply)) for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
    const raw = `{"${spelling}":${JSON.stringify(reply[field])},${text.slice(1)}\n`;
    assert.throws(() => stdoutParser(() => assert.fail('duplicate accepted')).push(Buffer.from(raw)), rejected);
  }
  for (const raw of ['{"event":"acceptance_warning_armed",bad}\n', `${text.slice(0, -1)},}\n`,
    `${text.slice(0, -1)},"text":"private-canary"}\n`, 'x'.repeat(4097)]) {
    assert.throws(() => stdoutParser(() => assert.fail('malformed accepted')).push(Buffer.from(raw)), rejected);
  }
});

test('acceptance-warning requires mutations, fresh audited selection and acknowledgement in order', () => {
  for (const mutations of [false, undefined, 'true', true]) {
    const protocol = acceptanceWarningProtocol(mutations);
    assert.throws(() => protocol.request(request), rejected);
    protocol.reply(audit); protocol.request(selection);
    assert.throws(() => protocol.request(request), rejected);
    protocol.reply(acknowledgement);
    if (mutations !== true) { assert.throws(() => protocol.request(request), rejected); continue; }
    for (const id of [1, 2]) assert.throws(() => protocol.request({ ...request, id }), rejected);
    protocol.request(request);
    assert.throws(() => protocol.request(request), rejected);
    protocol.reply(reply);
    assert.throws(() => protocol.reply(reply), rejected);
    assert.throws(() => protocol.request({ ...request, id: 4 }), rejected);
    for (const command of [...incompatible, 'select']) assert.throws(() => protocol.request({ command, id: 4 }), rejected);
    protocol.request({ command: 'inspect', id: 4 });
    protocol.request({ command: 'inspect_task', id: 5 });
    protocol.request({ command: 'stop', id: 6 });
  }
  for (const change of [{ sequence_count: '2' }, { exact: false }]) {
    const protocol = acceptanceWarningProtocol(true);
    selected(protocol);
    protocol.reply({ ...audit, creations: [{ ...audit.creations[0], ...change }] });
    assert.throws(() => protocol.request(request), rejected);
  }
  const unaudited = acceptanceWarningProtocol(true);
  unaudited.request(selection); unaudited.reply(acknowledgement);
  assert.throws(() => unaudited.request(request), rejected);
  assert.throws(() => acceptanceWarningProtocol(true).reply(reply), rejected);
  assert.throws(() => acceptanceWarningProtocol(true).reply(acknowledgement), rejected);
  for (const bad of [{ ...acknowledgement, id: 4 }, { ...acknowledgement, event: 'armed' }, { ...acknowledgement, text: 'private-canary' }]) {
    const protocol = acceptanceWarningProtocol(true); protocol.request(selection);
    assert.throws(() => protocol.reply(bad), rejected);
  }
  for (const bad of [{ ...reply, id: 4 }, { ...reply, event: 'armed' }, { ...reply, text: 'private-canary' }]) {
    const protocol = acceptanceWarningProtocol(true); selected(protocol); protocol.request(request);
    assert.throws(() => protocol.reply(bad), rejected);
  }
});

test('acceptance-warning and prior task controls are mutually exclusive in both directions', () => {
  for (const command of incompatible) {
    const protocol = acceptanceWarningProtocol(true);
    selected(protocol); protocol.request({ command, id: 3 });
    assert.throws(() => protocol.request({ ...request, id: 4 }), rejected);
  }
  const unknown = acceptanceUnknownProtocol(true);
  selected(unknown); unknown.request(request);
  assert.throws(() => unknown.request({ command: 'arm_acceptance_unknown', id: 4 }), rejected);
  const armedUnknown = acceptanceUnknownProtocol(true);
  selected(armedUnknown); armedUnknown.request({ command: 'arm_acceptance_unknown', id: 3 });
  assert.throws(() => armedUnknown.request({ ...request, id: 4 }), rejected);
});
