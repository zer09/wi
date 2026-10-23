import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { decodeJson } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { answer, data, skillOutput } from '../test-support/presentation.mjs';

const labels = ['short-selected', 'long-selected', 'disconnected-reader'];
const stages = ['startup', 'connect', 'create', 'rename', 'catalog', 'keyboard', 'acceptance', 'partial', 'items', 'tools',
  'final-deltas', 'final-item', 'disconnect-reader', 'completion', 'rebase', 'older', 'abort', 'navigation-seed', 'navigation-selected', 'navigation', 'cleanup'];
const checks = ['outside', 'reply', 'reply-response', 'reply-status', 'reply-body', 'reply-size', 'reply-utf8', 'reply-decode',
  'status', 'identity', 'execution', 'headings', 'fields', 'metadata', 'ids', 'occurrences',
  'receipt', 'native', 'focus', 'disclosure', 'scroll', 'geometry', 'scroll-position', 'relative-anchor', 'aria', 'layout', 'privacy', 'assets', 'requests', 'parity', 'measurement'];
const timingFields = ['latest_ms', 'rebase_ms', 'acceptance_ms', 'result_display_ms'];
const countFields = ['tasks', 'loaded_blocks', 'loaded_entries', 'loaded_fields', 'dom_nodes', 'latest_requests',
  'older_requests', 'stream_requests', 'task_posts', 'status_updates', 'display_proof_requests'];
