import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { restartParser, restartProtocol, rootProof, workProof, terminalProof } from './restart-display.mjs';
import { sid, previous, expectedPage, collector } from './upgrade-display-parity.mjs';
import { responseHeaders } from './interrupted-display-parity.mjs';
import { CHILD_TEST } from './fixture.mjs';

const reject = () => { throw new Error('Display measurement rejected'); };
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const phases = ['cold', 'warm', 'older'];
export const boundaries = phases.flatMap(p => [`before-${p}`, `after-${p}`]);
export function transportTiming(t, stream = false) {
  const names = ['startTime', 'requestStart', 'responseStart'];
  if (!stream) names.push('responseEnd');
  if (names.some(k => !finite(t[k])) || t.responseStart < t.requestStart || !stream && t.responseEnd < t.responseStart) reject();
  const value = Object.fromEntries(names.map(k => [k, t[k]]));
  value.first_byte_ms = t.responseStart - t.requestStart;
  if (!stream) { value.download_ms = t.responseEnd - t.responseStart; value.total_ms = t.responseEnd - t.requestStart; }
  return { clock: 'Playwright request timing; startTime is epoch ms, remaining fields relative ms', ...value };
}
export function transportSizes(s) {
  const keys = ['requestBodySize', 'requestHeadersSize', 'responseBodySize', 'responseHeadersSize'];
  if (keys.some(k => !integer(s[k])) || s.requestBodySize !== 0 || s.requestHeadersSize === 0 || s.responseBodySize === 0 || s.responseHeadersSize === 0) reject();
  return Object.fromEntries(keys.map(k => [k, s[k]]));
}

// Only original request identities enter timing records. Asset reads stay in the existing collector.
export function measurementCollector(options) {
  const base = collector(options), items = new Map(), pending = new Set(), results = {}, streams = [];
  let phase = null, error = false, sequence = 0;
  const fail = () => { error = true; options.faults.collector++; };
  const path = `/v1/sessions/${sid}/conversation`;
  const isOriginal = url => url.pathname === path || url.pathname === `${path}/events`;
  const apiUrl = (q, stream) => {
    const url = new URL(q.url());
    const search = stream ? `?after=${encodeURIComponent(expectedPage(1).live_after)}` : phase === 'older' ? `?before=${encodeURIComponent(previous)}` : '';
    if (url.origin !== options.origin || q.method() !== 'GET' || url.pathname !== `${path}${stream ? '/events' : ''}` || url.search !== search) reject();
  };
  return {
    route: base.route,
    begin(next) {
      if (phases.indexOf(next) !== phases.indexOf(phase) + 1 || phase !== null && (!results[phase] || phase !== 'older' && !streams.some(s => s.phase === phase))) reject();
      phase = next;
    },
    request(q) {
      base.request(q);
      try {
        const url = new URL(q.url()); if (!isOriginal(url)) return;
        const stream = url.pathname.endsWith('/events');
        if (phase === null || stream && phase === 'older' || items.has(q)) reject();
        apiUrl(q, stream);
        if ([...items.values()].some(v => v.phase === phase && v.stream === stream)) reject();
        const latest = [...items.values()].find(v => v.phase === phase && !v.stream);
        if (stream && !latest?.response) reject();
        items.set(q, { phase, stream, response: null, request_order: ++sequence, finished: false });
      } catch { fail(); }
    },
    response(reply) {
      base.response(reply);
      try {
        const q = reply.request(), item = items.get(q);
        if (!item) { if (isOriginal(new URL(reply.url()))) reject(); return; }
        if (item.response || reply.url() !== q.url()) reject();
        item.response = reply; item.response_order = ++sequence;
        responseHeaders(reply, item.stream ? 'text/event-stream' : 'application/json');
        if (item.stream) streams.push({ phase: item.phase, request_order: item.request_order, response_order: item.response_order,
          identity_match: true, status: 200, media: 'sse', no_store: true, handshake: transportTiming(q.timing(), true) });
      } catch { fail(); }
    },
    finished(q) {
      const item = items.get(q);
      // Long-lived streams have no completion or size measurement, including cancelled old epochs.
      if (!item || item.stream) return;
      const task = (async () => {
        if (item.finished || !item.response || item.response.request() !== q) reject();
        item.finished = true;
        const timing = transportTiming(q.timing()), sizes = transportSizes(await q.sizes());
        if (results[item.phase]) reject();
        results[item.phase] = { identity_match: true, status: 200, media: 'json', no_store: true,
          requestfinished: true, request_order: item.request_order, response_order: item.response_order, timing, sizes };
      })().catch(fail).finally(() => pending.delete(task));
      pending.add(task);
    },
    ready(p) { return !error && results[p] !== undefined && (p === 'older' || streams.some(s => s.phase === p)); },
    async drain() { await Promise.all([...pending]); },
    facts() { return structuredClone({ operations: results, streams, failed: error }); },
    proof() {
      if (error || pending.size || phases.some(p => !results[p]) || streams.length !== 2 || !streams.every((s, i) => s.phase === phases[i])) reject();
      const facts = this.facts();
      items.clear();
      for (const list of [options.record.snapshots, options.record.streams, options.record.older]) {
        for (const item of list) for (const name of ['request', 'response', 'reply']) delete item[name];
      }
      return facts;
    },
  };
}

