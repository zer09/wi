import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { compileFunction } from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { preparationRedactor, sanitizeRecord } from '../test-support/browser-fixture-preparation.mjs';
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

const diagnosticPrefix = 'browser_suite_launch: failure ';
const diagnosticFallback = 'browser_suite_launch: failure diagnostics unavailable.\n';
function diagnosticLine(result) {
  const { consumed, first_failure, child } = result.outcome;
  return diagnosticPrefix + JSON.stringify({ version: 1, scope: 'invocation observations only', consumed, first_failure,
    child: { spawned: child.spawned, closed: child.closed, error_observed: child.error_observed, code: child.code, signal: child.signal },
    terminal: { code: result.code, signal: result.signal }, reporter_text: null }) + '\n';
}
function captureDiagnostic() {
  let text = '', writes = 0;
  const stderr = new Writable({ write(chunk, encoding, done) { text += chunk.toString(); writes++; done(); } });
  return { stderr, text: () => text, writes: () => writes };
}
async function cliFailure(f) {
  const output = captureDiagnostic(), terminated = [];
  let result, launches = 0;
  const code = await run(['--bundle', f.bundle], async input => {
    launches++; result = await launchBrowserSuite(input, f.io); return result;
  }, output.stderr, signal => { listeners(f); terminated.push(signal); });
  assert.equal(launches, 1); assert.equal(code, result.signal === null ? result.code : 1);
  assert.deepEqual(terminated, result.signal === null ? [] : [result.signal]);
  assert.equal(output.text(), diagnosticLine(result)); assert.equal(output.writes(), 1);
  assert.ok(Buffer.byteLength(output.text()) <= 1024);
  assert.equal(output.text().split('\n').length, 2);
  assert.equal(output.stderr.listenerCount('error'), 0); listeners(f);
  return result;
}

// Execute the unchanged CLI body in this realm, replacing imports only at its private test boundary.
async function diagnosticCLI(launch, io = fs, env = process.env) {
  const source = await fs.readFile(new URL('../scripts/launch-browser-suite.mjs', import.meta.url), 'utf8');
  const body = source.replace(/^import .+;\n/gm, '').replace('export async function run', 'async function run')
    .replace('if (import.meta.main) process.exitCode = await run(process.argv.slice(2));', '');
  const bindings = { basename, dirname, isAbsolute, resolve, join, isDeepStrictEqual,
    fs: io, constants, isUtf8, ROOT, pathToFileURL, launchBrowserSuite: launch, preparationRedactor, sanitizeRecord,
    process: Object.assign(Object.create(process), { env }) };
  return compileFunction(body + '\nreturn {run, parser: typeof parseReporterText === "function" ? parseReporterText : null, reader: typeof readReporterText === "function" ? readReporterText : null};',
    Object.keys(bindings), { filename: 'launch-browser-suite-control.mjs' })(...Object.values(bindings));
}
const require = createRequire(import.meta.url);
const { TerminalReporter, terminalScreen, formatError } = require('../node_modules/playwright/lib/reporters/base.js');
function reporterText({ failed = [], interrupted = [], flaky = [], passed = 0, skipped = 0, didNotRun = 0, fatal = 0 } = {}) {
  const reporter = new TerminalReporter({ screen: { ...terminalScreen, resolveFiles: 'cwd' } });
  reporter.onConfigure({ rootDir: join(ROOT, 'web/e2e'), tags: [] }); reporter.result = { duration: 1200 };
  const declaration = name => ({ location: { file: join(process.cwd(), 'web/e2e', name), line: 17, column: 3 },
    titlePath: () => ['', '', name, 'synthetic private title'], tags: [] });
  return reporter.generateSummaryMessage({ unexpected: failed.map(declaration), interrupted: interrupted.map(declaration),
    flaky: flaky.map(declaration), expected: passed, skipped, didNotRun, fatalErrors: Array(fatal).fill({}) }) + '\n';
}
const reporterObservation = (declarations, counts = {}) => ({ scope: 'reporter text only; unauthenticated',
  counts: { failed: 0, interrupted: 0, flaky: 0, skipped: 0, did_not_run: 0, passed: 0, fatal_errors: 0, ...counts },
  declarations, truncated: false });
const coordinate = (file, category = 'failed') => ({ category, file: `web/e2e/${file}`, line: 17, column: 3,
  reported_source_frame: null, reported_stored_handoff: null });
const wireObservation = (declarations, counts, files) => ({ ...reporterObservation([], counts), version: 2, source_map: 1,
  declarations: declarations.map(d => [['failed', 'interrupted', 'flaky'].indexOf(d.category) + 1,
    files.indexOf(basename(d.file)) + 1, d.line, d.column, null, null]) });

function failureReport(files, errorsFor = () => [{ message: 'Error: synthetic private failure' }], attachments = [], locationFor = () => ({ line: 17, column: 3 }), titleFor = () => 'synthetic private title') {
  const reporter = new TerminalReporter({ screen: { ...terminalScreen, resolveFiles: 'cwd' } });
  reporter.onConfigure({ rootDir: join(ROOT, 'web/e2e'), tags: [] }); reporter.result = { duration: 1200 };
  const tests = files.map((name, index) => ({ location: { file: join(process.cwd(), 'web/e2e', name), ...locationFor(index) },
    titlePath: () => ['', '', name, titleFor(index)], tags: [], expectedStatus: 'passed',
    results: [{ status: 'failed', retry: 0, errors: errorsFor(name, index), steps: [], attachments }] }));
  return tests.map((value, index) => reporter.formatFailure(value, index + 1)).join('\n') + '\n'
    + reporter.generateSummaryMessage({ unexpected: tests, interrupted: [], flaky: [], expected: 89 - files.length,
      skipped: 0, didNotRun: 0, fatalErrors: [] }) + '\n';
}
const representativeFiles = ['cancellation', 'client-close-handoff', 'content-measurements', 'display-app',
  'display-view', 'joined', 'lifecycle-failure', 'live-commit-measurements'].map(n => n + '.spec.mjs');

test('C88 eight actual formatter failures survive the actual CLI instead of the old two declaration cap', async t => {
  for (const count of [7, 8]) await t.test(String(count), async t => {
    const f = await diagnosticLog(t, failureReport(representativeFiles.slice(0, count)));
    const output = captureDiagnostic(), { run: controlled } = await diagnosticCLI(async () => eligibleResult());
    assert.equal(await controlled(['--bundle', f.bundle], undefined, output.stderr), 7);
    assert.equal(output.writes(), 1); assert.ok(Buffer.byteLength(output.text()) <= 1024);
    assert.ok(!output.text().includes('synthetic private'), 'Private formatter input cannot enter diagnostics.');
    const observed = JSON.parse(output.text().slice(diagnosticPrefix.length)).reporter_text;
    assert.equal(observed.declarations.length, count);
    assert.equal(observed.version, 2); assert.equal(observed.source_map, 1); assert.equal(observed.truncated, false);
    assert.equal(observed.counts.failed, count); assert.equal(observed.counts.passed, 89 - count);
  });
});

function privateObservation(value, canary = '') {
  const text = JSON.stringify(value);
  const variants = canary ? [canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary), Buffer.from(canary).toString('base64')] : [];
  assert.ok(!variants.some(v => text.includes(v)) && !/\/home\/|file:|https?:|syntheticPrivateFunction|Error:/.test(text),
    'Only closed observations can leave the formatter boundary.');
}
const reportedError = (file, message = 'synthetic private failure', prefix = ROOT + '/', line = 214, column = 9) => ({
  message: 'Error: ' + message,
  stack: `Error: ${message}\n    at syntheticPrivateFunction (${prefix}web/e2e/${file}:${line}:${column})`,
});
async function observedCLI(t, text, env = process.env, result = eligibleResult()) {
  const f = await diagnosticLog(t, text), output = captureDiagnostic(), terminated = [];
  const { run: controlled } = await diagnosticCLI(async () => result, fs, env);
  assert.equal(await controlled(['--bundle', f.bundle], undefined, output.stderr, s => terminated.push(s)), result.signal ? 1 : result.code);
  assert.equal(output.writes(), 1); assert.equal(output.stderr.listenerCount('error'), 0);
  assert.deepEqual(terminated, result.signal ? [result.signal] : []);
  assert.ok(Buffer.byteLength(output.text()) <= 1024); assert.equal(output.text().split('\n').length, 2);
  return output.text();
}

