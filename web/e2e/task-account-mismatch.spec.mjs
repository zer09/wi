import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { installAccountMismatchObserver } from '../test-support/account-mismatch.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const OUTPUT = '{"sum":42}';
const EDIT = '  edited before Send 雪\n<em>not submitted</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('account mismatch is an accepted execution failure without sending history on the second WebSocket', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let sid;
  let taskPath;
  let firstHead;
  let finalAudit;
  let stableProof;
  let observed = null;
  let memory = null;
  let assetEvidence = null;
  let stage = 'startup';
  const wire = { create: null, tasks: [] };
  const posts = { create: 0, task: 0, other: 0 };
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, response: 0, reconcile: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    // Prefixes detect private fixture material without placing provider identities or digests in the page.
    const privateMarkers = ['synthetic-replay-', 'synthetic-account-', 'private-operator-', 'private-project-', 'private-skill-',
      'private-support-', 'private-native', 'private-skills', 'private-data', 'principal_digest', 'encrypted_content',
      'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || privateMarkers.some(marker => text.includes(marker));
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
      else await route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.secret++;
      if (url.pathname.startsWith('/v1/') && request.headers().authorization !== `Bearer ${fixture.owner}`) faults.request++;
      if (request.method() !== 'POST') {
        if (request.method() !== 'GET') faults.request++;
        if (/\/(operations|runs)\//.test(url.pathname)) faults.reconcile++;
        return;
      }
      let kind;
      if (url.pathname === '/v1/sessions') kind = 'create';
      else if (url.pathname === taskPath) kind = 'task';
      else { posts.other++; return; }
      posts[kind]++;
      try {
        const bytes = request.postDataBuffer();
        if (bytes === null || bytes.byteLength > 4096) { faults.request++; return; }
        const raw = bytes.toString('utf8');
        const body = JSON.parse(raw);
        if (Object.keys(body).sort().join(',') !== (kind === 'task' ? 'operation_id,run_id,text' : 'operation_id,title,workspace')
          || !uuid(body.operation_id) || (kind === 'task' && (!uuid(body.run_id) || wire.tasks.length === 2))
          || (kind === 'create' && wire.create !== null)) { faults.request++; return; }
        const expected = kind === 'task' ? { operation_id: body.operation_id, run_id: body.run_id, text: TASKS[wire.tasks.length] }
          : { operation_id: body.operation_id, title: titles[0], workspace: body.workspace };
        if (raw !== JSON.stringify(expected) || leaked(raw)) faults.request++;
        if (kind === 'task') wire.tasks.push(body); else wire.create = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      if (response.status() >= 300) faults.response++;
      const path = new URL(response.url()).pathname;
      if (files.has(path)) assets.add(path);
    });
    await context.addInitScript(installAccountMismatchObserver);
    page = await context.newPage();
    page.on('console', message => { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.secret++; });
    page.on('pageerror', () => { faults.page++; });
    async function privateBoundary() {
      const evidence = await page.evaluate(async () => ({ values: [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
        ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)],
      empty: localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
        && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
        && (await navigator.serviceWorker.getRegistrations()).length === 0 }));
      expect(evidence.empty && !evidence.values.some(value => value && leaked(value))).toBe(true);
      expect((await context.cookies()).length).toBe(0);
      expect(await page.locator('.command em,.run em,.run img,.run script,.run a,img,iframe').count()).toBe(0);
    }
    const task = page.getByLabel('Task', { exact: true });
    const outcome = page.locator('.commands > section > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const run = page.locator('.run');
    const cursor = page.locator('p.metadata').filter({ hasText: /^Applied cursor:/ });
    const expectedCommand = index => ({ operation: wire.tasks[index].operation_id, run: wire.tasks[index].run_id, text: TASKS[index] });
    async function receiptTruth(index, first, last) {
      await exact(outcome, `task command\n\nAccepted receipt (not completion)\nOperation: ${wire.tasks[index].operation_id}\nSession: ${sid}\nRun: ${wire.tasks[index].run_id}\nSequences: ${first} to ${last}\n\nDuplicate receipt: false`);
      await expect(page.locator('.command')).toHaveCount(0);
      for (const name of ['Retry identical command', 'Reconcile receipt (read only)']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    async function firstTruth() {
      await exact(run.nth(0).locator('.user-text'), TASKS[0]);
      await exact(run.nth(0).locator(':scope > p:not(.metadata)'), 'Execution: completed. Final result recorded.');
      await occurrences(run.nth(0), ANSWER, 1);
      await occurrences(run.nth(0), OUTPUT, 1);
      await occurrences(run.nth(0), '{"a":17,\r\n "b":25}', 1);
      await expect(run.nth(0).locator('.entry')).toHaveCount(3);
      const tool = run.nth(0).locator('.entry').filter({ has: page.getByRole('heading', { name: 'Tool: add_numbers', exact: true }) });
      expect((await tool.textContent()).includes('finished (success)') && (await tool.textContent()).includes('Result: success')).toBe(true);
      expect((await run.nth(0).textContent()).includes('Terminal outcome: completed') && (await run.nth(0).textContent()).includes('Outcome: completed')).toBe(true);
    }
    async function finalTruth(draft) {
      await expect(run).toHaveCount(2);
      await firstTruth();
      await exact(run.nth(1).locator('.user-text'), TASKS[1]);
      await exact(run.nth(1).locator(':scope > p:not(.metadata)'), 'Execution: failed. Final result recorded.');
      await expect(run.nth(1).locator('.entry')).toHaveCount(0);
      const details = await run.nth(1).locator(':scope > details > pre').textContent();
      expect(details.includes('Terminal outcome: failed\nCode: history_identity') && details.includes('Outcome: failed\nCode: history_identity')
        && details.includes('model_requests_attempted: 0') && details.includes('model_requests_admitted: 0')
        && details.includes('last_upstream_outcome: none') && details.includes('new_tool_dispatches: 0')).toBe(true);
      await receiptTruth(1, finalAudit.receipt.first_sequence, finalAudit.receipt.last_sequence);
      await exact(cursor, `Applied cursor: ${sid}:${finalAudit.sequence_count}\nSnapshot head: 1`);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming; run: failed; result recorded');
      expect(await task.inputValue() === draft).toBe(true);
      memory = await page.evaluate(expected => globalThis.accountMismatchCapture.completed(expected),
        { first: expectedCommand(0), second: expectedCommand(1), draft, head: finalAudit.sequence_count });
      expect(Object.values(memory)).toEqual(Array(10).fill(true));
    }
    async function quiet() {
      const { id: _audit, ...audit } = await fixture.inspectTask();
      const { id: _proof, ...proof } = await fixture.inspect();
      expect(JSON.stringify(audit) === JSON.stringify(finalAudit)).toBe(true);
      expect(JSON.stringify(proof) === JSON.stringify(stableProof)).toBe(true);
      expect(posts).toEqual({ create: 1, task: 2, other: 0 });
      expect(faults.reconcile).toBe(0);
    }

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect.poll(async () => (await outcome.textContent()).includes('Accepted receipt (not completion)')).toBe(true);
    const creation = await fixture.inspectMutations();
    expect([creation.session_count, creation.seed_sessions, creation.creations.length]).toEqual([2, 1, 1]);
    sid = creation.creations[0].receipt.session_id;
    expect(creation.creations[0].exact && creation.creations[0].sequence_count === '1').toBe(true);
    taskPath = `/v1/sessions/${sid}/runs`;
    await page.evaluate(sid => globalThis.accountMismatchCapture.select(sid), sid);
    await fixture.request({ command: 'select', session_id: sid });
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await privateBoundary();

    stage = 'first normal acceptance and real tool completion';
    await task.fill(EDIT); await task.fill(TASKS[0]);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await fixture.wait('model_paused', 1);
    await receiptTruth(0, '2', '3');
    await fixture.request({ command: 'drive', gate: 1 });
    await fixture.wait('model_paused', 2);
    await occurrences(run.nth(0), OUTPUT, 1);
    await fixture.request({ command: 'drive', gate: 2 });
    await fixture.wait('model_paused', 3);
    await occurrences(run.nth(0), '42 雪', 1);
    await fixture.request({ command: 'drive', gate: 3 });
    await fixture.wait('task_finished', 1);
    const first = await fixture.inspectTask();
    firstHead = first.sequence_count;
    expect(first.exact && first.run_state === 'completed' && first.binding_events === 1 && first.tool_starts === 1 && first.tool_finishes === 1).toBe(true);
    await exact(cursor, `Applied cursor: ${sid}:${firstHead}\nSnapshot head: 1`);
    await firstTruth();
    await page.evaluate(() => globalThis.accountMismatchCapture.drain());
    memory = await page.evaluate(({ expected, head }) => globalThis.accountMismatchCapture.first(expected, head), { expected: expectedCommand(0), head: firstHead });
    expect(Object.values(memory)).toEqual(Array(6).fill(true));
    const firstProof = await fixture.inspect();
    expect([firstProof.connections, firstProof.requests, firstProof.auth_loads, firstProof.auth_prepares, firstProof.tool_results, firstProof.terminals, firstProof.results]).toEqual([1, 2, 1, 1, 1, 1, 1]);
    await privateBoundary();

    stage = 'one-shot private rotation after audited completion';
    expect((await fixture.request({ command: 'rotate_account' })).event === 'account_rotated').toBe(true);
    await task.fill(EDIT);
    memory = await page.evaluate(({ expected, head }) => globalThis.accountMismatchCapture.first(expected, head), { expected: expectedCommand(0), head: firstHead });
    expect(Object.values(memory)).toEqual(Array(6).fill(true));
    await task.fill(TASKS[1]);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(run.nth(1).locator(':scope > p:not(.metadata)')).toHaveText('Execution: failed. Final result recorded.');
    await page.evaluate(() => globalThis.accountMismatchCapture.drain());
    observed = await page.evaluate(() => globalThis.accountMismatchCapture.summary());
    expect(observed).toEqual({ count: 2, replies: [202, 202].map(status => ({ status, decoded: true, validated: true, exact: true })), failures: [] });
    const { id: _finalId, ...audit } = await fixture.inspectTask(); finalAudit = audit;
    const { id: _proofId, ...proof } = await fixture.inspect(); stableProof = proof;
    expect(finalAudit.exact && finalAudit.first_head === firstHead && finalAudit.history_unchanged && finalAudit.identity_checked && finalAudit.socket_closed).toBe(true);
    expect(finalAudit.receipt.operation_id === wire.tasks[1].operation_id && finalAudit.receipt.run_id === wire.tasks[1].run_id && finalAudit.receipt.session_id === sid).toBe(true);
    expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.tool_results, proof.terminals, proof.results, proof.completed]).toEqual([2, 2, 2, 2, 1, 2, 2, 1]);
    expect(proof.response_finishes.length === 2 && !proof.provider_failed && proof.read_failure === null).toBe(true);
    await finalTruth('');
    await privateBoundary();

    stage = 'finite no-auto-action interval and stable canonical failure';
    await task.fill(EDIT);
    await page.waitForTimeout(500);
    await finalTruth(EDIT);
    await quiet();
    await privateBoundary();
    await expect.poll(() => assets.size).toBe(files.size);
    assetEvidence = await page.evaluate(checkEmbeddedAssets, { secrets: privateMarkers,
      files: await Promise.all([...files].map(async ([path, file]) => [path, [...await readFile(new URL(`../${file}`, import.meta.url))]])) });
    expect(assetEvidence).toEqual({ checked: files.size, failures: [] });

    stage = 'Disconnect clears without cancel or retry';
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(outcome, ''); await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(() => globalThis.accountMismatchCapture.cleared())).toBe(true);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
    await quiet(); await privateBoundary();
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    expect(await page.evaluate(() => globalThis.accountMismatchCapture.summary())).toEqual(observed);
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure = new Error(`Account mismatch failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; memory=${JSON.stringify(memory)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Account mismatch browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Account mismatch fixture cleanup failed'); }
  }
  console.log(`Account mismatch cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  console.log(`Account mismatch evidence: normal_202=2 execution_failed=history_identity result_recorded=true assets=${assetEvidence.checked} task_posts=2 extra_posts=0 second_model_attempted=0 second_model_admitted=0 second_tools=0 auth_loads=2 auth_prepares=2 provider_connections=2 provider_requests=2 seed_head=1 observation_ms=500 disconnect_cleared=true`);
});
