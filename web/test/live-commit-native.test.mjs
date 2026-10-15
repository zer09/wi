import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, lstat, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHILD, ROOT, TARGET, texts, digest, workKeys, workProof, savedProof, readersProof, decode, protocol, parser,
  telemetryProof, artifactFromCargo, nativeSources, nativeBinding, sourceProof, createRoot, rootProof, identityProof,
  nativePhases, nodeBoundaries, nativeFailureProof, nativeCleanupProof,
  terminalProof, launchNative, removeRoot,
} from '../test-support/live-commit-native.mjs';

const sid = '54000000-0000-4000-8000-000000000001', rid = '54000000-0000-4000-8000-000000000002';
const clone = v => structuredClone(v);
const work = stage => Object.fromEntries(workKeys.map(k => [k, stage > 0 && !['completed', 'tool_validations', 'tool_executions'].includes(k) || stage === 2 && k === 'completed' ? 1 : 0]));
const readers = { opened: 2, closed: 2, active: 0 };
function saved(kind, head = { first: 6, append: 7, authoritative: 8, terminal: 12 }[kind]) {
  const terminal = kind === 'terminal', text = texts[['authoritative', 'terminal'].includes(kind) ? 'final' : kind];
  return { session_id: sid, run_id: rid, entry_id: 'e:5:0', field_id: digest('field'), head, projection_head: head,
    generation: ['authoritative', 'terminal'].includes(kind) ? 8 : 5, content_epoch: 5,
    bytes: Buffer.byteLength(text), sha256: digest(text), matches: true, provisional: !terminal,
    entry_state: terminal ? 'completed' : 'in_progress', run_state: terminal ? 'completed' : 'running',
    result_recorded: terminal, response_finished: terminal, run_finished: terminal, events_complete: terminal ? true : null };
}
const ready = pid => ({ protocol: 1, event: 'ready', id: 1, pid, origin: 'http://127.0.0.1:54321', session_id: sid, head: 1, work: work(0) });
const reply = (event, id, extra = {}) => ({ protocol: 1, event, id, ...extra });
function telemetry() {
  const totals = Array.from({ length: 30 }, (_, s) => [1, s, 0, 0, 0, 0]);
  totals[20] = [1, 20, 1, 2, 2, 0]; totals[21] = [1, 21, 3, 6, 6, 0]; totals[22] = [1, 22, 1, 2, 2, 0];
  totals[2] = [1, 2, 1, 20, 20, 1];
  const leaves = [20, 21, 21, 21, 22].map((s, i) => [2, s, 42, 0, 2, 2 + i * 3, 4 + i * 3, 0, 0]);
  const rows = [[0, 100, 120, 10, 10, 0, 0, 0, 0], ...totals, [4, 0, 0, 0, 0], [3, 42, 1, 2], ...leaves, [2, 2, 42, 0, 2, 0, 20, 1, 0]];
  return Array.from({ length: Math.ceil(rows.length / 24) }, (_, page) => ({ page, pages: Math.ceil(rows.length / 24), rows: rows.slice(page * 24, (page + 1) * 24) }));
}
const allRows = pages => pages.flatMap(p => p.rows);
function observerTelemetry(shape) {
  const rows = allRows(telemetry());
  rows.splice(rows.findIndex(r => r[0] === 2), 0, [3, 43, 2, 0]);
  if (shape === 'completed') {
    // Collector detail follows completion order: DisplayWait, DisplayHeld, then Operation.
    rows.splice(rows.findIndex(r => r[0] === 2), 0,
      [2, 9, 43, 0, 0, 0, 0, 0, 0], [2, 3, 43, 0, 0, 0, 1, 0, 0], [2, 0, 43, 0, 0, 0, 1, 0, 0]);
    for (const stage of [0, 3]) rows[1 + stage] = [1, stage, 1, 1, 1, 0];
    rows[1 + 9] = [1, 9, 1, 0, 0, 0];
  } else if (shape === 'pending' || shape === 'pre-window') {
    const clipped = shape === 'pre-window' ? 1 : 0, start = clipped ? 0 : 5;
    rows.push([2, 0, 43, 0, 0, start, 20, 1, clipped], [2, 9, 43, 0, 0, start, 20, 1, clipped]);
    for (const stage of [0, 9]) rows[1 + stage] = [1, stage, 1, 20 - start, 20 - start, 1];
    // Only DisplayWait is a leaf. Its overlap changes the header, not selected work.
    rows[0] = clipped ? [0, 100, 120, 20, 0, 10, 0, 0, 2] : [0, 100, 120, 17, 3, 8, 0, 0, 0];
  } else assert.equal(shape, 'metadata');
  return Array.from({ length: Math.ceil(rows.length / 24) }, (_, page) => ({ page, pages: Math.ceil(rows.length / 24), rows: rows.slice(page * 24, (page + 1) * 24) }));
}