test('C88 R1 long and boundary-width pinned headers retain uniquely associated observations', async t => {
  const ts = require('typescript'), { parser } = await diagnosticCLI(() => {});
  const cases = [];
  for (const [file, declarationLine, frameLine, frameColumn, id] of [
    ['client-close-handoff.spec.mjs', 51, 247, 15, 3], ['display-app.spec.mjs', 214, 218, 108, 6],
    ['live-commit-measurements.spec.mjs', 11, 23, 5, 12],
  ]) {
    const source = await fs.readFile(new URL('../e2e/' + file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const calls = ast.statements.filter(ts.isExpressionStatement).map(s => s.expression)
      .filter(e => ts.isCallExpression(e) && e.expression.getText(ast) === 'test');
    const call = calls.find(e => ast.getLineAndCharacterOfPosition(e.getStart(ast)).line + 1 === declarationLine);
    assert.ok(call && ts.isStringLiteral(call.arguments[0]), 'The actual declaration must supply the title.');
    // Bind synthetic frames to the current source, without importing or executing an E2E body.
    assert.ok(source.split('\n')[frameLine - 1].length >= frameColumn);
    cases.push({ file, line: declarationLine, column: 1, title: call.arguments[0].text, frame: [frameLine, frameColumn], id });
  }
  const handoff = cases[0], short = { ...cases[1], title: 'short' };
  const prefix = `  1) web/e2e/${handoff.file}:${handoff.line}:1 › `;
  const width = n => ({ ...handoff, title: 'x'.repeat(n - prefix.length - 1) });
  const scenarios = [...cases.map(c => [c]), ...cases.map(c => [{ ...c, title: 'short' }]),
    [width(99)], [width(100)], [handoff, short]];
  for (const [index, declarations] of scenarios.entries()) await t.test(String(index), async t => {
    const text = failureReport(declarations.map(c => c.file), (file, i) => [reportedError(file,
      file === handoff.file ? 'Client handoff failed: stage=close-a; check=native' : 'synthetic private failure', '', ...declarations[i].frame)],
    [], i => ({ line: declarations[i].line, column: declarations[i].column }), i => declarations[i].title);
    const headers = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(line => /^  [0-9]+\) /.test(line));
    assert.equal(headers.length, declarations.length);
    const decorations = headers.map(line => /─*$/.exec(line)[0].length);
    if (index < 3 || index === 7 || index === 8) assert.equal(decorations[0], 0);
    if (index >= 3 && index <= 6) assert.ok(decorations[0] > 0);
    const parsed = parser(text); privateObservation(parsed);
    const wire = await observedCLI(t, text); privateObservation(wire);
    const observation = JSON.parse(wire.slice(diagnosticPrefix.length));
    assert.equal(observation.reporter_text.counts.failed, declarations.length);
    assert.equal(observation.reporter_text.counts.passed, 89 - declarations.length);
    assert.deepEqual(observation.terminal, { code: 7, signal: null });
    assert.equal(observation.reporter_text.truncated, false);
    for (const [i, c] of declarations.entries()) {
      assert.deepEqual(parsed.declarations[i].reported_source_frame, { file: 'web/e2e/' + c.file, line: c.frame[0], column: c.frame[1] });
      assert.deepEqual(observation.reporter_text.declarations[i], [1, c.id, c.line, c.column, c.frame, c.file === handoff.file ? [4, 3] : null]);
    }
  });
});

test('C88 R1 only a supported single error region can supply optional observations', async t => {
  const { parser } = await diagnosticCLI(() => {}), file = 'display-app.spec.mjs';
  const canary = hash(String(performance.now())) + '/非公開';
  for (const prefix of ['AssertionError', 'TimeoutError', 'locator.click']) {
    for (const arrangement of ['after', 'before', 'frameless-first', 'handoff']) await t.test(`${prefix}/${arrangement}`, async t => {
      const name = arrangement === 'handoff' ? 'client-close-handoff.spec.mjs' : file;
      const first = reportedError(name, arrangement === 'handoff' ? 'Client handoff failed: stage=close-a; check=native' : canary, '', 214, 9);
      const second = reportedError(name, canary, '', 247, 19);
      second.message = second.message.replace('Error:', prefix + ':'); second.stack = second.stack.replace('Error:', prefix + ':');
      if (arrangement === 'frameless-first') delete first.stack;
      const errors = arrangement === 'before' ? [second, first] : [first, second];
      const text = failureReport([name], () => errors), parsed = parser(text); privateObservation(parsed, canary);
      const wire = await observedCLI(t, text); privateObservation(wire, canary);
      assert.deepEqual([parsed.declarations[0].reported_source_frame, parsed.declarations[0].reported_stored_handoff], [null, null]);
      const observation = JSON.parse(wire.slice(diagnosticPrefix.length));
      assert.deepEqual(observation.reporter_text.declarations[0], [1, arrangement === 'handoff' ? 3 : 6, 17, 3, null, null]);
      assert.deepEqual(observation.terminal, { code: 7, signal: null });
      assert.equal(observation.reporter_text.counts.failed, 1); assert.equal(observation.reporter_text.counts.passed, 88);
    });
  }
  for (const [index, continuation] of ['plain continuation', 'arbitrary.operation: another failure', 'CustomFailure: another failure',
    '        at unfinished (', '    214 | unsupported placement'].entries()) await t.test(`unsupported/${index}`, async t => {
    const error = reportedError(file, canary, '');
    error.stack += '\n' + continuation;
    const text = failureReport([file], () => [error]), parsed = parser(text); privateObservation(parsed, canary);
    const wire = await observedCLI(t, text); privateObservation(wire, canary);
    assert.deepEqual([parsed.declarations[0].reported_source_frame, parsed.declarations[0].reported_stored_handoff], [null, null]);
    assert.deepEqual(JSON.parse(wire.slice(diagnosticPrefix.length)).reporter_text.declarations[0].slice(4), [null, null]);
  });
});

test('C88 R1 exact byte boundaries require an actual whole-tuple omission for truncated true', async t => {
  for (const k of [2, 3, 4]) await t.test(String(1022 + k), async t => {
    const declarations = Array.from({ length: 26 }, (_, i) => [1, 1, 17 + i, i < k ? 10 : 3, null, null]);
    const text = failureReport(Array(26).fill('cancellation.spec.mjs'), undefined, [], i => ({ line: 17 + i, column: i < k ? 10 : 3 }));
    const full = JSON.parse(diagnosticLine(eligibleResult()).slice(diagnosticPrefix.length));
    full.reporter_text = { version: 2, source_map: 1, scope: 'reporter text only; unauthenticated',
      counts: { failed: 26, interrupted: 0, flaky: 0, skipped: 0, did_not_run: 0, passed: 63, fatal_errors: 0 }, declarations, truncated: false };
    assert.equal(Buffer.byteLength(diagnosticPrefix + JSON.stringify(full) + '\n'), 1022 + k);
    const wire = await observedCLI(t, text); privateObservation(wire);
    const observation = JSON.parse(wire.slice(diagnosticPrefix.length));
    const retained = k === 2 ? 26 : 25;
    assert.equal(Buffer.byteLength(wire), k === 2 ? 1024 : 1000 + k);
    assert.deepEqual(observation.reporter_text.declarations, declarations.slice(0, retained));
    assert.equal(observation.reporter_text.truncated, retained < declarations.length);
    full.reporter_text.declarations = declarations.slice(0, retained); full.reporter_text.truncated = retained < declarations.length;
    assert.deepEqual(observation, full);
  });
});

test('C88 versioned source IDs follow all 34 actual tracked declaration identities in order', async t => {
  const files = (await fs.readdir(new URL('../e2e/', import.meta.url))).filter(p => p.endsWith('.spec.mjs')).sort();
  assert.equal(files.length, 34);
  for (const [index, file] of files.entries()) await t.test(file, async t => {
    const text = await observedCLI(t, failureReport([file])); privateObservation(text);
    const observation = JSON.parse(text.slice(diagnosticPrefix.length)).reporter_text;
    assert.deepEqual(observation, wireObservation([coordinate(file)], { failed: 1, passed: 88 }, files));
    assert.equal(observation.declarations[0][1], index + 1);
  });
});

test('C88 actual formatError and numbered formatFailure bind the first reported same-spec frame, not the declaration', async t => {
  const { parser } = await diagnosticCLI(() => {}), file = 'display-app.spec.mjs';
  const canary = hash(String(performance.now())) + '/非公開';
  for (const [name, prefix] of [['absolute', ROOT + '/'], ['uri', pathToFileURL(ROOT + '/').href], ['relative', '']]) await t.test(name, async t => {
    const error = reportedError(file, canary, prefix);
    error.snippet = `  212 | private ${canary}\n> 214 | throw privateError;\n      |       ^`;
    error.stack = error.stack.replace('\n', `\n    at syntheticPrivateFunction (${prefix}web/e2e/joined.spec.mjs:31:7)\n`);
    error.stack += `\n    at syntheticPrivateFunction (${prefix}web/e2e/${file}:247:19)`;
    const formatted = formatError(terminalScreen, error).message;
    assert.ok(formatted.includes(canary) && formatted.includes(':214:9'), 'Pinned formatError must process the private stack and snippet.');
    const text = failureReport([file], () => [error]), parsed = parser(text); privateObservation(parsed, canary);
    assert.deepEqual(parsed.declarations[0].reported_source_frame, { file: 'web/e2e/' + file, line: 214, column: 9 });
    assert.deepEqual([parsed.declarations[0].line, parsed.declarations[0].column], [17, 3]);
    const wire = await observedCLI(t, text); privateObservation(wire, canary);
    assert.deepEqual(JSON.parse(wire.slice(diagnosticPrefix.length)).reporter_text.declarations[0], [1, 6, 17, 3, [214, 9], null]);
  });
});

test('C88 unsupported or ambiguous formatter bodies keep optional observations null without inventing declaration frames', async t => {
  const { parser } = await diagnosticCLI(() => {}), file = 'display-app.spec.mjs', canary = hash(String(performance.now()));
  const kinds = ['missing', 'unknown', 'other-spec', 'alias', 'traversal', 'url', 'zero', 'huge', 'column', 'multiple-errors',
    'nested-cause', 'attachment', 'snippet-only', 'unmatched', 'duplicate-block', 'duplicate-number', 'malformed-block', 'title-injection'];
  for (const kind of kinds) await t.test(kind, () => {
    let error = reportedError(file, canary), attachments = [], extra = [];
    if (kind === 'missing') error = { message: 'Error: ' + canary };
    if (kind === 'unknown') error = reportedError(file, canary, '/synthetic/private/');
    if (kind === 'other-spec') error = reportedError('joined.spec.mjs', canary);
    if (kind === 'alias') error = reportedError(file, canary, ROOT + '-alias/');
    if (kind === 'traversal') error = reportedError(file, canary, ROOT + '/other/../');
    if (kind === 'url') error = reportedError(file, canary, 'https://synthetic.invalid/');
    if (kind === 'zero') error = reportedError(file, canary, ROOT + '/', 0);
    if (kind === 'huge') error = reportedError(file, canary, ROOT + '/', 1_000_001);
    if (kind === 'column') error = reportedError(file, canary, ROOT + '/', 214, 1_000_001);
    if (kind === 'multiple-errors') extra = [reportedError(file, canary, '', 247, 19)];
    if (kind === 'nested-cause') error.cause = reportedError(file, canary, '', 247, 19);
    if (kind === 'attachment') attachments = [{ name: 'private-' + canary, contentType: 'text/plain', body: Buffer.from('    at ' + ROOT + '/web/e2e/' + file + ':247:19') }];
    if (kind === 'snippet-only') error = { message: 'Error: ' + canary, location: { file: join(ROOT, 'web/e2e', file), line: 214, column: 9 },
      snippet: '  214 |        at ' + ROOT + '/web/e2e/' + file + ':247:19' };
    let text = failureReport([file], () => [error, ...extra], attachments);
    const header = text.split('\n').find(line => /^  1\) /.test(line));
    if (kind === 'unmatched') text = text.replace(header, header.replace(':17:3', ':18:3'));
    if (kind === 'duplicate-block') text = text.replace(header, header + '\n' + header.replace('1)', '2)'));
    if (kind === 'duplicate-number') text = text.replace(header, header + '\n' + header);
    if (kind === 'malformed-block') text = text.replace(header, header.replace('web/e2e/', 'e2e/'));
    if (kind === 'title-injection') text = text.replace(header, header + '\n  2) private-' + canary);
    const parsed = parser(text); privateObservation(parsed, canary); assert.ok(parsed !== null);
    assert.equal(parsed.declarations[0].reported_source_frame, null);
    assert.equal(parsed.declarations[0].reported_stored_handoff, null);
    assert.deepEqual([parsed.declarations[0].line, parsed.declarations[0].column], [17, 3]);
  });
});

