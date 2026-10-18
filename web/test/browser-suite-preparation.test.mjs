import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { prepareBrowserSuite } from '../test-support/browser-suite-preparation.mjs';
import { prepareBrowserFixture, recordPreparationCommand, sanitizeRecord, preparationRedactor } from '../test-support/browser-fixture-preparation.mjs';
import { ROOT, TARGET, CHILD } from '../test-support/live-commit-native.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const load = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const absent = path => assert.rejects(fs.lstat(path), { code: 'ENOENT' });
const fixed = { message: 'Browser suite preparation failed.' };
const keys = ['WI_C3A_FIXTURE', 'WI_C3A_FIXTURE_SHA256', 'WI_C47_FIXTURE_SHA256', 'WI_C54_NATIVE_BINDING',
  'WI_BROWSER_FIXTURE_PARENT', 'WI_C52_EVIDENCE', 'WI_C54_ALLOCATION_PARENT', 'WI_C54_OUTER_MARKER'];

async function fixture(t) {
  const parent = await fs.mkdtemp(join(tmpdir(), 'wi-suite-unit-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sourceRoot = join(parent, 'inputs');
  for (const name of ['web/e2e', 'web/test-support', 'web/scripts']) await fs.mkdir(join(sourceRoot, name), { recursive: true, mode: 0o700 });
  for (const name of ['web/e2e/case.mjs', 'web/test-support/helper.mjs', 'web/test-support/data.json', 'web/scripts/prepare.mjs',
    'web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json']) await fs.writeFile(join(sourceRoot, name), '{}\n', { mode: 0o600 });
  const output = join(parent, 'fresh'), calls = [], env = { ...process.env };
  const sources = { 'Cargo.lock': { bytes: 4, sha256: hash('lock'), mode: 0o644 }, 'src/lib.rs': { bytes: 6, sha256: hash('source'), mode: 0o644 } };
  const executable = join(TARGET, 'debug/deps/wi-0123456789abcdef');
  const artifact = { reason: 'compiler-artifact', manifest_path: join(ROOT, 'Cargo.toml'), target: { name: 'wi', kind: ['lib'], src_path: join(ROOT, 'src/lib.rs') }, profile: { test: true }, executable };
  const cargo = JSON.stringify(artifact) + '\n' + JSON.stringify({ reason: 'build-finished', success: true }) + '\n';
  const io = { sourceRoot, env, sources: async () => clone(sources),
    bind: async text => ({ executable, sha256: hash('synthetic artifact bytes'), selector: CHILD, sources: clone(sources), cargo_json: text }),
    validate: async binding => clone(binding),
    command: async (program, argv, options) => {
      calls.push(options.name);
      let text = 'synthetic toolchain\n';
      if (options.name === 'revision') text = 'a'.repeat(40) + '\n';
      if (options.name === 'worktree') text = '?? synthetic-file\n';
      if (options.name === 'build') text = cargo;
      return recordPreparationCommand(program, argv, options, () => {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        queueMicrotask(() => { child.stdout.end(text); child.stderr.end(); child.emit('close', 0, null); });
        return child;
      });
    },
  };
  return { parent, output, sourceRoot, sources, executable, calls, io, env };
}
async function fails(f, extra = {}) {
  await assert.rejects(prepareBrowserSuite({ output: f.output }, { ...f.io, ...extra }), fixed);
  await absent(join(f.output, 'control/suite-ready.json'));
  for (const name of ['c52-evidence', 'playwright-output', 'control/execution-guard.json', 'control/c54-outer.json']) await absent(join(f.output, name));
}
async function walk(path) {
  const result = [];
  for (const name of await fs.readdir(path)) {
    const p = join(path, name), s = await fs.lstat(p);
    result.push({ path: p, s });
    if (s.isDirectory()) result.push(...await walk(p));
  }
  return result;
}

test('actual C65/C67 composition publishes preparation data only and preserves parent environment', async t => {
  const f = await fixture(t), before = { ...process.env };
  const path = await prepareBrowserSuite({ output: f.output }, f.io), bundle = await load(path);
  assert.ok(isDeepStrictEqual({ ...process.env }, before), 'Parent environment must remain unchanged.');
  assert.deepEqual(f.calls, ['revision', 'worktree', 'cargo-version', 'rustc-version', 'build']);
  assert.equal(path, join(f.output, 'control/suite-ready.json'));
  assert.equal(bundle.scope, 'browser suite preparation only'); assert.equal(bundle.launch, 'pending');
  assert.equal(bundle.full_readiness, false); assert.equal(bundle.browser_executions, 0); assert.equal(bundle.case_markers, 0);
  assert.deepEqual(Object.keys(bundle.environment).sort(), [...keys].sort());
  const child = JSON.parse(bundle.environment.WI_C54_ALLOCATION_PARENT);
  assert.deepEqual(Object.keys(child).sort(), ['path', 'uid', 'mode', 'device', 'inode'].sort());
  assert.equal(child.path, bundle.identities.child.path); assert.equal(child.mode, 0o700);
  assert.deepEqual(await fs.readdir(child.path), []);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['artifact', 'control', 'retained']);
  assert.ok(bundle.sources.manifest.files.some(r => r.path.endsWith('data.json')));
  for (const name of ['web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json']) {
    assert.ok(bundle.sources.manifest.files.some(r => r.path === name && r.type === 'file'));
  }
  assert.equal(bundle.producer.records.length, 24);
  assert.deepEqual(bundle.future_command, { program: process.execPath, argv: ['--', join(ROOT, 'web/node_modules/@playwright/test/cli.js'), 'test',
    `--config=${join(ROOT, 'web/playwright.config.mjs')}`, '--output', join(f.output, 'playwright-output')], cwd: ROOT });
  for (const p of Object.values(bundle.planned)) await absent(p);
  assert.equal((await fs.lstat(path)).nlink, 2);
  assert.equal((await fs.lstat(path)).ino, (await fs.lstat(join(f.output, 'control/suite-ready.pending.json'))).ino);
  for (const { path: p, s } of await walk(f.output)) {
    assert.equal(s.mode & 0o7777, s.isDirectory() ? 0o700 : 0o600);
    assert.ok(!/C(?:52|53|54|57|61)\.once|owner$/.test(p));
  }
  await assert.rejects(prepareBrowserSuite({ output: f.output }, f.io), fixed);
  assert.equal(f.calls.length, 5);
});

test('ordinary runtime directories retain nested regular JSON in the published manifest', async t => {
  const f = await fixture(t), roots = ['web/e2e', 'web/test-support', 'web/scripts'];
  for (const name of roots) {
    const path = join(f.sourceRoot, name, 'nested/data');
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(path, 'ordinary.json'), '{"ordinary":true}\n', { mode: 0o600 });
  }
  const bundle = await load(await prepareBrowserSuite({ output: f.output }, f.io));
  for (const name of roots) {
    for (const suffix of ['', '/nested', '/nested/data']) {
      assert.ok(bundle.sources.manifest.directories.some(r => r.path === name + suffix && r.type === 'directory'));
    }
    const record = bundle.sources.manifest.files.find(r => r.path === `${name}/nested/data/ordinary.json`);
    assert.equal(record.type, 'file'); assert.equal(record.bytes, Buffer.byteLength('{"ordinary":true}\n'));
    assert.equal(record.sha256, hash('{"ordinary":true}\n'));
  }
  assert.deepEqual(f.calls, ['revision', 'worktree', 'cargo-version', 'rustc-version', 'build']);
  for (const path of Object.values(bundle.planned)) await absent(path);
});

