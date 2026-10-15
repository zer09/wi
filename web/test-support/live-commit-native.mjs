import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, readlink, realpath, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const CHILD = 'providers::openai_codex::tests::replay_loopback_tests::http_api_joined::live_commit::child';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const TARGET = process.env.CARGO_TARGET_DIR || join(ROOT, 'target');
export const CARGO_ARGS = Object.freeze(['test', '--locked', '--offline', '--lib', '--no-run', '--message-format=json']);
export const texts = Object.freeze({ task: 'Give one short answer.', first: 'one 雪', delta: ' +🙂', append: 'one 雪 +🙂', final: 'one 雪 +🙂 final' });
export const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Error('Live native rejected'); };
const same = (a, b) => { if (!isDeepStrictEqual(a, b)) fail(); };
const keys = (v, names) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); same(Object.keys(v).sort(), [...names].sort()); };
const uint = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => uint(n) && n > 0;
const id = n => positive(n) && n <= 0xffffffff;
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s) && s !== '00000000-0000-0000-0000-000000000000';
export const workKeys = Object.freeze(['auth_loads', 'auth_prepares', 'provider_opens', 'model_requests', 'connections', 'wire_requests', 'prepared_exact', 'completed', 'tool_validations', 'tool_executions']);
export function workProof(value, stage) {
  keys(value, workKeys);
  if (![0, 1, 2].includes(stage)) fail();
  for (const key of workKeys) {
    let expected = 0;
    if (stage > 0 && !['tool_validations', 'tool_executions', 'completed'].includes(key)) expected = 1;
    if (stage === 2 && key === 'completed') expected = 1;
    if (value[key] !== expected) fail();
  }
  return true;
}
export function readersProof(v) {
  keys(v, ['opened', 'closed', 'active']);
  if (!uint(v.opened) || v.closed !== v.opened || v.active !== 0) fail();
  return true;
}
export function savedProof(v, kind, prior) {
  keys(v, ['session_id', 'run_id', 'entry_id', 'field_id', 'head', 'projection_head', 'generation', 'content_epoch', 'bytes', 'sha256', 'matches', 'provisional', 'entry_state', 'run_state', 'result_recorded', 'response_finished', 'run_finished', 'events_complete']);
  if (!uuid(v.session_id) || !uuid(v.run_id) || !/^e:[1-9][0-9]*:0$/.test(v.entry_id) || !hex(v.field_id)
    || ![v.head, v.projection_head, v.generation, v.content_epoch, v.bytes].every(positive) || v.head !== v.projection_head
    || v.generation > v.head || v.content_epoch > v.head || v.matches !== true || !['first', 'append', 'authoritative', 'terminal'].includes(kind)) fail();
  if (BigInt(v.entry_id.split(':')[1]) > BigInt(v.head)) fail();
  const text = texts[kind === 'authoritative' || kind === 'terminal' ? 'final' : kind];
  if (v.bytes !== Buffer.byteLength(text) || v.sha256 !== digest(text)) fail();
  const terminal = kind === 'terminal';
  // OutputItemFinished replaces the field but leaves the response entry in progress.
  if (v.result_recorded !== terminal || v.response_finished !== terminal || v.run_finished !== terminal
    || v.events_complete !== (terminal ? true : null) || v.run_state !== (terminal ? 'completed' : 'running')
    || v.provisional !== !terminal || v.entry_state !== (terminal ? 'completed' : 'in_progress')) fail();
  if (prior) {
    for (const key of ['session_id', 'run_id', 'entry_id', 'field_id', 'content_epoch']) if (v[key] !== prior[key]) fail();
    if (v.head <= prior.head || (kind === 'authoritative' ? v.generation <= prior.generation : v.generation !== prior.generation)) fail();
  }
  return true;
}