test('C88 handoff reports only source-bound stored stage/check literals, which can describe an earlier check', async t => {
  const stageNames = ['startup', 'create', 'first-send', 'close-a', 'observer-connect', 'first-completion', 'later-explicit-send', 'reopened-a'];
  const checkNames = ['outside', 'receipt', 'native', 'dto', 'handshake', 'order', 'assets', 'requests'];
  const source = await fs.readFile(new URL('../e2e/client-close-handoff.spec.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...new Set([...source.matchAll(/\bstage = '([^']+)'/g)].map(m => m[1]))], stageNames);
  assert.deepEqual([...new Set([...source.matchAll(/\bcheck = '([^']+)'/g)].map(m => m[1]))], checkNames);
  assert.ok(source.includes('failure = new Error(`Client handoff failed: stage=${stage}; check=${check}`);'));
  const { parser } = await diagnosticCLI(() => {}), file = 'client-close-handoff.spec.mjs';
  for (const [s, stage] of stageNames.entries()) for (const [c, check] of checkNames.entries()) await t.test(`${s + 1}/${c + 1}`, async t => {
    const text = failureReport([file], () => [reportedError(file, `Client handoff failed: stage=${stage}; check=${check}`, '', 247, 19)]);
    const parsed = parser(text); privateObservation(parsed);
    assert.deepEqual(parsed.declarations[0].reported_stored_handoff, { stage, check });
    const wire = await observedCLI(t, text); privateObservation(wire);
    assert.deepEqual(JSON.parse(wire.slice(diagnosticPrefix.length)).reporter_text.declarations[0], [1, 3, 17, 3, [247, 19], [s + 1, c + 1]]);
  });
  for (const [kind, message, name] of [
    ['unknown-stage', 'Client handoff failed: stage=unknown; check=native', file],
    ['unknown-check', 'Client handoff failed: stage=close-a; check=unknown', file],
    ['trailing', 'Client handoff failed: stage=close-a; check=native private', file],
    ['prefix', 'Private Client handoff failed: stage=close-a; check=native', file],
    ['cleanup', 'Client handoff cleanup failed: fixture', file],
    ['other-spec', 'Client handoff failed: stage=close-a; check=native', 'joined.spec.mjs'],
  ]) await t.test(kind, () => {
    const parsed = parser(failureReport([name], () => [reportedError(name, message)])); privateObservation(parsed);
    assert.equal(parsed.declarations[0].reported_stored_handoff, null);
  });
});

test('C88 eight maximum tuples fit; larger summaries lose only whole tuples after full validation', async t => {
  const files = (await fs.readdir(new URL('../e2e/', import.meta.url))).filter(p => p.endsWith('.spec.mjs')).sort();
  const eight = ['client-close-handoff.spec.mjs', ...files.slice(-7)];
  const maximum = failureReport(eight, file => [reportedError(file, file === eight[0]
    ? 'Client handoff failed: stage=reopened-a; check=requests' : 'synthetic private failure', '', 1_000_000, 1_000_000)])
    .replaceAll(':17:3', ':1000000:1000000').replace('  81 passed', '  1000000 skipped\n  1000000 did not run\n  1000000 passed')
    + '  1000000 errors were not a part of any test, see above for details\n';
  const result = eligibleResult(); result.code = result.outcome.child.code = Number.MAX_SAFE_INTEGER;
  const maxLine = await observedCLI(t, maximum, process.env, result); privateObservation(maxLine);
  const max = JSON.parse(maxLine.slice(diagnosticPrefix.length));
  assert.equal(max.reporter_text.declarations.length, 8); assert.equal(max.reporter_text.truncated, false);
  assert.ok(max.reporter_text.declarations.every(d => d[2] === 1_000_000 && d[3] === 1_000_000 && d[4]?.every(n => n === 1_000_000)));
  assert.deepEqual(max.reporter_text.declarations[0][5], [8, 8]); assert.equal(max.reporter_text.counts.fatal_errors, 1_000_000);
  t.diagnostic(`Maximum eight-entry diagnostic UTF8 bytes including prefix/newline: ${Buffer.byteLength(maxLine)}`);
  const large = failureReport(files), { parser } = await diagnosticCLI(() => {}), parsed = parser(large);
  assert.equal(parsed.declarations.length, 34); assert.equal(parsed.truncated, false);
  const many = failureReport(Array.from({ length: 89 }, (_, i) => files[i % files.length]), undefined, [], i => ({ line: 17 + i, column: 3 }));
  assert.equal(parser(many).declarations.length, 89);
  const manyLine = await observedCLI(t, many); privateObservation(manyLine);
  const manyWire = JSON.parse(manyLine.slice(diagnosticPrefix.length));
  assert.equal(manyWire.reporter_text.counts.failed, 89); assert.equal(manyWire.reporter_text.truncated, true);
  const line = await observedCLI(t, large); privateObservation(line);
  const wire = JSON.parse(line.slice(diagnosticPrefix.length)); assert.equal(wire.reporter_text.truncated, true);
  assert.ok(wire.reporter_text.declarations.length >= 8 && wire.reporter_text.declarations.length < 34);
  assert.ok(wire.reporter_text.declarations.every(d => d.length === 6));
  assert.deepEqual(wire.reporter_text.counts, parsed.counts); assert.deepEqual(wire.terminal, { code: 7, signal: null });
  const oneMore = structuredClone(wire); oneMore.reporter_text.declarations.push([1, wire.reporter_text.declarations.length + 1, 17, 3, null, null]);
  assert.ok(Buffer.byteLength(diagnosticPrefix + JSON.stringify(oneMore) + '\n') > 1024, 'No whole tuple is dropped before the budget requires it.');
  for (const kind of ['unknown-last', 'missing-last', 'invalid-last', 'extra-last', 'duplicate-last', 'missing-summary']) await t.test(kind, async t => {
    let changed = large;
    if (kind === 'unknown-last') changed = changed.replaceAll(files.at(-1), 'unknown.spec.mjs');
    if (kind === 'missing-last') changed = changed.replace(/^    web\/e2e\/upgrade-display-parity[^\n]*\n/m, '');
    if (kind === 'invalid-last') changed = changed.replace(/^    web\/e2e\/upgrade-display-parity[^\n]*/m, s => s.replace(':17:3', ':0:3'));
    if (kind === 'extra-last') changed += '    web/e2e/joined.spec.mjs:19:3 › extra\n';
    if (kind === 'duplicate-last') changed = changed.replace(/^    web\/e2e\/upgrade-display-parity[^\n]*/m, s => s.replace('upgrade-display-parity', 'tool-fidelity'));
    if (kind === 'missing-summary') changed = changed.replace('  34 failed\n', '');
    assert.ok(changed !== large); assert.equal(parser(changed), null);
    const observed = await observedCLI(t, changed); privateObservation(observed);
    assert.equal(JSON.parse(observed.slice(diagnosticPrefix.length)).reporter_text, null);
  });
});

test('C88 compact category IDs and optional reporter observations preserve one seven and signal terminals', async t => {
  for (const [category, id] of [['failed', 1], ['interrupted', 2], ['flaky', 3]]) for (const terminal of [1, 7, 'SIGTERM']) await t.test(`${category}/${terminal}`, async t => {
    const result = eligibleResult();
    if (terminal === 'SIGTERM') { result.code = result.outcome.child.code = null; result.signal = result.outcome.child.signal = terminal; }
    else result.code = result.outcome.child.code = terminal;
    const text = await observedCLI(t, reporterText({ [category]: ['cancellation.spec.mjs'], passed: 88 }), process.env, result);
    privateObservation(text); const wire = JSON.parse(text.slice(diagnosticPrefix.length));
    assert.deepEqual(wire.reporter_text.declarations, [[id, 1, 17, 3, null, null]]);
    assert.equal(wire.reporter_text.counts[category], 1); assert.equal(wire.first_failure, 'child');
    assert.deepEqual(wire.terminal, { code: result.code, signal: result.signal });
    assert.equal(wire.child.closed, true); assert.equal(wire.child.code, result.code); assert.equal(wire.child.signal, result.signal);
  });
});

test('C88 complete internal and fresh public projections reject collisions before IDs and byte omissions', async t => {
  const files = (await fs.readdir(new URL('../e2e/', import.meta.url))).filter(p => p.endsWith('.spec.mjs')).sort();
  const text = failureReport(files, file => [reportedError(file, file === 'client-close-handoff.spec.mjs'
    ? 'Client handoff failed: stage=reopened-a; check=requests' : 'synthetic private failure', '')]);
  for (const [kind, value] of [['filename', 'web/e2e/cancellation.spec.mjs'], ['omitted-filename', 'web/e2e/upgrade-display-parity.spec.mjs'],
    ['stage', 'reopened-a'], ['check', 'requests'], ['internal-key', 'reported_stored_handoff'], ['public-key', 'source_map'],
    ['public-value', 'reporter text only; unauthenticated'], ['safe', 'synthetic-private-nonoverlap']]) await t.test(kind, async t => {
    const env = { ...process.env, SYNTHETIC_TOKEN: value }, before = { ...process.env };
    const line = await observedCLI(t, text, env); privateObservation(line);
    assert.ok(isDeepStrictEqual({ ...process.env }, before));
    if (kind === 'safe') assert.equal(JSON.parse(line.slice(diagnosticPrefix.length)).reporter_text.truncated, true);
    else assert.equal(line, diagnosticFallback);
  });
});

test('C87 actual CLI default launch reads a private failed-child reporter summary without accepting its failed receipt', async t => {
  const f = await fixture(t), original = await fs.readFile(f.bundle);
  const text = reporterText({ failed: ['cancellation.spec.mjs'], passed: 88 });
  assert.match(text.replace(/\x1b\[[0-9;]*m/g, ''), /web\/e2e\/cancellation\.spec\.mjs:17:3/);
  during(f, c => c.stdout.write(text), 7);
  let result, launches = 0;
  const cli = await diagnosticCLI(async input => { launches++; result = await launchBrowserSuite(input, f.io); return result; });
  const output = captureDiagnostic(); assert.equal(await cli.run(['--bundle', f.bundle], undefined, output.stderr), 7);
  assert.equal(launches, 1); assert.equal(f.calls.length, 1); assert.equal(output.writes(), 1);
  const projection = JSON.parse(output.text().slice(diagnosticPrefix.length));
  const files = (await fs.readdir(new URL('../e2e/', import.meta.url))).filter(p => p.endsWith('.spec.mjs')).sort();
  assert.deepEqual(projection.reporter_text, wireObservation([coordinate('cancellation.spec.mjs')], { failed: 1, passed: 88 }, files));
  assert.equal(projection.child.code, 7); assert.equal(projection.child.closed, true); assert.equal(projection.first_failure, 'child');
  assert.ok(!output.text().includes('synthetic private title')); assert.ok(Buffer.byteLength(output.text()) <= 1024);
  assert.equal((await load(join(f.output, 'control/launch.command.json'))).code, 7);
  assert.equal(result.outcome.test_counts, null); assert.equal(result.outcome.browser_executions, null);
  assert.deepEqual(await fs.readFile(f.bundle), original); listeners(f);
});

test('C87 pinned formatter and closed allowlist bind every current declaration filename', async t => {
  assert.equal(require('../node_modules/playwright/package.json').version, '1.58.2');
  assert.equal(terminalScreen.resolveFiles, 'cwd');
  const { parser } = await diagnosticCLI(() => assert.fail('Parser must not launch.'));
  const files = (await fs.readdir(new URL('../e2e/', import.meta.url))).filter(p => p.endsWith('.spec.mjs')).sort();
  assert.equal(files.length, 34);
  for (const file of files) await t.test(file, async () => {
    assert.ok((await fs.lstat(new URL('../e2e/' + file, import.meta.url))).isFile());
    const text = reporterText({ failed: [file], passed: 88 });
    assert.deepEqual(parser(text), reporterObservation([coordinate(file)], { failed: 1, passed: 88 }));
  });
});

test('C87 actual formatter categories include omitted zeros and fatal errors alongside passing tests', async t => {
  const { parser } = await diagnosticCLI(() => {});
  const a = 'cancellation.spec.mjs', b = 'joined.spec.mjs', c = 'restart-display.spec.mjs';
  const cases = [
    [{ failed: [a] }, [coordinate(a)], { failed: 1 }],
    [{ interrupted: [a] }, [coordinate(a, 'interrupted')], { interrupted: 1 }],
    [{ flaky: [a] }, [coordinate(a, 'flaky')], { flaky: 1 }],
    [{ skipped: 2 }, [], { skipped: 2 }],
    [{ didNotRun: 3 }, [], { did_not_run: 3 }],
    [{ passed: 89 }, [], { passed: 89 }],
    [{ passed: 89, fatal: 1 }, [], { passed: 89, fatal_errors: 1 }],
    [{ passed: 88, fatal: 2 }, [], { passed: 88, fatal_errors: 2 }],
    [{ failed: [a, b] }, [coordinate(a), coordinate(b)], { failed: 2 }],
    [{ failed: [a], interrupted: [b], flaky: [c], skipped: 1, didNotRun: 2, passed: 83, fatal: 2 },
      [coordinate(a), coordinate(b, 'interrupted'), coordinate(c, 'flaky')], { failed: 1, interrupted: 1, flaky: 1, skipped: 1, did_not_run: 2, passed: 83, fatal_errors: 2 }],
  ];
  for (const [i, [input, declarations, counts]] of cases.entries()) await t.test(String(i), () => {
    const expected = reporterObservation(declarations, counts);
    assert.deepEqual(parser(reporterText(input)), expected);
  });
  for (const [name, text] of [['empty', reporterText()], ['fatal-only', reporterText({ fatal: 1 })],
    ['partial', 'Running 89 tests using 1 worker\n'], ['error-only', 'Error: synthetic private message\n']]) await t.test(name, () => assert.equal(parser(text), null));
  const ansi = '\x1b[1A\x1b[2K\x1b[31m' + reporterText({ failed: [a], passed: 88 }).replaceAll('\n', '\x1b[0m\r\n\x1b[31m') + '\x1b[0m';
  assert.deepEqual(parser(ansi), reporterObservation([coordinate(a)], { failed: 1, passed: 88 }));
});

test('C87 validates the whole final summary including headers beyond the coordinate cap', async t => {
  const { parser } = await diagnosticCLI(() => {});
  const text = reporterText({ failed: ['cancellation.spec.mjs', 'joined.spec.mjs', 'restart-display.spec.mjs'], passed: 86 });
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const edits = {
    unknown: s => s.replace('web/e2e/restart-display.spec.mjs', 'web/e2e/unknown.spec.mjs'),
    traversal: s => s.replace('web/e2e/restart-display.spec.mjs', 'web/e2e/../restart-display.spec.mjs'),
    absolute: s => s.replace('web/e2e/restart-display.spec.mjs', '/private/restart-display.spec.mjs'),
    wrong_prefix: s => s.replace('web/e2e/restart-display.spec.mjs', 'e2e/restart-display.spec.mjs'),
    project: s => s.replace('web/e2e/restart-display.spec.mjs', '[other] › web/e2e/restart-display.spec.mjs'),
    zero: s => s.replace(':17:3', ':0:3'), negative: s => s.replace(':17:3', ':-1:3'),
    leading_zero: s => s.replace(':17:3', ':017:3'), huge: s => s.replace(':17:3', ':1000001:3'),
    column: s => s.replace(':17:3', ':17:1000001'), float: s => s.replace(':17:3', ':17.2:3'),
    partial_header: s => s.replace(/    web\/e2e\/restart-display[^\n]*\n/, ''),
    extra_header: s => s + '    web/e2e/tool-fidelity.spec.mjs:17:3 › forged\n',
    duplicate_header: s => s.replace('restart-display.spec.mjs', 'joined.spec.mjs'),
    mismatch: s => s.replace('3 failed', '2 failed'), duplicate_summary: s => s + s,
    missing_first_count: s => s.replace('  3 failed\n', ''),
    damaged_first_count: s => s.replace('  3 failed', '  failed'),
    duplicate_category: s => s + '  1 passed (1s)\n',
    category_order: s => '  1 skipped\n' + s,
    zero_count: s => s.replace('3 failed', '0 failed'), huge_count: s => s.replace('3 failed', '1000001 failed'),
    invalid_duration: s => s.replace('(1.2s)', '(Infinitys)'),
    unknown_format: s => s + '  1 timed out\n', unknown_escape: s => s + '\x1b]private\x07',
    trailing_error: s => s + 'synthetic private fatal message\n',
    plural_fatal: s => s + '  1 errors were not a part of any test, see above for details\n',
    malformed_count_before_valid: s => '  -1 failed\n' + s,
  };
  for (const [name, edit] of Object.entries(edits)) await t.test(name, () => {
    const changed = edit(plain); assert.notEqual(changed, plain, 'Negative control must change its input.');
    assert.equal(parser(changed), null);
  });
  const parsed = parser(text); assert.equal(parsed.declarations.length, 3); assert.equal(parsed.truncated, false);
  // Test output can forge this exact text. Recognition is deliberately not case-execution proof.
  assert.equal(parser('synthetic stdout preamble\n' + text).scope, 'reporter text only; unauthenticated');
  const privateText = 'synthetic-secret/非公開 quote"';
  const variants = [privateText, JSON.stringify(privateText), encodeURIComponent(privateText), Buffer.from(privateText).toString('base64')];
  const malicious = plain.replaceAll('synthetic private title', variants.join(' '));
  const projected = JSON.stringify(parser(malicious));
  for (const value of variants) assert.ok(!projected.includes(value), 'Titles and encoded private values cannot leave the parser.');
});

async function diagnosticLog(t, text = reporterText({ failed: ['cancellation.spec.mjs'], passed: 88 })) {
  const parent = await fs.mkdtemp(join(tmpdir(), 'wi-reporter-unit-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'root'), control = join(root, 'control');
  await fs.mkdir(control, { recursive: true, mode: 0o700 });
  const path = join(control, 'launch.stdout'); await privateWrite(path, text);
  return { parent, root, control, path, bundle: join(control, 'suite-ready.json') };
}
const eligibleResult = () => ({ code: 7, signal: null, outcome: { scope: 'one-use suite launch observation only', consumed: true,
  first_failure: 'child', child: { spawned: true, closed: true, error_observed: false, code: 7, signal: null } } });

test('C87 bounded private reader rejects unsupported files and directories without entering fixtures or receipts', async t => {
  for (const kind of ['ordinary', 'missing', 'mode', 'root-mode', 'parent-mode', 'control-mode', 'symlink', 'hardlink',
    'directory', 'fifo', 'invalid-utf8', 'oversized', 'root-alias', 'control-alias', 'parent-alias', 'owner', 'directory-owner']) await t.test(kind, async t => {
    const f = await diagnosticLog(t); let bundle = f.bundle, opens = 0, closed = 0;
    if (kind === 'missing') await fs.unlink(f.path);
    if (kind === 'mode') await fs.chmod(f.path, 0o644);
    for (const [name, p] of [['root-mode', f.root], ['parent-mode', f.parent], ['control-mode', f.control]]) if (kind === name) await fs.chmod(p, 0o755);
    if (kind === 'symlink') { await fs.rename(f.path, f.path + '.original'); await fs.symlink(f.path + '.original', f.path); }
    if (kind === 'hardlink') await fs.link(f.path, f.path + '.link');
    if (kind === 'directory' || kind === 'fifo') {
      await fs.unlink(f.path);
      if (kind === 'directory') await fs.mkdir(f.path, { mode: 0o700 });
      else { const child = spawnSync('mkfifo', ['-m', '600', f.path], { env: { ...process.env }, encoding: 'utf8' }); assert.equal(child.status, 0); }
    }
    if (kind === 'invalid-utf8') await privateWrite(f.path, Buffer.from([0xff, 0xfe]));
    if (kind === 'oversized') { const h = await fs.open(f.path, 'r+'); try { await h.truncate(8 * 1024 * 1024 + 1); } finally { await h.close(); } }
    if (kind.endsWith('-alias')) {
      const actual = { 'root-alias': f.root, 'control-alias': f.control, 'parent-alias': f.parent }[kind];
      const alias = actual + '-alias'; await fs.symlink(actual, alias);
      if (kind === 'parent-alias') { t.after(() => fs.unlink(alias)); bundle = join(alias, 'root/control/suite-ready.json'); }
      else bundle = kind === 'root-alias' ? join(alias, 'control/suite-ready.json') : join(alias, 'suite-ready.json');
    }
    const io = { ...fs, lstat: async p => {
      assert.ok(p !== f.bundle && !p.endsWith('.command.json') && !p.includes('/retained/'));
      const s = await fs.lstat(p);
      if (kind === 'owner' && p === f.path || kind === 'directory-owner' && p === f.root) s.uid++;
      return s;
    }, open: async (p, flags) => {
      opens++; assert.equal(p, f.path); assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK);
      const h = await fs.open(p, flags);
      return { stat: () => h.stat(), read: (...args) => h.read(...args), close: async () => { closed++; await h.close(); } };
    } };
    const { reader } = await diagnosticCLI(() => {}, io);
    const result = await reader(bundle);
    if (kind === 'ordinary') assert.deepEqual(result, reporterObservation([coordinate('cancellation.spec.mjs')], { failed: 1, passed: 88 }));
    else assert.equal(result, null);
    assert.equal(closed, opens);
    if (!['ordinary', 'invalid-utf8'].includes(kind)) assert.equal(opens, 0);
  });
});

test('C87 held descriptor stays bounded during growth and closes after every rejected observation', async t => {
  for (const kind of ['ordinary', 'at-cap', 'growing', 'open-fifo-race', 'open-error', 'read-error', 'stat-error', 'after-stat-error', 'opened-type', 'opened-identity',
    'after-identity', 'after-mode', 'after-uid', 'after-links', 'after-size', 'path-replaced', 'parent-replaced', 'realpath-error', 'close-error']) await t.test(kind, async t => {
    const f = await diagnosticLog(t); let opens = 0, closes = 0, reads = 0, bytesRead = 0, stats = 0, after = false;
    const limit = 8 * 1024 * 1024;
    if (kind === 'at-cap') { const summary = await fs.readFile(f.path); await privateWrite(f.path, Buffer.concat([Buffer.alloc(limit - summary.length, 0x0a), summary])); }
    const io = { ...fs, realpath: async p => { if (kind === 'realpath-error') throw Error('synthetic'); return fs.realpath(p); },
      lstat: async p => {
        const s = await fs.lstat(p);
        if (after && kind === 'path-replaced' && p === f.path) s.ino++;
        if (after && kind === 'parent-replaced' && p === f.root) s.ino++;
        return s;
      },
      open: async (p, flags) => {
        assert.equal(p, f.path); assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK);
        if (kind === 'open-error') throw Error('synthetic');
        if (kind === 'open-fifo-race') {
          await fs.unlink(f.path); assert.equal(spawnSync('mkfifo', ['-m', '600', f.path], { env: { ...process.env } }).status, 0);
        }
        const h = await fs.open(p, flags); opens++;
        return { stat: async () => {
          const s = await h.stat(); stats++;
          if (kind === 'stat-error' || kind === 'after-stat-error' && stats > 1) throw Error('synthetic stat');
          if (kind === 'opened-type') s.isFile = () => false;
          if (kind === 'opened-identity' || stats > 1 && kind === 'after-identity') s.ino++;
          if (stats > 1 && kind === 'after-mode') s.mode ^= 0o040;
          if (stats > 1 && kind === 'after-uid') s.uid++;
          if (stats > 1 && kind === 'after-links') s.nlink++;
          if (stats > 1 && kind === 'after-size') s.size++;
          return s;
        }, read: async (buffer, offset, length, position) => {
          reads++; assert.ok(length > 0 && length <= 64 * 1024);
          if (kind === 'read-error') throw Error('synthetic');
          if (kind === 'growing') { buffer.fill(0x0a); bytesRead += length; return { bytesRead: length }; }
          const r = await h.read(buffer, offset, length, position); bytesRead += r.bytesRead;
          if (r.bytesRead === 0) after = true;
          return r;
        }, close: async () => { closes++; await h.close(); if (kind === 'close-error') throw Error('synthetic'); } };
      } };
    const { reader } = await diagnosticCLI(() => {}, io), value = await reader(f.bundle);
    if (['ordinary', 'at-cap'].includes(kind)) assert.ok(value?.declarations.length === 1);
    else assert.equal(value, null);
    assert.equal(closes, opens); assert.ok(bytesRead <= limit);
    if (kind === 'growing') { assert.equal(bytesRead, limit); assert.equal(reads, 128); assert.equal(stats, 2); }
    if (kind === 'open-fifo-race') assert.equal(reads, 0);
  });
});

test('C87 eligibility keeps generic injected writers and non-suite failures free of filesystem waits', async t => {
  for (const kind of ['injected', 'success', 'admission', 'reuse', 'open-child', 'not-spawned', 'zero-child', 'unknown-child', 'wrong-scope', 'getter']) await t.test(kind, async () => {
    const result = eligibleResult(); let calls = 0;
    if (kind === 'success') { result.code = 0; result.outcome.child.code = 0; }
    if (kind === 'admission') result.outcome.first_failure = 'admission';
    if (kind === 'reuse') result.outcome.consumed = false;
    if (kind === 'open-child') result.outcome.child.closed = false;
    if (kind === 'not-spawned') result.outcome.child.spawned = false;
    if (kind === 'zero-child') result.outcome.child.code = 0;
    if (kind === 'unknown-child') result.outcome.child.code = null;
    if (kind === 'wrong-scope') result.outcome.scope = 'unsupported';
    if (kind === 'getter') Object.defineProperty(result.outcome, 'scope', { get() { throw Error('synthetic private'); } });
    const { run: controlled } = await diagnosticCLI(async () => result, { ...fs, lstat: () => { calls++; return new Promise(() => {}); } });
    const output = captureDiagnostic();
    assert.equal(await controlled(['--bundle', '/private/control/suite-ready.json'], kind === 'injected' ? async () => result : undefined, output.stderr), result.code);
    assert.equal(calls, 0); assert.equal(output.writes(), kind === 'success' ? 0 : 1);
    if (kind !== 'success') assert.equal(JSON.parse(output.text().slice(diagnosticPrefix.length)).reporter_text, null);
  });
});

test('C87 actual eligible projection preserves terminals, privacy and the 1024 UTF8 byte cap', async t => {
  for (const kind of ['maximum', 'malformed-third', 'unavailable', 'signal', 'key-collision', 'file-collision', 'safe']) await t.test(kind, async t => {
    let text = reporterText({ failed: ['saved-history-active-rename.spec.mjs', 'skill-source-fidelity.spec.mjs', 'task-acceptance-warning.spec.mjs'],
      passed: 1_000_000, skipped: 1_000_000, didNotRun: 1_000_000, fatal: 1_000_000 }).replaceAll(':17:3', ':1000000:1000000');
    if (kind === 'malformed-third') text = text.replace('task-acceptance-warning.spec.mjs', 'unknown.spec.mjs');
    const f = await diagnosticLog(t, text), result = eligibleResult(), env = { ...process.env };
    const descriptors = Object.getOwnPropertyDescriptors(process), before = { ...process.env }, global = Object.getOwnPropertyDescriptor(globalThis, 'process');
    if (kind === 'maximum') result.code = result.outcome.child.code = Number.MAX_SAFE_INTEGER;
    if (kind === 'signal') { result.code = result.outcome.child.code = null; result.signal = result.outcome.child.signal = 'SIGTERM'; }
    if (kind === 'key-collision') env.SYNTHETIC_TOKEN = 'declarations';
    if (kind === 'file-collision') env.SYNTHETIC_TOKEN = 'web/e2e/saved-history-active-rename.spec.mjs';
    if (kind === 'safe') env.SYNTHETIC_TOKEN = 'synthetic-nonoverlap-private-value';
    if (kind === 'unavailable') await fs.unlink(f.path);
    const { run: controlled } = await diagnosticCLI(async () => result, fs, env), output = captureDiagnostic(), terminated = [];
    assert.equal(await controlled(['--bundle', f.bundle], undefined, output.stderr, s => terminated.push(s)), result.signal ? 1 : result.code);
    assert.deepEqual(terminated, result.signal ? ['SIGTERM'] : []);
    assert.equal(output.writes(), 1); assert.equal(output.stderr.listenerCount('error'), 0);
    assert.ok(Buffer.byteLength(output.text(), 'utf8') <= 1024); assert.equal(output.text().split('\n').length, 2);
    if (kind.endsWith('-collision')) assert.equal(output.text(), diagnosticFallback);
    else {
      const p = JSON.parse(output.text().slice(diagnosticPrefix.length)); assert.deepEqual(p.terminal, { code: result.code, signal: result.signal });
      if (['malformed-third', 'unavailable'].includes(kind)) assert.equal(p.reporter_text, null);
      else { assert.equal(p.reporter_text.declarations.length, 3); assert.equal(p.reporter_text.truncated, false); assert.equal(p.reporter_text.counts.fatal_errors, 1_000_000); }
    }
    assert.ok(isDeepStrictEqual({ ...process.env }, before), 'Real environment is unchanged.');
    const currentDescriptors = Object.getOwnPropertyDescriptors(process), own = Reflect.ownKeys(descriptors);
    assert.ok(Reflect.ownKeys(currentDescriptors).length === own.length && own.every(k => Object.hasOwn(currentDescriptors, k)
      && isDeepStrictEqual(currentDescriptors[k], descriptors[k])), 'All own keys and symbols are unchanged.');
    assert.ok(isDeepStrictEqual(Object.getOwnPropertyDescriptor(globalThis, 'process'), global), 'Global descriptor is unchanged.');
  });
});

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
  let terminated = null, signalDiagnostic = '';
  assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async () => ({ code: null, signal: 'SIGTERM' }),
    { write(text, done) { signalDiagnostic += text; done(); } }, signal => { terminated = signal; }), 1);
  assert.equal(signalDiagnostic, diagnosticFallback);
  assert.equal(terminated, 'SIGTERM');
  let diagnostic = '';
  assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async () => { throw Error('synthetic private failure'); },
    { write: text => { diagnostic += text; } }), 1);
  assert.equal(diagnostic, 'browser_suite_launch: launch control failed; consumed records are retained.\n');
  const before = { ...process.env }; let selected, missingDiagnostic = '';
  assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async input => { selected = input; return { code: 7, signal: null }; },
    { write(text, done) { missingDiagnostic += text; done(); } }), 7);
  assert.equal(missingDiagnostic, diagnosticFallback);
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
    }, { write(text, done) { diagnostic += text; done(); } }, s => { listeners(f); terminated.push(s); });
    assert.equal(launchCalls, 1); assert.equal(f.calls.length, 1); assert.equal(diagnostic, diagnosticLine(result));
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
    let reused, reuseDiagnostic = '';
    assert.equal(await run(['--bundle', f.bundle], async input => { reused = await launchBrowserSuite(input, f.io); return reused; },
      { write(text, done) { reuseDiagnostic += text; done(); } }, () => assert.fail('Reuse must not terminate.')), 1);
    assert.equal(reuseDiagnostic, diagnosticLine(reused));
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

