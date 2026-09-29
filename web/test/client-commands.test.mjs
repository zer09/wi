import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, json, httpError, token, event, page, tick } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';
const { sid, otherSid, exactText, frame } = wire;
const noticeValues = [
  { ...wire.notice, source_label: 'skills/  雪🙂e\u0301\r\n\t/SKILL.md' },
  { ...wire.notice, source_label: 'skills/  雪🙂e\u0301\r\n\t/SKILL.md', scope: 'global' },
  { ...wire.notice, source_label: 'skills/  雪🙂e\u0301\r\n\t/SKILL.md', kind: 'excluded.invalid_frontmatter' },
  { ...wire.notice, source_label: 'skills/  雪🙂é\r\n\t/SKILL.md' },
];
function assertNotices(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.ok(Object.isFrozen(actual)); assert.ok(actual.every(Object.isFrozen));
  assert.throws(() => actual.push(wire.notice), TypeError);
  if (actual.length > 0) {
    assert.throws(() => { actual[0] = wire.notice; }, TypeError);
    assert.throws(() => { actual[0].source_label = 'changed'; }, TypeError);
  }
}
function receipt(command, first = '2') {
  return { operation_id: command.operation_id, session_id: sid, run_id: command.run_id ?? null,
    first_sequence: first, last_sequence: (BigInt(first) + (command.run_id ? 1n : 0n)).toString() };
}
function accepted(body, first = '2') { return { ...wire.accepted, receipt: receipt(body, first) }; }
function run(body, first = '2') {
  return { api_version: 1, run_id: body.run_id, state: 'accepted', user_text: body.text, accepted_sequence: first,
    terminal_sequence: null, result_sequence: null, result_recorded: false, result: null };
}
function acceptance(body, first = 2) {
  return [
    { ...event('run.accepted', first), run_id: body.run_id, data: { ...wire.eventData['run.accepted'], user_text: body.text } },
    { ...event('checkpoint', BigInt(first) + 1n), run_id: body.run_id },
  ];
}
async function ambiguous(h) {
  h.client.setDraft(exactText);
  const sending = h.client.sendTask(); const request = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  request.reject(new Error(`private ${token}`)); await sending;
  const command = JSON.parse(request.init.body);
  assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
  return { command, request };
}

test('create preserves exact bytes, allowed workspace, actual receipt/status/warning and canonical read', async () => {
  const h = harness(); await h.connect();
  await h.client.createSession(exactText, '/not-allowed');
  assert.equal(h.uuids, 0); assert.equal(h.calls.length, 2);
  assert.equal(h.client.snapshot().error.category, 'workspace_forbidden');
  const done = h.client.createSession(exactText, wire.settings.workspaces[0]);
  const request = await h.next('/v1/sessions', 'POST');
  await h.client.createSession(exactText, wire.settings.workspaces[0]);
  assert.equal(h.uuids, 1); assert.equal(h.calls.length, 3);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, { operation_id: body.operation_id, title: exactText, workspace: wire.settings.workspaces[0] });
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  request.resolve(json({ ...wire.create, receipt: receipt(body, '1'), warning_code: 'storage.connection_cleanup_failed' }, 201));
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session)); await done;
  const result = h.client.snapshot().last_mutation;
  assert.equal(result.receipt.operation_id, body.operation_id); assert.equal(result.reply.duplicate, false);
  assert.equal(result.reply.warning_code, 'storage.connection_cleanup_failed');
  assert.equal(h.client.snapshot().pending.length, 0); h.client.disconnect();
});

test('lost create retries only on explicit action with the same body; new payload gets a new identity', async () => {
  const h = harness(); await h.connect();
  const done = h.client.createSession(exactText, wire.settings.workspaces[0]);
  const request = await h.next('/v1/sessions', 'POST'); request.reject(new Error('private')); await done;
  const original = h.client.snapshot().pending[0];
  assert.throws(() => { original.command.body.title = 'changed'; }, TypeError);
  const refresh = h.client.refreshSessions(); (await h.next('/v1/sessions?limit=32')).resolve(json(wire.list)); await refresh;
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
  const retry = h.client.retryCommand(original.command.id);
  const repeat = await h.next('/v1/sessions', 'POST'); assert.equal(repeat.init.body, request.init.body);
  const body = JSON.parse(repeat.init.body);
  repeat.resolve(json({ ...wire.create, receipt: receipt(body, '1'), duplicate: true }));
  (await h.next(`/v1/sessions/${sid}`)).resolve(json(wire.session)); await retry;
  assert.equal(h.client.snapshot().last_mutation.reply.duplicate, true);
  const changed = h.client.createSession('new\r\n', wire.settings.workspaces[0]);
  const next = await h.next('/v1/sessions', 'POST');
  assert.notEqual(JSON.parse(next.init.body).operation_id, body.operation_id);
  next.resolve(json(httpError('api.workspace_forbidden'), 403)); await changed;
  assert.equal(h.client.snapshot().pending[0].phase, 'rejected');
  assert.equal(h.client.snapshot().pending[0].error.server.code, 'api.workspace_forbidden');
  h.client.disconnect();
});

test('missing crypto.randomUUID is unsupported, never a random fallback', async () => {
  const h = harness({ crypto: null }); await h.connect(); await h.select(); h.client.setDraft(exactText);
  await h.client.sendTask(); await h.client.renameSession(exactText); await h.client.createSession(exactText, wire.settings.workspaces[0]);
  await h.client.refreshCatalog();
  assert.equal(h.client.snapshot().error.category, 'unsupported_client');
  assert.ok(h.calls.every(call => call.init.method === 'GET')); assert.equal(h.client.snapshot().draft, exactText);
  h.client.disconnect();
});

