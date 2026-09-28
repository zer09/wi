import assert from 'node:assert/strict';
import test from 'node:test';
import { mountView } from '../dist/view.js';
import { event, harness, httpError, json, page, stream, tick } from './client-fixtures.mjs';
import * as wire from './wire-fixtures.mjs';

// A small element model tests view bookkeeping, not browser layout, focus, or accessibility.
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.attributes = {}; this.listeners = {};
    this.text = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.scrollTop = 0; this.clientHeight = 100; this.scrollHeight = 100;
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.replaceChildren(); this.text = text; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  get options() { return this.children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, next) {
    child.remove();
    const index = next === null ? this.children.length : this.children.indexOf(next);
    assert.ok(index >= 0);
    this.children.splice(index, 0, child); child.parent = this;
  }
  remove() {
    if (this.parent !== null) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...children); }
  find(predicate) { return [this, ...this.children.flatMap(child => child.find(predicate))].filter(predicate); }
}
function setup(t, client) {
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  const root = new Element('main');
  const view = mountView(root, client, () => {}, true);
  return { root, view };
}
function byClass(root, name) { return root.find(node => node.className === name)[0]; }
function frozen(value) {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) frozen(entry);
  return Object.freeze(value);
}

function namedButton(root, text) { return root.find(node => node.tag === 'button' && node.textContent === text)[0]; }
async function connectedView(t) {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect();
  const { root, view } = setup(t, h.client);
  t.after(h.client.subscribe(view.render));
  return { h, root, view };
}

async function selected(t) {
  const h = harness(); t.after(() => h.client.disconnect());
  await h.connect();
  await h.select(wire.sid, [
    event('session.created', 1), event('run.accepted', 2), event('run.started', 3),
    event('turn.started', 4, wire.sid, { turn_id: 'turn', number: '1' }),
    event('response.started', 5),
    event('response.delta', 6, wire.sid, { response_id: 'response', item_id: 'item', output_index: '0',
      content_index: '0', summary_index: null, kind: 'text', delta: wire.exactText }),
    event('response.delta', 7, wire.sid, { response_id: 'response', item_id: 'reasoning', output_index: '1',
      content_index: null, summary_index: '0', kind: 'reasoning_summary', delta: 'Private-looking inert <b>reasoning</b> 雪' }),
  ]);
  return h;
}

test('element-model rendering keeps frozen snapshots, exact strings, and stable disclosure/form nodes', async t => {
  const h = await selected(t);
  const { root, view } = setup(t, h.client);
  const snapshot = h.client.snapshot(); const before = JSON.stringify(snapshot);
  view.render(snapshot);
  const transcript = byClass(root, 'transcript');
  assert.equal(transcript.find(node => node.tag === 'pre' && node.textContent === wire.exactText).length, 2);
  assert.match(transcript.textContent, /Execution: running. Final result not recorded/);
  assert.equal(root.find(node => ['script', 'img', 'a', 'iframe'].includes(node.tag)).length, 0);
  const disclosure = transcript.find(node => node.tag === 'details' && node.firstElementChild.textContent === 'Reasoning summary (provisional)')[0];
  disclosure.open = true;
  const task = root.find(node => node.tag === 'label' && node.text === 'Task')[0].children[0];
  h.client.setDraft('  next\n雪  ');
  view.render(h.client.snapshot());
  assert.equal(disclosure.open, true);
  assert.equal(root.find(node => node.tag === 'label' && node.text === 'Task')[0].children[0], task);
  assert.equal(task.value, '  next\n雪  ');
  assert.equal(JSON.stringify(snapshot), before);
});

// Generic closed DTO/view evidence. The OpenAI codec derives text only from represented blocks.
for (const content of [[], [{ kind: 'text', text: 'covered message 雪' }, { kind: 'refusal', text: 'covered refusal\r\n' }]]) {
  test(`generic ResponseView fallback renders once without covered duplicates (${content.length} blocks)`, async t => {
    const h = harness(); t.after(() => h.client.disconnect());
    await h.connect();
    const normalized = 'covered message 雪covered refusal\r\nadditional <img onerror=alert(1)> text';
    const response = { ...wire.response, outcome: { status: 'completed' }, text: normalized, items: [
      { ...wire.item, content },
      { item_id: 'opaque', kind: 'reasoning', function_call: null, content: [], unsupported_content: true },
    ] };
    await h.select(wire.sid, [event('session.created', 1), event('run.accepted', 2), event('run.started', 3),
      event('turn.started', 4, wire.sid, { turn_id: 'turn', number: '1' }),
      event('response.started', 5), event('response.finished', 6, wire.sid, response)]);
    const { root, view } = setup(t, h.client);
    view.render(frozen(h.client.snapshot()));
    const transcript = byClass(root, 'transcript');
    assert.equal(transcript.find(node => node.tag === 'h5' && node.textContent === 'Authoritative text fallback').length, 1);
    assert.equal(transcript.find(node => node.tag === 'pre' && node.textContent === normalized).length, 1);
    for (const block of content) assert.equal(transcript.find(node => node.tag === 'pre' && node.textContent === block.text).length, 0);
    assert.equal(transcript.find(node => node.tag === 'pre' && node.textContent === 'Unsupported content').length, 1);
    assert.doesNotMatch(transcript.textContent, /\(provisional\)/);
    assert.equal(transcript.find(node => ['script', 'img', 'a', 'iframe'].includes(node.tag)).length, 0);
  });
}

