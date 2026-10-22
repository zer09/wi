import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { browserSuiteManifest, browserSuiteProvenance } from './browser-suite-preparation.mjs';
import { browserEnvironment } from './browser-pin.mjs';
import { recordPreparationCommand, preparationRedactor, sanitizeRecord } from './browser-fixture-preparation.mjs';
import { ROOT, TARGET, CARGO_ARGS, CHILD, nativeSources, nativeBinding, identityProof, artifactFromCargo, processIdentity } from './live-commit-native.mjs';
import { CHILD_TEST, artifactFromCargo as ordinaryArtifact } from './fixture.mjs';
import { outerProof, allocationProof } from './live-commit-measurements.mjs';

const reject = () => { const error = Error('Browser suite launch failed.'); error.code = 'SUITE_REJECTED'; throw error; };
const same = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const six = ['TMPDIR', 'CARGO_TARGET_DIR', 'RUSTFLAGS', 'GIT_OPTIONAL_LOCKS', 'NODE_OPTIONS', 'PATH'];
const ownedKeys = ['WI_C3A_FIXTURE', 'WI_C3A_FIXTURE_SHA256', 'WI_C47_FIXTURE_SHA256', 'WI_C54_NATIVE_BINDING',
  'WI_BROWSER_FIXTURE_PARENT', 'WI_C52_EVIDENCE', 'WI_C54_ALLOCATION_PARENT', 'WI_C54_OUTER_MARKER'];
const commands = [['revision', 'git', ['rev-parse', 'HEAD']], ['worktree', 'git', ['status', '--porcelain=v1', '--untracked-files=all']],
  ['cargo-version', 'cargo', ['--version', '--verbose']], ['rustc-version', 'rustc', ['--version', '--verbose']], ['build', 'cargo', [...CARGO_ARGS]]];
const recordNames = ['ownership.json', 'sources-before.json', 'sources-after.json', 'invocation.json', 'native-binding.json',
  'environment.pending.json', 'environment.json', 'preparation.json', 'cargo.jsonl',
  ...commands.flatMap(([name]) => [`${name}.command.json`, `${name}.stdout`, `${name}.stderr`])].sort();
const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const environment = env => ({ values: Object.fromEntries(six.map(key => [key, env[key]])), cargo_build_jobs: env.CARGO_BUILD_JOBS ?? null });
const pathProof = path => typeof path === 'string' && path.isWellFormed() && !path.includes('\0') && isAbsolute(path) && resolve(path) === path;
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const identity = (path, s) => ({ path, uid: s.uid, mode: s.mode & 0o7777, device: s.dev, inode: s.ino });
const positive = n => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff;
const timestamp = text => typeof text === 'string' && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text;

