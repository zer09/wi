import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { prepareBrowserSuite } from '../test-support/browser-suite-preparation.mjs';
import { recordPreparationCommand } from '../test-support/browser-fixture-preparation.mjs';
import { ROOT, TARGET, CHILD } from '../test-support/live-commit-native.mjs';
import { launchBrowserSuite } from '../test-support/browser-suite-launch.mjs';
import { run } from '../scripts/launch-browser-suite.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const load = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const absent = async path => assert.rejects(fs.lstat(path), { code: 'ENOENT' });
const keys = ['WI_C3A_FIXTURE', 'WI_C3A_FIXTURE_SHA256', 'WI_C47_FIXTURE_SHA256', 'WI_C54_NATIVE_BINDING',
  'WI_BROWSER_FIXTURE_PARENT', 'WI_C52_EVIDENCE', 'WI_C54_ALLOCATION_PARENT', 'WI_C54_OUTER_MARKER'];
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const privateWrite = (path, bytes) => fs.writeFile(path, bytes, { mode: 0o600 });
async function fixture(t) {
  const parent = await fs.mkdtemp(join(tmpdir(), 'wi-launch-unit-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sourceRoot = join(parent, 'inputs');
  for (const p of ['web/e2e', 'web/test-support', 'web/scripts']) await fs.mkdir(join(sourceRoot, p), { recursive: true, mode: 0o700 });
  for (const p of ['web/e2e/case.mjs', 'web/test-support/helper.mjs', 'web/test-support/data.json', 'web/scripts/tool.mjs',
    'web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json']) await privateWrite(join(sourceRoot, p), '{}\n');
  const env = { ...process.env }, output = join(parent, 'fresh');
  const sources = { 'Cargo.lock': { bytes: 4, sha256: hash('lock'), mode: 0o644 }, 'src/lib.rs': { bytes: 6, sha256: hash('source'), mode: 0o644 } };
  const executable = join(TARGET, 'debug/deps/wi-0123456789abcdef');
  const cargo = JSON.stringify({ reason: 'compiler-artifact', manifest_path: join(ROOT, 'Cargo.toml'), target: { name: 'wi', kind: ['lib'], src_path: join(ROOT, 'src/lib.rs') }, profile: { test: true }, executable }) + '\n'
    + JSON.stringify({ reason: 'build-finished', success: true }) + '\n';
  const options = { env, sourceRoot, sources: async () => clone(sources),
    validate: async value => clone(value),
    bind: async text => ({ executable, sha256: hash('synthetic bytes'), selector: CHILD, sources: clone(sources), cargo_json: text }),
    command: (program, argv, opts) => recordPreparationCommand(program, argv, opts, () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let text = 'synthetic toolchain\n';
      if (opts.name === 'revision') text = 'a'.repeat(40) + '\n';
      if (opts.name === 'worktree') text = '?? synthetic-file\n';
      if (opts.name === 'build') text = cargo;
      queueMicrotask(() => { child.stdout.end(text); child.stderr.end(); child.emit('close', 0, null); });
      return child;
    }),
  };
  const bundle = await prepareBrowserSuite({ output }, options), data = await load(bundle);
  const bus = new EventEmitter(), calls = [], kills = [];
  const fake = (program, argv, opts) => {
    calls.push({ program, argv, opts });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = s => { kills.push(s); return true; };
    queueMicrotask(() => { child.emit('spawn'); child.stdout.end('synthetic launch\n'); child.stderr.end(); child.emit('close', 0, null); });
    return child;
  };
  return { parent, output, bundle, data, env, sourceRoot, sources, bus, calls, kills,
    io: { env, sourceRoot, sources: options.sources, validate: options.validate, signals: bus, spawn: fake } };
}
async function reject(f, extra = {}) {
  const r = await launchBrowserSuite({ bundle: f.bundle }, { ...f.io, ...extra });
  assert.equal(r.code, 1); assert.equal(r.signal, null); assert.equal(f.calls.length, 0);
  for (const p of [f.data.planned.guard, f.data.planned.outer]) await absent(p);
  return r;
}
async function changeBundle(f, mutate) {
  const b = await load(f.bundle); mutate(b); await privateWrite(f.bundle, JSON.stringify(b, null, 2) + '\n'); return b;
}
async function marker(f, relative, bytes) {
  const path = join(f.data.planned.playwright, relative);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 }); await privateWrite(path, bytes); return path;
}
function during(f, action, code = 0, signal = null) {
  f.io.spawn = (...args) => {
    f.calls.push(args); const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.exitCode = null; c.signalCode = null; c.kill = s => { f.kills.push(s); return true; };
    setImmediate(async () => { c.emit('spawn'); await action(c); c.stdout.end(); c.stderr.end(); c.emit('close', code, signal); });
    return c;
  };
}
function listeners(f) { for (const s of signals) assert.equal(f.bus.listenerCount(s), 0); }

test('actual C68/C65 fake recorder and C67 allocation compose one immutable synthetic launch', async t => {
  const f = await fixture(t), original = await fs.readFile(f.bundle), before = { ...process.env };
  const r = await launchBrowserSuite({ bundle: f.bundle }, f.io);
  assert.equal(r.code, 0); assert.equal(r.signal, null); assert.equal(f.calls.length, 1);
  const c = f.calls[0]; assert.deepEqual([c.program, c.argv, c.opts.cwd, c.opts.shell, c.opts.stdio],
    [process.execPath, f.data.future_command.argv, ROOT, false, ['ignore', 'pipe', 'pipe']]);
  assert.ok(isDeepStrictEqual(c.opts.env, { ...f.env, ...f.data.environment }), 'Only the prepared keys augment the copied environment.');
  assert.ok(isDeepStrictEqual({ ...process.env }, before), 'Global environment is unchanged.');
  assert.deepEqual(await fs.readFile(f.bundle), original);
  assert.deepEqual(await load(f.data.planned.outer), { consumed: true });
  assert.equal((await load(f.data.planned.guard)).consumed, true);
  assert.equal((await fs.lstat(f.data.planned.guard)).mode & 0o7777, 0o600);
  const outcome = await load(join(f.output, 'control/launch-outcome.json'));
  assert.equal(outcome.child.spawned, true); assert.equal(outcome.child.closed, true); assert.equal(outcome.child.code, 0);
  assert.equal(outcome.browser_executions, null); assert.equal(outcome.test_counts, null);
  assert.equal(outcome.markers.C52.status, 'absent'); assert.equal(outcome.markers.C57.count, 0);
  listeners(f);
});

