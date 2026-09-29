import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, json, httpError, event, page, stream, tick } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';
const { sid, otherSid, frame, exactText } = wire;
function accepted(command) {
  return { ...wire.accepted, receipt: { operation_id: command.operation_id, session_id: sid,
    run_id: command.run_id, first_sequence: '2', last_sequence: '3' } };
}

test('navigation aborts an in-progress history body and full reload starts at zero under a new epoch', async () => {
  const h = harness(); await h.connect();
  const loading = h.client.selectSession(sid);
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session));
  let cancelled = 0;
  const body = new ReadableStream({ start(control) { control.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled += 1; } });
  const oldPage = await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A0&limit=32`);
  oldPage.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } })); await tick();
  const s = await h.select(otherSid); await loading;
  assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(oldPage.init.signal.aborted, true);
  s.push(frame(event('session.renamed', 2, otherSid, { title: 'stream title' }))); await tick();
  assert.equal(h.client.snapshot().selected.title, 'stream title');
  const reloading = h.client.reloadHistory();
  const manifest = await h.next(`/v1/sessions/${otherSid}`);
  assert.equal(s.cancelled, 1); assert.equal(h.client.snapshot().selected.applied_cursor, `${otherSid}:0`);
  manifest.resolve(json({ ...wire.session, session_id: otherSid, title: 'canonical new', head_sequence: '2' }));
  (await h.next(`/v1/sessions/${otherSid}/history?after=${otherSid}%3A0&limit=32`)).resolve(json(page([
    event('session.created', 1, otherSid), event('session.renamed', 2, otherSid, { title: 'canonical new' }),
  ], otherSid)));
  const resumed = stream(); (await h.next(`/v1/sessions/${otherSid}/events?after=${otherSid}%3A2`)).resolve(resumed.response);
  await reloading; await tick(); assert.equal(h.client.snapshot().selected.title, 'canonical new');
  assert.ok(h.calls.every(call => call.init.method === 'GET')); h.client.disconnect();
});

test('page and stream replies from old selections cannot advance the new applied cursor', async () => {
  const h = harness(); await h.connect();
  const first = h.client.selectSession(sid);
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session));
  const oldPage = await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A0&limit=32`);
  await h.select(otherSid);
  oldPage.resolve(json(page([event('session.created', 1)]))); await first; await tick();
  assert.equal(h.client.snapshot().selected.applied_cursor, `${otherSid}:1`);
  const again = h.client.selectSession(sid);
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A0&limit=32`)).resolve(json(page([event('session.created', 1)])));
  const oldStream = await h.next(`/v1/sessions/${sid}/events?after=${sid}%3A1`); await again;
  await h.select(otherSid);
  const stale = stream(); oldStream.resolve(stale.response); await tick();
  assert.equal(stale.cancelled, 1); assert.equal(h.client.snapshot().selected.applied_cursor, `${otherSid}:1`);
  h.client.disconnect();
});

test('a reconnect during a chunk stops the old callback before its next record is applied', async () => {
  const h = harness(); await h.connect(); const s = await h.select();
  let reconnected = false;
  const unsubscribe = h.client.subscribe(state => {
    if (!reconnected && state.selected?.applied_cursor === `${sid}:2`) {
      reconnected = true; h.client.reconnectObservation();
    }
  });
  s.push(frame(event('run.accepted', 2)) + frame(event('checkpoint', 3)));
  const repeat = stream();
  (await h.next(`/v1/sessions/${sid}/events?after=${sid}%3A2`)).resolve(repeat.response); await tick();
  assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:2`); assert.equal(s.cancelled, 1);
  repeat.push(frame(event('run.accepted', 2)) + frame(event('checkpoint', 3))); await tick();
  assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:3`);
  assert.equal(h.client.snapshot().selected.display.length, 1);
  assert.throws(() => h.client.snapshot().selected.display[0].run.turns.push([]), TypeError);
  unsubscribe(); h.client.disconnect();
});

test('stream network drop retains prefix and never reconnects or POSTs automatically', async () => {
  const h = harness(); await h.connect(); const s = await h.select();
  s.push(frame(event('run.accepted', 2))); await tick(); s.fail(); await tick();
  const count = h.calls.length; await tick();
  assert.equal(h.calls.length, count); assert.equal(h.client.snapshot().selected.observation, 'disconnected');
  assert.equal(h.client.snapshot().selected.observation_error.category, 'network');
  assert.equal(h.client.snapshot().selected.display[0].execution, 'accepted');
  h.client.reconnectObservation();
  const next = stream(); (await h.next(`/v1/sessions/${sid}/events?after=${sid}%3A2`)).resolve(next.response); await tick();
  assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:2`);
  assert.ok(h.calls.every(call => call.init.method === 'GET')); h.client.disconnect();
});

