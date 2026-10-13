import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { rustPageFixture } from '../test-support/display-dom.mjs';
import * as f from '../test-support/display-fixtures.mjs';

// B/C: the unmodified embedded app and native Chromium fetch/SSE use synthetic loopback DTOs.
// Rust serves every page/asset. This does not claim joined provider or storage projection proof.
let fixture, transport;
test.beforeEach(async ({ browser }) => {
  fixture = await rustPageFixture(process.env.WI_C3A_FIXTURE);
  console.log('DISPLAY_APP_FIXTURE', JSON.stringify({ pid: fixture.pid, chromium: browser.version() }));
});
test.afterEach(async () => {
  if (transport) { await transport.stop(); transport = undefined; }
  const owned = fixture; fixture = undefined;
  if (owned) { await owned.stop(); console.log('DISPLAY_APP_FIXTURE_CLOSED', JSON.stringify({ pid: owned.pid, cleaned: true, exit: 0 })); }
});
const B = f.OTHER, base = `/v1/sessions/${f.SID}`;
const bytes = text => String(Buffer.byteLength(text));
const long = n => Array.from({ length: n }, (_, i) => `line ${i} 雪 https://external.invalid/\u001b[31m`).join('\n');
function human(text = 'Task B', sequence = '100', run_id = B) {
  return f.human({ run_id, entry_id: `e:${sequence}:0`, position: { sequence, slot: '0' }, revision: sequence, content_epoch: sequence,
    fields: [f.field({ field_id: 'text', order_key: '0', generation: sequence, text, total_bytes: bytes(text), to_byte: bytes(text) })] });
}
function assistant(text, sequence = '102', run_id = B) {
  return f.entry({ run_id, entry_id: `e:${sequence}:0`, position: { sequence, slot: '0' }, revision: sequence, content_epoch: sequence,
    fields: [f.field({ generation: sequence, text, total_bytes: bytes(text), to_byte: bytes(text) })] });
}
function latest(text = long(60), options = {}) {
  return f.page({ snapshot_head: '102', session: f.session('102'), block: f.block({ run_id: B, accepted_sequence: '100', revision: '102', human: human() }),
    entries: [assistant(text)], previous_block: f.cursor('b', '100'), live_after: f.cursor('l', '102', '3', '', ''), ...options });
}
function before(sequence = '2', text = 'Task A', previous = null) {
  return f.page({ snapshot_head: '102', session: f.session('102'), block: f.block({ accepted_sequence: sequence, revision: sequence, human: human(text, sequence, f.RID) }),
    entries: [], previous_block: previous, live_after: null });
}
const safeError = code => ({ api_version: 1, code, stage: null, certainty: code === 'storage.commit_unknown' ? 'unknown' : 'not_applicable', acceptance: null, notices: [] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function setup(page, first, handlers = {}, hash = `#session=${f.SID}`) {
  const calls = [], assets = [], admitted = [], posts = [], streams = new Set();
  let external = 0, bearerOK = true, latestCount = 0, olderActive = 0, olderMaximum = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    bearerOK &&= req.headers.authorization === `Bearer ${fixture.owner}`;
    if (url.pathname.endsWith('/conversation/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.flushHeaders(); res.write(': synthetic native stream\n\n');
      streams.add(res); res.on('close', () => streams.delete(res)); return;
    }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (body !== null) posts.push({ path: url.pathname, body });
      let value;
      if (url.pathname === '/v1/settings') value = { api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: false };
      else if (url.pathname === '/v1/sessions') value = await handlers.catalog?.() ?? { api_version: 1, entries: [], has_more: false, next_after_id: null };
      else if (url.pathname === base + '/conversation' && url.search === '') {
        latestCount++; value = latestCount === 1 ? first : await handlers.latest?.(latestCount) ?? first;
      } else if (url.pathname.includes('/conversation')) {
        olderMaximum = Math.max(olderMaximum, ++olderActive);
        try { value = await handlers.older?.(url, admitted.length) ?? before(); } finally { olderActive--; }
      } else if (req.method === 'POST') value = await handlers.post?.(url, body) ?? safeError('storage.commit_unknown');
      else value = safeError('api.not_found');
      const status = value?.code ? (value.code === 'api.unauthorized' ? 401 : 503) : 200;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  transport = { async stop() { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== fixture.origin) { external++; await route.abort(); return; }
    if (!url.pathname.startsWith('/v1/')) { assets.push(url.pathname); await route.continue(); return; }
    calls.push({ path: url.pathname + url.search, method: request.method() });
    if (url.pathname.includes('/conversation') && !url.pathname.endsWith('/events') && (url.search !== '' || url.pathname !== base + '/conversation')) {
      const state = await page.locator('#app .transcript').evaluate(node => ({ bRendered: node.textContent.includes('Task B'), overflow: node.scrollHeight > node.clientHeight }));
      admitted.push({ path: url.pathname + url.search, ...state });
    }
    // Rewriting only this request's destination retains native fetch, framing and real layout.
    await route.continue({ url: origin + url.pathname + url.search });
  });
  await page.goto(fixture.origin + '/' + hash);
  const root = page.locator('#app'), transcript = root.getByLabel('Canonical conversation');
  return { root, transcript, calls, assets, admitted, posts, get external() { return external; }, get bearerOK() { return bearerOK; }, get olderMaximum() { return olderMaximum; }, get streams() { return streams.size; },
    push(batch) { for (const res of streams) res.write(`event: wi.conversation\nid: ${batch.next_after}\ndata: ${JSON.stringify(batch)}\n\n`); },
    eof() { for (const res of [...streams]) res.end(); }, async connect() {
      await root.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
      await root.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(root.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    } };
}
function readOnly(h) {
  expect(h.calls.every(c => c.method === 'GET')).toBe(true); expect(h.posts).toHaveLength(0);
  expect(h.calls.some(c => /\/history(?:\?|$)|^\/v1\/sessions\/[^/]+\/events(?:\?|$)/.test(c.path))).toBe(false);
  expect(h.assets).toContain('/assets/app.js');
  expect(h.assets.filter(p => ['/assets/client.js','/assets/state.js','/assets/view.js'].includes(p))).toEqual([]);
  for (const name of ['display-client','display-store','display-view','display-api','sse','api']) expect(h.assets).toContain(`/assets/${name}.js`);
  expect(h.bearerOK).toBe(true); expect(h.external).toBe(0);
}

for (const viewport of [{ width: 360, height: 800 }, { width: 1440, height: 900 }]) test(`active embedded entry hash Connect B overflow zero older inert text ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const inert = '<img src="https://external.invalid/x"><script>window.bad=1</script>雪\u001b[31m\n' + long(60);
  const h = await setup(page, latest(inert));
  await expect(h.root.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  expect(h.calls).toEqual([]);
  await h.root.getByLabel('Owner token', { exact: true }).fill(fixture.owner); await frames(page); expect(h.calls).toEqual([]);
  await h.root.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(h.transcript).toContainText('Task B'); await expect(h.transcript.locator('pre').filter({ hasText: '<img src=' }).first()).toHaveText(inert);
  await expect.poll(() => h.streams).toBe(1); await frames(page);
  expect(h.admitted).toHaveLength(0);
  expect(h.calls.map(c => c.path)).toEqual(['/v1/settings','/v1/sessions?limit=32',base + '/conversation',base + '/conversation/events?after=' + encodeURIComponent(f.cursor('l','102','3','',''))]);
  expect(await h.transcript.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);
  expect(await h.transcript.locator('img,script,a,iframe,style').count()).toBe(0); expect(await page.evaluate(() => window.bad === undefined)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await h.transcript.locator('pre').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1))).toBe(true);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie, hash: location.hash }))).toEqual({ local: 0, session: 0, cookies: '', hash: `#session=${f.SID}` });
  await expect(h.root.getByLabel('Owner token', { exact: true })).toHaveValue(''); readOnly(h);
});

test('active short B renders before serial fill; native observation updates while an older read waits and fill stops at overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const hold = deferred(), first = latest('', { entries: [] });
  first.block.human.fields = [f.fragment('Task B', 1, 7, { field_id: 'text', order_key: '0', generation: '100' })];
  first.block.human.content_complete = false; first.block.human.earlier_content = f.cursor('c', B, 'e:100:0', '100', 'text', '100', '1');
  const h = await setup(page, first, { older: async (_url, count) => {
    if (count === 1) return f.addressed({ ...first.block.human, fields: [f.fragment(' ', 0, 7, { field_id: 'text', order_key: '0', generation: '100' })], earlier_content: null }, first.block, '102');
    await hold.promise; return before('90', long(50), f.cursor('b', '90'));
  } });
  await h.connect(); await expect.poll(() => h.admitted.length).toBe(2); await expect.poll(() => h.streams).toBe(1);
  expect(h.admitted.every(a => a.bRendered && !a.overflow)).toBe(true); expect(h.olderMaximum).toBe(1);
  const session = f.session('103', { title: 'independent live metadata' }); h.push(f.batch([{ kind: 'session.upsert', session }], '103'));
  await expect(h.root.getByLabel('Canonical session title')).toHaveText('independent live metadata');
  hold.resolve(); await expect(h.transcript).toContainText('line 49'); await frames(page);
  expect(h.admitted).toHaveLength(2); expect(h.olderMaximum).toBe(1); expect(h.admitted.map(a => a.path.includes('/content?') ? 'content' : 'before')).toEqual(['content','before']);
  await page.setViewportSize({ width: 1440, height: 1200 }); await h.transcript.evaluate(n => { n.scrollTop = 0; }); await frames(page);
  expect(h.admitted).toHaveLength(2); readOnly(h);
});

test('active oversized B completes content then within then A with one Human anchor and explicit keyboard Load older', async ({ page }) => {
  const tail = long(60), total = Buffer.byteLength(tail) + 5, e = assistant(tail);
  e.fields = [f.fragment(tail, 5, total, { generation: '102' })]; e.content_complete = false; e.earlier_content = f.cursor('c', B, e.entry_id, '102', f.FID, '102', '5');
  const first = latest('', { entries: [e], earlier_activity: f.cursor('s', B, '102', '0') });
  const h = await setup(page, first, { older: url => {
    if (url.pathname.endsWith('/content')) return f.addressed({ ...e, fields: [f.fragment('head ', 0, total, { generation: '102' })], earlier_content: null }, first.block, '102');
    if (url.searchParams.has('within')) return { ...first, entries: [assistant('earlier B', '101')], earlier_activity: null, live_after: null };
    return before();
  } });
  await h.connect(); await expect(h.transcript).toContainText('Task B'); await frames(page); expect(h.admitted).toHaveLength(0);
  for (let count = 1; count <= 3; count++) {
    const older = h.root.getByRole('button', { name: 'Load older', exact: true }); await expect(older).toBeEnabled(); await older.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => h.admitted.length).toBe(count); await expect(h.root).not.toContainText('Reading one older unit…');
  }
  expect(h.admitted.map(a => a.path.includes('/content?') ? 'content' : a.path.includes('within=') ? 'within' : 'before')).toEqual(['content','within','before']);
  expect((await h.transcript.locator('pre').allTextContents()).filter(t => t === 'Task B')).toHaveLength(1);
  await expect(h.transcript.locator('pre').filter({ hasText: 'head line 0' }).first()).toHaveText('head ' + tail);
  await expect(h.root.getByRole('button', { name: 'Load older', exact: true })).toBeDisabled(); readOnly(h);
});

