import * as fs from 'node:fs/promises';
import { isAbsolute, join, dirname, basename, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { browserSourceProof } from './display-measurements.mjs';
import { validateTaskCommand } from '../dist/api.js';
import { texts, savedProof, nativeBinding, ownNativeDiagnostic, nodeBoundaries } from './live-commit-native.mjs';
import { files, responseHeaders, newFaults } from './interrupted-display-parity.mjs';
export { newFaults };
const reject = () => { throw new Error('Live measurement rejected'); };
const equal = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); };
const integer = n => Number.isSafeInteger(n) && n >= 0;

export function allocationProgress() {
  return { phase: 'no_path', path: null, identity: null, nested: 'not_started', removed: false };
}
export async function outerProof(path, io = fs) {
  if (typeof path !== 'string' || !path.isWellFormed() || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) reject();
  const s = await io.lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || await io.realpath(path) !== path
    || (s.mode & 0o7777) !== 0o700) reject();
  return true;
}
export async function allocationProof(value, outer, io = fs) {
  if (!value || !isDeepStrictEqual(Object.keys(value).sort(), ['path', 'uid', 'mode', 'device', 'inode'].sort())) reject();
  if (typeof value.path !== 'string' || !isAbsolute(value.path) || dirname(value.path) !== outer
    || !/^wi-c54-private-[A-Za-z0-9]+$/.test(basename(value.path))) reject();
  await outerProof(outer, io);
  const s = await io.lstat(value.path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700
    || await io.realpath(value.path) !== value.path) reject();
  const current = { path: value.path, uid: s.uid, mode: s.mode & 0o7777, device: s.dev, inode: s.ino };
  equal(value, current); return current;
}
export async function allocateParent(outer, excluded, progress, io = fs) {
  if (progress.phase !== 'no_path' || !Array.isArray(excluded) || excluded.some(p => !isAbsolute(p))) reject();
  await outerProof(outer, io);
  const path = await io.mkdtemp(join(outer, 'wi-c54-private-'));
  // Preserve the returned path even if the next metadata read rejects. It grants no deletion authority.
  progress.path = path; progress.phase = 'path_returned';
  if (excluded.some(p => path === p || path.startsWith(p + '/') || p.startsWith(path + '/'))) reject();
  const s = await io.lstat(path);
  const candidate = { path, uid: s.uid, mode: s.mode & 0o7777, device: s.dev, inode: s.ino };
  progress.identity = await allocationProof(candidate, outer, io);
  progress.phase = 'identity_verified'; return progress;
}
export async function resolveAllocation(env, progress, io = fs) {
  const value = JSON.parse(env.WI_C54_ALLOCATION_PARENT);
  if (progress.phase !== 'no_path') reject();
  if (typeof value?.path === 'string' && isAbsolute(value.path)) {
    progress.path = value.path; progress.phase = 'path_returned';
  }
  progress.identity = await allocationProof(value, env.WI_BROWSER_FIXTURE_PARENT, io);
  progress.phase = 'identity_verified'; return progress;
}
export async function removeAllocation(progress, outer, safety, overrides = {}) {
  const io = { ...fs, ...overrides };
  if (safety.root_removed !== true || safety.prior_cleanup_safe !== true || progress.nested !== 'acquired'
    || progress.phase !== 'nested_fixture_acquired' || progress.removed) reject();
  await allocationProof(progress.identity, outer, io);
  // rmdir cannot sweep an unexpected partial root or another file.
  await io.rmdir(progress.path); progress.removed = true;
}
export async function prepareInvocation({ env, excluded, progress, readiness, consume }, io = fs, bind = resolveBinding) {
  await readiness();
  const binding = await bind(env);
  const outer = env.WI_BROWSER_FIXTURE_PARENT;
  await allocateParent(outer, excluded, progress, io);
  await allocationProof(progress.identity, outer, io);
  await readiness();
  // The wrapper reserves OUTER only here. The registered callback reserves its own marker later.
  return consume({ binding, progress });
}