// This runs in the page realm. It reads only the heading and the expected run identity.
export function installColdObserver({ title, run }, env = globalThis) {
  const heading = env.document.querySelector('[aria-label="Canonical session title"]');
  const transcript = env.document.querySelector('[aria-label="Canonical conversation"]');
  if (!heading || !transcript || env.__c52Cold) throw new Error('Cold observer rejected');
  const state = { clock: 'page performance.now', armed_ms: env.performance.now(), preparing_ms: null, installed_ms: null };
  const scan = () => {
    const now = env.performance.now();
    if (heading.textContent === 'Preparing conversation…' && state.preparing_ms === null) state.preparing_ms = now;
    if (heading.textContent === title && transcript.querySelector(`.run[data-run="${run}"]`) && state.installed_ms === null) state.installed_ms = now;
  };
  const observer = new env.MutationObserver(scan);
  observer.observe(heading, { childList: true, characterData: true, subtree: true });
  observer.observe(transcript, { childList: true, subtree: true });
  scan();
  env.__c52Cold = { finish() {
    scan(); observer.disconnect();
    const exact_dom_upper_ms = env.performance.now();
    const observed = state.preparing_ms !== null && state.installed_ms !== null && state.preparing_ms <= state.installed_ms;
    return { ...state, exact_dom_upper_ms, preparing_status: observed ? 'observed' : 'unavailable-transient-unobserved-or-coalesced',
      preparing_to_identity_ms: observed ? state.installed_ms - state.preparing_ms : null,
      warm_installation: 'not measured; warm retains keyed B and title' };
  } };
}
export function coldProof(value) {
  if (value.clock !== 'page performance.now' || !finite(value.armed_ms) || !finite(value.exact_dom_upper_ms)
    || value.exact_dom_upper_ms < value.armed_ms) reject();
  for (const k of ['preparing_ms', 'installed_ms']) if (value[k] !== null && (!finite(value[k]) || value[k] < value.armed_ms || value[k] > value.exact_dom_upper_ms)) reject();
  if (value.preparing_status === 'observed') {
    if (!finite(value.preparing_ms) || !finite(value.installed_ms) || value.installed_ms < value.preparing_ms
      || value.preparing_to_identity_ms !== value.installed_ms - value.preparing_ms) reject();
  } else if (value.preparing_status !== 'unavailable-transient-unobserved-or-coalesced' || value.preparing_to_identity_ms !== null) reject();
  return value;
}

