import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { validateTaskCommand, validateUuid } from '../dist/api.js';
import { data } from './presentation.mjs';
import { expectedBlock } from './rich-display-parity.mjs';
import { interruptedProof, stableProof, handshakeProof, allowedRequest, terminalProof, workProof, rootProof } from './restart-display.mjs';

const reject = () => { throw new Error('Interrupted parity rejected'); };
const equal = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); return true; };
export const markers = ['synthetic-replay-', 'synthetic-account-', 'private-operator-', 'private-project-', 'private-skill-', 'private-support-',
  'private-native', 'private-data', 'private-skills', 'private-config-canary', 'principal_digest', 'history_digest',
  'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
export const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/assets/wi.css', ['style.css', 'text/css; charset=utf-8']],
  ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, [`dist/${name}.js`, 'text/javascript; charset=utf-8']])]);
export const leaked = (text, owner) => text.includes(owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
export function publicPrivacy(value, owner) {
  const text = JSON.stringify(value, (key, item) => key === 'field_id' && /^(text|[0-9a-f]{64})$/.test(item) ? 'public-field-id' : item);
  if (leaked(text, owner)) reject();
  return true;
}
export async function boundary(page, context, owner) {
  const safe = await page.evaluate(async ({ owner, markers }) => {
    const dom = document.documentElement.cloneNode(true);
    // Only validated public field attributes are exempt from the private-digest scan.
    for (const field of dom.querySelectorAll('[data-field]')) {
      const id = field.getAttribute('data-field');
      if (!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return false;
      field.removeAttribute('data-field');
    }
    const values = [dom.outerHTML, location.href, JSON.stringify(history.state),
      ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
    const content = document.querySelector('.layout');
    return globalThis.wiCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
      && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
      && (await navigator.serviceWorker.getRegistrations()).length === 0
      && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))))
      && content.querySelectorAll('script,img,a,iframe,object,embed,svg,math,link,style,audio,video,source').length === 0
      && Array.from(content.querySelectorAll('*')).every(node => Array.from(node.attributes).every(attribute =>
        !/^on/i.test(attribute.name) && !['src', 'href', 'srcdoc'].includes(attribute.name)))
      && document.querySelectorAll('script').length === 1 && document.querySelector('script').getAttribute('src') === '/assets/app.js';
  }, { owner, markers });
  if (!safe || (await context.cookies()).length !== 0) reject();
  return true;
}
export function displayProof(actual, page) { return equal(actual, expectedBlock(page)); }
export function interruptedSnapshot(value, before, held) {
  const page = interruptedProof(value, before);
  if (before.snapshot_head !== '23' || page.snapshot_head !== '24') reject();
  if (held !== undefined) stableProof(page, held);
  return page;
}
export function sameDom(b, c) { if (typeof b !== 'string' || b.length === 0) reject(); return equal(b, c); }
export function newRecord() { return { requests: [], snapshots: [], streams: [], assets: new Set() }; }
export function newFaults() { return { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 }; }
export function responseHeaders(response, type, status = 200) {
  const h = response.headers();
  if (response.status() !== status || h['cache-control'] !== 'no-store' || h['x-content-type-options'] !== 'nosniff'
    || h['set-cookie'] !== undefined || (type === 'application/json' ? !/^application\/json(?:;|$)/.test(h['content-type']) : h['content-type'] !== type)) reject();
  return h;
}

