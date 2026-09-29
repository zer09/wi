import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { installAcceptanceWarningObserver } from '../test-support/acceptance-warning.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
// Exact TASKS[0] permits the independent closed SQLite task audit, without weakening it.
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('one Send accepts a committed cleanup warning without provider work or false completion', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let sid;
  let taskPath;
  let durable;
  let observed = null;
  let memory = null;
  let assetEvidence = null;
  let stage = 'startup';
  const wire = { create: null, task: null };
  const posts = { create: 0, task: 0, other: 0 };
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, response: 0, reconcile: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary',
      'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => secrets.some(secret => text.includes(secret));
    // Keep the installed failure-recorder guard enabled through owned context close.
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
        const fields = kind === 'task' ? 'operation_id,run_id,text' : 'operation_id,title,workspace';
        if (wire[kind] !== null || Object.keys(body).sort().join(',') !== fields || !uuid(body.operation_id)
          || (kind === 'task' && !uuid(body.run_id))) { faults.request++; return; }
        const expected = kind === 'task' ? { operation_id: body.operation_id, run_id: body.run_id, text: TASK }
          : { operation_id: body.operation_id, title: titles[0], workspace: body.workspace };
        if (raw !== JSON.stringify(expected) || leaked(raw)) faults.request++;
        wire[kind] = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300) faults.response++;
      if (files.has(path)) assets.add(path);
    });
    // Observe a bounded in-page clone before app requests. Never read DevTools response bodies.
    await context.addInitScript(installAcceptanceWarningObserver, { secrets });
    page = await context.newPage();
    page.on('console', message => {
      if (leaked(message.text()) || leaked(message.location().url)) faults.secret++;
      faults.console++; // HTTP 202 has no expected resource error or other console output.
    });
    page.on('pageerror', () => { faults.page++; });
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
      expect(await page.locator('.command em,.run em,.run img,.run script,.run a,.conversation h2 em,img,iframe').count()).toBe(0);
    }
    async function noWork(accepted) {
      const proof = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.completed,
        proof.prepared_exact, proof.fresh_parents, proof.continuations, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(11).fill(0));
      expect([proof.response_finishes, proof.terminal_sequences, proof.result_sequences].every(items => items.length === 0)).toBe(true);
      expect(proof.gate === null && proof.provider_stage === 'request' && !proof.provider_failed && proof.read_failure === null).toBe(true);
      expect([proof.accepted.length, proof.receipts.length]).toEqual(accepted ? [1, 1] : [0, 0]);
      expect(proof.sequence_count).toBe(accepted ? '3' : '1');
      if (accepted) {
        // The closed audit derives commands, receipts, selection digest and run projection from SQLite.
        // Its warning-only path also checks the unchanged seed and the empty tool table.
        const { id: _id, ...audit } = await fixture.inspectTask();
        expect(audit.exact && audit.run_state === 'accepted' && audit.sequence_count === '3').toBe(true);
        expect([audit.task_commands, audit.runs, audit.acceptance_events, audit.selection_events,
          audit.binding_events, audit.rename_events, audit.deltas, audit.tool_starts, audit.tool_finishes]).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0]);
        expect(audit.receipt.operation_id === wire.task.operation_id && audit.receipt.session_id === sid
          && audit.receipt.run_id === wire.task.run_id && audit.receipt.first_sequence === '2' && audit.receipt.last_sequence === '3').toBe(true);
        expect(JSON.stringify(proof.receipts[0]) === JSON.stringify(audit.receipt)
          && proof.accepted[0].run_id === wire.task.run_id && proof.accepted[0].accepted_sequence === '2').toBe(true);
        if (durable === undefined) durable = audit;
        else expect(JSON.stringify(audit) === JSON.stringify(durable)).toBe(true);
      } else {
        const audit = await fixture.inspectMutations();
        expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
        const entry = audit.creations[0];
        expect(entry.exact && entry.catalog_current && entry.sequence_count === '1' && entry.catalog_head_sequence === '1'
          && entry.rename_events === 0 && entry.renames.length === 0 && entry.rename_event_ids.length === 0
          && entry.receipt.session_id === sid && entry.receipt.operation_id === wire.create.operation_id).toBe(true);
      }
      expect(posts).toEqual({ create: 1, task: accepted ? 1 : 0, other: 0 });
      expect(faults.reconcile).toBe(0);
    }
    const task = page.getByLabel('Task', { exact: true });
    const outcome = page.locator('.commands > section > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const run = page.locator('.run');
    const title = page.getByRole('heading', { name: 'Canonical session title', exact: true });
    async function acceptedTruth() {
      await exact(outcome, `task command\n\nAccepted receipt (not completion)\nOperation: ${wire.task.operation_id}\nSession: ${sid}\nRun: ${wire.task.run_id}\nSequences: 2 to 3\n\nDuplicate receipt: false\nWarning: storage.connection_cleanup_failed`);
      await expect(outcome).toBeVisible();
      await expect(run).toHaveCount(1);
      await exact(run.locator('.user-text'), TASK);
      await exact(run.locator(':scope > .metadata'), `Run: ${wire.task.run_id}\nAccepted at sequence: 2`);
      await exact(run.locator(':scope > p:not(.metadata)'), 'Execution: accepted. Final result not recorded.');
      await exact(page.locator('p.metadata').filter({ hasText: /^Applied cursor:/ }), `Applied cursor: ${sid}:3\nSnapshot head: 1`);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming; run: accepted; result not recorded');
      await expect(page.locator('.command,.run .entry')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Retry identical command', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true })).toHaveCount(0);
      expect(await task.inputValue() === '').toBe(true);
      memory = await page.evaluate(expected => globalThis.acceptanceWarningCapture.memory(expected),
        { operation: wire.task.operation_id, run: wire.task.run_id, text: TASK });
      expect(Object.values(memory)).toEqual(Array(9).fill(true));
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
    const audit = await fixture.inspectMutations();
    sid = audit.creations[0].receipt.session_id;
    taskPath = `/v1/sessions/${sid}/runs`;
    await page.evaluate(sid => globalThis.acceptanceWarningCapture.select(sid), sid);
    await fixture.request({ command: 'select', session_id: sid });
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(title, titles[0]);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await noWork(false);
    await privateBoundary();

    stage = 'one armed cleanup warning and one Send';
    expect((await fixture.request({ command: 'arm_acceptance_warning' })).event === 'acceptance_warning_armed').toBe(true);
    await task.fill(TASK);
    expect(await task.inputValue() === TASK).toBe(true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await outcome.textContent()).includes('Warning: storage.connection_cleanup_failed')).toBe(true);
    await page.evaluate(() => globalThis.acceptanceWarningCapture.drain());
    observed = await page.evaluate(() => globalThis.acceptanceWarningCapture.summary());
    expect(observed).toEqual({ count: 1, reply: { status: 202, decoded: true, validated: true, exact: true }, failures: [] });
    await acceptedTruth();
    await noWork(true);
    await privateBoundary();

    stage = 'finite stable acceptance without retry or completion';
    await page.waitForTimeout(500);
    await acceptedTruth();
    await exact(title, titles[0]);
    await noWork(true);
    await privateBoundary();

    stage = 'embedded asset integrity and Disconnect clearing';
    await expect.poll(() => assets.size).toBe(files.size);
    assetEvidence = await page.evaluate(checkEmbeddedAssets, { secrets,
      files: await Promise.all([...files].map(async ([path, file]) => [path, [...await readFile(new URL(`../${file}`, import.meta.url))]])) });
    expect(assetEvidence).toEqual({ checked: files.size, failures: [] });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(outcome, '');
    await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(() => globalThis.acceptanceWarningCapture.cleared())).toBe(true);
    expect(await page.evaluate(canaries => {
      const nodes = Array.from(document.querySelectorAll('input,textarea,select'));
      const values = [document.documentElement.outerHTML, ...nodes.map(node => node.value)];
      return nodes.every(node => node.value === '') && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [TASK, titles[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(true);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    expect(await page.evaluate(() => globalThis.acceptanceWarningCapture.summary())).toEqual(observed);
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure = new Error(`Acceptance warning failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; memory=${JSON.stringify(memory)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      // Failed close leaves the guard enabled for Playwright's later fixture cleanup.
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Acceptance warning browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Acceptance warning fixture cleanup failed'); }
  }
  console.log(`Acceptance warning cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  console.log(`Acceptance warning evidence: HTTP=202 task_accepted_exact=${observed.reply.exact} captures=${observed.count} assets_checked=${assetEvidence.checked}; create_posts=${posts.create} task_posts=${posts.task} other_posts=${posts.other}; task_bytes=${Buffer.byteLength(TASK)} immutable_command_exact=${memory.commandExact} last_mutation_exact=${memory.lastMutationExact}; sessions=2 browser_sequence=3 seed_sequence=1 task_commands=1 task_receipts=1 runs_accepted=1 checkpoints=1 runtime=0 bindings=0 results=0 terminals=0 interrupts=0 renames=0 tools=0 provider_connections=0 provider_requests=0 auth_loads=0 auth_prepares=0 cancel=0 retry=0 reconcile=0 console=0 observation_ms=500 disconnect_cleared=true`);
});
