import { test, expect } from '@playwright/test';
import { rustPageFixture } from '../test-support/display-dom.mjs';
import * as f from '../test-support/display-fixtures.mjs';

// B/C: actual Chromium and generated modules, synthetic API routes/stream seam.
// The page/assets are real Rust HTTP. These cases are not joined producer proof.
let fixture;
test.beforeEach(async ({ browser }) => {
  fixture = undefined;
  fixture = await rustPageFixture(process.env.WI_C3A_FIXTURE);
  console.log('DISPLAY_BROWSER_FIXTURE', JSON.stringify({ pid: fixture.pid, chromium: browser.version() }));
});
test.afterEach(async () => {
  const owned = fixture;
  fixture = undefined;
  if (owned) { await owned.stop(); console.log('DISPLAY_BROWSER_FIXTURE_CLOSED', JSON.stringify({ pid: owned.pid, cleaned: true, exit: 0 })); }
});
const B = f.OTHER;
const utf8 = text => Buffer.byteLength(text);
function human(text = 'Task B', sequence = '100', run_id = B) { return f.human({ run_id, entry_id: `e:${sequence}:0`, position: { sequence, slot: '0' }, revision: sequence, content_epoch: sequence,
  fields: [f.field({ field_id: 'text', order_key: '0', generation: sequence, total_bytes: String(utf8(text)), to_byte: String(utf8(text)), text })] }); }
function assistant(text, sequence = '102', run_id = B) { return f.entry({ run_id, entry_id: `e:${sequence}:0`, position: { sequence, slot: '0' }, revision: sequence, content_epoch: sequence,
  fields: [f.field({ generation: sequence, total_bytes: String(utf8(text)), to_byte: String(utf8(text)), text })] }); }
function latest(text = 'short B', options = {}) { const b = f.block({ run_id: B, accepted_sequence: '100', revision: '102', human: human() });
  return f.page({ snapshot_head: '102', session: f.session('102'), block: b, entries: [assistant(text)], previous_block: f.cursor('b', '100'), live_after: f.cursor('l', '102', '3', '', ''), ...options }); }
