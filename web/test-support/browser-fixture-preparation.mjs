import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath, mkdir, link } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual, inspect } from 'node:util';
import { artifactFromCargo as ordinaryArtifact, CHILD_TEST } from './fixture.mjs';
import { ROOT, TARGET, CARGO_ARGS, CHILD, artifactFromCargo as liveArtifact,
  nativeSources, bindCargoArtifact, nativeBinding, processIdentity, identityProof } from './live-commit-native.mjs';

const rejected = () => { throw Error('Browser fixture preparation failed.'); };
const same = (a, b) => { if (!isDeepStrictEqual(a, b)) rejected(); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const environmentKeys = ['TMPDIR', 'CARGO_TARGET_DIR', 'RUSTFLAGS', 'GIT_OPTIONAL_LOCKS', 'NODE_OPTIONS', 'PATH'];
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
// Keep the original receipt in memory, not in a file that may already be scrubbed or edited.
const commandReceipts = new WeakMap();

// Record only the approved environment fields, not unrelated inherited secrets.
function effectiveEnvironment(env) {
  const values = Object.fromEntries(environmentKeys.map(key => [key, env[key]]));
  return { values, cargo_build_jobs: env.CARGO_BUILD_JOBS ?? null };
}

// This is a diagnostic scrubber, not a sandbox or a universal secret detector.
export function preparationRedactor(env) {
  const replacements = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (environmentKeys.includes(key) || !/token|secret|password|passwd|cookie|credential|auth|(?:^|[_-])(?:key|pass)(?:$|[_-])|private.*key|api.*key|access.*key/i.test(key)) continue;
    for (const text of [key, value]) {
      if (typeof text !== 'string' || text === '') continue;
      const escaped = JSON.stringify(text).slice(1, -1);
      replacements.add(text); replacements.add(escaped); replacements.add(escaped.replaceAll('/', '\\/'));
      replacements.add(inspect(text, { colors: false }).slice(1, -1));
      if (text.isWellFormed()) { replacements.add(encodeURIComponent(text)); replacements.add(encodeURI(text)); }
      replacements.add(Buffer.from(text).toString('base64')); replacements.add(Buffer.from(text).toString('base64url'));
      const unicode = Array.from({ length: text.length }, (_, i) => '\\u' + text.charCodeAt(i).toString(16).padStart(4, '0')).join('');
      replacements.add(unicode); replacements.add(unicode.toUpperCase().replaceAll('\\U', '\\u'));
    }
  }
  const ordered = [...replacements].sort((a, b) => b.length - a.length);
  const pattern = ordered.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const matches = pattern ? new RegExp(pattern, 'g') : null;
  // Deletion can join fragments into another match. Each changing pass shortens the string.
  return text => {
    let value = String(text);
    if (!matches) return value;
    for (;;) {
      const next = value.replace(matches, '');
      if (next === value) return value;
      value = next;
    }
  };
}

function sanitizeRecord(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitizeRecord(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [redact(key), sanitizeRecord(item, redact)]));
  // JSON punctuation and typed terminal facts are not private string payloads.
  return value;
}

function commandIdentity(facts) {
  if (facts.pid !== null && (!Number.isSafeInteger(facts.pid) || facts.pid <= 0 || facts.pid > 0xffffffff)) rejected();
  if (facts.identity_observation === 'observed') {
    const identity = facts.identity;
    if (typeof identity?.executable !== 'string' || !isAbsolute(identity.executable)
      || !identity.executable.isWellFormed() || identity.executable.includes('\0')) rejected();
    identityProof(identity, facts.pid, identity.executable, facts.cwd);
    if (facts.direct_identity_retired !== true) rejected();
  } else {
    if (!['unavailable', 'read_failed'].includes(facts.identity_observation) || facts.identity !== null
      || facts.direct_identity_retired !== null || (facts.identity_observation === 'read_failed' && facts.pid === null)) rejected();
  }
}