export function parseStat(raw, pid) {
  const end = raw.lastIndexOf(')'), start = raw.indexOf(' (');
  if (!integer(pid) || pid === 0 || pid > 0xffffffff || start < 1 || end < start || raw.slice(0, start) !== String(pid)) reject();
  const p = raw.slice(end + 2).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(p[0]) || !/^(0|[1-9][0-9]*)$/.test(p[1]) || !/^[1-9][0-9]*$/.test(p[19])) reject();
  const ppid = Number(p[1]); if (!integer(ppid) || ppid > 0xffffffff || BigInt(p[19]) > 0xffffffffffffffffn) reject();
  return { pid, ppid, start_ticks: p[19] };
}
export function parseMemory(raw) {
  const values = {};
  for (const key of ['VmRSS', 'VmHWM']) {
    const lines = raw.split('\n').filter(line => line.startsWith(`${key}:`));
    if (lines.length !== 1) reject();
    const match = new RegExp(`^${key}:\\s+(0|[1-9][0-9]*) kB\\s*$`).exec(lines[0]);
    if (!match) reject();
    const bytes = Number(match[1]) * 1024; if (!integer(bytes)) reject(); values[key] = bytes;
  }
  if (values.VmHWM < values.VmRSS) reject();
  return { rss_bytes: values.VmRSS, lifetime_hwm_bytes: values.VmHWM };
}
const same = (a, b) => a.pid === b.pid && a.start_ticks === b.start_ticks && a.executable === b.executable && a.ppid === b.ppid;
export async function identity(pid, io = fs) {
  try {
    const stat = parseStat(await io.readFile(`/proc/${pid}/stat`, 'utf8'), pid);
    const executable = await io.readlink(`/proc/${pid}/exe`), cwd = await io.readlink(`/proc/${pid}/cwd`);
    if (!executable.startsWith('/') || !cwd.startsWith('/')) reject();
    return { state: 'present', ...stat, executable, cwd };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try { await io.lstat(`/proc/${pid}`); } catch (directory) { if (directory?.code === 'ENOENT') return { state: 'absent', pid }; }
    }
    return { state: 'unknown', pid };
  }
}
export async function retirement(owned, io = fs) {
  if (owned?.state !== 'present' || !integer(owned.pid) || owned.pid === 0 || !/^[1-9][0-9]*$/.test(owned.start_ticks)
    || typeof owned.executable !== 'string' || !owned.executable.startsWith('/') || !integer(owned.ppid)) return { pid: owned?.pid ?? null, retirement: 'unknown' };
  const current = await identity(owned.pid, io);
  if (current.state === 'absent') return { ...owned, retirement: 'absent' };
  if (current.state === 'present' && current.start_ticks !== owned.start_ticks) return { ...owned, retirement: 'reused' };
  return { ...owned, retirement: current.state === 'present' && same(current, owned) ? 'alive' : 'unknown' };
}
async function memberMemory(owned, io) {
  const before = await identity(owned.pid, io);
  if (before.state !== 'present' || !same(before, owned)) return { identity: owned, valid: false, reason: 'identity-before' };
  try {
    const memory = parseMemory(await io.readFile(`/proc/${owned.pid}/status`, 'utf8'));
    const after = await identity(owned.pid, io);
    if (after.state !== 'present' || !same(before, after)) return { identity: owned, valid: false, reason: 'identity-after' };
    return { identity: owned, valid: true, ...memory };
  } catch { return { identity: owned, valid: false, reason: 'status-unreadable-or-invalid' }; }
}
async function discover(root, io) {
  const stats = new Map(), members = [], errors = { enumeration: 0, stat: 0, identity: 0 };
  try {
    for (const name of await io.readdir('/proc')) if (/^[1-9][0-9]*$/.test(name)) {
      const pid = Number(name);
      try { stats.set(pid, parseStat(await io.readFile(`/proc/${pid}/stat`, 'utf8'), pid)); } catch { errors.stat++; }
    }
  } catch { errors.enumeration++; }
  const anchor = await identity(root.pid, io);
  if (anchor.state !== 'present' || !same(root, anchor)) { errors.identity++; return { members, errors }; }
  const owned = new Map([[root.pid, root]]); members.push(root);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, stat] of stats) if (!owned.has(pid) && owned.has(stat.ppid)) {
      const parent = owned.get(stat.ppid), current = await identity(pid, io), parentNow = await identity(parent.pid, io);
      if (current.state === 'present' && current.start_ticks === stat.start_ticks && current.ppid === parent.pid
        && parentNow.state === 'present' && same(parentNow, parent)) {
        owned.set(pid, current); members.push(current); changed = true;
      } else { errors.identity++; stats.delete(pid); }
    }
  }
  return { members: members.sort((a, b) => a.pid - b.pid), errors };
}
const key = i => `${i.pid}:${i.start_ticks}:${i.executable}:${i.ppid}`;
export function aggregateBrowser(members, before, after) {
  const first = before.members.map(key), last = after.members.map(key);
  const churn = first.filter(k => !last.includes(k)).length + last.filter(k => !first.includes(k)).length;
  const complete = members.length > 0 && members.every(v => v.valid) && churn === 0
    && before.errors.enumeration === 0 && after.errors.enumeration === 0 && before.errors.identity === 0 && after.errors.identity === 0;
  let rss_bytes = null;
  if (complete) { rss_bytes = members.reduce((n, v) => n + v.rss_bytes, 0); if (!integer(rss_bytes)) reject(); }
  return { complete_for_observed_membership: complete, rss_bytes, members, churn,
    partial_errors: members.filter(v => !v.valid).length, discovery_gaps: before.errors.stat + after.errors.stat,
    enumeration_errors: before.errors.enumeration + after.errors.enumeration, identity_errors: before.errors.identity + after.errors.identity };
}
export function memoryProbe(native, browser, { io = fs, now = () => performance.now() } = {}) {
  const known = new Map([[key(browser), browser]]), samples = [];
  return {
    known: () => [...known.values()], samples,
    async sample(name) {
      const started_ms = now(), before = await discover(browser, io);
      for (const member of before.members) known.set(key(member), member);
      const native_memory = await memberMemory(native, io), members = [];
      for (const member of before.members) members.push(await memberMemory(member, io));
      const after = await discover(browser, io);
      for (const member of after.members) known.set(key(member), member);
      const ended_ms = now();
      if (!finite(started_ms) || !finite(ended_ms) || ended_ms < started_ms) reject();
      const value = { name, clock: 'Node monotonic performance.now', started_ms, ended_ms, cost_ms: ended_ms - started_ms,
        native: native_memory, browser: aggregateBrowser(members, before, after) };
      samples.push(value); return value;
    },
  };
}
export function sampler(probe, { now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout, interval = 100 } = {}) {
  let stopped = false, timer, chain = Promise.resolve(), firstFailure = null;
  const windows = [];
  const sample = name => {
    if (stopped) return Promise.reject(new Error('Sampler stopped'));
    const task = chain.then(async () => {
      const start = now();
      try { return await probe.sample(name); } finally { windows.push({ start_ms: start, end_ms: now(), name }); }
    });
    chain = task.catch(error => { firstFailure ??= error; }); return task;
  };
  const tick = async () => {
    if (stopped) return;
    const start = now();
    try { await sample('periodic'); } catch { /* Retain the first rejection for stop, without overlapping the next sample. */ }
    if (!stopped) timer = schedule(tick, Math.max(0, interval - (now() - start)));
  };
  return {
    start() { if (timer !== undefined || stopped) reject(); timer = schedule(tick, interval); }, sample,
    async stop() { stopped = true; if (timer !== undefined) cancel(timer); await chain; if (firstFailure) throw firstFailure; },
    facts() { return { stopped, nominal_interval_ms: interval, windows: structuredClone(windows), failed: firstFailure !== null }; },
  };
}
export function memorySummary(probe, clock) {
  const samples = probe.samples;
  for (const name of ['baseline', ...boundaries]) {
    const matching = samples.filter(s => s.name === name);
    if (matching.length !== 1 || !matching[0].native.valid || !matching[0].browser.complete_for_observed_membership) reject();
  }
  const validNative = samples.filter(s => s.native.valid), validBrowser = samples.filter(s => s.browser.complete_for_observed_membership);
  if (!samples.length || !validNative.length || !validBrowser.length || !clock.stopped || clock.failed) reject();
  return { clock: 'Node monotonic performance.now; separate from page and Request clocks', nominal_interval_ms: 100,
    sample_count: samples.length, native_valid_samples: validNative.length, browser_complete_samples: validBrowser.length,
    window_ms: [samples[0].started_ms, samples.at(-1).ended_ms], sample_cost_ms: samples.map(s => s.cost_ms),
    start_gaps_ms: samples.slice(1).map((s, i) => s.started_ms - samples[i].started_ms),
    native_max_observed_rss_bytes: Math.max(...validNative.map(s => s.native.rss_bytes)),
    native_process_lifetime_hwm_bytes: Math.max(...validNative.map(s => s.native.lifetime_hwm_bytes)),
    browser_max_observed_tree_rss_bytes: Math.max(...validBrowser.map(s => s.browser.rss_bytes)), samples,
    limitations: ['Approximate Linux status RSS; shared pages can be double counted.', 'Non-atomic readable observed tree, not exhaustive whole-host memory.',
      'Short-lived processes and peaks between samples can be missed.', 'Native includes the test harness, HTTP and storage, not production-only server memory.',
      'Node, Cargo and Playwright driver memory excluded.', 'No true peak, unique memory, leak, constant RSS, SLA or ceiling claim.'] };
}

