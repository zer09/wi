import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { decodeJson, validateCreateView, validateErrorView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
// Exact fixture TASKS keep the independent closed SQLite audit and provider canary unchanged.
const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
const EDIT = '  edited but not sent 雪\n<em>unsent</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('a second Send rejects incomplete stored history without changing the accepted warning or starting provider work', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let sid;
  let taskPath;
  let durable;
  let stableProof;
  const replyFacts = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false,
    body_bounded: false, decoded: false, validated: false, exact: false });
  const observed = { create: replyFacts(), latest: replyFacts(), tasks: [replyFacts(), replyFacts()] };
  const replies = [];
  const displayReads = [];
  let creationArticle;
  let acceptedArticle;
  let humanArticle;
  let rejectedArticle;
  let assetEvidence = null;
  let stage = 'startup';
  let resourceErrors = 0;
  const wire = { create: null, tasks: [] };
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
    const leaked = text => /[0-9a-f]{64}/i.test(text) || secrets.some(secret => text.includes(secret));
    async function readReply(promise, facts, validator, check) {
      const response = await promise;
      facts.acquired = true;
      const status = response.status();
      facts.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      facts.body_attempted = true;
      const bytes = await response.body();
      facts.body_returned = true;
      expect(bytes.byteLength <= 4096).toBe(true);
      facts.body_bounded = true;
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (leaked(raw)) faults.secret++;
      const value = decodeJson(raw, response.headers()['content-type'], parsed => {
        // Parsing succeeded here; the closed decoder can still reject the DTO.
        facts.decoded = true;
        return validator(parsed);
      });
      facts.validated = true;
      // Count separators outside strings so duplicate keys cannot hide in JSON.parse.
      const fields = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length - 1;
      expect(check(value, status, fields)).toBe(true);
      facts.exact = true;
      return value;
    }
    // The installed recorder can capture DOM on failures even with trace/screenshot/video off.
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
          displayReads.push({ kind: 'events', matching_head: observed.latest.acquired && url.pathname === `/v1/sessions/${sid}/conversation/events`
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
        if (Object.keys(body).sort().join(',') !== fields || !uuid(body.operation_id)
          || (kind === 'task' && (!uuid(body.run_id) || wire.tasks.length === 2))
          || (kind === 'create' && wire.create !== null)) { faults.request++; return; }
        const expected = kind === 'task' ? { operation_id: body.operation_id, run_id: body.run_id, text: TASKS[wire.tasks.length] }
          : { operation_id: body.operation_id, title: titles[0], workspace: body.workspace };
        if (raw !== JSON.stringify(expected) || leaked(raw)) faults.request++;
        if (kind === 'task') wire.tasks.push(body);
        else wire.create = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300 && !(path === taskPath && response.request().method() === 'POST' && response.status() === 422)) faults.response++;
      if (files.has(path)) assets.add(path);
      if (path.endsWith('/conversation')) displayReads.push({ kind: 'latest', status: response.status(),
        exact: path === `/v1/sessions/${sid}/conversation` && new URL(response.url()).search === '' });
    });
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
    async function privateBoundary() {
      const evidence = await page.evaluate(async owner => {
        const dom = document.documentElement.cloneNode(true);
        // Only validated public field attributes leave this detached privacy clone.
        for (const field of dom.querySelectorAll('[data-field]')) {
          const id = field.getAttribute('data-field');
          if (!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return { values: [owner], empty: false };
          field.removeAttribute('data-field');
        }
        return { values: [dom.outerHTML, location.href, JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)],
        empty: localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0 };
      }, fixture.owner);
      expect(evidence.empty && !evidence.values.some(value => value && leaked(value))).toBe(true);
      expect((await context.cookies()).length).toBe(0);
      expect(await page.locator('.command em,.command img,.command script,.command a,.run em,.run img,.run script,.run a,.conversation h2 em,img,iframe').count()).toBe(0);
    }
    async function noWork(tasks) {
      const { id: _proofId, ...proof } = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.completed,
        proof.prepared_exact, proof.fresh_parents, proof.continuations, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(11).fill(0));
      expect([proof.response_finishes, proof.terminal_sequences, proof.result_sequences].every(items => items.length === 0)).toBe(true);
      expect(proof.gate === null && proof.provider_stage === 'request' && !proof.provider_failed && proof.read_failure === null).toBe(true);
      expect([proof.accepted.length, proof.receipts.length]).toEqual(tasks === 0 ? [0, 0] : [1, 1]);
      expect(proof.sequence_count).toBe(tasks === 0 ? '1' : '3');
      if (tasks !== 0) {
        // This closed audit checks every command/event/projection, selection digest and empty tool table.
        // The warning control also audits seed head 1; a second acceptance cannot hide in these counts.
        const { id: _auditId, ...audit } = await fixture.inspectTask();
        expect(audit.exact && audit.run_state === 'accepted' && audit.sequence_count === '3').toBe(true);
        expect([audit.task_commands, audit.runs, audit.acceptance_events, audit.selection_events,
          audit.binding_events, audit.rename_events, audit.deltas, audit.tool_starts, audit.tool_finishes]).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0]);
        expect(audit.receipt.operation_id === wire.tasks[0].operation_id && audit.receipt.session_id === sid
          && audit.receipt.run_id === wire.tasks[0].run_id && audit.receipt.first_sequence === '2' && audit.receipt.last_sequence === '3').toBe(true);
        expect(JSON.stringify(proof.receipts[0]) === JSON.stringify(audit.receipt)
          && proof.accepted[0].run_id === wire.tasks[0].run_id && proof.accepted[0].accepted_sequence === '2').toBe(true);
        if (durable === undefined) { durable = audit; stableProof = proof; }
        else expect(JSON.stringify(audit) === JSON.stringify(durable) && JSON.stringify(proof) === JSON.stringify(stableProof)).toBe(true);
      } else {
        const audit = await fixture.inspectMutations();
        expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
        const entry = audit.creations[0];
        expect(entry.exact && entry.catalog_current && entry.sequence_count === '1' && entry.catalog_head_sequence === '1'
          && entry.rename_events === 0 && entry.renames.length === 0 && entry.rename_event_ids.length === 0
          && entry.receipt.session_id === sid && entry.receipt.operation_id === wire.create.operation_id).toBe(true);
      }
      expect(posts).toEqual({ create: 1, task: tasks, other: 0 });
      expect(faults.reconcile).toBe(0);
      expect(displayReads).toEqual([{ kind: 'latest', status: 200, exact: true }, { kind: 'events', matching_head: true }]);
    }
    const task = page.getByLabel('Task', { exact: true });
    const createCommand = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^create:/ }) });
    const commands = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) });
    const command = commands.nth(1);
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const run = page.locator('.run');
    const title = page.getByRole('heading', { name: 'Canonical session title', exact: true });
    async function acceptedTruth() {
      const first = commands.nth(0);
      await exact(first.locator('h3'), 'task: accepted');
      await exact(first.locator('.metadata'), `Operation: ${wire.tasks[0].operation_id}\nSession: ${sid}`);
      await exact(first.locator('details pre'), TASKS[0]);
      await exact(first.locator(':scope > pre'), `Accepted receipt (not completion)\nOperation: ${wire.tasks[0].operation_id}\nSession: ${sid}\nRun: ${wire.tasks[0].run_id}\nSequences: 2 to 3\n\nWarning: storage.connection_cleanup_failed; duplicate: false\n\nAccepted is not completed.`);
      await expect(first.getByRole('button', { name: 'Retry identical command', exact: true })).toBeHidden();
      await expect(first.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true })).toBeVisible();
      expect(await createCommand.evaluate(node => node.outerHTML) === creationArticle).toBe(true);
      await expect(run).toHaveCount(1);
      await expect(run).toHaveAttribute('data-run', wire.tasks[0].run_id);
      await exact(run.locator(':scope > .metadata'), 'Execution: accepted. Final result not recorded.');
      await expect(run.locator('.entry > h4')).toHaveText(['Human']);
      const human = run.locator('.entry');
      await expect(human).toHaveAttribute('data-entry', 'e:2:0');
      await exact(human.locator('[data-field] pre'), TASKS[0]);
      await exact(human.locator(':scope > .metadata').first(), 'Recorded state: accepted; Provisional: false');
      await exact(human.locator('[data-field] > .metadata'), `Recorded bytes: ${Buffer.byteLength(TASKS[0])}; generation: 2`);
      await exact(run.locator(':scope > details > pre'), `Run: ${wire.tasks[0].run_id}\nAccepted sequence: 2\nOutcome: not recorded\nEvents complete: not recorded\nSink error: none\nSummary not recorded.`);
      expect((await transcript.textContent()).includes(TASKS[1])).toBe(false);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
      await exact(page.locator('.conversation > div > .metadata').first(), 'Observation: streaming');
      // Accepted is not completed; the explicit Cancel control must never be clicked here.
      await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeEnabled();
      if (acceptedArticle !== undefined) expect(await first.evaluate(node => node.outerHTML) === acceptedArticle).toBe(true);
      if (humanArticle !== undefined) expect(await run.evaluate(node => node.outerHTML) === humanArticle).toBe(true);
    }
    async function rejectedTruth(draft) {
      await acceptedTruth();
      await expect(page.locator('.command')).toHaveCount(3);
      await expect(commands).toHaveCount(2);
      await exact(command.locator('h3'), 'task: rejected');
      await exact(command.locator(':scope > pre'), 'HTTP 422\nCode: invalid_request\nStage: history\nCertainty: not_applicable');
      await exact(command.locator('details pre'), TASKS[1]);
      await exact(command.locator('.metadata'), `Operation: ${wire.tasks[1].operation_id}\nSession: ${sid}`);
      expect(await task.inputValue() === draft).toBe(true);
      // Rejection keeps explicit recovery available; this case must not activate either control.
      for (const name of ['Retry identical command', 'Reconcile receipt (read only)']) {
        const control = command.getByRole('button', { name, exact: true });
        await expect(control).toBeVisible();
        await expect(control).toBeEnabled();
      }
      if (rejectedArticle !== undefined) expect(await command.evaluate(node => node.outerHTML) === rejectedArticle).toBe(true);
    }

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    const [created] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === '/v1/sessions' && response.request().method() === 'POST'),
        observed.create, validateCreateView, (value, status, fields) => status === 201 && fields === 10 && uuid(value.session_id)
          && value.receipt.session_id === value.session_id && value.receipt.operation_id === wire.create.operation_id
          && value.receipt.run_id === null && value.receipt.first_sequence === '1' && value.receipt.last_sequence === '1'
          && value.duplicate === false && value.warning_code === null),
      page.getByRole('button', { name: 'Create session', exact: true }).click(),
    ]);
    await exact(createCommand.locator('h3'), 'create: accepted');
    const audit = await fixture.inspectMutations();
    sid = audit.creations[0].receipt.session_id;
    expect(created.receipt).toEqual(audit.creations[0].receipt);
    taskPath = `/v1/sessions/${sid}/runs`;
    await createCommand.locator('summary').click();
    await exact(createCommand.locator('details pre'), titles[0]);
    await exact(createCommand.locator(':scope > pre'), `Accepted receipt (not completion)\nOperation: ${wire.create.operation_id}\nSession: ${sid}\nRun: none\nSequences: 1 to 1\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    creationArticle = await createCommand.evaluate(node => node.outerHTML);
    await fixture.request({ command: 'select', session_id: sid });
    await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === `/v1/sessions/${sid}/conversation` && response.request().method() === 'GET'),
        observed.latest, validateConversationPage, (value, status) => status === 200 && value.session_id === sid
          && value.session.session_id === sid && value.session.title === titles[0] && value.session.workspace === wire.create.workspace
          && value.snapshot_head === '1' && value.session.head_sequence === '1' && value.block === null && value.entries.length === 0
          && value.previous_block === null && value.earlier_activity === null
          && value.live_after === `g11l.${Buffer.from(JSON.stringify([1, sid, '1', '3', '', ''])).toString('base64url')}`),
      createCommand.getByRole('button', { name: 'Open receipt session', exact: true }).click(),
    ]);
    await exact(transcript, 'No messages yet.');
    await exact(title, titles[0]);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await noWork(0);
    await privateBoundary();

    stage = 'first Send commits the armed cleanup warning';
    expect((await fixture.request({ command: 'arm_acceptance_warning' })).event === 'acceptance_warning_armed').toBe(true);
    await task.fill(TASKS[0]);
    expect(await task.inputValue() === TASKS[0]).toBe(true);
    [replies[0]] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
        observed.tasks[0], value => validateDisplayTaskAccepted(value, { ...wire.tasks[0], session_id: sid }),
        (value, status, fields) => status === 202 && fields === 10 && value.duplicate === false
          && value.warning_code === 'storage.connection_cleanup_failed' && value.notices.length === 0
          && value.receipt.first_sequence === '2' && value.receipt.last_sequence === '3'),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    await commands.nth(0).locator('summary').click();
    await acceptedTruth();
    await expect(page.locator('.command')).toHaveCount(2);
    expect(await task.inputValue() === '').toBe(true);
    acceptedArticle = await commands.nth(0).evaluate(node => node.outerHTML);
    humanArticle = await run.evaluate(node => node.outerHTML);
    await noWork(1);
    expect(replies[0].receipt).toEqual(durable.receipt);
    await privateBoundary();

    stage = 'second Send rejects incomplete stored history';
    await task.fill(TASKS[1]);
    expect(await task.inputValue() === TASKS[1]).toBe(true);
    [replies[1]] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
        observed.tasks[1], validateErrorView, (value, status, fields) => status === 422 && fields === 6 && value.code === 'invalid_request'
          && value.stage === 'history' && value.certainty === 'not_applicable' && value.acceptance === null && value.notices.length === 0),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    await exact(command.locator('h3'), 'task: rejected');
    await command.locator('summary').click();
    await rejectedTruth(TASKS[1]);
    rejectedArticle = await command.evaluate(node => node.outerHTML);
    expect(new Set([sid, wire.create.operation_id, ...wire.tasks.flatMap(body => [body.operation_id, body.run_id])]).size).toBe(6);
    await noWork(2);
    await privateBoundary();

    stage = 'finite no-retry window and immutable rejected draft';
    await task.fill(EDIT);
    await page.waitForTimeout(500);
    await rejectedTruth(EDIT);
    await exact(title, titles[0]);
    await noWork(2);
    await privateBoundary();

    stage = 'embedded asset integrity and Disconnect clearing';
    await expect.poll(() => assets.size).toBe(files.size);
    assetEvidence = await page.evaluate(checkEmbeddedAssets, { secrets,
      files: await Promise.all([...files].map(async ([path, file]) => [path, [...await readFile(new URL(`../${file}`, import.meta.url))]])) });
    expect(assetEvidence).toEqual({ checked: files.size, failures: [] });
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
    }, [...TASKS, EDIT, titles[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(2);
    expect(resourceErrors).toBe(1);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    expect(Object.values(observed).flatMap(value => Array.isArray(value) ? value : [value]).every(facts => facts.exact)).toBe(true);
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-incomplete-history\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Incomplete history failed: ${stage}; kind=${kind} line=${line}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}; resource_errors=${resourceErrors}; display=${JSON.stringify(displayReads)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      // Keep the guard enabled if owned close fails and Playwright must close the context later.
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Incomplete history browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Incomplete history fixture cleanup failed'); }
  }
  console.log(`Incomplete history cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  console.log(`Incomplete history evidence: warning_202_exact=${observed.tasks[0].exact} history_422_exact=${observed.tasks[1].exact} assets_checked=${assetEvidence.checked}; create_posts=${posts.create} task_posts=${posts.task} other_posts=${posts.other}; persistent_articles=3 first_warning_unchanged=true human_only=true; sessions=2 browser_sequence=3 seed_sequence=1 task_commands=1 task_receipts=1 runs_accepted=1 checkpoints=1 runtime=0 bindings=0 results=0 terminals=0 interrupts=0 renames=0 tools=0 provider_connections=0 provider_requests=0 auth_loads=0 auth_prepares=0 cancel=0 retry=0 reconcile=0 expected_console_errors=${resourceErrors} observation_ms=500 disconnect_ms=300 disconnect_cleared=true; replies=${JSON.stringify(observed)} matching_display_sse=true`);
});