test('scalar fixtures and actual work counters have closed exact expectations', async t => {
  assert.deepEqual(['first', 'delta', 'append', 'final'].map(k => Buffer.byteLength(texts[k])), [7, 6, 13, 19]);
  for (const stage of [0, 1, 2]) {
    assert.equal(workProof(work(stage), stage), true);
    for (const key of workKeys) await t.test(`stage ${stage} rejects counter ${key}`, () => {
      const v = work(stage); v[key]++; assert.throws(() => workProof(v, stage));
    });
  }
  assert.throws(() => workProof({ ...work(0), extra: 0 }, 0));
  assert.throws(() => workProof(work(0), 3));
});

test('full saved endpoint predicates reject independent identity, text, range and terminal defects', async t => {
  for (const kind of ['first', 'append', 'authoritative', 'terminal']) {
    assert.equal(savedProof(saved(kind), kind), true);
    for (const key of Object.keys(saved(kind))) await t.test(`${kind} rejects ${key}`, () => {
      const v = saved(kind);
      if (typeof v[key] === 'number') v[key] = 0;
      else if (typeof v[key] === 'boolean') v[key] = !v[key];
      else if (v[key] === null) v[key] = true;
      else v[key] = 'wrong';
      assert.throws(() => savedProof(v, kind));
    });
  }
  for (const [prior, next] of [['first', 'append'], ['append', 'authoritative'], ['authoritative', 'terminal']]) {
    assert.equal(savedProof(saved(next), next, saved(prior)), true);
    for (const key of ['session_id', 'run_id', 'entry_id', 'field_id', 'content_epoch', 'generation', 'head']) await t.test(`${next} rejects changed ${key}`, () => {
      const v = saved(next);
      if (key === 'head') { v.head = saved(prior).head; v.projection_head = v.head; }
      else if (key === 'generation') v.generation = next === 'authoritative' ? saved(prior).generation : saved(prior).generation + 1;
      else if (typeof v[key] === 'number') v[key]++;
      else if (key === 'entry_id') v[key] = 'e:4:0';
      else if (key === 'field_id') v[key] = digest('other');
      else v[key] = '54000000-0000-4000-8000-000000000003';
      assert.throws(() => savedProof(v, next, saved(prior)));
    });
  }
});

test('closed JSON and byte-stream parser reject duplicate keys, invalid UTF8 and harness loss', async t => {
  for (const line of ['{"id":1,"id":2}\n', '{"nested":{"x":1,"x":2}}\n', '{"nested":[{"x":1,"x":2}]}\n', '{"x":"\\u0061"}\n', '{"x":1}', 'x\n', `${' '.repeat(16384)}\n`]) {
    assert.throws(() => decode(line));
  }
  const message = reply('armed', 4);
  const text = `\nrunning 1 test\ntest ${CHILD} ... ${JSON.stringify(message)}\nok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 955 filtered out; finished in 0.01s\n\n`;
  const bytes = Buffer.from(text);
  for (const split of [1, 2, 7, bytes.length]) await t.test(`split ${split}`, () => {
    const messages = [], p = parser(v => messages.push(v));
    for (let i = 0; i < bytes.length; i += split) p.push(bytes.subarray(i, i + split));
    p.end(); assert.deepEqual(messages, [message]); assert.throws(() => p.end()); assert.throws(() => p.push(Buffer.from('\n')));
  });
  for (const bad of [text.replace('running 1 test\n', ''), text.replace('ok\n', ''), text.replace('test result: ok.', 'test result: FAILED.'), text + 'extra\n', text.replace('ok\n', 'ok\nok\n'), text.replace(' ... ', ' ... ' + JSON.stringify(message) + '\n' + `test ${CHILD} ... `)]) {
    const p = parser(() => {}); assert.throws(() => { p.push(Buffer.from(bad)); p.end(); });
  }
  const p = parser(() => {}); assert.throws(() => p.push(Buffer.from([0xff])));
  const partial = parser(() => {}); partial.push(Buffer.from([0xe9])); assert.throws(() => partial.end());
  assert.throws(() => parser(() => {}).push(Buffer.alloc(1024 * 1024 + 1)));
});