export async function resolveBinding(env, io = fs, bind = nativeBinding) {
  const path = env.WI_C54_NATIVE_BINDING;
  if (typeof path !== 'string' || !isAbsolute(path)) reject();
  const s = await io.lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || await io.realpath(path) !== path) reject();
  return bind(JSON.parse(await io.readFile(path, 'utf8')));
}
export async function reserveOutput(testInfo, env, io = fs) {
  const root = testInfo.outputPath('c54-evidence');
  if (!isAbsolute(root)) reject();
  if (env.WI_C54_OUTER_MARKER !== undefined) {
    const p = env.WI_C54_OUTER_MARKER;
    if (!isAbsolute(p) || p === root || p.startsWith(dirname(root) + '/')) reject();
    const s = await io.lstat(p);
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o7777) !== 0o600 || await io.realpath(p) !== p) reject();
    equal(JSON.parse(await io.readFile(p, 'utf8')), { consumed: true });
  }
  await io.mkdir(root, { mode: 0o700 });
  await io.writeFile(join(root, 'C54.once.json'), JSON.stringify({ consumed: true }) + '\n', { flag: 'wx', mode: 0o600 });
  return root;
}
export async function modesProof(root, io = fs) {
  async function visit(p) {
    const s = await io.lstat(p);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || await io.realpath(p) !== p) reject();
    if (s.isDirectory()) {
      if ((s.mode & 0o7777) !== 0o700) reject();
      for (const name of await io.readdir(p)) await visit(join(p, name));
    } else if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o7777) !== 0o600) reject();
  }
  await visit(root); return true;
}

