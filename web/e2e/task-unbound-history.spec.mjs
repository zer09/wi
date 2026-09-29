import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { installUnboundHistoryObserver } from '../test-support/unbound-history.mjs';

const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const TITLE = 'Legacy completed conversation';
const EDIT = '  edited but not sent 雪\n<em>unsent</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('completed legacy history stays readable but one explicit Send rejects unbound replay without any new work', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let stage = 'startup';
  let observed = null;
  let memory = null;
  let assetEvidence = null;
  let durable;
  let sent;
  let resourceErrors = 0;
  const posts = { create: 0, task: 0, rename: 0, cancel: 0, other: 0 };
  const reads = { manifest: 0, history: 0, events: 0, reconcile: 0 };
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, response: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true, unbound_history: true });
    const sid = fixture.sessionId;
    const taskPath = `/v1/sessions/${sid}/runs`;
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary', 'principal_digest',
      'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request', 'stored history has no replay provenance'];
    const leaked = text => secrets.some(secret => text.includes(secret));
    // Keep the installed failure recorder disabled until this owned context actually closes.
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
        if (url.pathname === `/v1/sessions/${sid}`) reads.manifest++;
        if (url.pathname === `/v1/sessions/${sid}/history`) reads.history++;
        if (url.pathname === `/v1/sessions/${sid}/events`) reads.events++;
        if (/\/(operations|runs)\//.test(url.pathname)) reads.reconcile++;
        return;
      }
      if (url.pathname === '/v1/sessions') { posts.create++; return; }
      if (url.pathname.endsWith('/rename')) { posts.rename++; return; }
      if (url.pathname.endsWith('/cancel')) { posts.cancel++; return; }
      if (url.pathname !== taskPath) { posts.other++; return; }
      posts.task++;
      try {
        const bytes = request.postDataBuffer();
        if (bytes === null || bytes.byteLength > 4096 || sent !== undefined) { faults.request++; return; }
        const raw = bytes.toString('utf8');
        const body = JSON.parse(raw);
        if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || !uuid(body.operation_id) || !uuid(body.run_id)
          || new Set([sid, body.operation_id, body.run_id]).size !== 3
          || raw !== JSON.stringify({ operation_id: body.operation_id, run_id: body.run_id, text: TASKS[1] }) || leaked(raw)) faults.request++;
        sent = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300 && !(path === taskPath && response.request().method() === 'POST' && response.status() === 422)) faults.response++;
      if (files.has(path)) assets.add(path);
    });
    await context.addInitScript(installUnboundHistoryObserver, { secrets, legacyText: TASKS[0], legacyAnswer: ANSWER });
    page = await context.newPage();
    page.on('console', message => {
      const text = message.text();
      if (leaked(text) || leaked(message.location().url)) faults.secret++;
      if (message.type() === 'error' && message.location().url === `${fixture.origin}${taskPath}`
        && text === 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)') {
        resourceErrors++; return;
      }
      faults.console++;
    });
    page.on('pageerror', () => { faults.page++; });
    const task = page.getByLabel('Task', { exact: true });
    const command = page.locator('.command');
    const run = page.locator('.run');
    const outcome = page.locator('.commands > section > pre');
    async function privateBoundary() {
      expect(await page.evaluate(async secrets => {
        const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
        return !secrets.some(secret => values.some(value => value?.includes(secret)))
          && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0;
      }, secrets)).toBe(true);
      expect((await context.cookies()).length).toBe(0);
      expect(await page.locator('.command em,.command img,.command script,.command a,.run em,.run img,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function noWork(tasks) {
      const { id: _id, ...proof } = await fixture.inspect();
      expect(proof.session_id === sid && proof.exact && proof.unchanged && proof.replay_rejected && proof.completed && proof.result_recorded).toBe(true);
      expect([proof.sequence_count, proof.seed_head]).toEqual(['9', '1']);
      expect([proof.acceptances, proof.runtime, proof.results]).toEqual([1, 6, 1]);
      expect([proof.selections, proof.bindings, proof.tools, proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares]).toEqual(Array(7).fill(0));
      if (durable === undefined) durable = proof;
      else expect(JSON.stringify(proof) === JSON.stringify(durable)).toBe(true);
      expect(posts).toEqual({ create: 0, task: tasks, rename: 0, cancel: 0, other: 0 });
      expect(reads.reconcile).toBe(0);
    }
    async function canonicalTruth() {
      await expect(run).toHaveCount(1);
      await exact(run.locator('.user-text'), TASKS[0]);
      await expect(run.locator('.entry')).toHaveCount(1);
      await exact(run.locator('.entry > div > section > pre'), ANSWER);
      await exact(run.locator(':scope > p:not(.metadata)'), 'Execution: completed. Final result recorded.');
      await exact(page.locator('p.metadata').filter({ hasText: /^Applied cursor:/ }), `Applied cursor: ${sid}:9\nSnapshot head: 9`);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming; run: completed; result recorded');
      await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), TITLE);
      await exact(outcome, '');
      expect((await page.locator('.transcript').textContent()).includes(TASKS[1])).toBe(false);
    }
    async function rejectedTruth(draft) {
      await canonicalTruth();
      await expect(command).toHaveCount(1);
      await exact(command.locator('h3'), 'task: rejected');
      await exact(command.locator(':scope > pre'), 'HTTP 422\nCode: invalid_request\nStage: history\nCertainty: not_applicable');
      await exact(command.locator('details pre'), TASKS[1]);
      await exact(command.locator('.metadata'), `Operation: ${sent.operation_id}\nSession: ${sid}`);
      expect(await task.inputValue() === draft).toBe(true);
      for (const name of ['Retry identical command', 'Reconcile receipt (read only)']) {
        await expect(command.getByRole('button', { name, exact: true })).toBeVisible();
        await expect(command.getByRole('button', { name, exact: true })).toBeEnabled();
      }
      memory = await page.evaluate(expected => globalThis.unboundHistoryCapture.rejected(expected),
        { operation: sent.operation_id, run: sent.run_id, text: TASKS[1], draft });
      expect(Object.values(memory)).toEqual(Array(9).fill(true));
    }

    stage = 'real browser opens seeded legacy history';
    await noWork(0);
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.evaluate(sid => globalThis.unboundHistoryCapture.select(sid), sid);
    await page.locator('.session-list').getByRole('button', { name: TITLE, exact: true }).click();
    await canonicalTruth();
    expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    expect(await page.evaluate(() => globalThis.unboundHistoryCapture.legacy())).toBe(true);
    expect(reads).toEqual({ manifest: 1, history: 1, events: 1, reconcile: 0 });
    await noWork(0);
    await privateBoundary();

    stage = 'one explicit Send rejects unbound replay';
    await task.fill('draft before editing');
    await task.fill(TASKS[1]);
    expect(await task.inputValue() === TASKS[1]).toBe(true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await exact(command.locator('h3'), 'task: rejected');
    await page.evaluate(() => globalThis.unboundHistoryCapture.drain());
    observed = await page.evaluate(() => globalThis.unboundHistoryCapture.summary());
    expect(observed).toEqual({ count: 1, reply: { status: 422, decoded: true, validated: true, exact: true }, failures: [] });
    await command.locator('summary').click();
    await rejectedTruth(TASKS[1]);
    await noWork(1);
    await privateBoundary();

    stage = 'finite no-auto-action interval preserves edited current draft';
    await task.fill(EDIT);
    await page.waitForTimeout(500);
    await rejectedTruth(EDIT);
    await noWork(1);
    await privateBoundary();
    expect(reads).toEqual({ manifest: 1, history: 1, events: 1, reconcile: 0 });

    stage = 'exact assets and Disconnect stability';
    await expect.poll(() => assets.size).toBe(files.size);
    assetEvidence = await page.evaluate(checkEmbeddedAssets, { secrets,
      files: await Promise.all([...files].map(async ([path, file]) => [path, [...await readFile(new URL(`../${file}`, import.meta.url))]])) });
    expect(assetEvidence).toEqual({ checked: files.size, failures: [] });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(outcome, '');
    await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(() => globalThis.unboundHistoryCapture.cleared())).toBe(true);
    expect(await page.evaluate(canaries => {
      const nodes = Array.from(document.querySelectorAll('input,textarea,select'));
      const values = [document.documentElement.outerHTML, ...nodes.map(node => node.value)];
      return nodes.every(node => node.value === '') && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [...TASKS, EDIT, TITLE, ANSWER])).toBe(true);
    await page.waitForTimeout(500);
    await noWork(1);
    await privateBoundary();
    expect(resourceErrors).toBe(1);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect(await page.evaluate(() => globalThis.unboundHistoryCapture.summary())).toEqual(observed);
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure = new Error(`Unbound history failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; memory=${JSON.stringify(memory)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}; reads=${JSON.stringify(reads)}; resource_errors=${resourceErrors}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Unbound history browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Unbound history fixture cleanup failed'); }
  }
  console.log(`Unbound history cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  console.log(`Unbound history evidence: exact_422=${observed.reply.exact} captures=${observed.count} assets_checked=${assetEvidence.checked} immutable=${memory.commandExact} unchanged=true; legacy_accept_run=1 sequences=9 runtime=6 results=1 selections=0 bindings=0 seed_head=1 task_posts=1 other_posts=0 tools=0 connections=0 provider_requests=0 auth=0 retry=0 reconcile=0 observation_ms=500 disconnect_stable=true`);
});
