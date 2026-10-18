import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareBrowserFixture, recordPreparationCommand, preparationRedactor } from '../test-support/browser-fixture-preparation.mjs';
import { run } from '../scripts/prepare-browser-fixture.mjs';
import { ROOT, TARGET, CHILD, CARGO_ARGS } from '../test-support/live-commit-native.mjs';
import { CHILD_TEST } from '../test-support/fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const json = (...values) => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' });
const fixedError = { message: 'Browser fixture preparation failed.' };

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'wi-preparation-unit-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = join(parent, 'fresh');
  const ownedFile = join(parent, 'synthetic-artifact');
  await writeFile(ownedFile, 'synthetic bytes, never an executable', { mode: 0o600 });
  const sources = { 'Cargo.lock': { sha256: hash('lock'), bytes: 4, mode: 0o644 },
    'src/lib.rs': { sha256: hash('source'), bytes: 6, mode: 0o644 } };
  const executable = join(TARGET, 'debug/deps/wi-0123456789abcdef');
  const artifact = { reason: 'compiler-artifact', manifest_path: join(ROOT, 'Cargo.toml'),
    target: { name: 'wi', kind: ['lib'], src_path: join(ROOT, 'src/lib.rs') }, profile: { test: true }, executable };
  const finish = { reason: 'build-finished', success: true };
  const state = { commands: [], builds: 0, sources: 0, validations: 0, bindings: 0, writes: [] };
  const io = {
    sources: async () => { state.sources++; return clone(sources); },
    command: async (program, args, options) => {
      state.commands.push({ program, args: [...args], options: clone(options) });
      assert.equal(options.cwd, ROOT); assert.equal(options.output, output);
      let text = 'synthetic toolchain\n';
      if (options.name === 'build') {
        state.builds++; assert.equal(program, 'cargo'); assert.deepEqual(args, CARGO_ARGS);
        text = json(artifact, finish);
      }
      if (options.name === 'revision') text = 'a'.repeat(40) + '\n';
      if (options.name === 'worktree') text = '?? synthetic-file\n';
      return recordPreparationCommand(program, args, options, (...spawnArgs) => {
        if (state.spawnCommand) return state.spawnCommand(text, ...spawnArgs);
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        queueMicrotask(() => { child.stdout.end(text); child.stderr.end(); child.emit('close', 0, null); });
        return child;
      });
    },
    bind: async (text, inputs) => {
      state.bindings++;
      return { executable, sha256: hash(await readFile(ownedFile)), selector: CHILD, sources: clone(inputs), cargo_json: text };
    },
    validate: async value => {
      state.validations++;
      assert.equal(value.sha256, hash(await readFile(ownedFile)));
      assert.equal(value.selector, CHILD); assert.deepEqual(value.sources, sources);
      return clone(value);
    },
    write: async (path, bytes) => {
      state.writes.push(path);
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    },
  };
  return { parent, output, ownedFile, sources, executable, artifact, finish, state, io };
}

async function fails(f, overrides = {}) {
  await assert.rejects(prepareBrowserFixture({ output: f.output }, { ...f.io, ...overrides }), fixedError);
  await absent(join(f.output, 'environment.json'));
}

test('actual producer publishes exact consistent bindings without mutating the environment', async t => {
  const f = await fixture(t), before = { ...process.env };
  const original = f.io.command;
  f.io.command = async (...args) => {
    const result = await original(...args);
    args[2].env.PATH = '/synthetic/changed';
    return result;
  };
  const result = await prepareBrowserFixture({ output: f.output }, f.io);
  assert.ok(isDeepStrictEqual({ ...process.env }, before), 'Parent environment must remain unchanged.');
  assert.deepEqual(result, { WI_C3A_FIXTURE: f.executable, WI_C3A_FIXTURE_SHA256: hash(await readFile(f.ownedFile)),
    WI_C47_FIXTURE_SHA256: hash(await readFile(f.ownedFile)), WI_C54_NATIVE_BINDING: join(f.output, 'native-binding.json') });
  assert.deepEqual(await load(join(f.output, 'environment.json')), result);
  const binding = await load(result.WI_C54_NATIVE_BINDING);
  assert.deepEqual(Object.keys(binding).sort(), ['executable', 'sha256', 'selector', 'sources', 'cargo_json'].sort());
  assert.equal(binding.executable, result.WI_C3A_FIXTURE); assert.equal(binding.sha256, result.WI_C47_FIXTURE_SHA256);
  assert.equal(binding.selector, CHILD); assert.notEqual(CHILD, CHILD_TEST);
  assert.deepEqual(binding.sources, f.sources);
  assert.deepEqual(await load(join(f.output, 'sources-before.json')), await load(join(f.output, 'sources-after.json')));
  assert.equal(f.state.builds, 1); assert.equal(f.state.bindings, 1); assert.equal(f.state.validations, 2);
  assert.equal(f.state.sources, 3);
  assert.deepEqual(f.state.commands.map(c => c.options.name), ['revision', 'worktree', 'cargo-version', 'rustc-version', 'build']);
  assert.ok(f.state.commands.every(c => c.options.env.PATH === before.PATH));
  const invocation = await load(join(f.output, 'invocation.json'));
  assert.equal(invocation.revision, 'a'.repeat(40)); assert.equal(invocation.worktree, '?? synthetic-file\n');
  assert.deepEqual(invocation.command.argv, CARGO_ARGS);
  assert.equal(invocation.selectors.observed_in_executable, false);
  const receipt = await load(join(f.output, 'preparation.json'));
  assert.equal(receipt.full_readiness, false); assert.equal(receipt.product_test_execution, false);
  assert.equal(receipt.allocation, 'not prepared'); assert.equal(receipt.ci, 'not wired');
  assert.equal((await lstat(f.output)).mode & 0o7777, 0o700);
  for (const name of await readdir(f.output)) assert.equal((await lstat(join(f.output, name))).mode & 0o7777, 0o600);
});