test('all eight inherited suite variables reject even equal-looking entries before effects', async t => {
  for (const key of keys) await t.test(key, async t => {
    const f = await fixture(t);
    const equalValues = { WI_C3A_FIXTURE: f.executable, WI_C3A_FIXTURE_SHA256: hash('synthetic artifact bytes'),
      WI_C47_FIXTURE_SHA256: hash('synthetic artifact bytes'), WI_C54_NATIVE_BINDING: join(f.output, 'artifact/native-binding.json'),
      WI_BROWSER_FIXTURE_PARENT: join(f.output, 'retained'), WI_C52_EVIDENCE: join(f.output, 'c52-evidence'),
      WI_C54_ALLOCATION_PARENT: '{}', WI_C54_OUTER_MARKER: join(f.output, 'control/c54-outer.json') };
    f.env[key] = equalValues[key];
    await fails(f); await absent(f.output); assert.equal(f.calls.length, 0);
  });
});

test('invalid, nonprivate, aliased, occupied and overlapping destinations never adopt or repair', async t => {
  for (const kind of ['relative', 'nul', 'unicode', 'trailing', 'traversal', 'missing', 'file-parent', 'public', 'owner', 'alias', 'occupied', 'source', 'target']) await t.test(kind, async t => {
    const f = await fixture(t), old = join(f.parent, 'old'); await fs.writeFile(old, 'retain');
    let output = f.output, extra = {};
    if (kind === 'relative') output = 'relative';
    if (kind === 'nul') output += '\0';
    if (kind === 'unicode') output += '\ud800';
    if (kind === 'trailing') output += '/';
    if (kind === 'traversal') output += '/../fresh';
    if (kind === 'missing') output = join(f.parent, 'absent/fresh');
    if (kind === 'file-parent') output = join(old, 'fresh');
    if (kind === 'public') await fs.chmod(f.parent, 0o755);
    if (kind === 'owner') extra = { io: { lstat: async p => { const s = await fs.lstat(p); Object.defineProperty(s, 'uid', { value: process.getuid() + 1 }); return s; } } };
    if (kind === 'alias') { await fs.symlink(f.parent, join(f.parent, 'alias')); output = join(f.parent, 'alias/fresh'); }
    if (kind === 'occupied') await fs.mkdir(output, { mode: 0o700 });
    if (kind === 'source') output = join(f.sourceRoot, 'web/e2e/fresh');
    if (kind === 'target') output = join(TARGET, 'fresh');
    await assert.rejects(prepareBrowserSuite({ output }, { ...f.io, ...extra }), fixed);
    assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(old, 'utf8'), 'retain');
    if (kind === 'occupied') assert.deepEqual(await fs.readdir(output), []);
    if (kind === 'public') assert.equal((await fs.lstat(f.parent)).mode & 0o7777, 0o755);
  });
});

