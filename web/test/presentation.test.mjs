import assert from 'node:assert/strict';
import test from 'node:test';
import { answer, data, labels, measurement, skillOutput } from '../test-support/presentation.mjs';

const sample = { label: 'short-selected', first_page_ms: 0, durable_acceptance_ms: 1.25, committed_visibility_ms: 2,
  reducer_render_ms: 3, rebuild_ms: 4, stall_ms: 0, first_page_events: 1, history_pages: 4, selected_events: 100,
  selected_dom_nodes: 150, local_dom_nodes: 150, live_updates: 0, deltas: 64 };

test('finite measurement output has exactly three closed labels and numeric fields', () => {
  assert.equal(labels.length, 3);
  assert.equal(new Set(labels).size, 3);
  for (const label of labels) assert.deepEqual(measurement({ ...sample, label }), { ...sample, label });
  assert.equal(measurement({ ...sample, reducer_render_ms: 1.23456 }).reducer_render_ms, 1.23);
  for (const value of [null, [], {}, { ...sample, label: 'private-canary' }, { ...sample, token: 'private-canary' },
    { ...sample, path: '/private' }, { ...sample, selected_events: '100' }, { ...sample, selected_events: 1.5 },
    { ...sample, selected_events: 10001 }, { ...sample, reducer_render_ms: -1 }, { ...sample, first_page_ms: Infinity },
    { ...sample, durable_acceptance_ms: NaN }, { ...sample, stall_ms: 180001 }, { ...sample, live_updates: -1 }]) {
    assert.throws(() => measurement(value), { message: 'measurement rejected' });
  }
  for (const key of Object.keys(sample)) {
    const missing = { ...sample }; delete missing[key];
    assert.throws(() => measurement(missing), { message: 'measurement rejected' });
  }
});

test('presentation bytes remain distinct inert canaries and successful skill output remains a string', () => {
  assert.deepEqual(Object.keys(data), ['title', 'user', 'text', 'refusal', 'summary', 'reasoning', 'arguments', 'tool']);
  assert.equal(new Set(Object.values(data)).size, 8);
  for (const text of Object.values(data)) for (const marker of ['<script>', '<img', 'onerror=', 'javascript:', '\u001b', '雪', 'é', '😀']) {
    assert.ok(text.includes(marker));
  }
  assert.ok(data.user.endsWith('\n') && !data.user.includes('\r'));
  assert.equal(JSON.parse(skillOutput).body, data.tool);
  assert.ok(JSON.parse(skillOutput).body.startsWith('{"error":'));
  assert.ok(answer(0).includes('\r\n') && answer(0).endsWith('W'.repeat(2048)));
});
