import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { bounded, CHILD_TEST, ROOT } from './fixture.mjs';
import { data } from './presentation.mjs';
import { partialProof, freshHandshake } from './rich-display-parity.mjs';
import { decodeJson, validateTaskCommand, validateUuid } from '../dist/api.js';
import { validateConversationPage, validateEntryPage, validateTaskReconciliation, parseDisplayCursor } from '../dist/display-api.js';

const reject = () => { throw new Error('Restart display rejected'); };
const equal = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); return true; };
const keys = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  equal(Object.keys(value).sort(), [...names].sort());
};
const count = n => Number.isSafeInteger(n) && n >= 0;
const identifier = n => count(n) && n > 0 && n <= 0xffffffff;
export const workKeys = ['auth_loads', 'auth_prepares', 'provider_opens', 'model_requests', 'connections', 'wire_requests',
  'prepared_exact', 'tool_validations', 'tool_executions', 'completed', 'fresh_empty'];
export function workProof(work, phase) {
  keys(work, workKeys);
  if (!['produce', 'observe'].includes(phase)) reject();
  for (const key of workKeys) {
    if (key === 'fresh_empty') { if (work[key] !== (phase === 'produce')) reject(); }
    else if (!count(work[key]) || work[key] !== (phase === 'produce' && workKeys.indexOf(key) < 7 ? 1 : 0)) reject();
  }
  return work;
}
function originProof(origin) {
  if (typeof origin !== 'string') reject();
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 0 || url.origin !== origin) reject();
  return origin;
}
export function messageProof(value) {
  const fields = { ready: ['phase', 'pid', 'origin'], selected: ['id'], driven: ['id'], model_paused: ['gate'],
    sample: ['id', 'work'], stopped: ['id', 'work', 'drained'] };
  if (!value || !Object.hasOwn(fields, value.event)) reject();
  keys(value, ['protocol', 'event', ...fields[value.event]]);
  if (value.protocol !== 1) reject();
  if (value.event === 'ready') {
    if (!['produce', 'observe'].includes(value.phase) || !identifier(value.pid)) reject();
    originProof(value.origin);
  }
  if (Object.hasOwn(value, 'id') && !identifier(value.id)) reject();
  if (value.event === 'model_paused' && ![1, 2].includes(value.gate)) reject();
  if (value.event === 'stopped' && value.drained !== true) reject();
  if (Object.hasOwn(value, 'work')) {
    keys(value.work, workKeys);
    if (typeof value.work.fresh_empty !== 'boolean' || workKeys.slice(0, -1).some(key => !count(value.work[key]))) reject();
  }
  return value;
}

// JSON.parse hides duplicate names. Check decoded names at every object depth first.
export function closedJson(line) {
  let value;
  try { value = JSON.parse(line); } catch { reject(); }
  const stack = [];
  for (const token of line.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    const text = token[0];
    if (text === '{' || text === '[') stack.push(text === '{' ? new Set() : null);
    else if (text === '}' || text === ']') stack.pop();
    else if (/^\s*:/.test(line.slice(token.index + text.length))) {
      const names = stack.at(-1), name = JSON.parse(text);
      if (!names || names.has(name)) reject();
      names.add(name);
    }
  }
  return value;
}
export function restartParser(onMessage) {
  let pending = Buffer.alloc(0), total = 0, harness = 0, running = false, ok = false, summary = false, prefixed = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    push(chunk) {
      total += chunk.length;
      if (total > 64 * 1024) reject();
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end === -1) break;
        if (end > 4096) reject();
        let line;
        try { line = decoder.decode(pending.subarray(0, end)); } catch { reject(); }
        pending = pending.subarray(end + 1);
        const prefix = `test ${CHILD_TEST} ... `;
        if (line.startsWith(prefix)) {
          if (!running || prefixed || ok) reject();
          prefixed = true; line = line.slice(prefix.length);
        }
        if (line.startsWith('{')) {
          if (!running || ok || summary) reject();
          onMessage(messageProof(closedJson(line)));
        } else {
          if (++harness > 16) reject();
          if (line === '') continue;
          if (line === 'running 1 test' && !running) running = true;
          else if (line === 'ok' && running && prefixed && !ok) ok = true;
          else if (/^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [0-9.]+s$/.test(line)
            && ok && !summary) summary = true;
          else reject();
        }
      }
      if (pending.length > 4096) reject();
    },
    end(killed) { if (pending.length || !running || !prefixed || (killed ? ok || summary : !ok || !summary)) reject(); },
  };
}