test('all inherited suite keys reject, including equal-looking values', async t => {
  for (const key of keys) await t.test(key, async t => { const f = await fixture(t); f.env[key] = f.data.environment[key]; await reject(f); listeners(f); });
});

test('closed bundle fixed intent rejects coherent-looking edits before reservation', async t => {
  const edits = {
    version: b => b.version++, scope: b => b.scope = 'launch', launch: b => b.launch = 'ready', readiness: b => b.full_readiness = true,
    count: b => b.browser_executions = 1, case_count: b => b.case_markers = 1, reserved: b => b.execution_guard_reserved = true,
    extra: b => b.extra = true, missing: b => delete b.scope, cutoff: b => b.preparation_cutoff = 'new', outer: b => b.outer_content.extra = 1,
    map_extra: b => b.environment.EXTRA = 'x', map_missing: b => delete b.environment.WI_C52_EVIDENCE,
    map_path: b => b.environment.WI_C52_EVIDENCE += '-other', digest: b => b.environment.WI_C47_FIXTURE_SHA256 = '0'.repeat(64),
    allocation: b => b.environment.WI_C54_ALLOCATION_PARENT = '{}', argv: b => b.future_command.argv.push('--workers=1'),
    shell: b => b.future_command.shell = false, cwd: b => b.future_command.cwd = b.identities.root.path,
    node: b => b.future_command.program = '/usr/bin/node', planned: b => b.planned.c52 += '-other',
    sources_path: b => b.sources.path += '-other', producer_path: b => b.producer.path += '-other',
    producer_extra: b => b.producer.extra = true, identities_extra: b => b.identities.extra = b.identities.root,
  };
  for (const [name, edit] of Object.entries(edits)) await t.test(name, async t => { const f = await fixture(t); await changeBundle(f, edit); await reject(f); });
});

test('canonical location, private roots, hard-link pairs and empty child are mandatory', async t => {
  for (const kind of ['relative', 'trailing', 'nul', 'unicode', 'name', 'alias', 'mode', 'parent-mode', 'child-mode', 'child-extra', 'retained-extra',
    'control-extra', 'umbrella-extra', 'artifact-extra', 'pair-missing', 'pair-replaced', 'pair-third', 'bundle-mode', 'bundle-directory']) await t.test(kind, async t => {
    const f = await fixture(t); let bundle = f.bundle;
    if (kind === 'relative') bundle = 'relative';
    if (kind === 'trailing') bundle += '/';
    if (kind === 'nul') bundle += '\0';
    if (kind === 'unicode') bundle += '\ud800';
    if (kind === 'name') bundle = join(f.output, 'control/other.json');
    if (kind === 'alias') { const path = join(f.parent, 'alias'); await fs.symlink(f.output, path); bundle = join(path, 'control/suite-ready.json'); }
    if (kind === 'mode') await fs.chmod(f.output, 0o755);
    if (kind === 'parent-mode') await fs.chmod(f.parent, 0o755);
    if (kind === 'child-mode') await fs.chmod(f.data.identities.child.path, 0o755);
    if (kind === 'child-extra') await privateWrite(join(f.data.identities.child.path, 'keep'), 'keep');
    for (const [name, p] of [['retained-extra', 'retained'], ['control-extra', 'control'], ['umbrella-extra', ''], ['artifact-extra', 'artifact']]) {
      if (kind === name) await privateWrite(join(f.output, p, 'keep'), 'keep');
    }
    const pending = join(f.output, 'control/suite-ready.pending.json');
    if (kind === 'pair-missing') await fs.unlink(pending);
    if (kind === 'pair-replaced') { const bytes = await fs.readFile(pending); await fs.unlink(pending); await privateWrite(pending, bytes); }
    if (kind === 'pair-third') await fs.link(bundle, join(f.parent, 'third'));
    if (kind === 'bundle-mode') await fs.chmod(bundle, 0o644);
    if (kind === 'bundle-directory') { await fs.unlink(bundle); await fs.mkdir(bundle); }
    const r = await launchBrowserSuite({ bundle }, f.io); assert.equal(r.code, 1); assert.equal(f.calls.length, 0);
    await absent(f.data.planned.guard); listeners(f);
  });
});

test('all runtime roots and ordinary data, config, package and native drift reject', async t => {
  for (const kind of ['new-json', 'delete-json', 'bytes', 'mode', 'hardlink', 'symlink', 'directory', 'config', 'package', 'lock', 'native', 'binding', 'environment', 'jobs']) await t.test(kind, async t => {
    const f = await fixture(t), p = join(f.sourceRoot, 'web/test-support/data.json');
    if (kind === 'new-json') await privateWrite(join(f.sourceRoot, 'web/e2e/extra.json'), '{}');
    if (kind === 'delete-json') await fs.unlink(p);
    if (kind === 'bytes') await privateWrite(p, 'changed');
    if (kind === 'mode') await fs.chmod(p, 0o644);
    if (kind === 'hardlink') await fs.link(p, join(f.parent, 'link'));
    if (kind === 'symlink') { await fs.unlink(p); await fs.symlink(join(f.sourceRoot, 'web/package.json'), p); }
    if (kind === 'directory') { await fs.unlink(p); await fs.mkdir(p); }
    for (const [name, path] of [['config', 'web/playwright.config.mjs'], ['package', 'web/package.json'], ['lock', 'web/package-lock.json']]) if (kind === name) await privateWrite(join(f.sourceRoot, path), 'changed');
    if (kind === 'native') f.io.sources = async () => ({ ...f.sources, extra: {} });
    if (kind === 'binding') f.io.validate = async () => { throw Error('synthetic'); };
    if (kind === 'environment') f.env.RUSTFLAGS += ' changed';
    if (kind === 'jobs') f.env.CARGO_BUILD_JOBS = '7';
    await reject(f);
  });
  for (const p of ['web/e2e', 'web/test-support', 'web/scripts', 'web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json']) await t.test(p, async t => {
    const f = await fixture(t), path = join(f.sourceRoot, p), s = await fs.lstat(path);
    await fs.rm(path, { recursive: true }); if (s.isDirectory()) await privateWrite(path, '{}'); else await fs.mkdir(path);
    await reject(f);
  });
});