test('required runtime directories reject initial regular files before producer entry or root traversal', async t => {
  for (const name of ['web/e2e', 'web/test-support', 'web/scripts']) await t.test(name, async t => {
    const f = await fixture(t), path = join(f.sourceRoot, name), bytes = 'ordinary file\n';
    await fs.rm(path, { recursive: true }); await fs.writeFile(path, bytes, { mode: 0o600 });
    assert.equal((await fs.lstat(path)).nlink, 1);
    let producers = 0, allocations = 0, traversals = 0, reads = 0;
    f.io.prepare = async (...args) => { producers++; return prepareBrowserFixture(...args); };
    f.io.io = {
      mkdtemp: async p => { allocations++; return fs.mkdtemp(p); },
      readdir: async p => { if (p === path) traversals++; return fs.readdir(p); },
      readFile: async (...args) => { if (args[0] === path) reads++; return fs.readFile(...args); },
    };
    await fails(f);
    assert.deepEqual([producers, f.calls.length, allocations, traversals, reads], [0, 0, 0, 0, 0]);
    assert.deepEqual(await load(join(f.output, 'suite-failure.json')), { stage: 'source', ready: false, launch: 'pending' });
    assert.deepEqual((await fs.readdir(f.output)).sort(), ['control', 'retained', 'suite-failure.json']);
    assert.deepEqual(await fs.readdir(join(f.output, 'retained')), []);
    assert.deepEqual(await fs.readdir(join(f.output, 'control')), []);
    for (const { path: p, s } of await walk(f.output)) {
      assert.equal(s.mode & 0o7777, s.isDirectory() ? 0o700 : 0o600);
      assert.ok(!/C(?:52|53|54|57|61)\.once|owner$/.test(p));
    }
    assert.equal(await fs.readFile(path, 'utf8'), bytes);
  });
});

