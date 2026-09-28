import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { checkEmbeddedAssets, installStaleHistoryObserver } from '../test-support/stale-history.mjs';

const { titles, renames } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const TASK = '  Stale head 雪\n<em>task & inert</em>\n  ';
const EDIT = '  edited but not sent 雪\n<em>unsent</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('one Send rejects stale captured history after one real browser rename commits', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let sid;
  let taskPath;
  let renamePath;
  let observed = null;
  let assetEvidence = null;
  let stage = 'startup';
  let resourceErrors = 0;
  const forceObserverFailure = process.env.WI_STALE_HISTORY_FAIL_DEVTOOLS === '1';
  let observerFailures = 0;
  const wire = { create: null, task: null, rename: null };
  const posts = { create: 0, task: 0, rename: 0, other: 0 };
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, asset: 0, response: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary',
      'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => secrets.some(secret => text.includes(secret));
    // No HAR, video, trace or screenshots. Same-origin requests continue to the actual service.
    // Playwright can capture failure DOM snapshots even when those recordings are off.
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
        if (request.method() !== 'GET' || /\/(operations|runs)\//.test(url.pathname)) faults.request++;
        return;
      }
      let kind;
      if (url.pathname === '/v1/sessions') kind = 'create';
      else if (url.pathname === taskPath) kind = 'task';
      else if (url.pathname === renamePath) kind = 'rename';
      else { posts.other++; return; }
      posts[kind]++;
      try {
        // Keep identities only in memory for comparisons. No body, UUID or digest enters diagnostics.
        const raw = request.postDataBuffer();
        const body = JSON.parse(raw.toString('utf8'));
        const fields = { create: 'operation_id,title,workspace', task: 'operation_id,run_id,text', rename: 'operation_id,title' };
        if (wire[kind] !== null || Object.keys(body).sort().join(',') !== fields[kind]
          || !uuid(body.operation_id) || (kind === 'task' && !uuid(body.run_id))) { faults.request++; return; }
        const expected = kind === 'task' ? { operation_id: body.operation_id, run_id: body.run_id, text: TASK }
          : { operation_id: body.operation_id, title: kind === 'create' ? titles[0] : renames[0] };
        if (kind === 'create') expected.workspace = body.workspace;
        if (raw.toString('utf8') !== JSON.stringify(expected) || leaked(raw.toString('utf8'))) faults.request++;
        wire[kind] = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    const reads = new Set();
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      const method = response.request().method();
      if (response.status() >= 300 && !(path === taskPath && method === 'POST' && response.status() === 409)) faults.response++;
      if (forceObserverFailure && path === taskPath && method === 'POST' && response.status() === 409) {
        // Break only the test observer, not the response consumed by the application.
        response.json = response.body = async () => { observerFailures++; throw new Error('forced observer failure'); };
        const read = response.json().then(() => { faults.response++; }, () => {}).finally(() => reads.delete(read));
        reads.add(read);
      }
      if (files.has(path)) assets.add(path);
    });
    await context.addInitScript(installStaleHistoryObserver, { secrets, initialTitle: titles[0], renamedTitle: renames[0] });
    page = await context.newPage();
    async function capture() {
      observed = await page.evaluate(() => globalThis.staleHistoryCapture.summary());
      expect(observed.failures).toEqual([]);
      return observed;
    }
    async function drain() {
      await page.evaluate(() => globalThis.staleHistoryCapture.drain());
      while (reads.size !== 0) await Promise.all(reads);
      await capture();
    }
    page.on('console', message => {
      const text = message.text();
      if (leaked(text) || leaked(message.location().url)) faults.secret++;
      if (message.type() === 'error' && message.location().url === `${fixture.origin}${taskPath}`
        && text === 'Failed to load resource: the server responded with a status of 409 (Conflict)') {
        resourceErrors++; return;
      }
      faults.console++;
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
      expect(await page.locator('.command em,.command img,.command script,.command a,.conversation h2 em,img,iframe').count()).toBe(0);
    }
    async function noWork(tasks, renamed) {
      const proof = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.completed,
        proof.prepared_exact, proof.fresh_parents, proof.continuations, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(11).fill(0));
      expect([proof.accepted, proof.receipts, proof.response_finishes, proof.terminal_sequences, proof.result_sequences].every(items => items.length === 0)).toBe(true);
      expect(proof.sequence_count).toBe(String(1 + renamed));
      expect(proof.gate === null && proof.provider_stage === 'request' && !proof.provider_failed && proof.read_failure === null).toBe(true);
      // The audit reads every event/command/run/tool row in BOTH sessions, including the seed.
      const audit = await fixture.inspectMutations();
      expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
      const entry = audit.creations[0];
      expect(entry.exact && entry.catalog_current && entry.sequence_count === String(1 + renamed)
        && entry.catalog_head_sequence === entry.sequence_count && entry.rename_events === renamed
        && entry.renames.length === renamed && entry.rename_event_ids.length === renamed
        && entry.receipt.session_id === sid && entry.receipt.operation_id === wire.create.operation_id).toBe(true);
      if (renamed) expect(await page.evaluate(({ receipt, operation }) => globalThis.staleHistoryCapture.matchesRename(receipt, operation),
        { receipt: entry.renames[0], operation: wire.rename.operation_id })).toBe(true);
      expect(posts).toEqual({ create: 1, task: tasks, rename: renamed, other: 0 });
    }
    async function preserved(locator, expected, input = false) {
      expect(await locator.evaluate((node, { expected, input }) => {
        const actual = input ? node.value : node.textContent;
        return actual === expected && new TextEncoder().encode(actual).length === new TextEncoder().encode(expected).length;
      }, { expected, input })).toBe(true);
    }
    const task = page.getByLabel('Task', { exact: true });
    const command = page.locator('.command');
    const outcome = page.locator('.commands > section > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const title = page.getByRole('heading', { name: 'Canonical session title', exact: true });

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
    renamePath = `/v1/sessions/${sid}/rename`;
    await page.evaluate(sid => globalThis.staleHistoryCapture.select(sid), sid);
    await fixture.request({ command: 'select', session_id: sid });
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(title, titles[0]);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await noWork(0, 0);
    await privateBoundary();

    stage = 'one explicit Send paused after replay-head capture';
    expect((await fixture.request({ command: 'replay_head', step: 'arm' })).step).toBe('armed');
    await task.fill(TASK);
    await preserved(task, TASK, true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect((await fixture.request({ command: 'replay_head', step: 'wait' })).step).toBe('paused');
    await exact(command.locator('h3'), 'task: sending');
    await command.locator('summary').click();
    await preserved(command.locator('details pre'), TASK);
    await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
    expect((await capture()).reply.status).toBe(null);
    await noWork(1, 0);

    stage = 'one real browser rename commits before task release';
    const rename = page.getByLabel('Exact new title', { exact: true });
    await rename.fill(renames[0]);
    await preserved(rename, renames[0], true);
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    await expect.poll(async () => { const value = await capture(); return value.rename && value.canonicalRename; }).toBe(true);
    await exact(outcome, `rename command\n\nAccepted receipt (not completion)\nOperation: ${wire.rename.operation_id}\nSession: ${sid}\nRun: none\nSequences: 2 to 2\n\nDuplicate receipt: false\nIndependent catalog refresh: updated`);
    await exact(title, renames[0]);
    await expect.poll(async () => (await page.locator('.conversation').textContent()).includes(`Applied cursor: ${sid}:2\n`)).toBe(true);
    await exact(command.locator('h3'), 'task: sending');
    await preserved(task, TASK, true);
    await preserved(command.locator('details pre'), TASK);
    expect((await capture()).reply.status).toBe(null);
    await noWork(1, 1);
    await privateBoundary();

    stage = 'release and exact stale-history rejection';
    expect((await fixture.request({ command: 'replay_head', step: 'release' })).step).toBe('released');
    await exact(command.locator('h3'), 'task: rejected');
    await drain();
    expect(observed.reply).toEqual({ status: 409, decoded: true, validated: true, exact: true });
    expect(observed.counts).toEqual({ task: 1, rename: 1, manifest: 2 });
    expect(observerFailures).toBe(forceObserverFailure ? 1 : 0);
    await exact(command.locator(':scope > pre'), 'HTTP 409\nCode: storage.stale_history\nStage: acceptance\nCertainty: not_committed');
    await preserved(task, TASK, true);
    await preserved(command.locator('details pre'), TASK);
    await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
    await exact(title, renames[0]);
    await exact(transcript, 'No messages yet.');
    await expect(page.locator('.run')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeDisabled();
    expect(new Set(Object.values(wire).map(body => body.operation_id)).size).toBe(3);
    await noWork(1, 1);

    stage = 'draft edit preserves immutable rejected command and truthful rename';
    await task.fill(EDIT);
    await preserved(task, EDIT, true);
    // This finite observation window detects automatic retry without adding a product timeout.
    await page.waitForTimeout(300);
    await exact(command.locator('h3'), 'task: rejected');
    await preserved(command.locator('details pre'), TASK);
    await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
    await exact(title, renames[0]);
    expect((await outcome.textContent()).startsWith('rename command\n\nAccepted receipt (not completion)')).toBe(true);
    await noWork(1, 1);
    await privateBoundary();

    stage = 'embedded asset integrity and Disconnect clearing';
    await expect.poll(() => assets.size).toBe(files.size);
    assetEvidence = await page.evaluate(checkEmbeddedAssets, { secrets,
      files: await Promise.all([...files].map(async ([path, file]) => [path, [...await readFile(new URL(`../${file}`, import.meta.url))]])) });
    expect(assetEvidence).toEqual({ checked: files.size, failures: [] });
    await drain();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(outcome, '');
    await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(canaries => {
      const nodes = Array.from(document.querySelectorAll('input,textarea,select'));
      const values = [document.documentElement.outerHTML, ...nodes.map(node => node.value)];
      return nodes.every(node => node.value === '') && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [TASK, EDIT, titles[0], renames[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(1, 1);
    expect(resourceErrors).toBe(1);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-stale-history\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Stale history failed: ${stage}; kind=${kind} line=${line}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}; forced_observer_failures=${observerFailures}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      // A failed close must leave the guard on for Playwright's later fixture cleanup.
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    }
    catch { failure ??= new Error('Stale history browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Stale history fixture cleanup failed'); }
  }
  console.log(`Stale history cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  expect(resourceErrors).toBe(1);
  console.log(`Stale history evidence: HTTP=409 flat_error_exact=${observed.reply.exact}; observer_failures=${observerFailures} captures=${JSON.stringify(observed.counts)} assets_checked=${assetEvidence.checked}; create_posts=${posts.create} task_posts=${posts.task} rename_posts=${posts.rename}; task_bytes=${Buffer.byteLength(TASK)} rename_bytes=${Buffer.byteLength(renames[0])} wire_draft_command_exact=true canonical_rename_exact=${observed.canonicalRename}; sessions=2 browser_sequence=2 seed_sequence=1 rename_commands=1 rename_receipts=1 task_commands=0 task_receipts=0 runs=0 checkpoints=0 runtime=0 results=0 tools=0 provider_connections=0 provider_requests=0 auth_loads=0 auth_prepares=0 cancel=0 retry=0 unrelated_mutations=0 disconnect_cleared=true`);
});