// Reject duplicate keys before JSON.parse discards them. Protocol strings need no escapes.
export function decode(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 16384 || !line.endsWith('\n') || line.includes('\\')) fail();
  let quoted = false, start = 0;
  const stack = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      quoted = !quoted;
      if (quoted) start = i + 1;
      else if (/^\s*:/.test(line.slice(i + 1))) {
        const set = stack.at(-1), key = line.slice(start, i);
        if (!(set instanceof Set) || set.has(key)) fail();
        set.add(key);
      }
    } else if (!quoted && (c === '{' || c === '[')) stack.push(c === '{' ? new Set() : null);
    else if (!quoted && (c === '}' || c === ']')) stack.pop();
  }
  try { return JSON.parse(line); } catch { fail(); }
}
export const nativePhases = Object.freeze(['setup_control', 'setup', 'ready_emit', 'control_receive', 'control_admission',
  'first_wire_receive', 'acceptance_read', 'acceptance_decode', 'task_match', 'provider_request_match', 'first_wire_reply',
  'settle', 'snapshot', 'saved_validation', 'first_emit', 'observed_first', 'arm', 'second', 'page', 'authoritative',
  'terminal', 'observed_terminal', 'stop', 'cleanup', 'stopped_emit']);
export const nodeBoundaries = Object.freeze(['protocol', 'parser', 'native_frame', 'input', 'stdout', 'stderr', 'spawn', 'identity',
  'ipc_write', 'timeout', 'close', 'input_end', 'retirement', 'signal', 'observer', 'startup', 'abandon']);