// Cleanup order is explicit. A rejected step must not hide the first failure or skip later resources.
export function resources(onFailure = () => {}) {
  const tasks = [], steps = []; let original = null;
  const fail = error => { if (original === null) { original = error; try { onFailure(); } catch {} } };
  return {
    register(name, order, action) { if (tasks.some(t => t.name === name)) reject(); tasks.push({ name, order, action }); },
    fail, cleanupFailed: () => steps.some(step => !step.ok),
    async cleanup() {
      for (const task of tasks.sort((a, b) => a.order - b.order)) {
        try { await task.action(); steps.push({ name: task.name, ok: true }); }
        catch (error) { fail(error); steps.push({ name: task.name, ok: false }); }
      }
      return { error: original, steps: structuredClone(steps), pass: original === null };
    },
  };
}
export async function acquireResource(owned, name, order, acquire, close) {
  const value = await acquire();
  owned.register(name, order, () => close(value));
  return value;
}
const bounded = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Observer control timed out')), ms); })]).finally(() => clearTimeout(timer));
};

// Spawn returns ownership immediately; initialization is a separate fallible operation.
export function acquireObserver(binding, fixture, { spawnChild = spawn, readIdentity = identity, checkRoot = rootProof, retire = retirement, waitBounded = bounded } = {}) {
  const cwd = join(fixture.root, 'observe');
  const env = { WI_NATIVE_RESTART_CHILD: '1', HOME: join(cwd, 'home'), XDG_CONFIG_HOME: join(cwd, 'xdg'), CODEX_HOME: join(cwd, 'codex'),
    TMPDIR: join(cwd, 'tmp'), TMP: join(cwd, 'tmp'), TEMP: join(cwd, 'tmp') };
  const argv = ['--ignored', '--exact', CHILD_TEST, '--nocapture', '--test-threads=1'];
  const child = spawnChild(binding.executable, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = [], waiters = [], samples = [], hashes = [createHash('sha256'), createHash('sha256')];
  const facts = { pid: child.pid, identity: null, phase: 'observe', cwd, argv, env, closed: false, reaped: false, code: null, signal: null,
    stderr_bytes: 0, stdout_bytes: 0, error: false, fallback: false, drained: false, expected_kill: false, same_start_alive: true,
    input_ended: false, cleanup_errors: [] };
  let failure, protocol, selected = false, closing = false, next = 1, origin;
  const fail = () => { failure ??= new Error('Observer rejected'); facts.error = true; for (const w of waiters.splice(0)) w.reject(failure); };
  try { protocol = restartProtocol('observe', child.pid); } catch { fail(); }
  const parser = restartParser(value => {
    protocol.reply(value); if (value.work) { workProof(value.work, 'observe'); samples.push({ event: value.event, id: value.id, work: value.work }); }
    if (value.event === 'stopped') facts.drained = value.drained;
    const i = waiters.findIndex(w => w.match(value)); if (i >= 0) waiters.splice(i, 1)[0].resolve(value); else queue.push(value);
  });
  child.stdout.on('data', bytes => { hashes[0].update(bytes); facts.stdout_bytes += bytes.length; try { parser.push(bytes); } catch { fail(); } });
  child.stderr.on('data', bytes => { hashes[1].update(bytes); facts.stderr_bytes += bytes.length; fail(); });
  child.on('error', fail); child.stdin.on('error', fail);
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    facts.closed = true; facts.code = code; facts.signal = signal;
    facts.stdout_sha256 = hashes[0].digest('hex'); facts.stderr_sha256 = hashes[1].digest('hex');
    try { parser.end(false); protocol.end(false); if (!closing || queue.length || waiters.length) reject(); } catch { fail(); }
    resolve();
  }));
  const wait = async match => {
    if (failure) throw failure;
    const i = queue.findIndex(match); if (i >= 0) return queue.splice(i, 1)[0];
    let waiter;
    try { return await waitBounded(new Promise((resolve, rejectWait) => { waiter = { match, resolve, reject: rejectWait }; waiters.push(waiter); }), 20_000); }
    finally { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); }
  };
  const request = async body => {
    if (failure || facts.closed) reject();
    const command = protocol.request({ ...body, id: next++ }), reply = wait(v => v.id === command.id);
    child.stdin.write(`${JSON.stringify(command)}\n`); return reply;
  };
  return {
    pid: child.pid, get origin() { return origin; },
    async initialize() {
      const candidate = await readIdentity(child.pid);
      if (candidate.state !== 'present' || !integer(candidate.pid) || candidate.pid === 0 || candidate.pid > 0xffffffff
        || candidate.pid !== child.pid || typeof candidate.start_ticks !== 'string'
        || !/^[1-9][0-9]*$/.test(candidate.start_ticks) || BigInt(candidate.start_ticks) > 0xffffffffffffffffn
        || candidate.executable !== binding.executable || candidate.cwd !== cwd || candidate.ppid !== process.pid) reject();
      // Only validated ownership can authorize a signal, even if the root check fails next.
      facts.identity = Object.freeze({ ...candidate });
      await checkRoot(fixture, 'observe');
      child.stdin.write(`${JSON.stringify({ root: fixture.root, phase: 'observe' })}\n`);
      origin = (await wait(v => v.event === 'ready')).origin;
      await request({ command: 'select', session_id: sid }); selected = true;
      await request({ command: 'sample' });
      return facts.identity;
    },
    sample: () => request({ command: 'sample' }),
    evidence: () => ({ ...facts, samples: structuredClone(samples) }),
    async stop() {
      if (!selected || facts.closed || failure) reject(); closing = true;
      await waitBounded(request({ command: 'stop' }), 5000); child.stdin.end(); facts.input_ended = true; await waitBounded(exited, 5000);
      const retired = await retire(facts.identity);
      facts.same_start_alive = retired.retirement === 'alive'; facts.reaped = ['absent', 'reused'].includes(retired.retirement);
      terminalProof(facts, false); return retired;
    },
    async emergency() {
      let cleanupError;
      const failed = (step, error) => { facts.cleanup_errors.push(step); facts.error = true; cleanupError ??= error; };
      closing = true;
      // We own the input and close event even when initialization never established a PID identity.
      if (!facts.input_ended) {
        try { child.stdin.end(); facts.input_ended = true; } catch (error) { failed('input-end', error); }
      }
      if (!facts.closed && facts.identity) {
        try {
          const current = await readIdentity(child.pid);
          if (!facts.closed && current.state === 'present' && same(current, facts.identity) && current.cwd === facts.identity.cwd) {
            facts.fallback = true; child.kill('SIGKILL');
          }
        } catch (error) { failed('identity-or-fallback', error); }
      }
      try { await waitBounded(exited, 2000); } catch (error) { failed('close', error); }
      if (cleanupError) throw cleanupError;
    },
  };
}

