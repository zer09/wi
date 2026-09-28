import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, json, httpError, token, event, page, stream, tick } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';
const { sid, otherSid, exactText, frame } = wire;

// These controlled responses prove controller behavior, not joined browser acceptance.
test('Connect validates exact token, reads settings then catalog, and never returns the token', async () => {
  const h = harness();
  for (const invalid of ['', 'A'.repeat(64), `${token}\n`, ` ${token}`, 'g'.repeat(64)]) {
    await h.client.connect(invalid);
    assert.equal(h.client.snapshot().error.category, 'invalid_token');
    assert.equal(h.calls.length, 0);
  }
  const states = [];
  h.client.subscribe(state => states.push(state));
  await h.connect();
  for (const { url, init } of h.calls) {
    assert.ok(url.startsWith('/v1/'));
    assert.ok(init.headers.Authorization === `Bearer ${token}`, 'bearer header mismatch');
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store'); assert.equal(init.mode, 'same-origin');
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.body, undefined); assert.equal(init.method, 'GET');
  }
  assert.ok(!JSON.stringify(states).includes(token), 'snapshot leaked secret');
  assert.throws(() => { states.at(-1).settings.workspaces.push('changed'); }, TypeError);
  assert.deepEqual(h.client.snapshot().settings.workspaces, wire.settings.workspaces);
  h.client.disconnect();
  assert.equal(h.client.snapshot().settings, null);
});

test('connection errors are safe HTTP, network, protocol, or auth categories', async () => {
  for (const [reply, expected] of [
    [json(httpError('api.workspace_forbidden'), 403), 'http'],
    [json({ private: token }), 'protocol'],
    [new Response(token, { headers: { 'Content-Type': 'text/plain' } }), 'protocol'],
    [new Response('{private', { headers: { 'Content-Type': 'application/json' } }), 'protocol'],
    [new Response(token, { status: 401 }), 'authentication'],
    [null, 'network'],
  ]) {
    const h = harness(); const done = h.client.connect(token);
    const call = await h.next('/v1/settings');
    if (reply === null) call.reject(new Error(`private ${token}`)); else call.resolve(reply);
    await done;
    const state = h.client.snapshot();
    assert.equal(state.error.category, expected); assert.equal(state.connection, 'disconnected');
    assert.ok(!JSON.stringify(state).includes(token), 'error leaked secret');
    assert.equal(h.calls.length, 1);
  }
});

test('catalog uses limit32 and actual ID cursor; refresh starts over without changing canonical header', async () => {
  const h = harness(); await h.connect([wire.catalog]);
  await h.select();
  const refresh = h.client.refreshSessions();
  (await h.next('/v1/sessions?limit=32')).resolve(json({ ...wire.list, has_more: true }));
  await refresh;
  const more = h.client.loadMoreSessions();
  (await h.next(`/v1/sessions?limit=32&after_id=${sid}`)).resolve(json({ ...wire.list,
    entries: [{ ...wire.catalog, session_id: otherSid, title: 'stale' }], next_after_id: otherSid }));
  await more;
  assert.deepEqual(h.client.snapshot().catalog.entries.map(entry => entry.session_id), [sid, otherSid]);
  assert.equal(h.client.snapshot().selected.manifest.title, exactText);
  const count = h.calls.length; await h.client.loadMoreSessions(); assert.equal(h.calls.length, count);
  const again = h.client.refreshSessions();
  (await h.next('/v1/sessions?limit=32')).resolve(json({ api_version: 1, entries: [], next_after_id: null, has_more: false }));
  await again; assert.deepEqual(h.client.snapshot().catalog.entries, []);
  h.client.disconnect();
});

