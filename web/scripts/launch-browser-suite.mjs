import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { launchBrowserSuite } from '../test-support/browser-suite-launch.mjs';
import { preparationRedactor, sanitizeRecord } from '../test-support/browser-fixture-preparation.mjs';

const fallback = 'browser_suite_launch: failure diagnostics unavailable.\n';
const stages = ['admission', 'guard', 'guard_recheck', 'outer', 'dispatch_recheck', 'stop_before_dispatch',
  'child', 'launch_receipt', 'post_readback', 'markers', 'final_readback', 'outcome_record'];
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2'];
const boolean = value => typeof value === 'boolean' ? value : null;
const code = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function signal(value) {
  if (typeof value !== 'string') return null;
  return signals.includes(value) ? value : 'unknown';
}
// Only tracked declaration identities can leave the private reporter-text boundary.
const reporterFiles = new Set([
  'cancellation', 'catalog-pagination', 'client-close-handoff', 'content-measurements', 'create-recovery',
  'display-app', 'display-measurements', 'display-view', 'interrupted-display-parity', 'joined', 'lifecycle-failure',
  'live-commit-measurements', 'presentation', 'rename-recovery', 'restart-display', 'rich-display-parity',
  'saved-history-active-rename', 'skill-source-fidelity', 'task-acceptance-unknown', 'task-acceptance-warning',
  'task-account-mismatch', 'task-active-conflict', 'task-disconnect-epoch', 'task-fixed-head', 'task-incomplete-history',
  'task-input-framing', 'task-input-rejection', 'task-recovery', 'task-reload-epoch', 'task-selection-epoch',
  'task-stale-history', 'task-unbound-history', 'tool-fidelity', 'upgrade-display-parity',
].map(name => `web/e2e/${name}.spec.mjs`));
const reporterLimit = 8 * 1024 * 1024;
const reporterInteger = text => /^[1-9][0-9]{0,6}$/.test(text) && Number(text) <= 1_000_000;
function parseReporterText(text) {
  // These are the pinned line reporter's CSI operations, not a general terminal emulator.
  const normalized = text.replace(/\x1b\[(?:[0-9]+(?:;[0-9]+)*)?[mAKG]/g, '').replace(/\r\n?/g, '\n');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized)) return null;
  const lines = normalized.trimEnd().split('\n');
  const start = lines.findIndex(line => /^  \S+ (?:failed|interrupted|flaky|skipped|did not run|passed|errors?\b)/.test(line));
  if (start < 0) return null;
  // A declaration header without its category count makes the summary partial or ambiguous.
  if (lines.slice(0, start).some(line => /^    \S+:\S+:\S+ › /.test(line))) return null;
  const categories = ['failed', 'interrupted', 'flaky', 'skipped', 'did not run', 'passed'];
  const counts = { failed: 0, interrupted: 0, flaky: 0, skipped: 0, did_not_run: 0, passed: 0, fatal_errors: 0 };
  const declarations = [], seen = new Set();
  let index = start, last = -1;
  while (index < lines.length) {
    const line = lines[index++];
    const fatal = /^  ([1-9][0-9]{0,6}) (error was|errors were) not a part of any test, see above for details$/.exec(line);
    if (fatal) {
      if (!reporterInteger(fatal[1]) || (Number(fatal[1]) === 1) !== (fatal[2] === 'error was')
        || index !== lines.length || counts.failed + counts.interrupted + counts.flaky + counts.passed === 0) return null;
      counts.fatal_errors = Number(fatal[1]); break;
    }
    const summary = /^  ([1-9][0-9]{0,6}) (failed|interrupted|flaky|skipped|did not run|passed)(?: \(([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)\))?$/.exec(line);
    if (!summary || !reporterInteger(summary[1])) return null;
    const category = summary[2], rank = categories.indexOf(category);
    if (rank <= last || (category === 'passed') !== (summary[3] !== undefined)
      || summary[3] !== undefined && (!Number.isFinite(Number(summary[3])) || Number(summary[3]) > 1_000_000_000)) return null;
    last = rank; counts[category.replaceAll(' ', '_')] = Number(summary[1]);
    if (rank > 2) continue;
    // Check every header before limiting the public array. A bad third header still rejects.
    for (let n = 0; n < Number(summary[1]); n++) {
      const header = /^    (web\/e2e\/[^ :]+):([1-9][0-9]{0,6}):([1-9][0-9]{0,6}) › .+$/.exec(lines[index++] ?? '');
      if (!header || !reporterFiles.has(header[1]) || !reporterInteger(header[2]) || !reporterInteger(header[3])) return null;
      const key = header.slice(1, 4).join(':');
      if (seen.has(key)) return null;
      seen.add(key); declarations.push({ category, file: header[1], line: Number(header[2]), column: Number(header[3]) });
    }
  }
  return { scope: 'reporter text only; unauthenticated', counts, declarations: declarations.slice(0, 2), truncated: declarations.length > 2 };
}
async function readReporterText(bundle) {
  let handle;
  try {
    const control = dirname(bundle), root = dirname(control), parents = [dirname(root), root, control];
    const directory = async path => {
      const s = await fs.lstat(path);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700
        || await fs.realpath(path) !== path) throw Error();
      return [s.dev, s.ino, s.mode, s.uid];
    };
    const parentsBefore = await Promise.all(parents.map(directory));
    const path = join(control, 'launch.stdout');
    const regular = s => s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid()
      && (s.mode & 0o7777) === 0o600 && s.nlink === 1 && Number.isSafeInteger(s.size) && s.size >= 0 && s.size <= reporterLimit;
    const pin = s => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size];
    const before = await fs.lstat(path);
    if (!regular(before) || await fs.realpath(path) !== path) return null;
    // NONBLOCK also protects the open if a regular path is replaced by a FIFO after lstat.
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!regular(opened) || !isDeepStrictEqual(pin(before), pin(opened))) return null;
    const chunks = []; let total = 0;
    while (total < reporterLimit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, reporterLimit - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      total += bytesRead;
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), current = await fs.lstat(path);
    if (!regular(after) || !regular(current) || !isDeepStrictEqual(pin(before), pin(after))
      || !isDeepStrictEqual(pin(before), pin(current)) || total !== before.size || await fs.realpath(path) !== path
      || !isDeepStrictEqual(parentsBefore, await Promise.all(parents.map(directory)))) return null;
    const bytes = Buffer.concat(chunks, total);
    return isUtf8(bytes) ? parseReporterText(bytes.toString('utf8')) : null;
  } catch { return null; }
  finally { try { await handle?.close(); } catch { return null; } }
}
function failureDiagnostic(result, reporterText) {
  try {
    const outcome = result.outcome;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return fallback;
    const child = outcome.child, firstFailure = outcome.first_failure;
    // Project observations only. Never enumerate the private outcome or infer case results.
    const projection = { version: 1, scope: 'invocation observations only', consumed: boolean(outcome.consumed),
      first_failure: stages.includes(firstFailure) ? firstFailure : null,
      child: { spawned: boolean(child?.spawned), closed: boolean(child?.closed), error_observed: boolean(child?.error_observed),
        code: code(child?.code), signal: signal(child?.signal) },
      terminal: { code: code(result.code), signal: signal(result.signal) }, reporter_text: reporterText };
    // Limit coordinates, never serialized JSON. Preserve terminal facts if a projection is too large.
    while (projection.reporter_text?.declarations.length && Buffer.byteLength('browser_suite_launch: failure ' + JSON.stringify(projection) + '\n') > 1024) {
      projection.reporter_text.declarations.pop(); projection.reporter_text.truncated = true;
    }
    if (!isDeepStrictEqual(sanitizeRecord(projection, preparationRedactor(process.env)), projection)) return fallback;
    const line = 'browser_suite_launch: failure ' + JSON.stringify(projection) + '\n';
    return Buffer.byteLength(line, 'utf8') <= 1024 ? line : fallback;
  } catch { return fallback; }
}
async function writeDiagnostic(stderr, line) {
  let onError;
  try {
    await new Promise(resolve => {
      let scheduled = false;
      const complete = () => {
        // Writable can emit error after its callback. Keep the observer through that turn.
        if (!scheduled) { scheduled = true; setImmediate(resolve); }
      };
      onError = complete;
      stderr.on?.('error', onError);
      try { stderr.write(line, complete); } catch { complete(); }
    });
  } catch { /* Failed diagnostics must not replace the known terminal. */ }
  finally { try { stderr.removeListener?.('error', onError); } catch {} }
}