test('rename shows every independent catalog_refresh disposition and retains commit after read failure', async () => {
  for (const disposition of ['updated', 'unchanged', 'failed', 'not_attempted']) {
    const h = harness(); await h.connect(); await h.select();
    const done = h.client.renameSession(' new\n雪 ');
    const request = await h.next(`/v1/sessions/${sid}/rename`, 'POST'); const body = JSON.parse(request.init.body);
    assert.equal(body.title, ' new\n雪 ');
    request.resolve(json({ ...wire.rename, receipt: receipt(body), catalog_refresh: disposition,
      warning_code: disposition === 'not_attempted' ? 'storage.connection_cleanup_failed' : null }));
    (await h.next(`/v1/sessions/${sid}`)).resolve(json(httpError('storage.io', 'unknown'), 503)); await done;
    assert.equal(h.client.snapshot().last_mutation.reply.catalog_refresh, disposition);
    assert.equal(h.client.snapshot().last_mutation.canonical_read_error.category, 'http');
    assert.equal(h.client.snapshot().last_mutation.receipt.operation_id, body.operation_id);
    assert.equal(h.client.snapshot().pending.length, 0); h.client.disconnect();
  }
});

test('lost rename retry stays on original session, and its late canonical read cannot change the new selection', async () => {
  const h = harness(); await h.connect(); await h.select();
  const done = h.client.renameSession(exactText); const first = await h.next(`/v1/sessions/${sid}/rename`, 'POST');
  first.reject(new Error('lost')); await done;
  const id = h.client.snapshot().pending[0].command.id; await h.select(otherSid);
  const retry = h.client.retryCommand(id); const repeat = await h.next(`/v1/sessions/${sid}/rename`, 'POST');
  assert.equal(repeat.init.body, first.init.body);
  repeat.resolve(json({ ...wire.rename, receipt: receipt(JSON.parse(repeat.init.body)) }));
  (await h.next(`/v1/sessions/${sid}`)).resolve(json({ ...wire.session, title: 'A title' })); await retry;
  assert.equal(h.client.snapshot().selected.session_id, otherSid);
  assert.equal(h.client.snapshot().selected.manifest.title, exactText);
  const refresh = h.client.refreshCatalog();
  const request = await h.next(`/v1/sessions/${otherSid}/refresh`, 'POST'); assert.equal(request.init.body, '{}');
  request.resolve(json({ ...wire.refresh, session_id: otherSid }));
  (await h.next(`/v1/sessions/${otherSid}`)).resolve(json({ ...wire.session, session_id: otherSid, title: 'canonical' })); await refresh;
  assert.equal(h.client.snapshot().selected.manifest.title, 'canonical');
  assert.equal(h.client.snapshot().last_mutation.reply.disposition, 'unchanged'); h.client.disconnect();
});

test('task double activation captures once; 202 is accepted, not canonical or completed', async () => {
  const h = harness(); await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); await h.client.sendTask();
  const request = await h.next(`/v1/sessions/${sid}/runs`, 'POST'); const body = JSON.parse(request.init.body);
  assert.equal(h.uuids, 2); assert.deepEqual(Object.keys(body), ['operation_id', 'run_id', 'text']);
  assert.equal(body.text, exactText); assert.equal(h.client.snapshot().selected.display.length, 0);
  assert.equal(h.client.snapshot().pending[0].phase, 'sending');
  request.resolve(json(accepted(body), 202)); await done;
  assert.equal(h.client.snapshot().pending[0].phase, 'accepted');
  assert.equal(h.client.snapshot().pending[0].receipt.first_sequence, '2');
  const pending = h.client.snapshot().pending[0];
  assertNotices(pending.notices, wire.accepted.notices);
  assert.notEqual(pending.notices, pending.reply.notices);
  assert.notEqual(pending.notices[0], pending.reply.notices[0]);
  assert.equal(h.client.snapshot().selected.display.length, 0); assert.equal(h.client.snapshot().draft, '');
  s.push(acceptance(body).map(frame).join('')); await tick();
  assert.equal(h.client.snapshot().pending.length, 0);
  assert.equal(h.client.snapshot().selected.display[0].user_text, exactText);
  assert.equal(h.client.snapshot().selected.display[0].execution, 'accepted');
  assertNotices(h.client.snapshot().last_mutation.notices, wire.accepted.notices);
  h.client.disconnect();
});

test('ambiguous task retains immutable body through edits, explicit retry and navigation without retargeting', async () => {
  const h = harness(); await h.connect(); await h.select();
  const { command, request } = await ambiguous(h); h.client.setDraft('new draft');
  assert.equal(h.client.snapshot().pending[0].canonical_sequence, null);
  await h.client.sendTask(); assert.equal(h.uuids, 2);
  await h.select(otherSid); h.client.setDraft('B draft');
  const retry = h.client.retryCommand(command.operation_id);
  const repeat = await h.next(`/v1/sessions/${sid}/runs`, 'POST'); assert.equal(repeat.init.body, request.init.body);
  repeat.resolve(json({ ...accepted(command), duplicate: true }, 202)); await retry;
  assert.equal(h.client.snapshot().pending[0].phase, 'accepted');
  assert.equal(h.client.snapshot().pending[0].command.session_id, sid);
  assert.equal(h.client.snapshot().selected.display.length, 0); assert.equal(h.client.snapshot().draft, 'B draft');
  assert.equal(h.uuids, 2); h.client.disconnect();
});

test('aborting a mutation waiter is uncertain and Disconnect clears it without cancellation', async () => {
  const h = harness(); await h.connect(); await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const call = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const body = JSON.parse(call.init.body); h.client.abortCommandWaiter(body.operation_id); await done;
  assert.equal(call.init.signal.aborted, true); assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
  assert.equal(h.client.snapshot().pending[0].error.category, 'aborted');
  const retry = h.client.retryCommand(body.operation_id); const repeat = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  h.client.disconnect(); await retry;
  repeat.resolve(json(accepted(body), 202)); call.resolve(json(accepted(body), 202)); await tick();
  assert.equal(h.client.snapshot().connection, 'disconnected'); assert.equal(h.client.snapshot().draft, '');
  assert.equal(h.client.snapshot().pending.length, 0); assert.equal(h.client.snapshot().last_mutation, null);
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});