test('C85 actual CLI reports child terminals without inferring case results and reuse without new consumption', async t => {
  for (const kind of ['one', 'seven', 'signal', 'error', 'unknown', 'throw', 'no-spawn']) await t.test(kind, async t => {
    const f = await fixture(t), original = await fs.readFile(f.bundle);
    if (kind === 'throw') f.io.spawn = () => { throw Error('synthetic start'); };
    else if (kind === 'no-spawn') f.io.spawn = () => {
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
      queueMicrotask(() => c.emit('close', null, null)); return c;
    };
    else during(f, c => { if (kind === 'error') c.emit('error', Error('synthetic child')); },
      { one: 1, seven: 7, signal: null, error: 0, unknown: null }[kind], kind === 'signal' ? 'SIGTERM' : null);
    const result = await cliFailure(f);
    assert.equal(result.code, { one: 1, seven: 7, signal: null, error: 1, unknown: 1, throw: 1, 'no-spawn': 1 }[kind]);
    assert.equal(result.outcome.first_failure, 'child');
    assert.equal(result.outcome.consumed, true);
    assert.equal(result.outcome.child.closed, kind !== 'throw');
    assert.equal(result.outcome.child.spawned, !['throw', 'no-spawn'].includes(kind));
    assert.equal(result.outcome.child.error_observed, kind === 'error');
    const guard = await fs.readFile(f.data.planned.guard), count = f.calls.length;
    const reused = await cliFailure(f);
    assert.equal(reused.outcome.consumed, false); assert.equal(reused.outcome.first_failure, 'admission');
    assert.equal(f.calls.length, count); assert.deepEqual(await fs.readFile(f.data.planned.guard), guard);
    assert.deepEqual(await fs.readFile(f.bundle), original);
  });
});