export async function run(argv, launch = launchBrowserSuite, stderr = process.stderr,
  terminate = signal => process.kill(process.pid, signal)) {
  if (argv.length !== 2 || argv[0] !== '--bundle' || typeof argv[1] !== 'string' || !argv[1].isWellFormed()
    || argv[1].includes('\0') || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]
    || basename(argv[1]) !== 'suite-ready.json' || basename(dirname(argv[1])) !== 'control') {
    stderr.write('browser_suite_launch: invalid invocation.\n'); return 2;
  }
  try {
    const result = await launch({ bundle: argv[1] });
    if (result.code !== 0 || result.signal !== null) {
      let reporterText = null;
      try {
        const outcome = result.outcome, child = outcome?.child;
        // Generic injected writer controls must not wait on filesystem work.
        if (launch === launchBrowserSuite && outcome?.scope === 'one-use suite launch observation only'
          && outcome.consumed === true && outcome.first_failure === 'child' && child?.spawned === true && child.closed === true
          && (code(child.code) > 0 || signal(child.signal) !== null)) reporterText = await readReporterText(argv[1]);
      } catch { /* Optional observations cannot replace the primary terminal. */ }
      await writeDiagnostic(stderr, failureDiagnostic(result, reporterText));
    }
    if (result.signal !== null) {
      // The launcher has finished safe recording and removed its temporary signal listeners.
      terminate(result.signal); return 1;
    }
    return result.code;
  } catch {
    stderr.write('browser_suite_launch: launch control failed; consumed records are retained.\n'); return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