test('command HTTP failures preserve exact draft, certainty and safe categories without auto retry', async () => {
  for (const [code, status, certainty, phase] of [
    ['storage.active_run_exists', 409, 'not_committed', 'rejected'],
    ['storage.stale_history', 409, 'not_committed', 'rejected'],
    ['context.invalid_request', 422, 'not_applicable', 'rejected'],
    ['context.input_too_large', 413, 'not_applicable', 'rejected'],
    ['storage.unsupported_version', 500, 'not_applicable', 'rejected'],
    ['auth_account_changed', 422, 'not_applicable', 'rejected'],
    ['storage.commit_unknown', 503, 'unknown', 'uncertain'],
  ]) {
    const h = harness(); await h.connect(); await h.select(); h.client.setDraft(exactText);
    const done = h.client.sendTask(); const call = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
    call.resolve(json(httpError(code, certainty), status)); await done;
    const state = h.client.snapshot(); assert.equal(state.pending[0].phase, phase);
    assert.equal(state.pending[0].error.server.code, code); assert.equal(state.pending[0].error.server.certainty, certainty);
    assert.equal(state.draft, exactText); assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
    h.client.disconnect();
  }
});

test('command HTTP error notices retain exact values in separate frozen snapshots until Disconnect', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); await h.select(); h.client.setDraft(exactText);
  const notices = [
    { ...wire.notice, source_label: 'skills/  雪🙂e\u0301\r\n\t/SKILL.md' },
    { scope: 'global', source_label: 'skills/other/SKILL.md', kind: 'excluded.invalid_frontmatter' },
  ];
  const view = { ...httpError('context.invalid_request'), stage: 'preflight', notices };
  const done = h.client.sendTask();
  (await h.next(`/v1/sessions/${sid}/runs`, 'POST')).resolve(json(view, 422)); await done;
  const state = h.client.snapshot();
  assert.deepEqual(state.pending[0].error, { category: 'http', status: 422, server: {
    code: view.code, stage: view.stage, certainty: view.certainty, acceptance: null, notices,
  } });
  assert.equal(state.pending[0].phase, 'rejected'); assert.equal(state.pending[0].receipt, null);
  assert.equal(state.draft, exactText); assert.equal(state.selected.applied_cursor, `${sid}:1`);
  assertNotices(state.pending[0].notices, notices);
  assert.notEqual(state.pending[0].notices, state.pending[0].error.server.notices);
  const saved = state.pending[0].error.server.notices;
  assert.ok(Object.isFrozen(saved)); assert.ok(saved.every(Object.isFrozen));
  assert.throws(() => saved.push(wire.notice), TypeError);
  assert.throws(() => { saved[0] = wire.notice; }, TypeError);
  assert.throws(() => { saved[0].source_label = 'changed'; }, TypeError);
  const next = h.client.snapshot().pending[0].error.server.notices;
  assert.notEqual(next, saved); assert.notEqual(next[0], saved[0]); assert.deepEqual(next, notices);
  assert.ok(!JSON.stringify(state).includes(token));
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
  h.client.disconnect(); await tick();
  const cleared = h.client.snapshot();
  assert.deepEqual(cleared.pending, []); assert.equal(cleared.error, null); assert.equal(cleared.selected, null);
  assert.ok(!JSON.stringify(cleared).includes('skills/other/SKILL.md'));
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});

test('notice retention merges explicit attempts by all fields in first-observed order, independently of reply and error', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const body = JSON.parse(post.init.body);
  const [a, b, c, d] = noticeValues;
  post.resolve(json({ ...httpError('storage.commit_unknown', 'unknown'), notices: [a, { ...a }, b] }, 503)); await done;
  const saved = h.client.snapshot();
  assertNotices(saved.pending[0].notices, [a, b]); assert.equal(saved.pending[0].phase, 'uncertain');
  const retry = h.client.retryCommand(body.operation_id);
  assertNotices(h.client.snapshot().pending[0].notices, [a, b]);
  assert.equal(h.client.snapshot().pending[0].error, null);
  const repeat = await h.next(`/v1/sessions/${sid}/runs`, 'POST'); assert.equal(repeat.init.body, post.init.body);
  const reply = { ...accepted(body), duplicate: true, notices: [c, b, d, { ...a }, c] };
  repeat.resolve(json(reply, 202)); await retry;
  let state = h.client.snapshot();
  assertNotices(state.pending[0].notices, [a, b, c, d]); assert.deepEqual(state.pending[0].reply, reply);
  assert.equal(state.pending[0].phase, 'accepted'); assert.equal(state.selected.applied_cursor, `${sid}:1`);
  assertNotices(saved.pending[0].notices, [a, b]);

  const reading = h.client.reconcileTask(body.operation_id);
  assertNotices(h.client.snapshot().pending[0].notices, [a, b, c, d]);
  (await h.next(`/v1/sessions/${sid}/operations/${body.operation_id}`)).resolve(json({
    ...httpError('storage.io', 'unknown'), notices: [d, b, a],
  }, 503)); await reading;
  assertNotices(h.client.snapshot().pending[0].notices, [a, b, c, d]);
  s.push(acceptance(body).map(frame).join('')); await tick();
  state = h.client.snapshot();
  assert.deepEqual(state.pending, []); assert.deepEqual(state.recoveries, []);
  assertNotices(state.last_mutation.notices, [a, b, c, d]); assert.deepEqual(state.last_mutation.reply, reply);
  assert.notEqual(state.last_mutation.notices, state.last_mutation.reply.notices);
  assert.equal(state.selected.applied_cursor, `${sid}:3`); assert.equal(state.selected.display.length, 1);
  assert.equal(h.uuids, 2); assert.equal(h.calls.length, 8);
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 2);
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});

