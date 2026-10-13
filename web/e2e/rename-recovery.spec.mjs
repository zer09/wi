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

// Guard the installed failure recorder through owned context close, including failed close.
test('rename reply loss preserves one immutable command, retries its receipt, then commits one changed rename', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let loss;
  let failure;
  let stage = 'startup';
  const retry = { reply_acquired: false, reply_status: null, manifest_acquired: false, manifest_status: null,
    statuses: 'unavailable', manifest_finish: 'unavailable', manifest_null: 'unavailable', accepted_dom: 'unavailable',
    native_inspection: 'unavailable', native_equality: 'unavailable', no_work: 'unavailable',
    manifest_requestfinished: null, manifest_requestfailed: null, finish_settlement: 'unavailable' };
  let retryPage;
  let manifestRequest;
  const finishedRequests = new WeakSet();
  const failedRequests = new WeakSet();
  // SDK events can precede the matched response continuation. Keep identity only, never request data.
  const onManifestFinished = request => {
    finishedRequests.add(request);
    if (request === manifestRequest) retry.manifest_requestfinished = true;
  };
  const onManifestFailed = request => {
    failedRequests.add(request);
    if (request === manifestRequest) retry.manifest_requestfailed = true;
  };
  const snapshots = { catch: null, before_context_close: null, through_owned_close_removal: null };
  const listenerCleanup = { requestfinished: 'unavailable', requestfailed: 'unavailable' };
  const cleanup = { interceptor: 'unavailable', browser: 'unavailable', fixture: 'unavailable' };
  let renameUrl;
  let renamePath;
  let refreshPath;
  let dropping = false;
  let expectedNetworkErrors = 0;
  const faults = { external: 0, console: 0, page: 0, secret: 0, asset: 0, response: 0 };
  const requests = [];
  const displayReads = [];
  let snapshotHead = '1';
  const posts = path => requests.filter(request => request.method === 'POST' && request.path === path).length;
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary',
      'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => secrets.some(secret => text.includes(secret));
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
      // Keep only method/path, never headers, bodies, query strings or Request objects.
      requests.push({ method: request.method(), path: url.pathname });
      if (request.method() === 'GET' && url.pathname.endsWith('/conversation/events')) {
        const sid = url.pathname.split('/')[3];
        const after = `g11l.${Buffer.from(JSON.stringify([1, sid, snapshotHead, '3', '', ''])).toString('base64url')}`;
        displayReads.push({ kind: 'events', path: url.pathname, matching_head: url.searchParams.get('after') === after });
      }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    const reads = [];
    context.on('response', response => {
      if (response.status() >= 300) faults.response++;
      const path = new URL(response.url()).pathname;
      if (response.request().method() === 'GET' && path.endsWith('/conversation')) {
        displayReads.push({ kind: 'latest', path, status: response.status() });
      }
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
    const pending = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^rename:/ }) });
    const canonical = page.getByRole('heading', { name: 'Canonical session title', exact: true });
    const observation = page.locator('.conversation > div > .metadata').first();
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    async function accepted(kind, receipt, duplicate, refresh = null) {
      const row = page.locator('.command').filter({ has: page.locator('.metadata', { hasText: receipt.operation_id }) });
      await exact(row.locator('h3'), `${kind}: accepted`);
      let text = `Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${receipt.session_id}\nRun: none\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nWarning: none; duplicate: ${duplicate}`;
      if (refresh !== null) text += `\n\nIndependent catalog refresh: ${refresh}`;
      await exact(row.locator(':scope > pre'), `${text}\n\nAccepted is not completed.`);
    }
    let seedSid;
    async function catalog(title, sid, head) {
      await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
      await expect.poll(async () => {
        const values = await page.locator('.session-list button').allTextContents();
        return values.length === 2 && values.filter(value => value === title).length === 1
          && values.filter(value => value === 'Fixture barrier seed').length === 1;
      }).toBe(true);
      if (seedSid !== undefined) expect(await page.locator('.session-list button').allTextContents()).toEqual(sid < seedSid
        ? [title, 'Fixture barrier seed'] : ['Fixture barrier seed', title]);
      const selected = page.locator('.session-list li').filter({ has: page.locator('button[aria-current="true"]') });
      await exact(selected.locator('button'), title);
      await exact(selected.locator('.metadata'), `Observed head: ${head}\nAvailability: ready\nObserved run: none\nCode: none`);
      expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
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
    await exact(observation, 'Observation: streaming');
    expect(displayReads).toEqual([
      { kind: 'latest', path: `/v1/sessions/${sid}/conversation`, status: 200 },
      { kind: 'events', path: `/v1/sessions/${sid}/conversation/events`, matching_head: true },
    ]);
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
    await exact(pending.locator(':scope > pre'), '');
    await expect(pending.getByRole('button', { name: 'Open receipt session', exact: true })).toBeHidden();
    // SSE can expose the committed title even though the mutation receipt is still withheld.
    await exact(canonical, renames[0]);
    await exact(observation, 'Observation: streaming');
    expect(displayReads).toHaveLength(2);
    await exact(page.locator('.session-list button[aria-current="true"]'), titles[0]);
    await noWork(1, 1, 0, '2');

    stage = 'lost reply retains exact uncertain command without rollback or invented receipt';
    dropping = true;
    await loss.drop();
    await exact(pending.locator('h3'), 'rename: uncertain');
    await pending.locator('summary').click();
    await exact(pending.locator('details pre'), renames[0]);
    await exact(pending.locator(':scope > pre'), 'Network read or reply failed. This does not prove rollback.\n\nAcceptance is uncertain. No automatic retry.');
    await exact(pending.locator('.metadata'), `Operation: ${first.operation_id}\nSession: ${sid}`);
    await accepted('create', created.receipt, false);
    await expect(pending.getByRole('button', { name: 'Open receipt session', exact: true })).toBeHidden();
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

    retryPage = page;
    page.on('requestfinished', onManifestFinished);
    page.on('requestfailed', onManifestFailed);
    stage = 'explicit identical retry response acquisition';
    const manifestPath = `/v1/sessions/${sid}`;
    const [retryReply, retryManifest] = await Promise.all([
      page.waitForResponse(response => response.url() === renameUrl && response.request().method() === 'POST').then(response => {
        retry.reply_acquired = true; retry.reply_status = response.status(); return response;
      }),
      page.waitForResponse(response => response.url() === `${fixture.origin}${manifestPath}` && response.request().method() === 'GET').then(response => {
        retry.manifest_acquired = true; retry.manifest_status = response.status();
        manifestRequest = response.request();
        retry.manifest_requestfinished = finishedRequests.has(manifestRequest);
        retry.manifest_requestfailed = failedRequests.has(manifestRequest);
        return response;
      }),
      pending.getByRole('button', { name: 'Retry identical command', exact: true }).click(),
    ]);
    stage = 'explicit identical retry status validation';
    retry.statuses = 'attempted';
    expect(retryReply.status()).toBe(200);
    expect(retryManifest.status()).toBe(200);
    retry.statuses = 'succeeded';
    stage = 'explicit identical retry manifest finish';
    retry.manifest_finish = 'attempted';
    retry.finish_settlement = 'pending';
    const finish = await retryManifest.finished().then(value => {
      retry.finish_settlement = value === null ? 'returned_null' : 'returned_other';
      return value;
    }, reason => {
      retry.finish_settlement = 'rejected';
      throw reason;
    });
    stage = 'explicit identical retry manifest null assertion';
    retry.manifest_null = 'attempted';
    expect(finish).toBe(null);
    retry.manifest_null = 'succeeded';
    retry.manifest_finish = 'succeeded';
    stage = 'explicit identical retry accepted DOM';
    retry.accepted_dom = 'attempted';
    await accepted('rename', first, true, 'unchanged');
    retry.accepted_dom = 'succeeded';
    stage = 'explicit identical retry native mutation inspection';
    retry.native_inspection = 'attempted';
    const retried = oneSession(await fixture.inspectMutations(), 1);
    retry.native_inspection = 'succeeded';
    stage = 'explicit identical retry native mutation equality';
    retry.native_equality = 'attempted';
    expect(JSON.stringify(retried) === JSON.stringify(committed)).toBe(true);
    retry.native_equality = 'succeeded';
    stage = 'explicit identical retry no-work checks';
    retry.no_work = 'attempted';
    await noWork(1, 2, 0, '2');
    retry.no_work = 'succeeded';

    stage = 'select stable seed through the catalog before opening the rename receipt';
    // The current receipt hash would no-op, so leave it through the real catalog control first.
    const seed = page.locator('.session-list li').filter({
      has: page.getByRole('button', { name: 'Fixture barrier seed', exact: true }),
    });
    await expect(seed).toHaveCount(1);
    await exact(seed.locator('.metadata'), 'Observed head: 1\nAvailability: ready\nObserved run: none\nCode: none');
    await seed.getByRole('button', { name: 'Fixture barrier seed', exact: true }).click();
    await exact(page.locator('.session-list button[aria-current="true"]'), 'Fixture barrier seed');
    await exact(canonical, 'Fixture barrier seed');
    // The catalog button carries identity; visible catalog metadata does not.
    seedSid = new URL(page.url()).hash.slice('#session='.length);
    expect(seedSid).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(seedSid !== sid).toBe(true);
    await exact(page.locator('.conversation > .metadata'), `Workspace: not supplied\nSession: ${seedSid}`);
    await exact(observation, 'Observation: streaming');
    expect(displayReads.slice(2)).toEqual([
      { kind: 'latest', path: `/v1/sessions/${seedSid}/conversation`, status: 200 },
      { kind: 'events', path: `/v1/sessions/${seedSid}/conversation/events`, matching_head: true },
    ]);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await exact(transcript, 'No messages yet.');
    await accepted('rename', first, true, 'unchanged');

    const conversationPath = `/v1/sessions/${sid}/conversation`;
    const targetReads = () => [conversationPath, `${conversationPath}/events`].map(path =>
      requests.filter(request => request.method === 'GET' && request.path === path).length);
    const postCounts = () => [posts('/v1/sessions'), posts(renamePath), posts(refreshPath),
      requests.filter(request => request.method === 'POST').length];
    // Latest captures H; only its matching display stream may attach afterward.
    snapshotHead = '2';
    for (const action of ['Open receipt session', 'Reconnect latest']) {
      stage = `explicit ${action} reads canonical receipt session without mutations`;
      const displayBaseline = displayReads.length;
      const readBaseline = targetReads();
      const postBaseline = postCounts();
      expect(postBaseline).toEqual([1, 2, 0, 3]);
      const auditBaseline = oneSession(await fixture.inspectMutations(), 1);
      expect(JSON.stringify(auditBaseline) === JSON.stringify(committed)).toBe(true);
      let control = page.getByRole('button', { name: action, exact: true });
      if (action === 'Open receipt session') control = pending.getByRole('button', { name: action, exact: true });
      await control.click();
      await expect.poll(targetReads).toEqual(readBaseline.map(count => count + 1));
      await exact(page.locator('.session-list button[aria-current="true"]'), titles[0]);
      expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
      await exact(canonical, renames[0]);
      await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspaces[0]}\nSession: ${sid}`);
      await exact(observation, 'Observation: streaming');
      expect(displayReads.slice(displayBaseline)).toEqual([
        { kind: 'latest', path: conversationPath, status: 200 },
        { kind: 'events', path: `${conversationPath}/events`, matching_head: true },
      ]);
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
    const refreshed = page.locator('.command').filter({ has: page.getByRole('heading', { name: 'refresh: accepted', exact: true }) });
    await exact(refreshed.locator(':scope > pre'), 'Catalog refresh: unchanged\n\nAccepted is not completed.');
    await accepted('rename', first, true, 'unchanged');
    await expect(page.locator('.command')).toHaveCount(3);
    await page.waitForTimeout(300);
    await exact(canonical, renames[0]);
    await exact(observation, 'Observation: streaming');
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
    await exact(observation, 'Observation: streaming');
    expect(displayReads).toHaveLength(8);
    await accepted('rename', first, true, 'unchanged');
    await expect(page.locator('.command')).toHaveCount(4);
    await exact(transcript, 'No messages yet.');
    await expect(transcript.locator('.run')).toHaveCount(0);
    await catalog(renames[1], sid, '3');
    expect(JSON.stringify(oneSession(await fixture.inspectMutations(), 2)) === JSON.stringify(changed)).toBe(true);
    await noWork(1, 3, 1, '3');
    await privateBoundary();

    stage = 'public asset and private-boundary proof, then disconnect without work';
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    expect([...assets].sort()).toEqual([...files.keys()].sort());
    expect(requests.some(request => /\/(history|events)$/.test(request.path) && !request.path.endsWith('/conversation/events'))).toBe(false);
    expect(requests.some(request => /^\/assets\/(client|state|view)\.js$/.test(request.path))).toBe(false);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect(expectedNetworkErrors).toBe(1);
    expect(await page.locator('.error').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await privateBoundary();
    await noWork(1, 3, 1, '3');
    console.log('Rename recovery: browser_sessions=1 metadata_seeds=1 create_posts=1 rename_posts=3 rename_events=2 duplicate_receipts=1 refresh_posts=1 final_head=3 task_posts=0 cancel_posts=0 provider_requests=0 auth_loads=0');
  } catch {
    // A started proof that threw failed; later proofs stay unavailable.
    for (const field of ['statuses', 'manifest_finish', 'manifest_null', 'accepted_dom', 'native_inspection', 'native_equality', 'no_work']) {
      if (retry[field] === 'attempted') retry[field] = 'failed';
    }
    snapshots.catch = { ...retry };
    // Never forward raw Playwright arguments, DOM excerpts, errors or fixture payloads.
    failure = new Error(`Rename recovery failed: ${stage}; counts=${JSON.stringify(faults)}; rename_posts=${posts(renamePath)}; retry=${JSON.stringify(retry)}`);
  } finally {
    try {
      if (loss) { cleanup.interceptor = 'attempted'; await loss.stop(); cleanup.interceptor = 'succeeded'; }
    } catch { cleanup.interceptor = 'failed'; failure ??= new Error('Rename recovery interceptor cleanup failed'); }
    try {
      if (context) {
        snapshots.before_context_close = { ...retry };
        cleanup.browser = 'attempted'; await context.close(); cleanup.browser = 'succeeded';
        // Failed close leaves the guard enabled for Playwright's later fixture cleanup.
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { cleanup.browser = 'failed'; failure ??= new Error('Rename recovery browser cleanup failed'); }
    // Observe through owned close, then remove only our callbacks even if close or removal fails.
    try {
      if (retryPage) { listenerCleanup.requestfinished = 'attempted'; retryPage.off('requestfinished', onManifestFinished); listenerCleanup.requestfinished = 'succeeded'; }
    } catch { listenerCleanup.requestfinished = 'failed'; failure ??= new Error('Rename recovery listener cleanup failed'); }
    try {
      if (retryPage) { listenerCleanup.requestfailed = 'attempted'; retryPage.off('requestfailed', onManifestFailed); listenerCleanup.requestfailed = 'succeeded'; }
    } catch { listenerCleanup.requestfailed = 'failed'; failure ??= new Error('Rename recovery listener cleanup failed'); }
    snapshots.through_owned_close_removal = { ...retry };
    try {
      if (fixture) { cleanup.fixture = 'attempted'; await fixture.stop(); cleanup.fixture = 'succeeded'; }
    } catch { cleanup.fixture = 'failed'; failure ??= new Error('Rename recovery fixture cleanup failed'); }
  }
  // Closed Stop facts are independent of receipt/DOM proof and of resource absence.
  console.log(`Rename recovery evidence: ${JSON.stringify({ retry, snapshots, listener_cleanup: listenerCleanup, cleanup, lifecycle: fixture?.evidence() ?? null })}`);
  if (failure) throw failure;
});