function measurement(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== ['label', ...timingFields, ...countFields].sort().join(',')
    || !labels.includes(value.label)) throw new Error('Presentation measurement rejected');
  for (const key of timingFields) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 180_000)
    throw new Error('Presentation measurement rejected');
  for (const key of countFields) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000)
    throw new Error('Presentation measurement rejected');
  if (value.display_proof_requests !== value.latest_requests + Number(value.label === 'disconnected-reader'))
    throw new Error('Presentation measurement rejected');
  return { ...value };
}
function fatal(label, stage, check, error) {
  let kind = 'other';
  if (error instanceof TypeError) kind = 'TypeError';
  else if (error instanceof Error) kind = 'Error';
  if (!labels.includes(label)) label = 'unknown';
  if (!stages.includes(stage)) stage = 'unknown';
  if (!checks.includes(check)) check = 'unknown';
  return new Error(`Presentation failed: label=${label}; stage=${stage}; check=${check}; kind=${kind}`);
}
async function exact(locator, value) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === value).toBe(true);
}
async function textOnce(run, value) {
  await expect.poll(() => run.locator('[data-field] pre').evaluateAll((nodes, text) => nodes.filter(node => node.textContent === text).length, value)).toBe(1);
}
const argumentsFor = task => task === 0 ? '{"a":17,\r\n "b":25}' : '{"a":42,\r\n "b":8}';
function richFacts(task, phase) {
  let argumentsText = argumentsFor(task);
  if (phase === 'partial') argumentsText = data.arguments;
  return [['reasoning_summary', data.summary], ['reasoning_text', data.reasoning], ['text', data.text], ['refusal', data.refusal],
    ['function_name', 'add_numbers'], ['function_arguments', argumentsText], ['function_name', 'load_skill'],
    ['function_arguments', '{"id":"project:presentation"}'], ['function_name', 'add_numbers'],
    ['function_arguments', '{"a":9223372036854775807,"b":1}'], ['Unsupported content', 'Unsupported content']];
}
async function fields(entry, facts) {
  // A native pause proves persistence, not that Chromium has rendered the complete fields.
  await expect.poll(async () => isDeepStrictEqual(await entry.locator('[data-field]').evaluateAll(nodes => nodes.map(node =>
    [node.querySelector('summary,h5')?.textContent, ...Array.from(node.querySelectorAll('pre'), pre => pre.textContent)])), facts)).toBe(true);
}
async function richSections(entry, task, phase) {
  await fields(entry, richFacts(task, phase));
  let state = 'Recorded state: in_progress; Provisional: true';
  if (phase === 'authoritative') state = 'Recorded state: completed; Provisional: false';
  await exact(entry.locator(':scope > .metadata').first(), state);
  for (const key of ['text', 'refusal', 'summary', 'reasoning']) await textOnce(entry, data[key]);
  await textOnce(entry, 'Unsupported content');
  if (phase !== 'partial') expect((await entry.textContent()).includes(data.arguments)).toBe(false);
}
async function answerSection(entry, task, completed) {
  await fields(entry, [['text', answer(task)]]);
  let state = 'Recorded state: in_progress; Provisional: true';
  if (completed) state = 'Recorded state: completed; Provisional: false';
  await exact(entry.locator(':scope > .metadata').first(), state);
  await textOnce(entry, answer(task));
}
async function keyboardFocus(page, locator) {
  await expect(locator).toBeVisible(); await expect(locator).toBeEnabled();
  await locator.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(locator).toBeFocused();
  expect(await locator.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none')).toBe(true);
}
async function activate(page, locator) { await keyboardFocus(page, locator); await page.keyboard.press('Enter'); }
async function layout(page, viewport) {
  expect(isDeepStrictEqual(page.viewportSize(), viewport)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('.transcript pre').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
}
async function inert(page) {
  expect(await page.evaluate(() => {
    const content = document.querySelector('.layout');
    return globalThis.wiCanary === undefined
      && content.querySelectorAll('script,img,a,iframe,object,embed,svg,math,link,style,audio,video,source').length === 0
      && Array.from(content.querySelectorAll('*')).every(node => Array.from(node.attributes).every(attribute =>
        !/^on/i.test(attribute.name) && !['src', 'href', 'srcdoc'].includes(attribute.name)))
      && document.querySelectorAll('script').length === 1 && document.querySelector('script').getAttribute('src') === '/assets/app.js';
  })).toBe(true);
}
async function frames(page) {
  // Let layout settle at a fixed boundary, never wait for geometry to pass.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
function geometry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'anchor_y,overflow,scroll_top') throw new Error('Presentation geometry rejected');
  for (const key of ['scroll_top', 'anchor_y', 'overflow']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key])
    || Math.abs(value[key]) > 1_000_000) throw new Error('Presentation geometry rejected');
  if (value.scroll_top < 0 || value.overflow < 0) throw new Error('Presentation geometry rejected');
  return { ...value };
}
async function position(entry) {
  return geometry(await entry.evaluate(node => {
    const transcript = node.closest('.transcript');
    if (!transcript) throw new Error('Presentation geometry rejected');
    const scrollTop = transcript.scrollTop, entryTop = node.getBoundingClientRect().top, transcriptTop = transcript.getBoundingClientRect().top;
    const height = transcript.scrollHeight, clientHeight = transcript.clientHeight;
    for (const value of [scrollTop, entryTop, transcriptTop, height, clientHeight]) if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Presentation geometry rejected');
    // The renderer preserves the entry within the transcript, not within the document.
    return { scroll_top: scrollTop, anchor_y: entryTop - transcriptTop, overflow: height - clientHeight };
  }));
}
function positionDelta(baseline, current) {
  baseline = geometry(baseline); current = geometry(current);
  const delta = { scroll_delta: current.scroll_top - baseline.scroll_top, anchor_delta: current.anchor_y - baseline.anchor_y };
  for (const value of Object.values(delta)) if (!Number.isFinite(value) || Math.abs(value) > 1_000_000)
    throw new Error('Presentation geometry rejected');
  return delta;
}
async function bottom(transcript) {
  await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
}
async function normalized(run) {
  return run.evaluate(node => { const clone = node.cloneNode(true); for (const details of clone.querySelectorAll('details')) details.removeAttribute('open'); return clone.outerHTML; });
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
// One case, three real fixtures and four explicit Tasks. Reader loss replaces the old debugger suspension.
test('real presentation display, private boundary and finite measurements', async ({ browser }) => {
  test.setTimeout(180_000);
  const executable = await discoverFixture();
  const measurements = [];
  for (const label of labels) {
    const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
    let fixture; let context; let failure; let liveObserver; let stableDetail;
    let stage = 'startup'; let check = 'outside';
    const cleanup = { context: false, fixture: false };
    const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
    const observed = { latest: 0, older: 0, streams: 0, taskPosts: 0, statusUpdates: 0, designatedAbort: 0, abortDiagnostic: 0 };
    try {
      process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
      fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, presentation: true });
      let viewport = { width: 1440, height: 900 };
      if (label === 'short-selected') viewport = { width: 360, height: 800 };
      let taskCount = 1;
      if (label === 'long-selected') taskCount = 2;
      context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const files = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/assets/wi.css', 'style.css'],
        ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
      const markers = ['synthetic-replay-', 'private-operator-', 'private-project-', 'private-skill-', 'private-support-',
        'private-native', 'private-data', 'private-skills', 'private-config-canary', 'principal_digest', 'history_digest',
        'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
      const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
      const assets = new Set(); const assetReads = []; const requests = []; const handshakes = []; const snapshotRequests = [];
      const commands = []; const receipts = []; let sid; let snapshotResponse; let abortedRequest; let displayProofRequests = 0;
      let acceptanceStart; let acceptanceMs; let latestMs; let rebaseMs; let visibilityMs;
      await context.route('**/*', async route => {
        try {
          if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
          else await route.continue();
        } catch { faults.collector++; }
      });
      context.on('request', request => {
        try {
          const url = new URL(request.url()), method = request.method();
          requests.push({ method, path: url.pathname, search: url.search });
          if (url.origin !== fixture.origin) faults.external++;
          if (leaked(request.url())) faults.private++;
          if (url.pathname.startsWith('/v1/')) {
            const headers = request.headers();
            if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
              || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
            const allowed = method === 'GET' && (url.pathname === '/v1/settings' || url.pathname === '/v1/sessions'
              || (typeof sid === 'string' && url.pathname === `/v1/sessions/${sid}` && url.search === '')
              || /^\/v1\/sessions\/[0-9a-f-]{36}\/conversation(?:\/events|\/content|\/entries\/[0-9a-f-]{36}\/e:[0-9]+:[0-9]+)?$/.test(url.pathname))
              || method === 'POST' && (url.pathname === '/v1/sessions' || url.pathname === `/v1/sessions/${sid}/runs`
                || url.pathname === `/v1/sessions/${sid}/rename` || url.pathname === `/v1/sessions/${sid}/refresh`);
            if (!allowed) faults.request++;
          } else if (method !== 'GET' || !files.has(url.pathname) || url.search !== '') faults.request++;
          if (method === 'GET' && url.pathname.endsWith('/conversation')) {
            if (url.search === '') observed.latest++;
            else observed.older++;
          }
          // Keep framework identities private so an old same-URL reply cannot prove a new selection.
          if (method === 'GET' && url.origin === fixture.origin && url.search === ''
            && /^\/v1\/sessions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/conversation$/.test(url.pathname))
            snapshotRequests.push({ request, index: requests.length - 1, origin: url.origin, path: url.pathname, search: url.search });
          if (method === 'GET' && /\/conversation\/(content|entries\/)/.test(url.pathname)) observed.older++;
          if (method === 'GET' && url.pathname.endsWith('/conversation/events')) {
            observed.streams++;
            handshakes.push({ request, response: snapshotResponse, index: requests.length - 1, origin: url.origin, path: url.pathname, search: url.search });
          }
          if (method === 'POST' && url.pathname.endsWith('/runs')) {
            observed.taskPosts++;
            const body = request.postDataJSON();
            if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || body.text !== data.user) faults.request++;
            commands.push(structuredClone(body));
          }
        } catch { faults.collector++; }
      });
      context.on('response', response => {
        try {
          const url = new URL(response.url());
          if (url.pathname.endsWith('/conversation') && url.search === '') snapshotResponse = response;
          const file = files.get(url.pathname);
          if (response.status() >= 300) faults.response++;
          if (file === undefined) return;
          assetReads.push((async () => {
            const bytes = await response.body();
            if (response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.response++;
            if (leaked(bytes.toString('utf8'))) faults.private++;
            assets.add(new URL(response.url()).pathname);
          })().catch(() => { faults.collector++; }));
        } catch { faults.collector++; }
      });
      const page = await context.newPage();
      page.on('console', message => {
        try {
          // Only the one designated failed observation request may produce a network diagnostic.
          const location = message.location();
          if (message.type() === 'error' && message.text() === 'Failed to load resource: net::ERR_FAILED'
            && abortedRequest !== undefined && location.url === abortedRequest.url() && observed.abortDiagnostic === 0) observed.abortDiagnostic++;
          else faults.console++;
          if (leaked(message.text()) || leaked(location.url)) faults.private++;
        } catch { faults.collector++; }
      });
      page.on('pageerror', () => { faults.page++; });
      const button = name => page.getByRole('button', { name, exact: true });
      const taskField = page.getByLabel('Task', { exact: true });
      const token = page.getByLabel('Owner token', { exact: true });
      const workspace = page.getByRole('combobox', { name: 'Workspace', exact: true });
      const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
      const header = page.getByRole('heading', { name: 'Canonical session title', exact: true });
      const status = page.locator('.topbar [role="status"]');
      const title = `${data.title}\nrenamed`;
      async function readReply(response, statusCode, validate) {
        check = 'reply-status'; expect(response.status() === statusCode).toBe(true);
        check = 'reply-body'; const bytes = await response.body();
        check = 'reply-size'; expect(bytes.length <= 512 * 1024).toBe(true);
        check = 'reply-utf8'; const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        check = 'reply-decode'; return decodeJson(body, response.headers()['content-type'], validate);
      }
      async function boundary() {
        check = 'privacy';
        const safe = await page.evaluate(async ({ owner, markers }) => {
          const dom = document.documentElement.cloneNode(true);
          // Only validated public field attributes are exempt, and only in this detached clone.
          for (const field of dom.querySelectorAll('[data-field]')) {
            const id = field.getAttribute('data-field');
            if (!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return false;
            field.removeAttribute('data-field');
          }
          const values = [dom.outerHTML, location.href, JSON.stringify(history.state),
            ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
          return globalThis.wiCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
            && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
            && (await navigator.serviceWorker.getRegistrations()).length === 0
            && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
        }, { owner: fixture.owner, markers });
        expect(safe && (await context.cookies()).length === 0).toBe(true);
        await inert(page);
      }
      async function latest(action, streaming = true, expectedSid = sid) {
        const start = performance.now(), requestMark = requests.length, snapshotMark = snapshotRequests.length;
        const streamMark = handshakes.length, latestMark = observed.latest, streamCount = observed.streams, abortMark = observed.designatedAbort;
        check = 'reply-response';
        const [reply] = await Promise.all([
          page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.origin === fixture.origin && url.search === '' && response.request().method() === 'GET'
              && snapshotRequests.slice(snapshotMark).some(value => value.request === response.request() && value.path === url.pathname);
          }), action(),
        ]);
        check = 'reply-status'; expect(reply.status() === 200).toBe(true);
        const url = new URL(reply.url()), selectedSid = url.pathname.split('/')[3];
        check = 'identity';
        if (expectedSid === null) expect(stage === 'navigation-seed').toBe(true);
        else expect(selectedSid === expectedSid && expectedSid === sid).toBe(true);
        check = 'status';
        if (streaming) await exact(status, 'connected; observation: streaming');
        else await expect(status).toContainText('observation: disconnected');
        // Wait only for arrival. A wrong cursor or a duplicate stream fails immediately afterward.
        check = 'requests'; await expect.poll(() => handshakes.length > streamMark).toBe(true);
        const snapshot = snapshotRequests[snapshotMark], handshake = handshakes[streamMark];
        expect(snapshotRequests.length === snapshotMark + 1 && observed.latest === latestMark + 1
          && handshakes.length === streamMark + 1 && observed.streams === streamCount + 1
          && snapshot.index >= requestMark && snapshot.request === reply.request() && snapshotResponse === reply
          && !snapshotRequests.slice(0, snapshotMark).some(value => value.request === snapshot.request)
          && snapshot.origin === url.origin && snapshot.path === url.pathname && snapshot.search === '' && snapshot.request.url() === url.href
          && handshake.index > snapshot.index && handshake.response === reply && handshake.origin === fixture.origin
          && !handshakes.slice(0, streamMark).some(value => value.request === handshake.request)
          && handshake.request.method() === 'GET' && handshake.path === `${url.pathname}/events`
          && handshake.request.url() === `${url.href}/events${handshake.search}`).toBe(true);
        const after = new URLSearchParams(handshake.search).get('after');
        const cursor = parseDisplayCursor(after, 'live', selectedSid);
        expect(cursor.rank === '3' && cursor.run_id === '' && cursor.entry_id === ''
          && handshake.search === `?after=${encodeURIComponent(after)}`).toBe(true);
        if (!streaming) expect(abortedRequest === handshake.request && observed.designatedAbort === abortMark + 1).toBe(true);
        const ms = performance.now() - start;
        // The app installed its snapshot before issuing this stream. Observe the same server representation at that exact H.
        const proofInit = { method: 'GET', headers: { Authorization: `Bearer ${fixture.owner}`, Accept: 'application/json' },
          credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) };
        check = 'reply-response'; displayProofRequests++;
        const proof = await fetch(url.href, proofInit);
        check = 'reply-status'; expect(proof.status === 200).toBe(true);
        check = 'reply-body'; const bytes = await proof.arrayBuffer();
        check = 'reply-size'; expect(bytes.byteLength <= 512 * 1024).toBe(true);
        check = 'reply-utf8'; const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        check = 'reply-decode'; const value = decodeJson(body, proof.headers.get('content-type'), v => validateConversationPage(v, { kind: 'latest' }, selectedSid));
        check = 'identity'; expect(value.snapshot_head === cursor.sequence && value.live_after === after).toBe(true);
        check = 'requests'; expect(snapshotRequests.length === snapshotMark + 1 && observed.latest === latestMark + 1
          && handshakes.length === streamMark + 1 && observed.streams === streamCount + 1
          && snapshotRequests[snapshotMark] === snapshot && snapshot.request === reply.request() && snapshotResponse === reply
          && handshakes[streamMark] === handshake && handshake.response === reply
          && (streaming || (abortedRequest === handshake.request && observed.designatedAbort === abortMark + 1))).toBe(true);
        handshake.matching = true;
        return { value, ms };
      }
      async function stablePosition(entry, baseline) {
        await frames(page); check = 'geometry';
        const delta = positionDelta(baseline, await position(entry));
        console.log(`Presentation geometry: label=${label}; stage=${stage}; scroll_delta=${delta.scroll_delta}; anchor_delta=${delta.anchor_delta}`);
        check = 'scroll-position'; expect(Math.abs(delta.scroll_delta) <= 2).toBe(true);
        check = 'relative-anchor'; expect(Math.abs(delta.anchor_delta) <= 2).toBe(true);
      }
      async function chronology(run, names, previous = []) {
        check = 'headings'; await expect.poll(async () => isDeepStrictEqual(await run.locator('.entry > h4').allTextContents(), names)).toBe(true);
        check = 'ids'; const ids = await run.locator('.entry').evaluateAll(nodes => nodes.map(node => node.dataset.entry));
        expect(new Set(ids).size === ids.length && ids.every(id => /^e:[1-9][0-9]*:(0|[1-9][0-9]*)$/.test(id))).toBe(true);
        expect(isDeepStrictEqual(ids.slice(0, previous.length), previous)).toBe(true);
        const positions = ids.map(id => id.split(':').slice(1).map(BigInt));
        expect(positions.every(([seq, slot], index) => index === 0 || seq > positions[index - 1][0]
          || (seq === positions[index - 1][0] && slot > positions[index - 1][1]))).toBe(true);
        return ids;
      }
      async function completed(run, task) {
        check = 'identity'; expect(await run.getAttribute('data-run') === commands[task].run_id).toBe(true);
        check = 'execution'; await exact(run.locator(':scope > .metadata'), 'Execution: completed. Final result recorded.');
        await chronology(run, ['Human', 'assistant', 'tool', 'tool', 'tool', 'assistant']);
        const entries = run.locator('.entry');
        check = 'fields'; await fields(entries.nth(0), [['text', data.user]]);
        check = 'metadata'; await exact(entries.nth(0).locator(':scope > .metadata').first(), 'Recorded state: accepted; Provisional: false');
        expect(await entries.nth(0).getAttribute('data-entry') === `e:${receipts[task].first_sequence}:0`).toBe(true);
        check = 'fields'; await richSections(entries.nth(1), task, 'authoritative');
        for (let slot = 0; slot < 3; slot++) {
          let name = 'add_numbers'; let output = '{"error":{"code":"gateway_error"}}'; let isError = true;
          if (slot === 0) { output = task === 0 ? '{"sum":42}' : '{"sum":50}'; isError = false; }
          if (slot === 1) { name = 'load_skill'; output = skillOutput; isError = false; }
          check = 'fields'; await fields(entries.nth(slot + 2), [['tool_name', name], ['tool_result', output]]);
          check = 'metadata'; await exact(entries.nth(slot + 2).locator(':scope > .metadata').first(),
            `Recorded state: ${isError ? 'failed' : 'completed'}; Provisional: false; result_recorded: true; finish_recorded: true; is_error: ${isError}`);
          check = 'occurrences'; await textOnce(run, output);
        }
        check = 'fields'; await answerSection(entries.nth(5), task, true);
        check = 'occurrences'; await textOnce(run, answer(task));
        expect((await run.textContent()).includes('Provisional: true')).toBe(false);
        const recording = run.locator(':scope > details > pre');
        const requestId = (await recording.textContent()).split('\n').find(line => line.startsWith('last_request_id: '))?.slice('last_request_id: '.length);
        check = 'identity'; expect(typeof requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)
          && requestId !== '00000000-0000-0000-0000-000000000000').toBe(true);
        check = 'metadata'; await exact(recording, `Run: ${commands[task].run_id}\nAccepted sequence: ${receipts[task].first_sequence}\nOutcome: completed\nEvents complete: true\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 3\ntool_results_prepared: 3\nreused_results: 0\nlast_request_id: ${requestId}\nlast_upstream_outcome: terminal_received`);
      }
      stage = 'connect'; await page.goto(`${fixture.origin}/`);
      await page.evaluate(async () => { await (await fetch('/index.html', { credentials: 'omit', cache: 'no-store', redirect: 'error' })).text(); });
      await keyboardFocus(page, token); await token.fill('private-config-canary'); await activate(page, button('Connect'));
      await expect(token).toHaveValue(''); await expect(page.locator('main > .error')).not.toBeEmpty(); await boundary();
      await token.fill(fixture.owner); await activate(page, button('Connect')); await expect(token).toHaveValue('');
      await exact(status, 'connected'); await boundary(); expect((await fixture.inspect()).requests).toBe(0);
      stage = 'create'; const titleField = page.getByLabel('Title', { exact: true });
      await keyboardFocus(page, titleField); await titleField.fill(data.title); await keyboardFocus(page, workspace);
      await activate(page, button('Create session')); await expect(page.locator('.commands')).toContainText('Accepted receipt (not completion)');
      // The actual create receipt selects the new canonical session; IDs never enter diagnostics.
      const createText = await page.locator('.command > pre').first().textContent();
      sid = createText.split('\n').find(line => line.startsWith('Session: ')).slice('Session: '.length);
      const initial = await latest(() => activate(page, button('Open receipt session'))); latestMs = initial.ms;
      expect(initial.value.snapshot_head === '1' && initial.value.block === null).toBe(true);
      await exact(header, data.title); await fixture.request({ command: 'select', session_id: sid });
      await expect(transcript.locator('.run')).toHaveCount(0);
      stage = 'rename'; const renamed = page.getByLabel('Exact new title', { exact: true });
      await keyboardFocus(page, renamed); await renamed.fill(title); await activate(page, button('Rename session')); await exact(header, title);
      stage = 'catalog'; await activate(page, button('Refresh selected catalog entry'));
      await expect(page.locator('.commands')).toContainText('Catalog refresh:');
      await expect(button('Refresh selected catalog entry')).toBeEnabled();
      await expect(page.locator('.command > h3')).toHaveText(['create: accepted', 'rename: accepted', 'refresh: accepted']);
      await activate(page, button('Refresh list')); await expect(button('Refresh list')).toBeEnabled();
      await exact(page.locator('aside > .metadata'), 'Catalog observation loaded.');
      const choice = page.locator('.session-list button').filter({ hasText: 'title 雪' }); await expect(choice).toHaveCount(1);
      check = 'identity'; await expect(choice).toHaveAttribute('aria-current', 'true');
      expect(await page.evaluate(() => location.hash) === `#session=${sid}`).toBe(true);
      const selectedMetadata = page.locator('.conversation > .metadata');
      await exact(selectedMetadata, `Workspace: ${initial.value.session.workspace}\nSession: ${sid}`);
      await exact(header, title); check = 'status'; await exact(status, 'connected; observation: streaming');
      await expect(transcript.locator('.run')).toHaveCount(0); await frames(page);
      const catalogMark = { requests: requests.length, snapshots: snapshotRequests.length, streams: handshakes.length,
        proofs: displayProofRequests, observed: { ...observed } };
      const catalogStream = handshakes.at(-1), catalogSnapshot = snapshotResponse;
      const catalogDraft = await taskField.inputValue(), catalogCommands = await page.locator('.commands').textContent();
      const catalogTranscript = await transcript.textContent();
      // The selected catalog choice runs the real hash guard. It must not restart observation.
      await activate(page, choice); await frames(page);
      check = 'requests'; expect(requests.length === catalogMark.requests && snapshotRequests.length === catalogMark.snapshots
        && handshakes.length === catalogMark.streams && displayProofRequests === catalogMark.proofs
        && isDeepStrictEqual(observed, catalogMark.observed) && handshakes.at(-1) === catalogStream
        && catalogStream.matching === true && snapshotResponse === catalogSnapshot).toBe(true);
      check = 'identity'; await expect(choice).toHaveAttribute('aria-current', 'true');
      expect(await page.evaluate(() => location.hash) === `#session=${sid}`).toBe(true);
      await exact(selectedMetadata, `Workspace: ${initial.value.session.workspace}\nSession: ${sid}`); await exact(header, title);
      check = 'status'; await exact(status, 'connected; observation: streaming');
      await expect(taskField).toHaveValue(catalogDraft); await exact(page.locator('.commands'), catalogCommands);
      await exact(transcript, catalogTranscript); await expect(transcript.locator('.run')).toHaveCount(0);
      check = 'layout'; await layout(page, viewport); await boundary();
      stage = 'keyboard'; await keyboardFocus(page, taskField); await taskField.fill('keyboard'); await taskField.press('End');
      await taskField.press('Enter'); await expect(taskField).toHaveValue('keyboard\n'); expect(observed.taskPosts).toBe(0);
      await keyboardFocus(page, button('Send')); await expect(button('Cancel current run')).toBeVisible(); await expect(button('Cancel current run')).toBeDisabled();
      await keyboardFocus(page, button('Reconnect latest'));
      for (let task = 0; task < taskCount; task++) {
        const gate = task * 6 + 1;
        stage = 'acceptance'; await fixture.request({ command: 'arm_acceptance' }); await taskField.fill(data.user);
        acceptanceStart = performance.now();
        if (label === 'long-selected' && task === 0) await activate(page, button('Send'));
        else await taskField.press(task === 1 ? 'Meta+Enter' : 'Control+Enter');
        await fixture.request({ command: 'wait_acceptance' }); await taskField.press(task === 1 ? 'Meta+Enter' : 'Control+Enter');
        await expect(button('Send')).toBeDisabled(); expect(observed.taskPosts).toBe(task + 1);
        expect((await fixture.inspect()).accepted.length).toBe(task);
        check = 'reply-response'; const acceptedReply = page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST');
        await fixture.request({ command: 'release_acceptance' });
        const acceptance = await readReply(await acceptedReply, 202, v => validateDisplayTaskAccepted(v, { ...commands[task], session_id: sid }));
        receipts.push(acceptance.receipt); acceptanceMs = performance.now() - acceptanceStart;
        await fixture.wait('model_paused', gate); const acceptedProof = await fixture.inspect();
        check = 'receipt'; expect(isDeepStrictEqual(receipts[task], acceptedProof.receipts[task])).toBe(true);
        expect(receipts[task].operation_id === commands[task].operation_id && receipts[task].run_id === commands[task].run_id).toBe(true);
        const run = transcript.locator(`.run[data-run="${commands[task].run_id}"]`);
        check = 'fields'; await fields(run.locator('.entry').first(), [['text', data.user]]);
        await keyboardFocus(page, button('Cancel current run')); expect(requests.some(r => r.path.endsWith('/cancel'))).toBe(false);
        stage = 'partial'; await fixture.request({ command: 'drive', gate }); await fixture.wait('model_paused', gate + 1);
        const entries = run.locator('.entry'); let ids = await chronology(run, ['Human', 'assistant']);
        check = 'fields'; await richSections(entries.nth(1), task, 'partial');
        const provisional = await fixture.inspect();
        check = 'native'; expect(isDeepStrictEqual([provisional.tool_results, provisional.response_finishes.length, provisional.requests], [task * 3, task * 2, task * 2 + 1])).toBe(true);
        stage = 'rebase'; const partialLive = await normalized(run); const partial = await latest(() => activate(page, button('Reconnect latest')));
        expect(partial.value.snapshot_head === provisional.sequence_count).toBe(true);
        check = 'fields'; await richSections(entries.nth(1), task, 'partial');
        check = 'parity'; expect((await normalized(run)) === partialLive).toBe(true);
        const detail = entries.nth(1).locator('details[data-field]').filter({ has: page.getByText('reasoning_summary', { exact: true }) });
        await activate(page, detail.locator('summary')); stableDetail = await detail.elementHandle();
        const draft = '  unsent composer 雪\nkeep focus and value  ';
        await taskField.fill(draft); await taskField.focus();
        await transcript.evaluate(node => { node.scrollTop = 0; });
        await frames(page); check = 'geometry';
        const baseline = await position(entries.first());
        check = 'scroll-position'; expect(baseline.scroll_top === 0 && baseline.overflow > 64).toBe(true);
        await boundary();
        stage = 'items'; await fixture.request({ command: 'drive', gate: gate + 1 }); await fixture.wait('model_paused', gate + 2);
        check = 'fields'; await richSections(entries.nth(1), task, 'items');
        check = 'native'; await expect.poll(async () => (await fixture.inspect()).sequence_count === (BigInt(provisional.sequence_count) + 6n).toString()).toBe(true);
        const itemsFinished = await fixture.inspect();
        expect(isDeepStrictEqual([itemsFinished.tool_results, itemsFinished.response_finishes.length, itemsFinished.requests], [task * 3, task * 2, task * 2 + 1])).toBe(true);
        check = 'focus'; await expect(taskField).toBeFocused(); await expect(taskField).toHaveValue(draft);
        check = 'disclosure'; expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
        await stablePosition(entries.first(), baseline);
        await boundary();
        stage = 'tools'; await fixture.request({ command: 'drive', gate: gate + 2 }); await fixture.wait('model_paused', gate + 3);
        ids = await chronology(run, ['Human', 'assistant', 'tool', 'tool', 'tool'], ids);
        check = 'fields'; await richSections(entries.nth(1), task, 'authoritative');
        for (let slot = 0; slot < 3; slot++) {
          let name = 'add_numbers'; let output = '{"error":{"code":"gateway_error"}}'; let isError = true;
          if (slot === 0) { output = task === 0 ? '{"sum":42}' : '{"sum":50}'; isError = false; }
          if (slot === 1) { name = 'load_skill'; output = skillOutput; isError = false; }
          check = 'fields'; await fields(entries.nth(slot + 2), [['tool_name', name], ['tool_result', output]]);
          check = 'metadata'; await exact(entries.nth(slot + 2).locator(':scope > .metadata').first(),
            `Recorded state: ${isError ? 'failed' : 'completed'}; Provisional: false; result_recorded: true; finish_recorded: true; is_error: ${isError}`);
          check = 'occurrences'; await textOnce(run, output);
        }
        check = 'focus'; await expect(taskField).toBeFocused(); await expect(taskField).toHaveValue(draft);
        check = 'disclosure'; expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
        await stablePosition(entries.first(), baseline);
        await expect(button('New content')).toBeVisible(); await activate(page, button('New content')); await bottom(transcript);
        await expect(button('New content')).toBeHidden(); await taskField.focus(); await boundary();
        check = 'aria'; expect(await transcript.locator('[aria-live],[role="status"],[role="alert"]').count()).toBe(0);
        expect(await page.locator('[role="alert"],[aria-live="assertive"]').count()).toBe(0);
        expect(await page.locator('[aria-live]').evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-live') === 'polite'))).toBe(true);
        // This handle owns only a local public-DOM observer. It never captures the app or client store.
        liveObserver = await page.evaluateHandle(() => {
          let count = 0;
          const observer = new MutationObserver(records => { count += records.length; });
          for (const node of document.querySelectorAll('[role="status"],[aria-live]')) observer.observe(node, { childList: true, characterData: true, subtree: true });
          return { read: () => count, dispose: () => observer.disconnect() };
        });
        stage = 'final-deltas'; await fixture.request({ command: 'drive', gate: gate + 3 }); await fixture.wait('model_paused', gate + 4);
        await chronology(run, ['Human', 'assistant', 'tool', 'tool', 'tool', 'assistant'], ids);
        check = 'fields'; await answerSection(entries.nth(5), task, false); const answerDeltas = await fixture.inspect();
        stage = 'final-item'; await fixture.request({ command: 'drive', gate: gate + 4 }); await fixture.wait('model_paused', gate + 5);
        check = 'native'; await expect.poll(async () => (await fixture.inspect()).sequence_count === (BigInt(answerDeltas.sequence_count) + 1n).toString()).toBe(true);
        check = 'fields'; await answerSection(entries.nth(5), task, false);
        expect((await fixture.inspect()).response_finishes.length).toBe(task * 2 + 1);
        check = 'focus'; await expect(taskField).toBeFocused(); await expect(taskField).toHaveValue(draft);
        check = 'disclosure'; expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
        check = 'scroll'; await bottom(transcript);
        check = 'aria'; const updates = await liveObserver.evaluate(value => { value.dispose(); return value.read(); });
        expect(updates <= 2).toBe(true); observed.statusUpdates += updates; await liveObserver.dispose(); liveObserver = undefined;
        if (label === 'disconnected-reader') {
          stage = 'disconnect-reader'; await activate(page, button('Disconnect'));
          await expect(taskField).toHaveValue(''); await expect(page.locator('.run,.command')).toHaveCount(0); await expect(token).toBeVisible();
          await boundary(); const before = requests.length;
          await fixture.request({ command: 'drive', gate: gate + 5 }); await fixture.wait('task_finished', task + 1);
          const committedStart = performance.now(); const committed = await fixture.inspect();
          // Actual authenticated Latest proves recorded completion with no browser observer or Cancel.
          const proofInit = {
            headers: { Authorization: `Bearer ${fixture.owner}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
          };
          displayProofRequests++;
          const reply = await fetch(`${fixture.origin}/v1/sessions/${sid}/conversation`, proofInit);
          expect(reply.status === 200).toBe(true);
          const value = decodeJson(await reply.text(), reply.headers.get('content-type'), v => validateConversationPage(v, { kind: 'latest' }, sid));
          expect(value.snapshot_head === committed.sequence_count && value.block.run_id === commands[task].run_id
            && value.block.state === 'completed' && value.block.result_recorded && value.entries.at(-1).fields[0].text === answer(task)).toBe(true);
          expect(requests.length === before).toBe(true);
          await token.fill(fixture.owner); await latest(() => activate(page, button('Connect')));
          await completed(run, task); visibilityMs = performance.now() - committedStart;
          await expect(taskField).toHaveValue(''); await expect(page.locator('.command')).toHaveCount(0);
        } else {
          stage = 'completion'; await fixture.request({ command: 'drive', gate: gate + 5 }); await fixture.wait('task_finished', task + 1);
          const committedStart = performance.now(); await completed(run, task); visibilityMs = performance.now() - committedStart;
          check = 'focus'; await expect(taskField).toBeFocused(); await expect(taskField).toHaveValue(draft);
          check = 'disclosure'; expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
          check = 'scroll'; await bottom(transcript);
        }
        await stableDetail.dispose(); stableDetail = undefined;
        const finished = await fixture.inspect();
        check = 'native'; expect(isDeepStrictEqual([finished.tool_results, finished.requests, finished.results, finished.provider_failed, finished.read_failure], [(task + 1) * 3, (task + 1) * 2, task + 1, false, null])).toBe(true);
        await expect(button('Cancel current run')).toBeDisabled(); check = 'layout'; await layout(page, viewport); await boundary();
      }
      const finished = await fixture.inspect(); const newest = taskCount - 1;
      const run = transcript.locator(`.run[data-run="${commands[newest].run_id}"]`);
      const live = await normalized(run); const draftBefore = await taskField.inputValue();
      const commandBefore = await page.locator('.commands').textContent(); const olderBefore = observed.older;
      stage = 'rebase'; const saved = await latest(() => activate(page, button('Reconnect latest'))); rebaseMs = saved.ms;
      expect(saved.value.snapshot_head === finished.sequence_count && saved.value.block.run_id === commands[newest].run_id).toBe(true);
      await completed(run, newest); check = 'parity'; expect((await normalized(run)) === live).toBe(true);
      await expect(transcript.locator('.run')).toHaveCount(1); expect(observed.older === olderBefore).toBe(true);
      await expect(taskField).toHaveValue(draftBefore); expect((await page.locator('.commands').textContent()) === commandBefore).toBe(true);
      if (taskCount === 2) {
        stage = 'older'; expect(saved.value.previous_block !== null).toBe(true);
        const anchor = run.locator('.entry').first();
        await transcript.evaluate((node, id) => { const row = node.querySelector(`[data-run="${id}"] .entry`); node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top; }, commands[newest].run_id);
        const y = await anchor.evaluate(node => node.getBoundingClientRect().top - node.closest('.transcript').getBoundingClientRect().top);
        await activate(page, button('Load older')); await expect(transcript.locator('.run')).toHaveCount(2);
        check = 'requests'; expect(observed.older === olderBefore + 1).toBe(true);
        expect(requests.filter(r => r.path.endsWith('/conversation') && r.search !== '').at(-1).search === `?before=${encodeURIComponent(saved.value.previous_block)}`).toBe(true);
        check = 'scroll'; expect(Math.abs((await anchor.evaluate(node => node.getBoundingClientRect().top - node.closest('.transcript').getBoundingClientRect().top)) - y) <= 2).toBe(true);
        check = 'identity'; expect(isDeepStrictEqual(await transcript.locator('.run').evaluateAll(nodes => nodes.map(node => node.dataset.run)), commands.map(c => c.run_id))).toBe(true);
        await completed(transcript.locator('.run').first(), 0); await completed(run, 1);
      }
      check = 'measurement'; measurements.push(measurement({ label, latest_ms: latestMs, rebase_ms: rebaseMs, acceptance_ms: acceptanceMs,
        result_display_ms: visibilityMs, tasks: taskCount, loaded_blocks: await transcript.locator('.run').count(),
        loaded_entries: await transcript.locator('.entry').count(), loaded_fields: await transcript.locator('[data-field]').count(),
        dom_nodes: await transcript.locator('*').count(), latest_requests: observed.latest, older_requests: observed.older,
        stream_requests: observed.streams, task_posts: observed.taskPosts, status_updates: observed.statusUpdates,
        display_proof_requests: displayProofRequests }));
      stage = 'abort'; const interrupt = '**/conversation/events?*';
      await context.route(interrupt, async route => {
        try {
          const url = new URL(route.request().url());
          if (url.origin !== fixture.origin || url.pathname !== `/v1/sessions/${sid}/conversation/events` || observed.designatedAbort !== 0) faults.request++;
          abortedRequest = route.request(); observed.designatedAbort++; await route.abort();
        } catch { faults.collector++; }
      }, { times: 1 });
      await latest(() => activate(page, button('Reconnect latest')), false);
      await expect(status).toContainText('observation: disconnected'); await context.unroute(interrupt);
      await latest(() => activate(page, button('Reconnect latest'))); await completed(run, newest);
      expect(observed.designatedAbort === 1 && observed.abortDiagnostic <= 1).toBe(true);
      stage = 'navigation-seed'; const seed = await latest(() => activate(page, button('Fixture barrier seed')), true, null);
      expect(seed.value.session.title === 'Fixture barrier seed' && seed.value.block === null && seed.value.entries.length === 0).toBe(true);
      await expect(transcript.locator('.run')).toHaveCount(0);
      stage = 'navigation-selected'; await latest(() => activate(page, choice)); await completed(run, newest); await exact(header, title);
      stage = 'navigation';
      check = 'layout'; await layout(page, viewport); await boundary(); await Promise.all(assetReads);
      check = 'assets'; expect(assets.size).toBe(10);
      check = 'requests'; expect(handshakes.every(value => value.matching === true) && observed.taskPosts === taskCount && !requests.some(r => r.path.endsWith('/cancel'))).toBe(true);
      expect(displayProofRequests === observed.latest + Number(label === 'disconnected-reader')).toBe(true);
      await activate(page, button('Disconnect')); await expect(token).toBeVisible(); await expect(taskField).toHaveValue('');
      await expect(page.locator('.run,.command')).toHaveCount(0); await boundary();
      const final = await fixture.inspect();
      check = 'native'; expect(isDeepStrictEqual([final.requests, final.tool_results, final.completed], [taskCount * 2, taskCount * 3, taskCount])).toBe(true);
      expect(isDeepStrictEqual([final.connections, final.auth_loads, final.auth_prepares, final.fresh_parents, final.continuations, final.prepared_exact],
        [taskCount, taskCount, taskCount, taskCount, taskCount, taskCount * 2])).toBe(true);
      expect(isDeepStrictEqual([final.fresh_empty, final.restored_history, final.terminals, final.results, final.gate], [true, taskCount === 2, taskCount, taskCount, null])).toBe(true);
      let providerStage = 'request'; if (taskCount === 2) providerStage = 'finished';
      expect(isDeepStrictEqual([final.provider_stage, final.provider_failed, final.read_failure], [providerStage, false, null])).toBe(true);
      expect(Object.values(faults).every(value => value === 0)).toBe(true);
    } catch (error) {
      failure = fatal(label, stage, check, error);
    } finally {
      try { if (liveObserver) { await liveObserver.evaluate(value => value.dispose()); await liveObserver.dispose(); } } catch { failure ??= fatal(label, 'cleanup', 'aria', null); }
      try { await stableDetail?.dispose(); } catch { failure ??= fatal(label, 'cleanup', 'disclosure', null); }
      try { if (context) { await context.close(); cleanup.context = true; } } catch { failure ??= fatal(label, 'cleanup', 'outside', null); }
      if (cleanup.context || !context) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
      try { if (fixture) { await fixture.stop(); cleanup.fixture = true; } } catch { failure ??= fatal(label, 'cleanup', 'native', null); }
      console.log(`Presentation cleanup: label=${label}; context=${cleanup.context}; fixture=${cleanup.fixture}`);
    }
    if (failure) throw failure;
  }
  expect(isDeepStrictEqual(measurements.map(value => value.label), labels)).toBe(true);
  for (const value of measurements) console.log(`Presentation measurement: ${JSON.stringify(value)}`);
});