test('notice retention survives canonical recovery and failed receipt reads through finalization with no reply', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const body = JSON.parse(post.init.body); const [a, b] = noticeValues;
  post.resolve(json({ ...httpError('storage.commit_unknown', 'unknown'), notices: [a] }, 503)); await done;
  s.push(acceptance(body).map(frame).join('')); await tick();
  const saved = h.client.snapshot().recoveries[0];
  assertNotices(saved.notices, [a]); assert.equal(saved.error, null);
  assert.equal(saved.receipt, null); assert.equal(saved.reply, null);
  const failed = h.client.reconcileTask(body.operation_id);
  assertNotices(h.client.snapshot().recoveries[0].notices, [a]);
  (await h.next(`/v1/sessions/${sid}/operations/${body.operation_id}`)).resolve(json({
    ...httpError('storage.io', 'unknown'), notices: [b, a, b],
  }, 503)); await failed;
  assertNotices(h.client.snapshot().recoveries[0].notices, [a, b]);
  const reading = h.client.reconcileTask(body.operation_id);
  assert.equal(h.client.snapshot().recoveries[0].error, null);
  assertNotices(h.client.snapshot().recoveries[0].notices, [a, b]);
  (await h.next(`/v1/sessions/${sid}/operations/${body.operation_id}`)).resolve(json({ api_version: 1, ...receipt(body) }));
  (await h.next(`/v1/sessions/${sid}/runs/${body.run_id}`)).resolve(json(run(body)));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A1&limit=32&through=3`)).resolve(json(page(acceptance(body))));
  await reading;
  const state = h.client.snapshot();
  assert.deepEqual(state.pending, []); assert.deepEqual(state.recoveries, []);
  assertNotices(state.last_mutation.notices, [a, b]); assert.equal(state.last_mutation.reply, null);
  assertNotices(saved.notices, [a]); assert.equal(state.selected.applied_cursor, `${sid}:3`);
  assert.equal(h.calls.length, 10); assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});

test('notice retention keeps validated notices alongside receipt identity conflicts but rejects invalid notices', async t => {
  for (const source of ['202', 'ErrorView']) {
    for (const valid of [true, false]) {
      const h = harness(); t.after(() => h.client.disconnect());
      await h.connect(); await h.select(); h.client.setDraft(exactText);
      const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
      const body = JSON.parse(post.init.body); const wrong = { ...receipt(body), run_id: wire.rid };
      const notices = valid ? noticeValues : [{ ...noticeValues[0], kind: 'unsupported' }];
      const view = source === '202' ? { ...accepted(body), receipt: wrong, notices }
        : { ...httpError('storage.commit_unknown', 'unknown', wrong), notices };
      post.resolve(json(view, source === '202' ? 202 : 503)); await done;
      const state = h.client.snapshot();
      assertNotices(state.pending[0].notices, valid ? noticeValues : []);
      assert.equal(state.pending[0].phase, valid ? 'conflict' : 'uncertain');
      assert.equal(state.pending[0].error.category, valid ? 'conflict' : 'protocol');
      assert.equal(state.pending[0].receipt, null); assert.equal(state.last_mutation, null);
      assert.equal(state.selected.applied_cursor, `${sid}:1`); assert.equal(state.draft, exactText);
      assert.equal(h.calls.length, 6); assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
    }
  }
});

test('notice retention clears pending, recovery and finalized collections on Disconnect and 401', async t => {
  for (const destination of ['pending', 'recoveries', 'last_mutation']) {
    for (const reason of ['disconnect', '401']) {
      const h = harness(); t.after(() => h.client.disconnect());
      await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
      const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
      const body = JSON.parse(post.init.body);
      post.resolve(json({ ...httpError('storage.commit_unknown', 'unknown', destination === 'last_mutation' ? receipt(body) : null),
        notices: noticeValues }, 503)); await done;
      if (destination !== 'pending') { s.push(acceptance(body).map(frame).join('')); await tick(); }
      const before = h.client.snapshot();
      assertNotices((destination === 'last_mutation' ? before.last_mutation : before[destination][0]).notices, noticeValues);
      if (reason === 'disconnect') h.client.disconnect();
      else {
        const reading = h.client.refreshSessions();
        (await h.next('/v1/sessions?limit=32')).resolve(new Response(null, { status: 401 })); await reading;
      }
      await tick();
      const cleared = h.client.snapshot();
      assert.deepEqual(cleared.pending, []); assert.deepEqual(cleared.recoveries, []);
      assert.equal(cleared.last_mutation, null); assert.equal(cleared.selected, null); assert.equal(cleared.draft, '');
      assert.equal(cleared.connection, 'disconnected'); assert.equal(s.cancelled, 1);
      assert.ok(!JSON.stringify(cleared).includes('skills/'));
      assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
      assert.equal(h.calls.length, reason === 'disconnect' ? 6 : 7);
      assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
    }
  }
});

test('reconciliation requires receipt, RunView and the exact two canonical acceptance records', async () => {
  const h = harness(); await h.connect(); await h.select(); const { command } = await ambiguous(h);
  const first = '9007199254740993'; const last = '9007199254740994';
  const done = h.client.reconcileTask(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json({ api_version: 1, ...receipt(command, first) }));
  assert.equal(h.client.snapshot().pending[0].phase, 'reconciling');
  (await h.next(`/v1/sessions/${sid}/runs/${command.run_id}`)).resolve(json(run(command, first)));
  assert.equal(h.client.snapshot().pending[0].phase, 'reconciling');
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A9007199254740992&limit=32&through=${last}`)).resolve(json(page(acceptance(command, first), sid, last)));
  await done;
  assert.equal(h.client.snapshot().pending.length, 0); assert.equal(h.client.snapshot().last_mutation.receipt.first_sequence, first);
  assert.equal(h.client.snapshot().selected.applied_cursor, `${sid}:1`); assert.equal(h.client.snapshot().selected.display.length, 0);
  assert.equal(h.client.snapshot().selected.run_view.accepted_sequence, first);
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1); h.client.disconnect();
});

