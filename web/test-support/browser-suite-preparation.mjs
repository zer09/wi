import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prepareBrowserFixture, recordPreparationCommand, preparationRedactor, sanitizeRecord } from './browser-fixture-preparation.mjs';
import { ROOT, TARGET, CARGO_ARGS, CHILD, nativeSources, bindCargoArtifact, nativeBinding, identityProof } from './live-commit-native.mjs';
import { CHILD_TEST } from './fixture.mjs';
import { outerProof, allocationProgress, allocationProof, prepareInvocation, resolveBinding } from './live-commit-measurements.mjs';

const reject = () => { throw Error('Browser suite preparation failed.'); };
const same = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const six = ['TMPDIR', 'CARGO_TARGET_DIR', 'RUSTFLAGS', 'GIT_OPTIONAL_LOCKS', 'NODE_OPTIONS', 'PATH'];
const four = ['WI_C3A_FIXTURE', 'WI_C3A_FIXTURE_SHA256', 'WI_C47_FIXTURE_SHA256', 'WI_C54_NATIVE_BINDING'];
const ownedKeys = [...four, 'WI_BROWSER_FIXTURE_PARENT', 'WI_C52_EVIDENCE', 'WI_C54_ALLOCATION_PARENT', 'WI_C54_OUTER_MARKER'];
const commands = [
  ['revision', 'git', ['rev-parse', 'HEAD']],
  ['worktree', 'git', ['status', '--porcelain=v1', '--untracked-files=all']],
  ['cargo-version', 'cargo', ['--version', '--verbose']],
  ['rustc-version', 'rustc', ['--version', '--verbose']],
  ['build', 'cargo', [...CARGO_ARGS]],
];
const environment = env => ({ values: Object.fromEntries(six.map(key => [key, env[key]])), cargo_build_jobs: env.CARGO_BUILD_JOBS ?? null });
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const identity = (path, s) => ({ path, uid: s.uid, mode: s.mode & 0o7777, device: s.dev, inode: s.ino });