function failureReaders(v) {
  if (v === null) return;
  keys(v, ['opened', 'closed', 'active']);
  if (![v.opened, v.closed, v.active].every(n => uint(n) && n <= 1000000) || v.closed > v.opened || v.active !== v.opened - v.closed) fail();
}
export function nativeFailureProof(v) {
  keys(v, ['protocol', 'event', 'category', 'origin', 'phase', 'last_completed', 'readers']);
  if (v.protocol !== 1 || v.event !== 'failed' || v.category !== 'native_failure' || !['run', 'cleanup'].includes(v.origin)
    || !nativePhases.includes(v.phase) || v.last_completed !== null && !nativePhases.includes(v.last_completed)) fail();
  failureReaders(v.readers); return true;
}
export function nativeCleanupProof(v) {
  keys(v, ['protocol', 'event', 'outcome', 'readers']);
  if (v.protocol !== 1 || v.event !== 'failure_cleanup' || !['closed', 'failed'].includes(v.outcome)) fail();
  failureReaders(v.readers);
  if (v.outcome === 'closed' && v.readers !== null) readersProof(v.readers);
  return true;
}
const events = { first: 'first', observed_first: 'first_observed', arm: 'armed', second: 'captured', page: 'page', authoritative: 'authoritative', terminal: 'terminal', observed_terminal: 'complete', stop: 'stopping' };
export function protocol() {
  let phase = 'start', serial = 1, pending = null, saved = null, sid = null, page = 0, pages = 0;
  let stopping = false, complete = false, stopped = false, stage = 0;
  const captures = [];
  let nativeFailure = null, nativeCleanup = null;
  return {
    diagnostics: () => structuredClone({ native_failure: nativeFailure, native_cleanup: nativeCleanup }),
    send(command) {
      const names = ['id', 'command'];
      if (['observed_first', 'authoritative', 'terminal', 'observed_terminal'].includes(command.command)) names.push('observed');
      if (command.command === 'page') names.push('page');
      keys(command, names);
      if (nativeFailure || phase === 'start' || stopping || pending || stopped || !id(command.id) || command.id !== serial + 1 || !Object.hasOwn(events, command.command)) fail();
      const allowed = { first: 'first', observed_first: 'observed_first', arm: 'arm', second: 'second', page: 'page', authoritative: 'authoritative', terminal: 'terminal', observed_terminal: 'observed_terminal' };
      if (command.command !== 'stop' && phase !== allowed[command.command]) fail();
      if ('observed' in command) same(command.observed, saved);
      if (command.command === 'page' && (command.page !== page || page >= pages)) fail();
      serial = command.id;
      pending = command.command;
    },
    reply(v) {
      if (!v || typeof v !== 'object') fail();
      if (v.event === 'failed') {
        if (nativeFailure || stopped) fail();
        nativeFailureProof(v); nativeFailure = structuredClone(v); fail();
      }
      if (v.event === 'failure_cleanup') {
        if (!nativeFailure || nativeCleanup || stopped) fail();
        nativeCleanupProof(v); nativeCleanup = structuredClone(v); return;
      }
      if (nativeFailure) fail();
      if (phase === 'start') {
        keys(v, ['protocol', 'event', 'id', 'pid', 'origin', 'session_id', 'head', 'work']);
        if (v.protocol !== 1 || v.event !== 'ready' || v.id !== 1 || !id(v.pid) || !uuid(v.session_id) || v.head !== 1 || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(v.origin)) fail();
        const url = new URL(v.origin);
        if (url.origin !== v.origin || Number(url.port) > 65535) fail();
        workProof(v.work, 0); sid = v.session_id; phase = 'first'; return;
      }
      if (stopping && v.event === 'stopped') {
        keys(v, ['protocol', 'event', 'id', 'drained', 'readers']);
        if (v.protocol !== 1 || v.id !== serial || v.drained !== true || stopped) fail();
        readersProof(v.readers); stopped = true; return;
      }
      if (!pending || v.protocol !== 1 || v.id !== serial || v.event !== events[pending]) fail();
      const extra = [];
      if (['first', 'captured', 'authoritative', 'terminal'].includes(v.event)) extra.push('saved');
      if (['first', 'terminal', 'stopping'].includes(v.event)) extra.push('work');
      if (v.event === 'captured') extra.push('operation_id', 'pause_hits', 'reader_closed', 'readers', 'released', 'pages');
      if (v.event === 'page') extra.push('page', 'pages', 'rows');
      if (v.event === 'stopping') extra.push('complete');
      keys(v, ['protocol', 'event', 'id', ...extra]);
      if (v.event === 'first') {
        savedProof(v.saved, 'first'); if (v.saved.session_id !== sid) fail();
        saved = structuredClone(v.saved); workProof(v.work, 1); stage = 1; phase = 'observed_first';
      } else if (v.event === 'first_observed') phase = 'arm';
      else if (v.event === 'armed') phase = 'second';
      else if (v.event === 'captured') {
        savedProof(v.saved, 'append', saved); saved = structuredClone(v.saved);
        if (!uuid(v.operation_id) || v.pause_hits !== 1 || v.reader_closed !== true || v.released !== true || !positive(v.pages) || v.pages > 34) fail();
        readersProof(v.readers); if (v.readers.opened === 0) fail();
        pages = v.pages; phase = 'page';
      } else if (v.event === 'page') {
        if (v.page !== page || v.pages !== pages || !Array.isArray(v.rows) || v.rows.length === 0 || v.rows.length > 24 || v.rows.some(r => !Array.isArray(r) || !r.every(uint))) fail();
        captures.push(structuredClone(v)); page++;
        if (page === pages) { telemetryProof(captures); phase = 'authoritative'; }
      } else if (v.event === 'authoritative') { savedProof(v.saved, 'authoritative', saved); saved = structuredClone(v.saved); phase = 'terminal'; }
      else if (v.event === 'terminal') { savedProof(v.saved, 'terminal', saved); saved = structuredClone(v.saved); workProof(v.work, 2); stage = 2; phase = 'observed_terminal'; }
      else if (v.event === 'complete') { complete = true; phase = 'complete'; }
      else if (v.event === 'stopping') { if (v.complete !== complete) fail(); workProof(v.work, stage); stopping = true; }
      pending = null;
    },
    end() { if (nativeFailure || !stopped || pending) fail(); return true; },
  };
}
export function parser(onMessage) {
  let buffer = '', running = false, prefixed = false, ok = false, summary = false, ended = false, total = 0;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const consume = () => {
    while (buffer.includes('\n')) {
      let line = buffer.slice(0, buffer.indexOf('\n') + 1); buffer = buffer.slice(line.length);
      const prefix = `test ${CHILD} ... `;
      if (line.startsWith(prefix)) { if (!running || prefixed || ok) fail(); prefixed = true; line = line.slice(prefix.length); }
      if (line.startsWith('{')) {
        if (!running || !prefixed || ok || summary) fail();
        onMessage(decode(line));
      } else if (/^\s*$/.test(line)) { /* libtest blank separators */ }
      else if (line === 'running 1 test\n' && !running) running = true;
      else if (line === 'ok\n' && running && prefixed && !ok) ok = true;
      else if (/^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [0-9.]+s\n$/.test(line) && ok && !summary) summary = true;
      else fail();
    }
    if (Buffer.byteLength(buffer) > 16384) fail();
  };
  return {
    push(bytes) { if (ended || (total += bytes.length) > 1024 * 1024) fail(); buffer += utf8.decode(bytes, { stream: true }); consume(); },
    end() { if (ended) fail(); ended = true; buffer += utf8.decode(); consume(); if (buffer || !running || !prefixed || !ok || !summary) fail(); },
  };
}

