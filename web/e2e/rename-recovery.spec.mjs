import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { armReplyLoss } from '../test-support/mutations.mjs';

const { titles, renames } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
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
function oneSession(proof, count) {
  expect([proof.session_count, proof.seed_sessions, proof.creations.length]).toEqual([2, 1, 1]);
  const entry = proof.creations[0];
  expect(entry.slot).toBe(0);
  expect(entry.rename_events).toBe(count);
  expect(entry.renames.length).toBe(count);
  expect(entry.rename_event_ids.length).toBe(count);
  expect(new Set(entry.rename_event_ids).size).toBe(count);
  expect(entry.sequence_count).toBe(String(count + 1));
  expect(entry.catalog_head_sequence).toBe(entry.sequence_count);
  expect(entry.exact && entry.catalog_current).toBe(true);
  for (const [index, receipt] of [entry.receipt, ...entry.renames].entries()) {
    expect(receipt.session_id === entry.receipt.session_id && receipt.run_id === null
      && receipt.first_sequence === String(index + 1) && receipt.last_sequence === String(index + 1)).toBe(true);
  }
  expect(new Set([entry.receipt, ...entry.renames].map(receipt => receipt.operation_id)).size).toBe(count + 1);
  return entry;
}

// Own the context so failed assertions cannot attach a token-bearing page snapshot.
test('rename reply loss preserves one immutable command, retries its receipt, then commits one changed rename', async ({ browser }) => {
  let fixture;
  let context;
  let loss;
  let failure;
  let stage = 'startup';
  let renameUrl;
  let renamePath;
  let refreshPath;
  let dropping = false;
  let expectedNetworkErrors = 0;
  const faults = { external: 0, console: 0, page: 0, secret: 0, asset: 0, response: 0 };
  const requests = [];
  const posts = path => requests.filter(request => request.method === 'POST' && request.path === path).length;
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
      // Keep only method/path, never headers, bodies, query strings or Request objects.
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
        // Only public asset bytes are inspected. Real API replies belong to the UI.
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
      const expected = dropping && message.location().url === renameUrl
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
      expect(await page.locator('.session-list em,.command em,.conversation h2 em,img,iframe').count()).toBe(0);
    }
    async function noWork(createCount, renameCount, refreshCount, head) {
      const proof = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.completed,
        proof.prepared_exact, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(9).fill(0));
      expect(proof.accepted.length + proof.receipts.length).toBe(0);
      expect(proof.provider_failed || proof.read_failure !== null).toBe(false);
      expect(proof.sequence_count).toBe(head);
      expect([posts('/v1/sessions'), posts(renamePath), posts(refreshPath)]).toEqual([createCount, renameCount, refreshCount]);
      expect(requests.filter(request => request.method === 'POST').length).toBe(createCount + renameCount + refreshCount);
    }
    const outcome = page.locator('.commands > section > pre');
    const pending = page.locator('.command');
    const canonical = page.getByRole('heading', { name: 'Canonical session title', exact: true });
    const cursor = page.locator('.conversation > div > .metadata').first();
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    async function accepted(kind, receipt, duplicate, refresh = null) {
      let text = `${kind} command\n\nAccepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${receipt.session_id}\nRun: none\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nDuplicate receipt: ${duplicate}`;
      if (refresh !== null) text += `\nIndependent catalog refresh: ${refresh}`;
      await exact(outcome, text);
      await expect(pending).toHaveCount(0);
    }
    async function catalog(title, sid, head) {
      await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
      await expect.poll(async () => {
        const values = await page.locator('.session-list button').allTextContents();
        return values.length === 2 && values.filter(value => value === title).length === 1
          && values.filter(value => value === 'Fixture barrier seed').length === 1;
      }).toBe(true);
      const selected = page.locator('.session-list li').filter({ has: page.locator('button[aria-current="true"]') });
      await exact(selected.locator('button'), title);
      await exact(selected.locator('.metadata'), `Session: ${sid}\nObserved head: ${head}\nAvailability: ready\nObserved run: none`);
    }

    stage = 'authenticated browser creation';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    stage = 'initial metadata seed audit';
    const initial = await fixture.inspectMutations();
    expect([initial.session_count, initial.seed_sessions, initial.creations.length]).toEqual([1, 1, 0]);
    await noWork(0, 0, 0, '0');
    stage = 'authenticated workspace selector';
    const workspace = page.getByLabel(/^Workspace/);
    const workspaces = await workspace.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    expect(workspaces.length).toBe(2);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    await workspace.selectOption(workspaces[0]);
    stage = 'real browser create POST and receipt';
    const [createdReply] = await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create session', exact: true }).click(),
    ]);
    expect(createdReply.status()).toBe(201);
    const created = oneSession(await fixture.inspectMutations(), 0);
    const sid = created.receipt.session_id;
    renamePath = `/v1/sessions/${sid}/rename`;
    refreshPath = `/v1/sessions/${sid}/refresh`;
    renameUrl = `${fixture.origin}${renamePath}`;
    await accepted('create', created.receipt, false);

    stage = 'select canonical session and establish catalog without an initial rename';
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(canonical, titles[0]);
    await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspaces[0]}\nSession: ${sid}`);
    await exact(cursor, `Applied cursor: ${sid}:1\nSnapshot head: 1`);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await exact(transcript, 'No messages yet.');
    expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    await fixture.request({ command: 'select', session_id: sid });
    await catalog(titles[0], sid, '1');
    await noWork(1, 0, 0, '1');
    await privateBoundary();

    stage = 'selected-session rename 200 paused after real commit';
    loss = await armReplyLoss(await context.newCDPSession(page), renameUrl, 200);
    await page.getByLabel('Exact new title', { exact: true }).fill(renames[0]);
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    expect(await loss.wait()).toBe(200);
    const committed = oneSession(await fixture.inspectMutations(), 1);
    const first = committed.renames[0];
    expect(JSON.stringify(committed.receipt) === JSON.stringify(created.receipt)).toBe(true);
    await expect(pending).toHaveCount(1);
    await exact(pending.locator('h3'), 'rename: sending');
    await exact(pending.locator('.metadata'), `Operation: ${first.operation_id}\nSession: ${sid}`);
    // SSE can expose the committed title even though the mutation receipt is still withheld.
    await exact(canonical, renames[0]);
    await exact(cursor, `Applied cursor: ${sid}:2\nSnapshot head: 1`);
    await exact(page.locator('.session-list button[aria-current="true"]'), titles[0]);
    await noWork(1, 1, 0, '2');

    stage = 'lost reply retains exact uncertain command without rollback or invented receipt';
    dropping = true;
    await loss.drop();
    await exact(pending.locator('h3'), 'rename: uncertain');
    await pending.locator('summary').click();
    await exact(pending.locator('details pre'), renames[0]);
    await exact(pending.locator(':scope > pre'), 'Network reply unavailable. This does not establish whether a command was accepted.\n\nAcceptance is uncertain. A missing reply or receipt does not prove rollback.');
    await exact(pending.locator('.metadata'), `Operation: ${first.operation_id}\nSession: ${sid}`);
    expect((await outcome.textContent()).startsWith('create command\n')).toBe(true);
    expect((await outcome.textContent()).includes(first.operation_id)).toBe(false);
    await expect(pending.getByRole('button', { name: 'Retry identical command', exact: true })).toBeEnabled();
    // Editing the form must not change the already captured command used by Retry.
    await page.getByLabel('Exact new title', { exact: true }).fill(renames[1]);
    await exact(pending.locator('details pre'), renames[0]);
    await page.waitForTimeout(300);
    await expect(pending).toHaveCount(1);
    await exact(canonical, renames[0]);
    const uncertain = oneSession(await fixture.inspectMutations(), 1);
    expect(JSON.stringify(uncertain) === JSON.stringify(committed)).toBe(true);
    await noWork(1, 1, 0, '2');
    await privateBoundary();

    stage = 'explicit identical retry consumes the real duplicate receipt and unchanged catalog result';
    const manifestPath = `/v1/sessions/${sid}`;
    const [retryReply, retryManifest] = await Promise.all([
      page.waitForResponse(response => response.url() === renameUrl && response.request().method() === 'POST'),
      page.waitForResponse(response => response.url() === `${fixture.origin}${manifestPath}` && response.request().method() === 'GET'),
      pending.getByRole('button', { name: 'Retry identical command', exact: true }).click(),
    ]);
    expect(retryReply.status()).toBe(200);
    expect(retryManifest.status()).toBe(200);
    expect(await retryManifest.finished()).toBe(null);
    await accepted('rename', first, true, 'unchanged');
    const retried = oneSession(await fixture.inspectMutations(), 1);
    expect(JSON.stringify(retried) === JSON.stringify(committed)).toBe(true);
    await noWork(1, 2, 0, '2');

    stage = 'select stable seed through the catalog before opening the rename receipt';
    // The current receipt hash would no-op, so leave it through the real catalog control first.
    const seed = page.locator('.session-list li').filter({
      has: page.getByRole('button', { name: 'Fixture barrier seed', exact: true }),
    });
    await expect(seed).toHaveCount(1);
    const seedSid = (await seed.locator('.metadata').textContent()).split('\n')[0].slice('Session: '.length);
    expect(seedSid !== sid).toBe(true);
    await exact(seed.locator('.metadata'), `Session: ${seedSid}\nObserved head: 1\nAvailability: ready\nObserved run: none`);
    await seed.getByRole('button', { name: 'Fixture barrier seed', exact: true }).click();
    await exact(page.locator('.session-list button[aria-current="true"]'), 'Fixture barrier seed');
    expect(new URL(page.url()).hash === `#session=${seedSid}`).toBe(true);
    await exact(canonical, 'Fixture barrier seed');
    await exact(page.locator('.conversation > .metadata'), `Workspace: not supplied\nSession: ${seedSid}`);
    await exact(cursor, `Applied cursor: ${seedSid}:1\nSnapshot head: 1`);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await exact(transcript, 'No messages yet.');
    await accepted('rename', first, true, 'unchanged');

    const historyPath = `/v1/sessions/${sid}/history`;
    const targetReads = () => [manifestPath, historyPath].map(path =>
      requests.filter(request => request.method === 'GET' && request.path === path).length);
    const postCounts = () => [posts('/v1/sessions'), posts(renamePath), posts(refreshPath),
      requests.filter(request => request.method === 'POST').length];
    // Each load reads one manifest and one page because this history has only two metadata events.
    for (const action of ['Open receipt session', 'Reload history']) {
      stage = `explicit ${action} reads canonical receipt session without mutations`;
      const readBaseline = targetReads();
      const postBaseline = postCounts();
      expect(postBaseline).toEqual([1, 2, 0, 3]);
      const auditBaseline = oneSession(await fixture.inspectMutations(), 1);
      expect(JSON.stringify(auditBaseline) === JSON.stringify(committed)).toBe(true);
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect.poll(targetReads).toEqual(readBaseline.map(count => count + 1));
      await exact(page.locator('.session-list button[aria-current="true"]'), titles[0]);
      expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
      await exact(canonical, renames[0]);
      await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspaces[0]}\nSession: ${sid}`);
      await exact(cursor, `Applied cursor: ${sid}:2\nSnapshot head: 2`);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
      await exact(transcript, 'No messages yet.');
      expect(targetReads()).toEqual(readBaseline.map(count => count + 1));
      expect(postCounts()).toEqual(postBaseline);
      expect(JSON.stringify(oneSession(await fixture.inspectMutations(), 1)) === JSON.stringify(auditBaseline)).toBe(true);
      await noWork(1, 2, 0, '2');
    }
    await catalog(renames[0], sid, '2');

    stage = 'explicit selected refresh returns unchanged without hidden rename or event';
    const [refreshReply] = await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}${refreshPath}` && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Refresh selected catalog entry', exact: true }).click(),
    ]);
    expect(refreshReply.status()).toBe(200);
    await exact(outcome, 'refresh command\n\nCatalog refresh: unchanged');
    await expect(pending).toHaveCount(0);
    await page.waitForTimeout(300);
    await exact(canonical, renames[0]);
    await exact(cursor, `Applied cursor: ${sid}:2\nSnapshot head: 2`);
    expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    expect(JSON.stringify(oneSession(await fixture.inspectMutations(), 1)) === JSON.stringify(committed)).toBe(true);
    await noWork(1, 2, 1, '2');

    stage = 'changed second rename commits one new operation and event';
    await page.getByLabel('Exact new title', { exact: true }).fill(renames[1]);
    const [changedReply] = await Promise.all([
      page.waitForResponse(response => response.url() === renameUrl && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Rename session', exact: true }).click(),
    ]);
    expect(changedReply.status()).toBe(200);
    const changed = oneSession(await fixture.inspectMutations(), 2);
    const second = changed.renames[1];
    expect(JSON.stringify(changed.receipt) === JSON.stringify(created.receipt)).toBe(true);
    expect(JSON.stringify(changed.renames[0]) === JSON.stringify(first)).toBe(true);
    expect(changed.rename_event_ids[0] === committed.rename_event_ids[0]).toBe(true);
    expect(second.operation_id !== first.operation_id && second.session_id === first.session_id).toBe(true);
    await accepted('rename', second, false, 'updated');
    await exact(canonical, renames[1]);
    await exact(cursor, `Applied cursor: ${sid}:3\nSnapshot head: 2`);
    await exact(transcript, 'No messages yet.');
    await expect(transcript.locator('.run')).toHaveCount(0);
    await catalog(renames[1], sid, '3');
    expect(JSON.stringify(oneSession(await fixture.inspectMutations(), 2)) === JSON.stringify(changed)).toBe(true);
    await noWork(1, 3, 1, '3');
    await privateBoundary();

    stage = 'public asset and private-boundary proof, then disconnect without work';
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect(expectedNetworkErrors).toBe(1);
    expect(await page.locator('.error').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await privateBoundary();
    await noWork(1, 3, 1, '3');
    console.log('Rename recovery: browser_sessions=1 metadata_seeds=1 create_posts=1 rename_posts=3 rename_events=2 duplicate_receipts=1 refresh_posts=1 final_head=3 task_posts=0 cancel_posts=0 provider_requests=0 auth_loads=0');
  } catch {
    // Never forward raw Playwright arguments, DOM excerpts, errors or fixture payloads.
    failure = new Error(`Rename recovery failed: ${stage}; counts=${JSON.stringify(faults)}; rename_posts=${posts(renamePath)}`);
  } finally {
    try { await loss?.stop(); } catch { failure ??= new Error('Rename recovery interceptor cleanup failed'); }
    try { await context?.close(); } catch { failure ??= new Error('Rename recovery browser cleanup failed'); }
    try { await fixture?.stop(); } catch { failure ??= new Error('Rename recovery fixture cleanup failed'); }
  }
  if (failure) throw failure;
});
