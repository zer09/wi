import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateErrorView } from '../dist/api.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const FIRST = '  Add 17 and 25. 雪\n<em>task & inert</em>\n'; // browser.rs TASKS[0].
const SECOND = '  Distinct active task 雪\n<em>not queued</em>\n';
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// Keep the first run clean even if the real rejection contradicts the required HTTP status.
test('active task conflict returns the required 409 without accepting or queueing a second task', async ({ browser }) => {
  let fixture;
  let context;
  let failure;
  let stage = 'startup';
  let taskPath;
  let observed;
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0 };
  const requests = [];
  const captured = [];
  const cleanup = { browser: false, fixture: false };
  let resourceErrors = 0;
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
      requests.push({ method: request.method(), path: url.pathname });
      if (request.method() !== 'POST' || url.pathname !== taskPath) return;
      try {
        const body = request.postDataJSON();
        const expected = [FIRST, SECOND][captured.length];
        if (expected === undefined || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
          || body.text !== expected || ![body.operation_id, body.run_id].every(id => typeof id === 'string'
            && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) faults.request++;
        else captured.push({ operation_id: body.operation_id, run_id: body.run_id });
      } catch { faults.request++; }
    });
    const page = await context.newPage();
    page.on('console', message => {
      if (leaked(message.text()) || leaked(message.location().url)) faults.secret++;
      if (message.type() !== 'error') return;
      if (message.location().url === `${fixture.origin}${taskPath}`
        && /^Failed to load resource: the server responded with a status of 409 \([A-Za-z ]+\)$/.test(message.text())) resourceErrors++;
      else faults.console++;
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
      expect(await page.locator('.run em,.command em,img,iframe').count()).toBe(0);
    }
    function postCounts(tasks) {
      expect(requests.filter(request => request.method === 'POST').map(request => request.path))
        .toEqual(['/v1/sessions', ...Array(tasks).fill(taskPath)]);
    }
    function work(proof, providerRequests, tools, completed) {
      expect([proof.requests, proof.connections, proof.auth_loads, proof.auth_prepares, proof.prepared_exact,
        proof.tool_results, proof.terminals, proof.results, proof.completed])
        .toEqual([providerRequests, 1, 1, 1, providerRequests, tools, completed, completed, completed]);
      expect(proof.provider_failed || proof.read_failure !== null).toBe(false);
      expect([proof.accepted.length, proof.receipts.length, proof.fresh_parents, proof.continuations])
        .toEqual([1, 1, 1, providerRequests - 1]);
      expect(proof.fresh_empty && !proof.restored_history).toBe(true);
    }
    const command = page.locator('.command');
    const task = page.getByLabel('Task', { exact: true });
    const run = page.locator('.run');
    const outcome = page.locator('.commands > section > pre');

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(outcome).toContainText('Accepted receipt (not completion)');
    const creation = await fixture.inspectMutations();
    expect([creation.session_count, creation.seed_sessions, creation.creations.length]).toEqual([2, 1, 1]);
    const sid = creation.creations[0].receipt.session_id;
    taskPath = `/v1/sessions/${sid}/runs`;
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(page.getByRole('region', { name: 'Canonical conversation', exact: true }), 'No messages yet.');
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await fixture.request({ command: 'select', session_id: sid });
    await privateBoundary();

    stage = 'first task paused before durable acceptance';
    await fixture.request({ command: 'arm_acceptance' });
    await task.fill(FIRST);
    const firstReply = page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await fixture.request({ command: 'wait_acceptance' });
    await exact(command.locator('h3'), 'task: sending');
    await expect(run).toHaveCount(0);
    const before = await fixture.inspect();
    expect([before.requests, before.auth_loads, before.auth_prepares, before.receipts.length, before.accepted.length]).toEqual([0, 0, 0, 0, 0]);
    expect(before.sequence_count).toBe('1');
    postCounts(1);
    await fixture.request({ command: 'release_acceptance' });
    expect((await firstReply).status()).toBe(202);
    await fixture.wait('model_paused', 1);
    const committed = await fixture.inspectTask();
    expect(committed.exact && committed.run_state === 'running').toBe(true);
    expect(committed.receipt.operation_id === captured[0].operation_id && committed.receipt.run_id === captured[0].run_id).toBe(true);
    await expect(outcome).toContainText('Accepted receipt (not completion)');
    await expect(outcome).toContainText(`Operation: ${committed.receipt.operation_id}`);
    await exact(run.locator('.user-text'), FIRST);
    await expect(run).toContainText('Execution: running. Final result not recorded.');
    await expect(command).toHaveCount(0);
    work(await fixture.inspect(), 1, 0, 0);

    stage = 'distinct active task real HTTP rejection';
    await task.fill(SECOND);
    const [secondReply] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    const error = validateErrorView(await secondReply.json());
    // Only the validated closed fields are retained. No headers or raw response enter diagnostics.
    observed = { status: secondReply.status(), code: error.code, stage: error.stage, certainty: error.certainty,
      acceptance_null: error.acceptance === null, notices: error.notices.length };
    expect(error.acceptance === null && error.notices.length === 0).toBe(true);
    await exact(command.locator('h3'), 'task: rejected');
    await exact(command.locator(':scope > pre'), `HTTP ${observed.status}\nCode: ${error.code}\nStage: ${error.stage ?? 'none'}\nCertainty: ${error.certainty}`);
    await command.locator('summary').click();
    await exact(command.locator('details pre'), SECOND);
    expect(await task.inputValue() === SECOND).toBe(true);
    expect(captured.length === 2 && captured[0].operation_id !== captured[1].operation_id && captured[0].run_id !== captured[1].run_id).toBe(true);
    await exact(command.locator('.metadata'), `Operation: ${captured[1].operation_id}\nSession: ${sid}`);
    const { id: _firstId, ...firstAudit } = committed;
    const { id: _rejectedId, ...rejectedAudit } = await fixture.inspectTask();
    expect(JSON.stringify(firstAudit) === JSON.stringify(rejectedAudit)).toBe(true);
    work(await fixture.inspect(), 1, 0, 0);
    postCounts(2);

    stage = 'complete only the first task through real tool and final output';
    await fixture.request({ command: 'drive', gate: 1 });
    await fixture.wait('model_paused', 2);
    await occurrences(run, '{"sum":42}', 1);
    work(await fixture.inspect(), 2, 1, 0);
    await fixture.request({ command: 'drive', gate: 2 });
    await fixture.wait('model_paused', 3);
    await occurrences(run, '42 雪', 1);
    await fixture.request({ command: 'drive', gate: 3 });
    await fixture.wait('task_finished', 1);
    await expect(run).toContainText('Execution: completed. Final result recorded.');
    await occurrences(run, ANSWER, 1);
    await occurrences(run, '42 雪', 0);
    await expect(run).toHaveCount(1);
    await exact(run.locator('.user-text'), FIRST);
    await exact(command.locator('h3'), 'task: rejected');
    await exact(command.locator('details pre'), SECOND);
    expect(await task.inputValue() === SECOND).toBe(true);
    await page.waitForTimeout(300);
    const final = await fixture.inspectTask();
    expect(final.exact && final.run_state === 'completed').toBe(true);
    expect([final.task_commands, final.runs, final.acceptance_events, final.selection_events, final.binding_events,
      final.rename_events, final.deltas, final.tool_starts, final.tool_finishes]).toEqual([1, 1, 1, 1, 1, 0, 1, 1, 1]);
    expect(JSON.stringify(final.receipt) === JSON.stringify(committed.receipt)
      && final.accepted_event_id === committed.accepted_event_id && final.checkpoint_event_id === committed.checkpoint_event_id).toBe(true);
    const finished = await fixture.inspect();
    work(finished, 2, 1, 1);
    expect(finished.response_finishes.length).toBe(2);
    expect(finished.provider_stage).toBe('finished');
    postCounts(2);
    await privateBoundary();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.run,.command')).toHaveCount(0);
    expect(await task.inputValue() === '').toBe(true);
    await privateBoundary();
    work(await fixture.inspect(), 2, 1, 1);
    postCounts(2);
    expect(Object.values(faults)).toEqual(Array(5).fill(0));
    expect(resourceErrors).toBe(1);
    console.log(`Active conflict evidence: ${JSON.stringify(observed)}; create_posts=1 task_posts=2 accepted_tasks=1 provider_requests=2 auth_loads=1 auth_prepares=1 tool_results=1 response_finishes=2 terminals=1 results=1 rename_posts=0 cancel_posts=0 dom_cleared_by_disconnect=true`);
    stage = 'required HTTP 409 active-run contract';
    expect(observed).toEqual({ status: 409, code: 'storage.active_run_exists', stage: null,
      certainty: 'not_committed', acceptance_null: true, notices: 0 });
    expect(error).toEqual({ api_version: 1, code: 'storage.active_run_exists', stage: null,
      certainty: 'not_committed', acceptance: null, notices: [] });
  } catch {
    failure = new Error(`Active conflict failed: ${stage}; observed=${JSON.stringify(observed ?? null)}; faults=${JSON.stringify(faults)}`);
  } finally {
    try { await context?.close(); cleanup.browser = context !== undefined; }
    catch { failure ??= new Error('Active conflict browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Active conflict fixture cleanup failed'); }
  }
  // Preserve teardown evidence even when an earlier contract assertion failed.
  console.log(`Active conflict cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
});