test('active EOF waits for explicit Reconnect latest; successful rebase preserves exact pending task, failed rebase keeps stale content', async ({ page }) => {
  const fresh = latest('fresh canonical B\n' + long(60), { snapshot_head: '104', session: f.session('104'), live_after: f.cursor('l','104','3','','') });
  fresh.block.revision = '104'; fresh.entries[0].revision = '104'; fresh.entries[0].content_epoch = '104'; fresh.entries[0].fields[0].generation = '104';
  const h = await setup(page, latest(), { latest: count => count === 2 ? fresh : safeError('storage.unavailable'), post: url => url.pathname.endsWith('/reconcile') ? f.reconciliation('not_found') : safeError('storage.commit_unknown') });
  await h.connect(); await expect.poll(() => h.streams).toBe(1);
  const text = '  immutable task 雪\n'; await h.root.getByLabel('Task', { exact: true }).fill(text);
  await h.root.getByRole('button', { name: 'Send', exact: true }).click(); await expect(h.root.locator('.command')).toContainText('task: uncertain');
  await h.root.getByLabel('Task', { exact: true }).fill('draft survives same-page rebase');
  h.eof(); await expect(h.root).toContainText('Observation: disconnected'); await frames(page);
  expect(h.calls.filter(c => c.path === base + '/conversation')).toHaveLength(1); expect(h.posts).toHaveLength(1);
  await h.root.getByRole('button', { name: 'Reconnect latest', exact: true }).click(); await expect(h.transcript).toContainText('fresh canonical B'); await expect.poll(() => h.streams).toBe(1);
  await expect(h.root.getByLabel('Task', { exact: true })).toHaveValue('draft survives same-page rebase'); await expect(h.root.locator('.command')).toContainText('task: uncertain');
  expect(h.posts).toHaveLength(1);
  expect(h.calls.filter(c => c.path.includes('/conversation/events?')).map(c => c.path)).toEqual([base + '/conversation/events?after=' + encodeURIComponent(f.cursor('l','102','3','','')),base + '/conversation/events?after=' + encodeURIComponent(f.cursor('l','104','3','',''))]);
  await h.root.getByRole('button', { name: 'Reconnect latest', exact: true }).click(); await expect(h.root).toContainText('Code: storage.unavailable');
  await expect(h.transcript).toContainText('fresh canonical B'); expect(h.calls.filter(c => c.path.includes('/conversation/events?'))).toHaveLength(2); expect(h.posts).toHaveLength(1);
  await h.root.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true }).click(); await expect(h.root.locator('.command')).toContainText('Point-in-time absence, not rollback proof.');
  expect(h.posts).toHaveLength(2); expect(h.posts[0].body.text).toBe(text); expect(h.posts[1]).toEqual({ path: base + '/runs/reconcile', body: h.posts[0].body });
  expect(h.calls.some(c => /\/history|^\/v1\/sessions\/[^/]+\/events\?/.test(c.path))).toBe(false); expect(h.bearerOK).toBe(true); expect(h.external).toBe(0);
});

