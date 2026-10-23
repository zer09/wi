import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceUnknownRequest, acceptanceUnknownProtocol, parseControl, stdoutParser } from '../test-support/fixture.mjs';

const rejected = { message: 'fixture protocol rejected' };
const request = { command: 'arm_acceptance_unknown', id: 3 };
const reply = { protocol: 1, event: 'acceptance_unknown_armed', id: 3 };
const sid = '12345678-1234-4234-8234-123456789abc';
const audit = { event: 'mutation_inspect', creations: [{ exact: true, sequence_count: '1', receipt: { session_id: sid } }] };
const selected = protocol => {
  protocol.reply(audit);
  protocol.request({ command: 'select', id: 2, session_id: sid });
  protocol.reply({ protocol: 1, event: 'selected', id: 2 });
};

test('acceptance-unknown control is closed with positive bounded IDs on both sides', () => {
  for (const id of [1, 0xffffffff]) {
    assert.deepEqual(acceptanceUnknownRequest({ ...request, id }), { ...request, id });
    assert.deepEqual(parseControl({ ...reply, id }), { ...reply, id });
    const seen = [];
    const parser = stdoutParser(value => seen.push(value));
    const bytes = Buffer.from(`${JSON.stringify({ ...reply, id })}\n`);
    assert.ok(bytes.length < 4096);
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    parser.end();
    assert.deepEqual(seen, [{ ...reply, id }]);
  }
  for (const [validate, original] of [[acceptanceUnknownRequest, request], [parseControl, reply]]) {
    for (const value of [null, [], 1, 'private-canary']) assert.throws(() => validate(value), rejected);
    for (const change of [
      ...[0, -1, 0x100000000, 1.5, '1', null, NaN, Infinity].map(id => ({ id })),
      { text: 'private-canary' }, { owner: 'private-canary' }, { session_id: 'private-canary' },
      { point: 'CommitStart' }, { record: 'Acceptance' }, { action: 'CommitUnknown' }, { step: 'arm' },
      { protocol: 2 },
    ]) assert.throws(() => validate({ ...original, ...change }), rejected);
    for (const field of Object.keys(original)) {
      const value = { ...original }; delete value[field];
      assert.throws(() => validate(value), rejected);
    }
  }
});

test('acceptance-unknown replies reject raw duplicate fields, escaped keys and private malformed data', () => {
  const text = JSON.stringify(reply);
  for (const field of Object.keys(reply)) {
    for (const spelling of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, '0')}${field.slice(1)}`]) {
      const raw = `{"${spelling}":${JSON.stringify(reply[field])},${text.slice(1)}\n`;
      assert.throws(() => stdoutParser(() => assert.fail('duplicate accepted')).push(Buffer.from(raw)), rejected);
    }
  }
  for (const raw of ['{"event":"acceptance_unknown_armed",bad}\n', `${text.slice(0, -1)},}\n`,
    `${text.slice(0, -1)},"text":"private-canary"}\n`, 'x'.repeat(4097)]) {
    assert.throws(() => stdoutParser(() => assert.fail('malformed accepted')).push(Buffer.from(raw)), rejected);
  }
});

test('acceptance-unknown requires acknowledged selection, mutations mode and one unused control', () => {
  for (const mutations of [false, undefined, 'true', true]) {
    const protocol = acceptanceUnknownProtocol(mutations);
    assert.throws(() => protocol.request(request), rejected);
    protocol.reply(audit);
    protocol.request({ command: 'select', id: 2, session_id: sid });
    assert.throws(() => protocol.request(request), rejected);
    protocol.reply({ protocol: 1, event: 'selected', id: 2 });
    if (mutations !== true) { assert.throws(() => protocol.request(request), rejected); continue; }
    protocol.request(request);
    assert.throws(() => protocol.request(request), rejected);
    protocol.reply(reply);
    assert.throws(() => protocol.reply(reply), rejected);
    assert.throws(() => protocol.request({ ...request, id: 4 }), rejected);
    for (const command of ['arm_acceptance', 'wait_acceptance', 'release_acceptance', 'replay_head', 'seed_input_framing', 'drive', 'select']) {
      assert.throws(() => protocol.request({ command, id: 4 }), rejected);
    }
    protocol.request({ command: 'inspect', id: 4 });
    protocol.request({ command: 'stop', id: 5 });
  }
  for (const command of ['arm_acceptance', 'replay_head', 'seed_input_framing', 'drive']) {
    const protocol = acceptanceUnknownProtocol(true);
    selected(protocol);
    protocol.request({ command, id: 3 });
    assert.throws(() => protocol.request({ ...request, id: 4 }), rejected);
  }
  for (const sequence of ['1', '2']) {
    const protocol = acceptanceUnknownProtocol(true);
    protocol.request({ command: 'select', id: 2, session_id: sid });
    protocol.reply({ event: 'selected', id: 2 });
    assert.throws(() => protocol.request(request), rejected, 'a seed or unaudited selection cannot arm the fault');
    protocol.reply({ ...audit, creations: [{ ...audit.creations[0], sequence_count: sequence }] });
    if (sequence === '2') assert.throws(() => protocol.request(request), rejected);
    else protocol.request(request);
  }
  assert.throws(() => acceptanceUnknownProtocol(true).reply(reply), rejected);
  for (const bad of [{ ...reply, id: 4 }, { ...reply, event: 'armed' }]) {
    const protocol = acceptanceUnknownProtocol(true);
    selected(protocol); protocol.request(request);
    assert.throws(() => protocol.reply(bad), rejected);
  }
});