export const projectionStages = Object.freeze(['run-row update', 'projector plus DisplayApplied hook tail', 'receipt/manifest/command work']);
export function telemetryProof(pages) {
  if (!Array.isArray(pages) || !positive(pages.length) || pages.length > 34) fail();
  const rows = [];
  for (let p = 0; p < pages.length; p++) {
    const v = pages[p];
    if (v.page !== p || v.pages !== pages.length || !Array.isArray(v.rows) || v.rows.length === 0 || v.rows.length > 24) fail();
    rows.push(...v.rows);
  }
  const lengths = [9, 6, 9, 4, 5];
  for (const r of rows) if (!Array.isArray(r) || !r.every(uint) || r.length !== lengths[r[0]]) fail();
  const headers = rows.filter(r => r[0] === 0), totals = rows.filter(r => r[0] === 1), work = rows.filter(r => r[0] === 4);
  const ops = rows.filter(r => r[0] === 3), intervals = rows.filter(r => r[0] === 2);
  if (headers.length !== 1 || totals.length !== 30 || new Set(totals.map(r => r[1])).size !== 30 || totals.some(r => r[1] > 29)
    || work.length !== 1 || ops.length > 512 || new Set(ops.map(r => r[1])).size !== ops.length || ops.some(r => !positive(r[1]) || r[2] > 2)
    || intervals.length > 256 || intervals.filter(r => r[7] === 1).length > 128) fail();
  const h = headers[0], window = h[2] - h[1];
  if (h[2] < h[1] || h[2] > 600000000 || h[6] !== 0 || h[7] !== 0) fail();
  for (const r of totals) if (r[4] > r[3] || r[5] > r[2]) fail();
  for (const r of intervals) if (r[1] > 29 || r[5] > r[6] || r[6] > window || r[7] > 1 || r[8] > 1 || (r[2] > 0 && !ops.some(o => o[1] === r[2]))) fail();
  const selected = ops.filter(r => r[2] === 1 && r[3] === 2);
  if (selected.length !== 1) fail();
  const op = selected[0][1], leaves = intervals.filter(r => r[2] === op && [20, 21, 22].includes(r[1]));
  same(leaves.map(r => r[1]), [20, 21, 21, 21, 22]);
  if (leaves.some(r => r[3] !== 0 || r[4] !== 2 || r[7] !== 0 || r[8] !== 0) || leaves.some((r, i) => i > 0 && leaves[i - 1][6] > r[5])) fail();
  for (const stage of [20, 21, 22]) {
    const t = totals.find(r => r[1] === stage), items = leaves.filter(r => r[1] === stage);
    if (t[2] !== items.length || t[5] !== 0 || t[3] !== items.reduce((s, r) => s + r[6] - r[5], 0)) fail();
  }
  const projection = leaves.slice(1, 4).map(r => r[6] - r[5]);
  return Object.freeze({ operation: op, delta: 2, canonical_insert_us: leaves[0][6] - leaves[0][5], projection_us: projection,
    projection_sum_us: projection.reduce((a, b) => a + b, 0), commit_us: leaves[4][6] - leaves[4][5], canonical_to_commit_us: leaves[4][6] - leaves[0][5],
    other_intervals: intervals.filter(r => !leaves.includes(r)).map(r => ({ stage: r[1], operation: r[2], read: r[3], delta: r[4], start_us: r[5], end_us: r[6], pending: r[7] === 1, clipped: r[8] === 1 })), window_us: window });
}

