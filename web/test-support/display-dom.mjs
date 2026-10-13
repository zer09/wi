import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bounded, CHILD_TEST, stdoutParser } from './fixture.mjs';

// This element model covers DOM bookkeeping only. Chromium supplies layout/focus proof.
export class Element {
  constructor(tag, document) {
    this.tag = tag; this.ownerDocument = document; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map();
    this.text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.className = '';
    this.scrollTop = 0; this.clientHeight = 100; this.scrollHeight = 100; this.selectionStart = 0; this.selectionEnd = 0;
  }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = value; }
  get firstChild() { return null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  get options() { return this.children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  dispatch(name, props = {}) { const event = { target: this, isTrusted: false, preventDefault() { this.prevented = true; }, ...props }; for (const cb of this.listeners.get(name) ?? []) cb(event); return event; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, next) { child.remove(); const i = next === null ? this.children.length : this.children.indexOf(next); assert.ok(i >= 0); this.children.splice(i, 0, child); child.parent = this; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...children) { for (const c of [...this.children]) c.remove(); this.text = ''; this.append(...children); }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  find(predicate) { return [this, ...this.children.flatMap(c => c.find(predicate))].filter(predicate); }
  querySelectorAll(selector) { const selectors = selector.split(',').map(s => s.trim()); return this.children.flatMap(c => c.find(n => selectors.some(s => s.startsWith('.') ? n.className.split(' ').includes(s.slice(1)) : n.tag === s))); }
  getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; }
  focus() { this.ownerDocument.activeElement = this; }
}
export function model(t) {
  const original = globalThis.document;
  const document = { createElement: tag => new Element(tag, document), activeElement: null };
  globalThis.document = document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  const queued = new Map(), all = new Map(); let next = 0;
  const layout = { request(callback) { const id = ++next; queued.set(id, callback); all.set(id, callback); return id; }, cancel(id) { queued.delete(id); } };
  return { document, root: new Element('main', document), layout, queued, all, flush() { const batch = [...queued]; for (const [id, cb] of batch) { queued.delete(id); cb(0); } } };
}
// Reuse the real Rust loopback fixture without its Cargo discovery or stripped child environment.
export async function rustPageFixture(executable) {
  const sandbox = await mkdtemp(join(tmpdir(), 'wi-display-browser-'));
  const child = spawn(executable, ['--ignored','--exact',CHILD_TEST,'--nocapture','--test-threads=1'], {
    cwd: sandbox, stdio: ['pipe','pipe','pipe'], env: { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: sandbox, CODEX_HOME: sandbox },
  });
  let id = 0, failure = null, stderrBytes = 0, closed = false, stopping = false;
  let terminal = null, stopResult, exitCode, stopId;
  const stopFacts = { attempted: false, clean_acknowledgment: false, reap_complete: false, sandbox_removed: false, sigterm: false, sigkill: false };
  const evidence = () => Object.freeze({ failure: terminal, stop: Object.freeze({ ...stopFacts,
    exit_observed: closed, exit_zero: closed ? exitCode === 0 : null, error_latched: failure !== null, stderr_empty: stderrBytes === 0 }) });
  const waits = new Map();
  const rejectAll = (message = 'synthetic Rust fixture failed') => {
    failure ??= Error(message);
    for (const waiter of waits.values()) { clearTimeout(waiter.timer); waiter.reject(failure); }
    waits.clear();
    // A later exit callback must not erase an earlier successful signal attempt.
    if (!closed && !terminal) stopFacts.sigterm = child.kill('SIGTERM') || stopFacts.sigterm;
  };
  const parser = stdoutParser(message => {
    if (message.event === 'fixture_failed') {
      terminal ??= Object.freeze({ phase: message.phase, category: message.category });
      rejectAll();
      return;
    }
    if (message.id === stopId && message.event === 'stopped') stopFacts.clean_acknowledgment = message.cleaned === true;
    if (failure) return;
    const waiter = waits.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); waits.delete(message.id); waiter.resolve(message); }
  });
  child.stdout.on('data', bytes => { try { parser.push(bytes); } catch { rejectAll(); } });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
  child.stdin.on('error', () => rejectAll());
  child.on('error', () => rejectAll());
  // A clean exit is valid only after the Stop acknowledgement, not instead of it.
  child.on('exit', code => { if (!stopping || waits.size !== 0 || code !== 0) rejectAll(); });
  const exited = new Promise(resolve => child.on('close', code => {
    closed = true;
    exitCode = code;
    try { parser.end(); } catch { rejectAll(); }
    if (!stopping || waits.size !== 0 || code !== 0) rejectAll();
    resolve(code);
  }));
  const request = async body => {
    if (closed || child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) rejectAll();
    if (failure) return Promise.reject(failure);
    const current = ++id;
    if (body.command === 'stop') stopId = current;
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => rejectAll('synthetic Rust fixture deadline'), 20000);
      waits.set(current, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ ...body, id: current }) + '\n', error => { if (error) rejectAll(); }); }
      catch { rejectAll(); }
    });
    if (failure) throw failure;
    return message;
  };
  const cleanup = async () => {
    child.stdin.end();
    // Reject fatal controls now, but give native teardown the existing shutdown guard.
    try { await bounded(exited, 5000, 'synthetic Rust fixture failed'); }
    catch {
      stopFacts.sigterm = child.kill('SIGTERM') || stopFacts.sigterm;
      try { await bounded(exited, 2000, 'synthetic Rust fixture failed'); }
      catch { stopFacts.sigkill = child.kill('SIGKILL'); await bounded(exited, 2000, 'synthetic Rust fixture failed'); }
    }
    stopFacts.reap_complete = closed;
    try { await rm(sandbox, { recursive: true, force: true }); stopFacts.sandbox_removed = true; }
    catch { throw Error('synthetic Rust fixture cleanup failed'); }
  };
  const owner = randomBytes(32).toString('hex');
  try {
    const ready = await request({ transport: 'web_socket', recovered: false, mime: true, owner });
    if (failure || ready.event !== 'ready') { rejectAll(); throw failure; }
    function stop() {
      stopResult ??= (async () => {
        stopping = true;
        try {
          if (!failure && !closed) {
            stopFacts.attempted = true;
            const stopped = await request({ command: 'stop' });
            if (stopped.event !== 'stopped' || stopped.cleaned !== true) { rejectAll(); throw failure; }
          }
        } finally { await cleanup(); }
        if (!stopFacts.clean_acknowledgment || exitCode !== 0 || failure || stderrBytes !== 0) { rejectAll(); throw failure; }
      })();
      return stopResult;
    }
    return { origin: ready.origin, owner, pid: child.pid, request, stop, evidence };
  } catch (error) { await cleanup(); throw error; }
}
export function button(root, name) { return root.find(n => n.tag === 'button' && n.textContent === name)[0]; }
export function control(root, name) { return root.find(n => n.tag === 'label' && n.text === name)[0]?.children[0]; }
export function byClass(root, name) { return root.find(n => n.className === name)[0]; }
export function controller(state) {
  const listeners = new Set(), calls = [];
  const client = { snapshot: () => state, subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); } };
  for (const name of ['connect','disconnect','selectSession','reconnectLatest','loadOlder','refreshEntry','createSession','renameSession','refreshCatalog','sendTask','reconcileTask','readRun','cancelCurrentRun','retryCommand','abortCommandWaiter','discardCommand','refreshSessions','loadMoreSessions','setDraft']) {
    client[name] = (...args) => { calls.push({ name, args }); return Promise.resolve(); };
  }
  return { client, calls, listeners, publish(value) { state = value; for (const fn of listeners) fn(value); } };
}