// This function runs unchanged in Chromium and in controls using the built renderer.
export async function browserProgram(input, env = globalThis) {
  const fail = () => { throw new Error('Live browser observation rejected'); };
  if (input.action === 'poll') return env.__wiC54Observation.poll(input.kind);
  if (input.action === 'finish') return env.__wiC54Observation.finish();
  const { first, texts } = input;
  const transcript = env.document.querySelector('[aria-label="Canonical conversation"]');
  if (!transcript) fail();
  function copy() {
    const runs = Array.from(transcript.querySelectorAll('.run'));
    return runs.map(run => ({ run: run.dataset.run,
      status: run.querySelector(':scope > .metadata')?.textContent ?? null,
      detail: run.querySelector(':scope > details > pre')?.textContent ?? null,
      entries: Array.from(run.querySelectorAll('.entry')).map(entry => ({ id: entry.dataset.entry,
        kind: entry.querySelector('h4')?.textContent ?? null,
        state: entry.querySelector(':scope > .metadata')?.textContent ?? null,
        partial: entry.querySelectorAll(':scope > .metadata')[1]?.textContent ?? null,
        partial_hidden: entry.querySelectorAll(':scope > .metadata')[1]?.hidden ?? null,
        fields: Array.from(entry.querySelectorAll('[data-field]')).map(field => ({ id: field.dataset.field,
          kind: field.querySelector('h5,summary')?.textContent ?? null,
          metadata: field.querySelector('.metadata')?.textContent ?? null,
          ranges: Array.from(field.querySelectorAll('[data-range]')).map(range => ({
            key: range.dataset.range, pre: range.tagName === 'PRE', text: range.textContent,
          })),
        })),
      })),
    }));
  }
  function candidate(snapshot, kind, authorityGeneration) {
    if (snapshot.length !== 1) return null;
    const r = snapshot[0], e = r.entries[1], human = r.entries[0];
    if (r.run !== first.run_id || r.entries.length !== 2 || !human || !e || human.kind !== 'Human'
      || human.id === e.id || e.id !== first.entry_id || e.kind !== 'assistant' || e.fields.length !== 1
      || human.fields.length !== 1 || human.fields[0].id !== 'text' || human.fields[0].ranges.length !== 1
      || human.fields[0].ranges[0].key !== 'text:0' || !human.fields[0].ranges[0].pre
      || human.fields[0].ranges[0].text !== texts.task || human.partial_hidden !== true || human.partial !== 'Content complete.'
      || human.state !== 'Recorded state: accepted; Provisional: false') return null;
    const f = e.fields[0], expectedText = texts[kind === 'authority' || kind === 'terminal' ? 'final' : kind];
    const match = /^Recorded bytes: (0|[1-9][0-9]*); generation: ([1-9][0-9]*)$/.exec(f.metadata ?? '');
    const terminal = kind === 'terminal';
    if (f.id !== first.field_id || f.kind !== 'text' || !match || f.ranges.length !== 1 || !f.ranges[0].pre
      || f.ranges[0].key !== 'text:0' || f.ranges[0].text !== expectedText
      || Number(match[1]) !== new env.TextEncoder().encode(expectedText).length
      || e.partial !== 'Content complete.' || e.partial_hidden !== true
      || e.state !== `Recorded state: ${terminal ? 'completed' : 'in_progress'}; Provisional: ${!terminal}`
      || r.status !== `Execution: ${terminal ? 'completed' : 'running'}. Final result ${terminal ? 'recorded' : 'not recorded'}.`) return null;
    const generation = match[2];
    if (kind === 'first' || kind === 'append') { if (generation !== String(first.generation)) return null; }
    else if (BigInt(generation) <= BigInt(first.generation)) return null;
    if (terminal && generation !== authorityGeneration) return null;
    const lines = r.detail?.split('\n');
    if (!lines || lines[0] !== `Run: ${first.run_id}` || !/^Accepted sequence: [1-9][0-9]*$/.test(lines[1])) return null;
    const accepted = lines[1].slice('Accepted sequence: '.length), humanBytes = new env.TextEncoder().encode(texts.task).length;
    if (human.id !== `e:${accepted}:0` || BigInt(accepted) >= BigInt(first.entry_id.split(':')[1])
      || human.fields[0].kind !== 'text' || human.fields[0].metadata !== `Recorded bytes: ${humanBytes}; generation: ${accepted}`) return null;
    if (!terminal) {
      if (lines.slice(2).join('\n') !== 'Outcome: not recorded\nEvents complete: not recorded\nSink error: none\nSummary not recorded.') return null;
    } else {
      const required = ['Outcome: completed', 'Events complete: true', 'Sink error: none', 'turns_started: 1', 'turns_finished: 1',
        'model_requests_attempted: 1', 'model_requests_admitted: 1', 'new_tool_dispatches: 0', 'tool_results_prepared: 0', 'reused_results: 0'];
      if (required.some(line => lines.filter(v => v === line).length !== 1)
        || !lines.some(v => /^last_request_id: [a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v))
        || !lines.includes('last_upstream_outcome: terminal_received')) return null;
    }
    return { run_id: r.run, entry_id: e.id, field_id: f.id, generation, bytes: Number(match[1]),
      text: f.ranges[0].text, human_entry_id: human.id, accepted_sequence: accepted, entry_state: terminal ? 'completed' : 'in_progress', provisional: !terminal,
      run_state: terminal ? 'completed' : 'running', result_recorded: terminal, events_complete: terminal ? true : null,
      exact_ranges: true, no_gaps: true, human_before_assistant: true, complete_content: true,
      // The renderer does not expose native heads, epochs or response/run event existence.
      native_only: ['head', 'projection_head', 'content_epoch', 'response_finished', 'run_finished'] };
  }
  async function hashed(value, at, arm) {
    const bytes = new env.TextEncoder().encode(value.text);
    const digest = await env.crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const { text, ...facts } = value;
    return { ...facts, sha256, callback_ms: at, arm_to_callback_ms: arm === null ? null : at - arm };
  }
  if (input.action === 'read') {
    const at = env.performance.now(), snapshot = copy(), value = candidate(snapshot, 'first');
    return value ? hashed(value, at, null) : null;
  }
  if (input.action !== 'arm' || env.__wiC54Observation !== undefined) fail();
  const before = copy();
  if (!candidate(before, 'first') || before.some(r => r.entries.some(e => e.fields.some(f => f.ranges.some(n =>
    n.text === texts.append || n.text === texts.final))))) fail();
  const armed = env.performance.now(), reservations = {}, results = {}, pending = new Set();
  let failure = false, callbacks = 0, firstTarget = null, authorityGeneration = null, disconnected = false;
  const scan = () => {
    // Copy time and every predicate input before any asynchronous digest can settle.
    const at = env.performance.now(); let snapshot;
    try { snapshot = copy(); } catch { failure = true; return; }
    callbacks++;
    const field = snapshot.flatMap(r => r.entries.flatMap(e => e.fields)).find(f => f.id === first.field_id);
    if (field?.ranges.some(n => n.pre && n.text !== texts.first) && firstTarget === null) firstTarget = at;
    for (const kind of ['append', 'authority', 'terminal']) {
      let value;
      try { value = candidate(snapshot, kind, authorityGeneration); } catch { failure = true; continue; }
      if (!value || reservations[kind]) continue;
      if (kind !== 'append' && !reservations[kind === 'authority' ? 'append' : 'authority']) { failure = true; continue; }
      reservations[kind] = { at, value };
      if (kind === 'authority') authorityGeneration = value.generation;
      // Reservation precedes digest creation, so reordered settlements cannot replace the first callback.
      const task = hashed(value, at, armed).then(result => { results[kind] = result; }, () => { failure = true; }).finally(() => pending.delete(task));
      pending.add(task);
    }
  };
  const observer = new env.MutationObserver(scan);
  observer.observe(transcript, { childList: true, characterData: true, subtree: true, attributes: true });
  env.__wiC54Observation = {
    poll(kind) { if (failure || disconnected) fail(); return results[kind] ?? null; },
    async finish() {
      while (pending.size) await Promise.all([...pending]);
      observer.disconnect(); disconnected = true;
      if (failure || ['append', 'authority', 'terminal'].some(k => !results[k]) || firstTarget === null) fail();
      return { clock: 'browser performance.now', armed_ms: armed, first_target_callback_ms: firstTarget,
        first_target_observation_ms: firstTarget - armed, callbacks, pending: pending.size, append_absent_at_arm: true,
        append: results.append, authority: results.authority, terminal: results.terminal };
    },
  };
  return { clock: 'browser performance.now', armed_ms: armed, append_absent_at_arm: true };
}
export function browserProof(value, saved, kind, prior) {
  savedProof(saved, kind === 'authority' ? 'authoritative' : kind, prior);
  if (!value) reject();
  for (const k of ['run_id', 'entry_id', 'field_id', 'bytes', 'sha256', 'entry_state', 'provisional', 'run_state', 'result_recorded', 'events_complete']) equal(value[k], saved[k]);
  if (value.generation !== String(saved.generation) || !['exact_ranges', 'no_gaps', 'human_before_assistant', 'complete_content'].every(k => value[k] === true)
    || !Number.isFinite(value.callback_ms) || value.callback_ms < 0) reject();
  if (kind !== 'first' && (!Number.isFinite(value.arm_to_callback_ms) || value.arm_to_callback_ms < 0)) reject();
  return true;
}