test('fixed runtime files reject initial empty and populated directories before producer entry', async t => {
  for (const name of ['web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json']) {
    for (const populated of [false, true]) await t.test(`${name}-${populated ? 'populated' : 'empty'}`, async t => {
      const f = await fixture(t), path = join(f.sourceRoot, name);
      await fs.rm(path); await fs.mkdir(path, { mode: 0o700 });
      if (populated) await fs.writeFile(join(path, 'ordinary-child.json'), '{}\n', { mode: 0o600 });
      let producers = 0, allocations = 0, traversals = 0;
      f.io.prepare = async (...args) => { producers++; return prepareBrowserFixture(...args); };
      f.io.io = {
        mkdtemp: async p => { allocations++; return fs.mkdtemp(p); },
        readdir: async p => { if (p === path) traversals++; return fs.readdir(p); },
      };
      await fails(f);
      assert.deepEqual([producers, f.calls.length, allocations, traversals], [0, 0, 0, 0]);
      assert.deepEqual(await load(join(f.output, 'suite-failure.json')), { stage: 'source', ready: false, launch: 'pending' });
      assert.deepEqual((await fs.readdir(f.output)).sort(), ['control', 'retained', 'suite-failure.json']);
      assert.deepEqual(await fs.readdir(join(f.output, 'retained')), []);
      assert.deepEqual(await fs.readdir(join(f.output, 'control')), []);
      assert.deepEqual(await fs.readdir(path), populated ? ['ordinary-child.json'] : []);
    });
  }
});

test('runtime enumeration catches new deleted JSON, source mode/type/alias and config/package drift', async t => {
  for (const kind of ['new-json', 'deleted-json', 'source', 'mode', 'type', 'symlink', 'hardlink', 'config', 'package', 'lock']) await t.test(kind, async t => {
    const f = await fixture(t), original = f.io.command;
    f.io.command = async (...args) => {
      const text = await original(...args);
      if (args[2].name === 'build') {
        const data = join(f.sourceRoot, 'web/test-support/data.json');
        if (kind === 'new-json') await fs.writeFile(join(f.sourceRoot, 'web/e2e/new.json'), '{}');
        if (kind === 'deleted-json') await fs.rm(data);
        if (kind === 'source') await fs.writeFile(join(f.sourceRoot, 'web/e2e/case.mjs'), 'changed');
        if (kind === 'mode') await fs.chmod(data, 0o644);
        if (kind === 'type') { await fs.rm(data); await fs.mkdir(data); }
        if (kind === 'symlink') { await fs.rm(data); await fs.symlink(join(f.sourceRoot, 'web/package.json'), data); }
        if (kind === 'hardlink') await fs.link(data, join(f.sourceRoot, 'web/e2e/alias.json'));
        if (kind === 'config') await fs.writeFile(join(f.sourceRoot, 'web/playwright.config.mjs'), 'changed');
        if (kind === 'package') await fs.writeFile(join(f.sourceRoot, 'web/package.json'), 'changed');
        if (kind === 'lock') await fs.writeFile(join(f.sourceRoot, 'web/package-lock.json'), 'changed');
      }
      return text;
    };
    await fails(f); assert.equal(f.calls.filter(n => n === 'build').length, 1);
  });
});

test('producer maps and independent retained provenance cannot authorize coherent tampering', async t => {
  const mutations = {
    map: (m) => { m.extra = 'no'; },
    equalMap: m => { m.WI_C47_FIXTURE_SHA256 = 'f'.repeat(64); },
    invocationLock: (_, r) => { r['invocation.json'].cargo_lock.bytes++; },
    invocationEnv: (_, r) => { r['invocation.json'].environment.values.PATH = '/changed'; },
    invocationCommand: (_, r) => { r['invocation.json'].command.argv = []; },
    invocationToolchain: (_, r) => { r['invocation.json'].toolchain.rustc = 'changed'; },
    revision: (_, r) => { r['invocation.json'].revision = 'b'.repeat(40); r['preparation.json'].revision = 'b'.repeat(40); },
    ownership: (_, r) => { r['ownership.json'].inode++; },
    lock: (_, r) => { r['sources-before.json']['Cargo.lock'].bytes++; r['sources-after.json']['Cargo.lock'].bytes++; },
    terminal: (_, r) => { r['build.command.json'].code = 7; },
    closed: (_, r) => { r['build.command.json'].closed = false; },
    redaction: (_, r) => { r['build.command.json'].stdout_redacted = true; },
    stream: (_, r) => { r['build.command.json'].sanitized_stdout_sha256 = 'f'.repeat(64); },
    streamSize: (_, r) => { r['build.command.json'].sanitized_stderr_bytes++; },
    commandEnv: (_, r) => { r['build.command.json'].environment.cargo_build_jobs = '99'; },
    argv: (_, r) => { r['build.command.json'].argv = []; },
    binding: (m, r) => {
      r['native-binding.json'].sha256 = 'f'.repeat(64);
      m.WI_C3A_FIXTURE_SHA256 = m.WI_C47_FIXTURE_SHA256 = 'f'.repeat(64);
      r['environment.json'] = clone(m); r['environment.pending.json'] = clone(m);
      r['preparation.json'].sha256 = 'f'.repeat(64);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await fixture(t);
    f.io.prepare = async (...args) => {
      const map = await prepareBrowserFixture(...args), dir = join(f.output, 'artifact'), records = {};
      for (const n of await fs.readdir(dir)) if (n.endsWith('.json')) records[n] = await load(join(dir, n));
      mutate(map, records);
      for (const [n, value] of Object.entries(records)) await fs.writeFile(join(dir, n), JSON.stringify(value) + '\n');
      return map;
    };
    await fails(f);
  });
});