test('every producer record is pinned and exact artifact set and environment pair reject substitution', async t => {
  const probe = await fixture(t);
  for (const pin of probe.data.producer.records) for (const kind of ['change', 'missing', 'mode', 'alias']) await t.test(`${basename(pin.path)}-${kind}`, async t => {
    const f = await fixture(t), p = join(f.output, 'artifact', basename(pin.path));
    if (kind === 'change') await fs.appendFile(p, ' ');
    if (kind === 'missing') await fs.unlink(p);
    if (kind === 'mode') await fs.chmod(p, 0o644);
    if (kind === 'alias') { await fs.unlink(p); await fs.symlink(join(f.sourceRoot, 'web/package.json'), p); }
    await reject(f);
  });
});

test('guard, OUTER and occupied output are never adopted or overwritten', async t => {
  for (const key of ['guard', 'outer', 'playwright', 'c52']) for (const kind of ['file', 'directory', 'symlink']) await t.test(`${key}-${kind}`, async t => {
    const f = await fixture(t), path = f.data.planned[key];
    if (kind === 'file') await privateWrite(path, 'prior output');
    if (kind === 'directory') await fs.mkdir(path, { mode: 0o700 });
    if (kind === 'symlink') await fs.symlink(join(f.sourceRoot, 'web/package.json'), path);
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 1); assert.equal(f.calls.length, 0);
    assert.ok(await fs.lstat(path)); if (kind === 'file') assert.equal(await fs.readFile(path, 'utf8'), 'prior output'); listeners(f);
  });
});

test('synchronized competing launchers spawn only once and loser cannot replace outcome', async t => {
  const f = await fixture(t); let arrivals = 0, release;
  const gate = new Promise(r => { release = r; });
  const io = { open: async (p, ...args) => { if (p === f.data.planned.guard) { if (++arrivals === 2) release(); await gate; } return fs.open(p, ...args); } };
  const results = await Promise.all([launchBrowserSuite({ bundle: f.bundle }, { ...f.io, io }), launchBrowserSuite({ bundle: f.bundle }, { ...f.io, io })]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]); assert.equal(f.calls.length, 1);
  assert.equal((await load(join(f.output, 'control/launch-outcome.json'))).child.spawned, true); listeners(f);
});

test('guard then OUTER then complete readback precede dispatch; stop latch consumes without spawn', async t => {
  for (const boundary of ['guard', 'outer', 'final-read']) await t.test(boundary, async t => {
    const f = await fixture(t); let fired = false;
    f.io.io = { open: async (p, ...args) => { const h = await fs.open(p, ...args); if (!fired && p === f.data.planned[boundary]) { fired = true; f.bus.emit('SIGINT'); } return h; },
      readFile: async (...args) => { const bytes = await fs.readFile(...args); if (boundary === 'final-read' && args[0] === f.data.planned.outer && !fired) { fired = true; f.bus.emit('SIGTERM'); } return bytes; } };
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 1); assert.equal(f.calls.length, 0);
    assert.equal((await load(f.data.planned.guard)).consumed, true); assert.equal(r.outcome.child.spawned, false); listeners(f);
  });
});

test('post-reservation corruption and each meaningful IO failure consume and retain', async t => {
  for (const kind of ['guard-write', 'guard-close', 'outer-open', 'outer-write', 'guard-read', 'outer-read', 'recheck-source', 'recheck-artifact', 'recheck-child', 'outcome-write', 'marker-read', 'output-read']) await t.test(kind, async t => {
    const f = await fixture(t); let guard = false;
    f.io.io = {
      open: async (p, ...args) => {
        if (p === f.data.planned.outer && kind === 'outer-open') throw Error('synthetic');
        const h = await fs.open(p, ...args); if (p === f.data.planned.guard) guard = true;
        return { writeFile: async bytes => { if ((p === f.data.planned.guard && kind === 'guard-write') || (p === f.data.planned.outer && kind === 'outer-write')) { await h.writeFile('{'); throw Error('synthetic'); } return h.writeFile(bytes); },
          close: async () => { await h.close(); if (p === f.data.planned.guard && kind === 'guard-close') throw Error('synthetic'); } };
      },
      readFile: async (p, ...args) => { if (guard && ((p === f.data.planned.guard && kind === 'guard-read') || (p === f.data.planned.outer && kind === 'outer-read')
        || (p === join(f.sourceRoot, 'web/test-support/data.json') && kind === 'recheck-source') || (p.endsWith('ownership.json') && kind === 'recheck-artifact')
        || (p.endsWith('CASE.once') && kind === 'marker-read'))) throw Error('synthetic'); return fs.readFile(p, ...args); },
      readdir: async (p, ...args) => { if (guard && ((p === f.data.identities.child.path && kind === 'recheck-child') || (p === f.data.planned.playwright && kind === 'output-read'))) throw Error('synthetic'); return fs.readdir(p, ...args); },
      writeFile: async (p, ...args) => { if (p.endsWith('launch-outcome.json') && kind === 'outcome-write') throw Error('synthetic'); return fs.writeFile(p, ...args); },
    };
    if (['marker-read', 'output-read'].includes(kind)) during(f, () => marker(f, 'case/c57/CASE.once', 'C57 fresh case\n'));
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 1); assert.equal(r.signal, null);
    assert.ok(await fs.lstat(f.data.planned.guard));
    const before = await fs.readFile(f.data.planned.guard); const count = f.calls.length;
    const again = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(again.code, 1); assert.equal(f.calls.length, count);
    assert.deepEqual(await fs.readFile(f.data.planned.guard), before); listeners(f);
  });
});