test('C85 actual CLI reports admission and consumed control failures with child-zero late failures', async t => {
  for (const kind of ['admission', 'guard', 'outer', 'stop', 'readback', 'marker', 'outcome']) await t.test(kind, async t => {
    const f = await fixture(t); let acquired = false;
    if (kind === 'admission') f.env.WI_C3A_FIXTURE = 'synthetic invalid';
    f.io.io = {
      open: async (p, ...args) => {
        if (kind === 'guard' && p === f.data.planned.guard || kind === 'outer' && p === f.data.planned.outer) throw Error('synthetic control');
        const h = await fs.open(p, ...args);
        if (p === f.data.planned.guard) acquired = true;
        if (kind === 'stop' && p === f.data.planned.outer) f.bus.emit('SIGINT');
        return h;
      },
      lstat: async p => {
        if (kind === 'readback' && f.calls.length && p === f.output) throw Error('synthetic readback');
        return fs.lstat(p);
      },
      writeFile: async (p, ...args) => {
        if (kind === 'outcome' && p.endsWith('launch-outcome.json')) throw Error('synthetic outcome');
        return fs.writeFile(p, ...args);
      },
    };
    if (kind === 'marker') during(f, () => marker(f, 'case/c57/CASE.once', 'wrong\n'));
    const r = await cliFailure(f);
    assert.equal(r.code, 1); assert.equal(r.outcome.consumed, acquired);
    assert.equal(r.outcome.first_failure, { admission: 'admission', guard: 'guard', outer: 'outer', stop: 'stop_before_dispatch',
      readback: 'post_readback', marker: 'markers', outcome: 'outcome_record' }[kind]);
    const dispatched = ['readback', 'marker', 'outcome'].includes(kind);
    assert.equal(r.outcome.child.spawned, dispatched); assert.equal(r.outcome.child.closed, dispatched);
    assert.equal(r.outcome.child.code, dispatched ? 0 : null); assert.equal(f.calls.length, dispatched ? 1 : 0);
    if (acquired) assert.ok(await fs.lstat(f.data.planned.guard)); else await absent(f.data.planned.guard);
  });
});