test('actual CLI parsing rejects malformed inputs before any producer call and never prints raw details', async t => {
  let calls = 0, text = '';
  const stderr = { write: value => { text += value; } };
  for (const argv of [[], ['--output'], ['--output', 'relative'], ['--other', '/synthetic/out'],
    ['--output', '/synthetic/out', 'extra'], ['--output', '/synthetic/\0secret'], ['--output', '/synthetic/\ud800']]) {
    assert.equal(await run(argv, async () => { calls++; }, stderr), 2);
  }
  assert.equal(calls, 0); assert.match(text, /invalid invocation/); assert.doesNotMatch(text, /synthetic|secret/);
  const f = await fixture(t);
  assert.equal(await run(['--output', f.output], options => prepareBrowserFixture(options, f.io), stderr), 0);
  assert.equal(f.state.builds, 1);
  text = '';
  assert.equal(await run(['--output', f.output], async () => { throw Error('private detail'); }, stderr), 1);
  assert.equal(text, 'browser_fixture_preparation: preparation failed; owned partial records are retained.\n');
  const cli = spawnSync(process.execPath, ['--', join(ROOT, 'web/scripts/prepare-browser-fixture.mjs'), '--output', 'relative'], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.ok(cli.stdout === '' && cli.stderr === 'browser_fixture_preparation: invalid invocation.\n', 'CLI diagnostics must be fixed text.');
});

test('invalid destinations reject before metadata or build and preserve siblings', async t => {
  for (const kind of ['relative', 'traversal', 'trailing-slash', 'missing-parent', 'file-parent', 'symlink-parent', 'ancestor-symlink',
    'public-parent', 'wrong-owner', 'occupied-directory', 'occupied-file', 'occupied-symlink']) await t.test(kind, async t => {
    const f = await fixture(t), sibling = join(f.parent, 'old-record');
    await writeFile(sibling, 'retain', { mode: 0o600 });
    let output = f.output;
    if (kind === 'relative') output = 'relative';
    if (kind === 'traversal') output = join(f.parent, 'unused') + '/../fresh';
    if (kind === 'trailing-slash') output += '/';
    if (kind === 'missing-parent') output = join(f.parent, 'missing', 'fresh');
    if (kind === 'file-parent') output = join(sibling, 'fresh');
    if (kind === 'symlink-parent') { await symlink(f.parent, join(f.parent, 'alias')); output = join(f.parent, 'alias', 'fresh'); }
    if (kind === 'ancestor-symlink') {
      await mkdir(join(f.parent, 'nested'), { mode: 0o700 });
      await symlink(f.parent, join(f.parent, 'alias'));
      output = join(f.parent, 'alias', 'nested', 'fresh');
    }
    if (kind === 'public-parent') await chmod(f.parent, 0o755);
    if (kind === 'wrong-owner') f.io.lstat = async path => {
      const s = await lstat(path); Object.defineProperty(s, 'uid', { value: process.getuid() + 1 }); return s;
    };
    if (kind === 'occupied-directory') await mkdir(f.output, { mode: 0o700 });
    if (kind === 'occupied-file') await writeFile(f.output, 'old');
    if (kind === 'occupied-symlink') await symlink(sibling, f.output);
    await assert.rejects(prepareBrowserFixture({ output }, f.io), fixedError);
    assert.equal(f.state.commands.length, 0); assert.equal(f.state.sources, 0); assert.equal(f.state.writes.length, 0);
    assert.equal(await readFile(sibling, 'utf8'), 'retain');
    if (kind === 'occupied-directory') assert.deepEqual(await readdir(f.output), []);
    if (kind === 'occupied-file') assert.equal(await readFile(f.output, 'utf8'), 'old');
    if (kind === 'occupied-symlink') assert.equal((await lstat(f.output)).isSymbolicLink(), true);
  });
});

test('both real Cargo parsers reject malformed absent duplicate and wrong artifacts', async t => {
  for (const kind of ['malformed', 'absent', 'duplicate', 'failed', 'no-finish', 'duplicate-finish', 'after-finish',
    'wrong-root', 'wrong-manifest', 'wrong-name', 'wrong-target', 'wrong-kind', 'not-test', 'compiler-error']) await t.test(kind, async t => {
    const f = await fixture(t), artifact = clone(f.artifact), finish = clone(f.finish);
    if (kind === 'wrong-root') artifact.target.src_path = '/synthetic/src/lib.rs';
    if (kind === 'wrong-manifest') artifact.manifest_path = '/synthetic/Cargo.toml';
    if (kind === 'wrong-name') artifact.target.name = 'other';
    if (kind === 'wrong-target') artifact.executable = '/synthetic/debug/deps/wi-abcdef';
    if (kind === 'wrong-kind') artifact.target.kind = ['bin'];
    if (kind === 'not-test') artifact.profile.test = false;
    if (kind === 'failed') finish.success = false;
    let text = json(artifact, finish);
    if (kind === 'malformed') text = 'not JSON\n';
    if (kind === 'absent') text = json(finish);
    if (kind === 'duplicate') text = json(artifact, artifact, finish);
    if (kind === 'no-finish') text = json(artifact);
    if (kind === 'duplicate-finish') text = json(artifact, finish, finish);
    if (kind === 'after-finish') text = json(artifact, finish, { reason: 'unrelated' });
    if (kind === 'compiler-error') text = json(artifact, { reason: 'compiler-message', message: { level: 'error' } }, finish);
    const original = f.io.command;
    f.io.command = async (...args) => { const value = await original(...args); return args[2].name === 'build' ? text : value; };
    await fails(f);
    assert.equal(f.state.builds, 1); assert.equal(f.state.bindings, 0);
    assert.equal((await load(join(f.output, 'failure.json'))).stage, 'artifact');
    assert.equal(await readFile(join(f.output, 'cargo.jsonl'), 'utf8'), text);
  });
});

test('source lock and mode drift reject before binding publication', async t => {
  for (const kind of ['source', 'lock', 'mode', 'added', 'removed', 'final']) await t.test(kind, async t => {
    const f = await fixture(t);
    const sources = f.io.sources;
    f.io.sources = async () => {
      const value = await sources();
      if (f.state.sources >= (kind === 'final' ? 3 : 2)) {
        if (kind === 'lock') value['Cargo.lock'].sha256 = hash('changed');
        else if (kind === 'mode') value['src/lib.rs'].mode = 0o600;
        else if (kind === 'added') value.extra = {};
        else if (kind === 'removed') delete value['src/lib.rs'];
        else value['src/lib.rs'].sha256 = hash('changed');
      }
      return value;
    };
    await fails(f); assert.equal(f.state.builds, 1);
    assert.equal((await load(join(f.output, 'failure.json'))).stage, kind === 'final' ? 'final_revalidation' : 'source_after');
  });
});

test('strong binding shape selector digest and final executable checks fail closed', async t => {
  for (const kind of ['selector', 'digest', 'executable', 'sources', 'cargo', 'extra-field', 'validator', 'changed-final', 'missing-final']) await t.test(kind, async t => {
    const f = await fixture(t), bind = f.io.bind, validate = f.io.validate;
    f.io.bind = async (...args) => {
      const value = await bind(...args);
      if (kind === 'selector') value.selector = CHILD_TEST;
      if (kind === 'digest') value.sha256 = 'a'.repeat(64);
      if (kind === 'executable') value.executable = '/synthetic/other';
      if (kind === 'sources') value.sources = {};
      if (kind === 'cargo') value.cargo_json = '';
      if (kind === 'extra-field') value.extra = true;
      return value;
    };
    f.io.validate = async value => {
      if (kind === 'validator') throw Error('synthetic binding rejection');
      if (f.state.validations === 1) {
        if (kind === 'changed-final') await writeFile(f.ownedFile, 'changed');
        if (kind === 'missing-final') await rm(f.ownedFile);
      }
      return validate(value);
    };
    await fails(f); assert.equal(f.state.builds, 1);
    assert.ok(await lstat(f.output));
    if (kind.endsWith('-final')) assert.equal((await load(join(f.output, 'failure.json'))).stage, 'final_revalidation');
  });
});

test('partial write failures retain records and first failure without a ready environment', async t => {
  for (const name of ['ownership.json', 'sources-before.json', 'invocation.json', 'cargo.jsonl', 'sources-after.json',
    'native-binding.json', 'environment.pending.json', 'preparation.json']) await t.test(name, async t => {
    const f = await fixture(t), write = f.io.write;
    f.io.write = async (path, bytes) => {
      if (path === join(f.output, name)) {
        await write(path, '{partial'); throw Error('first synthetic write failure');
      }
      return write(path, bytes);
    };
    await fails(f);
    assert.equal(await readFile(join(f.output, name), 'utf8'), '{partial');
    assert.equal((await load(join(f.output, 'failure.json'))).error.message, 'first synthetic write failure');
    await assert.rejects(prepareBrowserFixture({ output: f.output }, f.io), fixedError);
    assert.equal(await readFile(join(f.output, name), 'utf8'), '{partial');
  });
  const f = await fixture(t);
  await fails(f, { write: async () => { throw Error('record destination failed'); } });
  assert.deepEqual(await readdir(f.output), []);
});

test('actual process recorder separates logs identity terminal nonzero signal and failed starts', async t => {
  for (const kind of ['success', 'nonzero', 'signal', 'missing-program', 'throw-start']) await t.test(kind, async t => {
    const f = await fixture(t); await mkdir(f.output, { mode: 0o700 });
    const options = { cwd: f.parent, env: { ...process.env }, output: f.output, name: 'controlled' };
    let program = process.execPath, args = ['--input-type=module', '-e', "console.log('synthetic stdout'); console.error('synthetic stderr');"];
    if (kind === 'nonzero') args.push('unused');
    if (kind === 'nonzero') args[2] += 'process.exitCode=7;';
    if (kind === 'signal') args[2] += "process.kill(process.pid,'SIGTERM');";
    if (kind === 'missing-program') program = join(f.parent, 'absent-program');
    const spawnCommand = kind === 'throw-start' ? () => { throw Object.assign(Error('synthetic start rejection'), { code: 'EACCES' }); } : undefined;
    const action = recordPreparationCommand(program, args, options, spawnCommand);
    if (kind === 'success') assert.equal(await action, 'synthetic stdout\n');
    else await assert.rejects(action, fixedError);
    const facts = await load(join(f.output, 'controlled.command.json'));
    assert.equal(facts.program, program); assert.deepEqual(facts.argv, args); assert.equal(facts.cwd, f.parent);
    assert.equal(facts.sanitized_stdout_sha256, hash(await readFile(facts.stdout)));
    assert.equal(facts.sanitized_stderr_sha256, hash(await readFile(facts.stderr)));
    assert.equal(facts.sanitized_stdout_bytes, (await readFile(facts.stdout)).length);
    assert.equal(facts.sanitized_stderr_bytes, (await readFile(facts.stderr)).length);
    assert.equal(facts.log_boundary, 'sanitized streams only; raw streams remained in memory');
    assert.equal((await lstat(facts.stdout)).mode & 0o7777, 0o600);
    if (kind === 'success') { assert.equal(facts.code, 0); assert.equal(facts.closed, true); }
    if (kind === 'nonzero') assert.equal(facts.code, 7);
    if (kind === 'signal') assert.equal(facts.signal, 'SIGTERM');
    if (kind === 'missing-program' || kind === 'throw-start') assert.ok(facts.spawn_error);
    if (facts.identity) assert.equal(facts.direct_identity_retired, true);
  });
});

test('producer retains failed builds and metadata failures without automatic retry', async t => {
  for (const kind of ['start', 'nonzero', 'signal', 'metadata']) await t.test(kind, async t => {
    const f = await fixture(t), command = f.io.command;
    f.io.command = async (...args) => {
      const value = await command(...args);
      if (args[2].name === (kind === 'metadata' ? 'revision' : 'build')) {
        const script = kind === 'signal' ? "process.kill(process.pid,'SIGTERM')" : 'process.exitCode=3';
        const program = kind === 'start' ? join(f.parent, 'absent') : process.execPath;
        return recordPreparationCommand(program, ['-e', script], { ...args[2], name: `${args[2].name}-failure`, cwd: f.parent });
      }
      return value;
    };
    await fails(f); assert.equal(f.state.builds, kind === 'metadata' ? 0 : 1);
    const failure = await load(join(f.output, 'failure.json'));
    assert.equal(failure.stage, kind === 'metadata' ? 'metadata' : 'build');
    const saved = await load(join(f.output, `${kind === 'metadata' ? 'revision' : 'build'}-failure.command.json`));
    assert.ok(failure.error.code !== 'EEXIST', 'Receipt collisions must not mask the intended command failure.');
    if (kind === 'start') assert.ok(saved.spawn_error?.code === 'ENOENT', 'The failed-start receipt must be retained.');
    else assert.ok(saved.closed && (kind === 'signal' ? saved.signal === 'SIGTERM' : saved.code === 3), 'The intended terminal failure must be retained.');
  });
});

test('unchanged strong native binder validates actual owned files with a synthetic target, never the shared target', async t => {
  const f = await fixture(t), target = join(f.parent, 'target');
  await mkdir(join(target, 'debug/deps'), { recursive: true, mode: 0o700 });
  const executable = join(target, 'debug/deps/wi-abcdef');
  await writeFile(executable, 'synthetic binding bytes', { mode: 0o600 });
  const text = json({ ...f.artifact, executable }, f.finish);
  const script = `import {nativeSources,bindCargoArtifact,nativeBinding} from './web/test-support/live-commit-native.mjs';
    import {readFile,writeFile,rm} from 'node:fs/promises';
    import assert from 'node:assert/strict';
    const text=process.argv[1], sources=await nativeSources();
    const binding=await bindCargoArtifact(text,sources); assert.deepEqual(await nativeBinding(binding),binding);
    await assert.rejects(nativeBinding({...binding,selector:'wrong'}));
    await assert.rejects(nativeBinding({...binding,sha256:'a'.repeat(64)}));
    await assert.rejects(nativeBinding({...binding,extra:true}));
    await writeFile(binding.executable,'changed'); await assert.rejects(nativeBinding(binding));
    await rm(binding.executable); await assert.rejects(nativeBinding(binding));
    console.log(JSON.stringify({checks:6,inputs:Object.keys(sources).length,selector:binding.selector}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, text], {
    cwd: ROOT, env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: 'utf8',
  });
  assert.ok(result.status === 0, 'Synthetic binder child must succeed.');
  const proof = JSON.parse(result.stdout); assert.equal(proof.checks, 6); assert.equal(proof.selector, CHILD);
  assert.ok(proof.inputs > 400);
});

test('diagnostic redactor covers raw encoded escaped values and names without changing approved fields', () => {
  const value = 'synthetic/quote"line\n雪-diagnostic-4189';
  const env = { C65_SYNTHETIC_SECRET: value, PATH: '/synthetic/bin', NODE_OPTIONS: '' };
  const redact = preparationRedactor(env);
  const variants = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), encodeURI(value),
    Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), 'C65_SYNTHETIC_SECRET',
    Array.from({ length: value.length }, (_, i) => '\\u' + value.charCodeAt(i).toString(16).padStart(4, '0')).join('')];
  assert.ok(variants.every(text => redact(text) === ''), 'All diagnostic variants must be scrubbed.');
  assert.ok(preparationRedactor({ SYNTHETIC_SECRET: 'R' })('R') === '', 'Match removal must not insert another sensitive string.');
  assert.ok(preparationRedactor({})('ordinary diagnostic') === 'ordinary diagnostic', 'Empty redaction sets must preserve diagnostics.');
  assert.ok(redact(JSON.stringify({ PATH: env.PATH, NODE_OPTIONS: env.NODE_OPTIONS })) === JSON.stringify({ PATH: env.PATH, NODE_OPTIONS: env.NODE_OPTIONS }), 'Approved fields must remain usable.');
});

test('diagnostic removal reaches a fixed point after joining recognized fragments', async t => {
  const cases = [
    { name: 'overlap', input: 'aabb', expected: '' },
    { name: 'longer-chain', input: 'a'.repeat(64) + 'b'.repeat(64), expected: '' },
    { name: 'multiple-patterns', input: 'acdb', extra: 'cd', expected: '' },
    { name: 'encoded-join', input: 'YWaabbI=', expected: '' },
    { name: 'single-match', input: 'left[ab]right', expected: 'left[]right' },
    { name: 'nonoverlap', input: 'ordinary diagnostic', expected: 'ordinary diagnostic' },
  ];
  for (const c of cases) await t.test(c.name, () => {
    const env = { C65_SYNTHETIC_SECRET: 'ab' };
    if (c.extra) env.C65_SYNTHETIC_PASSWORD = c.extra;
    const redact = preparationRedactor(env), result = redact(c.input);
    assert.ok(result === c.expected, 'Removal must also remove matches created by earlier deletions.');
    assert.ok(redact(result) === result, 'Sanitized strings must be fixed points.');
    assert.ok(!result.includes('ab') && (!c.extra || !result.includes(c.extra)), 'No recognized nonempty match may remain.');
  });
});

test('actual recorder removes recreated matches from both streams and structured string or error data', async t => {
  const cases = [
    { name: 'overlap', chunks: ['aabb'] },
    { name: 'split-reads', chunks: ['aa', 'bb'] },
    { name: 'longer-chain', chunks: ['a'.repeat(64), 'b'.repeat(64)] },
    { name: 'multiple-patterns', chunks: ['ac', 'db'], extra: 'cd' },
    { name: 'encoded-join', chunks: ['YWa', 'abbI='] },
    { name: 'structured-error', chunks: ['aabb'], thrown: true },
    { name: 'nonoverlap', chunks: ['ordinary ', 'diagnostic'], value: 'synthetic-M4-nonoverlap-81937' },
  ];
  for (const c of cases) await t.test(c.name, async t => {
    const f = await fixture(t); await mkdir(f.output, { mode: 0o700 });
    // Only synthetic recognized data enters this recorder, with the approved fields unchanged.
    const keys = ['TMPDIR', 'CARGO_TARGET_DIR', 'RUSTFLAGS', 'GIT_OPTIONAL_LOCKS', 'NODE_OPTIONS', 'PATH'];
    const env = { ...Object.fromEntries(keys.map(k => [k, process.env[k]])), C65_SYNTHETIC_SECRET: c.value ?? 'ab' };
    if (c.extra) env.C65_SYNTHETIC_PASSWORD = c.extra;
    const input = c.chunks.join(''), expected = c.value ? input : '';
    const redact = preparationRedactor(env);
    const action = recordPreparationCommand(input, [input], { cwd: ROOT, env, output: f.output, name: 'closure' }, () => {
      if (c.thrown) throw Object.assign(Error(input), { code: input });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => {
        for (const chunk of c.chunks) { child.stdout.write(chunk); child.stderr.write(chunk); }
        child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
      });
      return child;
    });
    if (c.value) assert.ok(await action === expected, 'Nonoverlap data must remain unchanged.');
    else await assert.rejects(action, fixedError);
    const facts = await load(join(f.output, 'closure.command.json'));
    for (const stream of ['stdout', 'stderr']) {
      const bytes = await readFile(join(f.output, `closure.${stream}`)), text = bytes.toString('utf8');
      assert.ok(text === (c.thrown ? '' : expected), 'Persisted streams must contain only fully sanitized data.');
      assert.ok(!text.includes(env.C65_SYNTHETIC_SECRET) && (!c.extra || !text.includes(c.extra))
        && redact(text) === text, 'Retained streams must contain no recreated known match.');
      assert.ok(facts[`sanitized_${stream}_bytes`] === bytes.length && facts[`sanitized_${stream}_sha256`] === hash(bytes), 'Stream counters and hashes must bind sanitized bytes.');
      assert.ok(((await lstat(join(f.output, `closure.${stream}`))).mode & 0o7777) === 0o600, 'Stream files must remain private.');
    }
    assert.ok(facts.program === expected && facts.argv.length === 1 && facts.argv[0] === expected, 'Structured string data must reach the same fixed point.');
    assert.ok(facts.stdout_redacted === (!c.value && !c.thrown), 'Redaction flags must describe actual stdout changes.');
    assert.ok(facts.closed === !c.thrown && facts.code === (c.thrown ? null : 0) && facts.signal === null, 'Terminal facts must remain typed.');
    assert.ok(isDeepStrictEqual(facts.environment.values, Object.fromEntries(keys.map(k => [k, process.env[k]]))), 'Approved fields must remain exact.');
    if (c.thrown) assert.ok(facts.spawn_error.code === '' && facts.spawn_error.message === '', 'Error string data must reach the same fixed point.');
    else assert.ok(facts.spawn_error === null, 'Successful synthetic closure must not create a spawn error.');
  });
});

test('actual recorder scrubs split pipes errors and receipts before persistence and preserves Cargo JSON', async t => {
  for (const kind of ['split', 'encoded', 'cargo', 'thrown', 'spawn-error']) await t.test(kind, async t => {
    const f = await fixture(t); await mkdir(f.output, { mode: 0o700 });
    const value = 'synthetic/quote"line\n雪-diagnostic-7351';
    const env = { ...process.env, C65_SYNTHETIC_SECRET: value };
    const options = { cwd: ROOT, env, output: f.output, name: 'redacted' };
    const text = json(f.artifact, f.finish);
    let program = process.execPath, args = ['--input-type=module', '-e', `const v=process.env.C65_SYNTHETIC_SECRET;
      process.stdout.write(v.slice(0,8)); setTimeout(()=>{process.stdout.write(v.slice(8));process.stderr.write(v)},10);`];
    if (kind === 'encoded') args[2] = `const v=process.env.C65_SYNTHETIC_SECRET; console.log(JSON.stringify(v)); console.error(encodeURIComponent(v)); console.error(Buffer.from(v).toString('base64'));`;
    if (kind === 'cargo') { args[2] = `process.stdout.write(process.argv[1]);process.stderr.write(process.env.C65_SYNTHETIC_SECRET)`; args.push(text); }
    if (kind === 'spawn-error') program = join(f.parent, value);
    const start = kind === 'thrown' ? () => { throw Object.assign(Error(value), { code: value }); } : undefined;
    const action = recordPreparationCommand(program, args, options, start);
    // The child can exit zero although its scrubbed argv no longer proves the command.
    await assert.rejects(action, fixedError);
    if (kind === 'cargo') assert.ok(await readFile(join(f.output, 'redacted.stdout'), 'utf8') === text, 'Nonsecret Cargo JSON must remain byte-equal.');
    const redact = preparationRedactor(env);
    for (const name of await readdir(f.output)) {
      const saved = await readFile(join(f.output, name), 'utf8');
      assert.ok(!saved.includes(value) && !saved.includes(JSON.stringify(value).slice(1,-1))
        && !saved.includes(encodeURIComponent(value)) && !saved.includes('C65_SYNTHETIC_SECRET')
        && redact(saved) === saved, 'Only scrubbed diagnostics may be persisted.');
    }
    const facts = await load(join(f.output, 'redacted.command.json'));
    if (!['thrown', 'spawn-error'].includes(kind)) assert.ok(facts.closed && facts.code === 0 && facts.signal === null, 'Admission failure must preserve the successful child terminal facts.');
    assert.ok(facts.stdout_redacted === ['split', 'encoded'].includes(kind), 'Redaction facts must be boolean and bind the retained stdout.');
    assert.ok(facts.sanitized_stdout_sha256 === hash(await readFile(facts.stdout))
      && facts.sanitized_stderr_sha256 === hash(await readFile(facts.stderr)), 'Hashes must bind retained sanitized streams.');
    assert.ok(isDeepStrictEqual(facts.environment.values, Object.fromEntries(['TMPDIR','CARGO_TARGET_DIR','RUSTFLAGS','GIT_OPTIONAL_LOCKS','NODE_OPTIONS','PATH'].map(key => [key, env[key]]))), 'Approved fields must be preserved.');
  });
});

test('actual producer and recorder reject overlapping provenance without persisting the synthetic secret', async t => {
  for (const kind of ['nonoverlap', 'environment', 'program', 'revision', 'source', 'toolchain']) await t.test(kind, () => {
    // Isolate the synthetic sensitive field without changing any approved value.
    const script = `import assert from 'node:assert/strict';
      import {mkdtemp,writeFile,readFile,lstat,readdir,rm} from 'node:fs/promises';
      import {tmpdir} from 'node:os'; import {join} from 'node:path';
      import {createHash} from 'node:crypto'; import {isDeepStrictEqual} from 'node:util';
      import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
      import {prepareBrowserFixture,recordPreparationCommand,preparationRedactor} from './web/test-support/browser-fixture-preparation.mjs';
      import {ROOT,TARGET,CHILD,CARGO_ARGS} from './web/test-support/live-commit-native.mjs';
      const hash = ${hash}, clone = ${clone}, json = ${json}, fixture = ${fixture};
      const kind=process.argv[1], cleanups=[];
      const f=await fixture({after:fn=>cleanups.push(fn)});
      try {
        if(kind==='nonoverlap') process.env.CARGO_BUILD_JOBS='2';
        const keys=['TMPDIR','CARGO_TARGET_DIR','RUSTFLAGS','GIT_OPTIONAL_LOCKS','NODE_OPTIONS','PATH'];
        const values=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
        let value='synthetic-nonoverlap-81973';
        if(kind==='environment') value=['--','cfg'].join('');
        if(kind==='program') value=['car','go'].join('');
        if(kind==='revision') value='a'.repeat(40);
        if(kind==='source') value=f.sources['src/lib.rs'].sha256;
        if(kind==='toolchain') value=['tool','chain'].join('');
        process.env.C65_SYNTHETIC_SECRET=value;
        const redact=preparationRedactor(process.env);
        let resolved=false, fixed=false;
        try { await prepareBrowserFixture({output:f.output},f.io); resolved=true; }
        catch(error) { fixed=error.message==='Browser fixture preparation failed.'; }
        const names=await readdir(f.output);
        const saved=await Promise.all(names.map(name=>readFile(join(f.output,name),'utf8')));
        const safe=saved.every(text=>!text.includes(value)&&redact(text)===text);
        const unchanged=isDeepStrictEqual(values,Object.fromEntries(keys.map(key=>[key,process.env[key]])));
        let exact=false;
        if(kind==='nonoverlap') {
          const records=await Promise.all(['invocation.json',...['revision','worktree','cargo-version','rustc-version','build'].map(n=>n+'.command.json')].map(async name=>JSON.parse(await readFile(join(f.output,name),'utf8'))));
          exact=records.length===6&&records.every(record=>isDeepStrictEqual(record.environment.values,values)&&record.environment.cargo_build_jobs==='2');
        }
        console.log(JSON.stringify({resolved,fixed,safe,unchanged,exact,ready:names.includes('environment.json'),commands:f.state.commands.length}));
      } finally { for(const cleanup of cleanups) await cleanup(); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, kind], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
    assert.ok(child.status === 0 && child.stderr === '', 'Synthetic producer child must finish without scaffold failures.');
    const result = JSON.parse(child.stdout);
    assert.ok(result.safe && result.unchanged, 'Persistence must be scrubbed and approved values must remain unchanged.');
    if (kind === 'nonoverlap') assert.ok(result.resolved && result.ready && result.exact && result.commands === 5, 'All six retained environment records must be exact.');
    else assert.ok(!result.resolved && !result.ready && result.fixed, 'Lost structured provenance must reject with fixed diagnostics before readiness.');
  });
});

