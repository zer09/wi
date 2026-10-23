import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm as removeFixture } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { browserPin } from '../test-support/browser-pin.mjs';
import { transportTiming, transportSizes, measurementCollector, installColdObserver, coldProof, parseStat, parseMemory,
  identity, retirement, aggregateBrowser, memoryProbe, sampler, memorySummary, resources, acquireResource, acquireObserver,
  sourceGuard, boundaries } from '../test-support/display-measurements.mjs';
import { sid, previous, expectedPage, newRecord, newFaults } from '../test-support/upgrade-display-parity.mjs';
import { CHILD_TEST } from '../test-support/fixture.mjs';
import { createRestartRoot, workKeys, terminalProof } from '../test-support/restart-display.mjs';

const timing = { startTime: 123456, requestStart: 2, responseStart: 8, responseEnd: 10 };
const sizes = { requestBodySize: 0, requestHeadersSize: 100, responseBodySize: 200, responseHeadersSize: 50 };
const origin = 'http://127.0.0.1:1234', owner = 'synthetic-owner';
const base = `/v1/sessions/${sid}/conversation`;
function networkCase() {
  const record = newRecord(), faults = newFaults(), assetReads = [];
  return { record, faults, network: measurementCollector({ origin, owner, record, faults, assetReads }) };
}
function request(suffix = '', options = {}) {
  return { url: () => `${origin}${base}${suffix}`, method: () => 'GET', headers: () => ({ authorization: `Bearer ${owner}` }),
    timing: () => ({ ...timing }), sizes: async () => ({ ...sizes }),
    body: () => assert.fail('original body forbidden'), json: () => assert.fail('original JSON forbidden'), ...options };
}
function response(q, options = {}) {
  return { request: () => q, url: q.url, status: () => 200,
    headers: () => ({ 'content-type': q.url().includes('/events') ? 'text/event-stream' : 'application/json',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }),
    body: () => assert.fail('original response body forbidden'), json: () => assert.fail('original response JSON forbidden'), ...options };
}
async function operation(c, phase, mutation = () => {}) {
  c.network.begin(phase);
  if (phase === 'older') { c.record.newest = true; c.record.intent = true; }
  const q = request(phase === 'older' ? `?before=${encodeURIComponent(previous)}` : '');
  c.network.request(q); const reply = response(q); mutation(q, reply); c.network.response(reply);
  if (phase !== 'older') {
    const stream = request(`/events?after=${encodeURIComponent(expectedPage(1).live_after)}`, {
      timing: () => ({ ...timing, responseEnd: -1 }), sizes: () => assert.fail('SSE size forbidden') });
    c.network.request(stream); c.network.response(response(stream)); c.network.finished(stream);
  }
  c.network.finished(q); await c.network.drain(); return { q, reply };
}

test('C52 public timing and sizes reject unavailable nonfinite reversed or missing metadata', async t => {
  assert.equal(transportTiming(timing).total_ms, 8); assert.equal(transportTiming(timing, true).download_ms, undefined);
  for (const key of Object.keys(timing)) for (const bad of [-1, NaN, Infinity, undefined, '1']) await t.test(`${key} invalid ${String(bad)}`, () => {
    assert.throws(() => transportTiming({ ...timing, [key]: bad }));
  });
  for (const value of [{ ...timing, responseStart: 1 }, { ...timing, responseEnd: 7 }]) assert.throws(() => transportTiming(value));
  assert.deepEqual(transportSizes(sizes), sizes);
  for (const key of Object.keys(sizes)) for (const bad of [-1, NaN, Infinity, undefined, 0.5]) await t.test(`size ${key} ${String(bad)}`, () => {
    assert.throws(() => transportSizes({ ...sizes, [key]: bad }));
  });
  assert.throws(() => transportSizes({ ...sizes, requestBodySize: 1 }));
  for (const key of ['requestHeadersSize', 'responseBodySize', 'responseHeadersSize']) assert.throws(() => transportSizes({ ...sizes, [key]: 0 }));
});
test('C52 actual collector binds two distinct epochs and Before, never reads API bodies or SSE completion', async () => {
  const c = networkCase(); await operation(c, 'cold'); await operation(c, 'warm'); await operation(c, 'older');
  assert.equal(c.network.proof().streams.length, 2); assert.equal(c.record.snapshots.length, 2); assert.equal(c.record.older.length, 1);
  assert.equal(c.network.proof().operations.warm.requestfinished, true); assert.equal(c.network.proof().streams[0].handshake.total_ms, undefined);
  assert.equal(JSON.stringify(c.network.facts()).includes(owner), false);
});
test('C52 actual collector does not let retained warm DOM stand in for a delayed response', async () => {
  const c = networkCase(); await operation(c, 'cold'); c.network.begin('warm');
  assert.equal(c.network.ready('warm'), false);
  const q = request(); c.network.request(q); assert.equal(c.network.ready('warm'), false);
  c.network.response(response(q)); assert.equal(c.network.ready('warm'), false);
  c.network.finished(q); await c.network.drain(); assert.equal(c.network.ready('warm'), false);
  const s = request(`/events?after=${encodeURIComponent(expectedPage(1).live_after)}`);
  c.network.request(s); c.network.response(response(s)); assert.equal(c.network.ready('warm'), true);
});
test('C52 collector rejects identity resource phase status media duplicates and premature completion', async t => {
  const mutations = [
    ['status', (q, r) => { r.status = () => 500; }],
    ['media', (q, r) => { r.headers = () => ({ 'content-type': 'text/plain' }); }],
    ['no-store', (q, r) => { const h = r.headers(); r.headers = () => ({ ...h, 'cache-control': 'public' }); }],
    ['identity', (q, r) => { r.request = () => request(); }],
    ['URL', (q, r) => { r.url = () => `${origin}${base}?before=other`; }],
    ['size', q => { q.sizes = async () => ({ ...sizes, responseBodySize: 0 }); }],
    ['timing', q => { q.timing = () => ({ ...timing, responseEnd: -1 }); }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const c = networkCase(); await operation(c, 'cold', mutate); assert.equal(c.network.ready('cold'), false); assert.throws(() => c.network.proof());
  });
  for (const name of ['duplicate-request', 'duplicate-response', 'duplicate-finished', 'wrong-resource', 'wrong-origin', 'no-phase', 'no-response']) await t.test(name, async () => {
    const c = networkCase(); if (name !== 'no-phase') c.network.begin('cold');
    let q = request();
    if (name === 'wrong-resource') q = request('?before=other');
    if (name === 'wrong-origin') q = request('', { url: () => `http://127.0.0.1:1235${base}` });
    c.network.request(q); if (name === 'duplicate-request') c.network.request(q);
    if (name !== 'no-response') { const r = response(q); c.network.response(r); if (name === 'duplicate-response') c.network.response(r); }
    c.network.finished(q); if (name === 'duplicate-finished') c.network.finished(q);
    await c.network.drain(); assert.throws(() => c.network.proof()); assert.equal(c.network.facts().failed, true);
  });
  const c = networkCase(); assert.throws(() => c.network.begin('warm')); c.network.begin('cold'); assert.throws(() => c.network.begin('warm'));
});
test('C52 external request is blocked without retaining an endpoint or raw headers', async () => {
  const c = networkCase(); let aborted = false;
  await c.network.route({ request: () => ({ url: () => 'https://invalid.example/' }), abort: async () => { aborted = true; } });
  assert.equal(aborted, true); assert.equal(c.faults.external, 1); assert.equal(JSON.stringify(c.network.facts()).includes('invalid.example'), false);
});
function pageRealm() {
  let clock = 100, callback, b = false, disconnected = false;
  const heading = { textContent: 'Empty session' }, transcript = { querySelector: () => b ? {} : null };
  const env = { performance: { now: () => clock++ }, document: { querySelector: selector => selector.includes('title') ? heading : transcript },
    MutationObserver: class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } } };
  return { env, update(text, present = b) { heading.textContent = text; b = present; callback(); }, finish() { const value = env.__c52Cold.finish(); assert.equal(disconnected, true); return coldProof(value); } };
}
test('C52 cold-only heading timeline keeps observation and empty labels distinct and page clock isolated', async t => {
  const p = pageRealm(); installColdObserver({ title: 'Title', run: 'B' }, p.env); p.update('Preparing conversation…'); p.update('Title', true);
  const v = p.finish(); assert.equal(v.preparing_status, 'observed'); assert.ok(v.preparing_to_identity_ms > 0); assert.equal(v.clock, 'page performance.now');
  for (const label of ['Preparing conversation… Retained content is stale.', 'No conversation loaded.', 'Empty session', 'Title']) await t.test(label, () => {
    const p = pageRealm(); installColdObserver({ title: 'Title', run: 'B' }, p.env); p.update(label); p.update('Title', true);
    assert.equal(p.finish().preparing_to_identity_ms, null);
  });
  const coalesced = pageRealm(); installColdObserver({ title: 'Title', run: 'B' }, coalesced.env); coalesced.update('Title', true);
  assert.equal(coalesced.finish().preparing_status, 'unavailable-transient-unobserved-or-coalesced');
  for (const key of ['armed_ms', 'exact_dom_upper_ms', 'preparing_ms', 'installed_ms']) assert.throws(() => coldProof({ ...v, [key]: -1 }));
  assert.throws(() => coldProof({ ...v, preparing_to_identity_ms: 0 }));
});

