import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';

const options = { secrets: ['private-observer-canary'] };
const plain = value => JSON.parse(JSON.stringify(value));

test('asset verification compares exact bytes and reports no response data', async () => {
  const bytes = [0, 13, 10, 255, 32];
  for (const mode of ['exact', 'different', 'status', 'secret', 'read']) {
    const calls = [];
    const run = runInNewContext(`(${checkEmbeddedAssets.toString()})`, {
      Uint8Array, TextDecoder,
      fetch: async (path, init) => {
        calls.push({ path, init: plain(init) });
        if (mode === 'read') throw new Error('private-observer-canary');
        if (mode === 'secret') return new Response('private-observer-canary');
        return new Response(new Uint8Array(mode === 'different' ? [0, 10, 13, 255, 32] : bytes), { status: mode === 'status' ? 201 : 200 });
      },
    }, { timeout: 1000 });
    const proof = await run({ files: [['/assets/api.js', bytes]], secrets: options.secrets });
    const failures = { exact: [], different: ['asset:bytes'], status: ['asset:status'],
      secret: ['asset:bytes', 'asset:secret'], read: ['asset:read'] };
    assert.deepEqual(plain(proof), { checked: mode === 'read' ? 0 : 1, failures: failures[mode] });
    assert.deepEqual(calls, [{ path: '/assets/api.js', init: { mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error' } }]);
  }
});