test('receipt 404/read failure never proves rollback, and a known 202 receipt survives later failure', async () => {
  const h = harness(); await h.connect(); await h.select(); const { command } = await ambiguous(h);
  let done = h.client.reconcileTask(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json(httpError(), 404)); await done;
  assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
  done = h.client.retryCommand(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/runs`, 'POST')).resolve(json(accepted(command), 202)); await done;
  done = h.client.reconcileTask(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).reject(new Error('private')); await done;
  assert.equal(h.client.snapshot().pending[0].phase, 'accepted');
  assert.equal(h.client.snapshot().pending[0].receipt.operation_id, command.operation_id); h.client.disconnect();
});

test('wrong-method, session, operation, run, range, text and canonical content are reconciliation conflicts', async () => {
  for (const variation of ['method', 'session', 'operation', 'run', 'range', 'run_text', 'sequence', 'history_text', 'checkpoint']) {
    const h = harness(); await h.connect(); await h.select(); const { command } = await ambiguous(h);
    const result = receipt(command);
    if (variation === 'method') { result.run_id = null; result.last_sequence = result.first_sequence; }
    if (variation === 'session') result.session_id = otherSid;
    if (variation === 'operation') result.operation_id = wire.oid;
    if (variation === 'run') result.run_id = wire.rid;
    if (variation === 'range') result.last_sequence = '4';
    const done = h.client.reconcileTask(command.operation_id);
    (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json({ api_version: 1, ...result }));
    if (['run_text', 'sequence', 'history_text', 'checkpoint'].includes(variation)) {
      const record = run(command);
      if (variation === 'run_text') record.user_text += 'changed';
      if (variation === 'sequence') record.accepted_sequence = '3';
      (await h.next(`/v1/sessions/${sid}/runs/${command.run_id}`)).resolve(json(record));
    }
    if (['history_text', 'checkpoint'].includes(variation)) {
      const rows = acceptance(command);
      if (variation === 'history_text') rows[0].data.user_text += 'changed';
      if (variation === 'checkpoint') { rows[1].kind = 'run.started'; rows[1].data = {}; }
      (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A1&limit=32&through=3`)).resolve(json(page(rows)));
    }
    await done;
    assert.equal(h.client.snapshot().pending[0].phase, 'conflict', variation);
    assert.equal(h.client.snapshot().pending[0].error.category, 'conflict', variation);
    assert.equal(h.client.snapshot().pending[0].receipt, null); h.client.disconnect();
  }
});

test('canonical acceptance can precede POST reply, and mismatched user text never clears pending', async () => {
  for (const mismatch of [false, true]) {
    const h = harness(); await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
    const done = h.client.sendTask(); const call = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
    const body = JSON.parse(call.init.body); const rows = acceptance(body);
    if (mismatch) rows[0].data.user_text += 'changed';
    s.push(rows.map(frame).join('')); await tick();
    const state = h.client.snapshot();
    if (mismatch) assert.equal(state.pending[0].canonical_seen, false);
    else { assert.equal(state.pending.length, 0); assert.equal(state.recoveries[0].canonical_seen, true); }
    call.resolve(json(accepted(body), 202)); await done;
    if (mismatch) assert.equal(h.client.snapshot().pending[0].phase, 'conflict');
    else { assert.equal(h.client.snapshot().pending.length, 0); assert.equal(h.client.snapshot().selected.display.length, 1); }
    h.client.disconnect();
  }
});

