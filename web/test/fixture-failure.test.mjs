import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { startFixture } from '../test-support/fixture.mjs';
import { rustPageFixture } from '../test-support/display-dom.mjs';

const terminal = { protocol: 1, event: 'fixture_failed', phase: 'events_query', category: 'query_other' };
const inspect = { protocol: 1, event: 'inspect', connections: 0, requests: 0, gate: null, completed: 0,
  fresh_empty: false, restored_history: false, fresh_parents: 0, continuations: 0, prepared_exact: 0,
  auth_loads: 0, auth_prepares: 0, sequence_count: '1', accepted: [], receipts: [], tool_results: 0, terminals: 0, results: 0,
  response_finishes: [], terminal_sequences: [], result_sequences: [], provider_stage: null, provider_failed: false, read_failure: null };
// Real pipes and owned synthetic children prove failure handling without browser SQL faults.
async function peer(t, mode, order) {
  const root = await mkdtemp(join(tmpdir(), 'wi-fixture-peer-'));
  const executable = join(root, 'peer.mjs'), metadata = join(root, 'owned.json'), closure = join(root, 'closure.json');
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)}, order = ${JSON.stringify(order)};
const commands = [];
const save = signal => fs.writeFileSync(${JSON.stringify(closure)}, JSON.stringify({ commands, signal, teardown: signal === null }));
fs.writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({ pid: process.pid, sandbox: process.cwd() }));
process.on('SIGTERM', () => { save('SIGTERM'); process.exit(7); });
const lines = readline.createInterface({ input: process.stdin });
let fatal = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('close', () => { save(null); process.stdout.end(() => process.exit(fatal ? 7 : 0)); });
lines.on('line', line => {
  const request = JSON.parse(line);
  commands.push(request.command ?? 'start');
  if (!request.command) { send({ protocol: 1, event: 'ready', id: request.id, origin: 'http://127.0.0.1:1' }); return; }
  if (mode === 'fatal') {
    fatal = true;
    const ack = request.command === 'select' ? { protocol: 1, event: 'selected', id: request.id }
      : request.command === 'stop' ? { protocol: 1, event: 'stopped', id: request.id, cleaned: true }
      : { ...${JSON.stringify(inspect)}, id: request.id };
    const event = ${JSON.stringify(terminal)};
    const values = order === 'ack-first' ? [ack, event] : order === 'fatal-first' ? [event, ack] : [event];
    process.stdout.write(values.map(value => JSON.stringify(value)).join('\\n') + '\\n');
    if (order === 'later-errors') process.stdout.write(JSON.stringify({ ...event, phase: 'unknown', category: 'control_other' }) + '\\n{invalid\\n');
    return;
  }
  if (mode === 'absent') { save(null); process.stdout.end(() => process.exit(0)); return; }
  // Both signal and EOF must keep the failed-output exit policy.
  if (mode === 'invalid') { fatal = true; process.stdout.write('{invalid\\n'); return; }
  if (mode === 'private') { fatal = true; send({ ...${JSON.stringify(terminal)}, token: 'synthetic-private-canary' }); return; }
  send({ protocol: 1, event: 'stopped', id: request.id, cleaned: true });
  if (mode === 'stderr') process.stderr.write('synthetic static failure\\n');
  save(null); process.stdout.end(() => process.exit(mode === 'nonzero' ? 7 : 0));
});
`, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { executable, owned: async () => JSON.parse(await readFile(metadata, 'utf8')), closure: async () => JSON.parse(await readFile(closure, 'utf8')) };
}
async function reaped(owned) {
  assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(owned.sandbox), { code: 'ENOENT' });
}
test('peer allocation uses the caller temporary parent and cleanup preserves that parent', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'wi-fixture-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const previous = process.env.TMPDIR;
  let root;
  try {
    process.env.TMPDIR = parent;
    await t.test('owned peer root', async inner => {
      const p = await peer(inner, 'healthy');
      root = dirname(p.executable);
      assert.equal(dirname(root), parent);
      await access(p.executable);
    });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  await assert.rejects(access(root), { code: 'ENOENT' });
  await access(parent);
});
for (const mode of ['invalid', 'private']) for (const route of ['SIGTERM', 'EOF']) {
  test(`direct ${mode} peer exits 7 through ${route} after the failed-output handshake`, async t => {
    const p = await peer(t, mode);
    const child = spawn(p.executable, [], { cwd: dirname(p.executable), stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    });
    let stderrBytes = 0;
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    const ready = await lines.next();
    assert.equal(ready.done, false);
    assert.deepEqual(JSON.parse(ready.value), { protocol: 1, event: 'ready', id: 1, origin: 'http://127.0.0.1:1' });
    child.stdin.write(JSON.stringify({ command: 'stop', id: 2 }) + '\n');
    const output = await lines.next();
    assert.equal(output.done, false);
    // Compare in memory so the malformed private vector never enters failure output.
    const expected = mode === 'invalid' ? '{invalid' : JSON.stringify({ ...terminal, token: 'synthetic-private-canary' });
    assert.equal(output.value === expected, true);
    if (route === 'SIGTERM') assert.equal(child.kill('SIGTERM'), true);
    else child.stdin.end();
    const [code, signal] = await closed;
    assert.equal(code, 7); assert.equal(signal, null); assert.equal(stderrBytes, 0);
    assert.deepEqual(await p.closure(), { commands: ['start', 'stop'], signal: route === 'SIGTERM' ? 'SIGTERM' : null, teardown: route === 'EOF' });
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  });
}
const launchers = {
  joined: executable => startFixture(executable, { transport: 'websocket', recovered: false, mime: true }),
  display: rustPageFixture,
};
for (const [name, launch] of Object.entries(launchers)) {
  for (const command of ['select', 'inspect', 'stop']) for (const order of ['none', 'ack-first', 'fatal-first', 'later-errors']) {
    test(`${name} terminal rejects ${command}/${order}, freezes first evidence and lets native teardown finish`, async t => {
      const p = await peer(t, 'fatal', order), fixture = await launch(p.executable), owned = await p.owned();
      t.after(() => fixture.stop().catch(() => {}));
      const before = fixture.evidence();
      const action = command === 'stop' ? fixture.stop() : fixture.request({ command, ...(command === 'select' ? { session_id: '11111111-1111-4111-8111-111111111111' } : {}) });
      await assert.rejects(action);
      assert.deepEqual(fixture.evidence().failure, { phase: 'events_query', category: 'query_other' });
      await assert.rejects(fixture.request({ command: 'inspect' }));
      const errors = await Promise.all([fixture.stop().catch(error => error), fixture.stop().catch(error => error)]);
      assert.equal(errors[0], errors[1]);
      assert.ok(errors[0] instanceof Error);
      await assert.rejects(fixture.stop());
      const facts = fixture.evidence();
      assert.deepEqual(facts.failure, { phase: 'events_query', category: 'query_other' });
      assert.throws(() => { facts.failure.phase = 'unknown'; }, TypeError);
      assert.throws(() => { facts.stop.reap_complete = false; }, TypeError);
      assert.equal(before.failure, null); assert.equal(before.stop.reap_complete, false);
      assert.equal(facts.stop.attempted, command === 'stop');
      assert.equal(facts.stop.clean_acknowledgment, command === 'stop' && ['ack-first', 'fatal-first'].includes(order));
      assert.deepEqual([facts.stop.exit_observed, facts.stop.exit_zero, facts.stop.error_latched, facts.stop.stderr_empty,
        facts.stop.reap_complete, facts.stop.sandbox_removed, facts.stop.sigterm, facts.stop.sigkill], [true, false, true, true, true, true, false, false]);
      assert.deepEqual(await p.closure(), { commands: ['start', command], signal: null, teardown: true });
      await reaped(owned);
    });
  }
  for (const mode of ['healthy', 'absent', 'invalid', 'nonzero', 'stderr', 'private']) {
    test(`${name} Stop separates ${mode} acknowledgment, exit, stderr, failure and resource facts`, async t => {
      const p = await peer(t, mode), fixture = await launch(p.executable), owned = await p.owned();
      t.after(() => fixture.stop().catch(() => {}));
      if (mode === 'healthy') await fixture.stop();
      else { await assert.rejects(fixture.stop()); await assert.rejects(fixture.stop()); }
      const facts = fixture.evidence().stop;
      assert.equal(facts.attempted, true);
      assert.equal(facts.clean_acknowledgment, ['healthy', 'nonzero', 'stderr'].includes(mode));
      assert.equal(facts.exit_observed, true);
      assert.equal(facts.exit_zero, ['healthy', 'absent', 'stderr'].includes(mode));
      assert.equal(facts.stderr_empty, mode !== 'stderr');
      assert.equal(facts.reap_complete, true); assert.equal(facts.sandbox_removed, true);
      if (mode === 'healthy') assert.equal(facts.error_latched, false);
      assert.equal(fixture.evidence().failure, null);
      if (['invalid', 'private'].includes(mode)) {
        assert.equal(facts.error_latched, true);
        assert.equal(facts.clean_acknowledgment, false);
        assert.throws(() => { facts.error_latched = false; }, TypeError);
        const closure = await p.closure();
        // A signal attempt does not prove its handler beat stdin closure.
        assert.ok(closure.signal === null || closure.signal === 'SIGTERM');
        assert.deepEqual(closure, { commands: ['start', 'stop'], signal: closure.signal, teardown: closure.signal === null });
        assert.equal(facts.sigterm, true, 'later exit errors must not erase an actual termination');
      }
      await reaped(owned);
    });
  }
}