test('known terminals, errors, unknowns and reuse retain primary facts and prior output', async t => {
  for (const kind of ['zero', 'nonzero', 'signal', 'unknown', 'error', 'throw', 'not-spawned']) await t.test(kind, async t => {
    const f = await fixture(t), code = kind === 'nonzero' ? 7 : 0;
    if (kind === 'throw') f.io.spawn = () => { throw Error('synthetic start'); };
    else during(f, async c => {
      await marker(f, 'prior.txt', 'prior output');
      if (kind === 'error') c.emit('error', Error('synthetic child'));
    }, ['signal', 'unknown', 'not-spawned'].includes(kind) ? null : code, kind === 'signal' ? 'SIGTERM' : null);
    if (kind === 'not-spawned') f.io.spawn = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); queueMicrotask(() => c.emit('close', null, null)); return c; };
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io);
    if (kind === 'zero') assert.equal(r.code, 0);
    else if (kind === 'nonzero') assert.equal(r.code, 7);
    else if (kind === 'signal') { assert.equal(r.code, null); assert.equal(r.signal, 'SIGTERM'); }
    else assert.equal(r.code, 1);
    assert.equal(r.outcome.child.closed, kind !== 'throw');
    if (kind === 'nonzero') assert.equal(r.outcome.child.code, 7);
    const bytes = await fs.readFile(f.data.planned.guard), n = f.calls.length;
    assert.equal((await launchBrowserSuite({ bundle: f.bundle }, f.io)).code, 1); assert.equal(f.calls.length, n);
    assert.deepEqual(await fs.readFile(f.data.planned.guard), bytes);
    if (!['throw', 'not-spawned'].includes(kind)) assert.equal(await fs.readFile(join(f.data.planned.playwright, 'prior.txt'), 'utf8'), 'prior output'); listeners(f);
  });
});

test('correct qualified JSON/text markers, multiple reservations and unrelated CASE.once stay separate from proof', async t => {
  const f = await fixture(t);
  during(f, async () => {
    await fs.mkdir(f.data.planned.c52, { mode: 0o700 }); await privateWrite(join(f.data.planned.c52, 'C52.once.json'), '{\n  "consumed": true\n}\n');
    await marker(f, 'one/c53-evidence/C53.once.json', '{"consumed":true}\n');
    await marker(f, 'one/c54-evidence/C54.once.json', '{"consumed":true}\n');
    await marker(f, 'one/c57/CASE.once', 'C57 fresh case\n'); await marker(f, 'two/c57/CASE.once', 'C57 fresh case\n');
    await marker(f, 'one/c61/CASE.once', 'C61 fresh case\n');
    await marker(f, 'unrelated/CASE.once', 'not a marker'); await marker(f, 'other/C57.once.json', 'not a marker');
    await fs.rm(f.data.identities.child.path, { recursive: true });
  });
  const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 0);
  for (const [family, count] of Object.entries({ C52: 1, C53: 1, C54: 1, C57: 2, C61: 1 })) {
    assert.equal(r.outcome.markers[family].count, count); assert.equal(r.outcome.markers[family].status, 'observed');
  }
  assert.equal(r.outcome.browser_executions, null); assert.equal(r.outcome.test_counts, null);
  assert.equal(r.outcome.marker_meaning, 'reservation only'); listeners(f);
});

test('wrong/swapped text, JSON shape, marker aliases, and output aliases reject without erasing child status', async t => {
  for (const kind of ['C52', 'C53', 'C54', 'C57', 'C61', 'swapped', 'alias', 'output-alias', 'wrong-directory']) await t.test(kind, async t => {
    const f = await fixture(t);
    during(f, async () => {
      if (kind === 'C52') { await fs.mkdir(f.data.planned.c52, { mode: 0o700 }); await privateWrite(join(f.data.planned.c52, 'C52.once.json'), '{"consumed":true,"extra":1}'); }
      if (kind === 'C53') await marker(f, 'case/c53-evidence/C53.once.json', '[]');
      if (kind === 'C54') await marker(f, 'case/c54-evidence/C54.once.json', '{"consumed":false}');
      if (kind === 'C57') await marker(f, 'case/c57/CASE.once', 'C57 fresh case');
      if (kind === 'C61') await marker(f, 'case/c61/CASE.once', 'wrong\n');
      if (kind === 'swapped') await marker(f, 'case/c57/CASE.once', 'C61 fresh case\n');
      if (kind === 'wrong-directory') await marker(f, 'case/unrelated/CASE.once', 'C57 fresh case\n');
      if (kind === 'alias') { const p = await marker(f, 'case/c57/placeholder', 'x'); await fs.symlink(p, join(dirname(p), 'CASE.once')); }
      if (kind === 'output-alias') await fs.symlink(f.sourceRoot, f.data.planned.playwright);
    });
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, kind === 'wrong-directory' ? 0 : 1); assert.equal(r.outcome.child.code, 0);
    assert.ok(await fs.lstat(f.data.planned.guard)); listeners(f);
  });
});

test('signal forwarding is direct owned handle only, after spawn and before close', async t => {
  for (const kind of ['normal', 'false', 'throw', 'pre-spawn', 'after-close']) await t.test(kind, async t => {
    const f = await fixture(t);
    f.io.spawn = () => {
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.exitCode = null; c.signalCode = null;
      c.kill = s => { f.kills.push(s); if (kind === 'throw') throw Error('synthetic'); return kind !== 'false'; };
      queueMicrotask(() => {
        if (kind === 'pre-spawn') f.bus.emit('SIGINT'); c.emit('spawn');
        if (kind !== 'pre-spawn' && kind !== 'after-close') for (const s of signals) f.bus.emit(s);
        c.stdout.end(); c.stderr.end(); c.emit('close', 0, null);
        if (kind === 'after-close') f.bus.emit('SIGTERM');
      });
      return c;
    };
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io);
    assert.equal(r.code, ['false', 'throw'].includes(kind) ? 1 : 0);
    assert.deepEqual(f.kills, ['pre-spawn', 'after-close'].includes(kind) ? [] : signals);
    assert.equal(r.outcome.signals.received, kind === 'pre-spawn' || kind === 'after-close' ? 1 : 3);
    listeners(f);
  });
});