export function restartProtocol(phase, pid) {
  if (!['produce', 'observe'].includes(phase) || !identifier(pid)) reject();
  let ready = false, selected = false, driven = false, gate = 0, last = 0, pending = null, stopped = false;
  return {
    request(value) {
      const fields = { select: ['session_id'], drive: ['gate'], sample: [], stop: [] };
      if (!value || !Object.hasOwn(fields, value.command) || !ready || pending || stopped) reject();
      keys(value, ['command', 'id', ...fields[value.command]]);
      if (!identifier(value.id) || value.id <= last) reject();
      if (value.command === 'select') { validateUuid(value.session_id); if (selected || gate) reject(); }
      if (value.command === 'drive' && (phase !== 'produce' || !selected || driven || gate !== 1 || value.gate !== 1)) reject();
      if (value.command === 'sample' && phase === 'produce' && (!selected || !driven || gate !== 2)) reject();
      if (value.command === 'stop' && (phase !== 'observe' || !selected)) reject();
      last = value.id; pending = value;
      return value;
    },
    reply(input) {
      const value = messageProof(input);
      if (stopped) reject();
      if (value.event === 'ready') {
        if (ready || value.phase !== phase || value.pid !== pid) reject();
        ready = true;
      } else if (!ready) reject();
      else if (value.event === 'model_paused') {
        if (phase !== 'produce' || !selected || value.gate !== gate + 1
          || (value.gate === 2 && !driven && pending?.command !== 'drive')) reject();
        gate = value.gate;
      } else {
        if (!pending || value.id !== pending.id || value.event !== ({ select: 'selected', drive: 'driven', sample: 'sample', stop: 'stopped' })[pending.command]) reject();
        if (value.event === 'selected') selected = true;
        if (value.event === 'driven') driven = true;
        if (value.work) workProof(value.work, phase);
        if (value.event === 'stopped') stopped = true;
        pending = null;
      }
      return value;
    },
    end(killed) { if (!ready || pending || (killed ? phase !== 'produce' || !selected || !driven || gate !== 2 || stopped : !stopped)) reject(); },
  };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function nativeBinding(executable) {
  if (!isAbsolute(executable) || await realpath(executable) !== executable || executable !== process.env.WI_C3A_FIXTURE
    || !(await lstat(executable)).isFile()) reject();
  const hash = sha(await readFile(executable));
  // Normal fixture discovery supplies only the path; a supplied digest is an extra assertion.
  if (process.env.WI_C47_FIXTURE_SHA256 !== undefined && hash !== process.env.WI_C47_FIXTURE_SHA256) reject();
  const sources = {};
  for (const [file, expected] of [
    ['src/providers/openai_codex/tests/replay/http_api_joined/browser.rs', 'c004f59271deb49716e2aeccdfbf4154813d99b15a4d74209bd379638a50fe06'],
    ['src/providers/openai_codex/tests/replay/http_api_joined/browser/restart.rs', 'a3f39f2a2e2a9248143d24766ce28a8764ba7442c216667801435dc9be641164'],
  ]) { sources[file] = sha(await readFile(join(ROOT, file))); if (sources[file] !== expected) reject(); }
  return { executable, sha256: hash, sources };
}
export async function createRestartRoot(parent) {
  if (arguments.length === 0) parent = tmpdir();
  else {
    // Explicit parents are caller-owned retention boundaries, never paths to create or repair.
    try {
      if (typeof parent !== 'string' || !parent.isWellFormed() || parent.includes('\0')
        || !isAbsolute(parent) || resolve(parent) !== parent) reject();
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
        || (info.mode & 0o7777) !== 0o700 || await realpath(parent) !== parent) reject();
    } catch { reject(); }
  }
  const root = await realpath(await mkdtemp(join(parent, 'wi-restart-')));
  try {
    for (const name of ['workspace', 'private-skills', 'produce', 'observe']) await mkdir(join(root, name));
    for (const phase of ['produce', 'observe']) for (const name of ['home', 'xdg', 'codex', 'tmp']) await mkdir(join(root, phase, name));
    const workspace = join(root, 'workspace'), skill = join(workspace, '.agents/skills/presentation');
    await mkdir(skill, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), 'private-project-browser\r\n', { flag: 'wx' });
    await writeFile(join(skill, 'SKILL.md'), `---\nname: presentation\ndescription: synthetic metadata\n---\n${data.tool}`, { flag: 'wx' });
    await writeFile(join(skill, 'script.sh'), 'private-support-script', { flag: 'wx' });
    await writeFile(join(skill, 'resource.txt'), 'private-support-resource', { flag: 'wx' });
    const owner = randomBytes(32).toString('hex');
    await writeFile(join(root, 'owner'), owner, { mode: 0o600, flag: 'wx' });
    const sourceHash = sha(await readFile(join(workspace, 'AGENTS.md')));
    return { root, workspace, owner, sourceHash };
  } catch { await rm(root, { recursive: true, force: true }); reject(); }
}
export async function rootProof(fixture, phase) {
  const { root, workspace, owner, sourceHash } = fixture;
  if (!['produce', 'observe'].includes(phase) || !isAbsolute(root) || !basename(root).startsWith('wi-restart-')
    || await realpath(root) !== root || workspace !== join(root, 'workspace') || !/^[0-9a-f]{64}$/.test(owner)
    || (await lstat(join(root, 'owner'))).mode % 512 !== 0o600 || (await readFile(join(root, 'owner'), 'utf8')) !== owner
    || sha(await readFile(join(workspace, 'AGENTS.md'))) !== sourceHash) reject();
  for (const [file, content] of [['SKILL.md', `---\nname: presentation\ndescription: synthetic metadata\n---\n${data.tool}`],
    ['script.sh', 'private-support-script'], ['resource.txt', 'private-support-resource']]) {
    if (await readFile(join(workspace, '.agents/skills/presentation', file), 'utf8') !== content) reject();
  }
  for (const name of ['workspace', 'private-skills', 'produce', 'observe', `${phase}/home`, `${phase}/xdg`, `${phase}/codex`, `${phase}/tmp`]) {
    const dir = join(root, name);
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) reject();
  }
  return true;
}
export async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8'), parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, start_ticks: parts[19], executable: await readlink(`/proc/${pid}/exe`), cwd: await readlink(`/proc/${pid}/cwd`) };
  } catch { return null; }
}
export function terminalProof(facts, killed) {
  if (!facts.closed || !facts.reaped || facts.stderr_bytes !== 0 || facts.error || facts.fallback
    || facts.code !== (killed ? null : 0) || facts.signal !== (killed ? 'SIGKILL' : null)
    || facts.expected_kill !== killed || facts.same_start_alive || (!killed && !facts.drained)) reject();
  return true;
}