// Browser gates supplement, but never replace, A's actual closed protocol admission.
export function phaseDrive(native) {
  let first, append, authority, terminal, observed = null, armed = false;
  return {
    async first() { if (first) reject(); first = (await native.request({ command: 'first' })).saved; return first; },
    observed(kind, saved, dom) {
      const values = { first, append, authority, terminal }, priors = { append: first, authority: append, terminal: authority };
      equal(values[kind], saved); browserProof(dom, saved, kind, priors[kind]);
      if (observed === kind) reject(); observed = kind;
    },
    async arm() { if (observed !== 'first' || armed) reject(); await native.request({ command: 'observed_first', observed: first }); await native.request({ command: 'arm' }); armed = true; },
    async second() { if (!armed || append) reject(); const captured = await native.request({ command: 'second' }); append = captured.saved; return captured; },
    async authority() { if (observed !== 'append' || authority) reject(); authority = (await native.request({ command: 'authoritative', observed: append })).saved; return authority; },
    async terminal() { if (observed !== 'authority' || terminal) reject(); terminal = (await native.request({ command: 'terminal', observed: authority })).saved; return terminal; },
    async complete() { if (observed !== 'terminal') reject(); await native.request({ command: 'observed_terminal', observed: terminal }); },
  };
}

export function liveCollector({ origin, owner, session, head, faults, onReject = () => {}, onRequestFailed = () => {} }) {
  const items = new Map(), pending = new Set(), results = {}, assets = new Set();
  const counts = { latest: 0, sse: 0, task: 0, forbidden: 0, helper_http: 0, settings: 0, catalog: 0 };
  const base = `/v1/sessions/${session}/conversation`;
  const live = `g11l.${Buffer.from(JSON.stringify([1, session, String(head), '3', '', ''])).toString('base64url')}`;
  let error = false, closing = false, armed = false, sequence = 0, command, failedRequest = null;
  const fail = phase => { error = true; faults.collector++; try { onReject(phase); } catch { /* The collector remains failed if its observer rejects. */ } };
  function classify(q) {
    const u = new URL(q.url()), method = q.method();
    if (u.origin !== origin || u.username || u.password || u.hash || q.url().includes(owner)) reject();
    if (method === 'GET' && u.pathname === base && u.search === '') return 'latest';
    if (method === 'GET' && u.pathname === `${base}/events` && u.search === `?after=${encodeURIComponent(live)}`) return 'sse';
    if (method === 'POST' && u.pathname === `/v1/sessions/${session}/runs` && !u.search) return 'task';
    if (method === 'GET' && u.pathname === '/v1/settings' && !u.search) return 'settings';
    if (method === 'GET' && u.pathname === '/v1/sessions' && u.search === '?limit=32') return 'catalog';
    if (method === 'GET' && files.has(u.pathname) && !u.search) return u.pathname;
    counts.forbidden++; reject();
  }
  function track(action, phase) {
    const task = Promise.resolve().then(action).catch(() => fail(phase)).finally(() => pending.delete(task));
    pending.add(task);
  }
  return {
    async route(route) {
      try { if (new URL(route.request().url()).origin !== origin) { faults.external++; onReject('collector_route'); await route.abort(); } else await route.continue(); }
      catch { fail('collector_route'); }
    },
    request(q) {
      try {
        if (items.has(q)) reject();
        const kind = classify(q), h = q.headers();
        if (h.cookie !== undefined || h.origin !== undefined && h.origin !== origin) reject();
        if (!kind.startsWith('/') && h.authorization !== `Bearer ${owner}`) reject();
        if (kind.startsWith('/')) { if ([...items.values()].some(v => v.kind === kind)) reject(); }
        else if (++counts[kind] !== 1) reject();
        // The client can open SSE after a validated Latest reply before requestfinished reaches this observer.
        if (kind === 'sse' && ![...items.values()].some(item => item.kind === 'latest' && item.reply)) reject();
        if (kind === 'task') {
          if (!armed || !results.latest || !results.sse || h['content-type'] !== 'application/json') reject();
          command = validateTaskCommand(q.postDataJSON());
          if (command.text !== texts.task) reject();
        }
        items.set(q, { kind, reply: null, finished: false, order: ++sequence });
      } catch { fail('collector_request'); }
    },
    response(reply) {
      try {
        const q = reply.request(), item = items.get(q);
        if (!item || item.reply || reply.url() !== q.url() || classify(q) !== item.kind) reject();
        const file = files.get(item.kind);
        responseHeaders(reply, file ? file[1] : item.kind === 'sse' ? 'text/event-stream' : 'application/json', item.kind === 'task' ? 202 : 200);
        item.reply = reply; item.response_order = ++sequence;
        if (item.kind === 'sse') results.sse = { identity_match: true, status: 200, headers_only: true, no_store: true };
        if (file) track(async () => {
          // Only static asset responses are consumed by the observer.
          const assetReply = reply, bytes = await assetReply.body();
          equal(bytes, await fs.readFile(new URL(`../${file[0]}`, import.meta.url)));
          if (bytes.includes(Buffer.from(owner))) reject(); assets.add(item.kind);
        }, 'collector_asset');
      } catch { fail('collector_response'); }
    },
    finished(q) {
      try {
        const item = items.get(q);
        if (!item || item.finished || !item.reply || item.reply.request() !== q) reject();
        if (item.kind === 'sse') { if (!closing) reject(); item.finished = true; return; }
        item.finished = true;
        if (!item.kind.startsWith('/')) results[item.kind] = { identity_match: true, status: item.kind === 'task' ? 202 : 200,
          no_store: true, requestfinished: true, request_order: item.order, response_order: item.response_order, finished_order: ++sequence,
          timing: 'unmeasured', sizes: 'unmeasured' };
      } catch { fail('collector_finished'); }
    },
    failed(q) {
      const v = items.get(q);
      let status = 'unavailable';
      try { const n = v?.reply?.status(); if (Number.isInteger(n) && n >= 100 && n <= 599) status = n; } catch { /* No raw rejection leaves this callback. */ }
      let kind = 'untracked';
      if (v) kind = v.kind.startsWith('/') ? 'asset' : v.kind;
      const facts = Object.freeze({ kind,
        order: v?.order ?? 'unavailable', response_present: v ? v.reply !== null : 'unavailable',
        finished: v?.finished ?? 'unavailable', closing, status });
      const expected = closing && v?.kind === 'sse' && v.reply && !v.finished;
      if (!expected) failedRequest ??= facts;
      try { onRequestFailed(facts); } catch { fail('collector_failed'); }
      if (expected) { v.finished = true; return; }
      fail('collector_failed');
    },
    closing() { closing = true; },
    armTask() { if (armed || error || !results.latest || !results.sse) reject(); armed = true; },
    taskRun() { if (!command || error) reject(); return command.run_id; },
    ready(kind) { return !error && results[kind] !== undefined; },
    async drain() { while (pending.size) await Promise.all([...pending]); },
    facts() { return structuredClone({ counts, operations: results, failed: error, pending: pending.size, assets: assets.size, failed_request: failedRequest,
      command: command ? { operation_id: command.operation_id, run_id: command.run_id, exact_known_text: true } : null }); },
    cleanupProof() {
      if (error || pending.size || counts.forbidden || counts.helper_http) reject();
      for (const [q, v] of items) {
        if (!v.reply || v.reply.request() !== q || v.kind !== 'sse' && !v.finished) reject();
      }
      return this.facts();
    },
    proof() { this.cleanupProof(); if (['latest', 'sse', 'task', 'settings', 'catalog'].some(k => counts[k] !== 1) || assets.size !== 9) reject(); return this.facts(); },
  };
}
export const phases = ['output', 'binding', 'allocation', 'allocation_cleanup', 'root', 'native', 'server', 'identity', 'browser', 'context', 'page', 'goto', 'fresh', 'connect',
  'handshake', 'task', 'first', 'first_dom', 'browser_arm', 'native_arm', 'second', 'pages', 'append_dom', 'authority', 'authority_dom', 'terminal',
  'terminal_dom', 'complete', 'observer_finish', 'privacy', 'body_proof', 'cleanup', 'publication',
  'root_cleanup', 'native_stop', 'native_abandon', 'native_retirement', 'browser_discovery', 'server_close', 'browser_emergency', 'browser_retirement', 'browser_close', 'context_close', 'collector_drain',
  'collector_route', 'collector_request', 'collector_response', 'collector_finished', 'collector_failed', 'collector_asset', 'native_failed_frame', 'native_node_failure'];