test('three history pages stay at first H and stream only after H; EOF preserves active run and prefix', async () => {
  const h = harness(); await h.connect();
  const rows = [event('session.created', 1), event('run.accepted', 2), ...Array.from({ length: 63 }, (_, n) => event('checkpoint', n + 3))];
  const done = h.client.selectSession(sid);
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A0&limit=32`)).resolve(json(page(rows.slice(0, 32), sid, '65')));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A32&limit=32&through=65`)).resolve(json(page(rows.slice(32, 64), sid, '65')));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A64&limit=32&through=65`)).resolve(json(page(rows.slice(64), sid, '65')));
  const s = stream(); (await h.next(`/v1/sessions/${sid}/events?after=${sid}%3A65`)).resolve(s.response);
  await done; await tick();
  s.push(frame(event('checkpoint', 66))); s.push(frame(event('checkpoint', 67)).slice(0, -1)); s.close();
  await tick();
  const state = h.client.snapshot().selected;
  assert.equal(state.applied_cursor, `${sid}:66`); assert.equal(state.observation, 'disconnected');
  assert.equal(state.display[0].execution, 'accepted'); assert.equal(state.display[0].result_recorded, false);
  assert.equal(state.display.length, 1);
  h.client.reconnectObservation();
  const reconnect = stream();
  (await h.next(`/v1/sessions/${sid}/events?after=${sid}%3A66`)).resolve(reconnect.response);
  reconnect.push(frame(event('checkpoint', 66)) + frame(event('checkpoint', 67)));
  await tick(); assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:67`);
  assert.equal(h.client.snapshot().selected.display.length, 1);
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
  h.client.disconnect();
});

test('a bad page applies none of its events and never attaches SSE', async () => {
  const h = harness(); await h.connect();
  const done = h.client.selectSession(sid);
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session));
  const bad = page([event('session.created', 1), event('run.accepted', 3)]);
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A0&limit=32`)).resolve(json(bad));
  await done;
  assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:0`);
  assert.equal(h.client.snapshot().selected.observation_error.category, 'protocol');
  assert.equal(h.calls.length, 4);
  h.client.disconnect();
});

test('selection/page/stream/connection epochs fence old replies and release readers without cancel POST', async () => {
  const h = harness(); await h.connect();
  const oldLoad = h.client.selectSession(sid);
  const oldManifest = await h.next(`/v1/sessions/${sid}`);
  const s = await h.select(otherSid);
  oldManifest.resolve(json(wire.session)); await oldLoad; await tick();
  assert.equal(oldManifest.init.signal.aborted, true);
  assert.equal(h.client.snapshot().selected.session_id, otherSid);
  h.client.setDraft(exactText);
  h.client.disconnect(); await tick();
  assert.equal(s.cancelled, 1); assert.equal(h.client.snapshot().draft, '');
  assert.equal(h.client.snapshot().selected, null); assert.deepEqual(h.client.snapshot().pending, []);
  const connect = h.client.connect(token); const late = await h.next('/v1/settings');
  h.client.disconnect(); await connect;
  await h.connect(); late.resolve(new Response('', { status: 401 })); await tick();
  assert.equal(h.client.snapshot().connection, 'connected');
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
  h.client.disconnect();
});