function before(text = 'older A', sequence = '2', run_id = f.RID, previous = null) {
  return f.page({ snapshot_head: '102', session: f.session('102'), block: f.block({ run_id, accepted_sequence: sequence, revision: sequence, human: human('Task A', sequence, run_id) }), entries: [], previous_block: previous, live_after: null });
}
const long = n => Array.from({ length: n }, (_, i) => `line ${i} 雪 inert https://invalid.test/\u001b[31m`).join('\n');
const safeError = code => ({ api_version: 1, code, stage: null, certainty: code === 'storage.commit_unknown' ? 'unknown' : 'not_applicable', acceptance: null, notices: [] });
async function mount(page, first, handlers = {}) {
  const requests = [], posts = [], admitted = [];
  let external = 0, bearerOK = true, latestCount = 0;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== fixture.origin) { external++; await route.abort(); return; }
    if (!url.pathname.startsWith('/v1/')) { await route.continue(); return; }
    bearerOK &&= request.headers().authorization === 'Bearer ' + fixture.owner;
    requests.push(url.pathname + url.search);
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    if (body !== null) posts.push({ path: url.pathname, body });
    let value, status = 200;
    if (url.pathname === '/v1/settings') value = { api_version: 1, workspaces: ['/synthetic/project'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: false };
    else if (url.pathname === '/v1/sessions') {
      const entries = await handlers.catalog?.() ?? [];
      value = { api_version: 1, entries, has_more: false, next_after_id: entries.at(-1)?.session_id ?? null };
    }
    else if (url.pathname.endsWith('/conversation') && url.search === '') {
      latestCount++; value = latestCount === 1 ? first : await handlers.latest?.(latestCount) ?? first;
    } else if (url.pathname.includes('/conversation')) {
      admitted.push({ route: url.pathname + url.search, bRendered: await page.locator('#display-test .transcript').evaluate(node => node.textContent.includes('Task B')),
        overflow: await page.locator('#display-test .transcript').evaluate(node => node.scrollHeight > node.clientHeight),
      });
      value = await handlers.older?.(url, admitted.length) ?? before();
    } else if (request.method() === 'POST') value = await handlers.post?.(url, body) ?? safeError('storage.commit_unknown');
    else value = await handlers.read?.(url) ?? safeError('api.not_found');
    if (value?.code) status = value.code === 'api.conversation_cursor_stale' ? 409 : value.code === 'api.unauthorized' ? 401 : 503;
    if (value?.__status) { status = value.__status; value = value.value; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto(fixture.origin);
  await page.evaluate(async holdLayout => {
    const { createDisplayClient } = await import('/assets/display-client.js');
    const { mountDisplayView } = await import('/assets/display-view.js');
    const root = document.createElement('main'); root.id = 'display-test'; document.body.append(root);
    let sender, events = 0;
    const client = createDisplayClient({ fetch: (url, init) => {
      if (String(url).includes('/conversation/events?')) {
        events++;
        return Promise.resolve(new Response(new ReadableStream({ start(c) { sender = c; }, cancel() { sender = null; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return fetch(url, init);
    } });
    const queued = new Map(); let frame = 0;
    const layout = { request(cb) { const id = ++frame; queued.set(id, cb); return id; }, cancel(id) { queued.delete(id); } };
    const navigations = [];
    const view = mountDisplayView(root, client, sid => { navigations.push(sid); void client.selectSession(sid); }, true, holdLayout ? layout : undefined);
    window.displayHarness = { client, view, navigations, staticListenerCount: view.listenerCount, get events() { return events; }, flushLayout() { for (const [id, cb] of [...queued]) { queued.delete(id); cb(performance.now()); } }, push(batch) { sender.enqueue(new TextEncoder().encode(`event: wi.conversation\nid: ${batch.next_after}\ndata: ${JSON.stringify(batch)}\n\n`)); } };
  }, handlers.holdLayout === true);
  const root = page.locator('#display-test');
  await root.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
  await root.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(root.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().connection)).toBe('connected');
  await page.evaluate(sid => window.displayHarness.client.selectSession(sid), f.SID);
  return { root, transcript: root.getByLabel('Canonical conversation'), requests, posts, admitted, get external() { return external; }, get bearerOK() { return bearerOK; } };
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function push(page, text, revision = '103') {
  const e = assistant(text); e.revision = revision;
  const b = latest().block; b.revision = revision;
  await page.evaluate(batch => window.displayHarness.push(batch), f.batch([f.upsert(e, b)], revision));
  await frames(page);
}
async function noOverflow(page, root) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await root.locator('.transcript pre').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1))).toBe(true);
}

for (const viewport of [{ width: 360, height: 800 }, { width: 1440, height: 900 }]) test(`B/C tall B first zero A inert wrapping and memory-only clear ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const inert = '<img src="https://external.invalid/x"><script>window.bad=1</script>雪\u001b[31m\n' + long(60);
  const h = await mount(page, latest(inert));
  await frames(page); expect(h.admitted).toHaveLength(0);
  await expect(h.transcript.locator('pre').filter({ hasText: '<img src=' }).first()).toHaveText(inert);
  expect(await h.transcript.locator('img,script,a,iframe,style').count()).toBe(0);
  expect(await page.evaluate(() => window.bad === undefined)).toBe(true);
  await noOverflow(page, h.root);
  expect(h.external).toBe(0); expect(h.bearerOK).toBe(true);
  expect(await h.root.getByLabel('Owner token', { exact: true }).inputValue()).toBe('');
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie.length, fragment: location.hash }));
  expect(storage).toEqual({ local: 0, session: 0, cookies: 0, fragment: '' });
  await h.root.getByLabel('Task', { exact: true }).fill('sensitive synthetic draft');
  await h.root.getByLabel('Title', { exact: true }).fill('sensitive synthetic title');
  await h.root.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect(await h.root.getByLabel('Task', { exact: true }).inputValue()).toBe('');
  expect(await h.root.getByLabel('Title', { exact: true }).inputValue()).toBe('');
  expect(await h.root.textContent()).not.toContain(inert); expect(await h.root.textContent()).not.toContain('sensitive synthetic');
  expect(await page.evaluate(token => document.body.textContent.includes(token) || [...document.querySelectorAll('input,textarea')].some(n => n.value.includes(token)), fixture.owner)).toBe(false);
});

test('B/C short B renders before A, sequential fill after layout stops at overflow and stream is independent', async ({ page }) => {
  let active = 0, maximum = 0;
  await page.setViewportSize({ width: 1440, height: 1100 });
  const first = latest('', { entries: [] });
  first.block.human.fields[0] = f.fragment('Task B', 1, 7, { field_id: 'text', order_key: '0', generation: '100' });
  first.block.human.content_complete = false;
  first.block.human.earlier_content = f.cursor('c', B, 'e:100:0', '100', 'text', '100', '1');
  const h = await mount(page, first, { older: async (_url, count) => {
    maximum = Math.max(maximum, ++active);
    await page.waitForTimeout(30); active--;
    if (count === 1) return f.addressed({ ...first.block.human, fields: [f.fragment(' ', 0, 7, { field_id: 'text', order_key: '0', generation: '100' })], earlier_content: null }, first.block, '102');
    const p = before('', '90', f.RID, f.cursor('b', '90')); p.block.human = human(long(40), '90', f.RID); return p;
  } });
  await expect.poll(() => h.admitted.length).toBe(2); await frames(page);
  expect(h.admitted.every(a => a.bRendered && !a.overflow)).toBe(true); expect(maximum).toBe(1);
  expect(await page.evaluate(() => window.displayHarness.events)).toBe(1);
  await page.setViewportSize({ width: 1440, height: 1100 }); await frames(page);
  await h.transcript.evaluate(node => { node.scrollTop = 0; }); await frames(page);
  expect(h.admitted).toHaveLength(2); expect(h.posts).toHaveLength(0);
});

for (const [name, delta, expected] of [['one-pixel overflow', 1, 0], ['exact equality', 0, 1]]) test(`B/C initial fill actual ${name} stops only on overflow`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await mount(page, latest(), { holdLayout: true, older: () => latest('', { block: null, entries: [], previous_block: null, live_after: null }) });
  await expect(h.transcript).toContainText('Task B');
  await expect(h.transcript.locator('pre').filter({ hasText: 'short B' })).toHaveText('short B');
  expect(h.admitted).toHaveLength(0); expect(h.posts).toHaveLength(0);
  const measured = await h.transcript.evaluate((node, delta) => {
    // Use ordinary CSS height, not mocked scroll metrics, before releasing layout.
    node.style.cssText = 'height:100px;min-height:0;max-height:none;padding:0;border:0;overflow:auto;box-sizing:content-box;';
    const natural = node.scrollHeight;
    node.style.height = `${natural - delta}px`;
    return { natural, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
  }, delta);
  expect(measured.natural).toBeGreaterThan(100);
  expect(measured.scrollHeight - measured.clientHeight).toBe(delta);
  expect(await page.evaluate(() => window.displayHarness.events)).toBe(1);
  console.log('DISPLAY_FILL_MEASURED', JSON.stringify({ name, measured, olderBeforeLayout: h.admitted.length }));
  await page.evaluate(() => window.displayHarness.flushLayout()); await frames(page);
  if (expected === 1) await expect.poll(() => h.admitted.length).toBe(1);
  expect(h.admitted).toHaveLength(expected);
  if (expected === 1) {
    expect(h.admitted[0].route).toContain('conversation?before=');
    expect(h.admitted[0].bRendered).toBe(true); expect(h.admitted[0].overflow).toBe(false);
    await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().selected.older_loading)).toBe(false);
  } else {
    await h.transcript.evaluate(node => { node.style.height = `${node.scrollHeight + 200}px`; });
    await page.evaluate(() => window.displayHarness.client.setDraft('boundary control'));
  }
  await page.evaluate(() => window.displayHarness.flushLayout()); await frames(page);
  expect(h.admitted).toHaveLength(expected); expect(h.posts).toHaveLength(0);
  expect(h.requests.filter(route => route.includes('/conversation?before='))).toHaveLength(expected);
  expect(h.requests.some(route => /\/history|\/events\?/.test(route))).toBe(false);
  expect(h.external).toBe(0); expect(h.bearerOK).toBe(true);
  console.log('DISPLAY_FILL_BOUNDARY', JSON.stringify({ name, measured, olderAdmissions: h.admitted.length, posts: h.posts.length }));
});

test('B/C content then within then before keeps one Human and honest descriptors', async ({ page }) => {
  const tail = long(60), total = utf8(tail) + 5;
  const e = assistant(tail); e.fields = [f.fragment(tail, 5, total, { generation: '102' })]; e.content_complete = false; e.earlier_content = f.cursor('c', B, e.entry_id, '102', f.FID, '102', '5');
  const p = latest('', { entries: [e], earlier_activity: f.cursor('s', B, '102', '0') });
  const h = await mount(page, p, { older: url => {
    if (url.pathname.endsWith('/content')) { const full = { ...e, fields: [f.fragment('head ', 0, total, { generation: '102' })], earlier_content: null }; return f.addressed(full, p.block, '102'); }
    if (url.searchParams.has('within')) return { ...p, entries: [assistant('earlier', '101')], earlier_activity: null, live_after: null };
    return before();
  } });
  for (let count = 1; count <= 3; count++) {
    await h.root.getByRole('button', { name: 'Load older', exact: true }).click();
    await expect.poll(() => h.admitted.length).toBe(count);
    await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().selected.older_loading)).toBe(false);
    if (count < 3) await expect(h.root.getByRole('button', { name: 'Load older', exact: true })).toBeEnabled();
  }
  await frames(page);
  expect(h.admitted.map(a => a.route.includes('/content?') ? 'content' : a.route.includes('within=') ? 'within' : 'before')).toEqual(['content','within','before']);
  expect(await h.transcript.locator('h4').allTextContents()).toEqual(['Human','Human','assistant','assistant']);
  expect((await h.transcript.locator('pre').allTextContents()).filter(t => t === 'Task B')).toHaveLength(1);
  await expect(h.transcript.locator('pre').filter({ hasText: 'head line 0' }).first()).toHaveText('head ' + tail);
});

test('B/C empty session never backfills or invents a Human', async ({ page }) => {
  const h = await mount(page, latest('', { block: null, entries: [], previous_block: null })); await frames(page);
  await expect(h.transcript).toContainText('No messages yet.'); expect(await h.transcript.locator('h4').count()).toBe(0); expect(h.admitted).toHaveLength(0);
  await expect(h.root.getByRole('button', { name: 'Load older', exact: true })).toBeDisabled();
});

test('B/C explicit older and trusted upward 96 admit one request, no synthetic or resize/prepend chain', async ({ page }) => {
  const h = await mount(page, latest(long(60)), { older: (_url, count) => before('', String(100-count*10), `00000000-0000-4000-8000-${String(count).padStart(12,'0')}`, f.cursor('b', String(100-count*10))) });
  await frames(page); await h.transcript.evaluate(n => { n.scrollTop = 0; n.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 })); }); await frames(page); expect(h.admitted).toHaveLength(0);
  await h.transcript.hover(); await page.mouse.wheel(0, -48); await frames(page); expect(h.admitted).toHaveLength(0);
  await page.mouse.wheel(0, -48); await expect.poll(() => h.admitted.length).toBe(1); await frames(page);
  await page.setViewportSize({ width: 1440, height: 1000 }); await frames(page); expect(h.admitted).toHaveLength(1);
  await h.root.getByRole('button', { name: 'Load older', exact: true }).focus(); await page.keyboard.press('Enter'); await expect.poll(() => h.admitted.length).toBe(2); await frames(page); expect(h.admitted).toHaveLength(2);
  expect(h.posts).toHaveLength(0);
});

test('B/C anchor within 2px with prepend and simultaneous live bottom growth; draft/focus survive, bottom follow and New content', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const h = await mount(page, latest(long(100)), { older: async () => { await hold; return before(); } });
  const draft = h.root.getByLabel('Task', { exact: true }); await draft.fill(' draft 雪\nkept ');
  await h.transcript.evaluate(n => { n.scrollTop = 500; }); await frames(page);
  const pre = h.transcript.locator('[data-entry="e:102:0"] [data-field] pre');
  const beforeTop = await pre.evaluate(n => n.getBoundingClientRect().top - n.closest('.transcript').getBoundingClientRect().top);
  await h.root.getByRole('button', { name: 'Load older', exact: true }).click(); await expect.poll(() => h.admitted.length).toBe(1);
  await draft.focus(); await draft.evaluate(n => n.setSelectionRange(2,5));
  await push(page, long(140)); release(); await expect.poll(() => h.transcript.locator('article').count()).toBe(2); await frames(page);
  expect(Math.abs(await pre.evaluate(n => n.getBoundingClientRect().top - n.closest('.transcript').getBoundingClientRect().top) - beforeTop)).toBeLessThanOrEqual(2);
  await expect(draft).toBeFocused(); expect(await draft.inputValue()).toBe(' draft 雪\nkept '); expect(await draft.evaluate(n => [n.selectionStart,n.selectionEnd])).toEqual([2,5]);
  await expect(h.root.getByRole('button', { name: 'New content', exact: true })).toBeVisible();
  await h.root.getByRole('button', { name: 'New content', exact: true }).click();
  await push(page, long(160), '104');
  expect(await h.transcript.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThanOrEqual(2);
  const scroll = await h.transcript.evaluate(n => n.scrollTop);
  await page.evaluate(() => window.displayHarness.client.setDraft('new draft')); await frames(page); expect(await h.transcript.evaluate(n => n.scrollTop)).toBe(scroll);
});

test('B/C content409 refresh affects entry only, failed rebase retains stale text and later success replaces it', async ({ page }) => {
  const e = assistant(long(70)); e.fields[0].from_byte = '5'; e.fields[0].total_bytes = String(utf8(e.fields[0].text)+5); e.fields[0].to_byte = e.fields[0].total_bytes; e.fields[0].has_earlier = true;
  e.content_complete = false; e.earlier_content = f.cursor('c', B, e.entry_id, '102', f.FID, '102', '5');
  const p = latest('', { entries: [e] });
  const h = await mount(page, p, { older: url => url.pathname.endsWith('/content') ? safeError('api.conversation_cursor_stale') : f.addressed({ ...assistant('refreshed'), revision: '103', content_epoch: '103', fields: [f.field({ generation: '103', text: 'refreshed', total_bytes: '9', to_byte: '9' })] }, { ...p.block, revision: '103' }, '103'),
    latest: count => count === 2 ? safeError('storage.io') : latest('fresh B', { previous_block: null }) });
  await h.root.getByRole('button', { name: 'Load older', exact: true }).click();
  await expect(h.transcript).toContainText('Content changed. Refresh this entry explicitly.');
  await h.transcript.getByRole('button', { name: 'Refresh this entry', exact: true }).click(); await expect(h.transcript).toContainText('refreshed');
  expect(h.admitted).toHaveLength(2);
  const draft = h.root.getByLabel('Task', { exact: true }); await draft.fill('kept draft');
  await h.root.getByRole('button', { name: 'Reconnect latest', exact: true }).click(); await expect(h.root).toContainText('Code: storage.io');
  await expect(h.transcript).toContainText('refreshed'); await expect(h.root).toContainText('Retained window is stale'); expect(await draft.inputValue()).toBe('kept draft');
  await h.root.getByRole('button', { name: 'Reconnect latest', exact: true }).click(); await expect(h.transcript).toContainText('fresh B'); await expect(h.transcript).not.toContainText('refreshed'); expect(h.posts).toHaveLength(0);
});

test('B/C keyboard newline, one Ctrl/Cmd send, pending/uncertain/reconcile/discard remain separate from saved messages and 401 clears', async ({ page }) => {
  let reconciles = 0;
  const h = await mount(page, latest(long(60)), { post: url => {
    if (url.pathname.endsWith('/reconcile')) { reconciles++; return f.reconciliation('not_found'); }
    return safeError('storage.commit_unknown');
  }, latest: () => safeError('api.unauthorized') });
  const draft = h.root.getByLabel('Task', { exact: true }); await draft.fill(' exact text '); await draft.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('next 雪');
  const submitted = await draft.inputValue(); expect(submitted).toBe(' exact text \nnext 雪'); expect(h.posts).toHaveLength(0);
  await page.keyboard.press('Control+Enter'); await expect.poll(() => h.posts.length).toBe(1);
  await expect(h.root.locator('.commands')).toContainText('task: uncertain'); await expect(h.transcript).not.toContainText(submitted);
  await draft.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true }); await draft.dispatchEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true }); expect(h.posts).toHaveLength(1);
  await h.root.getByRole('button', { name: 'Retry identical command', exact: true }).click(); await expect.poll(() => h.posts.length).toBe(2);
  expect(h.posts[0].body).toEqual(h.posts[1].body);
  await h.root.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true }).click(); await expect.poll(() => reconciles).toBe(1); await expect(h.root.locator('.commands')).toContainText('Point-in-time absence, not rollback proof');
  expect(h.posts[0].body).toEqual(h.posts[2].body);
  await h.root.getByRole('button', { name: 'Discard local command', exact: true }).click(); expect(h.posts).toHaveLength(3);
  await h.root.getByRole('button', { name: 'Reconnect latest', exact: true }).click(); await expect(h.root).toContainText('Authorization failed');
  expect(await draft.inputValue()).toBe(''); expect(await h.root.locator('.transcript article').count()).toBe(0);
  expect(await page.evaluate(token => document.body.textContent.includes(token), fixture.owner)).toBe(false);
});

test('B/C failed older read stops fill until explicit action while stream continues', async ({ page }) => {
  const h = await mount(page, latest('', { entries: [] }), { older: () => safeError('storage.io') });
  await expect.poll(() => h.admitted.length).toBe(1); await expect(h.root).toContainText('Code: storage.io');
  await page.setViewportSize({ width: 1440, height: 1100 }); await frames(page); expect(h.admitted).toHaveLength(1);
  await page.evaluate(batch => window.displayHarness.push(batch), f.batch([f.upsert(assistant('live after older error', '103'), { ...latest().block, revision: '103' })], '103'));
  await expect(h.transcript).toContainText('live after older error'); expect(h.admitted).toHaveLength(1);
  await h.root.getByRole('button', { name: 'Load older', exact: true }).click(); await expect.poll(() => h.admitted.length).toBe(2); await frames(page); expect(h.admitted).toHaveLength(2);
});

test('B/C loaded suffix anchor stays within 2px when earlier content expands the same field', async ({ page }) => {
  const tail = long(90), prefix = long(30) + '\n';
  const e = assistant(tail), offset = utf8(prefix), total = offset + utf8(tail);
  e.fields = [f.fragment(tail, offset, total, { generation: '102' })]; e.content_complete = false;
  e.earlier_content = f.cursor('c', B, e.entry_id, '102', f.FID, '102', String(offset));
  const first = latest('', { entries: [e] });
  const h = await mount(page, first, { older: () => f.addressed({ ...e, fields: [f.fragment(prefix, 0, total, { generation: '102' })], earlier_content: null }, first.block, '102') });
  await h.transcript.evaluate(n => { n.scrollTop = 700; }); await frames(page);
  const pre = h.transcript.locator('[data-entry="e:102:0"] [data-field] pre');
  const y = async () => pre.evaluate(n => { const index = n.textContent.lastIndexOf('line 25 '); const range = document.createRange(); range.setStart(n.firstChild, index); range.setEnd(n.firstChild, index+1); return range.getBoundingClientRect().top - n.closest('.transcript').getBoundingClientRect().top; });
  const beforeY = await y();
  await h.root.getByRole('button', { name: 'Load older', exact: true }).click(); await expect(pre).toHaveText(prefix + tail); await frames(page);
  expect(Math.abs(await y() - beforeY)).toBeLessThanOrEqual(2); expect(h.admitted).toHaveLength(1);
});

test('B/C pending before response is not saved; acceptance receipt and one canonical Human stay distinct', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; }); let submitted;
  const h = await mount(page, latest(long(60)), { post: async (_url, body) => {
    submitted = body; await hold;
    return { __status: 202, value: { api_version: 1, receipt: { operation_id: body.operation_id, session_id: f.SID, run_id: body.run_id, first_sequence: '104', last_sequence: '105' }, duplicate: false, warning_code: null, notices: [] } };
  } });
  const draft = h.root.getByLabel('Task', { exact: true }); await draft.fill(' exact canonical Task C 雪 '); await draft.press('Control+Enter');
  await expect(h.root.locator('.commands')).toContainText('task: sending'); await expect(h.transcript).not.toContainText('exact canonical Task C');
  expect(h.posts).toHaveLength(1);
  const b = f.block({ run_id: submitted.run_id, accepted_sequence: '104', revision: '104', state: 'accepted', human: human(submitted.text, '104', submitted.run_id) });
  await page.evaluate(batch => window.displayHarness.push(batch), f.batch([{ kind: 'block.upsert', block: b }], '105'));
  release(); await expect(h.root.locator('.commands')).toContainText('task: accepted'); await expect(h.root.locator('.commands')).toContainText('Accepted receipt (not completion)');
  expect((await h.transcript.locator('pre').allTextContents()).filter(t => t === submitted.text)).toHaveLength(1); expect(await draft.inputValue()).toBe('');
  await frames(page); expect(h.posts).toHaveLength(1);
});

test('B/C disposed and old scheduled layout cannot fill another session', async ({ page }) => {
  const h = await mount(page, latest(long(60)));
  await page.evaluate(async sid => { const pending = window.displayHarness.client.selectSession(sid); window.displayHarness.view.dispose(); await pending; window.displayHarness.client.disconnect(); }, f.OTHER);
  await frames(page); expect(h.admitted).toHaveLength(0); expect(await h.root.locator('*').count()).toBe(0); expect(h.posts).toHaveLength(0);
});

const privateCatalog = (title = 'Synthetic private catalog title', sid = f.SID) => ({ session_id: sid, title, workspace: '/synthetic/project', created_at_ms: '1', updated_at_ms: '2', observed_head_sequence: '102', view: 'catalog', availability: 'ready', fault_code: null, last_run_id: null, last_run_state: null });
async function holdRow(page, selector) {
  await page.evaluate(selector => {
    const row = document.querySelector(selector), held = [row, ...row.querySelectorAll('*')], atDetach = [];
    const values = () => held.map(n => ({ text: n.textContent, value: n.matches('button,input,textarea,select,option') ? n.value : '' }));
    const remove = row.remove;
    // Observe one controlled row, not the global DOM or listener implementation.
    row.remove = function () { atDetach.push(values()); remove.call(this); };
    (window.displayRetirements ??= []).push({ row, held, atDetach, values });
  }, selector);
}
async function assertRetired(page) {
  const observations = await page.evaluate(() => window.displayRetirements.map(p => ({ attached: p.row.isConnected, atDetach: p.atDetach, now: p.values() })));
  for (const p of observations) {
    expect(p.attached).toBe(false); expect(p.atDetach).toHaveLength(1);
    for (const value of [...p.now, ...p.atDetach.flat()]) expect(value).toEqual({ text: '', value: '' });
  }
}
async function clickHeld(page) {
  await page.evaluate(() => { for (const p of window.displayRetirements) for (const n of p.held) if (n.tagName === 'BUTTON') n.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await frames(page);
}

for (const boundary of ['Disconnect', 'actual controller 401']) test(`B/C nonempty catalog ${boundary} clears held titles and nested transcript before detach`, async ({ page }) => {
  let unauthorized = false;
  const h = await mount(page, latest(long(60)), { catalog: () => [privateCatalog()], latest: () => unauthorized ? safeError('api.unauthorized') : latest(long(60)) });
  await expect(h.root.locator('.session-list button')).toHaveText(privateCatalog().title);
  await h.root.locator('.session-list button').evaluate(n => { n.value = 'Synthetic private held control value'; });
  await holdRow(page, '#display-test .session-list li'); await holdRow(page, '#display-test .transcript article');
  await h.root.getByLabel('Task', { exact: true }).fill('synthetic private draft');
  await h.root.getByLabel('Title', { exact: true }).fill('synthetic private title');
  if (boundary === 'Disconnect') await h.root.getByRole('button', { name: 'Disconnect', exact: true }).click();
  else { unauthorized = true; await page.evaluate(sid => window.displayHarness.client.selectSession(sid), f.SID); }
  expect(await page.evaluate(() => window.displayHarness.client.snapshot().connection)).toBe('disconnected');
  if (boundary === 'actual controller 401') await expect(h.root).toContainText('Authorization failed');
  await assertRetired(page);
  const count = h.requests.length; await clickHeld(page); expect(h.requests).toHaveLength(count);
  expect(await page.evaluate(() => window.displayHarness.navigations)).toEqual([]);
  for (const name of ['Owner token', 'Title', 'Exact new title', 'Task']) expect(await h.root.getByLabel(name, { exact: true }).inputValue()).toBe('');
  expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(await page.evaluate(() => window.displayHarness.staticListenerCount));
  expect(h.posts).toHaveLength(0); expect(h.external).toBe(0);
});

test('B/C nine catalog replacement reconnect and removal cycles do not accumulate owned registrations', async ({ page }) => {
  let catalog = [];
  const h = await mount(page, latest(long(60)), { catalog: () => catalog });
  const baseline = await page.evaluate(() => window.displayHarness.view.listenerCount);
  for (let i = 0; i < 9; i++) {
    catalog = [privateCatalog(`Synthetic removed title ${i}`)];
    await h.root.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect(h.root.locator('.session-list button')).toHaveText(catalog[0].title);
    await holdRow(page, '#display-test .session-list li');
    if (i % 3 === 2) {
      await h.root.getByRole('button', { name: 'Disconnect', exact: true }).click();
      catalog = [];
      await h.root.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
      await h.root.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().connection)).toBe('connected');
      await page.evaluate(sid => window.displayHarness.client.selectSession(sid), f.SID);
    } else {
      catalog = []; await h.root.getByRole('button', { name: 'Refresh list', exact: true }).click();
      await expect(h.root.locator('.session-list button')).toHaveCount(0);
    }
  }
  await assertRetired(page);
  expect(await page.evaluate(() => new Set(window.displayRetirements.map(p => p.held.find(n => n.tagName === 'BUTTON'))).size)).toBe(9);
  expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(baseline);
  const count = h.requests.length; await clickHeld(page); expect(h.requests).toHaveLength(count);
  expect(await page.evaluate(() => window.displayHarness.navigations)).toEqual([]);
  await expect(h.root).toContainText('No sessions in this catalog observation.');
  expect(h.posts).toHaveLength(0); expect(h.external).toBe(0);
});

test('B/C actual command discard retires held command controls and ordinary dispose clears all held controls', async ({ page }) => {
  const h = await mount(page, latest(long(60)));
  const draft = h.root.getByLabel('Task', { exact: true }); await draft.fill('synthetic private captured command'); await draft.press('Control+Enter');
  await expect(h.root.locator('.commands')).toContainText('task: uncertain');
  const baseline = await page.evaluate(() => window.displayHarness.view.listenerCount);
  await holdRow(page, '#display-test .commands article');
  await h.root.getByRole('button', { name: 'Discard local command', exact: true }).click();
  await assertRetired(page);
  expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(baseline - 4);
  const count = h.requests.length; await clickHeld(page); expect(h.requests).toHaveLength(count); expect(h.posts).toHaveLength(1);
  await page.evaluate(() => { window.displayHeldControls = [...document.querySelectorAll('#display-test *')]; window.displayHarness.view.dispose(); window.displayHarness.view.dispose(); });
  expect(await page.evaluate(() => window.displayHeldControls.every(n => n.textContent === '' && (!n.matches('button,input,textarea,select,option') || n.value === '')))).toBe(true);
  await page.evaluate(() => { for (const n of window.displayHeldControls) if (n.tagName === 'BUTTON') n.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(0); expect(h.requests).toHaveLength(count);
  expect(await h.root.locator('*').count()).toBe(0); expect(h.external).toBe(0);
});

for (const scope of ['range', 'field', 'entry', 'human', 'block']) test(`B/C synthetic ${scope} removal scrubs held descendants and keeps retained focus disclosure and draft`, async ({ page }) => {
  const e = assistant(long(60)); e.fields[0].kind = 'reasoning_text';
  const h = await mount(page, latest('', { entries: [e] }), { holdLayout: true });
  const draft = h.root.getByLabel('Task', { exact: true }); await draft.fill(' retained draft 雪 '); await draft.focus(); await draft.evaluate(n => n.setSelectionRange(2, 5));
  await h.transcript.locator('[data-entry="e:102:0"] details').evaluate(n => { n.open = true; });
  const selector = scope === 'block' ? '#display-test .transcript article' : scope === 'human' ? '#display-test [data-entry="e:100:0"]' : scope === 'entry' ? '#display-test [data-entry="e:102:0"]' : scope === 'field' ? '#display-test [data-entry="e:102:0"] [data-field]' : '#display-test [data-entry="e:102:0"] [data-field] pre';
  await holdRow(page, selector);
  const before = await page.evaluate(scope => {
    const { client, view } = window.displayHarness, state = client.snapshot(), store = state.selected.store, b = store.blocks[0];
    window.displayRetained = { block: document.querySelector('#display-test .transcript article'), human: document.querySelector('#display-test [data-entry="e:100:0"]'), disclosure: document.querySelector('#display-test [data-entry="e:102:0"] details') };
    const before = view.listenerCount;
    let next = b;
    if (scope === 'range') next = { ...b, entries: [{ ...b.entries[0], fields: [{ ...b.entries[0].fields[0], ranges: [] }] }] };
    if (scope === 'field') next = { ...b, entries: [{ ...b.entries[0], fields: [] }] };
    if (scope === 'entry') next = { ...b, entries: [] };
    if (scope === 'human') next = { ...b, human: { ...b.human, view: { ...b.human.view, entry_id: 'e:100:1' }, fields: [] } };
    view.render({ ...state, selected: { ...state.selected, store: { ...store, blocks: scope === 'block' ? [] : [next] } } });
    return before;
  }, scope);
  await assertRetired(page);
  expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(before - (scope === 'block' ? 3 : scope === 'entry' ? 1 : 0));
  const count = h.requests.length; await clickHeld(page); expect(h.requests).toHaveLength(count);
  await expect(draft).toBeFocused(); expect(await draft.inputValue()).toBe(' retained draft 雪 '); expect(await draft.evaluate(n => [n.selectionStart, n.selectionEnd])).toEqual([2, 5]);
  if (scope !== 'block') expect(await page.evaluate(() => document.querySelector('#display-test .transcript article') === window.displayRetained.block)).toBe(true);
  if (scope === 'human') expect(await page.evaluate(() => document.querySelector('#display-test [data-entry="e:102:0"] details') === window.displayRetained.disclosure && window.displayRetained.disclosure.open)).toBe(true);
  if (scope !== 'human' && scope !== 'block') expect(await page.evaluate(() => document.querySelector('#display-test [data-entry="e:100:0"]') === window.displayRetained.human)).toBe(true);
  expect(h.posts).toHaveLength(0); expect(h.external).toBe(0);
});

async function holdWorkspace(page) {
  await page.evaluate(() => {
    const select = document.querySelector('#display-test select'), native = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    const held = [...select.options].map(option => {
      const child = option.firstChild, beforeTextRemoval = [];
      Object.defineProperty(option, 'textContent', { get() { return native.get.call(this); }, set(value) { beforeTextRemoval.push(child.textContent); native.set.call(this, value); } });
      return { option, child, beforeTextRemoval };
    });
    const values = () => held.map(({ option, child }) => ({ text: option.textContent, value: option.value, attribute: option.getAttribute('value'), label: option.label, child: child.textContent }));
    const probe = { select, held, values, atDetach: [] };
    (window.workspaceRetirements ??= []).push(probe);
    if (!select.workspaceObserved) {
      select.workspaceObserved = true;
      const observe = () => { for (const p of window.workspaceRetirements) if (p.held.some(h => select.contains(h.option))) p.atDetach.push(p.values()); };
      const replace = select.replaceChildren;
      // These observers belong to this select and its options, never the global DOM.
      select.replaceChildren = function (...children) { observe(); replace.apply(this, children); };
      Object.defineProperty(select, 'textContent', { get() { return native.get.call(this); }, set(value) { observe(); native.set.call(this, value); } });
    }
  });
}
async function workspaceRetired(page) {
  const probes = await page.evaluate(() => window.workspaceRetirements.map(p => ({ attached: p.held.map(h => h.option.isConnected), atDetach: p.atDetach, now: p.values(), beforeTextRemoval: p.held.map(h => h.beforeTextRemoval) })));
  for (const p of probes) {
    expect(p.attached.every(a => !a)).toBe(true); expect(p.atDetach).toHaveLength(1);
    for (const values of [...p.atDetach, p.now]) for (const v of values) expect(v).toEqual({ text: '', value: '', attribute: '', label: '', child: '' });
    for (const values of p.beforeTextRemoval) expect(values).toEqual(['']);
  }
}
async function detachedWorkspaceActions(page) {
  await page.evaluate(() => { for (const p of window.workspaceRetirements) for (const h of p.held) { h.option.dispatchEvent(new MouseEvent('click', { bubbles: true })); h.option.dispatchEvent(new Event('change', { bubbles: true })); } });
  await frames(page);
}

for (const boundary of ['Disconnect', 'actual controller HTTP401']) test(`B/C workspace ${boundary} blanks held native options and original Text before detach reconnect and dispose`, async ({ page }) => {
  let unauthorized = false;
  const h = await mount(page, latest(long(60)), { latest: () => unauthorized ? safeError('api.unauthorized') : latest(long(60)) });
  const select = h.root.locator('select'), staticCount = await page.evaluate(() => window.displayHarness.staticListenerCount);
  for (let i = 0; i < 3; i++) {
    await expect(select.locator('option')).toHaveText(['/synthetic/project']);
    await holdWorkspace(page);
    expect(await page.evaluate(() => window.workspaceRetirements.at(-1).values())).toEqual([{ text: '/synthetic/project', value: '/synthetic/project', attribute: '/synthetic/project', label: '/synthetic/project', child: '/synthetic/project' }]);
    if (boundary === 'Disconnect') await h.root.getByRole('button', { name: 'Disconnect', exact: true }).click();
    else { unauthorized = true; await page.evaluate(sid => window.displayHarness.client.selectSession(sid), f.SID); }
    await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().connection)).toBe('disconnected');
    if (boundary === 'actual controller HTTP401') await expect(h.root).toContainText('Authorization failed');
    await workspaceRetired(page); await expect(select.locator('option')).toHaveCount(0); expect(await select.inputValue()).toBe('');
    for (const name of ['Owner token', 'Title', 'Exact new title', 'Task']) expect(await h.root.getByLabel(name, { exact: true }).inputValue()).toBe('');
    expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(staticCount);
    unauthorized = false;
    await h.root.getByLabel('Owner token', { exact: true }).fill(fixture.owner); await h.root.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().connection)).toBe('connected');
    await expect(select.locator('option')).toHaveText(['/synthetic/project']); await select.selectOption('/synthetic/project');
    expect(await select.inputValue()).toBe('/synthetic/project');
    expect(await page.evaluate(() => window.workspaceRetirements.every(p => p.held.every(h => h.option !== document.querySelector('#display-test option'))))).toBe(true);
  }
  await holdWorkspace(page); await page.evaluate(() => { window.displayHarness.view.dispose(); window.displayHarness.view.dispose(); });
  await workspaceRetired(page);
  const count = h.requests.length; await detachedWorkspaceActions(page); expect(h.requests).toHaveLength(count);
  expect(await page.evaluate(() => window.displayHarness.navigations)).toEqual([]); expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(0);
  expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0); expect(h.requests.some(p => p.includes('/history') || /\/events\?/.test(p))).toBe(false);
});

test('B/C changed workspace lists scrub retiring native options but identical copies retain option Text focus selection and draft', async ({ page }) => {
  const h = await mount(page, latest(long(60))), select = h.root.locator('select'), draft = h.root.getByLabel('Task', { exact: true });
  const paths = ['/synthetic/private-workspace', '/synthetic/other-workspace'];
  await draft.fill(' retained draft 雪 ');
  await page.evaluate(paths => { const s = window.displayHarness.client.snapshot(); window.displayHarness.view.render({ ...s, settings: { ...s.settings, workspaces: paths } }); }, paths);
  const baseline = await page.evaluate(() => window.displayHarness.view.listenerCount), count = h.requests.length;
  for (let i = 0; i < 3; i++) {
    await holdWorkspace(page);
    const current = await select.locator('option').evaluateAll(nodes => nodes.map(n => n.value));
    await select.selectOption(current[1]); await select.focus();
    await page.evaluate(paths => { const s = window.displayHarness.client.snapshot(); window.displayHarness.view.render({ ...s, settings: { ...s.settings, workspaces: [...paths] } }); }, current);
    await expect(select).toBeFocused(); expect(await select.inputValue()).toBe(current[1]);
    expect(await page.evaluate(() => { const p = window.workspaceRetirements.at(-1); return p.atDetach.length === 0 && p.held.every((h, i) => h.option === p.select.options[i] && h.child === h.option.firstChild); })).toBe(true);
    await draft.focus(); await draft.evaluate(n => n.setSelectionRange(2, 5));
    await page.evaluate(paths => { const s = window.displayHarness.client.snapshot(); window.displayHarness.view.render({ ...s, settings: { ...s.settings, workspaces: [...paths] } }); }, current);
    await expect(draft).toBeFocused(); expect(await draft.inputValue()).toBe(' retained draft 雪 '); expect(await draft.evaluate(n => [n.selectionStart, n.selectionEnd])).toEqual([2, 5]);
    const next = paths.map(p => `${p}-${i}`);
    await page.evaluate(paths => { const s = window.displayHarness.client.snapshot(); window.displayHarness.view.render({ ...s, settings: { ...s.settings, workspaces: paths } }); }, next);
    await workspaceRetired(page); await expect(select.locator('option')).toHaveText(next); await select.selectOption(next[1]); expect(await select.inputValue()).toBe(next[1]);
    await expect(draft).toBeFocused(); expect(await draft.inputValue()).toBe(' retained draft 雪 '); expect(await draft.evaluate(n => [n.selectionStart, n.selectionEnd])).toEqual([2, 5]);
    expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(baseline);
  }
  await holdWorkspace(page); await page.evaluate(() => { window.displayHarness.view.dispose(); window.displayHarness.view.dispose(); }); await workspaceRetired(page);
  await detachedWorkspaceActions(page); expect(h.requests).toHaveLength(count); expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0);
  expect(await page.evaluate(() => window.displayHarness.navigations)).toEqual([]); expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(0);
});

const focusText = 'retained reasoning 雪';
const focusFragment = (id, index, kind = 'text', text = focusText) => f.field({ field_id: id, order_key: f.order(2, BigInt(index)), kind, text, total_bytes: String(utf8(text)), to_byte: String(utf8(text)) });
const focusA = focusFragment(f.FID, 0, 'reasoning_summary', 'removed synthetic preceding text');
const focusB = focusFragment(f.SECOND, 1, 'reasoning_summary');
async function protectFocus(page, selector, composer = false) {
  await page.evaluate(({ selector, composer }) => {
    const root = document.querySelector('#display-test'), row = root.querySelector(selector);
    const draft = [...root.querySelectorAll('label')].find(n => n.firstChild.textContent === 'Task').querySelector('textarea');
    let target = row;
    if (composer) target = draft;
    else if (row.matches('li,.command')) target = row.querySelector('button');
    else target = row.querySelector('summary') ?? row.querySelector('button') ?? row;
    const disclosure = target.closest('details') ?? row.querySelector('details');
    if (disclosure) disclosure.open = true;
    draft.setSelectionRange(2,8,'backward'); target.focus();
    const pre = row.matches('pre') ? row : disclosure?.querySelector('pre') ?? row.querySelector('[data-range]') ?? row.querySelector('pre'), child = pre?.firstChild;
    if (!composer && child) { const range = document.createRange(); range.setStart(child,0); range.setEnd(child,8); const s = document.getSelection(); s.removeAllRanges(); s.addRange(range); }
    const moves = []; let blur = 0, focus = 0;
    target.addEventListener('blur', () => blur++); target.addEventListener('focus', () => focus++);
    // Observe only this row's owning lists, never global DOM or private controller state.
    for (let node = row; node !== root; node = node.parentElement) {
      const container = node.parentElement, insert = container.insertBefore;
      container.insertBefore = function (moved, next) { const protectedMove = moved.contains(target); moves.push({ protectedMove, connectedBefore: row.isConnected }); const result = insert.call(this,moved,next); moves.at(-1).connectedAfter = row.isConnected; return result; };
    }
    const s = document.getSelection();
    window.focusProof = { row, target, disclosure, pre, child, draft, moves, get blur() { return blur; }, get focus() { return focus; },
      block: row.closest('.run'), entry: row.closest('.entry'), selector, composer,
      before: { draft: draft.value, draftSelection: [draft.selectionStart,draft.selectionEnd,draft.selectionDirection], text: s.toString(), anchor: s.anchorNode, focus: s.focusNode, anchorOffset: s.anchorOffset, focusOffset: s.focusOffset } };
  }, { selector, composer });
  expect(await page.evaluate(() => document.activeElement === window.focusProof.target)).toBe(true);
  expect(await page.evaluate(() => window.focusProof.before.draftSelection)).toEqual([2,8,'backward']);
}
async function focusPreserved(page, removed = false) {
  const proof = await page.evaluate(() => {
    const p = window.focusProof, s = document.getSelection();
    return { focused: document.activeElement === p.target, connected: p.target.isConnected, rowConnected: p.row.isConnected,
      same: document.querySelector('#display-test').querySelector(p.selector) === p.row,
      blockSame: !p.block || document.querySelector(`[data-run="${p.block.dataset.run}"]`) === p.block,
      entrySame: !p.entry || p.block.querySelector(`[data-entry="${p.entry.dataset.entry}"]`) === p.entry,
      preSame: !p.pre || p.pre.firstChild === p.child, open: !p.disclosure || p.disclosure.open,
      blur: p.blur, focus: p.focus, protectedMoves: p.moves.filter(m => m.protectedMove).length,
      disconnectedDuringMove: p.moves.some(m => !m.connectedBefore || !m.connectedAfter),
      selectionSame: s.anchorNode === p.before.anchor && s.focusNode === p.before.focus && s.anchorOffset === p.before.anchorOffset && s.focusOffset === p.before.focusOffset && s.toString() === p.before.text,
      selectedText: s.toString(), composerSame: p.draft.value === p.before.draft && JSON.stringify([p.draft.selectionStart,p.draft.selectionEnd,p.draft.selectionDirection]) === JSON.stringify(p.before.draftSelection) };
  });
  expect(proof.composerSame).toBe(true); expect(proof.focus).toBe(0);
  if (removed) { expect(proof.connected).toBe(false); expect(proof.focused).toBe(false); }
  else {
    expect(proof).toMatchObject({ focused: true, connected: true, rowConnected: true, same: true, blockSame: true, entrySame: true, preSame: true, open: true, blur: 0, protectedMoves: 0, disconnectedDuringMove: false, selectionSame: true });
  }
  console.log('DISPLAY_FOCUS_PROOF', JSON.stringify(proof));
}
async function holdOriginalText(page, selector) {
  await holdRow(page, selector);
  await page.evaluate(() => {
    const p = window.displayRetirements.at(-1), texts = p.held.flatMap(n => [...n.childNodes].filter(n => n.nodeType === Node.TEXT_NODE));
    const remove = p.row.remove; p.originalTexts = texts; p.textAtDetach = [];
    p.row.remove = function () { p.textAtDetach.push(texts.map(n => n.textContent)); return remove.call(this); };
  });
}
async function originalTextRetired(page) {
  await assertRetired(page);
  const values = await page.evaluate(() => window.displayRetirements.map(p => ({ now: p.originalTexts.map(n => n.textContent), atDetach: p.textAtDetach })));
  for (const v of values) { expect(v.atDetach).toHaveLength(1); expect([...v.now,...v.atDetach.flat()].every(t => t === '')).toBe(true); }
}
async function focusFrame(page, fields, head = '5', epoch = head) {
  const batch = f.batch([f.upsert(f.entry({ revision: head, content_epoch: epoch, fields }))], head);
  await page.evaluate(batch => window.displayHarness.push(batch), batch);
  await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().selected.store.observed_head)).toBe(head);
}
const focusSelector = `[data-entry="e:4:0"] [data-field="${f.SECOND}"]`;
for (const name of ['retire preceding', 'retire following', 'metadata only', 'add preceding', 'composer focused', 'focused target disappears', 'invalid schema', 'atomic store conflict', 'backward prepend']) test(`B/C native actual controller focus ${name} keeps accepted order and rejected state atomic`, async ({ page }) => {
  let fields = [focusA,focusB];
  if (name === 'retire following') fields = [{ ...focusB,order_key: f.order(2,0n) },{ ...focusA,order_key: f.order(2,1n) }];
  if (name === 'add preceding') fields = [focusB];
  const first = f.page({ entries: [f.entry({ fields })], previous_block: name === 'backward prepend' ? f.cursor('b','2') : null });
  const older = f.page({ block: f.block({ run_id: f.OTHER, accepted_sequence: '1', human: human('Task A','1',f.OTHER) }), entries: [], live_after: null, previous_block: null });
  const h = await mount(page, first, { holdLayout: true, older: () => older });
  await page.evaluate(() => window.displayHarness.client.setDraft(' exact\n retained draft 雪 '));
  const targetSelector = name === 'focused target disappears' ? `[data-entry="e:4:0"] [data-field="${f.FID}"]` : focusSelector;
  await protectFocus(page, targetSelector, name === 'composer focused');
  const rejected = name === 'invalid schema' || name === 'atomic store conflict';
  const initial = await page.evaluate(() => { const s = window.displayHarness.client.snapshot().selected.store; return { cursor: s.live_after, title: s.session.title }; });
  if (name.startsWith('retire') || name === 'composer focused' || name === 'focused target disappears') await holdOriginalText(page, `[data-entry="e:4:0"] [data-field="${f.FID}"]`);
  if (name === 'backward prepend') await page.evaluate(() => window.displayHarness.client.loadOlder());
  else if (rejected) {
    let batch = f.batch([f.upsert(f.entry({ revision: '5', fields }))]);
    if (name === 'invalid schema') { batch = structuredClone(batch); batch.changes[0].entry.fields[0].to_byte = '0'; }
    else batch = f.batch([{ kind: 'session.upsert',session: f.session('5',{ title: 'must not publish' }) },f.upsert(f.entry({ revision: '5',fields: [focusA,{ ...focusB,text: 'X'+focusB.text.slice(1) }] }))]);
    await page.evaluate(batch => window.displayHarness.push(batch),batch);
    await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().selected.observation)).toBe('disconnected');
    expect(await page.evaluate(() => { const s = window.displayHarness.client.snapshot().selected.store; return { cursor: s.live_after,title: s.session.title }; })).toEqual(initial);
    expect(await h.root.getByLabel('Canonical session title').textContent()).toBe(initial.title);
  } else await focusFrame(page, name === 'metadata only' ? fields : name === 'add preceding' ? [focusA,focusB] : [fields.find(f => f.field_id === focusB.field_id)], '5', name === 'metadata only' ? '4' : '5');
  await focusPreserved(page, name === 'focused target disappears');
  const desired = rejected || name === 'metadata only' ? fields : name === 'add preceding' ? [focusA,focusB] : name === 'backward prepend' ? fields : [fields.find(f => f.field_id === focusB.field_id)];
  expect(await h.transcript.locator('[data-entry="e:4:0"] [data-field]').evaluateAll(nodes => nodes.map(n => n.dataset.field))).toEqual(desired.map(f => f.field_id));
  if (name.startsWith('retire') || name === 'composer focused' || name === 'focused target disappears') await originalTextRetired(page);
  expect(h.posts).toHaveLength(0); expect(h.external).toBe(0); expect(h.admitted).toHaveLength(name === 'backward prepend' ? 1 : 0);
  expect(h.requests.some(p => p.includes('/history') || /\/events\?/.test(p))).toBe(false);
});

test('B/C native valid multi-field SSE reorders reconcile both sides of stationary focused subtree', async ({ page }) => {
  const ids = ['a','b','c','d','e'].map(c => c.repeat(64));
  const original = ids.map((id,i) => focusFragment(id,i,'reasoning_summary'));
  const h = await mount(page, f.page({ entries: [f.entry({ fields: original })], previous_block: null }), { holdLayout: true });
  await page.evaluate(() => window.displayHarness.client.setDraft(' exact\n retained draft 雪 '));
  await protectFocus(page, `[data-entry="e:4:0"] [data-field="${ids[2]}"]`);
  let head = 4;
  for (const permutation of [[4,3,2,1,0],[2,4,0,3,1],[0,4,1,3,2],[4,2,3,0,1],[0,1,2,3,4]]) {
    const fields = permutation.map((i,index) => ({ ...original[i],order_key: f.order(2,BigInt(index)) }));
    await focusFrame(page, fields,String(++head)); await focusPreserved(page);
    expect(await h.transcript.locator('[data-entry="e:4:0"] [data-field]').evaluateAll(nodes => nodes.map(n => n.dataset.field))).toEqual(fields.map(f => f.field_id));
    expect(await page.evaluate(() => window.displayHarness.client.snapshot().selected.observation)).toBe('streaming');
  }
  expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0);
});

test('B/C native actual catalog refresh retires predecessor before focused retained button and stale buttons are inert', async ({ page }) => {
  let entries = [privateCatalog('Removed',f.SID),privateCatalog('Retained',f.OTHER)];
  const h = await mount(page,f.page({ previous_block: null }),{ holdLayout: true,catalog: () => entries });
  await page.evaluate(() => window.displayHarness.client.setDraft(' exact\n retained draft 雪 '));
  await protectFocus(page,'.session-list li:nth-child(2)');
  // Identity lookup must not depend on a retiring sibling's index.
  await page.evaluate(() => { window.focusProof.selector = '.session-list li'; });
  await h.root.locator('.session-list li').first().locator('button').evaluate(n => { n.value = 'removed synthetic value'; });
  await holdOriginalText(page,'#display-test .session-list li:first-child');
  entries = entries.slice(1); await page.evaluate(() => window.displayHarness.client.refreshSessions());
  await focusPreserved(page); await originalTextRetired(page);
  await expect(h.root.locator('.session-list button')).toHaveText('Retained');
  const count = h.requests.length; await clickHeld(page); expect(h.requests).toHaveLength(count);
  expect(await page.evaluate(() => window.displayHarness.navigations)).toEqual([]);
  expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0);
});

test('B/C native explicit command discard and append preserve focused retained retry disclosure and original text retirement', async ({ page }) => {
  const h = await mount(page,f.page({ previous_block: null }),{ holdLayout: true });
  await page.evaluate(async () => { await window.displayHarness.client.renameSession('removed synthetic command'); await window.displayHarness.client.renameSession('retained synthetic command'); window.displayHarness.client.setDraft(' exact\n retained draft 雪 '); });
  await protectFocus(page,'.commands article:nth-child(2)');
  await page.evaluate(() => { window.focusProof.selector = '.commands article'; });
  await holdOriginalText(page,'#display-test .commands article:first-child');
  const baseline = await page.evaluate(() => window.displayHarness.view.listenerCount);
  await page.evaluate(() => window.displayHarness.client.discardCommand(window.displayHarness.client.snapshot().pending[0].command.id));
  await focusPreserved(page); await originalTextRetired(page);
  expect(await page.evaluate(() => window.displayHarness.view.listenerCount)).toBe(baseline-4);
  const count = h.requests.length; await clickHeld(page); expect(h.requests).toHaveLength(count); expect(h.posts).toHaveLength(2);
  await page.evaluate(() => window.displayHarness.client.renameSession('appended synthetic command')); await focusPreserved(page);
  expect(h.posts).toHaveLength(3); expect(await h.root.locator('.commands article h3').allTextContents()).toEqual(['rename: uncertain','rename: uncertain']);
  expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0); expect(await page.evaluate(() => window.displayHarness.navigations)).toEqual([]);
});

for (const scope of ['entry','block']) test(`B/C native synthetic ${scope} permutations protect nested owning row without focus restoration`, async ({ page }) => {
  const h = await mount(page,f.page({ entries: [f.entry({ fields: [focusB] })], previous_block: null }),{ holdLayout: true });
  await page.evaluate(scope => {
    const { client,view } = window.displayHarness; client.setDraft(' exact\n retained draft 雪 ');
    const s = client.snapshot(), store = s.selected.store, b = store.blocks[0], e = b.entries[0];
    let rows;
    if (scope === 'entry') rows = [0,1,2,3,4].map(i => ({ ...e,view: { ...e.view,entry_id: `e:${i+4}:0` } }));
    if (scope === 'block') rows = [0,1,2,3,4].map(i => ({ ...b,view: { ...b.view,run_id: `00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}` } }));
    window.nestedFocus = { s,store,b,e,rows,scope,arrange(ordered) {
      if (scope === 'block') return { ...store,blocks: ordered };
      return { ...store,blocks: [{ ...b,entries: ordered }] };
    } };
    view.render({ ...s,selected: { ...s.selected,store: window.nestedFocus.arrange(rows) } });
  },scope);
  const selector = scope === 'entry' ? '[data-entry="e:6:0"]' : '.transcript article:nth-child(3)';
  await protectFocus(page,selector);
  await page.evaluate(scope => {
    const p = window.focusProof; p.row.dataset.focusControl = 'retained'; p.selector = '[data-focus-control="retained"]';
    window.nestedFocus.nodes = [...p.row.parentElement.children];
  },scope);
  for (const order of [[4,3,2,1,0],[2,4,0,3,1],[0,4,1,3,2],[4,2,3,0,1],[0,1,2,3,4]]) {
    await page.evaluate(order => { const n = window.nestedFocus; window.displayHarness.view.render({ ...n.s,selected: { ...n.s.selected,store: n.arrange(order.map(i => n.rows[i])) } }); },order);
    await focusPreserved(page);
    expect(await page.evaluate(order => { const n = window.nestedFocus,p = window.focusProof; const actual = [...p.row.parentElement.children]; return actual.every((c,i) => c === n.nodes[order[i]]) && actual.length === order.length; },order)).toBe(true);
  }
  expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0);
});

test('B/C native ordered range retirement prepend and metadata preserve stationary selected unchanged PRE', async ({ page }) => {
  const h = await mount(page,f.page({ entries: [f.entry({ fields: [focusB] })],previous_block: null }),{ holdLayout: true });
  await page.evaluate(() => {
    window.displayHarness.client.setDraft(' exact\n retained draft 雪 ');
    const s = window.displayHarness.client.snapshot(), b = s.selected.store.blocks[0], e = b.entries[0];
    const ranges = [0,1,2,3,4].map(i => ({ from_byte: String(i*12),to_byte: String(i*12+8),text: 'retained' }));
    const publish = indices => window.displayHarness.view.render({ ...s,selected: { ...s.selected,store: { ...s.selected.store,blocks: [{ ...b,entries: [{ ...e,fields: [{ ...e.fields[0],total_bytes: '56',ranges: indices.map(i => ranges[i]) }] }] }] } } });
    window.rangeFocus = { publish }; publish([0,1,2,3,4]);
  });
  const selector = '[data-entry="e:4:0"] [data-range="text:24"]';
  await h.root.locator(selector).evaluate(n => { n.tabIndex = 0; });
  await protectFocus(page,selector);
  for (const indices of [[2,3,4],[2,4],[0,1,2,3,4],[0,1,2,3,4]]) {
    await page.evaluate(indices => window.rangeFocus.publish(indices),indices); await focusPreserved(page);
    expect(await h.root.locator('[data-entry="e:4:0"] [data-field] pre').evaluateAll(nodes => nodes.map(n => n.dataset.range))).toEqual(indices.map(i => `text:${i*12}`));
  }
  expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0);
});

test('B/C native actual content replacement removes focused descendant without restoring focus to retained field', async ({ page }) => {
  const h = await mount(page,f.page({ entries: [f.entry({ fields: [focusB] })],previous_block: null }),{ holdLayout: true });
  await page.evaluate(() => window.displayHarness.client.setDraft(' exact\n retained draft 雪 '));
  const selector = `${focusSelector} pre`;
  await h.root.locator(selector).evaluate(n => { n.tabIndex = 0; n.closest('details').open = true; });
  await protectFocus(page,selector); await holdOriginalText(page,'#display-test '+selector);
  await page.evaluate(() => { window.keptField = window.focusProof.row.closest('[data-field]'); });
  const field = f.fragment(focusText.slice(8),8,utf8(focusText),{ field_id: f.SECOND,order_key: focusB.order_key,kind: focusB.kind,generation: '5' });
  const entry = f.entry({ revision: '5',content_epoch: '5',fields: [field],content_complete: false,earlier_content: f.cursor('c',f.RID,'e:4:0','5',f.SECOND,'5','8') });
  await page.evaluate(batch => window.displayHarness.push(batch),f.batch([f.upsert(entry)]));
  await expect.poll(() => page.evaluate(() => window.displayHarness.client.snapshot().selected.store.observed_head)).toBe('5');
  await focusPreserved(page,true); await originalTextRetired(page);
  expect(await page.evaluate(selector => document.querySelector('#display-test '+selector) === window.keptField && window.keptField.open,focusSelector)).toBe(true);
  await expect(h.transcript).toContainText('Missing bytes [0, 8)');
  expect(h.posts).toHaveLength(0); expect(h.admitted).toHaveLength(0); expect(h.external).toBe(0);
});