test('C85 projection excludes dynamic private data and maps unsupported observations to null or unknown', async t => {
  const secret = createHash('sha256').update(String(performance.now())).digest('base64') + '/\n私';
  const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
  const base = () => ({ code: 7, signal: null, outcome: { consumed: true, first_failure: 'child',
    child: { spawned: true, closed: true, error_observed: false, code: 7, signal: null } } });
  for (const kind of ['ordinary', 'missing', 'unsupported', 'unknown-signal', 'large', 'getter', 'changing-stage', 'no-outcome']) await t.test(kind, async () => {
    const r = base(); let reads = 0;
    r.private = { path: secret, pid: 123, argv: variants, streams: variants, assertion: secret };
    r.outcome.markers = variants; r.outcome.child.identity = secret;
    Object.defineProperty(r.outcome, 'neverRead', { enumerable: true, get() { throw Error('Projection must not enumerate outcome.'); } });
    if (kind === 'missing') { delete r.outcome.consumed; delete r.outcome.first_failure; delete r.outcome.child; }
    if (kind === 'unsupported') {
      r.outcome.consumed = 0; r.outcome.first_failure = secret;
      r.outcome.child = { spawned: 1, closed: 'true', error_observed: {}, code: -1, signal: 42 };
    }
    if (kind === 'unknown-signal') r.outcome.child.signal = secret;
    if (kind === 'large') { r.outcome.first_failure = secret.repeat(10000); r.outcome.child.code = Number.MAX_SAFE_INTEGER; }
    if (kind === 'getter') Object.defineProperty(r.outcome, 'consumed', { get() { throw Error(secret); } });
    if (kind === 'changing-stage') Object.defineProperty(r.outcome, 'first_failure', { get() { return ++reads === 1 ? 'child' : secret; } });
    if (kind === 'no-outcome') delete r.outcome;
    const output = captureDiagnostic(); let launches = 0;
    assert.equal(await run(['--bundle', '/private/control/suite-ready.json'], async () => { launches++; return r; }, output.stderr), 7);
    assert.equal(launches, 1); assert.equal(output.writes(), 1); assert.equal(output.stderr.listenerCount('error'), 0);
    const text = output.text(); assert.ok(Buffer.byteLength(text) <= 1024); assert.equal(text.split('\n').length, 2);
    for (const value of variants) assert.ok(!text.includes(value), 'No dynamic fixture secret or its encodings may pass projection.');
    if (['getter', 'no-outcome'].includes(kind)) assert.equal(text, diagnosticFallback);
    else {
      const actual = JSON.parse(text.slice(diagnosticPrefix.length));
      assert.deepEqual(Object.keys(actual), ['version', 'scope', 'consumed', 'first_failure', 'child', 'terminal', 'reporter_text']);
      assert.equal(actual.reporter_text, null);
      assert.deepEqual(actual.terminal, { code: 7, signal: null });
      if (['missing', 'unsupported'].includes(kind)) {
        assert.equal(actual.consumed, null); assert.equal(actual.first_failure, null);
        assert.deepEqual(actual.child, { spawned: null, closed: null, error_observed: null, code: null, signal: null });
      } else if (kind === 'unknown-signal') assert.equal(actual.child.signal, 'unknown');
      else if (kind === 'large') { assert.equal(actual.first_failure, null); assert.equal(actual.child.code, Number.MAX_SAFE_INTEGER); }
      else if (kind === 'changing-stage') { assert.equal(actual.first_failure, 'child'); assert.equal(reads, 1); }
      else assert.equal(text, diagnosticLine(r));
    }
  });
});

