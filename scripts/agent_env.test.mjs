import test from 'node:test';
import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { EventEmitter, once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './agent_env.mjs';

const launcher = fileURLToPath(new URL('./agent_env.mjs', import.meta.url));
const keys = ['TMPDIR', 'CARGO_TARGET_DIR', 'RUSTFLAGS', 'GIT_OPTIONAL_LOCKS', 'NODE_OPTIONS', 'PATH'];
const secret = 'SYNTHETIC_SECRET_SENTINEL';
const pathSentinel = 'SYNTHETIC_PATH_SENTINEL';
const messages = {
  invocation: 'agent_env: rejected before execution: invalid invocation.\n',
  environment: 'agent_env: rejected before execution: invalid approved environment.\n',
  launch: 'agent_env: rejected before execution: command could not start.\n',
  control: 'agent_env: failure after child start: process control failed.\n',
  unknown: 'agent_env: execution state unknown: process control failed.\n',
};

function fixture(t) {
  assert.ok(isAbsolute(process.env.TMPDIR));
  const root = mkdtempSync(join(process.env.TMPDIR, 'wi-agent-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, `${pathSentinel}.json`);
  const marker = join(root, 'child-starts');
  const probe = join(root, 'probe.mjs');
  const approved = {
    TMPDIR: root,
    CARGO_TARGET_DIR: join(root, 'target with spaces'),
    RUSTFLAGS: '--cfg synthetic_delegate --cfg "words with spaces"',
    GIT_OPTIONAL_LOCKS: '0',
    NODE_OPTIONS: '',
    PATH: `${join(root, 'bin with spaces')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  writeFileSync(envFile, JSON.stringify(approved));
  writeFileSync(probe, `
import fs from 'node:fs';
const marker = ${JSON.stringify(marker)};
fs.appendFileSync(marker, 'started\\n');
const mode = process.argv[2];
if (mode === 'probe') {
  fs.writeFileSync(${JSON.stringify(envFile)}, 'changed after child start');
  console.log(JSON.stringify({ env: Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k]])),
    fixture: process.env.WI_AGENT_ENV_FIXTURE, taskFixture: process.env.WI_TASK_FIXTURE,
    argv: process.argv.slice(3), cwd: process.cwd() }));
  process.stderr.write('synthetic child stderr\\n');
} else if (mode === 'exit') process.exit(Number(process.argv[3]));
else if (mode === 'self-signal') process.kill(process.pid, process.argv[3]);
else {
  const signal = process.argv[3];
  const handler = () => {
    fs.appendFileSync(marker, signal + '\\n');
    if (mode === 'handled') process.exit(0);
    process.removeListener(signal, handler);
    process.kill(process.pid, signal);
  };
  process.on(signal, handler);
  console.log(JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1000);
}
`);
  return { root, envFile, marker, probe, approved };
}

function args(f, mode = 'probe', rest = []) {
  // The target is also Node: protect the probe's literal arguments from its CLI parser.
  return ['--env-file', f.envFile, '--', process.execPath, '--', f.probe, mode, ...rest];
}
function inherited() {
  return { ...process.env, NODE_OPTIONS: '', WI_AGENT_ENV_FIXTURE: 'synthetic inherited fixture',
    WI_TASK_FIXTURE: 'synthetic task fixture', RUSTFLAGS: 'inherited poison', GIT_OPTIONAL_LOCKS: '1' };
}
function launch(f, argv = args(f)) {
  return spawnSync(process.execPath, ['--', launcher, ...argv], {
    cwd: f.root, env: inherited(), encoding: 'utf8', shell: false,
  });
}
function rejected(f, argv, kind) {
  const before = readdirSync(f.root).sort();
  const result = launch(f, argv);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, messages[kind]);
  assert.ok(Buffer.byteLength(result.stderr) <= 100);
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes(pathSentinel));
  assert.ok(!result.stderr.includes(f.root));
  assert.ok(!existsSync(f.marker));
  assert.deepEqual(readdirSync(f.root).sort(), before);
}

test('preserves all six values, PATH order, fixture variables, literal argv, cwd and inherited stdio exactly once', t => {
  const f = fixture(t);
  const shellEffect = join(f.root, 'shell-effect');
  writeFileSync(join(f.root, 'glob-match'), 'synthetic');
  const literal = ['two words', '', '$WI_TASK_FIXTURE', '*', '; echo unwanted',
    `$(touch "${shellEffect}")`, '"quoted"', '--env-file', '--'];
  const result = launch(f, args(f, 'probe', literal));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, 'synthetic child stderr\n');
  const seen = JSON.parse(result.stdout);
  assert.deepEqual(seen.env, f.approved);
  assert.equal(seen.fixture, 'synthetic inherited fixture');
  assert.equal(seen.taskFixture, 'synthetic task fixture');
  assert.deepEqual(seen.argv, literal);
  assert.equal(seen.cwd, f.root);
  assert.equal(readFileSync(f.marker, 'utf8'), 'started\n');
  assert.equal(readFileSync(f.envFile, 'utf8'), 'changed after child start');
  assert.ok(!existsSync(shellEffect));
  assert.ok(!existsSync(f.approved.CARGO_TARGET_DIR));
});

for (const code of [0, 2, 17]) {
  test(`preserves child exit ${code} without retry; status alone does not prove rejection`, t => {
    const f = fixture(t);
    const result = launch(f, args(f, 'exit', [String(code)]));
    assert.equal(result.status, code);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(f.marker, 'utf8'), 'started\n');
  });
}

test('preserves child-initiated signal termination', t => {
  const f = fixture(t);
  const result = launch(f, args(f, 'self-signal', ['SIGTERM']));
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(f.marker, 'utf8'), 'started\n');
});

async function signalCase(t, signal, mode) {
  let wrapper, closed, childPid, finished = false, stderr = '';
  t.after(async () => {
    if (wrapper && !finished) {
      // These PIDs belong only to this test's synthetic processes.
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      wrapper.kill('SIGKILL');
      await closed;
    }
  });
  const f = fixture(t);
  wrapper = spawn(process.execPath, ['--', launcher, ...args(f, mode, [signal])], {
    cwd: f.root, env: inherited(), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  wrapper.stderr.setEncoding('utf8');
  wrapper.stderr.on('data', chunk => { stderr += chunk; });
  closed = once(wrapper, 'close');
  closed.then(() => { finished = true; });
  let ready = '';
  await new Promise((resolve, reject) => {
    wrapper.on('error', reject);
    wrapper.on('close', () => { if (!ready.includes('\n')) reject(new Error('synthetic child did not start')); });
    wrapper.stdout.setEncoding('utf8');
    wrapper.stdout.on('data', chunk => {
      ready += chunk;
      if (ready.includes('\n')) {
        childPid = JSON.parse(ready.trim()).pid;
        resolve();
      }
    });
  });
  assert.equal(wrapper.kill(signal), true);
  const [code, terminalSignal] = await closed;
  assert.equal(stderr, '');
  if (mode === 'handled') {
    assert.equal(code, 0);
    assert.equal(terminalSignal, null);
  } else {
    assert.equal(code, null);
    assert.equal(terminalSignal, signal);
  }
  assert.equal(readFileSync(f.marker, 'utf8'), `started\n${signal}\n`);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`forwards ${signal} to the direct child and preserves its termination`, { timeout: 10000 }, t => signalCase(t, signal, 'wait'));
}
test('a child can handle a forwarded signal and exit successfully', { timeout: 10000 }, t => signalCase(t, 'SIGTERM', 'handled'));

const invalid = [
  ['malformed JSON', () => `{ ${secret} ${'x'.repeat(50000)}`],
  ['null object', () => 'null'],
  ['array object', () => '[]'],
  ['string object', () => JSON.stringify(secret)],
  ['number object', () => '1'],
  ['boolean object', () => 'true'],
  ['extra own key', v => JSON.stringify({ ...v, [secret]: secret })],
  ['prototype key', v => JSON.stringify({ ...v, ['__proto__']: secret })],
  ['relative TMPDIR', v => JSON.stringify({ ...v, TMPDIR: secret })],
  ['empty TMPDIR', v => JSON.stringify({ ...v, TMPDIR: '' })],
  ['relative target', v => JSON.stringify({ ...v, CARGO_TARGET_DIR: secret })],
  ['empty target', v => JSON.stringify({ ...v, CARGO_TARGET_DIR: '' })],
  ['empty PATH', v => JSON.stringify({ ...v, PATH: '' })],
  ['relative PATH component', v => JSON.stringify({ ...v, PATH: `/synthetic:${secret}` })],
  ['leading empty PATH component', v => JSON.stringify({ ...v, PATH: ':/synthetic' })],
  ['trailing empty PATH component', v => JSON.stringify({ ...v, PATH: '/synthetic:' })],
  ['middle empty PATH component', v => JSON.stringify({ ...v, PATH: '/synthetic::/other' })],
  ['unsafe Node options', v => JSON.stringify({ ...v, NODE_OPTIONS: `--require=${secret}` })],
  ['nonempty whitespace Node options', v => JSON.stringify({ ...v, NODE_OPTIONS: ' ' })],
  ['unsafe Git locks', v => JSON.stringify({ ...v, GIT_OPTIONAL_LOCKS: '1' })],
  ['empty Git locks', v => JSON.stringify({ ...v, GIT_OPTIONAL_LOCKS: '' })],
];
for (const key of keys) {
  invalid.push([`missing ${key}`, v => { const copy = { ...v }; delete copy[key]; return JSON.stringify(copy); }]);
  invalid.push([`nonstring ${key}`, v => JSON.stringify({ ...v, [key]: 0 })]);
  invalid.push([`NUL in ${key}`, v => JSON.stringify({ ...v, [key]: `${secret}\0` })]);
}
for (const [name, content] of invalid) {
  test(`rejects ${name} before child effects with fixed safe diagnostics`, t => {
    const f = fixture(t);
    writeFileSync(f.envFile, content(f.approved));
    rejected(f, args(f, 'probe', [secret]), 'environment');
  });
}

for (const key of ['RUSTFLAGS', 'TMPDIR', 'CARGO_TARGET_DIR', 'PATH']) {
  for (const [name, sequence] of [
    ['byte FF', [0xff]],
    ['invalid multibyte', [0xc3, 0x28]],
    ['truncated multibyte', [0xe2, 0x82]],
  ]) {
    test(`rejects UTF-8 ${name} in ${key} before child effects`, t => {
      const f = fixture(t);
      const json = Buffer.from(JSON.stringify({ ...f.approved, [key]: `${f.approved[key]}${secret}` }));
      const offset = json.indexOf(secret);
      assert.ok(offset >= 0);
      const bytes = Buffer.concat([json.subarray(0, offset), Buffer.from(sequence), json.subarray(offset)]);
      assert.equal(isUtf8(bytes), false);
      writeFileSync(f.envFile, bytes);
      rejected(f, args(f, 'probe', [secret]), 'environment');
      assert.deepEqual(readFileSync(f.envFile), bytes);
    });
  }
}

for (const key of ['RUSTFLAGS', 'TMPDIR', 'CARGO_TARGET_DIR', 'PATH']) {
  for (const [name, sequence] of [
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
    ['high-high surrogates', '\ud800\ud800'],
    ['low-high surrogates', '\udc00\ud800'],
  ]) {
    test(`rejects escaped UTF-16 ${name} in ${key} before child effects`, t => {
      const f = fixture(t);
      const values = { ...f.approved, [key]: `${f.approved[key]}${sequence}${secret}` };
      const bytes = Buffer.from(JSON.stringify(values));
      assert.equal(isUtf8(bytes), true);
      assert.ok(bytes.includes(Buffer.from(JSON.stringify(sequence).slice(1, -1))));
      assert.deepEqual(JSON.parse(bytes.toString('utf8')), values);
      assert.equal(values[key].isWellFormed(), false);
      writeFileSync(f.envFile, bytes);
      rejected(f, args(f, 'probe', [secret]), 'environment');
      assert.deepEqual(readFileSync(f.envFile), bytes);
    });
  }
}

test('preserves escaped surrogate pairs as Unicode in all four values exactly', t => {
  const f = fixture(t);
  const unicode = '\ud83d\ude42';
  f.approved.TMPDIR += `/${unicode}`;
  f.approved.CARGO_TARGET_DIR += `/${unicode}`;
  f.approved.RUSTFLAGS += ` ${unicode} `;
  const directory = join(f.root, unicode);
  f.approved.PATH = `${directory}:${f.approved.PATH}:${directory}`;
  const json = JSON.stringify(f.approved).replaceAll(unicode, '\\ud83d\\ude42');
  assert.ok(json.includes('\\ud83d\\ude42'));
  assert.ok(!json.includes(unicode));
  const bytes = Buffer.from(json);
  assert.equal(isUtf8(bytes), true);
  assert.deepEqual(JSON.parse(json), f.approved);
  writeFileSync(f.envFile, bytes);
  const result = launch(f);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, 'synthetic child stderr\n');
  assert.deepEqual(JSON.parse(result.stdout).env, f.approved);
  assert.equal(readFileSync(f.marker, 'utf8'), 'started\n');
  assert.equal(readFileSync(f.envFile, 'utf8'), 'changed after child start');
});

test('preserves UTF-8 multibyte Unicode and literal U+FFFD exactly', t => {
  const f = fixture(t);
  const unicode = 'é日本🙂e\u0301\uFFFD';
  f.approved.TMPDIR += `/${unicode}`;
  f.approved.CARGO_TARGET_DIR += `/${unicode}`;
  f.approved.RUSTFLAGS += ` ${unicode}`;
  const directory = join(f.root, unicode);
  f.approved.PATH = `${directory}:${f.approved.PATH}:${directory}`;
  const bytes = Buffer.from(JSON.stringify(f.approved));
  assert.equal(isUtf8(bytes), true);
  writeFileSync(f.envFile, bytes);
  const result = launch(f);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, 'synthetic child stderr\n');
  assert.deepEqual(JSON.parse(result.stdout).env, f.approved);
  assert.equal(readFileSync(f.marker, 'utf8'), 'started\n');
});

test('allows empty RUSTFLAGS and duplicate absolute PATH directories without normalization', t => {
  const f = fixture(t);
  f.approved.RUSTFLAGS = '';
  f.approved.PATH = `${f.root}/../${f.root.split('/').at(-1)}:${f.root}:${f.root}`;
  writeFileSync(f.envFile, JSON.stringify(f.approved));
  const result = launch(f);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).env, f.approved);
});

for (const kind of ['missing', 'directory', 'unreadable']) {
  test(`rejects ${kind} environment file without child effects`, t => {
    const f = fixture(t);
    rmSync(f.envFile);
    if (kind === 'directory') mkdirSync(f.envFile);
    // A cyclic symlink is unreadable even when the test user can bypass permissions.
    if (kind === 'unreadable') symlinkSync(f.envFile, f.envFile);
    rejected(f, args(f, 'probe', [secret]), 'environment');
  });
}

const malformed = [
  ['no arguments', () => []],
  ['missing file', () => ['--env-file']],
  ['missing separator and command', f => ['--env-file', f.envFile]],
  ['missing command', f => ['--env-file', f.envFile, '--']],
  ['unknown option', f => ['--unknown', f.envFile, '--', process.execPath]],
  ['relative file', () => ['--env-file', `${pathSentinel}.json`, '--', process.execPath]],
  ['empty file', () => ['--env-file', '', '--', process.execPath]],
  ['missing separator', f => ['--env-file', f.envFile, process.execPath, f.probe]],
  ['wrong separator', f => ['--env-file', f.envFile, '-x', process.execPath]],
  ['extra option before separator', f => ['--env-file', f.envFile, '--env-file', f.envFile, '--', process.execPath]],
  ['empty program', f => ['--env-file', f.envFile, '--', '', secret]],
];
for (const [name, build] of malformed) {
  test(`rejects CLI ${name} before child effects`, t => {
    const f = fixture(t);
    rejected(f, build(f), 'invocation');
  });
}

test('rejects nonexistent and nonexecutable programs before execution without leaking arguments or paths', t => {
  const f = fixture(t);
  const program = join(f.root, pathSentinel);
  rejected(f, ['--env-file', f.envFile, '--', program, secret], 'launch');
  writeFileSync(program, secret, { mode: 0o600 });
  rejected(f, ['--env-file', f.envFile, '--', program, secret], 'launch');
});

test('one spawn uses separate argv, inherited stdio, no shell and restores signal listeners', async t => {
  const f = fixture(t);
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listeners(s));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let calls = 0;
  const result = await run(args(f), (program, argv, options) => {
    calls++;
    assert.equal(program, process.execPath);
    assert.deepEqual(argv, ['--', f.probe, 'probe']);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, 'inherit');
    assert.equal(Object.hasOwn(options, 'cwd'), false);
    assert.deepEqual(Object.fromEntries(keys.map(k => [k, options.env[k]])), f.approved);
    queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0, null); });
    return child;
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listeners(s)), before);
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

for (const mode of ['throw', 'error-before', 'error-after', 'kill-throw', 'kill-false', 'unknown-control', 'unknown-close', 'invalid-argv']) {
  test(`bounds own ${mode} diagnostic and restores listeners`, t => {
    const f = fixture(t);
    const script = join(f.root, 'synthetic-control.mjs');
    writeFileSync(script, `
import { EventEmitter } from 'node:events';
import { run } from ${JSON.stringify(pathToFileURL(launcher).href)};
const mode = ${JSON.stringify(mode)};
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const before = signals.map(s => process.listenerCount(s));
let calls = 0;
const argv = ${JSON.stringify(args(f))};
if (mode === 'invalid-argv') argv.push(${JSON.stringify(`${secret}\0`)});
const result = await run(argv, () => {
  calls++;
  if (mode === 'throw') throw new Error(${JSON.stringify(secret)});
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => {
    if (mode === 'kill-false') return false;
    throw new Error(${JSON.stringify(secret)});
  };
  queueMicrotask(() => {
    if (mode !== 'error-before' && mode !== 'unknown-control' && mode !== 'unknown-close') child.emit('spawn');
    if (mode.startsWith('error-')) child.emit('error', new Error(${JSON.stringify(secret)}));
    if (mode.startsWith('kill-') || mode === 'unknown-control') process.emit('SIGTERM');
    child.emit('close', mode === 'unknown-close' ? null : 0, null);
  });
  return child;
});
console.log(JSON.stringify({ result, calls, restored: signals.every((s, i) => process.listenerCount(s) === before[i]) }));
`);
    const result = spawnSync(process.execPath, ['--', script], { cwd: f.root, env: inherited(), encoding: 'utf8', shell: false });
    assert.equal(result.status, 0);
    let diagnostic = messages.control, code = 1;
    if (mode === 'throw' || mode === 'error-before') { diagnostic = messages.launch; code = 2; }
    if (mode === 'unknown-control' || mode === 'unknown-close') diagnostic = messages.unknown;
    if (mode === 'invalid-argv') { diagnostic = messages.invocation; code = 2; }
    assert.equal(result.stderr, diagnostic);
    assert.ok(Buffer.byteLength(result.stderr) <= 100);
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stderr.includes(pathSentinel));
    assert.deepEqual(JSON.parse(result.stdout), { result: { code, signal: null }, calls: mode === 'invalid-argv' ? 0 : 1, restored: true });
    assert.ok(!existsSync(f.marker));
  });
}

const policyURL = new URL('../docs/DELEGATE_EXECUTION.md', import.meta.url);
const policy = () => readFileSync(policyURL, 'utf8');
for (const [path, href] of [
  ['AGENTS.md', 'docs/DELEGATE_EXECUTION.md'],
  ['docs/slices/g1/IMPLEMENTOR_PROMPT.md', '../../DELEGATE_EXECUTION.md'],
  ['docs/slices/g1/VALIDATION.md', '../../DELEGATE_EXECUTION.md'],
]) {
  test(`current policy link in ${path} is prospective and preserves historical failures`, () => {
    const url = new URL(`../${path}`, import.meta.url);
    const text = readFileSync(url, 'utf8');
    assert.ok(text.includes(`[Delegate execution policy](${href})`));
    assert.equal(new URL(href, url).href, policyURL.href);
    assert.match(text, /NEW wi assignments issued from October 11, 2026, after owner approval/);
    assert.match(text, /supersedes older all-command literal-prefix and permanently fatal harmless-diagnostic rules prospectively only/);
    assert.match(text, /Old handoffs, failed checks and failed or BLOCKED roles remain historical unchanged/);
    assert.match(text, /Explicit acceptance requirements and explicitly terminal rules remain mandatory/);
  });
}

test('policy requires valid UTF-8 source and well-formed decoded Unicode without replacement', () => {
  const text = policy();
  assert.match(text, /JSON must use valid UTF-8 source bytes/);
  assert.match(text, /decode to a plain object with exactly these six own keys and well-formed Unicode, NUL-free string values/);
  assert.match(text, /Reject lone surrogate escapes rather than replace them/);
  assert.match(text, /Valid escaped surrogate pairs and literal U\+FFFD are permitted/);
});

test('canonical policy bootstrap protects launcher and target Node argv without a six-value prefix', () => {
  const text = policy();
  assert.ok(text.includes('node -- scripts/agent_env.mjs --env-file <absolute-approved-json> -- <program> [args...]'));
  assert.ok(text.includes("NODE_OPTIONS='' /absolute/configured/node24 -- scripts/agent_env.mjs"));
  assert.ok(text.includes('--env-file /absolute/parent-approved/EXPECTED_ENV.json -- /absolute/program [args...]'));
  assert.match(text, /first `--` terminates Node CLI preprocessing/);
  assert.match(text, /second `--` separates launcher options from the target command/);
  assert.match(text, /Node target.*own Node CLI separator/);
  assert.match(text, /Do not hand-copy a six-value shell prefix/);
  assert.match(text, /Existing recorders may load, verify and inherit the same JSON instead of nesting this launcher/);
});

test('prospective policy retains old roles, validation sections and mandatory acceptance', () => {
  const text = policy();
  assert.match(text, /NEW wi assignments issued from October 11, 2026/);
  assert.match(text, /prospectively only/);
  assert.match(text, /Old handoffs, failed checks and failed or BLOCKED roles remain historical unchanged/);
  assert.match(text, /Explicit user\/project acceptance requirements and explicitly terminal procedural rules remain mandatory/);
  assert.match(text, /Do not invent irrevocable harmless-procedure rules without owner authority/);
  const validation = readFileSync(new URL('../docs/slices/g1/VALIDATION.md', import.meta.url), 'utf8');
  assert.deepEqual([...validation.matchAll(/^## (\d+)\./gm)].map(m => Number(m[1])), [1, 2, 3, 4, 5, 6, 7]);
  assert.match(validation, /Sections 1 through 6 retain their historical source\/design observations/);
  assert.match(validation, /does not pass a G11 row, change accepted=false or authorize product verification/);
});

test('policy distinguishes correctable rejection, required verification failure and actual breach', () => {
  const text = policy();
  assert.match(text, /Recorded rejection before the intended operation.*Inspect the concrete cause; correct within authority/);
  assert.match(text, /Optional harmless helper\/parser diagnostic alone.*does not invalidate otherwise completed work/);
  assert.match(text, /Required verification remains failed\/invalid.*FAILED with `verification_failure`/);
  assert.match(text, /Policy prevents work before a breach.*BLOCKED with `policy_restriction`/);
  assert.match(text, /Actual unauthorized action, secret exposure, material breach.*FAILED with `policy_violation`; stop/);
  assert.match(text, /Do not blindly retry or repeat an unauthorized operation/);
  assert.match(text, /Do not replay already-passing product proof, promote historical roles or waive required checks/);
  assert.match(text, /Required failed\/invalid checks remain failed\/invalid evidence/);
  assert.match(text, /Numeric status alone does not prove that no operation occurred/);
});

test('policy requires self-contained excerpts, privacy and finite preservation evidence', () => {
  const text = policy();
  assert.match(text, /each verification exactly one finding excerpt plus relevant path\/line evidence/);
  assert.match(text, /do not require extraction from sibling full reports/);
  assert.match(text, /Capture only authorized synthetic diagnostics/);
  assert.match(text, /Sanitize sensitive data before saving or sharing/);
  assert.match(text, /not an output scrubber or process sandbox/);
  assert.match(text, /record the effective six values and the binding to the parent-approved file/);
  assert.match(text, /Invalid or unknown environment proof is not PASS/);
  assert.match(text, /finite read-only baseline comparison for tracked and nonignored untracked nonassigned content and file modes/);
  assert.match(text, /Incidental CodeGraph cache maintenance is not user-source mutation/);
  assert.throws(() => {
    assert.match(text.replace(' and file modes', ''),
      /finite read-only baseline comparison for tracked and nonignored untracked nonassigned content and file modes/);
  }, { code: 'ERR_ASSERTION' });
});

test('policy preserves fixture exceptions, environment authority, platform and standard gates', () => {
  const text = policy();
  assert.match(text, /parent-approved path is authority external to the helper/);
  assert.match(text, /Native reads, CodeGraph and JavaScript file analysis need no shell prefix/);
  assert.match(text, /exemptions do not waive privacy, authorization or evidence rules/);
  assert.match(text, /Explicit synthetic fixture-child isolation exceptions remain valid/);
  assert.match(text, /synthetic invalid environment files under approved TMPDIR/);
  assert.match(text, /never substitute a fixture environment/i);
  assert.match(text, /Standard delegation gates, role boundaries, attempt limits and final report requirements remain unchanged/);
  assert.match(text, /All 40 rows remain PARTIAL with accepted=false/);
  assert.match(text, /Ledger 31\/50 used, 19 remaining is unchanged/);
  assert.match(text, /do not restore native Windows support/);
  assert.match(text, /Existing gate recorders retain descendant identity, cleanup, source and evidence ownership/);
});