test('telemetry selects completed 20/21/21/21/22 leaves, not correlation or pending enclosing work', async t => {
  const proof = telemetryProof(telemetry());
  assert.deepEqual(proof.projection_us, [2, 2, 2]); assert.equal(proof.projection_sum_us, 6);
  assert.equal(proof.canonical_insert_us, 2); assert.equal(proof.commit_us, 2); assert.equal(proof.canonical_to_commit_us, 14);
  assert.equal(proof.other_intervals[0].pending, true);
  for (const [name, mutate] of [
    ['former parent oracle', r => { for (const v of r.filter(v => v[0] === 2 && v[1] >= 20)) v[1]--; }],
    ['missing leaf', r => r.splice(r.findIndex(v => v[0] === 2 && v[1] === 22), 1)],
    ['duplicate leaf', r => r.push(clone(r.find(v => v[0] === 2 && v[1] === 20)))],
    ['wrong delta', r => { r.find(v => v[0] === 3)[3] = 3; }],
    ['ambiguous operation', r => r.push([3, 43, 1, 2])],
    ['unknown operation kind', r => r.push([3, 43, 3, 0])],
    ['zero operation ID', r => r.push([3, 0, 2, 0])],
    ['duplicate operation ID', r => r.push([3, 42, 2, 0])],
    ['wrong read', r => { r.find(v => v[0] === 2 && v[1] === 20)[3] = 1; }],
    ['pending leaf', r => { r.find(v => v[0] === 2 && v[1] === 20)[7] = 1; }],
    ['clipped leaf', r => { r.find(v => v[0] === 2 && v[1] === 20)[8] = 1; }],
    ['overlap', r => { r.find(v => v[0] === 2 && v[1] === 20)[6] = 6; }],
    ['failed collector', r => { r[0][7] = 1; }],
    ['truncation', r => { r[0][6] = 1; }],
    ['overflow', r => { r[0][2] = Number.MAX_SAFE_INTEGER + 1; }],
    ['total count', r => { r.find(v => v[0] === 1 && v[1] === 21)[2]++; }],
    ['total elapsed', r => { r.find(v => v[0] === 1 && v[1] === 21)[3]++; }],
    ['unknown operation', r => { r.find(v => v[0] === 2)[2] = 999; }],
    ['row schema', r => r.push([9, 0])],
  ]) await t.test(name, () => {
    const rows = clone(allRows(telemetry())); mutate(rows);
    const pages = Array.from({ length: Math.ceil(rows.length / 24) }, (_, page) => ({ page, pages: Math.ceil(rows.length / 24), rows: rows.slice(page * 24, (page + 1) * 24) }));
    assert.throws(() => telemetryProof(pages));
  });
  const p = telemetry(); p[1].page = 0; assert.throws(() => telemetryProof(p));
});

test('nonselected metadata accepts the closed kind domain without changing the full selected proof', async t => {
  const baseline = telemetryProof(telemetry());
  for (const kind of [0, 1, 2]) await t.test(`kind ${kind}`, () => {
    const pages = observerTelemetry('metadata');
    allRows(pages).find(r => r[0] === 3 && r[1] === 43)[2] = kind;
    const before = clone(pages);
    assert.deepEqual(telemetryProof(pages), baseline);
    assert.deepEqual(pages, before);
  });
});

test('display observer detail retains completed, pending and clipped facts separately from selected leaves', async t => {
  const { other_intervals: baselineOther, ...selected } = telemetryProof(telemetry());
  const selectedRows = rows => rows.filter(r => r[0] === 3 && r[1] === 42
    || r[0] === 1 && [20, 21, 22].includes(r[1]) || r[0] === 2 && r[2] === 42);
  for (const shape of ['completed', 'pending', 'pre-window']) await t.test(shape, () => {
    const pages = observerTelemetry(shape), before = clone(pages);
    assert.deepEqual(selectedRows(allRows(pages)), selectedRows(allRows(telemetry())));
    const { other_intervals, ...actualSelected } = telemetryProof(pages);
    assert.deepEqual(actualSelected, selected);
    const clipped = shape === 'pre-window', pending = shape !== 'completed';
    const expected = pending
      ? [0, 9].map(stage => ({ stage, operation: 43, read: 0, delta: 0, start_us: clipped ? 0 : 5, end_us: 20, pending: true, clipped }))
      : [{ stage: 9, operation: 43, read: 0, delta: 0, start_us: 0, end_us: 0, pending: false, clipped: false },
        { stage: 3, operation: 43, read: 0, delta: 0, start_us: 0, end_us: 1, pending: false, clipped: false },
        { stage: 0, operation: 43, read: 0, delta: 0, start_us: 0, end_us: 1, pending: false, clipped: false }];
    assert.deepEqual(other_intervals.filter(r => r.operation === 43), expected);
    assert.deepEqual(other_intervals.filter(r => r.operation !== 43), baselineOther);
    assert.deepEqual(pages, before);
    allRows(pages).find(r => r[0] === 3 && r[1] === 43)[2] = 3;
    assert.throws(() => telemetryProof(pages));
  });
});