export async function startRestartProcess(binding, fixture, phase) {
  await rootProof(fixture, phase);
  if (sha(await readFile(binding.executable)) !== binding.sha256) reject();
  const cwd = join(fixture.root, phase);
  const env = { WI_NATIVE_RESTART_CHILD: '1', HOME: join(cwd, 'home'), XDG_CONFIG_HOME: join(cwd, 'xdg'),
    CODEX_HOME: join(cwd, 'codex'), TMPDIR: join(cwd, 'tmp'), TMP: join(cwd, 'tmp'), TEMP: join(cwd, 'tmp') };
  const argv = ['--ignored', '--exact', CHILD_TEST, '--nocapture', '--test-threads=1'];
  const child = spawn(binding.executable, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const protocol = restartProtocol(phase, child.pid), queue = [], waiters = [], samples = [];
  const facts = { phase, pid: child.pid, identity: null, argv, cwd, env, closed: false, reaped: false, code: null, signal: null,
    stderr_bytes: 0, stdout_bytes: 0, stdout_sha256: null, stderr_sha256: null, expected_kill: false, fallback: false, error: false, drained: false, same_start_alive: true };
  const out = createHash('sha256'), err = createHash('sha256');
  let nextId = 1, closing = false, failure = null;
  const fail = () => { failure ??= new Error('Restart child failed'); facts.error = true; for (const waiter of waiters.splice(0)) waiter.reject(failure); };
  const parser = restartParser(message => {
    protocol.reply(message);
    if (message.work) samples.push({ event: message.event, id: message.id, work: message.work });
    if (message.event === 'stopped') facts.drained = message.drained;
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else { if (queue.length >= 32) reject(); queue.push(message); }
  });
  child.stdout.on('data', bytes => { out.update(bytes); facts.stdout_bytes += bytes.length; try { parser.push(bytes); } catch { fail(); } });
  child.stderr.on('data', bytes => { err.update(bytes); facts.stderr_bytes += bytes.length; fail(); });
  child.stdin.on('error', fail); child.on('error', fail);
  const exited = new Promise(resolve => child.once('close', async (code, signal) => {
    facts.closed = true; facts.code = code; facts.signal = signal;
    facts.stdout_sha256 = out.digest('hex'); facts.stderr_sha256 = err.digest('hex');
    try { parser.end(facts.expected_kill); protocol.end(facts.expected_kill); if (!closing || queue.length || waiters.length) reject(); } catch { fail(); }
    const current = await processIdentity(child.pid);
    facts.same_start_alive = current !== null && current.start_ticks === facts.identity?.start_ticks;
    facts.reaped = !facts.same_start_alive;
    resolve();
  }));
  const wait = async match => {
    if (failure) throw failure;
    const index = queue.findIndex(match);
    if (index >= 0) return queue.splice(index, 1)[0];
    let waiter;
    try { return await bounded(new Promise((resolve, rejectWait) => { waiter = { match, resolve, reject: rejectWait }; waiters.push(waiter); }), 20_000, 'Restart control timed out'); }
    finally { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); }
  };
  const request = async body => {
    if (failure || facts.closed || Object.hasOwn(body, 'id')) reject();
    const value = protocol.request({ ...body, id: nextId++ });
    const reply = wait(message => message.id === value.id);
    child.stdin.write(`${JSON.stringify(value)}\n`);
    const message = await reply;
    if (failure) throw failure;
    return message;
  };
  const fallback = async () => {
    if (!facts.closed) { facts.fallback = true; closing = true; child.kill('SIGKILL'); await bounded(exited, 2000, 'Restart fallback reap timed out'); }
    return facts;
  };
  try {
    facts.identity = await processIdentity(child.pid);
    if (!facts.identity || facts.identity.executable !== binding.executable || facts.identity.cwd !== cwd) reject();
    child.stdin.write(`${JSON.stringify({ root: fixture.root, phase })}\n`);
    const ready = await wait(message => message.event === 'ready');
    if (failure) throw failure;
    return {
      origin: ready.origin, pid: child.pid, request, samples,
      wait: gate => wait(message => message.event === 'model_paused' && message.gate === gate),
      sample: () => request({ command: 'sample' }),
      evidence: () => ({ ...facts, samples: structuredClone(samples) }), fallback,
      killProducer: async () => {
        if (phase !== 'produce' || failure || facts.closed) reject();
        protocol.end(true); closing = true; facts.expected_kill = true;
        if (!child.kill('SIGKILL')) reject();
        child.stdin.end(); await bounded(exited, 5000, 'Restart producer reap timed out');
        terminalProof(facts, true); return facts;
      },
      stopObserver: async () => {
        if (phase !== 'observe' || failure || facts.closed) reject();
        closing = true;
        await bounded(request({ command: 'stop' }), 5000, 'Restart drain timed out');
        child.stdin.end(); await bounded(exited, 5000, 'Restart observer reap timed out');
        terminalProof(facts, false); return facts;
      },
    };
  } catch { await fallback(); reject(); }
}
export async function removeRestartRoot(fixture, processes) {
  if (processes.length !== 2) reject();
  terminalProof(processes[0].evidence(), true); terminalProof(processes[1].evidence(), false);
  await rootProof(fixture, 'observe');
  await rm(fixture.root, { recursive: true });
  try { await lstat(fixture.root); } catch (error) { if (error.code === 'ENOENT') return true; }
  reject();
}