test('refresh cancels old catalog read; malformed cursor metadata cannot replace the accepted list', async () => {
  const h = harness(); await h.connect([wire.catalog]);
  const first = h.client.refreshSessions(); const stale = await h.next('/v1/sessions?limit=32');
  const second = h.client.refreshSessions();
  (await h.next('/v1/sessions?limit=32')).resolve(json({ ...wire.list, entries: [{ ...wire.catalog, title: 'new' }] })); await second;
  stale.resolve(json(wire.list)); await first; await tick();
  assert.equal(stale.init.signal.aborted, true); assert.equal(h.client.snapshot().catalog.entries[0].title, 'new');
  const bad = h.client.refreshSessions();
  (await h.next('/v1/sessions?limit=32')).resolve(json({ ...wire.list, next_after_id: otherSid })); await bad;
  assert.equal(h.client.snapshot().error.category, 'protocol'); assert.equal(h.client.snapshot().catalog.entries[0].title, 'new');
  h.client.disconnect();
});

test('lost body after HTTP headers is uncertain; exact retry cannot downgrade a previous unknown commit', async () => {
  const h = harness(); await h.connect(); await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const call = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const command = JSON.parse(call.init.body);
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled += 1; } });
  call.resolve(new Response(body, { status: 202, headers: { 'Content-Type': 'application/json' } })); await tick();
  h.client.abortCommandWaiter(command.operation_id); await done;
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
  assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
  const retry = h.client.retryCommand(command.operation_id);
  const repeat = await h.next(`/v1/sessions/${sid}/runs`, 'POST'); assert.equal(repeat.init.body, call.init.body);
  repeat.resolve(json(httpError('storage.io', 'not_committed'), 503)); await retry;
  assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
  assert.equal(h.client.snapshot().draft, exactText);
  h.client.discardCommand(command.operation_id); assert.equal(h.client.snapshot().pending.length, 0);
  h.client.disconnect();
});

test('wrong success status/receipt is not acceptance and safe warnings retain actual accepted evidence', async () => {
  for (const variant of ['status', 'operation', 'run', 'session', 'range', 'media', 'warning', 'error_acceptance']) {
    const h = harness(); await h.connect(); await h.select(); h.client.setDraft(exactText);
    const done = h.client.sendTask(); const call = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
    const command = JSON.parse(call.init.body); const value = accepted(command);
    if (variant === 'operation') value.receipt.operation_id = wire.oid;
    if (variant === 'run') value.receipt.run_id = wire.rid;
    if (variant === 'session') value.receipt.session_id = otherSid;
    if (variant === 'range') value.receipt.last_sequence = '4';
    if (variant === 'warning') value.warning_code = 'storage.commit_unknown';
    if (variant === 'error_acceptance') call.resolve(json(httpError('storage.commit_unknown', 'unknown', value.receipt), 503));
    else call.resolve(json(value, variant === 'status' ? 200 : 202, variant === 'media' ? 'text/html' : 'application/json'));
    await done;
    const pending = h.client.snapshot().pending[0];
    if (variant === 'warning' || variant === 'error_acceptance') {
      assert.equal(pending.phase, 'accepted'); assert.equal(pending.receipt.operation_id, command.operation_id);
    } else {
      assert.notEqual(pending.phase, 'accepted'); assert.equal(pending.receipt, null);
      assert.equal(h.client.snapshot().draft, exactText);
    }
    h.client.disconnect();
  }
});

test('aborted reconciliation stays associated with its original session and never issues a retry', async () => {
  const h = harness(); await h.connect(); await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const command = JSON.parse(post.init.body); post.reject(new Error('lost')); await done;
  const reading = h.client.reconcileTask(command.operation_id);
  const lookup = await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`);
  await h.select(otherSid); await reading;
  lookup.resolve(json({ api_version: 1, ...accepted(command).receipt })); await tick();
  assert.equal(h.client.snapshot().pending[0].command.session_id, sid);
  assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
  assert.equal(h.client.snapshot().selected.applied_cursor, `${otherSid}:1`);
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1); h.client.disconnect();
});

test('known canonical acceptance is not undone by a lost reply and can be explicitly reconciled later', async () => {
  const h = harness(); await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const call = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const command = JSON.parse(call.init.body);
  const view = { ...event('run.accepted', 2), run_id: command.run_id };
  s.push(frame(view)); await tick(); call.reject(new Error('lost')); await done;
  const state = h.client.snapshot(); const item = state.recoveries[0];
  assert.equal(item.canonical_seen, true); assert.equal(item.phase, 'accepted'); assert.equal(item.receipt, null);
  assert.deepEqual(state.pending, []); assert.equal(state.draft, '');
  assert.equal(state.selected.display.length, 1);
  h.client.disconnect();
});
