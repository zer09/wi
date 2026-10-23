import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControl, replayHeadRequest, stdoutParser } from '../test-support/fixture.mjs';

const rejected = { message: 'fixture protocol rejected' };

test('replay-head requests and replies are closed, bounded and use positive Rust u32 IDs', () => {
  for (const [step, ack] of [['arm', 'armed'], ['wait', 'paused'], ['release', 'released']]) {
    for (const id of [1, 0xffffffff]) {
      const request = { command: 'replay_head', id, step };
      const reply = { protocol: 1, event: 'replay_head', id, step: ack };
      assert.deepEqual(replayHeadRequest(request), request);
      assert.deepEqual(parseControl(reply), reply);
      const bytes = Buffer.from(`${JSON.stringify(reply)}\n`);
      assert.ok(bytes.length < 4096);
      const received = [];
      const parser = stdoutParser(value => received.push(value));
      for (const byte of bytes) parser.push(Buffer.from([byte]));
      parser.end();
      assert.deepEqual(received, [reply]);
    }
  }
});

test('replay-head protocol rejects malformed, missing and private fields without echoing input', () => {
  for (const [validate, original] of [
    [replayHeadRequest, { command: 'replay_head', id: 1, step: 'arm' }],
    [parseControl, { protocol: 1, event: 'replay_head', id: 1, step: 'armed' }],
  ]) {
    for (const change of [
      ...[0, -1, 0x100000000, 1.5, '1', null, NaN, Infinity].map(id => ({ id })),
      ...['private-canary', null, 1, [], {}, 'Arm'].map(step => ({ step })),
      { text: 'private-canary' }, { owner: 'private-canary' }, { session_id: 'private-canary' },
      { point: 'BeforeCommit' }, { payload: {} }, { protocol: 2 },
    ]) assert.throws(() => validate({ ...original, ...change }), rejected);
    for (const key of Object.keys(original)) {
      const missing = { ...original };
      delete missing[key];
      assert.throws(() => validate(missing), rejected);
    }
    for (const value of [null, [], 1, 'private-canary']) assert.throws(() => validate(value), rejected);
  }
  assert.throws(() => replayHeadRequest({ command: 'inspect', id: 1, step: 'arm' }), rejected);
  assert.throws(() => parseControl({ protocol: 1, event: 'replay_head', id: 1, step: 'arm' }), rejected);
});

test('replay-head stdout rejects duplicate fields including escaped keys and malformed JSON', () => {
  const reply = { protocol: 1, event: 'replay_head', id: 1, step: 'paused' };
  const text = JSON.stringify(reply);
  for (const key of Object.keys(reply)) {
    for (const spelling of [key, `\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}`]) {
      const line = `{"${spelling}":${JSON.stringify(reply[key])},${text.slice(1)}\n`;
      assert.throws(() => stdoutParser(() => assert.fail('duplicate accepted')).push(Buffer.from(line)), rejected);
    }
  }
  for (const line of ['{"event":"replay_head",bad}\n', `${text.slice(0, -1)},}\n`, `${text.slice(0, -1)},"text":"private-canary"}\n`]) {
    assert.throws(() => stdoutParser(() => assert.fail('malformed accepted')).push(Buffer.from(line)), rejected);
  }
});
