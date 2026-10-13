import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { data, answer, skillOutput } from '../test-support/presentation.mjs';
import { decodeJson, validateCreateView, validateTaskCommand, validateUuid } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { partialProof, expectedBlock, displayedBlock, normalizedDom, freshHandshake, readOnly } from '../test-support/rich-display-parity.mjs';

async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
function allowedRequest(method, url, sid, observer) {
  if (method === 'GET') return (url.pathname === '/v1/settings' && url.search === '')
    || url.pathname === '/v1/sessions'
    || (sid !== undefined && url.pathname === `/v1/sessions/${sid}` && url.search === '')
    || (sid !== undefined && url.pathname === `/v1/sessions/${sid}/conversation` && url.search === '')
    || (sid !== undefined && url.pathname === `/v1/sessions/${sid}/conversation/events` && url.search.startsWith('?after='));
  return !observer && method === 'POST' && url.search === ''
    && (url.pathname === '/v1/sessions' || (sid !== undefined && url.pathname === `/v1/sessions/${sid}/runs`));
}
async function boundary(page, context, owner, markers) {
  const safe = await page.evaluate(async ({ owner, markers }) => {
    const dom = document.documentElement.cloneNode(true);
    // Field IDs are public. Exempt only validated attributes in this detached privacy scan.
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
async function latestProof(fixture, sid) {
  // Independent typed HTTP proof at a held native H, not the browser Response body or its Fetch consumption.
  const reply = await fetch(`${fixture.origin}/v1/sessions/${sid}/conversation`, {
    method: 'GET', headers: { Authorization: `Bearer ${fixture.owner}`, Accept: 'application/json' },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  expect(reply.status === 200 && reply.headers.get('cache-control') === 'no-store').toBe(true);
  const bytes = await reply.arrayBuffer(); expect(bytes.byteLength <= 512 * 1024).toBe(true);
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), reply.headers.get('content-type'),
    value => validateConversationPage(value, { kind: 'latest' }, sid));
}

const stages = ['startup', 'connect', 'create', 'task', 'partial', 'fresh', 'parity', 'close-b', 'drain', 'cleanup'];
const checks = ['outside', 'reply', 'identity', 'native', 'fields', 'handshake', 'privacy', 'assets', 'requests', 'cleanup'];
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('fresh rich partial page matches live public DOM at one committed H', async ({ browser }) => {
  test.setTimeout(180_000);
  let fixture, a, b, contextA, contextB, sid, command, receipt, failure;
  let stage = 'startup', check = 'outside';
  const cleanup = { a: false, b: false, fixture: false };
  const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  const records = [0, 1].map(() => ({ requests: [], snapshots: [], streams: [], assets: new Set() }));
  const assetReads = [];
  try {
    const executable = await discoverFixture();
    expect(executable === process.env.WI_C3A_FIXTURE).toBe(true);
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, presentation: true });
    console.log(`Rich parity fixture: pid=${fixture.pid}; transport=websocket; presentation=true`);
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const markers = ['synthetic-replay-', 'synthetic-account-', 'private-operator-', 'private-project-', 'private-skill-', 'private-support-',
      'private-native', 'private-data', 'private-skills', 'private-config-canary', 'principal_digest', 'history_digest',
      'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
    async function observer(context, index) {
      const record = records[index];
      await context.route('**/*', async route => {
        try {
          if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
          else await route.continue();
        } catch { faults.collector++; }
      });
      context.on('request', request => {
        try {
          const url = new URL(request.url()), method = request.method();
          record.requests.push({ method, path: url.pathname, search: url.search });
          if (url.origin !== fixture.origin) faults.external++;
          if (leaked(request.url())) faults.private++;
          if (url.pathname.startsWith('/v1/')) {
            const headers = request.headers();
            if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
              || (headers.origin !== undefined && headers.origin !== fixture.origin)
              || !allowedRequest(method, url, sid, index === 1)) faults.request++;
          } else if (method !== 'GET' || !files.has(url.pathname) || url.search !== '') faults.request++;
          if (method === 'GET' && sid !== undefined && request.url() === `${fixture.origin}/v1/sessions/${sid}/conversation`)
            record.snapshots.push({ request, index: record.requests.length - 1, response: null });
          if (method === 'GET' && sid !== undefined && url.pathname === `/v1/sessions/${sid}/conversation/events`)
            record.streams.push({ request, index: record.requests.length - 1, response: record.snapshots.at(-1)?.response });
          if (method === 'POST' && url.pathname.endsWith('/runs')) {
            if (index !== 0 || command !== undefined) faults.request++;
            command = validateTaskCommand(request.postDataJSON());
            if (command.text !== data.user) faults.request++;
          }
        } catch { faults.collector++; }
      });
      context.on('response', response => {
        try {
          const url = new URL(response.url()), snapshot = record.snapshots.find(item => item.request === response.request());
          if (snapshot) snapshot.response = response;
          if (response.status() >= 300) faults.response++;
          const file = files.get(url.pathname);
          if (file === undefined) return;
          assetReads.push((async () => {
            const bytes = await response.body();
            if (response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.response++;
            if (leaked(bytes.toString('utf8'))) faults.private++;
            record.assets.add(url.pathname);
          })().catch(() => { faults.collector++; }));
        } catch { faults.collector++; }
      });
      const page = await context.newPage();
      page.on('console', message => { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.private++; });
      page.on('pageerror', () => { faults.page++; });
      return page;
    }
    const status = page => page.locator('.topbar [role="status"]');
    const transcript = page => page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const button = (page, name) => page.getByRole('button', { name, exact: true });
    async function connect(page) {
      await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
      await button(page, 'Connect').click();
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    }
    async function readReply(response, statusCode, validate) {
      expect(response.status() === statusCode).toBe(true);
      const bytes = await response.body(); expect(bytes.length <= 512 * 1024).toBe(true);
      return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), response.headers()['content-type'], validate);
    }
    contextA = await browser.newContext({ serviceWorkers: 'block' }); a = await observer(contextA, 0);
    stage = 'connect'; await a.goto(`${fixture.origin}/`); await connect(a); await exact(status(a), 'connected');
    check = 'privacy'; await boundary(a, contextA, fixture.owner, markers);
    stage = 'create'; await a.getByLabel('Title', { exact: true }).fill(data.title);
    check = 'reply'; const [createdReply] = await Promise.all([
      a.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      button(a, 'Create session').click(),
    ]);
    const created = await readReply(createdReply, 201, validateCreateView); sid = validateUuid(created.session_id);
    await button(a, 'Open receipt session').click(); await exact(status(a), 'connected; observation: streaming');
    await expect.poll(() => records[0].streams.length).toBe(1);
    check = 'native'; await fixture.request({ command: 'select', session_id: sid });
    expect((await fixture.inspect()).sequence_count === '1').toBe(true);
    stage = 'task'; await a.getByLabel('Task', { exact: true }).fill(data.user);
    const [acceptedReply] = await Promise.all([
      a.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'),
      button(a, 'Send').click(),
    ]);
    check = 'reply'; const accepted = await readReply(acceptedReply, 202, value => validateDisplayTaskAccepted(value, { ...command, session_id: sid }));
    receipt = accepted.receipt;
    await fixture.wait('model_paused', 1);
    check = 'native'; expect(isDeepStrictEqual((await fixture.inspect()).receipts, [receipt])).toBe(true);
    stage = 'partial'; await fixture.request({ command: 'drive', gate: 1 }); await fixture.wait('model_paused', 2);
    const { id: _id, ...held } = await fixture.inspect();
    expect(isDeepStrictEqual([held.gate, held.requests, held.connections, held.tool_results, held.results, held.terminals, held.completed, held.response_finishes.length,
      held.provider_failed, held.read_failure], [2, 1, 1, 0, 0, 0, 0, 0, false, null])).toBe(true);
    check = 'fields'; const proof = partialProof(await latestProof(fixture, sid), sid, command.run_id, held.sequence_count, receipt.first_sequence);
    const expected = expectedBlock(proof), runA = transcript(a).locator('.run');
    await expect(runA).toHaveCount(1);
    await expect.poll(async () => isDeepStrictEqual(await displayedBlock(runA), expected)).toBe(true);
    const live = await normalizedDom(runA);
    check = 'privacy'; await boundary(a, contextA, fixture.owner, markers);

    stage = 'fresh'; contextB = await browser.newContext({ serviceWorkers: 'block' }); b = await observer(contextB, 1);
    await b.goto(`${fixture.origin}/#session=${sid}`);
    await expect(b.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await expect(transcript(b).locator('.run')).toHaveCount(0);
    expect(records[1].requests.every(request => !request.path.startsWith('/v1/'))).toBe(true);
    check = 'reply'; const [freshReply] = await Promise.all([
      b.waitForResponse(response => records[1].snapshots.some(item => item.request === response.request())), connect(b),
    ]);
    await exact(status(b), 'connected; observation: streaming');
    await expect.poll(() => records[1].streams.length > 0).toBe(true);
    check = 'handshake'; const independent = partialProof(await latestProof(fixture, sid), sid, command.run_id, held.sequence_count, receipt.first_sequence);
    expect(isDeepStrictEqual(independent, proof)).toBe(true);
    expect(freshHandshake({ origin: fixture.origin, sid, head: held.sequence_count, value: independent,
      snapshots: records[1].snapshots, streams: records[1].streams, reply: freshReply })).toBe(true);
    expect(freshReply.headers()['cache-control'] === 'no-store' && freshReply.headers()['content-type'].startsWith('application/json')).toBe(true);
    stage = 'parity'; check = 'fields'; const runB = transcript(b).locator('.run'); await expect(runB).toHaveCount(1);
    await expect.poll(async () => isDeepStrictEqual(await displayedBlock(runB), expected)).toBe(true);
    expect(isDeepStrictEqual(await displayedBlock(runA), await displayedBlock(runB))).toBe(true);
    expect((await normalizedDom(runA)) === live && (await normalizedDom(runB)) === live).toBe(true);
    await exact(a.getByRole('heading', { name: 'Canonical session title', exact: true }), data.title);
    await exact(b.getByRole('heading', { name: 'Canonical session title', exact: true }), data.title);
    await expect(b.locator('.command')).toHaveCount(0); await expect(b.getByLabel('Task', { exact: true })).toHaveValue('');
    check = 'privacy'; await boundary(b, contextB, fixture.owner, markers);
    check = 'requests'; expect(readOnly(records[1].requests)).toBe(true);
    expect(records[0].snapshots.length === 1 && records[0].streams.length === 1
      && records[0].requests.filter(request => request.method === 'POST').length === 2).toBe(true);
    check = 'native'; const { id: _readId, ...afterReads } = await fixture.inspect(); expect(isDeepStrictEqual(afterReads, held)).toBe(true);
    console.log(`Rich parity barrier: head=${held.sequence_count}; tasks=1; partial_barriers=1; entries=2; fields=12; fresh_latest=1; fresh_stream=1; fresh_mutations=0; provider_requests=1; tool_results=0; native_unchanged=true`);
    stage = 'close-b'; await contextB.close(); cleanup.b = true;
    const { id: _closeId, ...afterClose } = await fixture.inspect(); expect(isDeepStrictEqual(afterClose, held)).toBe(true);
    expect(readOnly(records[1].requests)).toBe(true);

    // Drain the same real Task. This is not another parity milestone.
    stage = 'drain'; check = 'native';
    for (const gate of [2, 3, 4, 5, 6]) {
      await fixture.request({ command: 'drive', gate });
      if (gate < 6) await fixture.wait('model_paused', gate + 1);
      else await fixture.wait('task_finished', 1);
    }
    const final = await fixture.inspect();
    expect(isDeepStrictEqual([final.requests, final.tool_results, final.completed, final.connections, final.auth_loads, final.auth_prepares,
      final.fresh_parents, final.continuations, final.prepared_exact, final.terminals, final.results, final.gate], [2, 3, 1, 1, 1, 1, 1, 1, 2, 1, 1, null])).toBe(true);
    expect(isDeepStrictEqual([final.fresh_empty, final.restored_history, final.provider_stage, final.provider_failed, final.read_failure], [true, false, 'request', false, null])).toBe(true);
    expect(isDeepStrictEqual(final.receipts, [receipt]) && final.accepted.length === 1 && final.accepted[0].run_id === command.run_id
      && final.response_finishes.length === 2 && final.response_finishes.every(response => response.provenance === 'native_terminal')
      && BigInt(final.terminal_sequences[0]) < BigInt(final.result_sequences[0])).toBe(true);
    check = 'fields'; await exact(runA.locator(':scope > .metadata'), 'Execution: completed. Final result recorded.');
    await expect.poll(async () => isDeepStrictEqual(await runA.locator('.entry > h4').allTextContents(), ['Human', 'assistant', 'tool', 'tool', 'tool', 'assistant'])).toBe(true);
    const tools = runA.locator('.entry');
    for (const [slot, output, error] of [[2, '{"sum":42}', false], [3, skillOutput, false], [4, '{"error":{"code":"gateway_error"}}', true]]) {
      await exact(tools.nth(slot).locator('[data-field] pre').last(), output);
      await exact(tools.nth(slot).locator(':scope > .metadata').first(), `Recorded state: ${error ? 'failed' : 'completed'}; Provisional: false; result_recorded: true; finish_recorded: true; is_error: ${error}`);
    }
    await exact(tools.nth(5).locator('[data-field] pre'), answer(0));
    check = 'privacy'; await boundary(a, contextA, fixture.owner, markers);
    check = 'assets'; await Promise.all(assetReads);
    expect(records.every(record => record.assets.size === files.size && [...files.keys()].every(file => record.assets.has(file)))).toBe(true);
    check = 'requests'; expect(records[0].requests.filter(request => request.method === 'POST').length === 2 && readOnly(records[1].requests)
      && records.every(record => !record.requests.some(request => request.path.endsWith('/cancel')))).toBe(true);
    expect(Object.values(faults).every(value => value === 0)).toBe(true);
    console.log('Rich parity drain: tasks=1; provider_requests=2; tool_results=3; completed=1; terminals=1; results=1; native_fidelity=true');
  } catch {
    failure = new Error(`Rich parity failed: stage=${stages.includes(stage) ? stage : 'unknown'}; check=${checks.includes(check) ? check : 'unknown'}`);
  } finally {
    try { if (contextB && !cleanup.b) { await contextB.close(); cleanup.b = true; } } catch { failure ??= new Error('Rich parity cleanup failed: B'); }
    try { if (contextA) { await contextA.close(); cleanup.a = true; } } catch { failure ??= new Error('Rich parity cleanup failed: A'); }
    try { if (fixture) { await fixture.stop(); cleanup.fixture = true; } } catch { failure ??= new Error('Rich parity cleanup failed: fixture'); }
    const evidence = fixture?.evidence();
    console.log(`Rich parity cleanup: ${JSON.stringify({ ...cleanup, evidence })}`);
    if (fixture && (!cleanup.fixture || evidence.failure !== null || !evidence.stop.attempted || !evidence.stop.clean_acknowledgment
      || !evidence.stop.reap_complete || !evidence.stop.sandbox_removed || !evidence.stop.exit_observed || evidence.stop.exit_zero !== true
      || evidence.stop.error_latched || !evidence.stop.stderr_empty || evidence.stop.sigterm || evidence.stop.sigkill))
      failure ??= new Error('Rich parity strict Stop rejected');
  }
  if (failure) throw failure;
});