test('actual structured recorder keeps JSON tokens typed and removes matched marker data before readiness', async t => {
  for (const kind of ['zero', 'false', 'quote', 'marker', 'nonoverlap', 'long-overlap']) await t.test(kind, () => {
    const script = `import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
      import assert from 'node:assert/strict'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
      import {createHash} from 'node:crypto'; import {isDeepStrictEqual} from 'node:util';
      import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
      import {prepareBrowserFixture,recordPreparationCommand,preparationRedactor} from './web/test-support/browser-fixture-preparation.mjs';
      import {ROOT,TARGET,CHILD,CARGO_ARGS} from './web/test-support/live-commit-native.mjs';
      const hash=${hash}, clone=${clone}, json=${json}, fixture=${fixture};
      const kind=process.argv[1], values={zero:'0',false:'false',quote:String.fromCharCode(34),marker:'[REDACTED]',nonoverlap:'synthetic-M3-nonoverlap-73189','long-overlap':'synthetic-M3-toolchain-57291'};
      const value=values[kind], before={...process.env}, cleanups=[];
      process.env.C65_SYNTHETIC_SECRET=value;
      try {
        const f=await fixture({after:fn=>cleanups.push(fn)}), redact=preparationRedactor(process.env);
        const overlap=!['zero','nonoverlap'].includes(kind);
        f.state.spawnCommand=(text,_program,_args,options)=>{
          const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough();
          if(overlap&&f.state.commands.at(-1).options.name==='cargo-version') text=value+'\\n';
          queueMicrotask(()=>{child.stdout.end(text);child.stderr.end('synthetic payload '+value+'\\n');child.emit('close',0,null)});
          return child;
        };
        let resolved=false,fixed=false;
        try{await prepareBrowserFixture({output:f.output},f.io);resolved=true}catch(error){fixed=error.message==='Browser fixture preparation failed.'}
        const names=await readdir(f.output), receipts=[];
        let parseable=true, safe=true;
        const safeData=v=>typeof v==='string'?redact(v)===v:Array.isArray(v)?v.every(safeData):v&&typeof v==='object'?Object.entries(v).every(([k,x])=>redact(k)===k&&safeData(x)):true;
        for(const name of names){
          const text=await readFile(join(f.output,name),'utf8');
          if(name.endsWith('.json')){
            let record;try{record=JSON.parse(text)}catch{parseable=false;continue}
            safe&&=safeData(record);
            if(name.endsWith('.command.json')) receipts.push(record);
          }else safe&&=redact(text)===text&&!text.includes(value);
        }
        const terminal=receipts.length>0&&receipts.every(v=>v.closed===true&&v.code===0&&v.signal===null&&v.spawn_error===null&&typeof v.stdout_redacted==='boolean');
        const match=overlap?receipts.some(v=>v.stdout_redacted===true):receipts.every(v=>v.stdout_redacted===false);
        const logs=await Promise.all(names.filter(n=>n.endsWith('.stderr')).map(n=>readFile(join(f.output,n),'utf8')));
        const removed=logs.length===receipts.length&&logs.every(v=>v==='synthetic payload \\n')&&redact(value)==='';
        const admission=kind==='nonoverlap'?resolved&&names.includes('environment.json')&&receipts.length===5:!resolved&&fixed&&!names.includes('environment.json');
        let failure=true;
        if(kind!=='nonoverlap')try{const v=JSON.parse(await readFile(join(f.output,'failure.json'),'utf8'));failure=v.ready===false&&typeof v.stage==='string'&&safeData(v)}catch{failure=false}
        const g=await fixture({after:fn=>cleanups.push(fn)});
        g.io.sources=async()=>{throw Object.assign(Error(value),{name:value,code:value})};
        let errorFixed=false;try{await prepareBrowserFixture({output:g.output},g.io)}catch(error){errorFixed=error.message==='Browser fixture preparation failed.'}
        let errorData=false;
        try{const v=JSON.parse(await readFile(join(g.output,'failure.json'),'utf8'));errorData=errorFixed&&v.ready===false&&v.error.name===''&&v.error.code===''&&v.error.message===''}catch{}
        console.log(JSON.stringify({parseable,safe,terminal,match,removed,admission,failure,errorData,environment:isDeepStrictEqual(before,Object.fromEntries(Object.keys(before).map(k=>[k,process.env[k]])))}));
      } finally {for(const cleanup of cleanups.reverse())await cleanup()}`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, kind], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
    assert.ok(child.status === 0 && child.stderr === '', 'Structured synthetic controls must finish without scaffold failures.');
    const result = JSON.parse(child.stdout);
    assert.ok(result.parseable, 'Every structured record must parse as JSON.');
    assert.ok(result.terminal, 'Command terminal facts must remain typed and usable.');
    assert.ok(result.failure && result.errorData, 'Failure JSON must preserve ready=false and scrub error string data.');
    assert.ok(result.safe && result.removed, 'Every recognized match must remove string data without a replacement collision.');
    assert.ok(result.match, 'Stdout redaction facts must detect matched string data.');
    assert.ok(result.admission && result.environment, 'Lost provenance must reject readiness without changing inherited environment.');
  });
});