function advance(p, until = 'complete') {
  const pages = telemetry(); let serial = 1;
  p.reply(ready(12345));
  const step = (command, event, extra = {}, body = {}) => { const id = ++serial; p.send({ command, id, ...body }); p.reply(reply(event, id, extra)); };
  step('first', 'first', { saved: saved('first'), work: work(1) });
  if (until === 'first') return serial;
  step('observed_first', 'first_observed', {}, { observed: saved('first') });
  step('arm', 'armed');
  step('second', 'captured', { saved: saved('append'), operation_id: rid, pause_hits: 1, reader_closed: true, readers, released: true, pages: pages.length });
  if (until === 'captured') return serial;
  for (const page of pages) step('page', 'page', page, { page: page.page });
  if (until === 'pages') return serial;
  step('authoritative', 'authoritative', { saved: saved('authoritative') }, { observed: saved('append') });
  if (until === 'authoritative') return serial;
  step('terminal', 'terminal', { saved: saved('terminal'), work: work(2) }, { observed: saved('authoritative') });
  if (until === 'terminal') return serial;
  step('observed_terminal', 'complete', {}, { observed: saved('terminal') });
  return serial;
}
test('closed protocol enforces first commit, observation admissions and independent release before DOM', async t => {
  const p = protocol(), last = advance(p);
  p.send({ command: 'stop', id: last + 1 }); p.reply(reply('stopping', last + 1, { complete: true, work: work(2) }));
  p.reply(reply('stopped', last + 1, { drained: true, readers })); assert.equal(p.end(), true);
  assert.throws(() => p.reply(reply('stopped', last + 1, { drained: true, readers })));
  for (const [phase, command, observed] of [
    ['first', 'arm'], ['captured', 'terminal', saved('append')], ['captured', 'authoritative', saved('append')],
    ['pages', 'terminal', saved('append')], ['authoritative', 'observed_terminal', saved('authoritative')],
    ['terminal', 'authoritative', saved('terminal')],
  ]) await t.test(`${phase} rejects ${command}`, () => {
    const p = protocol(), serial = advance(p, phase);
    assert.throws(() => p.send({ command, id: serial + 1, ...(observed ? { observed } : {}) }));
  });
  for (const body of [{ command: 'first', id: 2 }, { command: 'stop', id: 0 }]) assert.throws(() => protocol().send(body));
  for (const body of [{ command: 'first', id: 1 }, { command: 'first', id: 3 }, { command: 'first', id: 2, extra: 1 }, { command: 'toString', id: 2 }]) {
    const p = protocol(); p.reply(ready(12345)); assert.throws(() => p.send(body));
  }
  const bad = protocol(), n = advance(bad, 'captured'); bad.send({ command: 'page', page: 0, id: n + 1 });
  assert.throws(() => bad.reply(reply('page', n + 1, { ...telemetry()[0], pages: 99 })));
  const missing = protocol(); missing.reply(ready(12345)); assert.throws(() => missing.end());
});

test('actual protocol final-page validation admits display observers before authoritative replacement', async t => {
  for (const shape of ['metadata', 'completed', 'pending', 'pre-window']) await t.test(shape, () => {
    const pages = observerTelemetry(shape), p = protocol(); let serial = advance(p, 'captured');
    assert.equal(pages.length, telemetry().length);
    for (const page of pages) {
      p.send({ command: 'page', id: ++serial, page: page.page });
      p.reply(reply('page', serial, page));
    }
    p.send({ command: 'authoritative', id: ++serial, observed: saved('append') });
    p.reply(reply('authoritative', serial, { saved: saved('authoritative') }));
    p.send({ command: 'terminal', id: ++serial, observed: saved('authoritative') });
    p.reply(reply('terminal', serial, { saved: saved('terminal'), work: work(2) }));
    p.send({ command: 'observed_terminal', id: ++serial, observed: saved('terminal') }); p.reply(reply('complete', serial));
    p.send({ command: 'stop', id: ++serial }); p.reply(reply('stopping', serial, { complete: true, work: work(2) }));
    p.reply(reply('stopped', serial, { drained: true, readers })); assert.equal(p.end(), true);
  });
  const pages = observerTelemetry('pending'), p = protocol(); let serial = advance(p, 'captured');
  allRows(pages).find(r => r[0] === 3 && r[1] === 43)[2] = 3;
  for (const page of pages) {
    p.send({ command: 'page', id: ++serial, page: page.page });
    if (page.page === pages.length - 1) assert.throws(() => p.reply(reply('page', serial, page)));
    else p.reply(reply('page', serial, page));
  }
  assert.throws(() => p.send({ command: 'authoritative', id: serial + 1, observed: saved('append') }));
});

