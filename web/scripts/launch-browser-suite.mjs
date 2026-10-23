import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../test-support/live-commit-native.mjs';
import { launchBrowserSuite } from '../test-support/browser-suite-launch.mjs';
import { preparationRedactor, sanitizeRecord } from '../test-support/browser-fixture-preparation.mjs';
import { decodeReport, publicSummary, reportName } from '../test-support/browser-case-diagnostics.mjs';

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
// Source map 1: stable one-based IDs in this order. Reporter schema 2 tuples are
// [category ID (failed/interrupted/flaky), source ID, declaration line, column,
// reported same-spec frame [line, column] or null, reported stored [stage ID, check ID] or null].
// Frames can identify a wrapper. Stored checks can predate their stage. Neither identifies a failed assertion.
const reporterFiles = new Map([
  'cancellation', 'catalog-pagination', 'client-close-handoff', 'content-measurements', 'create-recovery',
  'display-app', 'display-measurements', 'display-view', 'interrupted-display-parity', 'joined', 'lifecycle-failure',
  'live-commit-measurements', 'presentation', 'rename-recovery', 'restart-display', 'rich-display-parity',
  'saved-history-active-rename', 'skill-source-fidelity', 'task-acceptance-unknown', 'task-acceptance-warning',
  'task-account-mismatch', 'task-active-conflict', 'task-disconnect-epoch', 'task-fixed-head', 'task-incomplete-history',
  'task-input-framing', 'task-input-rejection', 'task-recovery', 'task-reload-epoch', 'task-selection-epoch',
  'task-stale-history', 'task-unbound-history', 'tool-fidelity', 'upgrade-display-parity',
  'skill-history-replay',
].map((name, index) => [`web/e2e/${name}.spec.mjs`, index + 1]));
const handoffStages = ['startup', 'create', 'first-send', 'close-a', 'observer-connect', 'first-completion', 'later-explicit-send', 'reopened-a'];
const handoffChecks = ['outside', 'receipt', 'native', 'dto', 'handshake', 'order', 'assets', 'requests'];
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
  // Numbered blocks are optional observations. Only an exact, unique summary identity can own a block.
  const headers = [];
  for (let n = 0; n < start; n++) if (/^  [0-9]+\) /.test(lines[n])) headers.push(n);
  const blocks = new Map(), numbers = new Set(); let ambiguous = false;
  for (const [n, begin] of headers.entries()) {
    const header = /^  ([1-9][0-9]*)\) (web\/e2e\/[^ :]+):([1-9][0-9]{0,6}):([1-9][0-9]{0,6}) › .+ ─*$/.exec(lines[begin]);
    if (!header || numbers.has(header[1])) { ambiguous = true; continue; }
    numbers.add(header[1]);
    const key = header.slice(2, 5).join(':');
    if (!seen.has(key)) { ambiguous = true; continue; }
    const body = lines.slice(begin + 1, headers[n + 1] ?? start);
    if (blocks.has(key)) { blocks.set(key, null); continue; }
    blocks.set(key, body);
  }
  if (ambiguous) blocks.clear();
  for (const declaration of declarations) {
    declaration.reported_source_frame = null; declaration.reported_stored_handoff = null;
    const body = blocks.get([declaration.file, declaration.line, declaration.column].join(':'));
    if (!body) continue;
    // Admit one Error lead, then only snippets and stack frames. Unknown text can hide another error.
    const region = []; let supported = true, stackStarted = false;
    for (const line of body) {
      if (/^ *$/.test(line)) continue;
      if (region.length === 0 && /^    Error:/.test(line)) { region.push(line); continue; }
      if (region.length && /^        at (?:[^()]+ \([^()]+:[0-9]+:[0-9]+\)|[^()]+:[0-9]+:[0-9]+)$/.test(line)) {
        stackStarted = true; region.push(line); continue;
      }
      if (region.length && !stackStarted && /^    (?:[ >] *[0-9]+ \|.*| +\|[ ^~]*)$/.test(line)) { region.push(line); continue; }
      supported = false; break;
    }
    if (!supported || region.length === 0) continue;
    for (const line of region) {
      const frame = /^        at (?:[^()]+ \(([^()]+)\)|([^()]+))$/.exec(line);
      const location = frame && /^(.+):([1-9][0-9]{0,6}):([1-9][0-9]{0,6})$/.exec(frame[1] ?? frame[2]);
      if (location && [declaration.file, join(ROOT, declaration.file), pathToFileURL(join(ROOT, declaration.file)).href].includes(location[1])
        && reporterInteger(location[2]) && reporterInteger(location[3])) {
        declaration.reported_source_frame = { file: declaration.file, line: Number(location[2]), column: Number(location[3]) }; break;
      }
    }
    if (declaration.file === 'web/e2e/client-close-handoff.spec.mjs') {
      const stored = region.map(line => /^    Error: Client handoff failed: stage=([a-z-]+); check=([a-z-]+)$/.exec(line)).filter(Boolean);
      if (stored.length === 1 && handoffStages.includes(stored[0][1]) && handoffChecks.includes(stored[0][2]))
        declaration.reported_stored_handoff = { stage: stored[0][1], check: stored[0][2] };
    }
  }
  return { scope: 'reporter text only; unauthenticated', counts, declarations, truncated: false };
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
async function readCaseObservations(bundle) {
  const unavailable = { value: null, reason: 'schema_unavailable' };
  const limit = 1024 * 1024;
  let handle, bytes;
  try {
    const control = dirname(bundle), root = dirname(control), output = join(root, 'playwright-output');
    const parents = [dirname(root), root, control, output];
    const directory = async path => {
      const s = await fs.lstat(path), mode = s.mode & 0o7777;
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || await fs.realpath(path) !== path
        || (path === output ? ![0o700, 0o755].includes(mode) : mode !== 0o700)) throw Error();
      return [s.dev, s.ino, s.mode, s.uid];
    };
    const parentsBefore = await Promise.all(parents.map(directory));
    const path = join(output, reportName);
    const regular = s => s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid()
      && (s.mode & 0o7777) === 0o600 && s.nlink === 1 && Number.isSafeInteger(s.size) && s.size >= 0 && s.size <= limit;
    const pin = s => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs];
    const before = await fs.lstat(path);
    if (!regular(before) || await fs.realpath(path) !== path) return unavailable;
    // A path swapped for a FIFO must not block the failed child's diagnostics.
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!regular(opened) || !isDeepStrictEqual(pin(before), pin(opened))) return unavailable;
    const chunks = []; let total = 0;
    while (total < limit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) return unavailable;
      total += bytesRead;
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), current = await fs.lstat(path);
    if (!regular(after) || !regular(current) || !isDeepStrictEqual(pin(before), pin(after))
      || !isDeepStrictEqual(pin(before), pin(current)) || total !== before.size || await fs.realpath(path) !== path
      || !isDeepStrictEqual(parentsBefore, await Promise.all(parents.map(directory)))) return unavailable;
    bytes = Buffer.concat(chunks, total);
  } catch { return unavailable; }
  finally { try { await handle?.close(); } catch { return unavailable; } }
  // No observation can publish until descriptor closure also succeeds.
  try {
    if (!isUtf8(bytes)) return unavailable;
    const encoded = JSON.parse(bytes.toString('utf8'));
    decodeReport(encoded, preparationRedactor(process.env));
    return { value: encoded, reason: null };
  } catch (error) { return { value: null, reason: error.code === 'privacy_collision' ? 'privacy_collision' : 'schema_unavailable' }; }
}
function failureDiagnostic(result, reporterText, typed = null) {
  try {
    const outcome = result.outcome;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return fallback;
    const child = outcome.child, firstFailure = outcome.first_failure;
    // Project observations only. Never enumerate the private outcome or infer case results.
    const internal = { version: 1, scope: typed?.value
      ? 'invocation observations; onEnd-entry callback snapshot; unauthenticated' : 'invocation observations only', consumed: boolean(outcome.consumed),
      first_failure: stages.includes(firstFailure) ? firstFailure : null,
      child: { spawned: boolean(child?.spawned), closed: boolean(child?.closed), error_observed: boolean(child?.error_observed),
        code: code(child?.code), signal: signal(child?.signal) },
      terminal: { code: code(result.code), signal: signal(result.signal) }, reporter_text: reporterText };
    const redact = preparationRedactor(process.env);
    if (typed?.reason === 'privacy_collision') return fallback;
    if (typed?.value) {
      // Budget the complete terminal envelope. Add no fields after this call.
      const summary = publicSummary(typed.value, internal, redact);
      return summary.value === null ? fallback : 'browser_suite_launch: failure ' + JSON.stringify(summary.value) + '\n';
    }
    // Check every allowlisted name before IDs or byte omissions could hide a collision.
    if (!isDeepStrictEqual(sanitizeRecord(internal, redact), internal)) return fallback;
    const projection = { ...internal, reporter_text: reporterText === null ? null : {
      version: 2, source_map: 1, scope: reporterText.scope, counts: { ...reporterText.counts },
      declarations: reporterText.declarations.map(d => [['failed', 'interrupted', 'flaky'].indexOf(d.category) + 1,
        reporterFiles.get(d.file), d.line, d.column,
        d.reported_source_frame === null ? null : [d.reported_source_frame.line, d.reported_source_frame.column],
        d.reported_stored_handoff === null ? null : [handoffStages.indexOf(d.reported_stored_handoff.stage) + 1,
          handoffChecks.indexOf(d.reported_stored_handoff.check) + 1]]), truncated: false } };
    if (!isDeepStrictEqual(sanitizeRecord(projection, redact), projection)) return fallback;
    // Budget a prefix once, rather than repeatedly serializing a potentially large private summary.
    if (projection.reporter_text?.declarations.length && Buffer.byteLength('browser_suite_launch: failure ' + JSON.stringify(projection) + '\n') > 1024) {
      const declarations = projection.reporter_text.declarations;
      projection.reporter_text.declarations = []; projection.reporter_text.truncated = true;
      let bytes = Buffer.byteLength('browser_suite_launch: failure ' + JSON.stringify(projection) + '\n');
      for (const declaration of declarations) {
        const added = Buffer.byteLength(JSON.stringify(declaration)) + (projection.reporter_text.declarations.length ? 1 : 0);
        // The shorter spelling of true must not admit every tuple after the false form overflowed.
        if (projection.reporter_text.declarations.length === declarations.length - 1 || bytes + added > 1024) break;
        projection.reporter_text.declarations.push(declaration); bytes += added;
      }
    }
    if (!isDeepStrictEqual(sanitizeRecord(projection, redact), projection)) return fallback;
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
      let reporterText = null, typed = null;
      try {
        const outcome = result.outcome, child = outcome?.child;
        // Generic injected writer controls must not wait on filesystem work.
        if (launch === launchBrowserSuite && outcome?.scope === 'one-use suite launch observation only'
          && outcome.consumed === true && outcome.first_failure === 'child' && child?.spawned === true && child.closed === true
          && (code(child.code) > 0 || signal(child.signal) !== null)) {
          typed = await readCaseObservations(argv[1]);
          if (typed.value === null && typed.reason !== 'privacy_collision') reporterText = await readReporterText(argv[1]);
        }
      } catch { /* Optional observations cannot replace the primary terminal. */ }
      await writeDiagnostic(stderr, failureDiagnostic(result, reporterText, typed));
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
