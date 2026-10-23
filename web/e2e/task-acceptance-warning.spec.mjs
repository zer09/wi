import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { decodeJson } from '../dist/api.js';
import { validateDisplayTaskAccepted } from '../dist/display-api.js';

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
  const observed = { count: 0, reply: { status: null, decoded: false, validated: false, exact: false }, failures: [] };
  const displayReads = [];
  const reads = [];
  let creationOutcome;
  let creationArticle;
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
      const headers = request.headers();
      if (headers.cookie !== undefined || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      if (url.pathname.startsWith('/v1/') && headers.authorization !== `Bearer ${fixture.owner}`) faults.request++;
      if (/\/(history|events|operations)(\/|$)/.test(url.pathname) && !url.pathname.endsWith('/conversation/events')) faults.request++;
      if (['/assets/client.js', '/assets/state.js', '/assets/view.js'].includes(url.pathname)) faults.request++;
      if (request.method() !== 'POST') {
        if (request.method() !== 'GET') faults.request++;
        if (/\/(operations|runs)\//.test(url.pathname)) faults.reconcile++;
        if (url.pathname.endsWith('/conversation/events')) {
          const after = `g11l.${Buffer.from(JSON.stringify([1, sid, '1', '3', '', ''])).toString('base64url')}`;
          displayReads.push({ kind: 'events', matching_head: url.pathname === `/v1/sessions/${sid}/conversation/events`
            && url.searchParams.size === 1 && url.searchParams.get('after') === after });
        }
        return;
      }
      if (headers.origin !== fixture.origin || url.search !== '') faults.request++;
      let kind;
      if (url.pathname === '/v1/sessions') kind = 'create';
      else if (url.pathname === taskPath) kind = 'task';
      else { posts.other++; return; }
      posts[kind]++;
      try {
        const bytes = request.postDataBuffer();
        if (bytes === null || bytes.byteLength > 4096) { faults.request++; return; }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      const url = new URL(response.url()), path = url.pathname;
      if (response.status() >= 300) faults.response++;
      if (path.endsWith('/conversation')) displayReads.push({ kind: 'latest', status: response.status(),
        exact: path === `/v1/sessions/${sid}/conversation` && url.search === '' });
      const file = files.get(path);
      if (file !== undefined) reads.push((async () => {
        const body = await response.body();
        if (response.status() !== 200 || !body.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.response++;
        if (leaked(body.toString('utf8'))) faults.secret++;
        assets.add(path);
      })().catch(() => { faults.response++; }));
      if (path !== taskPath || response.request().method() !== 'POST') return;
      observed.count++;
      reads.push((async () => {
        let step = 'status';
        try {
          observed.reply.status = response.status();
          if (response.status() !== 202 || observed.count !== 1) throw Error();
          step = 'body';
          const bytes = await response.body();
          if (bytes.byteLength > 4096) throw Error();
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (leaked(raw)) { faults.secret++; throw Error(); }
          const value = JSON.parse(raw); observed.reply.decoded = true;
          step = 'schema';
          decodeJson(raw, response.headers()['content-type'], value => validateDisplayTaskAccepted(value, { ...wire.task, session_id: sid }));
          observed.reply.validated = true;
          step = 'exact';
          // Count all keys so JSON.parse cannot hide a duplicate in the closed reply.
          observed.reply.exact = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 11
            && value.api_version === 1 && value.receipt.operation_id === wire.task.operation_id
            && value.receipt.session_id === sid && value.receipt.run_id === wire.task.run_id
            && value.receipt.first_sequence === '2' && value.receipt.last_sequence === '3'
            && value.duplicate === false && value.warning_code === 'storage.connection_cleanup_failed' && value.notices.length === 0;
          if (!observed.reply.exact) throw Error();
        } catch { observed.failures.push(`task:${step}`); }
      })());
    });
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
      expect(displayReads).toEqual([{ kind: 'latest', status: 200, exact: true }, { kind: 'events', matching_head: true }]);
    }
    const task = page.getByLabel('Task', { exact: true });
    const createCommand = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^create:/ }) });
    const command = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) });
    const outcome = command.locator(':scope > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const run = page.locator('.run');
    const title = page.getByRole('heading', { name: 'Canonical session title', exact: true });
    async function acceptedTruth() {
      await exact(command.locator('h3'), 'task: accepted');
      await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
      await exact(command.locator('details pre'), TASK);
      await exact(outcome, `Accepted receipt (not completion)\nOperation: ${wire.task.operation_id}\nSession: ${sid}\nRun: ${wire.task.run_id}\nSequences: 2 to 3\n\nWarning: storage.connection_cleanup_failed; duplicate: false\n\nAccepted is not completed.`);
      await expect(outcome).toBeVisible();
      await exact(createCommand.locator(':scope > pre'), creationOutcome);
      expect(await createCommand.evaluate(node => node.outerHTML) === creationArticle).toBe(true);
      await expect(page.locator('.command')).toHaveCount(2);
      await expect(run).toHaveCount(1);
      await expect(run).toHaveAttribute('data-run', wire.task.run_id);
      await exact(run.locator(':scope > .metadata'), 'Execution: accepted. Final result not recorded.');
      await expect(run.locator('.entry > h4')).toHaveText(['Human']);
      const human = run.locator('.entry');
      await expect(human).toHaveAttribute('data-entry', 'e:2:0');
      await exact(human.locator('[data-field] pre'), TASK);
      await exact(human.locator(':scope > .metadata').first(), 'Recorded state: accepted; Provisional: false');
      await exact(human.locator('[data-field] > .metadata'), `Recorded bytes: ${Buffer.byteLength(TASK)}; generation: 2`);
      await exact(run.locator(':scope > details > pre'), `Run: ${wire.task.run_id}\nAccepted sequence: 2\nOutcome: not recorded\nEvents complete: not recorded\nSink error: none\nSummary not recorded.`);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
      await exact(page.locator('.conversation > div > .metadata').first(), 'Observation: streaming');
      await expect(page.getByRole('button', { name: 'Retry identical command', exact: true })).toHaveCount(0);
      expect(await task.inputValue() === '').toBe(true);
    }

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect.poll(async () => (await createCommand.locator(':scope > pre').textContent()).includes('Accepted receipt (not completion)')).toBe(true);
    const audit = await fixture.inspectMutations();
    sid = audit.creations[0].receipt.session_id;
    taskPath = `/v1/sessions/${sid}/runs`;
    await fixture.request({ command: 'select', session_id: sid });
    await createCommand.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(title, titles[0]);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await exact(createCommand.locator('h3'), 'create: accepted');
    creationOutcome = await createCommand.locator(':scope > pre').textContent();
    creationArticle = await createCommand.evaluate(node => node.outerHTML);
    await noWork(false);
    await privateBoundary();

    stage = 'one armed cleanup warning and one Send';
    expect((await fixture.request({ command: 'arm_acceptance_warning' })).event === 'acceptance_warning_armed').toBe(true);
    await task.fill(TASK);
    expect(await task.inputValue() === TASK).toBe(true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await outcome.textContent()).includes('Warning: storage.connection_cleanup_failed')).toBe(true);
    await Promise.all(reads);
    expect(observed).toEqual({ count: 1, reply: { status: 202, decoded: true, validated: true, exact: true }, failures: [] });
    await command.locator('summary').click();
    expect(uuid(sid) && new Set([sid, wire.create.operation_id, wire.task.operation_id, wire.task.run_id]).size === 4).toBe(true);
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
    await Promise.all(reads);
    assetEvidence = { checked: assets.size, exact: faults.response === 0 };
    expect(assetEvidence).toEqual({ checked: files.size, exact: true });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(page.locator('.transcript'), '');
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    expect(await page.getByLabel('Workspace', { exact: true }).locator('option').count()).toBe(0);
    expect(await page.evaluate(canaries => {
      const nodes = Array.from(document.querySelectorAll('input,textarea,select'));
      const values = [document.documentElement.outerHTML, ...nodes.map(node => node.value)];
      return nodes.every(node => node.value === '') && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [TASK, titles[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(true);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    await Promise.all(reads);
    expect(observed).toEqual({ count: 1, reply: { status: 202, decoded: true, validated: true, exact: true }, failures: [] });
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure = new Error(`Acceptance warning failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
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
  console.log(`Acceptance warning evidence: HTTP=202 task_accepted_exact=${observed.reply.exact} captures=${observed.count} assets_checked=${assetEvidence.checked}; create_posts=${posts.create} task_posts=${posts.task} other_posts=${posts.other}; task_bytes=${Buffer.byteLength(TASK)} command_dom_original=true create_article_unchanged=true; sessions=2 browser_sequence=3 seed_sequence=1 task_commands=1 task_receipts=1 runs_accepted=1 checkpoints=1 runtime=0 bindings=0 results=0 terminals=0 interrupts=0 renames=0 tools=0 provider_connections=0 provider_requests=0 auth_loads=0 auth_prepares=0 cancel=0 retry=0 reconcile=0 console=0 observation_ms=500 disconnect_cleared=true`);
});