export async function browserSuiteManifest(sourceRoot = ROOT, io = fs) {
  const files = [], directories = [];
  async function visit(relative) {
    const path = join(sourceRoot, relative), s = await io.lstat(path);
    if (s.isSymbolicLink() || await io.realpath(path) !== path) reject();
    if (['web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json'].includes(relative) && !s.isFile()) reject();
    if (['web/e2e', 'web/test-support', 'web/scripts'].includes(relative) && !s.isDirectory()) reject();
    const facts = { path: relative, type: s.isDirectory() ? 'directory' : 'file', mode: s.mode & 0o7777,
      device: s.dev, inode: s.ino };
    if (s.isDirectory()) {
      directories.push(facts);
      for (const name of (await io.readdir(path)).sort()) await visit(join(relative, name));
    } else {
      if (!s.isFile() || s.nlink !== 1) reject();
      const bytes = await io.readFile(path), after = await io.lstat(path);
      if (after.ino !== s.ino || after.dev !== s.dev || after.mode !== s.mode || after.nlink !== 1 || after.size !== bytes.length) reject();
      files.push({ ...facts, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  for (const name of ['web/e2e', 'web/test-support', 'web/scripts', 'web/playwright.config.mjs', 'web/package.json', 'web/package-lock.json']) await visit(name);
  return { files, directories };
}

export async function prepareBrowserSuite({ output }, overrides = {}) {
  // Seams keep offline controls on owned synthetic files, without a native build.
  const io = { ...fs, ...overrides.io };
  const env = { ...(overrides.env ?? process.env) }, initialEnv = { ...env };
  const sourceRoot = overrides.sourceRoot ?? ROOT;
  const sources = overrides.sources ?? nativeSources;
  const validate = overrides.validate ?? nativeBinding;
  const produce = overrides.prepare ?? prepareBrowserFixture;
  const command = overrides.command ?? recordPreparationCommand;
  const redact = preparationRedactor(env);
  const required = value => { same(sanitizeRecord(value, redact), value); return value; };
  const write = async (path, value) => {
    const text = json(required(value));
    await io.writeFile(path, text, { mode: 0o600, flag: 'wx' });
    return text;
  };
  const absent = async path => {
    try { await io.lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    reject();
  };
  const directory = async path => { await outerProof(path, io); return identity(path, await io.lstat(path)); };
  const file = async (path, links = 1) => {
    const s = await io.lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o600
      || s.nlink !== links || await io.realpath(path) !== path) reject();
    const bytes = await io.readFile(path);
    const after = await io.lstat(path);
    same(identity(path, after), identity(path, s));
    if (after.size !== bytes.length || after.nlink !== links) reject();
    return { ...identity(path, s), type: 'file', bytes: bytes.length, sha256: hash(bytes) };
  };
  const load = async path => { await file(path); return JSON.parse(await io.readFile(path, 'utf8')); };
  const manifest = async () => required(await browserSuiteManifest(sourceRoot, io));
  let created = false, stage = 'entry';
  try {
    if (!process.versions.node.startsWith('24.') || env.CARGO_TARGET_DIR !== join(ROOT, 'target') || TARGET !== env.CARGO_TARGET_DIR
      || ownedKeys.some(key => env[key] !== undefined)
      || typeof output !== 'string' || !output.isWellFormed() || output.includes('\0') || !isAbsolute(output)
      || resolve(output) !== output || output === '/') reject();
    if ([ROOT, TARGET, sourceRoot].some(path => overlaps(output, path))) reject();
    required({ output, environment: environment(env), node: process.execPath });
    const parent = await directory(dirname(output));
    await io.mkdir(output, { mode: 0o700 }); created = true;
    const root = await directory(output);
    const artifact = join(output, 'artifact'), retained = join(output, 'retained'), control = join(output, 'control');
    await io.mkdir(retained, { mode: 0o700 }); await io.mkdir(control, { mode: 0o700 });
    const base = await directory(retained), controlIdentity = await directory(control);
    const planned = { c52: join(output, 'c52-evidence'), playwright: join(output, 'playwright-output'),
      guard: join(control, 'execution-guard.json'), outer: join(control, 'c54-outer.json') };
    const final = join(control, 'suite-ready.json'), pending = join(control, 'suite-ready.pending.json');
    stage = 'source';
    const before = await manifest(), nativeBefore = structuredClone(await sources());
    if (!nativeBefore['Cargo.lock']) reject();
    const captured = [], originals = new Map();
    let capturedBinding;
    const captureCommand = async (program, argv, options) => {
      const expected = commands[captured.length];
      if (!expected) reject();
      same([options.name, program, argv], expected);
      same(environment(options.env), environment(env));
      same(options.cwd, ROOT); same(options.output, artifact);
      const text = await command(program, argv, options);
      const facts = await load(join(artifact, `${options.name}.command.json`));
      for (const [key, value] of Object.entries({ program, argv, cwd: ROOT, environment: environment(env),
        stdout: join(artifact, `${options.name}.stdout`), stderr: join(artifact, `${options.name}.stderr`),
        spawn_error: null, closed: true, code: 0, signal: null, stdout_redacted: false,
        log_boundary: 'sanitized streams only; raw streams remained in memory' })) same(facts[key], value);
      if (facts.identity_observation === 'observed') {
        identityProof(facts.identity, facts.pid, facts.identity?.executable, ROOT);
        if (facts.direct_identity_retired !== true) reject();
      } else if (!['unavailable', 'read_failed'].includes(facts.identity_observation) || facts.identity !== null
        || facts.direct_identity_retired !== null || facts.identity_observation === 'read_failed' && facts.pid === null) reject();
      const stdout = await io.readFile(facts.stdout), stderr = await io.readFile(facts.stderr);
      same(stdout.toString('utf8'), text);
      same([facts.sanitized_stdout_bytes, facts.sanitized_stdout_sha256], [stdout.length, hash(stdout)]);
      same([facts.sanitized_stderr_bytes, facts.sanitized_stderr_sha256], [stderr.length, hash(stderr)]);
      required(facts); required(text);
      captured.push(structuredClone({ name: options.name, text, facts }));
      return text;
    };
    stage = 'producer';
    const map = await produce({ output: artifact }, { sources, command: captureCommand,
      bind: async (...args) => {
        const value = await (overrides.bind ?? bindCargoArtifact)(...args);
        capturedBinding = structuredClone(required(value));
        return value;
      }, validate,
      write: async (path, bytes) => {
        // C65 uses its own scrubber too. Reject any additional suite-level collision before writing.
        if (path.endsWith('.json')) return write(path, JSON.parse(bytes));
        required(bytes);
        return io.writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      } });
    same(captured.map(c => c.name), commands.map(c => c[0]));
    same(Object.keys(map).sort(), [...four].sort());
    const artifactIdentity = await directory(artifact);
    const bindingPath = join(artifact, 'native-binding.json');
    same(map.WI_C54_NATIVE_BINDING, bindingPath);
    // C65 publishes exactly one intentional hard-link pair; no other aliases are admitted.
    const readyStat = await io.lstat(join(artifact, 'environment.json'));
    const pendingStat = await io.lstat(join(artifact, 'environment.pending.json'));
    if (readyStat.dev !== pendingStat.dev || readyStat.ino !== pendingStat.ino) reject();
    const recordNames = ['ownership.json', 'sources-before.json', 'sources-after.json', 'invocation.json', 'native-binding.json',
      'environment.pending.json', 'environment.json', 'preparation.json', 'cargo.jsonl',
      ...commands.flatMap(([name]) => [`${name}.command.json`, `${name}.stdout`, `${name}.stderr`])].sort();
    same((await io.readdir(artifact)).sort(), recordNames);
    const pins = [];
    for (const name of recordNames) {
      const path = join(artifact, name), links = name.startsWith('environment.') ? 2 : 1;
      pins.push(await file(path, links));
      const bytes = await io.readFile(path);
      required(bytes.toString('utf8'));
      originals.set(path, bytes);
    }
    const record = name => JSON.parse(originals.get(join(artifact, name)).toString('utf8'));
    const text = name => originals.get(join(artifact, name)).toString('utf8');
    const native = required(record('native-binding.json'));
    same(native, capturedBinding);
    same(await validate(native), native);
    same(native.sources, nativeBefore);
    same(record('sources-before.json'), nativeBefore); same(record('sources-after.json'), nativeBefore);
    same(map, { WI_C3A_FIXTURE: native.executable, WI_C3A_FIXTURE_SHA256: native.sha256,
      WI_C47_FIXTURE_SHA256: native.sha256, WI_C54_NATIVE_BINDING: bindingPath });
    same(record('environment.json'), map); same(record('environment.pending.json'), map);
    const ownership = { output: artifact, parent: output, uid: artifactIdentity.uid, mode: artifactIdentity.mode,
      device: artifactIdentity.device, inode: artifactIdentity.inode };
    same(record('ownership.json'), ownership);
    const [revision, worktree, cargo, rustc, build] = captured;
    if (!/^[a-f0-9]{40}$/.test(revision.text.trim())) reject();
    same(record('invocation.json'), { revision: revision.text.trim(), worktree: worktree.text, cargo_lock: nativeBefore['Cargo.lock'],
      node: process.versions.node, platform: process.platform, architecture: process.arch,
      toolchain: { cargo: cargo.text, rustc: rustc.text }, command: { program: 'cargo', argv: CARGO_ARGS, cwd: ROOT },
      environment: environment(env), selectors: { ordinary: CHILD_TEST, live_commit: CHILD, observed_in_executable: false } });
    same(record('preparation.json'), { scope: 'current-artifact preparation only', revision: revision.text.trim(), worktree: worktree.text,
      cargo_lock: nativeBefore['Cargo.lock'], ownership, executable: native.executable, sha256: native.sha256,
      ready_environment: join(artifact, 'environment.json'), publication: 'environment.json exists only after final revalidation',
      full_readiness: false, allocation: 'not prepared', suite_output: 'not prepared', ci: 'not wired', selector_execution: false, product_test_execution: false });
    same(text('cargo.jsonl'), build.text); same(native.cargo_json, build.text);
    for (const c of captured) {
      same(record(`${c.name}.command.json`), c.facts); same(text(`${c.name}.stdout`), c.text);
    }
    stage = 'readiness';
    const invocationEnv = { ...env, ...map, WI_BROWSER_FIXTURE_PARENT: retained };
    const progress = allocationProgress();
    const controlRecords = new Map();
    const readiness = async () => {
      same(env, initialEnv);
      same(await directory(dirname(output)), parent); same(await directory(output), root);
      same(await directory(retained), base); same(await directory(control), controlIdentity);
      same(await directory(artifact), artifactIdentity);
      // Pinned records do not reveal newly added directory entries.
      same((await io.readdir(artifact)).sort(), recordNames);
      same(await manifest(), before); same(await sources(), nativeBefore); same(await validate(native), native);
      for (let i = 0; i < recordNames.length; i++) {
        const name = recordNames[i], path = join(artifact, name);
        same(await file(path, name.startsWith('environment.') ? 2 : 1), pins[i]);
        same(await io.readFile(path), originals.get(path));
      }
      same(invocationEnv, { ...env, ...map, WI_BROWSER_FIXTURE_PARENT: retained });
      for (const path of Object.values(planned)) await absent(path);
      await absent(final);
      if (progress.identity) {
        await allocationProof(progress.identity, retained, io);
        same(await io.readdir(progress.identity.path), []);
        same((await io.readdir(retained)).sort(), [progress.identity.path.slice(retained.length + 1)]);
      } else same(await io.readdir(retained), []);
      for (const [path, expected] of controlRecords) {
        await file(path); same(await io.readFile(path, 'utf8'), expected);
      }
      same((await io.readdir(control)).sort(), [...controlRecords.keys()].map(path => path.slice(control.length + 1)).sort());
      same((await io.readdir(output)).sort(), ['artifact', 'control', 'retained']);
    };
    return await prepareInvocation({ env: invocationEnv, excluded: [artifact, control, planned.c52, planned.playwright], progress, readiness,
      consume: async ({ binding, progress: actual }) => {
        same(binding, native); same(actual, progress);
        stage = 'publication';
        const child = await allocationProof(actual.identity, retained, io);
        const childEnvironment = required({ ...map, WI_BROWSER_FIXTURE_PARENT: retained, WI_C52_EVIDENCE: planned.c52,
          WI_C54_ALLOCATION_PARENT: JSON.stringify(child), WI_C54_OUTER_MARKER: planned.outer });
        same(Object.keys(childEnvironment).sort(), [...ownedKeys].sort());
        const sourcePath = join(control, 'runtime-sources.json');
        controlRecords.set(sourcePath, await write(sourcePath, before));
        const provenancePath = join(control, 'producer-records.json');
        controlRecords.set(provenancePath, await write(provenancePath, { native_sources: nativeBefore, records: pins,
          invocation: record('invocation.json'), commands: captured.map(c => c.facts) }));
        const bundle = required({ version: 1, scope: 'browser suite preparation only', launch: 'pending', full_readiness: false,
          preparation_cutoff: 'revalidate all inputs before a separately authorized one-use launch', browser_executions: 0, case_markers: 0,
          identities: { parent, root, artifact: artifactIdentity, control: controlIdentity, retained: base, child },
          environment: childEnvironment, approved_environment: environment(env), planned,
          sources: { path: sourcePath, sha256: hash(controlRecords.get(sourcePath)), manifest: before },
          producer: { path: provenancePath, sha256: hash(controlRecords.get(provenancePath)), records: pins, binding: native },
          future_command: { program: process.execPath, argv: ['--', join(ROOT, 'web/node_modules/@playwright/test/cli.js'), 'test',
            `--config=${join(ROOT, 'web/playwright.config.mjs')}`, '--output', planned.playwright], cwd: ROOT },
          outer_content: { consumed: true }, execution_guard_reserved: false });
        const serialized = await write(pending, bundle);
        controlRecords.set(pending, serialized);
        // Include the pending bundle in the readback, not just the records it refers to.
        await readiness();
        same(JSON.parse(await io.readFile(pending, 'utf8')), bundle);
        await io.link(pending, final);
        // Nothing fallible follows publication. Partials and the empty child are never deleted here.
        return final;
      } }, io, value => resolveBinding(value, io, validate));
  } catch {
    if (created) {
      try { await write(join(output, 'suite-failure.json'), { stage, ready: false, launch: 'pending' }); }
      catch { /* A failed diagnostic must not replace the first preparation failure. */ }
    }
    reject();
  }
}