test('real owned Node fixtures handle each signal or terminate with an actual known status', async t => {
  for (const signal of signals) for (const handled of [true, false]) await t.test(`${signal}-${handled}`, async t => {
    const f = await fixture(t); let owned;
    f.io.spawn = () => {
      // This seam runs only this harmless Node fixture, never the prepared Playwright argv.
      owned = spawn(process.execPath, ['--input-type=module', '-e', handled
        ? `process.on('${signal}',()=>process.exit(9));console.log('ready');setInterval(()=>{},1000);`
        : "console.log('ready');setInterval(()=>{},1000);"], { cwd: ROOT, env: { ...f.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      owned.stdout.once('data', () => f.bus.emit(signal)); return owned;
    };
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io);
    assert.equal(r.outcome.child.spawned, true); assert.equal(r.outcome.child.closed, true);
    assert.equal(r.outcome.child.pid, owned.pid);
    if (r.outcome.child.identity_observation === 'observed') {
      assert.equal(r.outcome.child.identity.pid, owned.pid); assert.equal(r.outcome.child.identity.ppid, process.pid);
    } else assert.equal(r.outcome.child.identity, null);
    if (handled) { assert.equal(r.code, 9); assert.equal(r.signal, null); } else { assert.equal(r.code, null); assert.equal(r.signal, signal); }
    assert.equal(r.outcome.signals.forwarded, 1); assert.equal(owned.exitCode, handled ? 9 : null); listeners(f);
  });
});

test('a signal for one real owned Node fixture does not reach a concurrently owned sibling', async t => {
  const f = await fixture(t), sibling = await fixture(t); let other, ready;
  const started = new Promise(resolve => { ready = resolve; });
  sibling.io.spawn = () => {
    other = spawn(process.execPath, ['--input-type=module', '-e', "process.on('SIGTERM',()=>process.exit(5));console.log('ready');setInterval(()=>{},1000);"],
      { cwd: ROOT, env: { ...sibling.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    other.stdout.once('data', ready); return other;
  };
  const siblingResult = launchBrowserSuite({ bundle: sibling.bundle }, sibling.io);
  await started;
  f.io.spawn = () => {
    const own = spawn(process.execPath, ['--input-type=module', '-e', "process.on('SIGTERM',()=>process.exit(9));console.log('ready');setInterval(()=>{},1000);"],
      { cwd: ROOT, env: { ...f.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    own.stdout.once('data', () => f.bus.emit('SIGTERM')); return own;
  };
  const result = await launchBrowserSuite({ bundle: f.bundle }, f.io);
  assert.equal(result.code, 9); assert.equal(other.exitCode, null); assert.equal(other.signalCode, null);
  assert.equal(sibling.bus.listenerCount('SIGTERM'), 1);
  other.kill('SIGTERM');
  const retired = await siblingResult; assert.equal(retired.code, 5); assert.equal(retired.outcome.signals.received, 0);
  listeners(f); listeners(sibling);
});

test('buffered split/encoded/structured secrets are scrubbed and provenance collisions fail closed', async t => {
  const f = await fixture(t), secret = 'synthetic-secret/line\nquote"'; f.env.UNIT_SECRET = secret;
  const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
  during(f, async c => { for (const v of variants) { const n = Math.floor(v.length / 2); c.stdout.write(v.slice(0, n)); c.stdout.write(v.slice(n)); c.stderr.write(v); } });
  const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 0);
  for (const name of ['launch.stdout', 'launch.stderr', 'launch.command.json', 'launch-outcome.json']) {
    const text = await fs.readFile(join(f.output, 'control', name), 'utf8'); for (const v of variants) assert.ok(!text.includes(v), 'Synthetic secret must not persist.');
  }
  const collision = await fixture(t); collision.env.UNIT_SECRET = 'browser suite preparation only'; await reject(collision);
});

async function repin(f) {
  const b = await load(f.bundle), provenancePath = join(f.output, 'control/producer-records.json');
  const provenance = await load(provenancePath);
  for (const pin of b.producer.records) {
    const s = await fs.lstat(pin.path), bytes = await fs.readFile(pin.path);
    Object.assign(pin, { uid: s.uid, mode: s.mode & 0o7777, device: s.dev, inode: s.ino, bytes: bytes.length, sha256: hash(bytes) });
  }
  provenance.records = clone(b.producer.records);
  provenance.commands = await Promise.all(['revision', 'worktree', 'cargo-version', 'rustc-version', 'build'].map(n => load(join(f.output, `artifact/${n}.command.json`))));
  provenance.invocation = await load(join(f.output, 'artifact/invocation.json'));
  await privateWrite(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  b.producer.sha256 = hash(await fs.readFile(provenancePath));
  await privateWrite(f.bundle, JSON.stringify(b, null, 2) + '\n');
}

test('coherently repinned records cannot replace known producer command and publication semantics', async t => {
  const edits = {
    program: ['build.command.json', f => f.program = 'npm'], argv: ['build.command.json', f => f.argv.push('--release')],
    cwd: ['build.command.json', f => f.cwd = '/other'], extra: ['build.command.json', f => f.extra = true],
    stdout_digest: ['build.command.json', f => f.sanitized_stdout_sha256 = '0'.repeat(64)],
    stdout_length: ['build.command.json', f => f.sanitized_stdout_bytes++],
    stderr_digest: ['build.command.json', f => f.sanitized_stderr_sha256 = '0'.repeat(64)],
    redacted: ['build.command.json', f => f.stdout_redacted = true], closed: ['build.command.json', f => f.closed = false],
    code: ['build.command.json', f => f.code = 1], signal: ['build.command.json', f => f.signal = 'SIGTERM'],
    error: ['build.command.json', f => f.spawn_error = { code: 'EIO', message: 'synthetic' }],
    pid: ['build.command.json', f => f.pid = -1], identity: ['build.command.json', f => f.identity_observation = 'invented'],
    retired: ['build.command.json', f => f.direct_identity_retired = true], date: ['build.command.json', f => f.ended_at = 'not-a-date'],
    environment: ['invocation.json', f => f.environment.values.RUSTFLAGS += ' changed'], node: ['invocation.json', f => f.node = '24.0.0'],
    selector: ['invocation.json', f => f.selectors.ordinary = CHILD], observed: ['invocation.json', f => f.selectors.observed_in_executable = true],
    toolchain: ['invocation.json', f => f.toolchain.rustc = 'changed'], ownership: ['ownership.json', f => f.inode++],
    ready: ['preparation.json', f => f.full_readiness = true], execution: ['preparation.json', f => f.selector_execution = true],
    publication: ['preparation.json', f => f.publication = 'other'], cargo: ['native-binding.json', f => f.cargo_json += ' '],
  };
  for (const [name, [file, edit]] of Object.entries(edits)) await t.test(name, async t => {
    const f = await fixture(t), p = join(f.output, 'artifact', file), record = await load(p); edit(record);
    await privateWrite(p, JSON.stringify(record, null, 2) + '\n'); await repin(f); await reject(f);
  });
});

test('historical receipt identities retain qualifications without requiring current parent or PID absence', async t => {
  for (const kind of ['retired', 'read-failed', 'bad-parent', 'not-retired', 'bad-shape']) await t.test(kind, async t => {
    const f = await fixture(t), p = join(f.output, 'artifact/build.command.json'), record = await load(p);
    record.pid = 2147483613;
    if (kind === 'read-failed') record.identity_observation = 'read_failed';
    else {
      record.identity_observation = 'observed'; record.direct_identity_retired = true;
      record.identity = { pid: record.pid, ppid: 42, start_ticks: '1234', executable: '/synthetic/retired-tool', cwd: ROOT };
      if (kind === 'bad-parent') record.identity.ppid = 0;
      if (kind === 'not-retired') record.direct_identity_retired = false;
      if (kind === 'bad-shape') record.identity.extra = true;
    }
    await privateWrite(p, JSON.stringify(record, null, 2) + '\n'); await repin(f);
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io);
    assert.equal(r.code, ['retired', 'read-failed'].includes(kind) ? 0 : 1); assert.deepEqual(f.kills, []); listeners(f);
  });
});

test('late launch receipt/log substitution and scrub collisions cannot convert child zero into control success', async t => {
  for (const kind of ['stdout', 'stderr', 'receipt', 'mode', 'structured-collision']) await t.test(kind, async t => {
    const f = await fixture(t); let closed = false, changed = false;
    if (kind === 'structured-collision') f.env.UNIT_SECRET = 'SYNTHETIC_CODE';
    during(f, c => { if (kind === 'structured-collision') { const error = Error('synthetic private'); error.code = 'SYNTHETIC_CODE'; c.emit('error', error); } closed = true; });
    f.io.io = { lstat: async p => {
      if (closed && !changed && p === f.output && kind !== 'structured-collision') {
        changed = true;
        const name = { stdout: 'launch.stdout', stderr: 'launch.stderr', receipt: 'launch.command.json', mode: 'launch.stdout' }[kind];
        const path = join(f.output, 'control', name);
        if (kind === 'mode') await fs.chmod(path, 0o644); else await fs.appendFile(path, 'changed');
      }
      return fs.lstat(p);
    } };
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 1); assert.equal(r.outcome.child.code, 0); listeners(f);
    if (kind === 'structured-collision') assert.ok(!(await fs.readFile(join(f.output, 'control/launch.command.json'), 'utf8')).includes('SYNTHETIC_CODE'));
  });
});

test('C65 exclusive launch receipt failures retain original child status and any prior record', async t => {
  for (const name of ['launch.stdout', 'launch.stderr', 'launch.command.json']) for (const code of [0, 11]) await t.test(`${name}-${code}`, async t => {
    const f = await fixture(t); during(f, () => privateWrite(join(f.output, 'control', name), 'prior receipt'), code);
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, code || 1);
    assert.equal(r.outcome.child.code, code); assert.equal(await fs.readFile(join(f.output, 'control', name), 'utf8'), 'prior receipt'); listeners(f);
  });
});

test('marker read faults stay unavailable rather than malformed and known nonzero remains primary', async t => {
  const f = await fixture(t); during(f, () => marker(f, 'case/c61/CASE.once', 'C61 fresh case\n'), 13);
  f.io.io = { readFile: async (p, ...args) => { if (p.endsWith('CASE.once')) throw Error('synthetic IO fault'); return fs.readFile(p, ...args); } };
  const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 13);
  assert.equal(r.outcome.markers.C61.status, 'unavailable'); assert.equal(r.outcome.markers.C61.count, 1);
  assert.equal(r.outcome.browser_executions, null); listeners(f);
});

test('each distinct filesystem operation and phase fails closed without cleanup or loss of terminal facts', async t => {
  function instrument(f, fault) {
    const seen = new Set(); let phase = 'admission', hit = false;
    const category = p => {
      if (p === f.parent) return 'parent';
      if (p === f.output) return 'umbrella';
      if (p === f.data.identities.child.path) return 'allocation';
      if (p.startsWith(f.sourceRoot + '/')) return p.slice(f.sourceRoot.length + 1);
      if (p.startsWith(f.output + '/artifact/')) {
        if (p.endsWith('.command.json')) return 'artifact-command';
        if (p.endsWith('.stdout')) return 'artifact-stdout';
        if (p.endsWith('.stderr')) return 'artifact-stderr';
      }
      return p.slice(f.output.length + 1).replace(/case\//g, '');
    };
    const check = (method, p) => {
      const key = `${phase}:${method}:${category(p)}`; seen.add(key);
      if (!hit && key === fault) { hit = true; throw Error('synthetic filesystem failure'); }
    };
    f.io.io = Object.fromEntries(['lstat', 'realpath', 'readFile', 'readdir', 'writeFile', 'open'].map(method => [method, async (p, ...args) => {
      if (method === 'open' && p === f.data.planned.guard) phase = 'guard';
      if (method === 'open' && p === f.data.planned.outer) phase = 'outer';
      if (method === 'readFile' && p.endsWith('CASE.once')) phase = 'observation';
      check(method, p);
      const value = await fs[method](p, ...args);
      if (method !== 'open') return value;
      return { writeFile: async bytes => { check('handle-write', p); return value.writeFile(bytes); },
        close: async () => { await value.close(); check('handle-close', p); } };
    }]));
    during(f, async () => {
      await fs.mkdir(f.data.planned.c52, { mode: 0o700 }); await privateWrite(join(f.data.planned.c52, 'C52.once.json'), '{"consumed":true}\n');
      await marker(f, 'case/c53-evidence/C53.once.json', '{"consumed":true}\n');
      await marker(f, 'case/c54-evidence/C54.once.json', '{"consumed":true}\n');
      await marker(f, 'case/c57/CASE.once', 'C57 fresh case\n'); await marker(f, 'case/c61/CASE.once', 'C61 fresh case\n');
    }, 17);
    const start = f.io.spawn;
    f.io.spawn = (...args) => { phase = 'runtime'; return start(...args); };
    return { seen, hit: () => hit };
  }
  const baseline = await fixture(t), trace = instrument(baseline);
  assert.equal((await launchBrowserSuite({ bundle: baseline.bundle }, baseline.io)).code, 17);
  t.diagnostic(`Distinct synthetic filesystem operation/phase classes: ${trace.seen.size}`);
  for (const key of trace.seen) await t.test(key, async t => {
    const f = await fixture(t), probe = instrument(f, key), r = await launchBrowserSuite({ bundle: f.bundle }, f.io);
    assert.equal(probe.hit(), true); assert.equal(r.code, f.calls.length ? 17 : 1); assert.ok(f.calls.length <= 1);
    if (f.calls.length) assert.equal(r.outcome.child.code, 17);
    const n = f.calls.length;
    if (r.outcome.consumed) { assert.ok(await fs.lstat(f.data.planned.guard)); assert.equal((await launchBrowserSuite({ bundle: f.bundle }, f.io)).code, 1); assert.equal(f.calls.length, n); }
    listeners(f);
  });
});

test('late occupied paths, changed guard/OUTER and changed bundle rechecks never dispatch', async t => {
  for (const boundary of ['guard', 'outer']) for (const kind of ['guard', 'outer', 'output', 'c52', 'bundle', 'artifact-extra']) await t.test(`${boundary}-${kind}`, async t => {
    const f = await fixture(t); let changed = false;
    f.io.io = { open: async (p, ...args) => {
      const h = await fs.open(p, ...args);
      return { writeFile: bytes => h.writeFile(bytes), close: async () => {
        await h.close(); if (changed || p !== f.data.planned[boundary]) return; changed = true;
        if (kind === 'guard') await fs.appendFile(f.data.planned.guard, ' ');
        if (kind === 'outer') await privateWrite(f.data.planned.outer, '{"consumed":false}');
        if (kind === 'output') { await fs.mkdir(f.data.planned.playwright, { mode: 0o700 }); await privateWrite(join(f.data.planned.playwright, 'prior'), 'prior output'); }
        if (kind === 'c52') await fs.mkdir(f.data.planned.c52, { mode: 0o700 });
        if (kind === 'bundle') await fs.appendFile(f.bundle, ' ');
        if (kind === 'artifact-extra') await privateWrite(join(f.output, 'artifact/extra'), 'retain');
      } };
    } };
    const r = await launchBrowserSuite({ bundle: f.bundle }, f.io); assert.equal(r.code, 1); assert.equal(f.calls.length, 0);
    assert.ok(await fs.lstat(f.data.planned.guard)); listeners(f);
    if (kind === 'output') assert.equal(await fs.readFile(join(f.data.planned.playwright, 'prior'), 'utf8'), 'prior output');
  });
});

test('CLI is import-inert, fixed --bundle only, no passthrough or environment mutation', async () => {
  for (const args of [[], ['--output', '/x'], ['--bundle', 'relative'], ['--bundle', '/x/../y'], ['--bundle', '/x', '--grep', 'x'], ['--bundle', '/x\0']]) {
    let calls = 0, text = '';
    assert.equal(await run(args, async () => { calls++; }, { write: s => { text += s; } }), 2); assert.equal(calls, 0);
    assert.equal(text, 'browser_suite_launch: invalid invocation.\n');
  }
  let terminated = null;
  assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async () => ({ code: null, signal: 'SIGTERM' }),
    { write() {} }, signal => { terminated = signal; }), 1);
  assert.equal(terminated, 'SIGTERM');
  let diagnostic = '';
  assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async () => { throw Error('synthetic private failure'); },
    { write: text => { diagnostic += text; } }), 1);
  assert.equal(diagnostic, 'browser_suite_launch: launch control failed; consumed records are retained.\n');
  const before = { ...process.env }; let selected;
  assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async input => { selected = input; return { code: 7, signal: null }; }), 7);
  assert.deepEqual(selected, { bundle: '/private/control/suite-ready.json' });
  assert.ok(isDeepStrictEqual({ ...process.env }, before), 'CLI preserves global environment.');
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./web/scripts/launch-browser-suite.mjs')"], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
  assert.deepEqual([p.status, p.stdout, p.stderr], [0, '', '']);
});