test('canonical acceptance without a reply retains only immutable receipt recovery in either ordering', async t => {
  for (const ordering of ['lost-before-canonical', 'canonical-before-lost']) {
    for (const edited of [false, true]) {
      const h = harness(); t.after(() => h.client.disconnect());
      await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
      const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
      const body = JSON.parse(post.init.body); const rows = acceptance(body);
      const original = { id: body.operation_id, kind: 'task', session_id: sid, body };
      const expectedDraft = edited ? 'edited\r\n雪 draft' : '';
      if (edited) h.client.setDraft(expectedDraft);
      if (ordering === 'lost-before-canonical') {
        post.reject(new Error('lost')); await done;
        assert.equal(h.client.snapshot().pending[0].phase, 'uncertain');
      }
      s.push(rows.map(frame).join('')); await tick();
      function recovery() {
        const state = h.client.snapshot();
        assert.deepEqual(state.pending, []); assert.equal(state.recoveries.length, 1);
        const item = state.recoveries[0];
        assert.equal(item.phase, 'accepted'); assert.equal(item.canonical_seen, true);
        assert.equal(item.canonical_sequence, '2');
        assert.equal(item.receipt, null); assert.equal(item.reply, null);
        assert.deepEqual(item.command, original); assert.equal(state.last_mutation, null);
        assert.equal(state.draft, expectedDraft);
        assert.equal(state.selected.display.length, 1); assert.equal(state.selected.display[0].user_text, exactText);
        assert.equal(state.selected.display[0].execution, 'accepted');
        return item;
      }
      const saved = recovery();
      assert.ok(Object.isFrozen(h.client.snapshot().recoveries));
      assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.command)); assert.ok(Object.isFrozen(saved.command.body));
      assert.throws(() => { saved.command.id = wire.oid; }, TypeError);
      assert.throws(() => { saved.command.body.text = 'changed'; }, TypeError);
      if (ordering === 'canonical-before-lost') { post.reject(new Error('lost')); await done; }
      recovery();
      s.push(rows.map(frame).join('')); await tick();
      s.fail(); await tick(); recovery();
      assert.equal(h.client.snapshot().selected.observation_error.category, 'network');
      const count = h.calls.length; await tick(); assert.equal(h.calls.length, count);

      const failed = h.client.reconcileTask(saved.command.id); recovery();
      (await h.next(`/v1/sessions/${sid}/operations/${body.operation_id}`)).reject(new Error('read lost')); await failed;
      assert.equal(recovery().error.category, 'network');
      const reading = h.client.reconcileTask(saved.command.id); recovery();
      const lookup = await h.next(`/v1/sessions/${sid}/operations/${body.operation_id}`);
      assert.equal(lookup.init.body, undefined); lookup.resolve(json({ api_version: 1, ...receipt(body) }));
      const runRead = await h.next(`/v1/sessions/${sid}/runs/${body.run_id}`); recovery();
      assert.equal(runRead.init.body, undefined); runRead.resolve(json(run(body)));
      const historyRead = await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A1&limit=32&through=3`); recovery();
      assert.equal(historyRead.init.body, undefined); historyRead.resolve(json(page(rows))); await reading;
      const state = h.client.snapshot();
      assert.deepEqual(state.pending, []); assert.deepEqual(state.recoveries, []);
      assert.equal(state.last_mutation.id, body.operation_id); assert.deepEqual(state.last_mutation.receipt, receipt(body));
      assert.equal(state.draft, expectedDraft); assert.equal(state.selected.display.length, 1);
      assert.deepEqual(saved.command, original); assert.equal(saved.receipt, null);
      assert.equal(h.uuids, 2); assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
      assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
    }
  }
});

test('canonical receipt recovery does not block a new explicit task or clear a new equal draft', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const body = JSON.parse(post.init.body); const rows = acceptance(body);
  s.push(frame(rows[0])); await tick();
  assert.equal(h.client.snapshot().draft, ''); assert.deepEqual(h.client.snapshot().pending, []);
  h.client.setDraft(exactText);
  s.push(frame(rows[1])); await tick();
  assert.equal(h.client.snapshot().draft, exactText);
  const next = h.client.sendTask(); const nextPost = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
  const nextBody = JSON.parse(nextPost.init.body);
  assert.notEqual(nextBody.operation_id, body.operation_id); assert.notEqual(nextBody.run_id, body.run_id);
  assert.equal(nextBody.text, exactText); assert.equal(h.uuids, 4);
  post.reject(new Error('lost')); await done;
  nextPost.resolve(json(httpError('storage.active_run_exists', 'not_committed'), 409)); await next;
  const state = h.client.snapshot();
  assert.equal(state.pending.length, 1); assert.equal(state.pending[0].command.id, nextBody.operation_id);
  assert.equal(state.pending[0].phase, 'rejected'); assert.equal(state.draft, exactText);
  assert.equal(state.recoveries.length, 1); assert.deepEqual(state.recoveries[0].command.body, body);
  assert.equal(state.recoveries[0].phase, 'accepted'); assert.equal(state.recoveries[0].receipt, null);
  assert.equal(state.selected.display.length, 1); assert.equal(state.last_mutation, null);
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 2);
  h.client.disconnect(); assert.deepEqual(h.client.snapshot().recoveries, []);
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});

test('canonical recovery installs no receipt when explicit reconciliation returns different text', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); const s = await h.select(); const { command } = await ambiguous(h);
  s.push(acceptance(command).map(frame).join('')); await tick();
  h.client.setDraft('edited draft');
  const done = h.client.reconcileTask(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json({ api_version: 1, ...receipt(command) }));
  (await h.next(`/v1/sessions/${sid}/runs/${command.run_id}`)).resolve(json({ ...run(command), user_text: 'edited draft' })); await done;
  const state = h.client.snapshot();
  assert.deepEqual(state.recoveries, []); assert.equal(state.pending.length, 1);
  const item = state.pending[0];
  assert.equal(item.phase, 'conflict'); assert.equal(item.error.category, 'conflict'); assert.equal(item.canonical_seen, true);
  assert.equal(item.receipt, null); assert.deepEqual(item.command.body, command);
  assert.equal(state.last_mutation, null); assert.equal(state.draft, 'edited draft');
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});

test('canonical-before-202 sequence conflict stays visible instead of finalizing, while a matching receipt succeeds', async t => {
  for (const mismatch of [true, false]) {
    const h = harness(); t.after(() => h.client.disconnect());
    const states = []; h.client.subscribe(state => states.push(state));
    await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
    const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
    const body = JSON.parse(post.init.body);
    s.push(acceptance(body).map(frame).join('')); await tick();
    const reply = accepted(body, mismatch ? '4' : '2'); post.resolve(json(reply, 202)); await done;
    const state = h.client.snapshot();
    if (mismatch) {
      assert.equal(state.pending.length, 1);
      const item = state.pending[0];
      assert.equal(item.phase, 'conflict'); assert.equal(item.error.category, 'conflict'); assert.equal(item.canonical_seen, true);
      assert.deepEqual(item.receipt, reply.receipt); assert.deepEqual(item.reply, reply);
      assert.deepEqual(item.command, { id: body.operation_id, kind: 'task', session_id: sid, body });
      assert.throws(() => { item.command.body.text = 'changed'; }, TypeError);
      assert.equal(state.last_mutation, null);
      assert.ok(states.some(value => value.pending.some(entry => entry.command.id === body.operation_id && entry.phase === 'conflict')));
      assert.ok(states.every(value => value.last_mutation === null));
    } else {
      assert.deepEqual(state.pending, []); assert.deepEqual(state.last_mutation.receipt, reply.receipt);
    }
    assert.deepEqual(state.recoveries, []); assert.equal(state.selected.display.length, 1);
    assert.equal(state.selected.display[0].user_text, exactText);
    await tick(); assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
  }
});

test('recovery integrity compares 202 and ErrorView receipts in both orderings and across navigation', async t => {
  for (const source of ['202', 'ErrorView']) {
    for (const ordering of ['canonical-first', 'receipt-first']) {
      for (const navigate of [false, true]) {
        for (const mismatch of [false, true]) {
          await t.test(`${source} ${ordering} navigate=${navigate} mismatch=${mismatch}`, async t => {
            const h = harness(); t.after(() => h.client.disconnect());
            const states = []; h.client.subscribe(state => states.push(state));
            await h.connect(); let s = await h.select(); h.client.setDraft(exactText);
            const done = h.client.sendTask(); const post = await h.next(`/v1/sessions/${sid}/runs`, 'POST');
            const body = JSON.parse(post.init.body); const rows = acceptance(body);
            const actual = receipt(body, mismatch ? '4' : '2');
            async function receive() {
              if (source === '202') post.resolve(json({ ...accepted(body), receipt: actual, notices: noticeValues }, 202));
              else post.resolve(json({ ...httpError('storage.commit_unknown', 'unknown', actual), notices: noticeValues }, 503));
              await done;
            }
            if (ordering === 'canonical-first') s.push(rows.map(frame).join(''));
            else await receive();
            await tick();
            const intermediate = h.client.snapshot();
            if (ordering === 'canonical-first') {
              assertNotices(intermediate.recoveries[0].notices, []);
              assert.equal(intermediate.recoveries[0].receipt, null);
              assert.equal(intermediate.selected.applied_cursor, `${sid}:3`);
            } else {
              assertNotices(intermediate.pending[0].notices, noticeValues);
              assert.equal(intermediate.pending[0].phase, 'accepted');
              assert.equal(intermediate.selected.applied_cursor, `${sid}:1`);
            }
            assert.equal(intermediate.last_mutation, null);
            if (navigate) { await h.select(otherSid); h.client.setDraft('other session draft'); }
            if (ordering === 'canonical-first') await receive();
            else if (navigate) s = await h.select(sid, [event('session.created', 1), ...rows]);
            else { s.push(rows.map(frame).join('')); await tick(); }
            const state = h.client.snapshot();
            assert.deepEqual(state.recoveries, []);
            const outcome = mismatch ? state.pending[0] : state.last_mutation;
            assertNotices(outcome.notices, noticeValues);
            if (source === 'ErrorView') assert.equal(outcome.reply, null);
            else assert.deepEqual(outcome.reply.notices, noticeValues);
            const next = h.client.snapshot();
            const nextNotices = (mismatch ? next.pending[0] : next.last_mutation).notices;
            assertNotices(nextNotices, noticeValues); assert.notEqual(nextNotices, outcome.notices);
            assert.notEqual(nextNotices[0], outcome.notices[0]);
            if (mismatch) {
              assert.equal(state.pending.length, 1);
              const item = state.pending[0];
              assert.equal(item.phase, 'conflict'); assert.equal(item.error.category, 'conflict');
              assert.deepEqual(item.command, { id: body.operation_id, kind: 'task', session_id: sid, body });
              assert.deepEqual(item.receipt, actual); assert.equal(item.canonical_sequence, '2');
              assert.ok(Object.isFrozen(item.receipt));
              assert.throws(() => { item.canonical_sequence = '4'; }, TypeError);
              assert.throws(() => { item.receipt.first_sequence = '2'; }, TypeError);
              assert.throws(() => { item.command.body.text = 'changed'; }, TypeError);
              assert.equal(state.last_mutation, null);
              const count = h.calls.length;
              const retry = h.client.retryCommand(body.operation_id); await tick();
              assert.equal(h.calls.length, count); await retry;
              const reading = h.client.reconcileTask(body.operation_id); await tick();
              assert.equal(h.calls.length, count); await reading;
              assert.deepEqual(h.client.snapshot().pending[0], item);
              assert.ok(states.every(value => value.last_mutation === null));
            } else {
              assert.deepEqual(state.pending, []); assert.deepEqual(state.last_mutation.receipt, actual);
              assert.equal(states.filter((value, index) => value.last_mutation?.id === body.operation_id
                && states[index - 1]?.last_mutation?.id !== body.operation_id).length, 1);
              const count = h.calls.length;
              await h.client.retryCommand(body.operation_id); await h.client.reconcileTask(body.operation_id);
              assert.equal(h.calls.length, count);
            }
            if (navigate && ordering === 'canonical-first') {
              assert.equal(state.selected.session_id, otherSid); assert.equal(state.selected.display.length, 0);
              assert.equal(state.selected.applied_cursor, `${otherSid}:1`); assert.equal(state.draft, 'other session draft');
            } else {
              s.push(rows.map(frame).join('')); await tick();
              assert.equal(h.client.snapshot().selected.display.length, 1);
            }
            assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
            const navigationRequests = ordering === 'receipt-first' ? 6 : 3;
            assert.equal(h.calls.length, 6 + (navigate ? navigationRequests : 0));
            h.client.disconnect(); await tick();
            assert.deepEqual(h.client.snapshot().pending, []); assert.deepEqual(h.client.snapshot().recoveries, []);
            assert.equal(h.client.snapshot().last_mutation, null);
            assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
          });
        }
      }
    }
  }
});

test('recovery integrity retry makes zero requests before GET-only reconciliation on the original session', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); const s = await h.select(); const { command } = await ambiguous(h);
  s.push(acceptance(command).map(frame).join('')); await tick();
  await h.select(otherSid); h.client.setDraft('other session draft');
  const saved = h.client.snapshot().recoveries[0]; const before = h.calls.length;
  const retry = h.client.retryCommand(command.operation_id); await tick();
  assert.equal(h.calls.length, before); await retry;
  assert.deepEqual(h.client.snapshot().recoveries, [saved]); assert.deepEqual(h.client.snapshot().pending, []);
  assert.equal(saved.canonical_sequence, '2'); assert.equal(saved.receipt, null);
  const done = h.client.reconcileTask(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json({ api_version: 1, ...receipt(command) }));
  (await h.next(`/v1/sessions/${sid}/runs/${command.run_id}`)).resolve(json(run(command)));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A1&limit=32&through=3`)).resolve(json(page(acceptance(command))));
  await done;
  const state = h.client.snapshot();
  assert.deepEqual(state.pending, []); assert.deepEqual(state.recoveries, []);
  assert.deepEqual(state.last_mutation.receipt, receipt(command)); assert.equal(state.last_mutation.id, command.operation_id);
  assert.equal(state.selected.session_id, otherSid); assert.equal(state.selected.run_view, null);
  assert.equal(state.selected.applied_cursor, `${otherSid}:1`); assert.equal(state.draft, 'other session draft');
  assert.equal(h.calls.length - before, 3);
  assert.ok(h.calls.slice(before).every(call => call.init.method === 'GET' && call.init.body === undefined));
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('recovery integrity reconciliation rejects a different canonical sequence after navigation or a delayed read', async t => {
  for (const ordering of ['canonical-first', 'receipt-first']) {
    await t.test(ordering, async t => {
      const h = harness(); t.after(() => h.client.disconnect());
      const states = []; h.client.subscribe(state => states.push(state));
      await h.connect(); const s = await h.select(); const { command } = await ambiguous(h);
      const rows = acceptance(command); const actual = receipt(command, '4');
      if (ordering === 'canonical-first') {
        s.push(rows.map(frame).join('')); await tick(); await h.select(otherSid);
      }
      const before = h.calls.length;
      const done = h.client.reconcileTask(command.operation_id);
      (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json({ api_version: 1, ...actual }));
      if (ordering === 'canonical-first') {
        await tick(); assert.equal(h.calls.length - before, 1);
      } else {
        (await h.next(`/v1/sessions/${sid}/runs/${command.run_id}`)).resolve(json(run(command, '4')));
        const history = await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A3&limit=32&through=5`);
        s.push(rows.map(frame).join('')); await tick();
        history.resolve(json(page(acceptance(command, '4'))));
      }
      await done;
      const state = h.client.snapshot();
      assert.equal(state.pending.length, 1); assert.deepEqual(state.recoveries, []);
      const item = state.pending[0];
      assert.equal(item.phase, 'conflict'); assert.equal(item.error.category, 'conflict');
      assert.equal(item.canonical_sequence, '2'); assert.deepEqual(item.receipt, actual);
      assert.deepEqual(item.command.body, command); assert.ok(Object.isFrozen(item.receipt));
      assert.ok(states.every(value => value.last_mutation === null));
      assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
    });
  }
});

test('recovery integrity reconciliation retains its exact canonical sequence when canonical fingerprints conflict', async t => {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect(); const rows = [event('session.created', 1), event('session.renamed', 2, sid, { title: 'other' })];
  await h.select(sid, rows); const { command } = await ambiguous(h);
  const done = h.client.reconcileTask(command.operation_id);
  (await h.next(`/v1/sessions/${sid}/operations/${command.operation_id}`)).resolve(json({ api_version: 1, ...receipt(command) }));
  (await h.next(`/v1/sessions/${sid}/runs/${command.run_id}`)).resolve(json(run(command)));
  (await h.next(`/v1/sessions/${sid}/history?after=${sid}%3A1&limit=32&through=3`)).resolve(json(page(acceptance(command))));
  await done;
  const item = h.client.snapshot().pending[0];
  assert.equal(item.phase, 'conflict'); assert.equal(item.canonical_sequence, '2');
  assert.deepEqual(item.command.body, command); assert.equal(h.client.snapshot().last_mutation, null);
});

test('Cancel only targets known active selected run, sends {}, and never invents a terminal state', async () => {
  const h = harness(); await h.connect(); await h.select();
  await h.client.cancelCurrentRun(); assert.equal(h.client.snapshot().error.category, 'invalid_action');
  const s = await h.select(sid, [event('session.created', 1), event('run.accepted', 2), event('checkpoint', 3)]);
  for (const [disposition, status] of [['requested', 202], ['not_tracked', 200]]) {
    const done = h.client.cancelCurrentRun(); await h.client.cancelCurrentRun();
    const call = await h.next(`/v1/sessions/${sid}/runs/${wire.rid}/cancel`, 'POST'); assert.equal(call.init.body, '{}');
    call.resolve(json({ ...wire.cancel, disposition }, status)); await done;
    assert.equal(h.client.snapshot().selected.cancel.disposition, disposition);
    assert.equal(h.client.snapshot().selected.display[0].execution, 'accepted');
  }
  const read = h.client.readRun(wire.rid);
  (await h.next(`/v1/sessions/${sid}/runs/${wire.rid}`)).resolve(json({ ...wire.run, accepted_sequence: '2', terminal_sequence: '4', result_sequence: '5' })); await read;
  const count = h.calls.length; await h.client.cancelCurrentRun(); assert.equal(h.calls.length, count);
  s.close(); await tick(); h.client.disconnect();
  assert.equal(h.calls.filter(call => call.url.endsWith('/cancel')).length, 2);
});

test('401 during mutation clears drafts, pending commands and stream without issuing cancellation', async () => {
  const h = harness(); await h.connect(); const s = await h.select(); h.client.setDraft(exactText);
  const done = h.client.sendTask();
  (await h.next(`/v1/sessions/${sid}/runs`, 'POST')).resolve(new Response(token, { status: 401 })); await done; await tick();
  assert.equal(s.cancelled, 1); const state = h.client.snapshot();
  assert.equal(state.error.category, 'authentication'); assert.equal(state.draft, ''); assert.deepEqual(state.pending, []);
  assert.equal(state.settings, null); assert.equal(state.selected, null); assert.ok(!JSON.stringify(state).includes(token));
  assert.ok(!h.calls.some(call => call.url.endsWith('/cancel')));
});