// Only isolated child processes use these synthetic /proc observations.
async function identityFixture(t, kind) {
  const f = await fixture(t), read = fs.readFile, readlink = fs.readlink, reads = new Map();
  fs.readFile = async (path, ...args) => {
    const match = /^\/proc\/(2147483[0-9]+)\/stat$/.exec(String(path));
    if (!match) return read(path, ...args);
    const pid = Number(match[1]), count = (reads.get(pid) ?? 0) + 1;
    reads.set(pid, count);
    if (kind === 'read_failed') throw Object.assign(Error('synthetic read failure'), { code: 'EACCES' });
    if (kind === 'unavailable' || count > 1) throw Object.assign(Error('synthetic absence'), { code: 'ENOENT' });
    const parts = Array(20).fill('0'); parts[0] = 'S'; parts[1] = String(process.pid); parts[19] = '123456789';
    if (kind === 'invalid-parent') parts[1] = String(process.pid + 1);
    if (kind === 'invalid-ticks') parts[19] = '0';
    return `${pid} (synthetic child) ${parts.join(' ')}`;
  };
  fs.readlink = async path => {
    if (/^\/proc\/2147483[0-9]+\/exe$/.test(String(path))) return kind === 'invalid-executable' ? 'relative' : process.execPath;
    if (/^\/proc\/2147483[0-9]+\/cwd$/.test(String(path))) return kind === 'invalid-cwd' ? '/synthetic/changed' : ROOT;
    return readlink(path);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readFile = read; fs.readlink = readlink; syncBuiltinESMExports(); });
  f.state.spawnCommand = (text, _program, _args, options) => {
    const child = new EventEmitter(); child.pid = 2147483000 + f.state.commands.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    assert.ok(options.cwd === ROOT && options.shell === false, 'Synthetic command context must be exact.');
    queueMicrotask(() => {
      child.emit('spawn'); child.stdout.end(text);
      child.stderr.end('synthetic diagnostic ' + process.env.C65_SYNTHETIC_SECRET);
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  return f;
}

function identityScenario(kind, name = null) {
  const script = `import assert from 'node:assert/strict';
    import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {mkdtemp,mkdir,writeFile,readFile,lstat,readdir,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os'; import {join} from 'node:path';
    import {createHash} from 'node:crypto'; import {isDeepStrictEqual} from 'node:util';
    import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
    import {prepareBrowserFixture,recordPreparationCommand,preparationRedactor} from './web/test-support/browser-fixture-preparation.mjs';
    import {ROOT,TARGET,CHILD,CARGO_ARGS,identityProof} from './web/test-support/live-commit-native.mjs';
    const hash=${hash}, clone=${clone}, json=${json}, fixture=${fixture}, identityFixture=${identityFixture};
    const kind=process.argv[1], name=process.argv[2], keys=['TMPDIR','CARGO_TARGET_DIR','RUSTFLAGS','GIT_OPTIONAL_LOCKS','NODE_OPTIONS','PATH'];
    const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    process.env.C65_SYNTHETIC_SECRET=kind==='collision'?'start_ticks':'synthetic-nonoverlap-identity-91827';
    const mutations={
      'missing-pid':v=>{delete v.pid}, 'malformed-pid':v=>{v.pid='invalid'}, 'changed-pid':v=>{v.pid++},
      'missing-identity':v=>{delete v.identity}, 'null-identity':v=>{v.identity=null},
      'malformed-identity':v=>{v.identity={}}, 'changed-identity-pid':v=>{v.identity.pid++},
      'changed-parent':v=>{v.identity.ppid++}, 'missing-ticks':v=>{delete v.identity.start_ticks},
      'malformed-ticks':v=>{v.identity.start_ticks=''}, 'changed-ticks':v=>{v.identity.start_ticks='987654321'},
      'redacted-key':v=>{v.identity['']=v.identity.start_ticks;delete v.identity.start_ticks},
      'changed-executable':v=>{v.identity.executable='/synthetic/changed'}, 'changed-identity-cwd':v=>{v.identity.cwd='/synthetic/changed'},
      'extra-identity':v=>{v.identity.extra=true}, 'missing-observation':v=>{delete v.identity_observation},
      'malformed-observation':v=>{v.identity_observation={}}, 'changed-observation':v=>{v.identity_observation=v.identity_observation==='read_failed'?'unavailable':'read_failed'},
      'missing-retirement':v=>{delete v.direct_identity_retired}, 'malformed-retirement':v=>{v.direct_identity_retired='true'},
      'false-retirement':v=>{v.direct_identity_retired=false}, 'null-retirement':v=>{v.direct_identity_retired=null},
      'coherent-downgrade':v=>{v.identity=null;v.identity_observation='unavailable';v.direct_identity_retired=null},
      'missing-start':v=>{delete v.started_at}, 'changed-end':v=>{v.ended_at='changed'}, 'extra-receipt':v=>{v.extra=true}
    };
    let selected=Object.keys(mutations);
    if(kind==='unavailable'||kind==='read_failed') selected=['missing-pid','malformed-pid','changed-pid','missing-identity','malformed-identity','missing-observation','malformed-observation','changed-observation','missing-retirement','malformed-retirement','false-retirement','missing-start','changed-end','extra-receipt'];
    const cases=name?selected.flatMap(m=>['boundary','final'].map(when=>({mutation:m,when}))):[{}];
    const results=[];
    for(const c of cases){
      const cleanups=[], f=await identityFixture({after:fn=>cleanups.push(fn)},kind);
      try{
        const mutate=async()=>{const path=join(f.output,name+'.command.json'),v=JSON.parse(await readFile(path,'utf8'));mutations[c.mutation](v);await writeFile(path,JSON.stringify(v));};
        if(name&&c.when==='boundary'){
          const command=f.io.command;
          f.io.command=async(...args)=>{const text=await command(...args);if(args[2].name===name)await mutate();return text};
        }
        if(name&&c.when==='final'){
          const validate=f.io.validate;
          f.io.validate=async value=>{const result=await validate(value);if(f.state.validations===2)await mutate();return result};
        }
        let resolved=false,fixed=false;
        try{await prepareBrowserFixture({output:f.output},f.io);resolved=true}catch(error){fixed=error.message==='Browser fixture preparation failed.'}
        const names=await readdir(f.output),saved=await Promise.all(names.map(n=>readFile(join(f.output,n),'utf8')));
        const redact=preparationRedactor(process.env),safe=saved.every(text=>!text.includes(process.env.C65_SYNTHETIC_SECRET)&&redact(text)===text);
        const receipts=await Promise.all(names.filter(n=>n.endsWith('.command.json')).map(n=>readFile(join(f.output,n),'utf8').then(JSON.parse)));
        const exact=receipts.every(v=>isDeepStrictEqual(v.environment.values,before));
        let usable=0,unknown=0;
        for(const v of receipts){
          try{identityProof(v.identity,v.pid,process.execPath,ROOT);if(v.identity_observation==='observed'&&v.direct_identity_retired===true)usable++}catch{}
          if(v.identity===null&&v.direct_identity_retired===null&&v.identity_observation===kind)unknown++;
        }
        let pass=!resolved&&fixed&&!names.includes('environment.json');
        if(!name&&kind!=='collision'&&!kind.startsWith('invalid-')) pass=resolved&&names.includes('environment.json')&&receipts.length===5&&(kind==='observed'?usable===5:unknown===5);
        results.push({pass,safe,exact,unchanged:isDeepStrictEqual(before,Object.fromEntries(keys.map(k=>[k,process.env[k]]))),receipts:receipts.length,usable,unknown});
      }finally{for(const cleanup of cleanups.reverse())await cleanup()}
    }
    console.log(JSON.stringify({cases:results.length,passed:results.filter(r=>r.pass).length,safe:results.every(r=>r.safe&&r.exact&&r.unchanged),synthetic:true}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, kind, ...(name ? [name] : [])], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
  assert.ok(child.status === 0 && child.stderr === '', 'Isolated synthetic identity controls must finish without scaffold failures.');
  return JSON.parse(child.stdout);
}

test('actual producer and recorder qualify observed colliding and unknown synthetic identities', async t => {
  for (const kind of ['observed', 'collision', 'unavailable', 'read_failed', 'invalid-parent', 'invalid-ticks', 'invalid-executable', 'invalid-cwd']) await t.test(kind, () => {
    const result = identityScenario(kind);
    assert.ok(result.synthetic && result.safe && result.cases === 1, 'Synthetic identity records must be safe with exact approved values.');
    assert.ok(result.passed === result.cases, 'Only usable observed identities or explicitly unknown identities may authorize readiness.');
  });
});

test('complete captured command provenance rejects identity and qualification edits at command return and final admission', async t => {
  for (const name of ['revision', 'worktree', 'cargo-version', 'rustc-version', 'build']) await t.test(name, () => {
    const result = identityScenario('observed', name);
    assert.ok(result.synthetic && result.safe && result.cases === 52, 'Every mutation must retain safe diagnostics and unchanged approved values.');
    assert.ok(result.passed === result.cases, 'Every saved provenance mutation must reject before readiness.');
  });
});

test('unknown identity qualifications and complete captured receipts also resist later edits', async t => {
  for (const kind of ['unavailable', 'read_failed']) await t.test(kind, () => {
    const result = identityScenario(kind, 'build');
    assert.ok(result.synthetic && result.safe && result.cases === 28, 'Unknown-identity controls must retain safe exact records.');
    assert.ok(result.passed === result.cases, 'Unknown identity must not allow later qualification or receipt edits.');
  });
});

test('final admission rereads critical retained invocation command and build records', async t => {
  const mutations = {
    environment: value => { value.environment.values.RUSTFLAGS = '[REDACTED]'; },
    jobs: value => { value.environment.cargo_build_jobs = 'changed'; },
    'missing-field': value => { delete value.environment.values.PATH; },
    program: value => { value.program = 'changed'; },
    argv: value => { value.argv = []; },
    cwd: value => { value.cwd = '/synthetic/changed'; },
    terminal: value => { value.code = 7; },
    redacted: value => { value.stdout_redacted = true; },
    stdout: value => { value.sanitized_stdout_sha256 = '0'.repeat(64); },
  };
  for (const name of ['invocation.json', ...['revision', 'worktree', 'cargo-version', 'rustc-version', 'build'].map(n => `${n}.command.json`)]) {
    const kinds = ['missing', 'partial', 'malformed', 'environment', 'jobs', 'missing-field'];
    if (name === 'invocation.json') kinds.push('command', 'revision', 'lock', 'toolchain');
    else kinds.push('program', 'argv', 'cwd', 'terminal', 'stdout', 'redacted');
    for (const kind of kinds) await t.test(`${name}:${kind}`, async t => {
      const f = await fixture(t), validate = f.io.validate;
      f.io.validate = async value => {
        const result = await validate(value);
        if (f.state.validations === 2) {
          const path = join(f.output, name);
          if (kind === 'missing') await rm(path);
          else if (kind === 'partial') await writeFile(path, '{partial');
          else if (kind === 'malformed') await writeFile(path, 'null');
          else {
            const saved = await load(path);
            if (kind === 'command') saved.command.argv = [];
            else if (kind === 'revision') saved.revision = 'b'.repeat(40);
            else if (kind === 'lock') saved.cargo_lock = {};
            else if (kind === 'toolchain') saved.toolchain.cargo = 'changed';
            else mutations[kind](saved);
            await writeFile(path, JSON.stringify(saved));
          }
        }
        return result;
      };
      await fails(f);
      assert.ok(f.state.validations === 2 && (await load(join(f.output, 'failure.json'))).stage === 'final_revalidation', 'The saved record must reject at final admission.');
    });
  }
  for (const name of ['ownership.json', 'sources-before.json', 'sources-after.json', 'preparation.json', 'cargo.jsonl', 'build.stdout', 'build.stderr']) await t.test(name, async t => {
    const f = await fixture(t), validate = f.io.validate;
    f.io.validate = async value => {
      const result = await validate(value);
      if (f.state.validations === 2) await writeFile(join(f.output, name), '{}');
      return result;
    };
    await fails(f);
    assert.ok((await load(join(f.output, 'failure.json'))).stage === 'final_revalidation', 'Retained build and source provenance must be reread.');
  });
});

test('producer scrubs failure records and CLI errors with synthetic fixture-child environment isolation', async t => {
  const f = await fixture(t), value = 'synthetic/quote"line\n雪-diagnostic-3287';
  const script = `import {prepareBrowserFixture} from './web/test-support/browser-fixture-preparation.mjs';
    import {run} from './web/scripts/prepare-browser-fixture.mjs';
    const status=await run(['--output',process.argv[1]], options=>prepareBrowserFixture(options,{sources:async()=>{throw Object.assign(Error(process.env.C65_SYNTHETIC_SECRET),{code:process.env.C65_SYNTHETIC_SECRET})}}));
    process.exitCode=status;`;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',script,f.output], {
    cwd: ROOT, env: { ...process.env, C65_SYNTHETIC_SECRET: value }, encoding: 'utf8',
  });
  assert.ok(result.status === 1 && result.stdout === '' && result.stderr === 'browser_fixture_preparation: preparation failed; owned partial records are retained.\n', 'Child must fail with fixed CLI diagnostics.');
  const failure = await load(join(f.output, 'failure.json'));
  assert.ok(failure.stage === 'source_before' && failure.error.message === '' && failure.error.code === '', 'Failure metadata must be scrubbed before writing.');
  await absent(join(f.output, 'environment.json'));
});