test('command seam cannot bless separately mutated terminal environment redaction or streams', async t => {
  for (const field of ['code', 'signal', 'environment', 'stdout_redacted', 'sanitized_stdout_sha256', 'sanitized_stderr_bytes']) await t.test(field, async t => {
    const f = await fixture(t), command = f.io.command;
    f.io.command = async (...args) => {
      const text = await command(...args);
      if (args[2].name === 'build') {
        const p = join(f.output, 'artifact/build.command.json'), record = await load(p);
        if (field === 'environment') record.environment.values.PATH = '/changed';
        else if (field === 'stdout_redacted') record[field] = true;
        else if (field.includes('sha256')) record[field] = 'f'.repeat(64);
        else if (field === 'signal') record[field] = 'SIGTERM';
        else record[field] = 7;
        await fs.writeFile(p, JSON.stringify(record));
      }
      return text;
    };
    await fails(f);
  });
});

test('actual allocation order reproof and all partials remain without output or markers', async t => {
  const f = await fixture(t), events = [];
  f.io.io = {
    mkdtemp: async p => { events.push('allocation'); const child = await fs.mkdtemp(p); assert.deepEqual(await fs.readdir(child), []); return child; },
    readdir: async p => { if (p === join(f.output, 'retained')) events.push('readiness'); return fs.readdir(p); },
  };
  const validate = f.io.validate;
  f.io.validate = async v => { events.push('binding'); return validate(v); };
  await prepareBrowserSuite({ output: f.output }, f.io);
  const at = events.indexOf('allocation');
  assert.ok(events.slice(0, at).includes('readiness')); assert.equal(events[at - 1], 'binding');
  assert.ok(events.slice(at + 1).includes('readiness'));
  for (const kind of ['allocation-error', 'allocation-mode', 'allocation-identity', 'binding-error', 'source-after-allocation']) await t.test(kind, async t => {
    const f = await fixture(t); let child;
    f.io.io = { mkdtemp: async p => {
      child = await fs.mkdtemp(p);
      if (kind === 'allocation-error') throw Error('synthetic first failure');
      if (kind === 'allocation-mode') await fs.chmod(child, 0o755);
      if (kind === 'source-after-allocation') await fs.writeFile(join(f.sourceRoot, 'web/e2e/new.json'), '{}');
      return child;
    }, lstat: async p => {
      const s = await fs.lstat(p);
      if (kind === 'allocation-identity' && p === child) Object.defineProperty(s, 'uid', { value: process.getuid() + 1 });
      return s;
    } };
    if (kind === 'binding-error') f.io.validate = async () => { throw Error('synthetic binding rejection'); };
    await fails(f);
    if (child) assert.deepEqual(await fs.readdir(child), []);
  });
});

test('native drift, late unexpected output and directory identity drift reject after allocation', async t => {
  for (const kind of ['native', 'planned', 'root-mode', 'child-content', 'extra-control']) await t.test(kind, async t => {
    const f = await fixture(t);
    f.io.io = { mkdtemp: async p => {
      const child = await fs.mkdtemp(p);
      if (kind === 'native') f.sources['Cargo.lock'].sha256 = hash('changed');
      if (kind === 'planned') await fs.mkdir(join(f.output, 'playwright-output'));
      if (kind === 'root-mode') await fs.chmod(f.output, 0o755);
      if (kind === 'child-content') await fs.writeFile(join(child, 'unexpected'), 'retain');
      if (kind === 'extra-control') await fs.writeFile(join(f.output, 'control/unexpected'), 'retain');
      return child;
    } };
    await assert.rejects(prepareBrowserSuite({ output: f.output }, f.io), fixed);
    await absent(join(f.output, 'control/suite-ready.json'));
    assert.equal((await fs.readdir(join(f.output, 'retained'))).length, 1);
  });
});