export function browserSourceProof(spec) {
  const ast = ts.createSourceFile('measurement.mjs', spec, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) reject();
  const imports = ast.statements.filter(ts.isImportDeclaration);
  const pin = imports.filter(s => s.moduleSpecifier.text === '../test-support/browser-pin.mjs');
  if (pin.length !== 1 || pin[0].importClause?.getText(ast) !== '{ browserPin, browserLaunchOptions }') reject();
  const names = { browserLaunchOptions: 0, browserPin: 0, chromium: 0 }, launches = [], connects = [], versions = [];
  function visit(node) {
    if (ts.isIdentifier(node) && Object.hasOwn(names, node.text)) names[node.text]++;
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(ast) === 'chromium.launchServer') launches.push(node);
      if (node.expression.getText(ast) === 'chromium.connect') connects.push(node);
      if (node.expression.getText(ast) === 'expect(browserVersion).toBe') versions.push(node);
      if (['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Reflect.set', 'Reflect.deleteProperty'].includes(node.expression.getText(ast))
        && node.arguments[0]?.getText(ast) === 'process.env') reject();
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && node.left.getText(ast).startsWith('process.env')
      && node.left.getText(ast) !== 'process.env.WI_C3A_FIXTURE') reject();
    if (ts.isDeleteExpression(node) && node.expression.getText(ast).startsWith('process.env')) reject();
    ts.forEachChild(node, visit);
  }
  visit(ast);
  // Extra references also reject a local shadow or a second browser-selection route.
  if (names.browserLaunchOptions !== 3 || names.browserPin !== 2 || names.chromium !== 4) reject();
  const cases = ast.statements.filter(ts.isExpressionStatement).map(s => s.expression)
    .filter(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'test');
  if (cases.length !== 1 || !ts.isArrowFunction(cases[0].arguments[1]) || !ts.isBlock(cases[0].arguments[1].body)) reject();
  const tries = cases[0].arguments[1].body.statements.filter(ts.isTryStatement);
  const early = tries[0]?.tryBlock.statements[0];
  if (tries.length !== 1 || !early || !ts.isExpressionStatement(early) || early.expression.getText(ast) !== 'browserLaunchOptions()') reject();
  if (launches.length !== 1 || launches[0].arguments.length !== 1 || !ts.isObjectLiteralExpression(launches[0].arguments[0])) reject();
  const options = launches[0].arguments[0].properties;
  if (options.length !== 3 || options[0].getText(ast) !== "host: '127.0.0.1'"
    || !ts.isPropertyAssignment(options[1]) || options[1].name.getText(ast) !== 'headless' || options[1].initializer.kind !== ts.SyntaxKind.TrueKeyword
    || !ts.isSpreadAssignment(options[2]) || options[2].expression.getText(ast) !== 'browserLaunchOptions()') reject();
  if (connects.length !== 1 || connects[0].arguments.length !== 1 || connects[0].arguments[0].getText(ast) !== 'server.wsEndpoint()') reject();
  if (versions.length !== 1 || versions[0].arguments.length !== 1 || versions[0].arguments[0].getText(ast) !== 'browserPin.version') reject();
  return true;
}