test('SSE errors, closed frames, conflicts, and gaps preserve the last applied cursor', async () => {
  for (const suffix of [
    `event: wi.error\ndata: ${JSON.stringify(httpError('storage.io', 'unknown'))}\n\n`,
    `event: wi.closed\ndata: ${JSON.stringify(wire.closed)}\n\n`,
    frame({ ...event('session.created', 1), data: { title: 'conflict', workspace: null } }),
    frame(event('run.accepted', 3)),
  ]) {
    const h = harness(); await h.connect(); const s = await h.select();
    s.push(': heartbeat\n\n' + suffix); await tick();
    assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:1`);
    assert.equal(h.client.snapshot().selected.observation, 'disconnected');
    assert.equal(s.cancelled, 1);
    assert.ok(h.calls.every(call => call.init.method === 'GET'));
    h.client.disconnect();
  }
});

test('wi.error notices retain exact values in frozen snapshots without advancing the cursor and clear on 401', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect();
  const s = await h.select(sid, [event('session.created', 1), event('run.accepted', 2), event('checkpoint', 3)]);
  const before = h.client.snapshot(); const count = h.calls.length;
  const notices = [
    { scope: 'global', source_label: 'skills/  雪🙂e\u0301\r\n\t/SKILL.md', kind: 'directory_name_mismatch' },
    wire.notice,
  ];
  const view = { ...httpError('storage.io', 'unknown'), stage: 'history', notices };
  s.push(`event: wi.error\ndata: ${JSON.stringify(view)}\n\n` + frame(event('checkpoint', 4))); await tick();
  const state = h.client.snapshot();
  assert.deepEqual(state.selected.observation_error, { category: 'http', status: 200, server: {
    code: view.code, stage: view.stage, certainty: view.certainty, acceptance: null, notices,
  } });
  assert.equal(state.selected.applied_cursor, before.selected.applied_cursor);
  assert.deepEqual(state.selected.display, before.selected.display);
  assert.equal(state.selected.observation, 'disconnected'); assert.equal(s.cancelled, 1);
  const saved = state.selected.observation_error.server.notices;
  assert.ok(Object.isFrozen(saved)); assert.ok(saved.every(Object.isFrozen));
  assert.throws(() => saved.push(wire.notice), TypeError);
  assert.throws(() => { saved[0] = wire.notice; }, TypeError);
  assert.throws(() => { saved[0].kind = 'skipped_symlink'; }, TypeError);
  const next = h.client.snapshot().selected.observation_error.server.notices;
  assert.notEqual(next, saved); assert.notEqual(next[0], saved[0]); assert.deepEqual(next, notices);
  assert.ok(!JSON.stringify(state).includes(token)); assert.equal(h.calls.length, count);
  const read = h.client.refreshSessions();
  (await h.next('/v1/sessions?limit=32')).resolve(new Response(token, { status: 401 })); await read;
  const cleared = h.client.snapshot();
  assert.equal(cleared.connection, 'disconnected'); assert.equal(cleared.error.category, 'authentication');
  assert.equal(cleared.selected, null); assert.deepEqual(cleared.pending, []);
  assert.ok(!JSON.stringify(cleared).includes(wire.notice.source_label));
  assert.ok(!JSON.stringify(cleared).includes(token));
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
});

test('HTTP and wi.error notices reject raw details and invalid categories without leaking tokens', async t => {
  const privateDetails = `private error details ${token}`;
  for (const view of [
    { ...httpError(), notices: [wire.notice], details: privateDetails },
    { ...httpError(), notices: [{ ...wire.notice, details: privateDetails }] },
    { ...httpError(), notices: [{ ...wire.notice, kind: privateDetails }] },
  ]) {
    for (const transport of ['http', 'sse']) {
      const h = harness(); t.after(() => h.client.disconnect());
      const states = []; h.client.subscribe(state => states.push(state));
      await h.connect(); const s = await h.select();
      if (transport === 'http') {
        h.client.setDraft(exactText); const done = h.client.sendTask();
        (await h.next(`/v1/sessions/${sid}/runs`, 'POST')).resolve(json(view, 422)); await done;
      } else {
        s.push(`event: wi.error\ndata: ${JSON.stringify(view)}\n\n`); await tick();
      }
      const state = h.client.snapshot();
      const error = transport === 'http' ? state.pending[0].error : state.selected.observation_error;
      assert.deepEqual(error, { category: 'protocol', detail: 'invalid_schema' });
      assert.equal(state.selected.applied_cursor, `${sid}:1`);
      if (transport === 'http') {
        assert.equal(state.pending[0].phase, 'uncertain'); assert.equal(state.draft, exactText);
      }
      assert.ok(!JSON.stringify(states).includes(token));
      assert.ok(!JSON.stringify(states).includes('private error details'));
      const count = h.calls.length; await tick(); assert.equal(h.calls.length, count);
      h.client.disconnect(); assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
    }
  }
});

test('401 on observation clears selected state and token; no cancel or revoke follows', async () => {
  const h = harness(); await h.connect(); const s = await h.select(); s.close(); await tick();
  h.client.reconnectObservation();
  (await h.next(`/v1/sessions/${sid}/events?after=${sid}%3A1`)).resolve(new Response(token, { status: 401 }));
  await tick();
  assert.equal(h.client.snapshot().connection, 'disconnected'); assert.equal(h.client.snapshot().selected, null);
  assert.equal(h.client.snapshot().error.category, 'authentication');
  assert.ok(!JSON.stringify(h.client.snapshot()).includes(token));
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
});