test('outcome-only redaction collisions reject publication without losing primary child facts or consumed controls', async t => {
  for (const key of ['first_failure', 'terminal', 'signals']) for (const kind of ['zero', 'nonzero', 'signal']) await t.test(`${key}-${kind}`, async t => {
    const f = await fixture(t), code = { zero: 0, nonzero: 17, signal: null }[kind];
    const signal = kind === 'signal' ? 'SIGTERM' : null, outcomePath = join(f.output, 'control/launch-outcome.json');
    const pin = async path => {
      const s = await fs.lstat(path);
      return { bytes: await fs.readFile(path), uid: s.uid, mode: s.mode, device: s.dev, inode: s.ino, links: s.nlink };
    };
    const immutable = [f.bundle, join(f.output, 'control/suite-ready.pending.json'), f.data.sources.path, f.data.producer.path,
      ...f.data.producer.records.map(p => p.path)];
    const originals = await Promise.all(immutable.map(pin));
    // Introduce the collision after real synthetic preparation, not into the bundle producer.
    f.env.UNIT_SECRET = key;
    let child, result, launchCalls = 0, diagnostic = '';
    const terminated = [];
    during(f, async c => {
      child = c;
      for (const stream of [c.stdout, c.stderr]) { stream.write(key.slice(0, 3)); stream.write(key.slice(3)); stream.write('ok\n'); }
    }, code, signal);
    const cli = await run(['--bundle', f.bundle], async input => {
      launchCalls++; result = await launchBrowserSuite(input, f.io); return result;
    }, { write: text => { diagnostic += text; } }, s => { listeners(f); terminated.push(s); });
    assert.equal(launchCalls, 1); assert.equal(f.calls.length, 1); assert.equal(diagnostic, '');
    assert.deepEqual(terminated, signal === null ? [] : [signal]);
    assert.equal(cli, kind === 'nonzero' ? 17 : 1);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: signal === null ? cli : null, signal });
    assert.deepEqual(result.outcome.child, { spawned: true, closed: true, code, signal, error_observed: false,
      pid: null, identity: null, identity_observation: 'unavailable' });
    assert.equal(result.outcome.consumed, true);
    assert.deepEqual(result.outcome.signals, { received: 0, forwarded: 0, not_forwarded: 0, failures: 0, first: null, order: [] });
    assert.equal(result.outcome.browser_executions, null); assert.equal(result.outcome.test_counts, null);
    for (const observation of Object.values(result.outcome.markers)) assert.deepEqual(observation, { status: 'absent', count: 0, paths: [] });
    const guard = await load(f.data.planned.guard);
    assert.equal(guard.consumed, true); assert.equal(guard.meaning, 'reservation only');
    assert.equal(guard.bundle_sha256, hash(originals[0].bytes)); assert.deepEqual(guard.command, f.data.future_command);
    assert.deepEqual(await fs.readFile(f.data.planned.outer, 'utf8'), '{\n  "consumed": true\n}\n');
    const receiptPath = join(f.output, 'control/launch.command.json'), receipt = await load(receiptPath);
    assert.equal(receipt.closed, true); assert.equal(receipt.code, code); assert.equal(receipt.signal, signal); assert.equal(receipt.spawn_error, null);
    for (const stream of ['stdout', 'stderr']) {
      const text = await fs.readFile(join(f.output, `control/launch.${stream}`), 'utf8');
      assert.equal(text, 'ok\n'); assert.equal(receipt[`sanitized_${stream}_bytes`], Buffer.byteLength(text));
      assert.equal(receipt[`sanitized_${stream}_sha256`], hash(text));
    }
    assert.deepEqual(await Promise.all(immutable.map(pin)), originals);
    const retained = [f.data.planned.guard, f.data.planned.outer, receiptPath, join(f.output, 'control/launch.stdout'), join(f.output, 'control/launch.stderr')];
    for (const path of retained) {
      const s = await fs.lstat(path); assert.ok(s.isFile() && !s.isSymbolicLink());
      assert.equal(s.uid, process.getuid()); assert.equal(s.mode & 0o7777, 0o600); assert.equal(s.nlink, 1);
    }
    listeners(f); assert.deepEqual(f.kills, []);
    assert.equal(child.listenerCount('spawn'), 0); assert.equal(child.listenerCount('close'), 0);
    // The recorder keeps its error observer; the launcher's separate error listener is removed.
    assert.equal(child.listenerCount('error'), 1);
    await absent(f.data.planned.c52); await absent(f.data.planned.playwright);
    await absent(outcomePath);
    // A failed nonzero/signal receipt already selected child; final publication must not replace it.
    assert.equal(result.outcome.first_failure, kind === 'zero' ? 'outcome_record' : 'child');
    const retainedBefore = await Promise.all(retained.map(pin));
    let reused;
    assert.equal(await run(['--bundle', f.bundle], async input => { reused = await launchBrowserSuite(input, f.io); return reused; },
      { write() { assert.fail('Reuse must return a bounded result.'); } }, () => assert.fail('Reuse must not terminate.')), 1);
    assert.equal(reused.outcome.first_failure, 'admission'); assert.equal(reused.outcome.consumed, false);
    assert.equal(f.calls.length, 1); assert.deepEqual(await Promise.all(retained.map(pin)), retainedBefore);
    assert.deepEqual(await Promise.all(immutable.map(pin)), originals); await absent(outcomePath); listeners(f);
  });
});

