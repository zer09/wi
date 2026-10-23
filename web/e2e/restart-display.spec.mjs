import { expect, test } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture } from '../test-support/fixture.mjs';
import { data } from '../test-support/presentation.mjs';
import { decodeJson, validateCreateView, validateTaskCommand, validateUuid } from '../dist/api.js';
import { validateDisplayTaskAccepted } from '../dist/display-api.js';
import { expectedBlock, displayedBlock, normalizedDom, readOnly } from '../test-support/rich-display-parity.mjs';
import { nativeBinding, createRestartRoot, startRestartProcess, removeRestartRoot, runningProof, interruptedProof,
  stableProof, entryProof, receiptProof, publicJson, handshakeProof, allowedRequest } from '../test-support/restart-display.mjs';

const markers = ['synthetic-replay-', 'synthetic-account-', 'private-operator-', 'private-project-', 'private-skill-', 'private-support-',
  'private-native', 'private-data', 'private-skills', 'private-config-canary', 'principal_digest', 'history_digest',
  'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
const hash = value => createHash('sha256').update(value).digest('hex');
async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
async function boundary(page, context, owner) {
  const safe = await page.evaluate(async ({ owner, markers }) => {
    const dom = document.documentElement.cloneNode(true);
    // Public field IDs are not secrets. Exempt only their validated attributes in this detached scan.
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
  expect(safe && (await context.cookies()).length === 0).toBe(true);
}
function publicPrivacy(value, owner) {
  const text = JSON.stringify(value, (key, item) => key === 'field_id' && /^(text|[0-9a-f]{64})$/.test(item) ? 'public-field-id' : item);
  expect(!text.includes(owner) && !/[0-9a-f]{64}/i.test(text) && !markers.some(marker => text.includes(marker))).toBe(true);
}
async function readReply(response, statusCode, validate) {
  const headers = response.headers();
  expect(response.status() === statusCode && headers['cache-control'] === 'no-store'
    && headers['x-content-type-options'] === 'nosniff' && headers['set-cookie'] === undefined).toBe(true);
  const bytes = await response.body(); expect(bytes.length <= 512 * 1024).toBe(true);
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), headers['content-type'], validate);
}
const stages = ['binding', 'produce', 'connect-a', 'create', 'task', 'partial', 'close-a', 'kill', 'observe', 'connect-b', 'interrupted', 'warm', 'close-b', 'drain', 'cleanup'];
const checks = ['outside', 'identity', 'reply', 'work', 'fields', 'handshake', 'privacy', 'assets', 'requests', 'cleanup'];
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('fresh browser Latest recovers exact rich interrupted display after owned producer SIGKILL', async ({ browser }) => {
  let fixture, producer, observer, contextA, contextB, sid, command, receipt, failure;
  let stage = 'binding', check = 'identity', permission = 'none', rootRemoved = false, closedA = false, closedB = false;
  const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  const records = [0, 1].map(() => ({ requests: [], snapshots: [], streams: [], assets: new Set() }));
  const assetReads = [];
  try {
    const executable = await discoverFixture();
    const binding = await nativeBinding(executable);
    console.log(`Restart display binding: ${JSON.stringify(binding)}`);
    fixture = await createRestartRoot(); stage = 'produce'; producer = await startRestartProcess(binding, fixture, 'produce');
    const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/assets/wi.css', ['style.css', 'text/css; charset=utf-8']],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, [`dist/${name}.js`, 'text/javascript; charset=utf-8']])]);
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
    async function pageFor(context, process, index) {
      const record = records[index];
      await context.route('**/*', async route => {
        try {
          if (new URL(route.request().url()).origin !== process.origin) { faults.external++; await route.abort(); }
          else await route.continue();
        } catch { faults.collector++; }
      });
      context.on('request', request => {
        try {
          const url = new URL(request.url()), method = request.method();
          record.requests.push({ method, path: url.pathname, search: url.search });
          if (url.origin !== process.origin) faults.external++;
          if (leaked(request.url())) faults.private++;
          if (url.pathname.startsWith('/v1/')) {
            const headers = request.headers();
            if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
              || headers.origin !== undefined && headers.origin !== process.origin
              || !allowedRequest(method, url, sid, index === 0 ? permission : 'none')) faults.request++;
          } else if (method !== 'GET' || !files.has(url.pathname) || url.search !== '') faults.request++;
          const base = `/v1/sessions/${sid}/conversation`;
          if (method === 'GET' && url.pathname === base) record.snapshots.push({ request, index: record.requests.length - 1, response: null });
          if (method === 'GET' && url.pathname === `${base}/events`) record.streams.push({ request, index: record.requests.length - 1, response: record.snapshots.at(-1)?.response, reply: null });
          if (method === 'POST' && url.pathname.endsWith('/runs')) {
            if (index !== 0 || command !== undefined) faults.request++;
            command = validateTaskCommand(request.postDataJSON());
            if (command.text !== data.user) faults.request++;
          }
        } catch { faults.collector++; }
      });
      context.on('response', response => {
        try {
          const url = new URL(response.url());
          const snapshot = record.snapshots.find(item => item.request === response.request()); if (snapshot) snapshot.response = response;
          const stream = record.streams.find(item => item.request === response.request()); if (stream) stream.reply = response;
          if (response.status() >= 300) faults.response++;
          const file = files.get(url.pathname); if (!file) return;
          assetReads.push((async () => {
            const bytes = await response.body(), headers = response.headers();
            if (response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file[0]}`, import.meta.url)))
              || headers['content-type'] !== file[1] || headers['cache-control'] !== 'no-store' || headers['x-content-type-options'] !== 'nosniff'
              || headers['set-cookie'] !== undefined) faults.response++;
            if (leaked(bytes.toString('utf8'))) faults.private++;
            record.assets.add(url.pathname);
          })().catch(() => { faults.collector++; }));
        } catch { faults.collector++; }
      });
      const page = await context.newPage();
      page.on('console', () => { faults.console++; }); page.on('pageerror', () => { faults.page++; });
      return page;
    }
    const status = page => page.locator('.topbar [role="status"]');
    const transcript = page => page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const button = (page, name) => page.getByRole('button', { name, exact: true });
    async function connect(page) {
      await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner); await button(page, 'Connect').click();
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    }
    async function display(page, proof) {
      const run = transcript(page).locator('.run'); await expect(run).toHaveCount(1);
      await expect.poll(async () => isDeepStrictEqual(await displayedBlock(run), expectedBlock(proof))).toBe(true);
      await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), data.title);
      return normalizedDom(run);
    }
    async function addressed(process, page) {
      for (const entry of [page.block.human, ...page.entries]) {
        const proof = await publicJson(process, fixture.owner, `/v1/sessions/${sid}/conversation/entries/${command.run_id}/${encodeURIComponent(entry.entry_id)}`,
          value => entryProof(value, page, entry)); publicPrivacy(proof, fixture.owner);
      }
    }
    async function reconciliation(process, page) {
      const proof = await publicJson(process, fixture.owner, `/v1/sessions/${sid}/runs/reconcile`, value => receiptProof(value, page, command, receipt), command);
      publicPrivacy(proof, fixture.owner);
    }
    contextA = await browser.newContext({ serviceWorkers: 'block' }); const a = await pageFor(contextA, producer, 0);
    stage = 'connect-a'; await a.goto(`${producer.origin}/`); await connect(a); await exact(status(a), 'connected');
    check = 'privacy'; await boundary(a, contextA, fixture.owner);
    stage = 'create'; permission = 'create'; await a.getByLabel('Title', { exact: true }).fill(data.title);
    check = 'reply'; const [createdReply] = await Promise.all([
      a.waitForResponse(response => response.url() === `${producer.origin}/v1/sessions` && response.request().method() === 'POST'), button(a, 'Create session').click(),
    ]);
    const created = await readReply(createdReply, 201, validateCreateView); sid = validateUuid(created.session_id); permission = 'none';
    await button(a, 'Open receipt session').click(); await exact(status(a), 'connected; observation: streaming');
    await expect.poll(() => records[0].streams.length).toBe(1);
    check = 'identity'; await producer.request({ command: 'select', session_id: sid });
    stage = 'task'; permission = 'task'; await a.getByLabel('Task', { exact: true }).fill(data.user);
    check = 'reply'; const [acceptedReply] = await Promise.all([
      a.waitForResponse(response => response.url() === `${producer.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'), button(a, 'Send').click(),
    ]);
    const accepted = await readReply(acceptedReply, 202, value => validateDisplayTaskAccepted(value, { ...command, session_id: sid }));
    expect(!accepted.duplicate && accepted.warning_code === null && accepted.notices.length === 0).toBe(true);
    receipt = accepted.receipt; permission = 'none'; await producer.wait(1);
    stage = 'partial'; await producer.request({ command: 'drive', gate: 1 }); await producer.wait(2);
    check = 'work'; await producer.sample();
    check = 'fields'; const before = await publicJson(producer, fixture.owner, `/v1/sessions/${sid}/conversation`,
      value => runningProof(value, sid, command, receipt, fixture.workspace));
    publicPrivacy(before, fixture.owner); await addressed(producer, before); await reconciliation(producer, before);
    const liveDom = await display(a, before); await expect(button(a, 'Cancel current run')).toBeEnabled();
    check = 'privacy'; await boundary(a, contextA, fixture.owner);
    stage = 'close-a'; await contextA.close(); closedA = true;
    check = 'work'; await producer.sample();
    check = 'fields'; await publicJson(producer, fixture.owner, `/v1/sessions/${sid}/conversation`, value => stableProof(value, before));
    check = 'requests'; expect(records[0].requests.filter(request => request.method === 'POST').length === 2).toBe(true);
    stage = 'kill'; check = 'cleanup'; await producer.killProducer();
    console.log(`Restart display partial: head=${before.snapshot_head}; operation=${command.operation_id}; run=${command.run_id}; receipt=${hash(JSON.stringify(receipt))}; dom=${hash(liveDom)}; tasks=1; producer_sigkill=true`);

    stage = 'observe'; check = 'identity'; observer = await startRestartProcess(binding, fixture, 'observe');
    expect(observer.pid !== producer.pid).toBe(true);
    await observer.request({ command: 'select', session_id: sid }); check = 'work'; await observer.sample();
    contextB = await browser.newContext({ serviceWorkers: 'block' }); const b = await pageFor(contextB, observer, 1);
    stage = 'connect-b'; await b.goto(`${observer.origin}/#session=${sid}`);
    await expect(b.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await expect(transcript(b).locator('.run')).toHaveCount(0);
    expect(records[1].requests.every(request => !request.path.startsWith('/v1/'))).toBe(true);
    check = 'reply'; const [originalLatest] = await Promise.all([
      b.waitForResponse(response => records[1].snapshots.some(item => item.request === response.request())), connect(b),
    ]);
    await exact(status(b), 'connected; observation: streaming');
    await expect.poll(() => records[1].streams.length === 1 && records[1].streams[0].reply !== null).toBe(true);
    // Only B's original Latest can open/recover the selected session. Independent proofs start after its display is interrupted.
    await exact(transcript(b).locator('.run > .metadata'), 'Execution: interrupted. Final result not recorded.');
    stage = 'interrupted'; check = 'fields'; const after = await publicJson(observer, fixture.owner, `/v1/sessions/${sid}/conversation`, value => interruptedProof(value, before));
    publicPrivacy(after, fixture.owner); await addressed(observer, after); await reconciliation(observer, after);
    check = 'handshake'; handshakeProof({ origin: observer.origin, sid, head: after.snapshot_head, value: after,
      snapshots: records[1].snapshots, streams: records[1].streams, reply: originalLatest });
    check = 'fields'; const savedDom = await display(b, after);
    await expect(button(b, 'Cancel current run')).toBeDisabled(); await expect(b.locator('.command')).toHaveCount(0);
    await expect(b.getByLabel('Task', { exact: true })).toHaveValue(''); check = 'work'; await observer.sample();
    stage = 'warm';
    for (const round of [1, 2]) {
      const snapshotStart = records[1].snapshots.length, streamStart = records[1].streams.length;
      check = 'reply'; const [latestReply] = await Promise.all([
        b.waitForResponse(response => records[1].snapshots.slice(snapshotStart).some(item => item.request === response.request())), button(b, 'Reconnect latest').click(),
      ]);
      await exact(status(b), 'connected; observation: streaming');
      await expect.poll(() => records[1].streams.length === streamStart + 1 && records[1].streams.at(-1).reply !== null).toBe(true);
      check = 'fields'; const warm = await publicJson(observer, fixture.owner, `/v1/sessions/${sid}/conversation`, value => stableProof(value, after));
      publicPrivacy(warm, fixture.owner); await reconciliation(observer, warm);
      check = 'handshake'; handshakeProof({ origin: observer.origin, sid, head: after.snapshot_head, value: warm,
        snapshots: records[1].snapshots.slice(snapshotStart), streams: records[1].streams.slice(streamStart), reply: latestReply });
      check = 'fields'; expect(await display(b, warm) === savedDom).toBe(true);
      check = 'privacy'; await boundary(b, contextB, fixture.owner); check = 'work'; await observer.sample();
      console.log(`Restart display warm: round=${round}; head=${warm.snapshot_head}; dom=${hash(savedDom)}; exact_public_snapshot=true; work_zero=true`);
    }
    check = 'assets'; await Promise.all(assetReads);
    expect(records.every(record => record.assets.size === files.size && [...files.keys()].every(file => record.assets.has(file)))).toBe(true);
    stage = 'close-b'; await contextB.close(); closedB = true; check = 'work'; await observer.sample();
    check = 'requests'; expect(readOnly(records[1].requests) && records[1].snapshots.length === 3 && records[1].streams.length === 3
      && records[0].snapshots.length === 1 && records[0].streams.length === 1 && records[0].requests.filter(request => request.method === 'POST').length === 2
      && records.every(record => !record.requests.some(request => request.path.endsWith('/cancel')))).toBe(true);
    expect(Object.values(faults).every(value => value === 0)).toBe(true);
    stage = 'drain'; check = 'cleanup'; await observer.stopObserver();
    stage = 'cleanup'; rootRemoved = await removeRestartRoot(fixture, [producer, observer]);
    console.log(`Restart display parity: pre_head=${before.snapshot_head}; post_head=${after.snapshot_head}; public_h_plus_one=true; entries=2; fields=12; observer_latest=3; observer_streams=3; observer_mutations=0; browser_recovery=true; faults=${JSON.stringify(faults)}`);
  } catch {
    failure = new Error(`Restart display failed: stage=${stages.includes(stage) ? stage : 'unknown'}; check=${checks.includes(check) ? check : 'unknown'}`);
  } finally {
    try { if (contextB && !closedB) { await contextB.close(); closedB = true; } } catch { failure ??= new Error('Restart display cleanup failed: B'); }
    try { if (contextA && !closedA) { await contextA.close(); closedA = true; } } catch { failure ??= new Error('Restart display cleanup failed: A'); }
    if (failure) {
      for (const process of [producer, observer]) if (process) { try { await process.fallback(); } catch { failure = new Error('Restart display cleanup failed: reap'); } }
      if (fixture && !rootRemoved && [producer, observer].filter(Boolean).every(process => process.evidence().reaped)) {
        try { await rm(fixture.root, { recursive: true, force: true }); rootRemoved = true; } catch { failure = new Error('Restart display cleanup failed: root'); }
      }
    }
    console.log(`Restart display cleanup: ${JSON.stringify({ closedA, closedB, rootRemoved, failed: !!failure, producer: producer?.evidence(), observer: observer?.evidence() })}`);
    if (!closedA || !closedB || !rootRemoved) failure ??= new Error('Restart display strict cleanup rejected');
  }
  if (failure) throw failure;
});