// This is a pure Cargo JSON resolver. Only the separately recorded offline build invokes Cargo.
export function artifactFromCargo(text) {
  const artifacts = []; let finished = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let v; try { v = JSON.parse(line); } catch { fail(); }
    if (finished) fail();
    if (v.reason === 'build-finished') { if (v.success !== true || ++finished !== 1) fail(); }
    if (v.reason === 'compiler-artifact' && v.target?.kind?.includes('lib') && v.profile?.test && v.executable) {
      if (v.target.name !== 'wi' || !isDeepStrictEqual(v.target.kind, ['lib']) || v.target.src_path !== join(ROOT, 'src/lib.rs')) fail();
      artifacts.push(v.executable);
    }
  }
  if (finished !== 1 || artifacts.length !== 1 || !new RegExp(`^${TARGET}/debug/deps/wi-[a-f0-9]+$`).test(artifacts[0])) fail();
  return artifacts[0];
}
export async function nativeSources() {
  const records = {};
  async function add(p) {
    const s = await lstat(join(ROOT, p));
    if (s.isSymbolicLink()) fail();
    if (s.isDirectory()) { for (const n of (await readdir(join(ROOT, p))).sort()) await add(`${p}/${n}`); }
    else if (s.isFile()) { const bytes = await readFile(join(ROOT, p)); records[p] = { sha256: digest(bytes), bytes: bytes.length, mode: s.mode & 0o7777 }; }
    else fail();
  }
  for (const p of ['Cargo.toml', 'Cargo.lock', 'src', 'tests', 'examples', 'web/dist', 'web/index.html', 'web/style.css']) await add(p);
  return records;
}
export async function bindCargoArtifact(cargoJson, compiledSources) {
  const executable = artifactFromCargo(cargoJson);
  same(await nativeSources(), compiledSources);
  const binding = { executable, sha256: digest(await readFile(executable)), selector: CHILD, sources: compiledSources, cargo_json: cargoJson };
  return nativeBinding(binding);
}
export function sourceProof(expected, current) {
  same(expected, current);
  return true;
}
export async function nativeBinding(expected) {
  keys(expected, ['executable', 'sha256', 'selector', 'sources', 'cargo_json']);
  if (typeof expected.cargo_json !== 'string' || artifactFromCargo(expected.cargo_json) !== expected.executable) fail();
  if (expected.selector !== CHILD || typeof expected.executable !== 'string' || !new RegExp(`^${TARGET}/debug/deps/wi-[a-f0-9]+$`).test(expected.executable)
    || await realpath(expected.executable) !== expected.executable || !(await lstat(expected.executable)).isFile() || !hex(expected.sha256)
    || digest(await readFile(expected.executable)) !== expected.sha256) fail();
  sourceProof(expected.sources, await nativeSources());
  return structuredClone(expected);
}
async function privateDirectory(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o7777) !== 0o700 || s.uid !== process.getuid() || await realpath(path) !== path) fail();
  return s;
}
export async function createRoot(parent) {
  await privateDirectory(parent);
  const root = await mkdtemp(join(parent, 'wi-live-commit-')), owner = randomBytes(32).toString('hex');
  // A partial root is retained. A name alone never grants authority over an occupied path.
  for (const n of ['workspace', 'private-skills', 'child']) await mkdir(join(root, n), { mode: 0o700 });
  for (const n of ['home', 'xdg', 'codex', 'tmp']) await mkdir(join(root, 'child', n), { mode: 0o700 });
  await writeFile(join(root, 'owner'), owner, { mode: 0o600, flag: 'wx' });
  const s = await lstat(root); return { root, owner, device: s.dev, inode: s.ino };
}
export async function rootProof(f) {
  keys(f, ['root', 'owner', 'device', 'inode']);
  if (!isAbsolute(f.root) || !basename(f.root).startsWith('wi-live-commit-') || !hex(f.owner)) fail();
  const s = await privateDirectory(f.root); if (s.dev !== f.device || s.ino !== f.inode) fail();
  for (const n of ['workspace', 'private-skills', 'child', 'child/home', 'child/xdg', 'child/codex', 'child/tmp']) await privateDirectory(join(f.root, n));
  const p = join(f.root, 'owner'), m = await lstat(p);
  if (!m.isFile() || m.isSymbolicLink() || m.nlink !== 1 || (m.mode & 0o7777) !== 0o600 || m.uid !== process.getuid() || await readFile(p, 'utf8') !== f.owner) fail();
  return true;
}
export async function processIdentity(pid) {
  if (!id(pid)) fail();
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(parts[1]), start_ticks: parts[19], executable: await readlink(`/proc/${pid}/exe`), cwd: await readlink(`/proc/${pid}/cwd`) };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; fail(); }
}
export function identityProof(v, pid, executable, cwd, parent = process.pid) {
  keys(v, ['pid', 'ppid', 'start_ticks', 'executable', 'cwd']);
  if (v.pid !== pid || !id(pid) || v.ppid !== parent || !/^[1-9][0-9]*$/.test(v.start_ticks) || v.executable !== executable || v.cwd !== cwd) fail();
  return true;
}
export function terminalProof(v) {
  if (!v.identity || v.closed !== true || v.input_ended !== true || v.stopped !== true || v.drained !== true || v.code !== 0 || v.signal !== null
    || v.stderr_bytes !== 0 || v.failure !== false || v.fallback !== false || v.retired !== true) fail();
  readersProof(v.readers); return true;
}
const bounded = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Live native timeout')), ms); })]); }
  finally { clearTimeout(timer); }
};
export async function launchNative({ fixture, binding, onDiagnostic }, overrides = {}) {
  const io = { spawn, identity: processIdentity, binding: nativeBinding, root: rootProof, bounded, ...overrides };
  await io.root(fixture); await io.binding(binding);
  const cwd = join(fixture.root, 'child'), p = protocol();
  const facts = { identity: null, closed: false, input_ended: false, stopped: false, drained: false, readers: null, code: null, signal: null, stderr_bytes: 0, failure: false, fallback: false, retired: false,
    first_boundary: null, native_failure: null, native_cleanup: null };
  let child = null, closed = null, pending = null, failure = null, next = 1, cleanupPromise = null, stopPromise = null;
  function notify(event) {
    try { onDiagnostic?.(event, structuredClone(facts)); }
    catch {
      failure ??= Error('Live native failed'); facts.failure = true; facts.first_boundary ??= 'observer';
      if (pending) { pending.reject(failure); pending = null; }
    }
  }
  const reject = boundary => {
    failure ??= Error('Live native failed'); facts.failure = true; facts.first_boundary ??= boundary;
    if (pending) { pending.reject(failure); pending = null; }
    notify(boundary === 'native_frame' ? 'native_failed_frame' : 'node_failure');
  };
  const feed = parser(message => {
    try {
      p.reply(message);
      if (message.event === 'failure_cleanup') { facts.native_cleanup = p.diagnostics().native_cleanup; notify('native_cleanup'); }
      else if (message.event === 'stopped') { facts.stopped = true; facts.drained = message.drained; facts.readers = structuredClone(message.readers); }
      else if (pending && pending.event === message.event && pending.id === message.id) { const w = pending; pending = null; w.resolve(message); }
      else fail();
    } catch {
      const diagnostic = p.diagnostics();
      if (diagnostic.native_failure && !facts.native_failure) { facts.native_failure = diagnostic.native_failure; reject('native_frame'); }
      else reject('protocol');
    }
  });
  const wait = (event, serial) => {
    if (failure) throw failure;
    if (pending || facts.closed) fail();
    return new Promise((resolve, reject) => { pending = { event, id: serial, resolve, reject }; });
  };
  async function currentSignal() {
    if (!facts.identity) return false;
    await io.root(fixture); await io.binding(binding);
    const now = await io.identity(child.pid);
    if (now === null || now.start_ticks !== facts.identity.start_ticks) return false;
    same(now, facts.identity); facts.fallback = true;
    return child.kill('SIGKILL');
  }
  async function endInput() {
    if (facts.input_ended) return;
    await new Promise((resolve, reject) => {
      try { child.stdin.end(error => error ? reject(Error('Live native input failed')) : resolve()); }
      catch { reject(Error('Live native input failed')); }
    });
    facts.input_ended = true;
  }
  async function cleanup() {
    cleanupPromise ??= (async () => {
      let bad = false;
      try { await io.bounded(endInput(), 5000); } catch { reject('input_end'); bad = true; }
      try { await io.bounded(closed, 5000); }
      catch { reject('timeout'); bad = true; try { await currentSignal(); await io.bounded(closed, 2000); } catch { reject('signal'); bad = true; } }
      try {
        if (!facts.identity) fail();
        const now = await io.identity(child.pid);
        facts.retired = now === null || now.start_ticks !== facts.identity.start_ticks;
        if (!facts.retired) fail();
      } catch { reject('retirement'); bad = true; }
      if (bad) throw failure;
    })();
    return cleanupPromise;
  }
  const request = async body => {
    if (failure) throw failure;
    if (facts.closed || !body || Object.hasOwn(body, 'id')) fail();
    const command = { ...body, id: next + 1 };
    p.send(command); next++;
    const promise = wait(events[body.command], command.id);
    try { child.stdin.write(JSON.stringify(command) + '\n', error => { if (error) reject('ipc_write'); }); } catch { reject('ipc_write'); }
    let reply;
    try { reply = await io.bounded(promise, 30000); } catch { reject('timeout'); throw failure; }
    if (failure) throw failure;
    return reply;
  };
  try {
    child = io.spawn(binding.executable, ['--ignored', '--exact', CHILD, '--nocapture', '--test-threads=1'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { HOME: join(cwd, 'home'), XDG_CONFIG_HOME: join(cwd, 'xdg'), CODEX_HOME: join(cwd, 'codex'), TMPDIR: join(cwd, 'tmp'), TMP: join(cwd, 'tmp'), TEMP: join(cwd, 'tmp') },
    });
    // Install close and pipe handlers before the first await after acquisition.
    closed = new Promise(resolve => child.once('close', (code, signal) => {
      facts.closed = true; facts.code = code; facts.signal = signal; notify('native_close');
      if (code !== 0 || signal !== null) reject('close');
      try { feed.end(); p.end(); if (pending) fail(); } catch { reject('close'); }
      resolve();
    }));
    child.stdin.on('error', () => reject('input')); child.stdout.on('error', () => reject('stdout')); child.stderr.on('error', () => reject('stderr'));
    child.stdout.on('data', bytes => { try { feed.push(bytes); } catch { reject('parser'); } });
    child.stderr.on('data', bytes => { facts.stderr_bytes += bytes.length; reject('stderr'); });
    const spawned = new Promise((resolve, rejectSpawn) => {
      child.once('spawn', resolve);
      child.once('error', () => { reject('spawn'); rejectSpawn(failure); });
    });
    try { await io.bounded(spawned, 5000); } catch { reject('spawn'); throw failure; }
    try {
      const candidate = await io.identity(child.pid);
      identityProof(candidate, child.pid, binding.executable, cwd);
      facts.identity = structuredClone(candidate);
    } catch { reject('identity'); throw failure; }
    const readyPromise = wait('ready', 1);
    try { child.stdin.write(JSON.stringify({ id: 1, root: fixture.root, owner: fixture.owner }) + '\n', error => { if (error) reject('ipc_write'); }); }
    catch { reject('ipc_write'); }
    let ready;
    try { ready = await io.bounded(readyPromise, 30000); } catch { reject('timeout'); throw failure; }
    if (ready.pid !== child.pid || failure) { reject('protocol'); throw failure; }
    return {
      origin: ready.origin, session_id: ready.session_id, head: ready.head, pid: child.pid, request,
      evidence: () => structuredClone(facts),
      stop() {
        stopPromise ??= (async () => {
          let error;
          try { await request({ command: 'stop' }); } catch (caught) { error = failure ?? caught; }
          try { await cleanup(); } catch (caught) { error ??= failure ?? caught; }
          if (error) throw error;
          await io.binding(binding); await io.root(fixture); terminalProof(facts);
          return structuredClone(facts);
        })();
        return stopPromise;
      },
      async abandon() { reject('abandon'); await cleanup(); return structuredClone(facts); },
    };
  } catch {
    reject('startup');
    if (child && closed) { try { await cleanup(); } catch { /* Retain the root and all failure facts. */ } }
    throw failure;
  }
}
export async function removeRoot(fixture, processes, binding, overrides = {}) {
  const io = { root: rootProof, binding: nativeBinding, identity: processIdentity, remove: rm, ...overrides };
  if (!Array.isArray(processes) || processes.length !== 1) fail();
  for (const p of processes) { terminalProof(p); identityProof(p.identity, p.identity.pid, binding.executable, join(fixture.root, 'child')); }
  await io.root(fixture); await io.binding(binding);
  for (const p of processes) {
    const now = await io.identity(p.identity.pid);
    if (now !== null && now.start_ticks === p.identity.start_ticks) fail();
  }
  await io.root(fixture); await io.remove(fixture.root, { recursive: true });
}