export async function recordPreparationCommand(program, args, options, spawnCommand = spawn) {
  const { cwd, env, output, name } = options;
  const redact = preparationRedactor(env);
  const stdoutPath = join(output, `${name}.stdout`), stderrPath = join(output, `${name}.stderr`);
  const stdout = [], stderr = [];
  const facts = { program, argv: [...args], cwd, environment: effectiveEnvironment(env),
    started_at: new Date().toISOString(), pid: null, identity: null, identity_observation: 'unavailable',
    spawn_error: null, closed: false, code: null, signal: null, stdout: stdoutPath, stderr: stderrPath };
  await new Promise(resolveCommand => {
    let child;
    try { child = spawnCommand(program, args, { cwd, env: { ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { facts.spawn_error = { code: error.code ?? null, message: error.message }; resolveCommand(); return; }
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    let identity = Promise.resolve();
    child.once('spawn', () => {
      facts.pid = child.pid;
      identity = processIdentity(child.pid).then(value => {
        facts.identity = value;
        if (value) facts.identity_observation = 'observed';
      }).catch(() => { facts.identity_observation = 'read_failed'; });
    });
    child.on('error', error => { facts.spawn_error ??= { code: error.code ?? null, message: error.message }; });
    child.once('close', async (code, signal) => {
      facts.closed = true; facts.code = code; facts.signal = signal;
      await identity;
      resolveCommand();
    });
  });
  facts.ended_at = new Date().toISOString();
  facts.direct_identity_retired = null;
  if (facts.identity) {
    const current = await processIdentity(facts.pid);
    facts.direct_identity_retired = current === null || current.start_ticks !== facts.identity.start_ticks;
  }
  // Join chunks before scrubbing so a value split across pipe reads cannot escape.
  const stdoutBytes = Buffer.from(redact(Buffer.concat(stdout).toString('utf8')));
  const stderrBytes = Buffer.from(redact(Buffer.concat(stderr).toString('utf8')));
  // Scrubbed stdout is safe to retain, but cannot prove exact build or toolchain input.
  facts.stdout_redacted = stdoutBytes.toString('utf8') !== Buffer.concat(stdout).toString('utf8');
  facts.log_boundary = 'sanitized streams only; raw streams remained in memory';
  facts.sanitized_stdout_bytes = stdoutBytes.length; facts.sanitized_stdout_sha256 = hash(stdoutBytes);
  facts.sanitized_stderr_bytes = stderrBytes.length; facts.sanitized_stderr_sha256 = hash(stderrBytes);
  await privateWrite(stdoutPath, stdoutBytes);
  await privateWrite(stderrPath, stderrBytes);
  const sanitized = sanitizeRecord(facts, redact);
  await privateWrite(join(output, `${name}.command.json`), json(sanitized));
  // Safe failed receipts stay available, but scrubbed provenance cannot authorize success.
  if (!isDeepStrictEqual(sanitized, facts) || facts.spawn_error || !facts.closed || facts.code !== 0 || facts.signal !== null) rejected();
  commandReceipts.set(options, structuredClone(facts));
  return stdoutBytes.toString('utf8');
}

export async function prepareBrowserFixture({ output }, overrides = {}) {
  // These seams let offline controls exercise failures without running a Cargo build.
  const io = { sources: nativeSources, bind: bindCargoArtifact, validate: nativeBinding,
    command: recordPreparationCommand, write: privateWrite, lstat, ...overrides };
  const env = { ...process.env }, redact = preparationRedactor(env);
  // Scrub string data before serialization so failed receipts remain valid JSON.
  const writeText = (path, text) => io.write(path, redact(text));
  const writeRecord = (path, value) => io.write(path, json(sanitizeRecord(value, redact)));
  let owned = false, stage = 'destination';
  try {
    if (!process.versions.node.startsWith('24.') || env.CARGO_TARGET_DIR !== join(ROOT, 'target') || TARGET !== env.CARGO_TARGET_DIR
      || typeof output !== 'string' || !output.isWellFormed() || output.includes('\0') || !isAbsolute(output)
      || resolve(output) !== output || basename(output) === '' || output === '/') rejected();
    const parent = dirname(output), parentInfo = await io.lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o7777) !== 0o700
      || parentInfo.uid !== process.getuid() || await realpath(parent) !== parent) rejected();
    // No recursive creation, deletion or adoption. An occupied path always rejects.
    await mkdir(output, { mode: 0o700 }); owned = true;
    const info = await io.lstat(output);
    if ((info.mode & 0o7777) !== 0o700 || info.uid !== process.getuid() || await realpath(output) !== output) rejected();
    const ownership = { output, parent, uid: info.uid, mode: info.mode & 0o7777, device: info.dev, inode: info.ino };
    const records = new Map(), commands = [];
    const write = (name, value) => {
      records.set(name, structuredClone(value));
      return writeRecord(join(output, name), value);
    };
    await write('ownership.json', ownership);
    stage = 'source_before';
    const before = structuredClone(await io.sources());
    if (!before['Cargo.lock']) rejected();
    await write('sources-before.json', before);
    const command = async (name, program, args) => {
      const options = { cwd: ROOT, env: { ...env }, output, name };
      const text = redact(await io.command(program, args, options));
      const facts = commandReceipts.get(options);
      commandReceipts.delete(options);
      if (!facts) rejected();
      for (const [key, value] of Object.entries({ program, argv: [...args], cwd: ROOT, environment: effectiveEnvironment(env),
        stdout: join(output, `${name}.stdout`), stderr: join(output, `${name}.stderr`),
        spawn_error: null, closed: true, code: 0, signal: null, stdout_redacted: false,
        log_boundary: 'sanitized streams only; raw streams remained in memory' })) same(facts[key], value);
      commandIdentity(facts);
      commands.push({ name, text, facts });
      return text;
    };
    stage = 'metadata';
    const revision = (await command('revision', 'git', ['rev-parse', 'HEAD'])).trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) rejected();
    const worktree = await command('worktree', 'git', ['status', '--porcelain=v1', '--untracked-files=all']);
    const cargoVersion = await command('cargo-version', 'cargo', ['--version', '--verbose']);
    const rustcVersion = await command('rustc-version', 'rustc', ['--version', '--verbose']);
    await write('invocation.json', { revision, worktree, cargo_lock: before['Cargo.lock'],
      node: process.versions.node, platform: process.platform, architecture: process.arch,
      toolchain: { cargo: cargoVersion, rustc: rustcVersion }, command: { program: 'cargo', argv: CARGO_ARGS, cwd: ROOT },
      environment: effectiveEnvironment(env), selectors: { ordinary: CHILD_TEST, live_commit: CHILD, observed_in_executable: false } });
    stage = 'build';
    const cargoJson = await command('build', 'cargo', [...CARGO_ARGS]);
    await writeText(join(output, 'cargo.jsonl'), cargoJson);
    stage = 'source_after';
    const after = await io.sources();
    await write('sources-after.json', after);
    same(before, after);
    stage = 'artifact';
    const executable = ordinaryArtifact(cargoJson);
    if (liveArtifact(cargoJson) !== executable || CHILD_TEST === CHILD) rejected();
    const binding = await io.bind(cargoJson, before);
    same(Object.keys(binding).sort(), ['executable', 'sha256', 'selector', 'sources', 'cargo_json'].sort());
    if (binding.executable !== executable || binding.selector !== CHILD || !/^[a-f0-9]{64}$/.test(binding.sha256)
      || binding.cargo_json !== cargoJson) rejected();
    same(binding.sources, before);
    same(await io.validate(binding), binding);
    const bindingPath = join(output, 'native-binding.json');
    await write('native-binding.json', binding);
    const environment = { WI_C3A_FIXTURE: executable, WI_C3A_FIXTURE_SHA256: binding.sha256,
      WI_C47_FIXTURE_SHA256: binding.sha256, WI_C54_NATIVE_BINDING: bindingPath };
    // Only the final link publishes readiness. A partial write cannot leave a ready map.
    await write('environment.pending.json', environment);
    await write('preparation.json', { scope: 'current-artifact preparation only', revision, worktree,
      cargo_lock: before['Cargo.lock'], ownership, executable, sha256: binding.sha256,
      ready_environment: join(output, 'environment.json'), publication: 'environment.json exists only after final revalidation',
      full_readiness: false, allocation: 'not prepared', suite_output: 'not prepared', ci: 'not wired',
      selector_execution: false, product_test_execution: false });
    stage = 'final_revalidation';
    same(JSON.parse(await readFile(bindingPath, 'utf8')), binding);
    same(JSON.parse(await readFile(join(output, 'environment.pending.json'), 'utf8')), environment);
    same(await io.validate(binding), binding);
    same(await io.sources(), before);
    // Scrubbing must never turn required provenance into a successful, inexact receipt.
    for (const [name, value] of records) same(JSON.parse(await readFile(join(output, name), 'utf8')), value);
    same(await readFile(join(output, 'cargo.jsonl'), 'utf8'), cargoJson);
    for (const { name, text, facts: captured } of commands) {
      const facts = JSON.parse(await readFile(join(output, `${name}.command.json`), 'utf8'));
      same(facts, captured);
      commandIdentity(facts);
      const stdoutPath = join(output, `${name}.stdout`), stderrPath = join(output, `${name}.stderr`);
      const stdout = await readFile(stdoutPath), stderr = await readFile(stderrPath);
      same(stdout.toString('utf8'), text);
      same(facts.sanitized_stdout_bytes, stdout.length); same(facts.sanitized_stdout_sha256, hash(stdout));
      same(facts.sanitized_stderr_bytes, stderr.length); same(facts.sanitized_stderr_sha256, hash(stderr));
    }
    const finalInfo = await io.lstat(output);
    if (finalInfo.dev !== info.dev || finalInfo.ino !== info.ino || finalInfo.uid !== info.uid
      || (finalInfo.mode & 0o7777) !== 0o700 || await realpath(output) !== output) rejected();
    stage = 'publication';
    await link(join(output, 'environment.pending.json'), join(output, 'environment.json'));
    return environment;
  } catch (error) {
    if (owned) {
      try { await writeRecord(join(output, 'failure.json'), { stage, error: { name: error?.name ?? null, code: error?.code ?? null, message: error?.message ?? null }, ready: false }); }
      catch { /* Preserve the first failure even when its private record cannot be written. */ }
    }
    rejected();
  }
}