test('element-model canonical recovery has only read controls and no copied pending transcript', async t => {
  const h = await selected(t); const { root, view } = setup(t, h.client);
  const recovery = frozen({ command: { kind: 'task', id: wire.oid, session_id: wire.sid, body: wire.taskCommand },
    phase: 'accepted', error: null, receipt: null, reply: null, notices: [wire.notice], canonical_seen: true, canonical_sequence: '2' });
  view.render(frozen({ ...h.client.snapshot(), recoveries: [recovery] }));
  const commands = byClass(root, 'commands');
  assert.match(commands.textContent, /Canonical acceptance; receipt recovery/);
  assert.equal(commands.find(node => node.tag === 'button').filter(node => !node.hidden).map(node => node.textContent).includes('Reconcile receipt (read only)'), true);
  assert.equal(commands.find(node => node.tag === 'button' && /Retry|Discard/.test(node.textContent)).length, 0);
  assert.ok(!commands.textContent.includes(wire.exactText));
});

test('element-model pending text stays outside canonical history and cancel remains a disposition', async t => {
  const h = await selected(t); const { root, view } = setup(t, h.client);
  const pendingText = 'Pending only <svg onload=alert(1)>\r\n雪';
  const pending = frozen({ command: { kind: 'task', id: wire.oid, session_id: wire.sid, body: { ...wire.taskCommand, text: pendingText } },
    phase: 'uncertain', error: { category: 'http', status: 503, server: { ...wire.error, acceptance: null } },
    receipt: null, reply: null, notices: [wire.notice], canonical_seen: false, canonical_sequence: null });
  const snapshot = h.client.snapshot();
  view.render(frozen({ ...snapshot, pending: [pending], selected: { ...snapshot.selected, cancel: wire.cancel } }));
  assert.ok(!byClass(root, 'transcript').textContent.includes(pendingText));
  assert.ok(byClass(root, 'commands').textContent.includes(pendingText));
  assert.match(byClass(root, 'commands').textContent, /Certainty: unknown/);
  assert.match(root.textContent, /Cancel disposition: requested/);
  assert.match(root.textContent, /Execution: running/);
  assert.match(root.textContent, /not terminal truth/);
});

test('element-model Disconnect clears sensitive nodes and forms, not just visibility', async t => {
  const h = await selected(t); const { root, view } = setup(t, h.client);
  h.client.setDraft('unsent-secret-looking-canary'); view.render(h.client.snapshot());
  assert.ok(root.textContent.includes(wire.exactText));
  h.client.disconnect(); view.render(h.client.snapshot());
  assert.ok(!root.textContent.includes(wire.exactText));
  assert.ok(!root.textContent.includes(wire.sid));
  for (const node of root.find(node => ['input', 'textarea', 'select'].includes(node.tag))) assert.equal(node.value, '');
  assert.equal(byClass(root, 'transcript').children[1].children.length, 0);
});

test('element-model manifest failure stops loading at the unchanged cursor and requires explicit reload', async t => {
  const { h, root, view } = await connectedView(t);
  const done = h.client.selectSession(wire.sid);
  const before = h.client.snapshot().selected;
  (await h.next(`/v1/sessions/${wire.sid}`)).reject(new Error('private-manifest-canary'));
  await done; await tick();
  const after = h.client.snapshot().selected;
  assert.equal(after.observation, 'disconnected');
  assert.equal(after.manifest, null);
  assert.equal(after.history_complete, false);
  assert.equal(after.applied_cursor, before.applied_cursor);
  assert.equal(root.find(node => node.attributes['aria-label'] === 'Canonical session title')[0].textContent,
    'Canonical session unavailable. Use Reload history to try again.');
  const status = byClass(root, 'transcript').firstElementChild;
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Canonical history incomplete\. Loading stopped\..*Reload history/);
  assert.doesNotMatch(root.textContent, /Loading canonical|No messages yet\.|private-manifest-canary/);
  const error = byClass(byClass(root, 'conversation'), 'error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Network reply unavailable/);
  assert.equal(namedButton(root, 'Reconnect observation').disabled, true);
  assert.equal(namedButton(root, 'Reload history').disabled, false);
  view.render(h.client.snapshot()); await tick();
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
});

