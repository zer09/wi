import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { armReplyLoss } from '../test-support/mutations.mjs';

class Session extends EventEmitter {
  calls = [];
  async send(method, params) { this.calls.push([method, params]); }
  async detach() { this.calls.push(['detach']); }
}
function response(status = 201) {
  const forbidden = () => { throw new Error('must not inspect private bytes'); };
  return { requestId: 'safe-id', responseStatusCode: status,
    request: { method: 'POST', get headers() { forbidden(); }, get postData() { forbidden(); } },
    get responseHeaders() { forbidden(); }, get body() { forbidden(); } };
}

test('reply loss fails only the existing expected response and disables/reaps interception', async () => {
  const session = new Session();
  const loss = await armReplyLoss(session, 'http://127.0.0.1:1234/v1/sessions', 201);
  session.emit('Fetch.requestPaused', response());
  assert.equal(await loss.wait(), 201);
  await loss.drop();
  await loss.stop();
  assert.deepEqual(session.calls, [
    ['Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:1234/v1/sessions', requestStage: 'Response' }] }],
    ['Fetch.failRequest', { requestId: 'safe-id', errorReason: 'Failed' }], ['Fetch.disable', undefined], ['detach'],
  ]);
  assert.equal(session.listenerCount('Fetch.requestPaused'), 0);
});

test('reply loss cleanup continues an undropped response and rejects unexpected real status', async () => {
  for (const status of [201, 401]) {
    const session = new Session();
    const loss = await armReplyLoss(session, 'http://127.0.0.1:1234/v1/sessions', 201);
    session.emit('Fetch.requestPaused', response(status));
    if (status === 201) await loss.wait();
    else await assert.rejects(loss.wait(), { message: 'reply-loss response rejected' });
    await loss.stop();
    assert.deepEqual(session.calls.slice(1), [
      ['Fetch.continueRequest', { requestId: 'safe-id' }], ['Fetch.disable', undefined], ['detach'],
    ]);
    assert.equal(session.listenerCount('Fetch.requestPaused'), 0);
  }
});

test('reply loss rejects a second paused reply and continues both without dropping either', async () => {
  const session = new Session();
  const loss = await armReplyLoss(session, 'http://127.0.0.1:1234/v1/sessions', 201);
  session.emit('Fetch.requestPaused', response());
  const second = response();
  second.requestId = 'second-safe-id';
  session.emit('Fetch.requestPaused', second);
  await assert.rejects(loss.wait(), { message: 'reply-loss response rejected' });
  await assert.rejects(loss.drop(), { message: 'reply-loss response rejected' });
  await loss.stop();
  assert.deepEqual(session.calls.slice(1), [
    ['Fetch.continueRequest', { requestId: 'second-safe-id' }],
    ['Fetch.continueRequest', { requestId: 'safe-id' }], ['Fetch.disable', undefined], ['detach'],
  ]);
  assert.equal(session.listenerCount('Fetch.requestPaused'), 0);
});

test('reply loss continues a non-POST reply and detaches when stopped before any response', async () => {
  for (const unexpected of [false, true]) {
    const session = new Session();
    const loss = await armReplyLoss(session, 'http://127.0.0.1:1234/v1/sessions', 201);
    if (unexpected) {
      const event = response();
      event.request.method = 'GET';
      session.emit('Fetch.requestPaused', event);
      await assert.rejects(loss.wait(), { message: 'reply-loss response rejected' });
    }
    await loss.stop();
    await loss.stop();
    assert.equal(session.calls.filter(([method]) => method === 'Fetch.continueRequest').length, Number(unexpected));
    assert.deepEqual(session.calls.slice(-2), [['Fetch.disable', undefined], ['detach']]);
    assert.equal(session.listenerCount('Fetch.requestPaused'), 0);
  }
});

test('reply loss always disables and detaches after setup, release or drop failure', async () => {
  for (const rejected of ['Fetch.enable', 'Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.disable']) {
    const session = new Session();
    session.send = async (method, params) => {
      session.calls.push([method, params]);
      if (method === rejected) throw new Error('synthetic CDP failure');
    };
    if (rejected === 'Fetch.enable') {
      await assert.rejects(armReplyLoss(session, 'http://127.0.0.1:1234/v1/sessions', 201), { message: 'reply-loss setup failed' });
    } else {
      const loss = await armReplyLoss(session, 'http://127.0.0.1:1234/v1/sessions', 201);
      session.emit('Fetch.requestPaused', response());
      await loss.wait();
      const release = rejected === 'Fetch.failRequest' ? loss.drop() : loss.stop();
      await assert.rejects(release, { message: 'synthetic CDP failure' });
      await loss.stop();
    }
    assert.deepEqual(session.calls.slice(-2), [['Fetch.disable', undefined], ['detach']]);
    assert.equal(session.calls.filter(([method]) => method === 'Fetch.failRequest').length, Number(rejected === 'Fetch.failRequest'));
    assert.equal(session.listenerCount('Fetch.requestPaused'), 0);
  }
});