export function runningProof(input, sid, command, receipt, workspace) {
  validateTaskCommand(command);
  if (command.text !== data.user || receipt.operation_id !== command.operation_id || receipt.run_id !== command.run_id
    || receipt.session_id !== sid || receipt.first_sequence !== '2' || receipt.last_sequence !== '3') reject();
  const page = partialProof(input, sid, command.run_id, '23', receipt.first_sequence);
  if (page.session.title !== data.title || page.session.workspace !== workspace || page.block.revision !== '23' || page.entries[0].revision !== '23') reject();
  return page;
}
export function interruptedProof(input, before) {
  const page = validateConversationPage(input, { kind: 'latest' }, before.session_id), expected = structuredClone(before);
  const head = String(BigInt(before.snapshot_head) + 1n);
  expected.snapshot_head = head; expected.session.head_sequence = head;
  if (BigInt(page.session.updated_at_ms) < BigInt(before.session.updated_at_ms)) reject();
  expected.session.updated_at_ms = page.session.updated_at_ms;
  expected.live_after = page.live_after;
  expected.block.state = 'interrupted'; expected.block.revision = head;
  expected.entries[0].recorded_state = 'interrupted'; expected.entries[0].revision = head;
  equal(page, expected);
  // The real interruption settles metadata only, never fields, epochs or generations.
  freshCursor(page, head);
  return page;
}
function freshCursor(page, head) {
  const encoded = `g11l.${Buffer.from(JSON.stringify([1, page.session_id, head, '3', '', ''])).toString('base64url')}`;
  if (page.live_after !== encoded) reject();
}
export function stableProof(input, held) {
  const page = validateConversationPage(input, { kind: 'latest' }, held.session_id);
  equal(page, held); return page;
}
export function entryProof(input, page, entry) {
  const result = validateEntryPage(input, { session_id: page.session_id, run_id: page.block.run_id, entry_id: entry.entry_id });
  if (result.snapshot_head !== page.snapshot_head) reject();
  equal(result.block, page.block); equal(result.entry, entry); return result;
}
export function receiptProof(input, page, command, receipt) {
  const value = validateTaskReconciliation(input, { ...command, session_id: page.session_id });
  if (value.state !== 'accepted') reject();
  equal(value.acceptance, receipt);
  equal(value.run, { api_version: 1, run_id: command.run_id, state: page.block.state, user_text: command.text,
    accepted_sequence: receipt.first_sequence, terminal_sequence: page.block.state === 'interrupted' ? page.snapshot_head : null,
    result_sequence: null, result_recorded: false, result: null });
  return value;
}
export async function publicJson(process, owner, suffix, validate, body) {
  const reply = await fetch(`${process.origin}${suffix}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${owner}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (reply.status !== 200 || reply.headers.get('cache-control') !== 'no-store' || reply.headers.get('x-content-type-options') !== 'nosniff') reject();
  const bytes = await reply.arrayBuffer(); if (bytes.byteLength > 512 * 1024) reject();
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), reply.headers.get('content-type'), validate);
}
export function handshakeProof(input) {
  freshHandshake(input);
  const headers = input.reply.headers();
  if (headers['cache-control'] !== 'no-store' || headers['x-content-type-options'] !== 'nosniff'
    || !/^application\/json(?:;|$)/.test(headers['content-type']) || headers['set-cookie'] !== undefined) reject();
  const stream = input.streams[0];
  if (!stream.reply || stream.reply.request() !== stream.request || stream.reply.status() !== 200
    || stream.reply.headers()['content-type'] !== 'text/event-stream' || stream.reply.headers()['cache-control'] !== 'no-store'
    || stream.reply.headers()['x-content-type-options'] !== 'nosniff' || stream.reply.headers()['set-cookie'] !== undefined) reject();
  return true;
}
export function allowedRequest(method, url, sid, permission) {
  if (method === 'GET') {
    if (url.pathname === '/v1/settings') return url.search === '';
    if (url.pathname === '/v1/sessions') return url.search === '?limit=32';
    if (sid === undefined) return false;
    const base = `/v1/sessions/${sid}`;
    if (url.pathname === `${base}/conversation`) return url.search === '';
    if (url.pathname === `${base}/conversation/events`) {
      const params = [...url.searchParams];
      return params.length === 1 && params[0][0] === 'after' && parseDisplayCursor(params[0][1], 'live', sid) !== null;
    }
    return false;
  }
  return method === 'POST' && url.search === '' && ((permission === 'create' && url.pathname === '/v1/sessions')
    || (permission === 'task' && sid !== undefined && url.pathname === `/v1/sessions/${sid}/runs`));
}