test('element-model initial history failure keeps the canonical title but never claims empty or loading', async t => {
  const { h, root } = await connectedView(t);
  const done = h.client.selectSession(wire.sid);
  (await h.next(`/v1/sessions/${wire.sid}`)).resolve(json(wire.session));
  const history = await h.next(`/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A0&limit=32`);
  const before = h.client.snapshot().selected;
  history.resolve(json(httpError('storage.io', 'unknown'), 503));
  await done; await tick();
  const after = h.client.snapshot().selected;
  assert.equal(after.observation, 'disconnected');
  assert.equal(after.history_complete, false);
  assert.equal(after.applied_cursor, before.applied_cursor);
  assert.equal(root.find(node => node.attributes['aria-label'] === 'Canonical session title')[0].textContent, wire.session.title);
  const status = byClass(root, 'transcript').firstElementChild;
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Canonical history incomplete\. Loading stopped\..*Reload history/);
  assert.doesNotMatch(root.textContent, /Loading canonical|No messages yet\./);
  const error = byClass(byClass(root, 'conversation'), 'error');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'HTTP 503\nCode: storage.io\nStage: none\nCertainty: unknown');
  assert.equal(namedButton(root, 'Reconnect observation').disabled, true);
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
});

test('element-model later-page failure exposes incomplete status without replacing or scrolling the valid prefix', async t => {
  const { h, root } = await connectedView(t);
  const done = h.client.selectSession(wire.sid);
  (await h.next(`/v1/sessions/${wire.sid}`)).resolve(json({ ...wire.session, head_sequence: '4' }));
  (await h.next(`/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A0&limit=32`)).resolve(json(page([
    event('session.created', 1), event('run.accepted', 2), event('run.started', 3),
  ], wire.sid, '4')));
  const later = await h.next(`/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A3&limit=32&through=4`);
  const transcript = byClass(root, 'transcript');
  const runs = transcript.children[1];
  const run = runs.firstElementChild;
  const text = runs.textContent;
  const disclosure = run.find(node => node.tag === 'details')[0];
  disclosure.open = true;
  transcript.scrollHeight = 1000; transcript.scrollTop = 125;
  const newContentHidden = namedButton(root, 'New content').hidden;
  const task = root.find(node => node.tag === 'label' && node.text === 'Task')[0].children[0];
  h.client.setDraft('  keep this draft\n雪  ');
  const before = h.client.snapshot().selected;
  later.reject(new Error('private-history-canary'));
  await done; await tick();
  const after = h.client.snapshot().selected;
  assert.equal(after.observation, 'disconnected');
  assert.equal(after.history_complete, false);
  assert.equal(after.applied_cursor, `${wire.sid}:3`);
  assert.equal(after.through_sequence, '4');
  assert.deepEqual(after.display, before.display);
  assert.equal(runs.textContent, text);
  assert.equal(runs.firstElementChild, run);
  assert.equal(run.find(node => node.tag === 'details')[0], disclosure);
  assert.equal(disclosure.open, true);
  assert.equal(transcript.scrollTop, 125);
  assert.equal(namedButton(root, 'New content').hidden, newContentHidden);
  assert.equal(root.find(node => node.tag === 'label' && node.text === 'Task')[0].children[0], task);
  assert.equal(task.value, '  keep this draft\n雪  ');
  assert.equal(transcript.firstElementChild.hidden, false);
  assert.match(transcript.firstElementChild.textContent, /Canonical history incomplete\. Loading stopped\..*Reload history/);
  assert.doesNotMatch(root.textContent, /Loading canonical|No messages yet\.|private-history-canary/);
  assert.match(byClass(byClass(root, 'conversation'), 'error').textContent, /Network reply unavailable/);
  assert.equal(namedButton(root, 'Reconnect observation').disabled, true);
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
});

