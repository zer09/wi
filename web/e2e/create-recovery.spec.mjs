import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { armReplyLoss } from '../test-support/mutations.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
let executable;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  executable = await discoverFixture();
});
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
function creationOnly(proof, count) {
  expect(proof.creations.length).toBe(count);
  for (const [slot, entry] of proof.creations.entries()) {
    expect(entry.slot).toBe(slot);
    expect(entry.sequence_count === '1' && entry.receipt.first_sequence === '1'
      && entry.receipt.last_sequence === '1' && entry.receipt.run_id === null).toBe(true);
    expect(entry.rename_events).toBe(0);
    expect(entry.renames.length).toBe(0);
    expect(entry.exact && entry.catalog_current).toBe(true);
  }
}

// Own the context so a failed assertion cannot attach a token-bearing page snapshot.
test('create reply loss retries the identical committed command, then creates a new session', async ({ browser }) => {
  let fixture;
  let context;
  let loss;
  let failure;
  let stage = 'startup';
  const faults = { external: 0, console: 0, page: 0, secret: 0, asset: 0, response: 0 };
  let expectedNetworkErrors = 0;
  let dropping = false;
  const requests = [];
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary',
      'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => secrets.some(secret => text.includes(secret));
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
      else await route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.secret++;
      // Retain only method/path, never headers, body, query strings or Request objects.
      requests.push({ method: request.method(), path: url.pathname });
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    const reads = [];
    context.on('response', response => {
      if (response.status() >= 300) faults.response++;
      const path = new URL(response.url()).pathname;
      const file = files.get(path);
      if (file === undefined) return;
      reads.push((async () => {
        // API bodies belong to the real UI. Inspect only public asset bytes here.
        const body = await response.body();
        if (leaked(body.toString('utf8'))) faults.secret++;
        if (response.status() !== 200 || !body.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.asset++;
        assets.add(path);
      })().catch(() => { faults.asset++; }));
    });
    const page = await context.newPage();
    page.on('console', message => {
      if (leaked(message.text()) || leaked(message.location().url)) faults.secret++;
      if (message.type() !== 'error') return;
      const expected = dropping && message.location().url === `${fixture.origin}/v1/sessions`
        && message.text() === 'Failed to load resource: net::ERR_FAILED';
      if (expected && expectedNetworkErrors === 0) expectedNetworkErrors++;
      else faults.console++;
    });
    page.on('pageerror', error => {
      faults.page++;
      if (leaked(error.message)) faults.secret++;
    });
    async function privateBoundary() {
      const clean = await page.evaluate(async secrets => {
        const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
          JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie,
          ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
        return !secrets.some(secret => values.some(value => value?.includes(secret)))
          && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0;
      }, secrets);
      expect(clean).toBe(true);
      expect((await context.cookies()).length).toBe(0);
    }
    async function noWork(posts) {
      const proof = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares,
        proof.completed, proof.prepared_exact, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(9).fill(0));
      expect(proof.provider_failed || proof.read_failure !== null).toBe(false);
      expect(requests.filter(request => request.method === 'POST').length).toBe(posts);
      expect(requests.some(request => request.method === 'POST' && request.path !== '/v1/sessions')).toBe(false);
    }
    const createPosts = () => requests.filter(request => request.method === 'POST' && request.path === '/v1/sessions').length;
    const outcome = page.locator('.commands > section > pre');
    async function accepted(receipt, duplicate) {
      await exact(outcome, `create command\n\nAccepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${receipt.session_id}\nRun: none\nSequences: 1 to 1\n\nDuplicate receipt: ${duplicate}`);
      await expect(page.locator('.command')).toHaveCount(0);
    }

    stage = 'authenticated connection and workspace order';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    await expect(page.getByRole('button', { name: 'Create session', exact: true })).toBeEnabled();
    stage = 'authenticated selector options';
    const workspace = page.getByLabel(/^Workspace/);
    const workspaces = await workspace.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    expect(workspaces.length).toBe(2);
    expect(workspaces.every(value => value.length > 0) && workspaces[0] !== workspaces[1]).toBe(true);
    expect(requests.some(request => request.method === 'GET' && request.path === '/v1/settings')).toBe(true);
    expect(requests.some(request => request.method === 'GET' && request.path === '/v1/sessions')).toBe(true);
    stage = 'initial mutation audit and private boundary';
    creationOnly(await fixture.inspectMutations(), 0);
    await noWork(0);
    await privateBoundary();

    stage = 'real create 201 paused after commit';
    loss = await armReplyLoss(await context.newCDPSession(page), `${fixture.origin}/v1/sessions`, 201);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    await workspace.selectOption(workspaces[0]);
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    expect(await loss.wait()).toBe(201);
    const committed = await fixture.inspectMutations();
    creationOnly(committed, 1);
    const first = committed.creations[0].receipt;
    const pending = page.locator('.command');
    await expect(pending).toHaveCount(1);
    await exact(pending.locator('h3'), 'create: sending');
    await exact(pending.locator('.metadata'), `Operation: ${first.operation_id}\nSession: not yet known`);
    expect(createPosts()).toBe(1);

    stage = 'one lost response leaves exact uncertain command';
    dropping = true;
    await loss.drop();
    await exact(pending.locator('h3'), 'create: uncertain');
    await pending.locator('summary').click();
    await exact(pending.locator('details pre'), titles[0]);
    await exact(pending.locator(':scope > pre'), `Network reply unavailable. This does not establish whether a command was accepted.\n\nWorkspace: ${workspaces[0]}\n\nAcceptance is uncertain. A missing reply or receipt does not prove rollback.`);
    await expect(pending.getByRole('button', { name: 'Retry identical command', exact: true })).toBeEnabled();
    await exact(pending.locator('.metadata'), `Operation: ${first.operation_id}\nSession: not yet known`);
    await privateBoundary();
    // A finite idle window checks that uncertainty does not schedule a second POST.
    await page.waitForTimeout(300);
    const uncertain = await fixture.inspectMutations();
    creationOnly(uncertain, 1);
    expect(JSON.stringify(uncertain.creations) === JSON.stringify(committed.creations)).toBe(true);
    await noWork(1);

    stage = 'explicit identical retry returns duplicate receipt';
    const [retryReply] = await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      pending.getByRole('button', { name: 'Retry identical command', exact: true }).click(),
    ]);
    expect(retryReply.status()).toBe(200);
    await accepted(first, true);
    const retried = await fixture.inspectMutations();
    creationOnly(retried, 1);
    expect(JSON.stringify(retried.creations) === JSON.stringify(committed.creations)).toBe(true);
    await noWork(2);

    stage = 'receipt opens exact canonical metadata and empty conversation';
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), titles[0]);
    await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspaces[0]}\nSession: ${first.session_id}`);
    expect(new URL(page.url()).hash === `#session=${first.session_id}`).toBe(true);
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    await exact(transcript, 'No messages yet.');
    await expect(transcript.locator('.run')).toHaveCount(0);
    await privateBoundary();

    stage = 'changed title and workspace create a distinct command and session';
    await page.getByLabel('Title', { exact: true }).fill(titles[1]);
    await workspace.selectOption(workspaces[1]);
    const [newReply] = await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create session', exact: true }).click(),
    ]);
    expect(newReply.status()).toBe(201);
    const created = await fixture.inspectMutations();
    creationOnly(created, 2);
    const second = created.creations[1].receipt;
    expect(second.operation_id !== first.operation_id && second.session_id !== first.session_id).toBe(true);
    expect(JSON.stringify(created.creations[0]) === JSON.stringify(committed.creations[0])).toBe(true);
    await accepted(second, false);
    await noWork(3);

    stage = 'explicit list refresh shows both exact titles';
    const lists = requests.filter(request => request.method === 'GET' && request.path === '/v1/sessions').length;
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect.poll(() => requests.filter(request => request.method === 'GET' && request.path === '/v1/sessions').length).toBe(lists + 1);
    await expect.poll(async () => {
      const shown = await page.locator('.session-list button').allTextContents();
      return titles.every(title => shown.filter(value => value === title).length === 1);
    }).toBe(true);
    // The fixture also owns one unrelated metadata-only barrier seed.
    await expect(page.locator('.session-list li')).toHaveCount(3);
    expect(await page.locator('.session-list em,.command em,.conversation h2 em').count()).toBe(0);
    creationOnly(await fixture.inspectMutations(), 2);
    await noWork(3);
    await privateBoundary();

    stage = 'public assets and final private boundary';
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect(expectedNetworkErrors).toBe(1);
    expect(await page.locator('.error').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await privateBoundary();
    await noWork(3);
    console.log('Create recovery: creations=2 create_posts=3 duplicate_receipts=1 sequences_each=1 rename_posts=0 task_posts=0 cancel_posts=0 provider_requests=0 auth_loads=0');
  } catch {
    // Never forward Playwright arguments, DOM excerpts, raw errors or fixture payloads.
    failure = new Error(`Create recovery failed: ${stage}; counts=${JSON.stringify(faults)}; create_posts=${requests.filter(request => request.method === 'POST' && request.path === '/v1/sessions').length}`);
  } finally {
    try { await loss?.stop(); } catch { failure ??= new Error('Create recovery interceptor cleanup failed'); }
    try { await context?.close(); } catch { failure ??= new Error('Create recovery browser cleanup failed'); }
    try { await fixture?.stop(); } catch { failure ??= new Error('Create recovery fixture cleanup failed'); }
  }
  if (failure) throw failure;
});