export async function launchBrowserSuite({ bundle }, overrides = {}) {
  // Offline controls replace only filesystem/native observations and the direct child transport.
  const io = { ...fs, ...overrides.io }, env = { ...(overrides.env ?? process.env) };
  const sourceRoot = overrides.sourceRoot ?? ROOT, sources = overrides.sources ?? nativeSources;
  const validate = overrides.validate ?? nativeBinding, start = overrides.spawn ?? spawn, bus = overrides.signals ?? process;
  const redact = preparationRedactor(env);
  const required = value => { same(sanitizeRecord(value, redact), value); return value; };
  const outcome = { scope: 'one-use suite launch observation only', consumed: false, first_failure: null,
    child: { spawned: false, closed: false, code: null, signal: null, error_observed: false,
      pid: null, identity: null, identity_observation: 'unavailable' },
    signals: { received: 0, forwarded: 0, not_forwarded: 0, failures: 0, first: null, order: [] },
    markers: Object.fromEntries(['C52', 'C53', 'C54', 'C57', 'C61'].map(name => [name, { status: 'unavailable', count: null, paths: [] }])),
    marker_meaning: 'reservation only', browser_executions: null, test_counts: null };
  let stage = 'admission', child, stopped = false, guardOwned = false, control, prepared, recheck, receiptOK = false;
  let guardPin, outerPin;
  const launchPins = new Map();
  const fail = () => { outcome.first_failure ??= stage; };
  const listeners = signalNames.map(signal => {
    const receive = () => {
      stopped = true;
      const s = outcome.signals; s.received++; s.first ??= signal;
      let action = 'not_forwarded';
      if (child && outcome.child.spawned && !outcome.child.closed && child.exitCode === null && child.signalCode === null) {
        try { if (child.kill(signal)) { s.forwarded++; action = 'forwarded'; } else { s.failures++; fail(); action = 'failure'; } }
        catch { s.failures++; fail(); action = 'failure'; }
      } else s.not_forwarded++;
      s.order.push({ signal, action });
    };
    bus.on(signal, receive); return [signal, receive];
  });
  const absent = async path => {
    try { await io.lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    reject();
  };
  const directory = async path => { await outerProof(path, io); return identity(path, await io.lstat(path)); };
  const file = async (path, links = 1) => {
    const s = await io.lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o600
      || s.nlink !== links || await io.realpath(path) !== path) reject();
    const bytes = await io.readFile(path), after = await io.lstat(path);
    same(identity(path, s), identity(path, after));
    if (after.nlink !== links || after.size !== bytes.length || !isUtf8(bytes)) reject();
    return { bytes, pin: { ...identity(path, s), type: 'file', bytes: bytes.length, sha256: hash(bytes) } };
  };
  const exclusive = async (path, value, acquired = () => {}) => {
    const bytes = json(required(value)), handle = await io.open(path, 'wx', 0o600);
    acquired();
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    const loaded = await file(path); same(loaded.bytes.toString('utf8'), bytes); return loaded;
  };
  let childListeners = [], childIdentity = Promise.resolve();
  try {
    if (!process.versions.node.startsWith('24.') || env.CARGO_TARGET_DIR !== join(ROOT, 'target') || TARGET !== env.CARGO_TARGET_DIR
      || ownedKeys.some(key => env[key] !== undefined) || !pathProof(bundle) || basename(bundle) !== 'suite-ready.json'
      || basename(dirname(bundle)) !== 'control') reject();
    if (six.some(key => typeof env[key] !== 'string' || !env[key].isWellFormed() || env[key].includes('\0'))
      || !isAbsolute(env.TMPDIR) || env.GIT_OPTIONAL_LOCKS !== '0' || env.NODE_OPTIONS !== ''
      || !env.PATH.split(':').every(p => p !== '' && isAbsolute(p))) reject();
    control = dirname(bundle);
    const root = dirname(control), parent = dirname(root), artifact = join(root, 'artifact'), retained = join(root, 'retained');
    if ([ROOT, TARGET, sourceRoot].some(path => overlaps(root, path))) reject();
    const browser = required(await browserSuiteProvenance(env, io, overrides.browserIO));
    if (overlaps(root, browser.admission.root)) reject();
    const planned = { c52: join(root, 'c52-evidence'), playwright: join(root, 'playwright-output'),
      guard: join(control, 'execution-guard.json'), outer: join(control, 'c54-outer.json') };
    const pending = join(control, 'suite-ready.pending.json');
    const sourcePath = join(control, 'runtime-sources.json'), provenancePath = join(control, 'producer-records.json');
    const finalFile = await file(bundle, 2), pendingFile = await file(pending, 2);
    same(finalFile.pin, { ...pendingFile.pin, path: bundle }); same(finalFile.bytes, pendingFile.bytes);
    prepared = required(JSON.parse(finalFile.bytes.toString('utf8')));
    const identities = { parent: await directory(parent), root: await directory(root), artifact: await directory(artifact),
      control: await directory(control), retained: await directory(retained), child: prepared.identities?.child };
    await allocationProof(identities.child, retained, io);
    const native = required(prepared.producer?.binding);
    same(Object.keys(native).sort(), ['executable', 'sha256', 'selector', 'sources', 'cargo_json'].sort());
    if (native.selector !== CHILD || native.executable !== artifactFromCargo(native.cargo_json)
      || native.executable !== ordinaryArtifact(native.cargo_json) || !/^[a-f0-9]{64}$/.test(native.sha256)) reject();
    const nativeBefore = required(await sources());
    if (!nativeBefore['Cargo.lock']) reject();
    same(native.sources, nativeBefore); same(await validate(native), native);
    const manifest = required(await browserSuiteManifest(sourceRoot, io));
    const sourceFile = await file(sourcePath), provenanceFile = await file(provenancePath);
    same(JSON.parse(sourceFile.bytes.toString('utf8')), manifest);
    const pins = [], originals = new Map();
    same((await io.readdir(artifact)).sort(), recordNames);
    for (const name of recordNames) {
      const loaded = await file(join(artifact, name), name.startsWith('environment.') ? 2 : 1);
      pins.push(loaded.pin); required(loaded.bytes.toString('utf8')); originals.set(name, loaded);
    }
    same(originals.get('environment.json').pin, { ...originals.get('environment.pending.json').pin, path: join(artifact, 'environment.json') });
    const record = name => JSON.parse(originals.get(name).bytes.toString('utf8'));
    const text = name => originals.get(name).bytes.toString('utf8');
    const map = { WI_C3A_FIXTURE: native.executable, WI_C3A_FIXTURE_SHA256: native.sha256, WI_C47_FIXTURE_SHA256: native.sha256,
      WI_C54_NATIVE_BINDING: join(artifact, 'native-binding.json') };
    const captured = [];
    for (const [name, program, argv] of commands) {
      const f = record(`${name}.command.json`), stdout = originals.get(`${name}.stdout`).bytes, stderr = originals.get(`${name}.stderr`).bytes;
      if (!timestamp(f.started_at) || !timestamp(f.ended_at) || f.ended_at < f.started_at || f.pid !== null && !positive(f.pid)) reject();
      if (f.identity_observation === 'observed') {
        if (!pathProof(f.identity?.executable) || !positive(f.identity?.ppid)) reject();
        // This is a historical preparation receipt, not a child of this launcher or present signal authority.
        identityProof(f.identity, f.pid, f.identity.executable, ROOT, f.identity.ppid);
        same(f.direct_identity_retired, true);
      } else if (!['unavailable', 'read_failed'].includes(f.identity_observation) || f.identity !== null
        || f.direct_identity_retired !== null || f.identity_observation === 'read_failed' && f.pid === null) reject();
      same(f, { program, argv, cwd: ROOT, environment: environment(env), started_at: f.started_at, pid: f.pid, identity: f.identity,
        identity_observation: f.identity_observation, spawn_error: null, closed: true, code: 0, signal: null,
        stdout: join(artifact, `${name}.stdout`), stderr: join(artifact, `${name}.stderr`), ended_at: f.ended_at,
        direct_identity_retired: f.direct_identity_retired, stdout_redacted: false, log_boundary: 'sanitized streams only; raw streams remained in memory',
        sanitized_stdout_bytes: stdout.length, sanitized_stdout_sha256: hash(stdout), sanitized_stderr_bytes: stderr.length, sanitized_stderr_sha256: hash(stderr) });
      captured.push(f);
    }
    const revision = text('revision.stdout').trim(), worktree = text('worktree.stdout'), build = text('build.stdout');
    if (!/^[a-f0-9]{40}$/.test(revision)) reject();
    const invocation = { revision, worktree, cargo_lock: nativeBefore['Cargo.lock'], node: process.versions.node, platform: process.platform,
      architecture: process.arch, toolchain: { cargo: text('cargo-version.stdout'), rustc: text('rustc-version.stdout') },
      command: { program: 'cargo', argv: CARGO_ARGS, cwd: ROOT }, environment: environment(env),
      selectors: { ordinary: CHILD_TEST, live_commit: CHILD, observed_in_executable: false } };
    const ownership = { output: artifact, parent: root, uid: identities.artifact.uid, mode: identities.artifact.mode,
      device: identities.artifact.device, inode: identities.artifact.inode };
    same(record('native-binding.json'), native); same(record('sources-before.json'), nativeBefore); same(record('sources-after.json'), nativeBefore);
    same(record('ownership.json'), ownership); same(record('invocation.json'), invocation);
    same(record('environment.json'), map); same(record('environment.pending.json'), map); same(text('cargo.jsonl'), build); same(native.cargo_json, build);
    same(record('preparation.json'), { scope: 'current-artifact preparation only', revision, worktree, cargo_lock: nativeBefore['Cargo.lock'], ownership,
      executable: native.executable, sha256: native.sha256, ready_environment: join(artifact, 'environment.json'),
      publication: 'environment.json exists only after final revalidation', full_readiness: false, allocation: 'not prepared', suite_output: 'not prepared',
      ci: 'not wired', selector_execution: false, product_test_execution: false });
    same(JSON.parse(provenanceFile.bytes.toString('utf8')), { native_sources: nativeBefore, records: pins, invocation, commands: captured });
    const childEnvironment = { ...map, WI_BROWSER_FIXTURE_PARENT: retained, WI_C52_EVIDENCE: planned.c52,
      WI_C54_ALLOCATION_PARENT: JSON.stringify(identities.child), WI_C54_OUTER_MARKER: planned.outer };
    const futureCommand = { program: process.execPath, argv: ['--', join(ROOT, 'web/node_modules/@playwright/test/cli.js'), 'test',
      `--config=${join(ROOT, 'web/playwright.config.mjs')}`, '--output', planned.playwright], cwd: ROOT };
    same(prepared, { version: 1, scope: 'browser suite preparation only', launch: 'pending', full_readiness: false,
      preparation_cutoff: 'revalidate all inputs before a separately authorized one-use launch', browser_executions: 0, case_markers: 0,
      identities, browser, environment: childEnvironment, approved_environment: environment(env), planned,
      sources: { path: sourcePath, sha256: hash(sourceFile.bytes), manifest },
      producer: { path: provenancePath, sha256: hash(provenanceFile.bytes), records: pins, binding: native }, future_command: futureCommand,
      outer_content: { consumed: true }, execution_guard_reserved: false });
    const baseControls = ['suite-ready.json', 'suite-ready.pending.json', 'runtime-sources.json', 'producer-records.json'];
    const controls = new Map([[bundle, finalFile], [pending, pendingFile], [sourcePath, sourceFile], [provenancePath, provenanceFile]]);
    recheck = async (runtime = false) => {
      for (const key of ['parent', 'root', 'artifact', 'control', 'retained']) same(await directory(identities[key].path), identities[key]);
      same(await browserSuiteManifest(sourceRoot, io), manifest); same(await sources(), nativeBefore); same(await validate(native), native);
      same((await io.readdir(artifact)).sort(), recordNames);
      for (const [name, original] of originals) {
        const current = await file(join(artifact, name), name.startsWith('environment.') ? 2 : 1);
        same(current, original);
      }
      for (const [path, original] of controls) same(await file(path, path === bundle || path === pending ? 2 : 1), original);
      const names = [...baseControls];
      if (guardPin) { same(await file(planned.guard), guardPin); names.push('execution-guard.json'); }
      else await absent(planned.guard);
      if (outerPin) { same(await file(planned.outer), outerPin); names.push('c54-outer.json'); }
      else await absent(planned.outer);
      if (runtime) {
        for (const [path, original] of launchPins) same(await file(path), original);
        // C54 can remove its child normally. Do not enter retained native fixtures after dispatch.
        names.push('launch.stdout', 'launch.stderr', 'launch.command.json');
        const actual = (await io.readdir(control)).sort();
        if (actual.some(name => !names.includes(name))) reject();
        const entries = await io.readdir(root);
        if (entries.some(name => !['artifact', 'control', 'retained', 'c52-evidence', 'playwright-output'].includes(name))) reject();
      } else {
        same((await io.readdir(control)).sort(), names.sort());
        same((await io.readdir(root)).sort(), ['artifact', 'control', 'retained']);
        await allocationProof(identities.child, retained, io); same(await io.readdir(identities.child.path), []);
        same(await io.readdir(retained), [basename(identities.child.path)]);
        await absent(planned.c52); await absent(planned.playwright);
      }
      // Check the browser last so native and control readbacks cannot hide a late swap.
      browserEnvironment(overrides.env ?? process.env);
      same((overrides.env ?? process.env).WI_BROWSER_BINDING, browser.admission.binding);
      same(required(await browserSuiteProvenance(env, io, overrides.browserIO)), browser);
    };
    await recheck();
    stage = 'guard';
    guardPin = await exclusive(planned.guard, { version: 1, consumed: true, meaning: 'reservation only', bundle_sha256: hash(finalFile.bytes),
      identities, command: futureCommand, environment: childEnvironment, approved_environment: environment(env) }, () => { guardOwned = true; outcome.consumed = true; });
    stage = 'guard_recheck'; await recheck();
    stage = 'outer'; outerPin = await exclusive(planned.outer, { consumed: true });
    stage = 'dispatch_recheck'; await recheck();
    if (stopped) { stage = 'stop_before_dispatch'; reject(); }
    stage = 'child';
    let launchText;
    try {
      launchText = await recordPreparationCommand(futureCommand.program, futureCommand.argv, { cwd: ROOT, env: { ...env, ...childEnvironment, WI_BROWSER_BINDING: browser.admission.binding }, output: control, name: 'launch' },
        (program, argv, options) => {
          // No await between the final stop latch and this single direct dispatch.
          if (stopped) reject();
          child = start(program, argv, options);
          const onSpawn = () => {
            outcome.child.spawned = true;
            if (positive(child.pid)) {
              outcome.child.pid = child.pid;
              childIdentity = processIdentity(child.pid).then(value => {
                outcome.child.identity = value;
                if (value) outcome.child.identity_observation = 'observed';
              }).catch(() => { outcome.child.identity_observation = 'read_failed'; });
            }
          };
          const onError = () => { outcome.child.error_observed = true; fail(); };
          const onClose = (code, signal) => {
            outcome.child.closed = true;
            outcome.child.code = Number.isSafeInteger(code) && code >= 0 ? code : null;
            outcome.child.signal = typeof signal === 'string' ? signal : null;
          };
          child.once('spawn', onSpawn); child.on('error', onError); child.once('close', onClose);
          childListeners = [['spawn', onSpawn], ['error', onError], ['close', onClose]];
          return child;
        });
      receiptOK = true;
    } catch { fail(); }
    await childIdentity;
    stage = 'launch_receipt';
    if (receiptOK) {
      for (const name of ['launch.stdout', 'launch.stderr', 'launch.command.json']) {
        const path = join(control, name); launchPins.set(path, await file(path));
      }
      const stdout = launchPins.get(join(control, 'launch.stdout')).bytes;
      const stderr = launchPins.get(join(control, 'launch.stderr')).bytes;
      const facts = required(JSON.parse(launchPins.get(join(control, 'launch.command.json')).bytes.toString('utf8')));
      for (const [key, value] of Object.entries({ program: futureCommand.program, argv: futureCommand.argv, cwd: ROOT,
        environment: environment(env), closed: outcome.child.closed, code: outcome.child.code, signal: outcome.child.signal, spawn_error: null,
        stdout: join(control, 'launch.stdout'), stderr: join(control, 'launch.stderr'),
        log_boundary: 'sanitized streams only; raw streams remained in memory',
        sanitized_stdout_bytes: stdout.length, sanitized_stdout_sha256: hash(stdout),
        sanitized_stderr_bytes: stderr.length, sanitized_stderr_sha256: hash(stderr) })) same(facts[key], value);
      same(stdout.toString('utf8'), launchText);
    }
    stage = 'post_readback'; await recheck(true);
    stage = 'markers';
    outcome.markers = await observeMarkers(planned, io);
    if (Object.values(outcome.markers).some(v => ['unavailable', 'rejected'].includes(v.status))) reject();
    stage = 'final_readback'; await recheck(true);
  } catch { fail(); }
  finally {
    for (const [signal, listener] of listeners) bus.removeListener(signal, listener);
    for (const [event, listener] of childListeners) child.removeListener(event, listener);
  }
  const terminal = () => {
    if (outcome.child.closed && outcome.child.signal !== null) return { code: null, signal: outcome.child.signal };
    if (outcome.child.closed && outcome.child.code !== null && outcome.child.code !== 0) return { code: outcome.child.code, signal: null };
    return { code: outcome.child.spawned && outcome.child.closed && outcome.child.code === 0 && receiptOK && !outcome.first_failure ? 0 : 1, signal: null };
  };
  if (guardOwned) {
    stage = 'outcome_record';
    try { await io.writeFile(join(control, 'launch-outcome.json'), json(required({ ...outcome, terminal: terminal() })), { mode: 0o600, flag: 'wx' }); }
    catch { fail(); }
  }
  return { ...terminal(), outcome };
}