test('active full reload and unload retain only hash; stale task reply never resubmits, reconciles or cancels work', async ({ page }) => {
  const reply = deferred();
  const h = await setup(page, latest(), { post: async (_url, body) => { await reply.promise; return { api_version: 1, receipt: { operation_id: body.operation_id, session_id: f.SID, run_id: body.run_id, first_sequence: '110', last_sequence: '111' }, duplicate: false, warning_code: null, notices: [] }; } });
  await h.connect(); await expect.poll(() => h.streams).toBe(1); await h.root.getByLabel('Task', { exact: true }).fill('page-only pending task');
  await h.root.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => h.posts.length).toBe(1); await expect(h.root.locator('.command')).toContainText('task: sending');
  await page.reload(); await expect(h.root.getByRole('button', { name: 'Connect', exact: true })).toBeVisible(); const afterReload = h.calls.length;
  await frames(page); expect(h.calls).toHaveLength(afterReload); expect(new URL(page.url()).hash).toBe(`#session=${f.SID}`);
  await expect(h.root.getByLabel('Owner token', { exact: true })).toHaveValue(''); await expect(h.root.getByLabel('Task', { exact: true })).toHaveValue(''); expect(await h.root.locator('.command').count()).toBe(0);
  reply.resolve(); await h.connect(); await expect.poll(() => h.streams).toBe(1); await expect(h.transcript).toContainText('Task B'); expect(h.posts).toHaveLength(1);
  await page.goto('about:blank'); await expect.poll(() => h.streams).toBe(0); const afterUnload = h.calls.length; await page.goto(fixture.origin + `/#session=${f.SID}`);
  await expect(h.root.getByRole('button', { name: 'Connect', exact: true })).toBeVisible(); await frames(page); expect(h.calls).toHaveLength(afterUnload);
  expect(h.posts.map(p => p.path)).toEqual([base + '/runs']); expect(h.calls.some(c => /\/history|^\/v1\/sessions\/[^/]+\/events\?/.test(c.path))).toBe(false);
  expect(h.bearerOK).toBe(true); expect(h.external).toBe(0);
});