export function sourceGuard(spec, helper) {
  browserSourceProof(spec);
  const forbidden = [/newCDPSession/, /_channel/, /_connection/, /wsPath\s*:/, /executablePath\s*:/, /args\s*:/,
    /\.json\s*\(/, /\.text\s*\(/, /\.arrayBuffer\s*\(/, /\.body\s*\(/, /test\.(skip|fixme|only)\s*\(/,
    /globalThis\.fetch\s*=/, /prototype\./, /console\./, /\.stack\b/, /JSON\.stringify\(process\.env\)/,
    /JSON\.stringify\((error|request|reply|response|server|browser|context)\)/];
  const implementation = helper.slice(0, helper.indexOf('export function sourceGuard'));
  if ((spec.match(/discoverFixture\s*\(/g) ?? []).length !== 1 || /discoverFixture\s*\(/.test(implementation)
    || !spec.includes('if (executable === undefined) {\n      executable = await discoverFixture();\n      process.env.WI_C3A_FIXTURE = executable;\n    }')
    || forbidden.some(re => re.test(spec) || re.test(implementation)) || !spec.includes("host: '127.0.0.1'")
    || !spec.includes('nativeBinding(') || !helper.includes('q.sizes()') || !helper.includes('q.timing()')
    || !spec.includes("context.on('requestfinished', network.finished)") || (spec.match(/server\.wsEndpoint\(\)/g) ?? []).length !== 1
    || !spec.includes('() => chromium.connect(server.wsEndpoint())')) reject();
  return true;
}