export function diagnostics(read) {
  let packet = null, native = null, failedRequest = null, discovery = 'not_rejected', overflow = false;
  const order = [], states = Object.fromEntries(phases.map(k => [k, 'not_started']));
  const safe = fn => { try { return fn(); } catch { return undefined; } };
  const count = fn => { const n = safe(fn); return integer(n) && n <= 1000000 ? n : 'unavailable'; };
  const bool = fn => { const v = safe(fn); return typeof v === 'boolean' ? v : 'unavailable'; };
  function requestFacts(v) {
    if (v == null) return null;
    const kind = safe(() => v.kind), status = safe(() => v.status);
    return Object.freeze({ kind: ['latest', 'sse', 'task', 'settings', 'catalog', 'asset', 'untracked'].includes(kind) ? kind : 'untracked',
      order: count(() => v.order), response_present: bool(() => v.response_present), finished: bool(() => v.finished), closing: bool(() => v.closing),
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unavailable' });
  }
  function observed(event) {
    if (order.length < 64) order.push(Object.freeze({ order: order.length + 1, event })); else overflow = true;
  }
  function facts() {
    return Object.freeze({ native, failed_request: failedRequest, browser_discovery_rejection: discovery,
      callback_order: Object.freeze([...order]), callback_order_overflow: overflow, callback_order_scope: 'Node callbacks only; not physical or cross-clock causality' });
  }
  function freeze(name) {
    if (packet) return packet;
    const net = safe(read), supplemental = facts();
    packet = Object.freeze({ first_operation: phases.includes(name) ? name : 'cleanup', phases: Object.freeze({ ...states }),
      counts: Object.freeze(Object.fromEntries(['latest', 'sse', 'task', 'forbidden', 'helper_http'].map(k => [k, count(() => net.counts[k])]))),
      pending: count(() => net.pending), collector_failed: bool(() => net.failed), ...supplemental,
      failed_request: requestFacts(safe(() => net.failed_request)) ?? failedRequest });
    return packet;
  }
  return { freeze, packet: () => packet, facts,
    requestFailed(value) { observed('browser_requestfailed'); failedRequest ??= requestFacts(value); },
    native(event, value) {
      if (!['node_failure', 'native_failed_frame', 'native_cleanup', 'native_close'].includes(event)) return;
      if (['native_failed_frame', 'native_close'].includes(event)) observed(event);
      const failure = safe(() => {
        const v = value.native_failure; if (v === null) return null;
        return ownNativeDiagnostic(v);
      });
      const cleanup = safe(() => { const v = value.native_cleanup; if (v === null) return null; return ownNativeDiagnostic(v, true); });
      const boundary = safe(() => value.first_boundary), code = safe(() => value.code);
      native = Object.freeze({ first_boundary: native?.first_boundary ?? (boundary === null || nodeBoundaries.includes(boundary) ? boundary : 'unavailable'),
        failure: native?.failure ?? failure ?? null, cleanup: cleanup ?? native?.cleanup ?? null,
        failure_availability: failure === undefined ? 'unavailable' : 'available', cleanup_availability: cleanup === undefined ? 'unavailable' : 'available',
        closed: bool(() => value.closed), code: code === null || integer(code) && code <= 255 ? code : 'unavailable' });
      if (event === 'native_failed_frame' || event === 'node_failure') freeze(event === 'native_failed_frame' ? event : 'native_node_failure');
    },
    discoveryRejected() { discovery = 'local_rejection_unavailable'; },
    async operation(name, action) {
      if (!phases.includes(name) || states[name] !== 'not_started') reject(); states[name] = 'pending';
      try { const value = await action(); states[name] = 'resolved'; return value; }
      catch (error) { states[name] = 'failed'; freeze(name); throw error; }
    } };
}
export function sourceGuard(spec, helper) {
  browserSourceProof(spec);
  const implementation = helper.slice(0, helper.indexOf('export function sourceGuard'));
  const forbidden = /discoverFixture|newCDPSession|_channel|_connection|executablePath\s*:|args\s*:|wsPath\s*:|globalThis\.fetch\s*=|\.stack\b|test\.(skip|fixme|only)\s*\(|\.json\s*\(|\.text\s*\(|\.arrayBuffer\s*\(|fetch\s*\(/;
  if (forbidden.test(spec) || forbidden.test(implementation) || /\.body\s*\(/.test(spec)
    || (implementation.match(/\.body\s*\(/g) ?? []).length !== 1 || !implementation.includes('await assetReply.body()')) reject();
  return true;
}