// These callbacks are the actual context collectors, also exercised without Chromium in the controls.
export function collector({ origin, owner, index, record, faults, assetReads, session, permission, command, acceptCommand }) {
  return {
    async route(route) {
      try {
        if (new URL(route.request().url()).origin !== origin) { faults.external++; await route.abort(); }
        else await route.continue();
      } catch { faults.collector++; }
    },
    request(request) {
      try {
        const url = new URL(request.url()), method = request.method(), sid = session();
        record.requests.push({ method, path: url.pathname, search: url.search });
        if (url.origin !== origin) faults.external++;
        if (leaked(request.url(), owner)) faults.private++;
        if (url.pathname.startsWith('/v1/')) {
          const h = request.headers();
          if (h.authorization !== `Bearer ${owner}` || h.cookie !== undefined || h.origin !== undefined && h.origin !== origin
            || !allowedRequest(method, url, sid, index === 0 ? permission() : 'none')) faults.request++;
        } else if (method !== 'GET' || !files.has(url.pathname) || url.search !== '') faults.request++;
        const base = `/v1/sessions/${sid}/conversation`;
        if (method === 'GET' && url.pathname === base) record.snapshots.push({ request, index: record.requests.length - 1, response: null });
        if (method === 'GET' && url.pathname === `${base}/events`) record.streams.push({ request, index: record.requests.length - 1, response: record.snapshots.at(-1)?.response, reply: null });
        if (method === 'POST' && url.pathname.endsWith('/runs')) {
          if (index !== 0 || command() !== undefined) faults.request++;
          const value = validateTaskCommand(request.postDataJSON());
          if (value.text !== data.user) faults.request++;
          if (index === 0 && command() === undefined) acceptCommand(value);
        }
      } catch { faults.collector++; }
    },
    response(response) {
      try {
        const url = new URL(response.url());
        const snapshot = record.snapshots.find(item => item.request === response.request());
        const stream = record.streams.find(item => item.request === response.request());
        if (snapshot) { snapshot.response = response; responseHeaders(response, 'application/json'); }
        if (stream) { stream.reply = response; responseHeaders(response, 'text/event-stream'); }
        if (response.status() >= 300) faults.response++;
        const file = files.get(url.pathname); if (!file) return;
        assetReads.push((async () => {
          responseHeaders(response, file[1]);
          const bytes = await response.body();
          if (!bytes.equals(await readFile(new URL(`../${file[0]}`, import.meta.url)))) faults.response++;
          if (leaked(bytes.toString('utf8'), owner)) faults.private++;
          record.assets.add(url.pathname);
        })().catch(() => { faults.collector++; }));
      } catch { faults.collector++; }
    },
  };
}
function original(record, reply) {
  if (record.snapshots.length !== 1 || record.streams.length !== 1) reject();
  const snapshot = record.snapshots[0], stream = record.streams[0];
  if (snapshot.request !== reply.request() || snapshot.response !== reply || stream.response !== reply
    || snapshot.index >= stream.index || !stream.reply || stream.reply.request() !== stream.request || snapshot.request === stream.request) reject();
  responseHeaders(reply, 'application/json'); responseHeaders(stream.reply, 'text/event-stream');
}
export function recoveryOrder() {
  let selected = false, next = 1, recovered = false;
  const events = [], bound = new Set();
  return {
    selected() { if (selected) reject(); selected = true; events.push('selected'); },
    displayed(index, record, reply, status) {
      if (!selected || index !== next || status !== 'Execution: interrupted. Final result not recorded.') reject();
      original(record, reply); events.push(index === 1 ? 'b-original-interrupted' : 'c-original-interrupted');
      recovered = true; next++;
    },
    async read(action) {
      // B must render recovery before an independent helper can open this session.
      if (!recovered) reject(); events.push('helper-read'); return action();
    },
    handshake(index, input) {
      if (next <= index || bound.has(index) || input.head !== '24') reject();
      handshakeProof(input); bound.add(index); events.push(index === 1 ? 'b-handshake' : 'c-handshake');
    },
    finish() {
      if (next !== 3 || bound.size !== 2 || events.indexOf('b-original-interrupted') >= events.indexOf('helper-read')
        || events.indexOf('b-handshake') >= events.indexOf('c-original-interrupted')) reject();
      return [...events];
    },
  };
}
export function observerWork(samples) {
  if (!Array.isArray(samples) || samples.length < 5 || samples[0].event !== 'sample' || samples.at(-1).event !== 'stopped') reject();
  for (const sample of samples) workProof(sample.work, 'observe');
  return true;
}
export function browserRequests(records, faults) {
  if (records.length !== 3 || !Object.values(faults).every(n => n === 0)) reject();
  for (const [index, record] of records.entries()) {
    if (record.snapshots.length !== 1 || record.streams.length !== 1 || record.assets.size !== files.size
      || ![...files.keys()].every(file => record.assets.has(file)) || record.requests.some(r => r.path.endsWith('/cancel'))) reject();
    const posts = record.requests.filter(r => r.method === 'POST');
    if (index === 0 ? posts.length !== 2 : record.requests.some(r => r.method !== 'GET')) reject();
  }
  return true;
}
export function storedHead(database, expected) {
  try {
    if (expected !== '24') reject();
    const rows = database.prepare('SELECT head_sequence FROM manifest').all();
    if (rows.length !== 1 || String(rows[0].head_sequence) !== expected) reject();
    return true;
  } finally { database.close(); }
}
export async function shutdownHead(fixture, sid) {
  await rootProof(fixture, 'observe'); validateUuid(sid);
  // This single read checks shutdown's head only. It does not audit canonical payloads or prefixes.
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(fixture.root, 'private-data/sessions', sid.slice(0,2), sid, 'session.sqlite3'), { readOnly: true });
  return storedHead(database, '24');
}
export function cleanupProof({ closed, rootRemoved, producer, observer }) {
  if (!isDeepStrictEqual(closed, [true, true, true]) || rootRemoved !== true || producer.phase !== 'produce' || observer.phase !== 'observe'
    || producer.pid === observer.pid || producer.identity?.start_ticks === undefined || observer.identity?.start_ticks === undefined
    || producer.identity.executable !== observer.identity.executable || producer.cwd === observer.cwd) reject();
  terminalProof(producer, true); terminalProof(observer, false); observerWork(observer.samples);
  return true;
}
