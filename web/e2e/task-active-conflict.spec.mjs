import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeJson, validateCreateView, validateErrorView } from '../dist/api.js';
import { validateDisplayTaskAccepted } from '../dist/display-api.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const FIRST = '  Add 17 and 25. 雪\n<em>task & inert</em>\n'; // browser.rs TASKS[0].
const SECOND = '  Distinct active task 雪\n<em>not queued</em>\n';
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// Keep the first run clean even if the real rejection contradicts the required HTTP status.
test('active task conflict returns the required 409 without accepting or queueing a second task', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let failure;
  let stage = 'startup';
  let sid;
  let taskPath;
  let observed = null;
  let responseStatus = null;
  const createFacts = { acquired: false, status: null, body_attempted: false, body_returned: false,
    body_rejected: false, body_rejection_class: null, dto_validated: false };
  let capturedCreate;
  let workspace;
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, response: 0, reconcile: 0 };
  const requests = [];
  const captured = [];
  const displayReads = [];
  const reads = [];
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
      requests.push({ method: request.method(), path: url.pathname });
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
      if (url.pathname !== taskPath && url.pathname !== '/v1/sessions') { faults.request++; return; }
      try {
        const bytes = request.postDataBuffer();
        if (bytes === null || bytes.byteLength > 4096) { faults.request++; return; }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const body = JSON.parse(raw);
        if (url.pathname === '/v1/sessions') {
          const expected = { operation_id: body.operation_id, title: titles[0], workspace };
          if (capturedCreate !== undefined || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
            || !uuid(body.operation_id) || raw !== JSON.stringify(expected) || leaked(raw)) faults.request++;
          else capturedCreate = { body, raw };
        } else {
          const expected = { operation_id: body.operation_id, run_id: body.run_id, text: [FIRST, SECOND][captured.length] };
          if (expected.text === undefined || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
            || !uuid(body.operation_id) || !uuid(body.run_id) || raw !== JSON.stringify(expected) || leaked(raw)) faults.request++;
          else captured.push({ ...body, raw });
        }
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      const url = new URL(response.url()), path = url.pathname;
      if (response.status() >= 300 && !(path === taskPath && response.request().method() === 'POST' && response.status() === 409)) faults.response++;
      if (path.endsWith('/conversation')) displayReads.push({ kind: 'latest', status: response.status(),
        exact: path === `/v1/sessions/${sid}/conversation` && url.search === '' });
      const file = files.get(path);
      if (file !== undefined) reads.push((async () => {
        const body = await response.body();
        if (response.status() !== 200 || !body.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.response++;
        if (leaked(body.toString('utf8'))) faults.secret++;
        assets.add(path);
      })().catch(() => { faults.response++; }));
    });
    const page = await context.newPage();
    page.on('console', message => {
      if (leaked(message.text()) || leaked(message.location().url)) faults.secret++;
      if (message.type() !== 'error') return;
      if (message.location().url === `${fixture.origin}${taskPath}`
        && /^Failed to load resource: the server responded with a status of 409 \([A-Za-z ]+\)$/.test(message.text())) resourceErrors++;
      else faults.console++;
    });
    page.on('pageerror', error => { faults.page++; if (leaked(error.message)) faults.secret++; });
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
      expect(await page.locator('.run em,.run script,.run img,.run a,.command em,.conversation h2 em,img,iframe').count()).toBe(0);
    }
    function postCounts(tasks) {
      expect(requests.filter(request => request.method === 'POST').map(request => request.path))
        .toEqual(['/v1/sessions', ...Array(tasks).fill(taskPath)]);
      expect(displayReads).toEqual([{ kind: 'latest', status: 200, exact: true }, { kind: 'events', matching_head: true }]);
      expect(faults.reconcile).toBe(0);
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
    const createCommand = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^create:/ }) });
    const commands = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) });
    const firstCommand = commands.first();
    const command = commands.last();
    const task = page.getByLabel('Task', { exact: true });
    const run = page.locator('.run');
    const outcome = firstCommand.locator(':scope > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    stage = 'workspace selector and Create POST';
    workspace = await page.getByLabel(/^Workspace/).inputValue();
    const [createReply] = await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create session', exact: true }).click(),
    ]);
    createFacts.acquired = true;
    const createStatus = createReply.status();
    createFacts.status = Number.isInteger(createStatus) && createStatus >= 100 && createStatus <= 599 ? createStatus : null;
    expect(createStatus).toBe(201);
    let createBytes;
    createFacts.body_attempted = true;
    try {
      createBytes = await createReply.body();
      createFacts.body_returned = true;
    } catch (cause) {
      createFacts.body_rejected = true;
      const message = typeof cause?.message === 'string' ? cause.message : '';
      // First matching marker wins. A marker is not a cause; private suffixes stay in this catch.
      if (message.includes('Network.getResponseBody')) createFacts.body_rejection_class = 'method_get_response_body';
      else if (message.includes('Target page, context or browser has been closed')) createFacts.body_rejection_class = 'target_closed';
      else if (message.includes('Target crashed')) createFacts.body_rejection_class = 'target_crashed';
      else if (cause?.name === 'TimeoutError' || /\bTimeout [0-9]+ms exceeded\b/.test(message)) createFacts.body_rejection_class = 'timeout';
      else createFacts.body_rejection_class = 'other';
      throw cause;
    }
    expect(createBytes.byteLength <= 4096).toBe(true);
    const createRaw = new TextDecoder('utf-8', { fatal: true }).decode(createBytes);
    expect(leaked(createRaw)).toBe(false);
    stage = 'closed Create response and command';
    const createAcceptance = decodeJson(createRaw, createReply.headers()['content-type'], validateCreateView);
    createFacts.dto_validated = true;
    await exact(createCommand.locator('h3'), 'create: accepted');
    await expect(createCommand.locator(':scope > pre')).toContainText('Accepted receipt (not completion)');
    await createCommand.locator('summary').click();
    await exact(createCommand.locator('details pre'), titles[0]);
    stage = 'native Create receipt identity';
    const creation = await fixture.inspectMutations();
    expect([creation.session_count, creation.seed_sessions, creation.creations.length]).toEqual([2, 1, 1]);
    const created = creation.creations[0];
    sid = created.receipt.session_id;
    expect(created.exact && created.catalog_current && created.sequence_count === '1' && created.catalog_head_sequence === '1'
      && created.rename_events === 0 && created.renames.length === 0 && created.rename_event_ids.length === 0).toBe(true);
    expect(uuid(sid) && createAcceptance.session_id === sid && createAcceptance.receipt.operation_id === capturedCreate.body.operation_id
      && createAcceptance.duplicate === false && createAcceptance.warning_code === null).toBe(true);
    // Closed DTO validation can reorder keys; receipt field values must still match exactly.
    expect(createAcceptance.receipt).toEqual(created.receipt);
    taskPath = `/v1/sessions/${sid}/runs`;
    const creationArticle = await createCommand.evaluate(node => node.outerHTML);
    stage = 'Latest before matching display stream';
    await createCommand.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), titles[0]);
    await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspace}\nSession: ${sid}`);
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await fixture.request({ command: 'select', session_id: sid });
    postCounts(0);
    await privateBoundary();

    stage = 'first task paused before durable acceptance';
    await fixture.request({ command: 'arm_acceptance' });
    await task.fill(FIRST);
    const firstReply = page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await fixture.request({ command: 'wait_acceptance' });
    await exact(firstCommand.locator('h3'), 'task: sending');
    await firstCommand.locator('summary').click();
    await exact(firstCommand.locator('details pre'), FIRST);
    await exact(firstCommand.locator('.metadata'), `Operation: ${captured[0].operation_id}\nSession: ${sid}`);
    await exact(outcome, '');
    expect(await task.inputValue() === FIRST).toBe(true);
    await expect(page.locator('.command')).toHaveCount(2);
    await expect(run).toHaveCount(0);
    const before = await fixture.inspect();
    expect([before.requests, before.auth_loads, before.auth_prepares, before.receipts.length, before.accepted.length]).toEqual([0, 0, 0, 0, 0]);
    expect([before.connections, before.prepared_exact, before.tool_results, before.terminals, before.results,
      before.completed, before.fresh_parents, before.continuations]).toEqual(Array(8).fill(0));
    expect(before.sequence_count).toBe('1');
    expect(captured.length === 1 && captured[0].raw === JSON.stringify({ operation_id: captured[0].operation_id, run_id: captured[0].run_id, text: FIRST })).toBe(true);
    postCounts(1);
    await privateBoundary();
    await fixture.request({ command: 'release_acceptance' });
    const acceptedReply = await firstReply;
    expect(acceptedReply.status()).toBe(202);
    const acceptanceBytes = await acceptedReply.body();
    expect(acceptanceBytes.byteLength <= 4096).toBe(true);
    const acceptanceRaw = new TextDecoder('utf-8', { fatal: true }).decode(acceptanceBytes);
    expect(leaked(acceptanceRaw)).toBe(false);
    const acceptance = decodeJson(acceptanceRaw, acceptedReply.headers()['content-type'],
      value => validateDisplayTaskAccepted(value, { ...captured[0], session_id: sid }));
    expect(acceptanceRaw.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 11
      && acceptance.duplicate === false && acceptance.warning_code === null && acceptance.notices.length === 0).toBe(true);
    await fixture.wait('model_paused', 1);
    const committed = await fixture.inspectTask();
    expect(committed.exact && committed.run_state === 'running').toBe(true);
    expect([committed.task_commands, committed.runs, committed.acceptance_events, committed.selection_events,
      committed.binding_events, committed.rename_events, committed.deltas, committed.tool_starts, committed.tool_finishes]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
    expect(committed.receipt.operation_id === captured[0].operation_id && committed.receipt.run_id === captured[0].run_id
      && committed.receipt.session_id === sid && committed.receipt.first_sequence === '2' && committed.receipt.last_sequence === '3').toBe(true);
    expect(acceptance.receipt).toEqual(committed.receipt);
    const receiptText = `Accepted receipt (not completion)\nOperation: ${committed.receipt.operation_id}\nSession: ${sid}\nRun: ${committed.receipt.run_id}\nSequences: 2 to 3\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`;
    await exact(firstCommand.locator('h3'), 'task: accepted');
    await exact(outcome, receiptText);
    await expect(run).toHaveCount(1);
    await expect(run).toHaveAttribute('data-run', captured[0].run_id);
    const human = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Human', exact: true }) });
    await expect(human).toHaveAttribute('data-entry', 'e:2:0');
    await exact(human.locator('[data-field] pre'), FIRST);
    await exact(human.locator(':scope > .metadata').first(), 'Recorded state: accepted; Provisional: false');
    await exact(human.locator('[data-field] > .metadata'), `Recorded bytes: ${Buffer.byteLength(FIRST)}; generation: 2`);
    await exact(run.locator(':scope > .metadata'), 'Execution: running. Final result not recorded.');
    await expect(page.locator('.command')).toHaveCount(2);
    expect(await task.inputValue() === '').toBe(true);
    expect(await createCommand.evaluate(node => node.outerHTML) === creationArticle).toBe(true);
    const acceptedArticle = await firstCommand.evaluate(node => node.outerHTML);
    const running = await fixture.inspect();
    work(running, 1, 0, 0);
    expect(JSON.stringify(running.receipts[0]) === JSON.stringify(committed.receipt)
      && running.sequence_count === committed.sequence_count).toBe(true);
    expect(running.accepted[0]).toEqual({ run_id: captured[0].run_id, accepted_sequence: '2' });

    stage = 'distinct active task real HTTP response acquisition';
    await task.fill(SECOND);
    const [secondReply] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    // A status is diagnostic evidence, not proof of a readable closed error body.
    responseStatus = secondReply.status();
    stage = 'distinct active task real HTTP body read';
    const errorBytes = await secondReply.body();
    stage = 'distinct active task real HTTP body validation';
    expect(errorBytes.byteLength <= 4096).toBe(true);
    const errorRaw = new TextDecoder('utf-8', { fatal: true }).decode(errorBytes);
    expect(leaked(errorRaw)).toBe(false);
    const error = decodeJson(errorRaw, secondReply.headers()['content-type'], validateErrorView);
    expect(errorRaw.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length === 7).toBe(true);
    // Only the validated closed fields are retained. No headers or raw response enter diagnostics.
    observed = { status: responseStatus, code: error.code, stage: error.stage, certainty: error.certainty,
      acceptance_null: error.acceptance === null, notices: error.notices.length };
    expect(error.acceptance === null && error.notices.length === 0).toBe(true);
    await exact(command.locator('h3'), 'task: rejected');
    await exact(command.locator(':scope > pre'), `HTTP ${observed.status}\nCode: ${error.code}\nStage: ${error.stage ?? 'none'}\nCertainty: ${error.certainty}`);
    await command.locator('summary').click();
    await exact(command.locator('details pre'), SECOND);
    expect(await task.inputValue() === SECOND).toBe(true);
    expect(captured.length === 2 && captured[0].operation_id !== captured[1].operation_id && captured[0].run_id !== captured[1].run_id).toBe(true);
    expect(new Set([sid, capturedCreate.body.operation_id, ...captured.flatMap(body => [body.operation_id, body.run_id])]).size === 6).toBe(true);
    expect(captured[1].raw === JSON.stringify({ operation_id: captured[1].operation_id, run_id: captured[1].run_id, text: SECOND })).toBe(true);
    await exact(command.locator('.metadata'), `Operation: ${captured[1].operation_id}\nSession: ${sid}`);
    await expect(page.locator('.command')).toHaveCount(3);
    expect(await firstCommand.evaluate(node => node.outerHTML) === acceptedArticle
      && await createCommand.evaluate(node => node.outerHTML) === creationArticle).toBe(true);
    await exact(outcome, receiptText);
    await exact(human.locator('[data-field] pre'), FIRST);
    await exact(run.locator(':scope > .metadata'), 'Execution: running. Final result not recorded.');
    await expect(run).toHaveCount(1);
    await expect(page.locator(`.run[data-run="${captured[1].run_id}"]`)).toHaveCount(0);
    const rejectedArticle = await command.evaluate(node => node.outerHTML);
    const { id: _firstId, ...firstAudit } = committed;
    const { id: _rejectedId, ...rejectedAudit } = await fixture.inspectTask();
    expect(JSON.stringify(firstAudit) === JSON.stringify(rejectedAudit)).toBe(true);
    work(await fixture.inspect(), 1, 0, 0);
    postCounts(2);

    stage = 'complete only the first task through real tool and final output';
    await fixture.request({ command: 'drive', gate: 1 });
    await fixture.wait('model_paused', 2);
    stage = 'gate 2 actual tool fields and recording facts';
    await occurrences(run, '{"sum":42}', 1);
    await occurrences(run, '{"a":17,\r\n "b":25}', 1);
    const tool = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'tool', exact: true }) });
    await expect(tool).toHaveCount(1);
    await exact(tool.locator(':scope > .metadata').first(), 'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false');
    expect(await tool.locator('[data-field] pre').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual(['add_numbers', '{"sum":42}']);
    await tool.getByText('tool_result', { exact: true }).click();
    await expect(tool.locator('details pre')).toBeVisible();
    await occurrences(run, ANSWER, 0);
    await exact(run.locator(':scope > .metadata'), 'Execution: running. Final result not recorded.');
    work(await fixture.inspect(), 2, 1, 0);
    await fixture.request({ command: 'drive', gate: 2 });
    await fixture.wait('model_paused', 3);
    stage = 'gate 3 provisional assistant without completion';
    await occurrences(run, '42 雪', 1);
    await occurrences(run, ANSWER, 0);
    const assistants = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'assistant', exact: true }) });
    const provisional = assistants.last();
    await exact(provisional.locator(':scope > .metadata').first(), 'Recorded state: in_progress; Provisional: true');
    const provisionalId = await provisional.getAttribute('data-entry');
    await exact(run.locator(':scope > .metadata'), 'Execution: running. Final result not recorded.');
    work(await fixture.inspect(), 2, 1, 0);
    await fixture.request({ command: 'drive', gate: 3 });
    await fixture.wait('task_finished', 1);
    stage = 'final chronological rows and authoritative fields';
    await expect(run).toContainText('Execution: completed. Final result recorded.');
    await occurrences(run, ANSWER, 1);
    await occurrences(run, '42 雪', 0);
    await expect(run).toHaveCount(1);
    await exact(human.locator('[data-field] pre'), FIRST);
    await expect(run.locator('.entry > h4')).toHaveText(['Human', 'assistant', 'tool', 'assistant']);
    expect(await run.locator('.entry').evaluateAll(nodes => {
      const ids = nodes.map(node => node.dataset.entry);
      if (new Set(ids).size !== ids.length || ids.some(id => !/^e:[1-9][0-9]*:(0|[1-9][0-9]*)$/.test(id))) return false;
      const positions = ids.map(id => id.split(':').slice(1).map(BigInt));
      return positions.every(([seq, slot], index) => index === 0 || seq > positions[index - 1][0]
        || (seq === positions[index - 1][0] && slot > positions[index - 1][1]));
    })).toBe(true);
    await expect(assistants).toHaveCount(2);
    await expect(provisional).toHaveAttribute('data-entry', provisionalId);
    for (let turn = 0; turn < 2; turn++) {
      const assistant = assistants.nth(turn);
      await exact(assistant.locator(':scope > .metadata').first(), 'Recorded state: completed; Provisional: false');
      const texts = turn === 0 ? ['add_numbers', '{"a":17,\r\n "b":25}'] : [ANSWER];
      expect(await assistant.locator('[data-field] pre').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual(texts);
    }
    expect(await run.locator('.entry').evaluateAll(nodes => nodes.map(node => Array.from(node.querySelectorAll('[data-field]'),
      field => field.querySelector('h5,summary').textContent)))).toEqual([
      ['text'], ['function_name', 'function_arguments'], ['tool_name', 'tool_result'], ['text'],
    ]);
    expect(await run.locator('[data-field]').evaluateAll(nodes => nodes.every(node => {
      const value = node.querySelector('pre')?.textContent;
      const metadata = node.querySelector('.metadata').textContent;
      return value !== undefined && new RegExp(`^Recorded bytes: ${new TextEncoder().encode(value).length}; generation: [1-9][0-9]*$`).test(metadata);
    }))).toBe(true);
    await exact(tool.locator(':scope > .metadata').first(), 'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false');
    await occurrences(run, '{"sum":42}', 1);
    stage = 'final lifecycle and recording summary';
    const recording = run.locator(':scope > details > pre');
    const requestId = (await recording.textContent()).split('\n').find(line => line.startsWith('last_request_id: '))?.slice('last_request_id: '.length);
    expect(uuid(requestId)).toBe(true);
    await exact(recording, `Run: ${captured[0].run_id}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 1\ntool_results_prepared: 1\nreused_results: 0\nlast_request_id: ${requestId}\nlast_upstream_outcome: terminal_received`);
    await exact(command.locator('h3'), 'task: rejected');
    await exact(command.locator('details pre'), SECOND);
    await exact(outcome, receiptText);
    expect(await task.inputValue() === SECOND).toBe(true);
    stage = '300ms stable first block and original command articles';
    const completedArticle = await run.evaluate(node => node.outerHTML);
    await page.waitForTimeout(300);
    expect(await run.evaluate(node => node.outerHTML) === completedArticle
      && await command.evaluate(node => node.outerHTML) === rejectedArticle
      && await firstCommand.evaluate(node => node.outerHTML) === acceptedArticle
      && await createCommand.evaluate(node => node.outerHTML) === creationArticle).toBe(true);
    await exact(human.locator('[data-field] pre'), FIRST);
    await occurrences(run, ANSWER, 1);
    await occurrences(run, '42 雪', 0);
    await exact(outcome, receiptText);
    expect(await task.inputValue() === SECOND).toBe(true);
    await expect(page.locator('.command')).toHaveCount(3);
    stage = 'final independent native audit and original receipt';
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
    expect(finished.response_finishes.map(response => response.provenance)).toEqual(['native_terminal', 'native_terminal']);
    const responseSequence = finished.response_finishes.at(-1).sequence;
    expect(BigInt(responseSequence) < BigInt(finished.terminal_sequences[0])
      && BigInt(finished.terminal_sequences[0]) < BigInt(finished.result_sequences[0])
      && finished.sequence_count === finished.result_sequences[0] && final.sequence_count === finished.sequence_count).toBe(true);
    postCounts(2);
    stage = 'public asset bytes and original immutable request bodies';
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    expect([...assets].sort()).toEqual([...files.keys()].sort());
    expect(capturedCreate.raw === JSON.stringify(capturedCreate.body)
      && captured.every((body, index) => body.raw === JSON.stringify({ operation_id: body.operation_id, run_id: body.run_id, text: [FIRST, SECOND][index] }))).toBe(true);
    await privateBoundary();
    stage = 'Disconnect clears display, catalog, commands and forms';
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.run,.command,.session-list li')).toHaveCount(0);
    await exact(page.locator('.transcript'), '');
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    expect(await page.getByLabel('Workspace', { exact: true }).locator('option').count()).toBe(0);
    expect(await task.inputValue() === '').toBe(true);
    expect(await page.evaluate(canaries => {
      const nodes = Array.from(document.querySelectorAll('input,textarea,select'));
      const values = [document.documentElement.outerHTML, ...nodes.map(node => node.value)];
      return nodes.every(node => node.value === '') && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [FIRST, SECOND, ANSWER, titles[0]])).toBe(true);
    await privateBoundary();
    work(await fixture.inspect(), 2, 1, 1);
    postCounts(2);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    expect(resourceErrors).toBe(1);
    console.log(`Active conflict evidence: ${JSON.stringify(observed)}; create_posts=1 task_posts=2 accepted_tasks=1 provider_requests=2 auth_loads=1 auth_prepares=1 tool_results=1 response_finishes=2 terminals=1 results=1 rename_posts=0 cancel_posts=0 dom_cleared_by_disconnect=true; create=${JSON.stringify(createFacts)}`);
    stage = 'required HTTP 409 active-run contract';
    expect(observed).toEqual({ status: 409, code: 'storage.active_run_exists', stage: null,
      certainty: 'not_committed', acceptance_null: true, notices: 0 });
    expect(error).toEqual({ api_version: 1, code: 'storage.active_run_exists', stage: null,
      certainty: 'not_committed', acceptance: null, notices: [] });
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = Number(cause?.stack?.match(/task-active-conflict\.spec\.mjs:([0-9]+):[0-9]+/)?.[1] ?? 0);
    failure = new Error(`Active conflict failed: ${stage}; kind=${kind}; source_line=${line}; response_status_available=${responseStatus !== null}; response_status=${responseStatus}; observed=${JSON.stringify(observed ?? null)}; faults=${JSON.stringify(faults)}; create=${JSON.stringify(createFacts)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      // Failed close leaves the guard enabled for Playwright's later fixture cleanup.
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Active conflict browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Active conflict fixture cleanup failed'); }
  }
  // Preserve teardown evidence even when an earlier contract assertion failed.
  console.log(`Active conflict cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
});