test('ordinary and nonoverlapping redaction retain the exact complete outcome schema and CLI zero', async t => {
  for (const kind of ['ordinary', 'nonoverlap']) await t.test(kind, async t => {
    const f = await fixture(t), original = await fs.readFile(f.bundle), secret = 'synthetic-outcome-safe-secret';
    if (kind === 'nonoverlap') f.env.UNIT_SECRET = secret;
    during(f, async c => {
      for (const stream of [c.stdout, c.stderr]) {
        if (kind === 'nonoverlap') { stream.write(secret.slice(0, 7)); stream.write(secret.slice(7)); }
        stream.write('ok\n');
      }
    });
    let result;
    assert.equal(await run(['--bundle', f.bundle], async input => { result = await launchBrowserSuite(input, f.io); return result; },
      { write() { assert.fail('Valid launch must not diagnose.'); } }, () => assert.fail('Valid launch must not terminate.')), 0);
    const path = join(f.output, 'control/launch-outcome.json'), outcome = await load(path);
    assert.deepEqual(Object.keys(outcome).sort(), ['scope', 'consumed', 'first_failure', 'child', 'signals', 'markers', 'marker_meaning', 'browser_executions', 'test_counts', 'terminal'].sort());
    assert.deepEqual(outcome, { ...result.outcome, terminal: { code: 0, signal: null } });
    assert.equal(outcome.first_failure, null); assert.equal((await fs.lstat(path)).mode & 0o7777, 0o600);
    for (const stream of ['stdout', 'stderr']) assert.equal(await fs.readFile(join(f.output, `control/launch.${stream}`), 'utf8'), 'ok\n');
    const before = await fs.readFile(path);
    assert.equal((await launchBrowserSuite({ bundle: f.bundle }, f.io)).code, 1);
    assert.deepEqual(await fs.readFile(path), before); assert.deepEqual(await fs.readFile(f.bundle), original);
    assert.equal(f.calls.length, 1); listeners(f);
  });
});

test('prepared-scope and producer-signal redaction collisions are early admission contrasts, not outcome failures', async t => {
  for (const value of ['browser suite preparation only', 'signal']) await t.test(value, async t => {
    const f = await fixture(t), original = await fs.readFile(f.bundle); f.env.UNIT_SECRET = value;
    const result = await reject(f);
    assert.equal(result.outcome.first_failure, 'admission'); assert.equal(result.outcome.consumed, false);
    assert.equal(result.outcome.child.spawned, false); assert.equal(result.outcome.child.closed, false);
    await absent(join(f.output, 'control/launch-outcome.json')); await absent(join(f.output, 'control/launch.command.json'));
    assert.deepEqual(await fs.readFile(f.bundle), original); assert.deepEqual(f.kills, []); listeners(f);
  });
});