test('artifact entries stay closed at initial audit allocation and pending readback without deleting partials', async t => {
  for (const boundary of ['producer', 'allocation', 'pending']) {
    const kinds = boundary === 'producer' ? ['file', 'directory', 'symlink'] : ['file', 'directory', 'symlink', 'record'];
    for (const kind of kinds) await t.test(`${boundary}-${kind}`, async t => {
      const f = await fixture(t), artifact = join(f.output, 'artifact');
      let originals, child, inserted = false;
      const observe = async path => {
        const s = await fs.lstat(path);
        return { bytes: await fs.readFile(path), uid: s.uid, mode: s.mode, device: s.dev, inode: s.ino, links: s.nlink };
      };
      const insert = async () => {
        inserted = true;
        const path = join(artifact, 'unexpected');
        if (kind === 'file') await fs.writeFile(path, 'retain\n', { mode: 0o600 });
        if (kind === 'directory') await fs.mkdir(path, { mode: 0o700 });
        if (kind === 'symlink') await fs.symlink(join(f.sourceRoot, 'web/test-support/data.json'), path);
        if (kind === 'record') await fs.appendFile(join(artifact, 'revision.stdout'), 'changed\n');
      };
      f.io.prepare = async (...args) => {
        const map = await prepareBrowserFixture(...args);
        const names = (await fs.readdir(artifact)).sort(); assert.equal(names.length, 24);
        originals = new Map(await Promise.all(names.map(async name => [name, await observe(join(artifact, name))])));
        if (boundary === 'producer') await insert();
        return map;
      };
      f.io.io = {
        mkdtemp: async p => { child = await fs.mkdtemp(p); if (boundary === 'allocation') await insert(); return child; },
        writeFile: async (p, bytes, options) => {
          await fs.writeFile(p, bytes, options);
          if (boundary === 'pending' && p.endsWith('suite-ready.pending.json')) await insert();
        },
      };
      await fails(f); assert.ok(inserted);
      assert.equal(f.calls.length, 5);
      const names = (await fs.readdir(artifact)).sort();
      assert.deepEqual(names, [...originals.keys(), ...(kind === 'record' ? [] : ['unexpected'])].sort());
      for (const [name, original] of originals) {
        if (kind !== 'record' || name !== 'revision.stdout') assert.deepEqual(await observe(join(artifact, name)), original);
      }
      const retained = join(f.output, 'retained'), pending = join(f.output, 'control/suite-ready.pending.json');
      if (boundary === 'producer') {
        assert.equal(child, undefined); assert.deepEqual(await fs.readdir(retained), []);
      } else {
        assert.deepEqual(await fs.readdir(retained), [child.slice(retained.length + 1)]);
        assert.deepEqual(await fs.readdir(child), []);
        assert.equal((await fs.lstat(child)).mode & 0o7777, 0o700);
      }
      if (boundary === 'pending') assert.equal((await load(pending)).launch, 'pending');
      else await absent(pending);
      const stages = { producer: 'producer', allocation: 'readiness', pending: 'publication' };
      assert.deepEqual(await load(join(f.output, 'suite-failure.json')), { stage: stages[boundary], ready: false, launch: 'pending' });
      for (const { path } of await walk(f.output)) assert.ok(!/C(?:52|53|54|57|61)\.once|owner$/.test(path));
    });
  }
});

test('every driver I/O boundary fails closed and retains partials including pending readback', async t => {
  const f = await fixture(t), operations = [];
  const names = ['lstat', 'realpath', 'readFile', 'readdir', 'mkdir', 'mkdtemp', 'writeFile', 'link'];
  f.io.io = Object.fromEntries(names.map(name => [name, async (...args) => { operations.push(name); return fs[name](...args); }]));
  await prepareBrowserSuite({ output: f.output }, f.io);
  // Exercise each distinct call position, including every final source/native/record readback.
  for (let failAt = 0; failAt < operations.length; failAt++) await t.test(`operation-${failAt}-${operations[failAt]}`, async t => {
    const f = await fixture(t); let index = 0, triggered = false;
    f.io.io = Object.fromEntries(names.map(name => [name, async (...args) => {
      if (index++ === failAt) { triggered = true; throw Object.assign(Error('synthetic I/O failure'), { code: 'EIO' }); }
      return fs[name](...args);
    }]));
    await fails(f); assert.ok(triggered);
  });
});