function diagnosticCollision(kind) {
  const script = `import assert from 'node:assert/strict'; import * as fs from 'node:fs/promises';
    import {tmpdir} from 'node:os'; import {basename,dirname,join} from 'node:path';
    import {createHash} from 'node:crypto'; import {EventEmitter} from 'node:events';
    import {PassThrough,Writable} from 'node:stream'; import {isDeepStrictEqual} from 'node:util';
    import {prepareBrowserSuite} from './web/test-support/browser-suite-preparation.mjs';
    import {recordPreparationCommand} from './web/test-support/browser-fixture-preparation.mjs';
    import {launchBrowserSuite} from './web/test-support/browser-suite-launch.mjs';
    import {run} from './web/scripts/launch-browser-suite.mjs';
    import {ROOT,TARGET,CHILD} from './web/test-support/live-commit-native.mjs';
    const hash=${hash},clone=${clone},load=${load},fixture=${fixture},privateWrite=${privateWrite},during=${during};
    const diagnosticFallback=${JSON.stringify(diagnosticFallback)},diagnosticPrefix=${JSON.stringify(diagnosticPrefix)},diagnosticLine=${diagnosticLine};
    const real=globalThis.process,descriptor=Object.getOwnPropertyDescriptor(globalThis,'process');
    const before={...real.env},fields=Object.getOwnPropertyDescriptors(real),cleanups=[];
    const env=Object.fromEntries(['TMPDIR','CARGO_TARGET_DIR','RUSTFLAGS','GIT_OPTIONAL_LOCKS','NODE_OPTIONS','PATH'].map(k=>[k,real.env[k]]));
    env.PATH='/synthetic/bin'; const facade=Object.create(real);
    Object.defineProperties(facade,{env:{value:env},execPath:{value:'/synthetic/bin/node'}});
    let f,result,text='',status,launches=0,terminated=[],removed=false;
    try {
      Object.defineProperty(globalThis,'process',{configurable:descriptor.configurable,enumerable:descriptor.enumerable,writable:true,value:facade});
      f=await fixture({after:fn=>cleanups.push(fn)});
      const kind=real.argv[1],secret={key:'error_observed',value:'invocation observations only',encoded:'\\x191',safe:'synthetic-nonoverlap-secret'}[kind];
      env.SYNTHETIC_TOKEN=secret; f.env.SYNTHETIC_TOKEN=secret;
      during(f,()=>{},kind==='encoded'?null:7,kind==='encoded'?'SIGTERM':null);
      const stderr=new Writable({write(chunk,encoding,done){text+=chunk.toString();done()}});
      status=await run(['--bundle',f.bundle],async input=>{launches++;result=await launchBrowserSuite(input,f.io);return result},stderr,s=>terminated.push(s));
      assert.equal(status,kind==='encoded'?1:7);assert.equal(launches,1);assert.equal(f.calls.length,1);
      assert.equal(result.outcome.consumed,true);assert.equal(result.outcome.child.closed,true);
      assert.ok(!text.includes(secret));assert.ok(Buffer.byteLength(text)<=1024);
      assert.deepEqual(terminated,kind==='encoded'?['SIGTERM']:[]);
      assert.equal(stderr.listenerCount('error'),0);
      for(const s of ['SIGINT','SIGTERM','SIGHUP'])assert.equal(f.bus.listenerCount(s),0);
    } finally {
      Object.defineProperty(globalThis,'process',descriptor);
      for(const cleanup of cleanups.reverse())await cleanup();
    }
    const current=Object.getOwnPropertyDescriptors(real),own=Reflect.ownKeys(fields);
    const restored=isDeepStrictEqual(Object.getOwnPropertyDescriptor(globalThis,'process'),descriptor);
    const unchanged=isDeepStrictEqual({...real.env},before)&&Reflect.ownKeys(current).length===own.length
      &&own.every(k=>Object.hasOwn(current,k)&&isDeepStrictEqual(current[k],fields[k]));
    removed=await fs.lstat(f.parent).then(()=>false,e=>{if(e.code!=='ENOENT')throw e;return true});
    assert.ok(restored&&unchanged&&removed);
    console.log(JSON.stringify({restored,unchanged,removed,launches,status,fallback:text===diagnosticFallback,exact:text===diagnosticLine(result)}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, kind], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
  assert.ok(child.status === 0 && child.stderr === '', 'Isolated CLI collision must finish without scaffold errors.');
  return JSON.parse(child.stdout);
}

test('C85 actual CLI and launcher share isolated key value and encoded collision environments', async t => {
  for (const kind of ['key', 'value', 'encoded', 'safe']) await t.test(kind, () => {
    const r = diagnosticCollision(kind);
    assert.ok(r.restored && r.unchanged && r.removed); assert.equal(r.launches, 1);
    assert.equal(r.fallback, kind !== 'safe'); assert.equal(r.exact, kind === 'safe');
  });
});

test('C85 stderr write completion and failures preserve the original terminal and remove temporary listeners', async t => {
  for (const kind of ['success', 'throw', 'callback', 'event', 'event-only', 'delayed-success', 'delayed-callback', 'delayed-event']) {
    for (const code of [1, 7, null]) await t.test(`${kind}-${code ?? 'SIGTERM'}`, async () => {
      const signal = code === null ? 'SIGTERM' : null;
      const r = { code, signal, outcome: { consumed: true, first_failure: 'child',
        child: { spawned: true, closed: true, error_observed: false, code, signal } } };
      let started = false, finished = false, release, writes = 0, launches = 0, observedListener = false;
      const terminated = [];
      const ready = new Promise(resolve => { release = resolve; });
      let finishWrite;
      const stderr = new Writable({ highWaterMark: 1, write(chunk, encoding, done) {
        started = true; writes++; release(); observedListener = this.listenerCount('error') === 2;
        const complete = () => {
          finished = true;
          if (kind === 'event-only') { this.emit('error', Error('synthetic private stream')); return; }
          if (kind.endsWith('event')) { this.emit('error', Error('synthetic private stream')); done(); }
          else done(kind.endsWith('callback') ? Error('synthetic private callback') : undefined);
        };
        if (kind.startsWith('delayed-')) finishWrite = complete; else complete();
      } });
      const originalWrite = stderr.write;
      if (kind === 'throw') stderr.write = function () {
        writes++; started = true; release(); observedListener = this.listenerCount('error') === 2;
        throw Error('synthetic private write');
      };
      const errors = [], observer = () => { errors.push(stderr.listenerCount('error')); }; stderr.on('error', observer);
      const before = stderr.listeners('error'); let completed = false;
      const pending = run(['--bundle', '/private/control/suite-ready.json'], async () => { launches++; return r; }, stderr,
        s => { terminated.push({ signal: s, finished }); }).then(value => { completed = true; return value; });
      // An event-loop turn also lets the original silent CLI finish, so expected-red never hangs waiting for a write.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(started, true, 'A returned failure must attempt a diagnostic write.');
      await ready;
      if (kind.startsWith('delayed-')) {
        assert.equal(stderr.writableNeedDrain, true); assert.equal(completed, false); assert.deepEqual(terminated, []);
        finishWrite();
      }
      assert.equal(await pending, signal === null ? code : 1); assert.equal(launches, 1); assert.equal(writes, 1);
      assert.deepEqual(terminated, signal === null ? [] : [{ signal, finished: kind !== 'throw' }]);
      assert.equal(observedListener, true); assert.deepEqual(stderr.listeners('error'), before);
      assert.deepEqual(errors, ['callback', 'event', 'event-only', 'delayed-callback', 'delayed-event'].includes(kind) ? [2] : []);
      stderr.removeListener('error', observer); stderr.write = originalWrite; stderr.destroy();
    });
  }
});

test('C85 default self-signal follows a real delayed stderr completion in an isolated Node child', () => {
  const result = { code: null, signal: 'SIGTERM', outcome: { consumed: true, first_failure: 'child',
    child: { spawned: true, closed: true, error_observed: false, code: null, signal: 'SIGTERM' } } };
  const script = `import {Writable} from 'node:stream'; import {run} from './web/scripts/launch-browser-suite.mjs';
    const stderr=new Writable({highWaterMark:1,write(chunk,encoding,done){setImmediate(()=>process.stderr.write(chunk,done))}});
    await run(['--bundle','/private/control/suite-ready.json'],async()=>(${JSON.stringify(result)}),stderr);
    process.exitCode=99;`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
  assert.equal(child.error, undefined); assert.equal(child.status, null); assert.equal(child.signal, 'SIGTERM');
  assert.equal(child.stdout, ''); assert.equal(child.stderr, diagnosticLine(result));
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