async function observeMarkers(planned, io) {
  const observations = Object.fromEntries(['C52', 'C53', 'C54', 'C57', 'C61'].map(name => [name, { status: 'absent', count: 0, paths: [] }]));
  const metadata = async path => {
    const s = await io.lstat(path);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || await io.realpath(path) !== path || !s.isDirectory() && !s.isFile()) reject();
    return s;
  };
  const observe = async (path, family) => {
    const o = observations[family]; o.paths.push(path); o.count++;
    try {
      const before = await metadata(path);
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600) reject();
      const bytes = await io.readFile(path), after = await metadata(path);
      if (!isUtf8(bytes) || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
        || after.nlink !== 1 || after.size !== bytes.length) reject();
      const text = bytes.toString('utf8');
      if (family === 'C57' || family === 'C61') same(text, `${family} fresh case\n`);
      else same(JSON.parse(text), { consumed: true });
      if (o.status === 'absent') o.status = 'observed';
    } catch (error) { o.status = error.code === 'SUITE_REJECTED' || error instanceof SyntaxError ? 'rejected' : 'unavailable'; }
  };
  try {
    let s;
    try { s = await metadata(planned.c52); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (s) {
      if (!s.isDirectory()) reject();
      const p = join(planned.c52, 'C52.once.json');
      try { await io.lstat(p); await observe(p, 'C52'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { observations.C52.status = error.code === 'SUITE_REJECTED' ? 'rejected' : 'unavailable'; }
  async function visit(path) {
    const leaf = basename(path), parent = basename(dirname(path));
    let family;
    if (leaf === 'C53.once.json' && parent === 'c53-evidence') family = 'C53';
    if (leaf === 'C54.once.json' && parent === 'c54-evidence') family = 'C54';
    if (leaf === 'CASE.once' && parent === 'c57') family = 'C57';
    if (leaf === 'CASE.once' && parent === 'c61') family = 'C61';
    if (family) await observe(path, family);
    else if ((await metadata(path)).isDirectory()) for (const name of (await io.readdir(path)).sort()) await visit(join(path, name));
  }
  try {
    try { await io.lstat(planned.playwright); } catch (error) { if (error.code === 'ENOENT') return observations; throw error; }
    if (!(await metadata(planned.playwright)).isDirectory()) reject();
    await visit(planned.playwright);
  } catch (error) {
    for (const family of ['C53', 'C54', 'C57', 'C61']) if (observations[family].status !== 'rejected') {
      observations[family].status = error.code === 'SUITE_REJECTED' ? 'rejected' : 'unavailable';
    }
  }
  return observations;
}