test('element-model genuine manifest and history loads keep loading text until history completes', async t => {
  const { h, root } = await connectedView(t);
  const done = h.client.selectSession(wire.sid);
  const manifest = await h.next(`/v1/sessions/${wire.sid}`);
  const heading = root.find(node => node.attributes['aria-label'] === 'Canonical session title')[0];
  const status = byClass(root, 'transcript').firstElementChild;
  assert.equal(h.client.snapshot().selected.observation, 'loading');
  assert.equal(heading.textContent, 'Loading canonical session…');
  assert.equal(status.textContent, 'Loading canonical history…');
  assert.equal(status.hidden, false);
  manifest.resolve(json({ ...wire.session, head_sequence: '1' }));
  const history = await h.next(`/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A0&limit=32`);
  assert.equal(h.client.snapshot().selected.observation, 'loading');
  assert.equal(heading.textContent, wire.session.title);
  assert.equal(status.textContent, 'Loading canonical history…');
  assert.equal(namedButton(root, 'Reconnect observation').disabled, true);
  history.resolve(json(page([event('session.created', 1)])));
  const observation = await h.next(`/v1/sessions/${wire.sid}/events?after=${wire.sid}%3A1`);
  await done;
  assert.equal(h.client.snapshot().selected.observation, 'connecting');
  assert.equal(status.textContent, 'No messages yet.');
  assert.doesNotMatch(root.textContent, /Loading canonical/);
  observation.resolve(stream().response); await tick();
  assert.equal(h.client.snapshot().selected.observation, 'streaming');
  assert.equal(status.textContent, 'No messages yet.');
});

for (const failedRead of ['manifest', 'history']) {
  test(`element-model explicit reload after ${failedRead} failure restores loading at the same cursor then completes`, async t => {
    const { h, root } = await connectedView(t);
    const done = h.client.selectSession(wire.sid);
    let failed = await h.next(`/v1/sessions/${wire.sid}`);
    if (failedRead === 'history') {
      failed.resolve(json(wire.session));
      failed = await h.next(`/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A0&limit=32`);
    }
    failed.reject(new Error('private-reload-canary'));
    await done; await tick();
    const status = byClass(root, 'transcript').firstElementChild;
    assert.match(status.textContent, /Loading stopped\..*Reload history/);
    const before = h.client.snapshot().selected.applied_cursor;
    const requests = h.calls.length;
    namedButton(root, 'Reload history').listeners.click();
    assert.equal(h.client.snapshot().selected.applied_cursor, before);
    assert.equal(h.client.snapshot().selected.observation, 'loading');
    assert.equal(root.find(node => node.attributes['aria-label'] === 'Canonical session title')[0].textContent, 'Loading canonical session…');
    assert.equal(status.textContent, 'Loading canonical history…');
    assert.equal(status.hidden, false);
    assert.equal(namedButton(root, 'Reconnect observation').disabled, true);
    assert.equal(byClass(byClass(root, 'conversation'), 'error').hidden, true);
    (await h.next(`/v1/sessions/${wire.sid}`)).resolve(json({ ...wire.session, head_sequence: '1' }));
    (await h.next(`/v1/sessions/${wire.sid}/history?after=${wire.sid}%3A0&limit=32`)).resolve(json(page([event('session.created', 1)])));
    (await h.next(`/v1/sessions/${wire.sid}/events?after=${wire.sid}%3A1`)).resolve(stream().response);
    await tick();
    assert.equal(h.client.snapshot().selected.history_complete, true);
    assert.equal(h.client.snapshot().selected.observation, 'streaming');
    assert.equal(status.textContent, 'No messages yet.');
    assert.equal(status.hidden, false);
    assert.doesNotMatch(root.textContent, /Loading canonical|Loading stopped|private-reload-canary/);
    assert.equal(h.calls.length, requests + 3);
    assert.ok(h.calls.every(call => call.init.method === 'GET'));
  });
}

test('element-model stream disconnect after completed empty history stays empty and permits explicit reconnect', async t => {
  const { h, root } = await connectedView(t);
  const observation = await h.select();
  const before = h.client.snapshot().selected;
  const transcript = byClass(root, 'transcript');
  assert.equal(transcript.firstElementChild.textContent, 'No messages yet.');
  assert.equal(namedButton(root, 'Reconnect observation').disabled, true);
  observation.fail(); await tick();
  const after = h.client.snapshot().selected;
  assert.equal(after.observation, 'disconnected');
  assert.equal(after.history_complete, true);
  assert.equal(after.applied_cursor, before.applied_cursor);
  assert.equal(transcript.firstElementChild.textContent, 'No messages yet.');
  assert.equal(transcript.firstElementChild.hidden, false);
  assert.doesNotMatch(root.textContent, /Loading canonical|Loading stopped|Canonical history incomplete|private transport details/);
  assert.match(byClass(byClass(root, 'conversation'), 'error').textContent, /Network reply unavailable/);
  assert.equal(namedButton(root, 'Reconnect observation').disabled, false);
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every(call => call.init.method === 'GET'));
});