test('pending corruption, missing records, arbitrary aliases, final occupation and hard-link failure retain empty child', async t => {
  for (const kind of ['truncate-pending', 'corrupt-pending', 'missing-record', 'record-mode', 'extra-link', 'final-occupied', 'link-failure']) await t.test(kind, async t => {
    const f = await fixture(t);
    f.io.io = { writeFile: async (p, bytes, options) => {
      await fs.writeFile(p, bytes, options);
      if (p.endsWith('suite-ready.pending.json')) {
        if (kind === 'truncate-pending') await fs.writeFile(p, '{');
        if (kind === 'corrupt-pending') await fs.writeFile(p, String(bytes).replace('"pending"', '"changed"'));
        if (kind === 'missing-record') await fs.rm(join(f.output, 'artifact/revision.command.json'));
        if (kind === 'record-mode') await fs.chmod(join(f.output, 'artifact/invocation.json'), 0o644);
        if (kind === 'extra-link') await fs.link(join(f.output, 'artifact/environment.json'), join(f.parent, 'extra-link'));
        if (kind === 'final-occupied') await fs.writeFile(join(f.output, 'control/suite-ready.json'), 'preexisting', { mode: 0o600 });
      }
    }, link: async (...args) => { if (kind === 'link-failure') throw Error('synthetic link failure'); return fs.link(...args); } };
    if (kind === 'final-occupied') {
      await assert.rejects(prepareBrowserSuite({ output: f.output }, f.io), fixed);
      assert.equal(await fs.readFile(join(f.output, 'control/suite-ready.json'), 'utf8'), 'preexisting');
    } else await fails(f);
    const retained = join(f.output, 'retained');
    const children = await fs.readdir(retained); assert.equal(children.length, 1);
    assert.deepEqual(await fs.readdir(join(retained, children[0])), []);
  });
});

test('structured scrubber handles keys values collisions and fixed-point deletion before persistence', async t => {
  const redact = preparationRedactor({ API_TOKEN: 'xy', SECRET_KEY: 'ab' });
  const value = { ab: 'ax yb'.replaceAll(' ', ''), keep: ['axyb', 'xy'] };
  const safe = sanitizeRecord(value, redact);
  assert.deepEqual(safe, { '': '', keep: ['', ''] });
  for (const collision of ['output', 'PATH', 'environment', 'version', 'scope', 'sha256']) await t.test(collision, async t => {
    const f = await fixture(t); f.env.SYNTHETIC_TOKEN = collision;
    await fails(f);
    if (await fs.lstat(f.output).catch(() => null)) {
      for (const { path, s } of await walk(f.output)) if (s.isFile()) {
        assert.equal((await fs.readFile(path, 'utf8')).includes(collision), false, 'Sensitive matches must not be persisted.');
      }
    }
  });
});

test('CLI is fixed, inert on import, rejects passthrough and never prints private values', async t => {
  const { run } = await import('../scripts/prepare-browser-suite.mjs');
  let calls = 0, diagnostic = '';
  const stderr = { write: text => { diagnostic += text; } };
  for (const argv of [[], ['--output'], ['--output', 'relative'], ['launch', '/synthetic/out'], ['--output', '/synthetic/out', '--grep', 'case'],
    ['--output', '/synthetic/\0'], ['--output', '/synthetic/\ud800']]) assert.equal(await run(argv, async () => { calls++; }, stderr), 2);
  assert.equal(calls, 0); assert.ok(!diagnostic.includes('synthetic'));
  diagnostic = '';
  assert.equal(await run(['--output', '/synthetic/fresh'], async () => { throw Error('private detail'); }, stderr), 1);
  assert.equal(diagnostic, 'browser_suite_preparation: preparation failed; owned partial records are retained.\n');
  const f = await fixture(t);
  assert.equal(await run(['--output', f.output], options => prepareBrowserSuite(options, f.io), stderr), 0);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/prepare-browser-suite.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.ok(r.status === 0 && r.stdout === '' && r.stderr === '', 'Import must be inert.');
});