test('Cargo JSON binding resolves only one current isolated lib-test artifact and complete source set', async t => {
  const executable = `${TARGET}/debug/deps/wi-0123456789abcdef`;
  const artifact = { reason: 'compiler-artifact', target: { kind: ['lib'], name: 'wi', src_path: join(ROOT, 'src/lib.rs') }, profile: { test: true }, executable };
  const finish = { reason: 'build-finished', success: true };
  const text = (...v) => v.map(v => JSON.stringify(v)).join('\n');
  assert.equal(artifactFromCargo(text(artifact, finish)), executable);
  for (const bad of [text(artifact), text(artifact, artifact, finish), text(artifact, { ...finish, success: false }), text({ ...artifact, executable: '/old/wi-0123456789abcdef' }, finish), text({ ...artifact, target: { ...artifact.target, src_path: '/other/src/lib.rs' } }, finish), 'invalid']) {
    assert.throws(() => artifactFromCargo(bad));
  }
  const sources = await nativeSources();
  for (const p of ['Cargo.lock', 'src/lib.rs', 'src/storage/test_hooks/latency.rs', 'src/providers/openai_codex/tests/replay/http_api_joined/live_commit.rs', 'src/providers/openai_codex/tests/replay/http_api_joined/browser.rs']) assert.ok(sources[p]);
  assert.equal(sources['src/lib.rs'].sha256, digest(await readFile(join(ROOT, 'src/lib.rs'))));
  assert.equal(sourceProof(sources, clone(sources)), true);
  for (const defect of ['missing', 'extra', 'sha256', 'mode', 'bytes']) await t.test(`source ${defect}`, () => {
    const v = clone(sources);
    if (defect === 'missing') delete v['src/lib.rs'];
    else if (defect === 'extra') v['unknown.rs'] = clone(v['src/lib.rs']);
    else if (defect === 'sha256') v['src/lib.rs'].sha256 = '0'.repeat(64);
    else v['src/lib.rs'][defect]++;
    assert.throws(() => sourceProof(v, sources));
  });
  await assert.rejects(nativeBinding({ executable: process.execPath, selector: CHILD, sha256: digest(await readFile(process.execPath)), sources }));
  for (const key of ['selector', 'sources']) await t.test(`missing ${key}`, async () => {
    const v = { executable, selector: CHILD, sha256: '0'.repeat(64), sources }; delete v[key]; await assert.rejects(nativeBinding(v));
  });
});

test('private root creation never adopts and rejects owner, modes, inode and symlink changes', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'wi-c54-unit-'));
  try {
    await chmod(parent, 0o700);
    const f = await createRoot(parent); assert.equal(await rootProof(f), true);
    assert.equal((await lstat(f.root)).mode & 0o7777, 0o700);
    assert.equal((await lstat(join(f.root, 'owner'))).mode & 0o7777, 0o600);
    for (const key of ['owner', 'inode', 'device']) await t.test(`reject ${key}`, async () => {
      const bad = clone(f); bad[key] = key === 'owner' ? '0'.repeat(64) : bad[key] + 1; await assert.rejects(rootProof(bad));
    });
    await chmod(join(f.root, 'workspace'), 0o755); await assert.rejects(rootProof(f)); await chmod(join(f.root, 'workspace'), 0o700);
    await rm(join(f.root, 'child/home'), { recursive: true }); await symlink(join(f.root, 'child/xdg'), join(f.root, 'child/home'));
    await assert.rejects(rootProof(f));
    await chmod(parent, 0o755); await assert.rejects(createRoot(parent));
  } finally { await rm(parent, { recursive: true }); }
});

