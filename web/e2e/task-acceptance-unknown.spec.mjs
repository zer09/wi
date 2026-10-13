import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { decodeJson, validateErrorView } from '../dist/api.js';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const TASK = '  Unknown acceptance 雪\n<em>task & inert</em>\n  ';
const EDIT = '  edited but not sent 雪\n<em>unsent</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('one Send keeps an acceptance commit unknown before COMMIT uncertain without retry', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let sid;
  let taskPath;
  const observed = { count: 0, reply: { status: null, decoded: false, validated: false, exact: false }, failures: [] };
  const displayReads = [];
  const reads = [];
  let assetEvidence = null;
  let stage = 'startup';
  let resourceErrors = 0;
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
    // Keep the failure-snapshot guard enabled until the owned context has safely closed.
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
      const taskReply = path === taskPath && response.request().method() === 'POST';
      if (response.status() >= 300 && !(taskReply && response.status() === 503)) faults.response++;
      if (path.endsWith('/conversation')) displayReads.push({ kind: 'latest', status: response.status(),
        exact: path === `/v1/sessions/${sid}/conversation` && url.search === '' });
      const file = files.get(path);
      if (file !== undefined) reads.push((async () => {
        const body = await response.body();
        if (response.status() !== 200 || !body.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.response++;
        if (leaked(body.toString('utf8'))) faults.secret++;
        assets.add(path);
      })().catch(() => { faults.response++; }));
      if (!taskReply) return;
      observed.count++;
      reads.push((async () => {
        let step = 'status';
        try {
          observed.reply.status = response.status();
          if (response.status() !== 503 || observed.count !== 1) throw Error();
          step = 'body';
          const bytes = await response.body();
          if (bytes.byteLength > 4096) throw Error();
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (leaked(raw)) { faults.secret++; throw Error(); }
          const value = JSON.parse(raw); observed.reply.decoded = true;
          step = 'schema'; decodeJson(raw, response.headers()['content-type'], validateErrorView); observed.reply.validated = true;
          step = 'exact';
          observed.reply.exact = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 7
            && value.api_version === 1 && value.code === 'storage.commit_unknown' && value.stage === 'acceptance'
            && value.certainty === 'unknown' && value.acceptance === null && value.notices.length === 0;
          if (!observed.reply.exact) throw Error();
        } catch { observed.failures.push(`task:${step}`); }
      })());
    });
    page = await context.newPage();
    page.on('console', message => {
      const text = message.text();
      if (leaked(text) || leaked(message.location().url)) faults.secret++;
      if (message.type() === 'error' && message.location().url === `${fixture.origin}${taskPath}`
        && text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)') {
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
    async function noWork(tasks) {
      const proof = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.completed,
        proof.prepared_exact, proof.fresh_parents, proof.continuations, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(11).fill(0));
      expect([proof.accepted, proof.receipts, proof.response_finishes, proof.terminal_sequences, proof.result_sequences].every(items => items.length === 0)).toBe(true);
      expect(proof.sequence_count).toBe('1');
      expect(proof.gate === null && proof.provider_stage === 'request' && !proof.provider_failed && proof.read_failure === null).toBe(true);
      // This independent read-only audit checks ALL events/commands/runs/tools in both sessions.
      const audit = await fixture.inspectMutations();
      expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
      const entry = audit.creations[0];
      expect(entry.exact && entry.catalog_current && entry.sequence_count === '1' && entry.catalog_head_sequence === '1'
        && entry.rename_events === 0 && entry.renames.length === 0 && entry.rename_event_ids.length === 0
        && entry.receipt.session_id === sid && entry.receipt.operation_id === wire.create.operation_id).toBe(true);
      expect(posts).toEqual({ create: 1, task: tasks, other: 0 });
      expect(faults.reconcile).toBe(0);
      expect(displayReads).toEqual([{ kind: 'latest', status: 200, exact: true }, { kind: 'events', matching_head: true }]);
    }
    async function preserved(locator, expected, input = false) {
      expect(await locator.evaluate((node, { expected, input }) => {
        const actual = input ? node.value : node.textContent;
        return actual === expected && new TextEncoder().encode(actual).length === new TextEncoder().encode(expected).length;
      }, { expected, input })).toBe(true);
    }
    async function retained(draft) {
      await preserved(task, draft, true);
      await preserved(command.locator('details pre'), TASK);
      await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
      await exact(command.locator(':scope > pre'), 'HTTP 503\nCode: storage.commit_unknown\nStage: acceptance\nCertainty: unknown\n\nAcceptance is uncertain. No automatic retry.');
      await exact(createCommand.locator(':scope > pre'), creationOutcome);
      expect(await createCommand.evaluate(node => node.outerHTML) === creationArticle).toBe(true);
    }
    const task = page.getByLabel('Task', { exact: true });
    const command = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) });
    const createCommand = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^create:/ }) });
    const outcome = createCommand.locator(':scope > pre');
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
    await fixture.request({ command: 'select', session_id: sid });
    await createCommand.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(title, titles[0]);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await exact(createCommand.locator('h3'), 'create: accepted');
    const creationOutcome = await outcome.textContent();
    const creationArticle = await createCommand.evaluate(node => node.outerHTML);
    await noWork(0);
    await privateBoundary();

    stage = 'one armed acceptance fault and one Send';
    expect((await fixture.request({ command: 'arm_acceptance_unknown' })).event === 'acceptance_unknown_armed').toBe(true);
    await task.fill(TASK);
    await preserved(task, TASK, true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await exact(command.locator('h3'), 'task: uncertain');
    await Promise.all(reads);
    expect(observed).toEqual({ count: 1, reply: { status: 503, decoded: true, validated: true, exact: true }, failures: [] });
    await exact(command.locator(':scope > pre'), 'HTTP 503\nCode: storage.commit_unknown\nStage: acceptance\nCertainty: unknown\n\nAcceptance is uncertain. No automatic retry.');
    await command.locator('summary').click();
    await preserved(task, TASK, true);
    await preserved(command.locator('details pre'), TASK);
    await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
    await expect(command.getByRole('button', { name: 'Retry identical command', exact: true })).toBeVisible();
    await expect(command.getByRole('button', { name: 'Retry identical command', exact: true })).toBeEnabled();
    await expect(command.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true })).toBeVisible();
    await expect(command.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true })).toBeEnabled();
    expect(uuid(sid) && new Set([sid, wire.create.operation_id, wire.task.operation_id, wire.task.run_id]).size === 4).toBe(true);
    await retained(TASK);
    await exact(outcome, creationOutcome);
    await exact(transcript, 'No messages yet.');
    await expect(page.locator('.run')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeDisabled();
    await noWork(1);

    stage = 'finite no-retry window and immutable draft edit';
    await task.fill(EDIT);
    await preserved(task, EDIT, true);
    // A finite test observation, not a product timeout or automatic recovery timer.
    await page.waitForTimeout(500);
    await exact(command.locator('h3'), 'task: uncertain');
    await preserved(command.locator('details pre'), TASK);
    await exact(command.locator('.metadata'), `Operation: ${wire.task.operation_id}\nSession: ${sid}`);
    await retained(EDIT);
    await exact(outcome, creationOutcome);
    await exact(title, titles[0]);
    await exact(transcript, 'No messages yet.');
    await noWork(1);
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
    }, [TASK, EDIT, titles[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(1);
    expect(resourceErrors).toBe(1);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    await Promise.all(reads);
    expect(observed).toEqual({ count: 1, reply: { status: 503, decoded: true, validated: true, exact: true }, failures: [] });
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure = new Error(`Acceptance unknown failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      // A failed close leaves the guard enabled for Playwright's later fixture cleanup.
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Acceptance unknown browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Acceptance unknown fixture cleanup failed'); }
  }
  console.log(`Acceptance unknown cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  expect(resourceErrors).toBe(1);
  console.log(`Acceptance unknown evidence: HTTP=503 flat_error_exact=${observed.reply.exact} captures=${observed.count} assets_checked=${assetEvidence.checked}; create_posts=${posts.create} task_posts=${posts.task} other_posts=${posts.other}; task_bytes=${Buffer.byteLength(TASK)} command_dom_original=true create_article_unchanged=true; sessions=2 browser_sequence=1 seed_sequence=1 task_commands=0 task_receipts=0 runs=0 checkpoints=0 runtime=0 results=0 tools=0 provider_connections=0 provider_requests=0 auth_loads=0 auth_prepares=0 cancel=0 retry=0 reconcile=0 observation_ms=500 disconnect_cleared=true`);
});
