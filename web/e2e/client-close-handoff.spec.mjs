import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { decodeJson, validateCreateView, validateTaskCommand, validateUuid } from '../dist/api.js';
import { validateConversationPage } from '../dist/display-api.js';
import { expectedBlock, displayedBlock, normalizedDom, freshHandshake, readOnly } from '../test-support/rich-display-parity.mjs';
import { TITLE, TASKS, ARGUMENTS, OUTPUTS, acceptedTask, nativeBarrier, unchangedNative, publicProof,
  allowedRequest, handoffOrder, strictStop } from '../test-support/client-close-handoff.mjs';

async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
async function latestProof(fixture, sid) {
  // This typed HTTP read is independent of the original browser Request/Response handshake.
  const reply = await fetch(`${fixture.origin}/v1/sessions/${sid}/conversation`, {
    method: 'GET', headers: { Authorization: `Bearer ${fixture.owner}`, Accept: 'application/json' },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  expect(reply.status === 200 && reply.headers.get('cache-control') === 'no-store').toBe(true);
  const bytes = await reply.arrayBuffer(); expect(bytes.byteLength <= 512 * 1024).toBe(true);
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), reply.headers.get('content-type'),
    value => validateConversationPage(value, { kind: 'latest' }, sid));
}
async function boundary(page, context, owner, markers) {
  const safe = await page.evaluate(async ({ owner, markers }) => {
    const dom = document.documentElement.cloneNode(true);
    // Exempt only validated public field IDs from the detached privacy scan.
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
      && content.querySelectorAll('script,img,a,iframe,object,embed,svg,math,link,style,audio,video,source,em').length === 0
      && Array.from(content.querySelectorAll('*')).every(node => Array.from(node.attributes).every(attribute =>
        !/^on/i.test(attribute.name) && !['src', 'href', 'srcdoc'].includes(attribute.name)))
      && document.querySelectorAll('script').length === 1 && document.querySelector('script').getAttribute('src') === '/assets/app.js';
  }, { owner, markers });
  expect(safe && (await context.cookies()).length === 0).toBe(true);
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('submitter closes active Task; observer completes and explicitly submits; fresh submitter opens latest', async ({ browser }) => {
  let fixture, contextA, contextB, reopenedA, a, b, freshA, sid, workspace, failure;
  let stage = 'startup', check = 'outside';
  const cleanup = { a: false, b: false, reopened: false, fixture: false };
  const faults = { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 };
  const records = [0, 1, 2].map(() => ({ requests: [], snapshots: [], streams: [], assets: new Set(), permission: null }));
  const commands = [], receipts = [], events = [], assetReads = [];
  try {
    const executable = await discoverFixture(); expect(executable === process.env.WI_C3A_FIXTURE).toBe(true);
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true });
    console.log(`Client handoff fixture: pid=${fixture.pid}; transport=websocket; recovered=false; mime=true; chromium=${browser.version()}`);
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
              || !allowedRequest(method, url, sid, record.permission)) faults.request++;
          } else if (method !== 'GET' || !files.has(url.pathname) || url.search !== '') faults.request++;
          if (method === 'GET' && sid !== undefined && request.url() === `${fixture.origin}/v1/sessions/${sid}/conversation`)
            record.snapshots.push({ request, index: record.requests.length - 1, response: null });
          if (method === 'GET' && sid !== undefined && url.pathname === `/v1/sessions/${sid}/conversation/events`)
            record.streams.push({ request, index: record.requests.length - 1, response: record.snapshots.at(-1)?.response });
          if (method === 'POST' && url.pathname.endsWith('/runs')) {
            const task = commands.length;
            if (task > 1 || index !== task || record.permission !== ['first','second'][task]) faults.request++;
            const command = validateTaskCommand(request.postDataJSON());
            if (command.text !== TASKS[task]) faults.request++;
            commands.push(command);
          }
          if (method === 'POST' && url.pathname === '/v1/sessions') {
            const body = request.postDataJSON();
            validateUuid(body.operation_id);
            if (index !== 0 || record.permission !== 'create' || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
              || body.title !== TITLE || body.workspace !== workspace) faults.request++;
          }
        } catch { faults.collector++; }
      });
      context.on('response', response => {
        try {
          const url = new URL(response.url()), snapshot = record.snapshots.find(item => item.request === response.request());
          if (snapshot) snapshot.response = response;
          if (response.status() >= 300) faults.response++;
          const file = files.get(url.pathname); if (file === undefined) return;
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
    const run = (page, task) => transcript(page).locator(`.run[data-run="${commands[task].run_id}"]`);
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
    async function freshMemory(page, index) {
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
      await expect(page.locator('.run,.command')).toHaveCount(0);
      expect(records[index].requests.every(request => !request.path.startsWith('/v1/'))).toBe(true);
      await boundary(page, index === 1 ? contextB : reopenedA, fixture.owner, markers);
    }
    async function ready(page, proof, task) {
      await expect(run(page, task)).toHaveCount(1);
      await expect.poll(async () => isDeepStrictEqual(await displayedBlock(run(page, task)), expectedBlock(proof))).toBe(true);
      await exact(status(page), 'connected; observation: streaming');
    }
    async function toolReady(task) {
      const tool = run(b, task).locator('.entry').filter({ has: b.getByRole('heading', { name: 'tool', exact: true }) });
      await expect(tool).toHaveCount(1);
      await exact(tool.locator(':scope > .metadata').first(), 'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false');
      await exact(tool.locator('[data-field] pre').first(), 'add_numbers');
      await exact(tool.locator('[data-field] pre').last(), OUTPUTS[task]);
      await exact(run(b, task).locator('[data-field] pre').filter({ hasText: ARGUMENTS[task] }), ARGUMENTS[task]);
    }
    const proofOptions = (held, task, completed) => ({ sid, head: held.sequence_count, command: commands[task], receipt: receipts[task], task, completed, workspace });

    contextA = await browser.newContext({ serviceWorkers: 'block' }); a = await observer(contextA, 0);
    stage = 'create'; await a.goto(`${fixture.origin}/`); await connect(a); await exact(status(a), 'connected');
    await a.getByLabel('Title', { exact: true }).fill(TITLE); workspace = await a.getByLabel(/^Workspace/).inputValue();
    records[0].permission = 'create';
    const [createdReply] = await Promise.all([a.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'), button(a, 'Create session').click()]);
    records[0].permission = null;
    const created = await readReply(createdReply, 201, validateCreateView); sid = validateUuid(created.session_id);
    await button(a, 'Open receipt session').click(); await exact(status(a), 'connected; observation: streaming');
    await fixture.request({ command: 'select', session_id: sid }); expect((await fixture.inspect()).sequence_count === '1').toBe(true);
    stage = 'first-send'; await a.getByLabel('Task', { exact: true }).fill(TASKS[0]);
    records[0].permission = 'first'; events.push('send-a');
    const [firstReply] = await Promise.all([a.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'), button(a, 'Send').click()]);
    records[0].permission = null; check = 'receipt'; receipts.push(await readReply(firstReply, 202, value => acceptedTask(value, commands[0], sid, 0)));
    await fixture.wait('model_paused', 1); check = 'native'; const gate1 = nativeBarrier(await fixture.inspect(), commands, receipts, 1, 0);
    check = 'dto'; const running = publicProof(await latestProof(fixture, sid), proofOptions(gate1, 0, false));
    await ready(a, running, 0); await exact(a.locator('.command h3').filter({ hasText: /^task:/ }), 'task: accepted');
    await boundary(a, contextA, fixture.owner, markers); await Promise.all(assetReads); events.push('gate1-ready');
    stage = 'close-a'; await contextA.close(); cleanup.a = true; events.push('a-closed');
    check = 'native'; expect(unchangedNative(await fixture.inspect(), gate1)).toBe(true);
    console.log(`Client handoff closure: head=${gate1.sequence_count}; gate=1; requests=1; tools=0; completed=0; terminals=0; results=0; a_context_closed=true; native_unchanged=true; receipt=${JSON.stringify(receipts[0])}`);

    stage = 'observer-connect'; contextB = await browser.newContext({ serviceWorkers: 'block' }); b = await observer(contextB, 1);
    await b.goto(`${fixture.origin}/#session=${sid}`); await freshMemory(b, 1);
    const [bReply] = await Promise.all([b.waitForResponse(response => records[1].snapshots.some(item => item.request === response.request())), connect(b)]);
    await exact(status(b), 'connected; observation: streaming'); await expect.poll(() => records[1].streams.length).toBe(1); events.push('b-connected');
    check = 'dto'; const observed = publicProof(await latestProof(fixture, sid), proofOptions(gate1, 0, false)); expect(isDeepStrictEqual(observed, running)).toBe(true);
    check = 'handshake'; expect(freshHandshake({ origin: fixture.origin, sid, head: gate1.sequence_count, value: observed,
      snapshots: records[1].snapshots, streams: records[1].streams, reply: bReply })).toBe(true);
    expect(bReply.headers()['cache-control'] === 'no-store' && bReply.headers()['content-type'].startsWith('application/json')).toBe(true);
    await ready(b, observed, 0); events.push('b-running'); expect(readOnly(records[1].requests)).toBe(true);
    check = 'native'; expect(unchangedNative(await fixture.inspect(), gate1)).toBe(true);
    stage = 'first-completion'; events.push('drive1'); await fixture.request({ command: 'drive', gate: 1 }); await fixture.wait('model_paused', 2);
    nativeBarrier(await fixture.inspect(), commands, receipts, 2, 0); await toolReady(0); events.push('tool1-ready');
    expect(cleanup.a && readOnly(records[1].requests)).toBe(true);
    events.push('drive2'); await fixture.request({ command: 'drive', gate: 2 }); await fixture.wait('task_finished', 1);
    const completed1 = nativeBarrier(await fixture.inspect(), commands, receipts, null, 1);
    check = 'dto'; const firstProof = publicProof(await latestProof(fixture, sid), proofOptions(completed1, 0, true));
    await ready(b, firstProof, 0); const firstDisplay = await displayedBlock(run(b, 0)), firstDom = await normalizedDom(run(b, 0));
    events.push('b-completed1'); expect(readOnly(records[1].requests) && commands.length === 1).toBe(true);
    expect(unchangedNative(await fixture.inspect(), completed1)).toBe(true); await boundary(b, contextB, fixture.owner, markers);
    console.log(`Client handoff first completion: head=${completed1.sequence_count}; response=${completed1.response_finishes[1].sequence}; terminal=${completed1.terminal_sequences[0]}; result=${completed1.result_sequences[0]}; dom_ready=true; b_mutations=0; a_closed=true`);

    stage = 'later-explicit-send'; await b.getByLabel('Task', { exact: true }).fill(TASKS[1]);
    records[1].permission = 'second'; events.push('send-b');
    const [secondReply] = await Promise.all([b.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'), button(b, 'Send').click()]);
    records[1].permission = null; check = 'receipt'; receipts.push(await readReply(secondReply, 202, value => acceptedTask(value, commands[1], sid, 1)));
    await fixture.wait('model_paused', 3); check = 'native'; nativeBarrier(await fixture.inspect(), commands, receipts, 3, 1); events.push('gate3-ready');
    await exact(b.locator('.command h3'), 'task: accepted');
    const receiptText = await b.locator('.command > pre').textContent();
    expect(receiptText.includes(`Operation: ${receipts[1].operation_id}\nSession: ${sid}\nRun: ${receipts[1].run_id}\nSequences: ${receipts[1].first_sequence} to ${receipts[1].last_sequence}`)).toBe(true);
    events.push('drive3'); await fixture.request({ command: 'drive', gate: 3 }); await fixture.wait('model_paused', 4);
    nativeBarrier(await fixture.inspect(), commands, receipts, 4, 1); await toolReady(1); events.push('tool2-ready');
    events.push('drive4'); await fixture.request({ command: 'drive', gate: 4 }); await fixture.wait('task_finished', 2);
    // The producer marks finished just after task_finished; observe that real state before fixing final H.
    await expect.poll(async () => (await fixture.inspect()).provider_stage).toBe('finished');
    const final = nativeBarrier(await fixture.inspect(), commands, receipts, null, 2);
    check = 'dto'; const finalProof = publicProof(await latestProof(fixture, sid), proofOptions(final, 1, true));
    await ready(b, finalProof, 1); events.push('b-completed2');
    expect(isDeepStrictEqual(await displayedBlock(run(b, 0)), firstDisplay) && (await normalizedDom(run(b, 0))) === firstDom).toBe(true);
    await exact(b.locator('.command > pre'), receiptText); const newestDom = await normalizedDom(run(b, 1));
    await boundary(b, contextB, fixture.owner, markers);
    console.log(`Client handoff later submission: head=${final.sequence_count}; explicit_tasks=2; distinct_runs=true; first_block_unchanged=true; restored_history=${final.restored_history}; dom_ready=true; receipt=${JSON.stringify(receipts[1])}`);

    stage = 'reopened-a'; reopenedA = await browser.newContext({ serviceWorkers: 'block' }); freshA = await observer(reopenedA, 2); events.push('a-reopened');
    await freshA.goto(`${fixture.origin}/#session=${sid}`); await freshMemory(freshA, 2);
    const [aReply] = await Promise.all([freshA.waitForResponse(response => records[2].snapshots.some(item => item.request === response.request())), connect(freshA)]);
    await exact(status(freshA), 'connected; observation: streaming'); await expect.poll(() => records[2].streams.length).toBe(1); events.push('a-connected');
    check = 'dto'; const reopened = publicProof(await latestProof(fixture, sid), proofOptions(final, 1, true)); expect(isDeepStrictEqual(reopened, finalProof)).toBe(true);
    check = 'handshake'; expect(freshHandshake({ origin: fixture.origin, sid, head: final.sequence_count, value: reopened,
      snapshots: records[2].snapshots, streams: records[2].streams, reply: aReply })).toBe(true);
    expect(aReply.headers()['cache-control'] === 'no-store' && aReply.headers()['content-type'].startsWith('application/json')).toBe(true);
    // Scope parity to the newest run; older viewport filling is legitimate and independent.
    await ready(freshA, reopened, 1); expect(isDeepStrictEqual(await displayedBlock(run(freshA, 1)), await displayedBlock(run(b, 1)))).toBe(true);
    expect((await normalizedDom(run(freshA, 1))) === newestDom).toBe(true); events.push('final-parity');
    await expect(freshA.locator('.command')).toHaveCount(0); await expect(freshA.getByLabel('Task', { exact: true })).toHaveValue('');
    await boundary(freshA, reopenedA, fixture.owner, markers); expect(readOnly(records[2].requests)).toBe(true);
    check = 'native'; expect(unchangedNative(await fixture.inspect(), final)).toBe(true);
    check = 'order'; expect(handoffOrder(events, [contextA, contextB, reopenedA], commands, receipts)).toBe(true);
    check = 'assets'; await Promise.all(assetReads);
    expect(records.every(record => record.assets.size === files.size && [...files.keys()].every(file => record.assets.has(file)))).toBe(true);
    check = 'requests'; expect(isDeepStrictEqual(records.map(record => record.requests.filter(request => request.method === 'POST').map(request => request.path)),
      [['/v1/sessions', `/v1/sessions/${sid}/runs`], [`/v1/sessions/${sid}/runs`], []])).toBe(true);
    expect(records.every(record => !record.requests.some(request => request.path.endsWith('/cancel'))) && Object.values(faults).every(value => value === 0)).toBe(true);
    console.log(`Client handoff final: head=${final.sequence_count}; tasks=2; receipts=2; requests=${final.requests}; connections=${final.connections}; auth_loads=${final.auth_loads}; auth_prepares=${final.auth_prepares}; prepared_exact=${final.prepared_exact}; fresh_parents=${final.fresh_parents}; continuations=${final.continuations}; tools=${final.tool_results}; completed=${final.completed}; terminals=${final.terminals}; results=${final.results}; fresh_empty=${final.fresh_empty}; restored_history=${final.restored_history}; provider_stage=${final.provider_stage}; provider_failed=${final.provider_failed}; read_failure=${final.read_failure}; contexts=3; typed_proofs=5; original_handshakes=2; newest_dom_equal=true; native_unchanged=true; assets_per_context=${files.size}; faults=${JSON.stringify(faults)}; events=${JSON.stringify(events)}`);
  } catch {
    failure = new Error(`Client handoff failed: stage=${stage}; check=${check}`);
  } finally {
    try { if (reopenedA) { await reopenedA.close(); cleanup.reopened = true; } } catch { failure ??= new Error('Client handoff cleanup failed: reopened A'); }
    try { if (contextB) { await contextB.close(); cleanup.b = true; } } catch { failure ??= new Error('Client handoff cleanup failed: B'); }
    try { if (contextA && !cleanup.a) { await contextA.close(); cleanup.a = true; } } catch { failure ??= new Error('Client handoff cleanup failed: A'); }
    try { if (fixture) { await fixture.stop(); cleanup.fixture = true; } } catch { failure ??= new Error('Client handoff cleanup failed: fixture'); }
    const evidence = fixture?.evidence(); console.log(`Client handoff cleanup: ${JSON.stringify({ ...cleanup, evidence })}`);
    try { if (fixture) strictStop(evidence); } catch { failure ??= new Error('Client handoff strict Stop rejected'); }
  }
  if (failure) throw failure;
});