const stat = (pid, ppid, start = '42') => `${pid} (synthetic ) name) S ${ppid} ${Array(17).fill('0').join(' ')} ${start} 0 0`;
const ident = (pid, ppid, executable = '/synthetic/browser') => ({ state: 'present', pid, ppid, start_ticks: '42', executable, cwd: '/synthetic' });
function procFixture() {
  const values = new Map(), errors = new Map(), statusReads = [];
  const add = (pid, ppid, rss = 10, hwm = 20, executable = '/synthetic/browser') => {
    values.set(`/proc/${pid}/stat`, stat(pid, ppid)); values.set(`/proc/${pid}/exe`, executable); values.set(`/proc/${pid}/cwd`, '/synthetic');
    values.set(`/proc/${pid}/status`, `VmRSS:\t${rss} kB\nVmHWM:\t${hwm} kB\n`); values.set(`/proc/${pid}`, true);
  };
  const read = async path => { if (errors.has(path)) throw { code: errors.get(path) }; if (!values.has(path)) throw { code: 'ENOENT' }; return values.get(path); };
  const io = { readFile: async path => { if (path.endsWith('/status')) statusReads.push(path); return read(path); }, readlink: read, lstat: read,
    readdir: async () => [...values.keys()].filter(p => /^\/proc\/\d+$/.test(p)).map(p => p.split('/').at(-1)) };
  return { io, values, errors, add, statusReads };
}
test('C52 strict Linux stat and kB arithmetic controls', async t => {
  assert.deepEqual(parseStat(stat(2, 1), 2), { pid: 2, ppid: 1, start_ticks: '42' });
  assert.deepEqual(parseMemory('VmRSS: 10 kB\nVmHWM: 20 kB\n'), { rss_bytes: 10240, lifetime_hwm_bytes: 20480 });
  for (const raw of ['VmRSS: 1 MB\nVmHWM: 2 kB', 'VmRSS: -1 kB\nVmHWM: 2 kB', 'VmRSS: 1.5 kB\nVmHWM: 2 kB',
    'VmRSS: 01 kB\nVmHWM: 2 kB', 'VmRSS: 1 kB\nVmRSS: 1 kB\nVmHWM: 2 kB', 'VmRSS: 20 kB\nVmHWM: 10 kB',
    'VmRSS: 99999999999999999999 kB\nVmHWM: 99999999999999999999 kB', 'VmRSS: 1 kB']) await t.test(`invalid memory ${raw.length}`, () => assert.throws(() => parseMemory(raw)));
  for (const raw of [stat(3, 1), stat(2, -1), stat(2, 1, '01'), stat(2, 1, '18446744073709551616'), stat(2, 4294967296), '2 broken']) assert.throws(() => parseStat(raw, 2));
});
test('C52 retirement distinguishes unreadable stat or directory from independently confirmed absence and PID reuse', async () => {
  const f = procFixture(), owned = ident(2, 1); f.add(2, 1);
  assert.equal((await retirement(owned, f.io)).retirement, 'alive');
  assert.equal((await retirement({ state: 'unknown', pid: 2 }, f.io)).retirement, 'unknown');
  assert.equal((await retirement({ ...owned, start_ticks: undefined }, f.io)).retirement, 'unknown');
  f.values.set('/proc/2/stat', stat(2, 1, '43')); assert.equal((await retirement(owned, f.io)).retirement, 'reused');
  f.values.set('/proc/2/stat', stat(2, 1)); f.values.set('/proc/2/exe', '/other'); assert.equal((await retirement(owned, f.io)).retirement, 'unknown');
  f.errors.set('/proc/2/stat', 'ENOENT'); assert.equal((await identity(2, f.io)).state, 'unknown');
  f.errors.set('/proc/2', 'EACCES'); assert.equal((await retirement(owned, f.io)).retirement, 'unknown');
  f.errors.set('/proc/2', 'ENOENT'); assert.equal((await retirement(owned, f.io)).retirement, 'absent');
  f.errors.set('/proc/2/stat', 'EACCES'); assert.equal((await retirement(owned, f.io)).retirement, 'unknown');
  f.errors.delete('/proc/2/stat'); f.errors.delete('/proc/2'); f.values.set('/proc/2/exe', owned.executable); f.values.set('/proc/2/stat', stat(2, 9));
  assert.equal((await retirement(owned, f.io)).retirement, 'unknown');
});
test('C52 real probe includes only owned ancestry, checks identities and does not sum historical HWMs', async () => {
  const f = procFixture(); f.add(1, 99, 2, 3, '/synthetic/native'); f.add(2, 99, 10, 200); f.add(3, 2, 20, 500); f.add(4, 777, 999, 999);
  let clock = 0; const probe = memoryProbe(ident(1, 99, '/synthetic/native'), ident(2, 99), { io: f.io, now: () => clock++ });
  const value = await probe.sample('baseline'); assert.equal(value.browser.rss_bytes, 30 * 1024); assert.equal(value.native.lifetime_hwm_bytes, 3 * 1024);
  assert.equal(probe.known().length, 2); assert.ok(f.statusReads.every(p => !p.includes('/4/')));
  f.errors.set('/proc/3/status', 'EACCES'); const partial = await probe.sample('partial');
  assert.equal(partial.browser.rss_bytes, null); assert.equal(partial.browser.complete_for_observed_membership, false); assert.equal(partial.browser.partial_errors, 1);
  f.errors.delete('/proc/3/status'); let reads = 0; const original = f.io.readlink;
  f.io.readlink = async path => path === '/proc/3/exe' && ++reads > 1 ? '/changed' : original(path);
  assert.equal((await probe.sample('exec-churn')).browser.complete_for_observed_membership, false);
});
test('C52 churn and incomplete aggregate never become a zero or a valid maximum', () => {
  const root = ident(2, 1), child = ident(3, 2), errors = { enumeration: 0, stat: 0, identity: 0 };
  const before = { members: [root], errors }, after = { members: [root, child], errors };
  const item = { identity: root, valid: true, rss_bytes: 10, lifetime_hwm_bytes: 1000 };
  assert.equal(aggregateBrowser([item], before, after).rss_bytes, null);
  assert.equal(aggregateBrowser([], { members: [], errors }, { members: [], errors }).complete_for_observed_membership, false);
  assert.equal(aggregateBrowser([item], before, before).rss_bytes, 10);
  assert.equal(aggregateBrowser([item], { ...before, errors: { ...errors, enumeration: 1 } }, before).rss_bytes, null);
});
test('C52 sampler serializes periodic and boundary work, and stop awaits pending work with no late sample', async () => {
  let callback, active = 0, max = 0, release, count = 0, cancelled = false, clock = 0;
  const held = new Promise(resolve => { release = resolve; });
  const probe = { sample: async () => { count++; active++; max = Math.max(max, active); if (count === 1) await held; active--; } };
  const s = sampler(probe, { now: () => clock++, schedule: fn => { callback = fn; return 1; }, cancel: () => { cancelled = true; } });
  s.start(); const periodic = callback(); await Promise.resolve(); const boundary = s.sample('before-cold');
  let stopped = false; const done = s.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  release(); await Promise.all([periodic, boundary, done]); assert.equal(max, 1); assert.equal(count, 2); assert.equal(cancelled, true);
  await callback(); assert.equal(count, 2); await assert.rejects(s.sample('late')); assert.equal(s.facts().stopped, true);
});
test('C52 sample failures remain original at stop, and required named boundaries cannot be omitted', async () => {
  const error = new Error('synthetic failure'); const s = sampler({ sample: async () => { throw error; } });
  await assert.rejects(s.sample('sample'), e => e === error); await assert.rejects(s.stop(), e => e === error);
  assert.throws(() => memorySummary({ samples: [] }, { stopped: true }));
  const sample = name => ({ name, started_ms: 0, ended_ms: 1, cost_ms: 1, native: { valid: true, rss_bytes: 10, lifetime_hwm_bytes: 20 }, browser: { complete_for_observed_membership: true, rss_bytes: 30 } });
  const probe = { samples: ['baseline', ...boundaries].map(sample) }; assert.equal(memorySummary(probe, { stopped: true }).browser_max_observed_tree_rss_bytes, 30);
  probe.samples[2].browser.complete_for_observed_membership = false; assert.throws(() => memorySummary(probe, { stopped: true }));
});
test('C52 acquired resources register before later rejection, connect failure still closes server, and all cleanup continues', async t => {
  const names = ['root', 'native', 'server', 'connect', 'context', 'sampler', 'sample'];
  for (let index = 0; index < names.length; index++) await t.test(`after ${names[index]}`, async () => {
    const r = resources(), events = [], error = new Error('original synthetic failure');
    try {
      for (let i = 0; i <= index; i++) {
        if (names[i] === 'connect') throw error;
        await acquireResource(r, names[i], -i, async () => names[i], async value => { events.push(value); });
        if (i === index) throw error;
      }
    } catch (e) { r.fail(e); }
    const result = await r.cleanup(); assert.equal(result.error, error);
    assert.equal(events.includes('server'), index >= 2); assert.equal(events.includes('native'), index >= 1); assert.equal(events.includes('root'), true);
  });
  for (const failing of ['sample-stop', 'context-close', 'connection-close', 'server-close', 'native-Stop']) await t.test(failing, async () => {
    const r = resources(), events = [], original = new Error('original'), later = new Error('later'); r.fail(original);
    for (const [i, name] of ['sample-stop', 'context-close', 'connection-close', 'server-close', 'native-Stop', 'root'].entries()) r.register(name, i, async () => { events.push(name); if (name === failing) throw later; });
    const result = await r.cleanup(); assert.equal(result.error, original); assert.equal(events.length, 6); assert.equal(result.steps.filter(s => !s.ok).length, 1);
    assert.equal(JSON.stringify(result.steps).includes('later'), false);
  });
});
function fakeObserver(failStop = false) {
  const child = new EventEmitter(); child.pid = 900; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const work = Object.fromEntries(workKeys.map(k => [k, k === 'fresh_empty' ? false : 0]));
  const emit = v => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ protocol: 1, ...v })}\n`));
  child.stdin.write = raw => {
    const v = JSON.parse(raw);
    queueMicrotask(() => {
      if (v.root) {
        child.stdout.emit('data', Buffer.from(`\nrunning 1 test\ntest ${CHILD_TEST} ... `));
        emit({ event: 'ready', phase: 'observe', pid: child.pid, origin });
      } else if (v.command === 'select') emit({ event: 'selected', id: v.id });
      else if (v.command === 'sample') emit({ event: 'sample', id: v.id, work });
      else if (failStop) child.stderr.emit('data', Buffer.from('synthetic unlogged failure'));
      else emit({ event: 'stopped', id: v.id, work, drained: true });
    });
  };
  child.stdin.end = () => { if (!failStop) queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s\n'));
    child.emit('close', 0, null);
  }); };
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
  const owned = { ...ident(900, process.pid, '/synthetic/native'), cwd: '/synthetic/observe' };
  return { child, deps: { spawnChild: () => child, readIdentity: async () => owned, checkRoot: async () => {}, retire: async () => ({ ...owned, retirement: 'absent' }) } };
}
test('C52 actual one-process native wrapper validates normal Stop and quarantines fallback as failed cleanup', async () => {
  const f = fakeObserver(), observer = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, f.deps);
  await observer.initialize(); await observer.sample(); assert.equal((await observer.stop()).retirement, 'absent'); terminalProof(observer.evidence(), false);
  assert.equal(observer.evidence().samples.length, 3); assert.equal(observer.evidence().fallback, false);
  const bad = fakeObserver(true), failed = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, bad.deps);
  await failed.initialize(); await assert.rejects(failed.stop()); await failed.emergency(); assert.equal(failed.evidence().fallback, true);
  assert.throws(() => terminalProof(failed.evidence(), false));
});
function partialObserver({ candidate, current, rootReject = true, identityReject = false, inputReject = false, killReject = false, pending = false, closeReject = false } = {}) {
  const f = fakeObserver(), events = [], original = new Error('original synthetic initialization failure');
  const owned = { ...ident(900, process.pid, '/synthetic/native'), cwd: '/synthetic/observe' };
  const initial = candidate ?? owned;
  let reads = 0;
  f.deps.readIdentity = async () => {
    events.push('identity'); reads++;
    if (identityReject) throw original;
    return reads === 1 ? initial : current ?? owned;
  };
  f.deps.checkRoot = async () => { events.push('root'); if (rootReject) throw original; };
  const close = () => { events.push('close'); f.child.emit('close', 0, null); };
  f.child.stdin.end = () => { events.push('input-end'); if (!pending) queueMicrotask(close); if (inputReject) throw new Error('synthetic input failure'); };
  f.child.kill = () => { events.push('signal'); if (killReject) throw new Error('synthetic signal failure'); if (!pending) queueMicrotask(close); return true; };
  f.deps.waitBounded = async (promise, ms) => {
    if (ms === 2000) { events.push('await-close'); if (closeReject) throw new Error('synthetic close timeout'); }
    return promise;
  };
  return { ...f, events, original, owned, initial, close };
}
test('C52 R1 real wrapper validates immutable ownership before a separately rejecting root', async () => {
  const f = partialObserver(), observer = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, f.deps);
  await assert.rejects(observer.initialize(), e => e === f.original);
  assert.deepEqual(f.events, ['identity', 'root']); assert.notEqual(observer.evidence().identity, f.initial);
  assert.equal(Object.isFrozen(observer.evidence().identity), true);
  f.initial.executable = '/rejected-after-capture'; assert.equal(observer.evidence().identity.executable, '/synthetic/native');
  await observer.emergency(); assert.equal(observer.evidence().input_ended, true); assert.equal(observer.evidence().closed, true);
  assert.equal(observer.evidence().reaped, false); assert.throws(() => terminalProof(observer.evidence(), false));
});
test('C52 R1 real wrapper never grants rejected or unknown candidates signal authority but resolves pipes and close', async t => {
  const owned = { ...ident(900, process.pid, '/synthetic/native'), cwd: '/synthetic/observe' };
  const candidates = [{ state: 'unknown', pid: 900 }, { state: 'absent', pid: 900 },
    ...[{ executable: '/other' }, { cwd: '/other' }, { ppid: process.pid + 1 }, { pid: 901 }, { pid: 0 },
      { start_ticks: undefined }, { start_ticks: 42 }, { start_ticks: '01' }, { start_ticks: '18446744073709551616' }].map(change => ({ ...owned, ...change }))];
  for (const [index, candidate] of candidates.entries()) await t.test(`candidate ${index}`, async () => {
    const f = partialObserver({ candidate, current: candidate }), observer = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, f.deps);
    await assert.rejects(observer.initialize()); assert.equal(observer.evidence().identity, null); assert.equal(f.events.includes('root'), false);
    await observer.emergency(); assert.equal(f.events.includes('input-end'), true); assert.equal(f.events.includes('await-close'), true);
    assert.equal(f.events.includes('signal'), false); assert.equal(observer.evidence().closed, true);
  });
});
test('C52 R1 real wrapper resolves acquired pipes and close after initial identity reading throws', async () => {
  const f = partialObserver({ identityReject: true }), observer = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, f.deps);
  await assert.rejects(observer.initialize(), e => e === f.original); await observer.emergency();
  assert.equal(observer.evidence().identity, null); assert.equal(observer.evidence().input_ended, true);
  assert.equal(observer.evidence().closed, true); assert.equal(f.events.includes('signal'), false);
});
test('C52 R1 real wrapper awaits owned close for absent reused unreadable unknown and matching alive identities', async t => {
  for (const state of ['absent', 'reused', 'missing-stat', 'unreadable-stat', 'unreadable-directory', 'exec-change', 'cwd-change', 'parent-change', 'alive']) await t.test(state, async () => {
    const f = partialObserver({ pending: true }), io = procFixture(); io.add(900, process.pid, 10, 20, '/synthetic/native');
    io.values.set('/proc/900/cwd', '/synthetic/observe');
    if (state === 'absent') { io.errors.set('/proc/900/stat', 'ENOENT'); io.errors.set('/proc/900', 'ENOENT'); }
    if (state === 'reused') io.values.set('/proc/900/stat', stat(900, process.pid, '43'));
    if (state === 'missing-stat' || state === 'unreadable-directory') io.errors.set('/proc/900/stat', 'ENOENT');
    if (state === 'unreadable-stat') io.errors.set('/proc/900/stat', 'EACCES');
    if (state === 'unreadable-directory') io.errors.set('/proc/900', 'EACCES');
    if (state === 'exec-change') io.values.set('/proc/900/exe', '/other');
    if (state === 'cwd-change') io.values.set('/proc/900/cwd', '/other');
    if (state === 'parent-change') io.values.set('/proc/900/stat', stat(900, process.pid + 1));
    let reads = 0; f.deps.readIdentity = async () => ++reads === 1 ? f.owned : identity(900, io.io);
    const observer = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, f.deps);
    await assert.rejects(observer.initialize(), e => e === f.original);
    let done = false; const cleanup = observer.emergency().then(() => { done = true; });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(done, false); assert.equal(f.events.includes('await-close'), true);
    assert.equal(f.events.filter(e => e === 'signal').length, state === 'alive' ? 1 : 0);
    f.close(); await cleanup; assert.equal(done, true); assert.equal(observer.evidence().input_ended, true);
    const retired = await retirement(f.owned, io.io);
    const expected = { absent: 'absent', reused: 'reused', alive: 'alive', 'cwd-change': 'alive' };
    assert.equal(retired.retirement, expected[state] ?? 'unknown');
    assert.equal(observer.evidence().reaped, false); assert.throws(() => terminalProof(observer.evidence(), false));
  });
});
test('C52 R1 partial cleanup preserves original failure and continues after input signal or pending-close rejection', async t => {
  for (const variant of ['input', 'signal', 'close', 'unknown-close']) await t.test(variant, async () => {
    const f = partialObserver({ inputReject: variant === 'input', killReject: variant === 'signal', pending: variant !== 'input',
      closeReject: variant !== 'input', candidate: variant === 'unknown-close' ? { state: 'unknown', pid: 900 } : undefined });
    const observer = acquireObserver({ executable: '/synthetic/native' }, { root: '/synthetic' }, f.deps), r = resources(), later = [];
    let original; try { await observer.initialize(); } catch (error) { original = error; r.fail(error); }
    r.register('stop', 1, () => observer.stop()); r.register('emergency', 2, () => observer.emergency());
    r.register('retirement', 3, async () => { later.push('retirement'); throw new Error('synthetic unknown retirement'); });
    r.register('root', 4, async () => { later.push('root-retained'); if (r.cleanupFailed()) throw new Error('Root retained'); });
    const result = await r.cleanup(); assert.equal(result.error, original); assert.deepEqual(later, ['retirement', 'root-retained']);
    assert.ok(observer.evidence().cleanup_errors.length); assert.ok(f.events.includes('await-close'));
    assert.equal(f.events.includes('signal'), variant === 'signal' || variant === 'close');
    assert.equal(observer.evidence().closed, variant === 'input');
    if (!observer.evidence().closed) f.close();
  });
});

async function specCase(options = {}) {
  const source = await readFile(new URL('../e2e/display-measurements.spec.mjs', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../test-support/display-measurements.mjs', import.meta.url), 'utf8');
  const bindingSource = await readFile(new URL('../test-support/restart-display.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('binding.mjs', bindingSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'nativeBinding').getText(ast).replace('export ', '');
  const script = source.replace(/^import[\s\S]*?;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../e2e/display-measurements.spec.mjs', import.meta.url).href));
  const events = [], saved = new Map(), synthetic = new Error('original synthetic failure'), publication = new Error('synthetic publication failure');
  const fixturePath = '/synthetic/compiler', parentReads = [], forwarded = [], removed = [];
  const env = new Proxy({ WI_C3A_FIXTURE: fixturePath, WI_BROWSER_FIXTURE_PARENT: '/synthetic/private-parent', ...options.env }, {
    get(target, key) { if (key === 'WI_BROWSER_FIXTURE_PARENT') { parentReads.push(key); events.push('parent-read'); } return target[key]; },
  });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = new Map([[fixturePath, Buffer.from('synthetic executable')]]);
  for (const file of ['src/providers/openai_codex/tests/replay/http_api_joined/browser.rs', 'src/providers/openai_codex/tests/replay/http_api_joined/browser/restart.rs']) {
    files.set(join('/synthetic/repository', file), await readFile(new URL(`../../${file}`, import.meta.url)));
  }
  if (options.integrity === 'digest') env.WI_C47_FIXTURE_SHA256 = 'wrong';
  if (options.integrity === 'empty-digest') env.WI_C47_FIXTURE_SHA256 = '';
  if (options.integrity === 'matching-digest') env.WI_C47_FIXTURE_SHA256 = sha(files.get(fixturePath));
  if (options.integrity === 'source') files.set(join('/synthetic/repository', 'src/providers/openai_codex/tests/replay/http_api_joined/browser.rs'), Buffer.from('changed source'));
  const localProcess = { env, pid: process.pid };
  const bind = new Function('process', 'ROOT', 'isAbsolute', 'join', 'realpath', 'lstat', 'readFile', 'sha', 'reject', `${fn}; return nativeBinding;`)(
    localProcess, '/synthetic/repository', isAbsolute, join, async path => options.integrity === 'canonical' ? '/other' : path,
    async () => ({ isFile: () => options.integrity !== 'file' }), async path => { if (!files.has(path)) throw synthetic; return files.get(path); }, sha, () => { throw synthetic; });
  let callback, observer, cleanupResult, serverClosed = false;
  const raise = name => { events.push(name); if (options.injected === name) throw synthetic; };
  const chrome = ident(902, process.pid), f = options.partial ?? fakeObserver(options.injected === 'native-stop');
  if (!options.partial) f.deps.checkRoot = async () => { raise('initialize'); };
  const locator = { fill: async () => {}, click: async () => {}, textContent: async () => '', evaluate: async () => true };
  const page = { on() {}, goto: async () => {}, getByLabel: () => locator, locator: () => locator, getByRole: () => locator };
  const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, route: async () => {}, on() {}, newPage: async () => page,
    close: async () => { raise('context-close'); } };
  const browser = { version: () => options.browserVersion ?? browserPin.version, newContext: async () => { raise('context'); return context; }, close: async () => { raise('browser-close'); } };
  const server = { process: () => ({ pid: 902 }), wsEndpoint: () => 'synthetic-unlogged-control',
    close: async () => { raise('server-close'); serverClosed = true; }, kill: async () => { events.push('browser-emergency'); serverClosed = true; } };
  function fakeExpect(value) { return { toBe: expected => assert.equal(value, expected), toEqual: expected => assert.deepEqual(value, expected),
    toContain: expected => assert.ok(value.includes(expected)), toHaveValue: async () => {}, toHaveCount: async () => {} }; }
  fakeExpect.poll = fn => ({ toBe: async expected => assert.equal(await fn(), expected) });
  const fakeTest = (name, body) => { events.push('collected'); callback = body; }; fakeTest.use = () => {};
  const sampling = { start() { raise('sampler-start'); }, sample: async () => { raise('sample'); throw synthetic; },
    stop: async () => { raise('sampler-stop'); }, facts: () => ({ stopped: true }) };
  let reserved = false;
  const output = env.WI_C52_EVIDENCE ?? '/synthetic/test-output/c52-evidence';
  const values = { process: localProcess, test: fakeTest, expect: fakeExpect,
    browserPin, browserLaunchOptions: (...args) => {
      assert.deepEqual(args, []); raise('browser-admission');
      if (events.filter(e => e === 'browser-admission').length === options.browserReject) throw synthetic;
      return Object.freeze({ executablePath: '/synthetic/admitted-browser' });
    },
    chromium: { launchServer: async options => {
      assert.deepEqual(options, { host: '127.0.0.1', headless: true, executablePath: '/synthetic/admitted-browser' });
      raise('launch'); return server;
    }, connect: async () => { raise('connect'); return browser; } },
    readFile: async url => { events.push('source-read'); return String(url).includes('spec.mjs') ? source : helper; },
    mkdir: async (path, flags) => { events.push('reserve'); assert.equal(path, output); assert.deepEqual(flags, { mode: 0o700 });
      if (options.occupied) throw synthetic; reserved = true; if (options.markerOccupied) saved.set('C52.once.json', { consumed: true }); },
    writeFile: async (path, raw, flags) => {
      const name = path.split('/').at(-1); events.push(`publish:${name}`); assert.equal(reserved, true); assert.equal(path, join(output, name));
      assert.deepEqual(flags, { mode: 0o600, flag: 'wx' });
      if (saved.has(name) || options.rejectPublication === name) throw publication;
      saved.set(name, JSON.parse(raw));
    },
    rm: async (path, flags) => { events.push('root-remove'); removed.push(path); assert.equal(path, '/synthetic'); assert.deepEqual(flags, { recursive: true }); }, lstat: async () => { throw { code: 'ENOENT' }; }, join, isAbsolute,
    discoverFixture: async () => { events.push('discovery'); assert.equal(saved.get('C52.once.json').consumed, true); return fixturePath; },
    nativeBinding: async path => { events.push('binding'); return bind(path); }, createRestartRoot: async (...args) => {
      forwarded.push(args); raise('root-acquire');
      if (options.allocator) {
        const value = await options.allocator(...args);
        // A broken forwarding regression must not leak its unexpected unit root.
        await removeFixture(value.root, { recursive: true });
        throw new Error('Invalid parent unexpectedly acquired root');
      }
      return { root: '/synthetic', owner };
    },
    rootProof: async () => { raise('root-proof'); }, terminalProof: () => {},
    sid, head: '21', title: 'Title', facts: [{ run: 'A' }, { run: 'B' }], previous, digest: () => 'synthetic-digest', seedLegacy: async () => { raise('seed'); return {}; },
    snapshot: () => ({}), legacyProof: () => {}, upgradedProof: () => {}, catalogProof: () => {}, expectedPage, pageProof: () => {}, domProof: () => {}, sameDom: () => {},
    newRecord, newFaults, observerWork: () => {}, handleFacts: () => ({ active: 0, opens: 2, closes: 2 }), boundary: async () => {}, publicPrivacy: () => {},
    displayedBlock: async () => ({}), normalizedDom: async () => '', measurementCollector: () => ({ route() {}, request() {}, response() {}, finished() {}, begin() {}, drain: async () => {}, facts: () => ({ safe: true }) }),
    installColdObserver, coldProof, identity: async () => { raise('server-identity'); return chrome; },
    retirement: async known => { events.push('retirement'); if (known.pid === 902) return { ...known, retirement: serverClosed ? 'absent' : 'alive' };
      return { ...known, retirement: options.partial ? 'unknown' : observer.evidence().closed ? 'absent' : 'alive' }; },
    memoryProbe: () => ({ known: () => [chrome] }), sampler: () => sampling, memorySummary: () => ({}),
    resources: onFailure => {
      const r = resources(onFailure), cleanup = r.cleanup;
      r.cleanup = async () => { cleanupResult = await cleanup(); return cleanupResult; }; return r;
    }, acquireResource,
    acquireObserver: (binding, fixture) => {
      events.push('native-acquire'); observer = acquireObserver({ ...binding, executable: '/synthetic/native' }, fixture, f.deps);
      for (const name of ['stop', 'emergency']) { const action = observer[name]; observer[name] = async () => { events.push(`native-${name}`); return action(); }; }
      return observer;
    }, sourceGuard: options.sourceMismatch ? () => { throw synthetic; } : sourceGuard };
  new Function(...Object.keys(values), script)(...Object.values(values));
  let error;
  assert.equal(parentReads.length, 0); events.push('invoke');
  try { await callback({}, { outputPath: name => { events.push('output-path'); assert.equal(name, 'c52-evidence'); return output; } }); } catch (caught) { error = caught; }
  assert.equal(events.filter(e => e === 'collected').length, 1);
  assert.match(error.message, /^C52 measurement case failed; sanitized evidence saved$/);
  assert.equal(JSON.stringify([...saved.values()]).includes('synthetic-unlogged-control'), false);
  assert.equal(JSON.stringify([...saved.values()]).includes(synthetic.message), false);
  return { events, saved, error, failure: cleanupResult.error, synthetic, publication, observer, env, f, forwarded, parentReads, removed };
}
test('C52 actual callback requires a runtime parent only at root acquisition and forwards it without fallback', async t => {
  const admitted = await specCase({ injected: 'seed', env: { WI_BROWSER_FIXTURE_PARENT: '/synthetic/designated-parent' } });
  assert.deepEqual(admitted.forwarded, [['/synthetic/designated-parent']]); assert.equal(admitted.parentReads.length, 1);
  assert.ok(admitted.events.indexOf('binding') < admitted.events.indexOf('parent-read'));
  assert.ok(admitted.events.indexOf('parent-read') < admitted.events.indexOf('root-acquire'));
  const missing = await specCase({ env: { WI_BROWSER_FIXTURE_PARENT: undefined } });
  assert.equal(missing.failure.message, 'Browser fixture parent required'); assert.equal(missing.parentReads.length, 1);
  assert.deepEqual(missing.forwarded, []); assert.ok(missing.events.includes('binding'));
  for (const event of ['root-acquire', 'seed', 'native-acquire', 'launch', 'root-remove']) assert.equal(missing.events.includes(event), false);
  for (const parent of ['', 'relative', '/synthetic/invalid\0', '\ud800']) await t.test('invalid parent has no root or native work', async () => {
    const c = await specCase({ env: { WI_BROWSER_FIXTURE_PARENT: parent }, allocator: createRestartRoot });
    assert.deepEqual(c.forwarded, [[parent]]); assert.equal(c.failure.message, 'Restart display rejected');
    for (const event of ['seed', 'native-acquire', 'launch', 'root-remove']) assert.equal(c.events.includes(event), false);
  });
});
test('C52 actual callback keeps safe body-failure removal and cleanup-failure refusal with a designated parent', async () => {
  const body = await specCase(); assert.deepEqual(body.forwarded, [['/synthetic/private-parent']]);
  assert.deepEqual(body.removed, ['/synthetic']); assert.equal(body.saved.get('BROWSER_RESULT.json').status, 'FAILED');
  const cleanup = await specCase({ injected: 'context-close' }); assert.deepEqual(cleanup.forwarded, body.forwarded);
  assert.equal(cleanup.events.includes('root-remove'), false); assert.equal(cleanup.saved.get('CLEANUP.json').pass, false);
});
test('C52 actual spec acquisition and cleanup rejection paths keep original facts and continue remaining ownership', async t => {
  for (const injected of ['seed', 'initialize', 'server-identity', 'connect', 'context', 'sampler-start', 'sample', 'sampler-stop', 'context-close', 'browser-close', 'server-close', 'native-stop']) await t.test(injected, async () => {
    const c = await specCase({ injected }); assert.equal(c.failure, c.synthetic);
    const result = c.saved.get('CLEANUP.json'); assert.equal(result.pass, false); assert.notEqual(result.first_failure.phase, 'preflight');
    if (injected !== 'seed') { assert.ok(c.events.includes('native-stop')); assert.equal(c.observer.evidence().closed, true); assert.equal(c.observer.evidence().input_ended, true); }
    if (!['seed', 'initialize'].includes(injected)) assert.ok(c.events.includes('server-close'));
    if (['initialize', 'sampler-stop', 'context-close', 'browser-close', 'server-close', 'native-stop'].includes(injected)) {
      assert.equal(c.events.includes('root-remove'), false); assert.ok(result.steps.some(s => !s.ok));
    }
  });
});
test('C52 R1 actual spec native-failure seam uses real partially initialized acquireObserver', async t => {
  for (const candidate of [undefined, { state: 'unknown', pid: 900 }, { ...ident(900, process.pid, '/other'), cwd: '/synthetic/observe' }]) await t.test(candidate?.state ?? 'root-rejection', async () => {
    const partial = partialObserver({ candidate }), c = await specCase({ partial });
    if (!candidate) assert.equal(c.failure, partial.original);
    assert.ok(c.error);
    assert.equal(c.events.includes('launch'), false); assert.equal(c.events.includes('root-remove'), false);
    assert.equal(c.saved.get('CLEANUP.json').native_retirement[0].retirement, 'unknown');
    assert.equal(c.observer.evidence().closed, true); assert.equal(c.observer.evidence().input_ended, true);
    assert.equal(partial.events.includes('signal'), false);
    assert.equal(c.events.includes('retirement'), !candidate);
  });
});
test('C52 R1 actual callback accepts ordinary supplied and injected fallback discovery bindings after exclusive output reservation', async t => {
  for (const variant of ['supplied', 'fallback', 'explicit-output', 'matching-digest']) await t.test(variant, async () => {
    const env = {}; if (variant === 'fallback') env.WI_C3A_FIXTURE = undefined;
    if (variant === 'explicit-output') env.WI_C52_EVIDENCE = '/synthetic/fresh-evidence';
    const c = await specCase({ env, injected: 'seed', integrity: variant === 'matching-digest' ? variant : undefined });
    assert.equal(c.failure, c.synthetic); assert.ok(c.events.includes('root-acquire')); assert.ok(c.events.includes('seed'));
    assert.equal(c.events.filter(e => e === 'discovery').length, variant === 'fallback' ? 1 : 0);
    assert.ok(c.events.indexOf('reserve') < c.events.indexOf('publish:C52.once.json'));
    assert.ok(c.events.indexOf('publish:C52.once.json') < c.events.indexOf('binding'));
    if (variant === 'fallback') assert.ok(c.events.indexOf('publish:C52.once.json') < c.events.indexOf('discovery'));
    assert.equal(c.env.WI_C3A_FIXTURE, '/synthetic/compiler'); assert.equal(c.events.includes('output-path'), variant !== 'explicit-output');
    assert.equal(c.saved.get('C52.once.json').consumed, true);
  });
});
test('C52 R1 actual callback rejects occupied directories before all writes discovery and resources, even if empty', async t => {
  for (const variant of ['empty', 'historical', 'fallback', 'relative']) await t.test(variant, async () => {
    const env = { WI_C52_EVIDENCE: variant === 'relative' ? 'relative-output' : '/synthetic/occupied' };
    if (variant === 'fallback') env.WI_C3A_FIXTURE = undefined;
    const c = await specCase({ env, occupied: true }); assert.ok(c.error);
    assert.equal(c.saved.size, 0); assert.equal(c.events.some(e => e.startsWith('publish:')), false);
    for (const event of ['source-read', 'discovery', 'binding', 'root-acquire', 'seed', 'native-acquire', 'launch']) assert.equal(c.events.includes(event), false);
  });
});
test('C52 R1 actual callback rejects occupied marker and exact native/source integrity failures before root creation', async t => {
  for (const variant of ['marker', 'canonical', 'file', 'digest', 'empty-digest', 'source', 'source-guard', 'empty-path', 'relative-path']) await t.test(variant, async () => {
    const env = {}; if (variant === 'empty-path') env.WI_C3A_FIXTURE = ''; if (variant === 'relative-path') env.WI_C3A_FIXTURE = 'relative';
    const c = await specCase({ env, integrity: variant, markerOccupied: variant === 'marker', sourceMismatch: variant === 'source-guard' });
    assert.ok(c.error); assert.equal(c.events.includes('discovery'), false); assert.equal(c.events.includes('root-acquire'), false);
    assert.equal(c.events.includes('native-acquire'), false); assert.equal(c.events.includes('launch'), false);
    if (variant === 'marker') { assert.equal(c.failure, c.publication); assert.equal(c.events.includes('binding'), false); }
    else assert.equal(c.failure, c.synthetic);
  });
});
test('C52 R1 actual callback strict wx publication rejects without replacing original failure or skipping cleanup', async t => {
  for (const name of ['C52.once.json', 'SEED.json', 'FAILURE_BEFORE_CLEANUP.json', 'CLEANUP.json', 'MEASUREMENTS.json', 'BROWSER_RESULT.json']) await t.test(name, async () => {
    const c = await specCase({ rejectPublication: name, injected: name === 'FAILURE_BEFORE_CLEANUP.json' ? 'initialize' : undefined });
    assert.equal(c.failure, ['C52.once.json', 'SEED.json'].includes(name) ? c.publication : c.synthetic);
    if (!['C52.once.json', 'SEED.json'].includes(name)) {
      assert.ok(c.events.includes('native-stop')); assert.ok(c.events.includes('root-proof'));
      assert.equal(c.observer.evidence().closed, true); assert.equal(c.observer.evidence().input_ended, true);
    }
    if (name === 'SEED.json') assert.equal(c.events.includes('native-acquire'), false);
    assert.equal(c.saved.has(name), false);
    if (name !== 'BROWSER_RESULT.json') {
      const result = c.saved.get('BROWSER_RESULT.json'); assert.equal(result.status, 'FAILED');
      assert.deepEqual(result.publication_failures, [name]);
    }
  });
});

test('C52 static guards bind actual spec and helper and detect forbidden source variants', async t => {
  const spec = await readFile(new URL('../e2e/display-measurements.spec.mjs', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../test-support/display-measurements.mjs', import.meta.url), 'utf8');
  assert.equal(sourceGuard(spec, helper), true);
  for (const snippet of ['x.body()', 'x.json()', 'x.text()', 'x.arrayBuffer()', 'x.newCDPSession()', 'x._channel', 'wsPath: "x"',
    'executablePath: "x"', 'args: []', 'discoverFixture()', 'test.skip()', 'test.only()', 'globalThis.fetch = f',
    'console.log(owner)', 'error.stack', 'JSON.stringify(process.env)', 'JSON.stringify(reply)', 'server.wsEndpoint()']) await t.test(snippet, () => assert.throws(() => sourceGuard(`${spec}\n${snippet}`, helper)));
  assert.throws(() => sourceGuard(spec.replace("host: '127.0.0.1'", "host: '0.0.0.0'"), helper));
  assert.throws(() => sourceGuard(spec.replace("context.on('requestfinished', network.finished)", ''), helper));
  assert.equal(/async \(\{ browser \}\)/.test(spec), false);
  assert.ok(spec.includes('serviceWorkers: \'block\'')); assert.ok(spec.includes('viewport: { width: 1000, height: 700 }'));
});

test('C93C display source requires real shared admission at preflight and owned launch', async t => {
  const spec = await readFile(new URL('../e2e/display-measurements.spec.mjs', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../test-support/display-measurements.mjs', import.meta.url), 'utf8');
  assert.match(spec, /import \{ browserPin, browserLaunchOptions \} from '\.\.\/test-support\/browser-pin\.mjs';/);
  assert.equal(sourceGuard(spec, helper), true);
  for (const [name, change] of Object.entries({
    'missing preflight': s => s.replace('    browserLaunchOptions();\n', ''),
    'wrong import': s => s.replace("from '../test-support/browser-pin.mjs'", "from '../test-support/fixture.mjs'"),
    shadow: s => s.replace('    browserLaunchOptions();', '    const browserLaunchOptions = () => ({}); browserLaunchOptions();'),
    'extra argument': s => s.replace('...browserLaunchOptions()', '...browserLaunchOptions(process.env)'),
    'unused options': s => s.replace(', ...browserLaunchOptions()', ''),
    'comment counterfeit': s => s.replace('    browserLaunchOptions();', '    // browserLaunchOptions();'),
    'wrong version': s => s.replace('toBe(browserPin.version)', "toBe('145.0.7632.6')"),
    bypass: s => s.replace('...browserLaunchOptions()', "...{ executablePath: '/synthetic/other' }"),
    'remote connection': s => s.replace('chromium.connect(server.wsEndpoint())', "chromium.connect('ws://synthetic.invalid')"),
    'SDK environment override': s => s.replace('    browserLaunchOptions();', "    browserLaunchOptions(); process.env.PWDEBUG = '1';"),
    'extra launch args': s => s.replace('...browserLaunchOptions()', '...browserLaunchOptions(), args: []'),
    'pin shadow': s => s.replace('    browserLaunchOptions();', "    browserLaunchOptions(); const browserPin = { version: 'other' };"),
  })) await t.test(name, () => {
    const changed = change(spec); assert.notEqual(changed, spec); assert.throws(() => sourceGuard(changed, helper));
  });
});

test('C93C display actual callback admits before evidence and rechecks at owned launch', async () => {
  const normal = await specCase();
  assert.equal(normal.events.filter(e => e === 'browser-admission').length, 2);
  assert.ok(normal.events.indexOf('browser-admission') < normal.events.indexOf('output-path'));
  assert.equal(normal.events[normal.events.indexOf('launch') - 1], 'browser-admission');
  const early = await specCase({ browserReject: 1 });
  assert.equal(early.failure, early.synthetic); assert.equal(early.saved.size, 0);
  for (const event of ['output-path', 'reserve', 'discovery', 'binding', 'root-acquire', 'native-acquire', 'launch']) assert.equal(early.events.includes(event), false);
  const late = await specCase({ browserReject: 2 });
  assert.equal(late.failure, late.synthetic); assert.equal(late.events.includes('launch'), false);
  assert.ok(late.events.includes('native-stop')); assert.equal(late.observer.evidence().closed, true);
  assert.equal(late.saved.get('BROWSER_RESULT.json').status, 'FAILED');
});
test('C93C display actual callback rejects a nonexact runtime browser version', async () => {
  for (const browserVersion of ['145.0.7632.6', browserPin.version + '.extra']) {
    const c = await specCase({ browserVersion });
    assert.ok(c.failure instanceof assert.AssertionError); assert.equal(c.events.includes('context'), false);
    assert.ok(c.events.includes('server-close')); assert.ok(c.events.includes('native-stop'));
  }
});