for (const boundary of ['Disconnect','HTTP401']) test(`active ${boundary} clears transcript commands draft and memory connection without implicit mutations`, async ({ page }) => {
  let unauthorized = false;
  const h = await setup(page, latest('synthetic private rendered text\n' + long(60)), { catalog: () => unauthorized ? safeError('api.unauthorized') : { api_version: 1, entries: [], has_more: false, next_after_id: null } });
  await h.connect(); await expect.poll(() => h.streams).toBe(1);
  await h.root.getByLabel('Task', { exact: true }).fill('synthetic pending text'); await h.root.getByRole('button', { name: 'Send', exact: true }).click(); await expect(h.root.locator('.command')).toContainText('task: uncertain');
  await h.root.getByLabel('Task', { exact: true }).fill('synthetic draft'); await h.root.getByLabel('Title', { exact: true }).fill('synthetic title');
  if (boundary === 'Disconnect') await h.root.getByRole('button', { name: 'Disconnect', exact: true }).click();
  else { unauthorized = true; await h.root.getByRole('button', { name: 'Refresh list', exact: true }).click(); await expect(h.root).toContainText('Authorization failed.'); }
  await expect(h.root.getByRole('button', { name: 'Connect', exact: true })).toBeVisible(); await expect.poll(() => h.streams).toBe(0);
  for (const label of ['Task','Title','Owner token']) await expect(h.root.getByLabel(label, { exact: true })).toHaveValue('');
  expect(await h.root.locator('.command,.entry,.run').count()).toBe(0); expect(await h.root.textContent()).not.toContain('synthetic private');
  expect(await page.evaluate(owner => document.body.textContent.includes(owner) || [...document.querySelectorAll('input,textarea')].some(n => n.value.includes(owner)), fixture.owner)).toBe(false);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }))).toEqual({ local: 0, session: 0, cookie: '' });
  expect(h.posts.map(p => p.path)).toEqual([base + '/runs']); expect(h.bearerOK).toBe(true); expect(h.external).toBe(0);
});

test('active empty session and invalid hash never invent messages or mutate; catalog navigation opens display Latest', async ({ page }) => {
  const catalog = { session_id: f.SID, title: 'Open synthetic session', workspace: '/synthetic/project', created_at_ms: '1', updated_at_ms: '2', observed_head_sequence: '102', view: 'catalog', availability: 'ready', fault_code: null, last_run_id: null, last_run_state: null };
  const h = await setup(page, latest('', { block: null, entries: [], previous_block: null }), { catalog: () => ({ api_version: 1, entries: [catalog], next_after_id: f.SID, has_more: false }) }, '#invalid');
  await h.connect(); await expect(h.root).toContainText('Invalid session fragment ignored.'); expect(h.calls).toHaveLength(2);
  await h.root.getByRole('button', { name: 'Open synthetic session', exact: true }).click();
  await expect(h.transcript).toContainText('No messages yet.'); await expect.poll(() => h.streams).toBe(1);
  expect(new URL(page.url()).hash).toBe(`#session=${f.SID}`); expect(await h.transcript.locator('h4').count()).toBe(0); expect(h.admitted).toHaveLength(0);
  await expect(h.root.getByRole('button', { name: 'Load older', exact: true })).toBeDisabled(); readOnly(h);
});