const fixture = { root: '/synthetic/wi-live-commit-owned', owner: 'a'.repeat(64), device: 1, inode: 2 };
const binding = { executable: `${TARGET}/debug/deps/wi-0123456789abcdef`, sha256: 'b'.repeat(64), selector: CHILD, sources: {} };
const identity = () => ({ pid: 12345, ppid: process.pid, start_ticks: '987654321', executable: binding.executable, cwd: join(fixture.root, 'child') });
function fake(options = {}) {
  const child = new EventEmitter(), state = { writes: [], ends: 0, kills: [], closed: false, roots: 0, bindings: 0, spawned: 0 };
  child.pid = 12345; child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const output = message => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  child.stdin.write = (line, callback) => {
    state.writes.push(decode(line));
    queueMicrotask(() => {
      if (options.writeError) { callback?.(Error('synthetic')); return; }
      callback?.();
      if (state.writes.length === 1) {
        child.stdout.emit('data', Buffer.from(`\nrunning 1 test\ntest ${CHILD} ... `));
        output(ready(options.readyPid ?? child.pid));
        if (options.lateFault) child.stderr.emit('data', Buffer.from('x'));
      } else {
        const command = state.writes.at(-1);
        if (command.command === 'stop') {
          output(reply('stopping', command.id, { complete: false, work: work(0) }));
          output(reply('stopped', command.id, { drained: true, readers }));
        }
      }
    });
    return true;
  };
  const close = (code = 0, signal = null) => {
    state.closed = true;
    if (state.writes.length && !options.noSummary) child.stdout.emit('data', Buffer.from('\nok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 955 filtered out; finished in 0.01s\n'));
    child.emit('close', code, signal);
  };
  child.stdin.end = callback => {
    state.ends++;
    queueMicrotask(() => { callback?.(options.endError ? Error('synthetic') : undefined); if (!options.stall) close(options.code ?? 0, options.signal ?? null); });
  };
  child.kill = signal => { state.kills.push(signal); queueMicrotask(() => close(null, signal)); return true; };
  const io = {
    root: async () => { state.roots++; if (options.rootError) throw Error('synthetic'); },
    binding: async () => { state.bindings++; if (options.bindingError) throw Error('synthetic'); },
    identity: async () => {
      if (state.closed) return options.stillLive ? identity() : null;
      if (options.identityError) throw Error('synthetic');
      return { ...identity(), ...options.candidate };
    },
    spawn: (exe, args, config) => {
      state.spawned++; assert.equal(exe, binding.executable); assert.deepEqual(args, ['--ignored', '--exact', CHILD, '--nocapture', '--test-threads=1']);
      assert.equal(config.cwd, join(fixture.root, 'child'));
      assert.deepEqual(Object.keys(config.env).sort(), ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP'].sort());
      if (options.spawnThrow) throw Error('synthetic');
      queueMicrotask(() => { if (options.spawnError) { child.emit('error', Error('synthetic')); close(1); } else child.emit('spawn'); });
      return child;
    },
    bounded: async (promise, ms) => { if (options.stall && state.ends && !state.closed && ms === 5000) throw Error('synthetic timeout'); return promise; },
  };
  return { child, state, io };
}

test('actual launcher accounts for acquisition, protocol Stop, input end, close and direct retirement', async () => {
  const f = fake(), native = await launchNative({ fixture, binding }, f.io);
  assert.equal(native.pid, 12345); assert.equal(f.state.writes.length, 1);
  const before = f.state.writes.length;
  await assert.rejects(native.request({ command: 'arm' })); assert.equal(f.state.writes.length, before);
  await assert.rejects(native.request({ command: 'stop', id: 99 })); assert.equal(f.state.writes.length, before);
  const a = native.stop(), b = native.stop(); assert.equal(a, b);
  const facts = await a; assert.equal(terminalProof(facts), true);
  assert.equal(f.state.ends, 1); assert.deepEqual(f.state.kills, []); assert.equal(f.state.closed, true);
});

test('actual launcher failure schedules retain roots and never signal rejected candidates', async t => {
  for (const options of [
    { rootError: true }, { bindingError: true }, { spawnThrow: true }, { spawnError: true }, { identityError: true },
    { candidate: { executable: '/wrong' } }, { candidate: { ppid: 1 } }, { candidate: { cwd: '/wrong' } }, { candidate: { start_ticks: '0' } },
    { readyPid: 999 }, { writeError: true }, { lateFault: true },
  ]) await t.test(Object.keys(options).join(','), async () => {
    const f = fake(options);
    await assert.rejects(launchNative({ fixture, binding }, f.io));
    assert.deepEqual(f.state.kills, []);
    if (f.state.spawned && !options.spawnThrow) { assert.equal(f.state.ends, 1); assert.equal(f.state.closed, true); }
  });
  for (const options of [{ endError: true }, { code: 1 }, { signal: 'SIGTERM' }, { noSummary: true }, { stillLive: true }, { stall: true }]) await t.test(`stop ${Object.keys(options)}`, async () => {
    const f = fake(options), native = await launchNative({ fixture, binding }, f.io);
    await assert.rejects(native.stop()); assert.equal(f.state.ends, 1);
    assert.equal(native.evidence().failure || native.evidence().code !== 0 || native.evidence().signal !== null, true);
    assert.deepEqual(f.state.kills, options.stall ? ['SIGKILL'] : []);
  });
});

const nativeFailure = (extra = {}) => ({ protocol: 1, event: 'failed', category: 'native_failure',
  origin: 'run', phase: 'first_wire_reply', last_completed: 'provider_request_match', readers: clone(readers), ...extra });
const nativeCleanup = () => ({ protocol: 1, event: 'failure_cleanup', outcome: 'closed', readers: clone(readers) });
test('D1 launcher freezes native failure before close and preserves separate later cleanup facts', async () => {
  const f = fake(), observed = [];
  const native = await launchNative({ fixture, binding, onDiagnostic: (event, facts) => observed.push({ event, facts }) }, f.io);
  f.child.stdout.emit('data', Buffer.from(JSON.stringify(nativeFailure()) + '\n'));
  assert.equal(native.evidence().native_failure?.phase, 'first_wire_reply');
  assert.equal(observed[0]?.event, 'native_failed_frame');
  assert.equal(observed[0].facts.closed, false);
  f.child.stdout.emit('data', Buffer.from(JSON.stringify(nativeCleanup()) + '\n'));
  assert.equal(native.evidence().native_cleanup?.outcome, 'closed');
  await assert.rejects(native.stop());
  assert.equal(native.evidence().first_boundary, 'native_frame');
  assert.ok(observed.some(v => v.event === 'native_close'));
});

test('D1 exact native schemas cover every phase origin readers and reject arbitrary or unknown fields', async t => {
  const rust = await readFile(new URL('../../src/providers/openai_codex/tests/replay/http_api_joined/live_commit.rs', import.meta.url), 'utf8');
  const phaseBody = rust.slice(rust.indexOf('enum Phase {'), rust.indexOf('\n}', rust.indexOf('enum Phase {')));
  const names = [...phaseBody.matchAll(/^    ([A-Z][a-zA-Z]+),$/gm)].map(m => m[1].replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase()));
  assert.deepEqual(names, nativePhases);
  for (const phase of nativePhases) for (const origin of ['run', 'cleanup']) await t.test(`${origin} ${phase}`, () => {
    const p = protocol(), v = nativeFailure({ phase, origin, last_completed: null, readers: null });
    assert.equal(nativeFailureProof(v), true); assert.throws(() => p.reply(v));
    assert.deepEqual(p.diagnostics().native_failure, v);
    v.phase = 'unknown'; assert.notEqual(p.diagnostics().native_failure.phase, 'unknown');
    assert.throws(() => p.send({ command: 'stop', id: 2 })); assert.throws(() => p.end());
    p.reply(nativeCleanup()); assert.equal(p.diagnostics().native_cleanup.outcome, 'closed');
    assert.throws(() => p.reply(nativeCleanup())); assert.throws(() => p.reply(ready(12345)));
  });
  const defects = { protocol: 2, event: 'other', category: 'payload', origin: 'unknown', phase: 'unknown', last_completed: 'payload', readers: { opened: 1, closed: 0, active: 0 }, extra: 'unpublished' };
  for (const [key, value] of Object.entries(defects)) await t.test(`reject ${key}`, () => {
    const v = nativeFailure({ [key]: value }), p = protocol(); assert.throws(() => p.reply(v)); assert.equal(p.diagnostics().native_failure, null);
  });
  for (const key of Object.keys(nativeFailure())) { const v = nativeFailure(); delete v[key]; assert.throws(() => nativeFailureProof(v)); }
  for (const readers of [{ opened: 1, closed: 2, active: 0 }, { opened: 1.5, closed: 0, active: 1.5 }, { opened: 1000001, closed: 0, active: 1000001 }, { opened: 1, closed: 1, active: 0, payload: 'unpublished' }]) assert.throws(() => nativeFailureProof(nativeFailure({ readers })));
  assert.equal(nativeFailureProof(nativeFailure({ readers: { opened: 2, closed: 1, active: 1 } })), true);
  const p = protocol(); assert.throws(() => p.reply(nativeCleanup()));
  for (const extra of [{ protocol: 2 }, { outcome: 'unknown' }, { readers: {} }, { readers: { opened: 2, closed: 1, active: 1 } }, { payload: 'unpublished' }]) assert.throws(() => nativeCleanupProof({ ...nativeCleanup(), ...extra }));
});
test('D1 earlier actual launcher boundaries survive later native failure cleanup callbacks and rejection objects', async t => {
  for (const boundary of ['stderr', 'parser', 'protocol', 'ipc_write', 'timeout']) await t.test(boundary, async () => {
    const f = fake(), observed = [];
    const io = { ...f.io };
    if (boundary === 'timeout') io.bounded = async (promise, ms) => { if (f.state.writes.length > 1 && ms === 30000) { promise.catch(() => {}); throw Error('unpublished timeout payload'); } return promise; };
    const native = await launchNative({ fixture, binding, onDiagnostic: (event, facts) => observed.push({ event, facts }) }, io);
    if (boundary === 'ipc_write') f.child.stdin.write = (bytes, callback) => { queueMicrotask(() => callback(Error('unpublished write payload'))); };
    const request = native.request({ command: 'first' }); const caught = request.catch(error => error);
    if (boundary === 'stderr') f.child.stderr.emit('data', Buffer.from('unpublished stderr payload'));
    if (boundary === 'parser') f.child.stdout.emit('data', Buffer.from([0xff]));
    if (boundary === 'protocol') f.child.stdout.emit('data', Buffer.from(JSON.stringify(reply('first', 2, { saved: saved('first'), work: work(0) })) + '\n'));
    const firstError = await caught;
    f.child.stdout.emit('data', Buffer.from(JSON.stringify(nativeFailure()) + '\n'));
    f.child.stdout.emit('data', Buffer.from(JSON.stringify(nativeCleanup()) + '\n'));
    await assert.rejects(native.request({ command: 'first' }), error => error === firstError);
    await assert.rejects(native.stop(), error => error === firstError);
    const facts = native.evidence(); assert.equal(facts.first_boundary, boundary); assert.ok(nodeBoundaries.includes(facts.first_boundary));
    assert.equal(facts.native_failure.phase, 'first_wire_reply'); assert.equal(facts.native_cleanup.outcome, 'closed');
    assert.equal(observed.filter(v => v.event === 'native_failed_frame').length, 1);
    assert.ok(!JSON.stringify(facts).includes('payload')); assert.ok(!JSON.stringify(observed).includes('payload'));
    const copy = native.evidence(); copy.native_failure.phase = 'unknown'; assert.equal(native.evidence().native_failure.phase, 'first_wire_reply');
  });
});
test('D1 launcher rejects malformed duplicate and out of order frames without normal Stop acceptance', async t => {
  for (const defect of ['schema', 'duplicate', 'cleanup-first', 'unknown', 'getter']) await t.test(defect, async () => {
    const f = fake(), native = await launchNative({ fixture, binding }, f.io);
    const emit = v => f.child.stdout.emit('data', Buffer.from(JSON.stringify(v) + '\n'));
    if (defect === 'schema') emit(nativeFailure({ phase: 'unpublished payload' }));
    if (defect === 'duplicate') { emit(nativeFailure()); emit(nativeFailure()); }
    if (defect === 'cleanup-first') emit(nativeCleanup());
    if (defect === 'unknown') emit({ protocol: 1, event: 'unknown' });
    if (defect === 'getter') {
      const p = protocol(), v = nativeFailure(); Object.defineProperty(v, 'phase', { get() { throw Error('unpublished getter payload'); } });
      assert.throws(() => p.reply(v)); assert.equal(p.diagnostics().native_failure, null); emit(nativeFailure({ readers: {} }));
    }
    await assert.rejects(native.stop()); const facts = native.evidence(); assert.equal(facts.failure, true); assert.equal(facts.stopped, false);
    assert.equal(facts.native_failure !== null, defect === 'duplicate'); assert.equal(facts.native_cleanup, null);
  });
});
test('D1 early startup and observer exceptions cannot suppress cleanup or replace original failure', async () => {
  const f = fake(), captured = [], io = { ...f.io };
  io.identity = async () => { f.child.stdout.emit('data', Buffer.from(`running 1 test\ntest ${CHILD} ... ${JSON.stringify(nativeFailure({ phase: 'setup_control', last_completed: null, readers: null }))}\n`)); throw Error('unpublished identity payload'); };
  await assert.rejects(launchNative({ fixture, binding, onDiagnostic: (event, facts) => { captured.push({ event, facts }); throw Error('unpublished observer payload'); } }, io));
  assert.equal(f.state.ends, 1); assert.equal(f.state.closed, true); assert.equal(captured[0].facts.native_failure.phase, 'setup_control');
  assert.equal(captured[0].facts.identity, null); assert.equal(captured[0].facts.first_boundary, 'native_frame');
  assert.ok(!JSON.stringify(captured).includes('payload'));
});

