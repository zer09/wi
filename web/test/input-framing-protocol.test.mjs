import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControl, stdoutParser } from '../test-support/fixture.mjs';

const evidence = { protocol: 1, id: 1, event: 'input_framing_seeded', max_input_bytes: 1048576,
  task_bytes: 786432, unframed_bytes: 786466, project_bytes: 524288, skill_bytes: 100,
  framed_bytes: 1311200, catalog_entries: 1, unframed_valid: true, framing_overflow: true };

test('input framing evidence contains only bounded sizes and validated outcomes', () => {
  assert.deepEqual(parseControl(evidence), evidence);
  const messages = [];
  const parser = stdoutParser(value => messages.push(value));
  const bytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
  assert.ok(bytes.length <= 4096);
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(messages, [evidence]);
});

test('input framing evidence rejects missing, private, mistyped and out-of-range fields', () => {
  for (const field of Object.keys(evidence)) {
    const value = { ...evidence };
    delete value[field];
    assert.throws(() => parseControl(value), { message: 'fixture protocol rejected' });
    for (const invalid of [null, [], {}, 'private-canary']) {
      assert.throws(() => parseControl({ ...evidence, [field]: invalid }), { message: 'fixture protocol rejected' });
    }
  }
  for (const changed of [
    { text: 'private-canary' }, { digest: 'private-canary' }, { id: 0 }, { id: 0x100000000 },
    { max_input_bytes: 0 }, { max_input_bytes: Number.MAX_SAFE_INTEGER }, { task_bytes: 0 },
    { task_bytes: 1048576 }, { project_bytes: 1048576 }, { catalog_entries: 0 }, { catalog_entries: 2 },
    { unframed_bytes: 786432 }, { unframed_bytes: 1048577 }, { unframed_bytes: 786466.5 },
    { skill_bytes: 0 }, { skill_bytes: -1 }, { skill_bytes: 1048576 }, { skill_bytes: 1.5 },
    { framed_bytes: 1048576 }, { framed_bytes: 2097152 }, { framed_bytes: 1311200.5 },
    { unframed_valid: false }, { framing_overflow: false },
  ]) assert.throws(() => parseControl({ ...evidence, ...changed }), { message: 'fixture protocol rejected' });
});
