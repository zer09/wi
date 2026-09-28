import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { armReplyLoss } from '../test-support/mutations.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n'; // browser.rs TASKS[0], unchanged.
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const ARGUMENTS = '{"a":17,\r\n "b":25}';
const OUTPUT = '{"sum":42}';
const EDITED = '  Edited unsent draft 雪\n<em>still inert</em>\n';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('one task: canonical acceptance wins a lost HTTP reply, explicit GET recovery, then real tool completion', async ({ browser }) => {
  let fixture;
  let context;
  let loss;
  let failure;
  let stage = 'startup';
  let taskPath;
  let taskUrl;
  let dropping = false;
  let expectedNetworkErrors = 0;
  let captured = null;
  const faults = { external: 0, console: 0, page: 0, secret: 0, asset: 0, response: 0 };
  const requests = [];
  const count = (method, path) => requests.filter(request => request.method === method && request.path === path).length;
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
      // No Authorization, request objects or query strings are retained or logged.
      requests.push({ method: request.method(), path: url.pathname });
      if (request.method() === 'POST' && url.pathname === taskPath) {
        try {
          const body = request.postDataJSON();
          if (captured !== null || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
            || body.text !== TASK || ![body.operation_id, body.run_id].every(id => typeof id === 'string'
              && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) faults.response++;
          else captured = { operation_id: body.operation_id, run_id: body.run_id };
        } catch { faults.response++; }
      }
      if (url.pathname.endsWith('/history') && count('GET', url.pathname) === 2) {
        const sid = url.pathname.split('/')[3];
        if (url.searchParams.get('after') !== `${sid}:1` || url.searchParams.get('through') !== '3'
          || url.searchParams.get('limit') !== '32' || [...url.searchParams.keys()].sort().join(',') !== 'after,limit,through') faults.response++;
      }
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
        // Public embedded assets only. Never inspect any API response headers or bodies.
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
      if (dropping && message.location().url === taskUrl
        && message.text() === 'Failed to load resource: net::ERR_FAILED' && expectedNetworkErrors === 0) expectedNetworkErrors++;
      else faults.console++;
    });
    page.on('pageerror', error => { faults.page++; if (leaked(error.message)) faults.secret++; });
    async function privateBoundary() {
      expect(await page.evaluate(async secrets => {
        const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
          JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie,
          ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
        return !secrets.some(secret => values.some(value => value?.includes(secret)))
          && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0;
      }, secrets)).toBe(true);
      expect((await context.cookies()).length).toBe(0);
      expect(await page.locator('.run em,.run script,.run img,.run a,.command em,.conversation h2 em,img,iframe').count()).toBe(0);
    }
    function postCounts() {
      expect(requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/v1/sessions', taskPath]);
    }
    function quiet(proof, requestCount, toolCount, completed) {
      expect([proof.requests, proof.connections, proof.auth_loads, proof.auth_prepares, proof.prepared_exact,
        proof.tool_results, proof.terminals, proof.results, proof.completed]).toEqual([requestCount, 1, 1, 1, requestCount, toolCount, completed, completed, completed]);
      expect(proof.provider_failed || proof.read_failure !== null).toBe(false);
      expect(proof.accepted.length).toBe(1);
      expect(proof.receipts.length).toBe(1);
      expect(proof.fresh_empty && !proof.restored_history).toBe(true);
      expect(proof.fresh_parents).toBe(1);
      expect(proof.continuations).toBe(requestCount - 1);
      postCounts();
    }
    const outcome = page.locator('.commands > section > pre');
    const command = page.locator('.command');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const run = transcript.locator('.run');
    const cursor = page.locator('.conversation > div > .metadata').first();
    const taskField = page.getByLabel('Task', { exact: true });

    stage = 'browser create and canonical selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    const workspace = page.getByLabel(/^Workspace/);
    const workspaceValue = await workspace.inputValue();
    const [createReply] = await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create session', exact: true }).click(),
    ]);
    expect(createReply.status()).toBe(201);
    const creation = await fixture.inspectMutations();
    expect([creation.session_count, creation.seed_sessions, creation.creations.length]).toEqual([2, 1, 1]);
    const created = creation.creations[0];
    expect(created.exact && created.catalog_current && created.rename_events === 0 && created.sequence_count === '1').toBe(true);
    const sid = created.receipt.session_id;
    taskPath = `/v1/sessions/${sid}/runs`;
    taskUrl = `${fixture.origin}${taskPath}`;
    await expect(outcome).toContainText('Accepted receipt (not completion)');
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), titles[0]);
    await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspaceValue}\nSession: ${sid}`);
    await exact(cursor, `Applied cursor: ${sid}:1\nSnapshot head: 1`);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await exact(transcript, 'No messages yet.');
    await fixture.request({ command: 'select', session_id: sid });
    await privateBoundary();

    stage = 'exact composer command remains unsaved before SQL commit';
    await fixture.request({ command: 'arm_acceptance' });
    // router.rs returns ACCEPTED for this actual task reply. CDP only fails that response.
    loss = await armReplyLoss(await context.newCDPSession(page), taskUrl, 202);
    await taskField.fill(TASK);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await fixture.request({ command: 'wait_acceptance' });
    await exact(command.locator('h3'), 'task: sending');
    await command.locator('summary').click();
    await exact(command.locator('details pre'), TASK);
    await expect(run).toHaveCount(0);
    const before = await fixture.inspect();
    expect([before.requests, before.connections, before.auth_loads, before.auth_prepares, before.results,
      before.receipts.length, before.accepted.length]).toEqual(Array(7).fill(0));
    expect(before.sequence_count).toBe('1');
    expect(captured !== null).toBe(true);
    await exact(command.locator('.metadata'), `Operation: ${captured.operation_id}\nSession: ${sid}`);
    await taskField.fill(EDITED);
    await exact(command.locator('details pre'), TASK);
    postCounts();
    await fixture.request({ command: 'release_acceptance' });
    expect(await loss.wait()).toBe(202);
    await fixture.wait('model_paused', 1);

    stage = 'read-only SQLite acceptance audit before dropping the actual reply';
    const committed = await fixture.inspectTask();
    const receipt = committed.receipt;
    expect(receipt.operation_id === captured.operation_id && receipt.run_id === captured.run_id && receipt.session_id === sid).toBe(true);
    expect([receipt.first_sequence, receipt.last_sequence]).toEqual(['2', '3']);
    expect([committed.task_commands, committed.runs, committed.acceptance_events, committed.selection_events,
      committed.binding_events, committed.rename_events, committed.deltas, committed.tool_starts, committed.tool_finishes]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
    expect(committed.exact && committed.run_state === 'running').toBe(true);
    const accepted = await fixture.inspect();
    quiet(accepted, 1, 0, 0);
    expect(accepted.response_finishes.length).toBe(0);
    expect(JSON.stringify(accepted.receipts[0]) === JSON.stringify(receipt)).toBe(true);
    expect(accepted.accepted[0]).toEqual({ run_id: receipt.run_id, accepted_sequence: '2' });
    expect(accepted.sequence_count).toBe(committed.sequence_count);
    await exact(cursor, `Applied cursor: ${sid}:${committed.sequence_count}\nSnapshot head: 1`);
    await exact(run.locator('.user-text'), TASK);
    await expect(run).toContainText('Execution: running. Final result not recorded.');
    await exact(command.locator('h3'), 'Canonical acceptance; receipt recovery');
    await expect(page.locator('.commands > div').first().locator('.command')).toHaveCount(0);
    await expect(command.locator('details')).toHaveCount(0);
    await expect(command.getByRole('button')).toHaveCount(1);
    await expect(command.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry identical command', exact: true })).toHaveCount(0);
    await expect(taskField).toHaveValue(EDITED);
    expect((await outcome.textContent()).includes(receipt.operation_id)).toBe(false);

    stage = 'lost reply cannot demote known canonical acceptance or invent a receipt';
    dropping = true;
    await loss.drop();
    await exact(command.locator(':scope > pre'), 'Network reply unavailable. This does not establish whether a command was accepted.\n\nCanonical task already accepted. Only read-only reconciliation is available; do not execute again.\n\nAccepted is not completed. Read canonical history for execution state.');
    await exact(command.locator('h3'), 'Canonical acceptance; receipt recovery');
    await exact(command.locator('.metadata'), `Operation: ${receipt.operation_id}\nSession: ${sid}`);
    await expect(taskField).toHaveValue(EDITED);
    await page.waitForTimeout(300);
    const { id: _committedId, ...stable } = committed;
    const { id: _lostId, ...lost } = await fixture.inspectTask();
    expect(JSON.stringify(lost) === JSON.stringify(stable)).toBe(true);
    quiet(await fixture.inspect(), 1, 0, 0);
    await privateBoundary();

    stage = 'explicit GET operation, run and exact two-record history establish the same receipt';
    const operationPath = `/v1/sessions/${sid}/operations/${receipt.operation_id}`;
    const runPath = `${taskPath}/${receipt.run_id}`;
    const historyPath = `/v1/sessions/${sid}/history`;
    expect([count('GET', operationPath), count('GET', runPath), count('GET', historyPath)]).toEqual([0, 0, 1]);
    const baseline = requests.length;
    await command.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true }).click();
    await exact(outcome, `task command\n\nAccepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id}\nSequences: 2 to 3`);
    await expect(command).toHaveCount(0);
    expect(requests.slice(baseline)).toEqual([operationPath, runPath, historyPath].map(path => ({ method: 'GET', path })));
    expect([count('GET', operationPath), count('GET', runPath), count('GET', historyPath)]).toEqual([1, 1, 2]);
    const { id: _reconciledId, ...reconciled } = await fixture.inspectTask();
    expect(JSON.stringify(reconciled) === JSON.stringify(stable)).toBe(true);
    quiet(await fixture.inspect(), 1, 0, 0);
    await exact(cursor, `Applied cursor: ${sid}:${committed.sequence_count}\nSnapshot head: 1`);
    await expect(run).toContainText('Execution: running. Final result not recorded.');
    await expect(taskField).toHaveValue(EDITED);

    stage = 'Drive 1 releases first provider turn and exactly one real add_numbers result';
    await fixture.request({ command: 'drive', gate: 1 });
    await fixture.wait('model_paused', 2);
    await occurrences(run, OUTPUT, 1);
    await occurrences(run, ARGUMENTS, 1);
    const tool = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Tool: add_numbers', exact: true }) });
    await expect(tool).toHaveCount(1);
    await expect(tool).toContainText('finished (success)');
    await expect(tool).toContainText('Result: success');
    await occurrences(run, ANSWER, 0);
    quiet(await fixture.inspect(), 2, 1, 0);
    const tools = await fixture.inspectTask();
    expect([tools.tool_starts, tools.tool_finishes, tools.deltas]).toEqual([1, 1, 0]);
    await expect(run).toContainText('Final result not recorded.');

    stage = 'Drive 2 exposes a committed provisional answer without completion';
    await fixture.request({ command: 'drive', gate: 2 });
    await fixture.wait('model_paused', 3);
    const partial = await fixture.inspectTask();
    expect(partial.deltas).toBe(1);
    await exact(cursor, `Applied cursor: ${sid}:${partial.sequence_count}\nSnapshot head: 1`);
    await occurrences(run, '42 雪', 1);
    await occurrences(run, ANSWER, 0);
    quiet(await fixture.inspect(), 2, 1, 0);
    await expect(run).toContainText('Final result not recorded.');
    await privateBoundary();

    stage = 'Drive 3 finalizes the response and separately records the real run result';
    await fixture.request({ command: 'drive', gate: 3 });
    await fixture.wait('task_finished', 1);
    const finished = await fixture.inspect();
    quiet(finished, 2, 1, 1);
    expect(finished.provider_stage).toBe('finished');
    expect(finished.response_finishes.length).toBe(2);
    expect(finished.response_finishes.map(response => response.provenance)).toEqual(['native_terminal', 'native_terminal']);
    const response = finished.response_finishes.at(-1).sequence;
    const terminal = finished.terminal_sequences[0];
    const result = finished.result_sequences[0];
    expect(BigInt(response) < BigInt(terminal) && BigInt(terminal) < BigInt(result)).toBe(true);
    expect(finished.sequence_count).toBe(result);
    await exact(cursor, `Applied cursor: ${sid}:${result}\nSnapshot head: 1`);
    await expect(run).toHaveCount(1);
    await expect(run).toContainText('Execution: completed. Final result recorded.');
    await expect(run).toContainText('Output provenance: native_terminal');
    await expect(run).toContainText('Terminal outcome: completed');
    await expect(run).toContainText('Outcome: completed');
    await expect(run).toContainText('new_tool_dispatches: 1');
    await expect(run).toContainText('model_requests_admitted: 2');
    await occurrences(run, ANSWER, 1);
    await occurrences(run, '42 雪', 0);
    await occurrences(run, OUTPUT, 1);
    await exact(run.locator('.user-text'), TASK);
    await expect(command).toHaveCount(0);
    await expect(taskField).toHaveValue(EDITED);
    const final = await fixture.inspectTask();
    expect(final.exact && final.run_state === 'completed' && final.sequence_count === result).toBe(true);
    expect([final.task_commands, final.runs, final.acceptance_events, final.selection_events,
      final.binding_events, final.rename_events, final.deltas, final.tool_starts, final.tool_finishes]).toEqual([1, 1, 1, 1, 1, 0, 1, 1, 1]);
    expect(JSON.stringify(final.receipt) === JSON.stringify(receipt)
      && final.accepted_event_id === committed.accepted_event_id && final.checkpoint_event_id === committed.checkpoint_event_id).toBe(true);

    stage = 'explicit real run read and final no-retry, no-cancel, no-private-state evidence';
    await run.getByRole('button', { name: 'Read run status', exact: true }).click();
    await expect(page.locator('pre.metadata').filter({ hasText: /^Read-only run view:/ }))
      .toContainText(`Execution: completed\nResult recorded: true\nTerminal sequence: ${terminal}\nResult sequence: ${result}\nOutcome: completed`);
    await page.waitForTimeout(300);
    expect([count('GET', operationPath), count('GET', runPath), count('GET', historyPath), count('GET', `/v1/sessions/${sid}/events`),
      count('GET', '/v1/settings'), count('GET', '/v1/sessions')]).toEqual([1, 2, 2, 1, 1, 1]);
    quiet(await fixture.inspect(), 2, 1, 1);
    await privateBoundary();
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect(expectedNetworkErrors).toBe(1);
    expect(await page.locator('.error').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
    expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.run,.command')).toHaveCount(0);
    await expect(taskField).toHaveValue('');
    await privateBoundary();
    quiet(await fixture.inspect(), 2, 1, 1);
    console.log(`Task recovery: ordering=canonical-first tasks=1 task_posts=1 retry_posts=0 create_posts=1 reconcile_gets=3 final_run_gets=1 provider_requests=2 connections=1 auth_loads=1 auth_prepares=1 tool_results=1 response_finishes=2 terminals=1 results=1 response=${response} terminal=${terminal} result=${result} applied=${result} cancel_posts=0`);
  } catch {
    // Never attach raw assertions, captured commands, response data, DOM or child diagnostics.
    failure = new Error(`Task recovery failed: ${stage}; counts=${JSON.stringify(faults)}; task_posts=${count('POST', taskPath)}`);
  } finally {
    try { await loss?.stop(); } catch { failure ??= new Error('Task recovery interceptor cleanup failed'); }
    try { await context?.close(); } catch { failure ??= new Error('Task recovery browser cleanup failed'); }
    try { await fixture?.stop(); } catch { failure ??= new Error('Task recovery fixture cleanup failed'); }
  }
  if (failure) throw failure;
});