test('identity, balanced reader and deletion gates reject unknown or live resources before effects', async t => {
  const native = await launchNative({ fixture, binding }, fake().io), facts = await native.stop();
  assert.equal(readersProof(readers), true);
  for (const key of Object.keys(identity())) {
    const v = identity(); v[key] = key === 'pid' || key === 'ppid' ? 1 : 'wrong';
    assert.throws(() => identityProof(v, 12345, binding.executable, join(fixture.root, 'child')));
  }
  for (const key of ['opened', 'closed', 'active']) { const v = clone(readers); v[key]++; assert.throws(() => readersProof(v)); }
  for (const key of ['closed', 'input_ended', 'stopped', 'drained', 'code', 'signal', 'stderr_bytes', 'failure', 'fallback', 'retired', 'identity', 'readers']) await t.test(`terminal ${key}`, () => {
    const v = clone(facts);
    if (typeof v[key] === 'boolean') v[key] = !v[key]; else if (typeof v[key] === 'number') v[key]++; else v[key] = key === 'signal' ? 'SIGTERM' : null;
    assert.throws(() => terminalProof(v));
  });
  for (const defect of ['live', 'unknown', 'root', 'binding', 'candidate', 'readers']) await t.test(`remove ${defect}`, async () => {
    let removed = 0;
    const v = clone(facts);
    if (defect === 'candidate') v.identity.executable = '/wrong';
    if (defect === 'readers') v.readers.active = 1;
    const io = { root: async () => { if (defect === 'root') throw Error('synthetic'); }, binding: async () => { if (defect === 'binding') throw Error('synthetic'); }, identity: async () => { if (defect === 'unknown') throw Error('synthetic'); return defect === 'live' ? identity() : null; }, remove: async () => { removed++; } };
    await assert.rejects(removeRoot(fixture, [v], binding, io)); assert.equal(removed, 0);
  });
  let removed = 0;
  await removeRoot(fixture, [facts], binding, { root: async () => {}, binding: async () => {}, identity: async () => ({ ...identity(), start_ticks: '999999999' }), remove: async () => { removed++; } });
  assert.equal(removed, 1);
});
