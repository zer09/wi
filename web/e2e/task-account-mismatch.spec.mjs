import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const OUTPUT = '{"sum":42}';
const EDIT = '  edited before Send 雪\n<em>not submitted</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('account mismatch is an accepted execution failure without sending history on the second WebSocket', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let sid;
  let taskPath;
  let firstHead;
  let finalAudit;
  let stableProof;
  const replyFacts = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false,
    body_bounded: false, decoded: false, validated: false, exact: false });
  const observed = { create: replyFacts(), latest: replyFacts(), tasks: [replyFacts(), replyFacts()] };
  const replies = [];
  const displayReads = [];
  let createArticle;
  const taskArticles = [];
  let firstArticle;
  let assetEvidence = null;
  let stage = 'startup';
  const wire = { create: null, tasks: [] };
  const posts = { create: 0, task: 0, other: 0 };
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, response: 0, reconcile: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    // Prefixes detect private fixture material without placing provider identities or digests in the page.
    const privateMarkers = ['synthetic-replay-', 'synthetic-account-', 'private-operator-', 'private-project-', 'private-skill-',
      'private-support-', 'private-native', 'private-skills', 'private-data', 'principal_digest', 'encrypted_content',
      'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || privateMarkers.some(marker => text.includes(marker));
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
      expect(check(value, status)).toBe(true);
      facts.exact = true;
      return value;
    }
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
        const raw = bytes.toString('utf8');
        const body = JSON.parse(raw);
        if (Object.keys(body).sort().join(',') !== (kind === 'task' ? 'operation_id,run_id,text' : 'operation_id,title,workspace')
          || !uuid(body.operation_id) || (kind === 'task' && (!uuid(body.run_id) || wire.tasks.length === 2))
          || (kind === 'create' && wire.create !== null)) { faults.request++; return; }
        const expected = kind === 'task' ? { operation_id: body.operation_id, run_id: body.run_id, text: TASKS[wire.tasks.length] }
          : { operation_id: body.operation_id, title: titles[0], workspace: body.workspace };
        if (raw !== JSON.stringify(expected) || leaked(raw)) faults.request++;
        if (kind === 'task') wire.tasks.push(body); else wire.create = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      if (response.status() >= 300) faults.response++;
      const path = new URL(response.url()).pathname;
      if (files.has(path)) assets.add(path);
      if (path.endsWith('/conversation')) displayReads.push({ kind: 'latest', status: response.status(),
        exact: path === `/v1/sessions/${sid}/conversation` && new URL(response.url()).search === '' });
    });
    page = await context.newPage();
    page.on('console', message => { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.secret++; });
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
      expect(await page.locator('.command em,.run em,.run img,.run script,.run a,img,iframe').count()).toBe(0);
    }
    const task = page.getByLabel('Task', { exact: true });
    const createCommand = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^create:/ }) });
    const commands = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) });
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const run = page.locator('.run');
    async function receiptTruth(index, receipt) {
      const command = commands.nth(index);
      await exact(command.locator('h3'), 'task: accepted');
      await exact(command.locator(':scope > pre'), `Accepted receipt (not completion)\nOperation: ${wire.tasks[index].operation_id}\nSession: ${sid}\nRun: ${wire.tasks[index].run_id}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
      await exact(command.locator('.metadata'), `Operation: ${wire.tasks[index].operation_id}\nSession: ${sid}`);
      if (!(await command.locator('details').evaluate(node => node.open))) await command.locator('summary').click();
      await exact(command.locator('details pre'), TASKS[index]);
      await expect(command.getByRole('button', { name: 'Retry identical command', exact: true })).toBeHidden();
      await expect(command.getByRole('button', { name: 'Reconcile receipt (read only)', exact: true })).toBeVisible();
    }
    async function firstTruth() {
      const first = run.nth(0);
      await expect(first).toHaveAttribute('data-run', wire.tasks[0].run_id);
      await exact(first.locator(':scope > .metadata'), 'Execution: completed. Final result recorded.');
      await expect(first.locator('.entry > h4')).toHaveText(['Human', 'assistant', 'tool', 'assistant']);
      expect(await first.locator('.entry').evaluateAll(nodes => nodes.map(node => node.dataset.entry)))
        .toEqual(['e:2:0', 'e:7:0', 'e:9:0', 'e:14:0']);
      const rows = first.locator('.entry');
      const fields = [[TASKS[0]], ['add_numbers', '{"a":17,\r\n "b":25}'], ['add_numbers', OUTPUT], [ANSWER]];
      for (let index = 0; index < fields.length; index++) {
        expect(await rows.nth(index).locator('[data-field] pre').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual(fields[index]);
        const state = index === 0 ? 'accepted' : 'completed';
        const extra = index === 2 ? '; result_recorded: true; finish_recorded: true; is_error: false' : '';
        await exact(rows.nth(index).locator(':scope > .metadata').first(), `Recorded state: ${state}; Provisional: false${extra}`);
      }
      await occurrences(first, TASKS[0], 1); await occurrences(first, ANSWER, 1);
      await occurrences(first, OUTPUT, 1); await occurrences(first, '{"a":17,\r\n "b":25}', 1);
      const recording = first.locator(':scope > details > pre');
      const requestId = (await recording.textContent()).split('\n').find(line => line.startsWith('last_request_id: '))?.slice('last_request_id: '.length);
      expect(uuid(requestId)).toBe(true);
      await exact(recording, `Run: ${wire.tasks[0].run_id}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 1\ntool_results_prepared: 1\nreused_results: 0\nlast_request_id: ${requestId}\nlast_upstream_outcome: terminal_received`);
    }
    async function finalTruth(draft) {
      await expect(run).toHaveCount(2);
      await firstTruth();
      const second = run.nth(1);
      await expect(second).toHaveAttribute('data-run', wire.tasks[1].run_id);
      await exact(second.locator(':scope > .metadata'), 'Execution: failed. Final result recorded.');
      await expect(second.locator('.entry > h4')).toHaveText(['Human']);
      await expect(second.locator('.entry')).toHaveAttribute('data-entry', `e:${finalAudit.receipt.first_sequence}:0`);
      await exact(second.locator('[data-field] pre'), TASKS[1]);
      await exact(second.locator('.entry > .metadata').first(), 'Recorded state: accepted; Provisional: false');
      await exact(second.locator(':scope > details > pre'), `Run: ${wire.tasks[1].run_id}\nAccepted sequence: ${finalAudit.receipt.first_sequence}\nOutcome: failed\nCode: history_identity\nEvents complete: true\nSink error: none\nturns_started: 0\nturns_finished: 0\nmodel_requests_attempted: 0\nmodel_requests_admitted: 0\nnew_tool_dispatches: 0\ntool_results_prepared: 0\nreused_results: 0\nlast_request_id: none\nlast_upstream_outcome: none`);
      for (let index = 0; index < 2; index++) {
        await receiptTruth(index, replies[index].receipt);
        expect(await commands.nth(index).evaluate(node => node.outerHTML) === taskArticles[index]).toBe(true);
      }
      await expect(page.locator('.command')).toHaveCount(3);
      expect(await createCommand.evaluate(node => node.outerHTML) === createArticle
        && await run.nth(0).evaluate(node => node.outerHTML) === firstArticle).toBe(true);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
      await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeDisabled();
      expect(await task.inputValue() === draft).toBe(true);
    }
    async function quiet() {
      const { id: _audit, ...audit } = await fixture.inspectTask();
      const { id: _proof, ...proof } = await fixture.inspect();
      expect(JSON.stringify(audit) === JSON.stringify(finalAudit)).toBe(true);
      expect(JSON.stringify(proof) === JSON.stringify(stableProof)).toBe(true);
      expect(posts).toEqual({ create: 1, task: 2, other: 0 });
      expect(faults.reconcile).toBe(0);
      expect(displayReads).toEqual([{ kind: 'latest', status: 200, exact: true }, { kind: 'events', matching_head: true }]);
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
        observed.create, validateCreateView, (value, status) => status === 201 && uuid(value.session_id)
          && value.receipt.session_id === value.session_id && value.receipt.operation_id === wire.create.operation_id
          && value.receipt.run_id === null && value.receipt.first_sequence === '1' && value.receipt.last_sequence === '1'
          && value.duplicate === false && value.warning_code === null),
      page.getByRole('button', { name: 'Create session', exact: true }).click(),
    ]);
    await exact(createCommand.locator('h3'), 'create: accepted');
    const creation = await fixture.inspectMutations();
    expect([creation.session_count, creation.seed_sessions, creation.creations.length]).toEqual([2, 1, 1]);
    sid = creation.creations[0].receipt.session_id;
    expect(creation.creations[0].exact && creation.creations[0].sequence_count === '1' && creation.creations[0].catalog_current).toBe(true);
    expect(created.receipt).toEqual(creation.creations[0].receipt);
    taskPath = `/v1/sessions/${sid}/runs`;
    await createCommand.locator('summary').click();
    await exact(createCommand.locator('details pre'), titles[0]);
    await exact(createCommand.locator(':scope > pre'), `Accepted receipt (not completion)\nOperation: ${wire.create.operation_id}\nSession: ${sid}\nRun: none\nSequences: 1 to 1\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    createArticle = await createCommand.evaluate(node => node.outerHTML);
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
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await privateBoundary();

    stage = 'first normal acceptance and real tool completion';
    await task.fill(EDIT); await task.fill(TASKS[0]);
    [replies[0]] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
        observed.tasks[0], value => validateDisplayTaskAccepted(value, { ...wire.tasks[0], session_id: sid }),
        (value, status) => status === 202 && value.duplicate === false && value.warning_code === null && value.notices.length === 0),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    await fixture.wait('model_paused', 1);
    const committed = await fixture.inspectTask();
    expect(committed.exact && committed.run_state === 'running').toBe(true);
    expect(replies[0].receipt).toEqual(committed.receipt);
    await receiptTruth(0, committed.receipt);
    expect(await task.inputValue() === '').toBe(true);
    taskArticles[0] = await commands.nth(0).evaluate(node => node.outerHTML);
    await fixture.request({ command: 'drive', gate: 1 });
    await fixture.wait('model_paused', 2);
    await occurrences(run.nth(0), OUTPUT, 1);
    await fixture.request({ command: 'drive', gate: 2 });
    await fixture.wait('model_paused', 3);
    await occurrences(run.nth(0), '42 雪', 1);
    await fixture.request({ command: 'drive', gate: 3 });
    await fixture.wait('task_finished', 1);
    const first = await fixture.inspectTask();
    firstHead = first.sequence_count;
    expect(first.exact && first.run_state === 'completed' && first.binding_events === 1 && first.tool_starts === 1 && first.tool_finishes === 1).toBe(true);
    expect(first.receipt).toEqual(replies[0].receipt);
    await firstTruth();
    firstArticle = await run.nth(0).evaluate(node => node.outerHTML);
    expect(await commands.nth(0).evaluate(node => node.outerHTML) === taskArticles[0]
      && await createCommand.evaluate(node => node.outerHTML) === createArticle).toBe(true);
    const firstProof = await fixture.inspect();
    expect([firstProof.connections, firstProof.requests, firstProof.auth_loads, firstProof.auth_prepares, firstProof.tool_results, firstProof.terminals, firstProof.results, firstProof.completed]).toEqual([1, 2, 1, 1, 1, 1, 1, 1]);
    expect(firstProof.sequence_count === firstHead && firstProof.response_finishes.length === 2
      && !firstProof.provider_failed && firstProof.read_failure === null).toBe(true);
    await privateBoundary();

    stage = 'one-shot private rotation after audited completion';
    expect((await fixture.request({ command: 'rotate_account' })).event === 'account_rotated').toBe(true);
    await task.fill(EDIT);
    await firstTruth();
    expect(await run.nth(0).evaluate(node => node.outerHTML) === firstArticle).toBe(true);
    await task.fill(TASKS[1]);
    [replies[1]] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
        observed.tasks[1], value => validateDisplayTaskAccepted(value, { ...wire.tasks[1], session_id: sid }),
        (value, status) => status === 202 && value.duplicate === false && value.warning_code === null && value.notices.length === 0),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    await exact(run.nth(1).locator(':scope > .metadata'), 'Execution: failed. Final result recorded.');
    await receiptTruth(1, replies[1].receipt);
    taskArticles[1] = await commands.nth(1).evaluate(node => node.outerHTML);
    expect(new Set([sid, wire.create.operation_id, ...wire.tasks.flatMap(body => [body.operation_id, body.run_id])]).size).toBe(6);
    const { id: _finalId, ...audit } = await fixture.inspectTask(); finalAudit = audit;
    const { id: _proofId, ...proof } = await fixture.inspect(); stableProof = proof;
    expect(finalAudit.exact && finalAudit.first_head === firstHead && finalAudit.history_unchanged && finalAudit.identity_checked && finalAudit.socket_closed).toBe(true);
    expect(finalAudit.receipt.operation_id === wire.tasks[1].operation_id && finalAudit.receipt.run_id === wire.tasks[1].run_id && finalAudit.receipt.session_id === sid).toBe(true);
    expect(replies[1].receipt).toEqual(finalAudit.receipt);
    expect(finalAudit.run_state === 'failed' && finalAudit.code === 'history_identity' && finalAudit.result_recorded
      && finalAudit.second_records === 6 && finalAudit.seed_head === '1').toBe(true);
    expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.tool_results, proof.terminals, proof.results, proof.completed]).toEqual([2, 2, 2, 2, 1, 2, 2, 1]);
    expect(proof.response_finishes.length === 2 && !proof.provider_failed && proof.read_failure === null).toBe(true);
    await finalTruth('');
    await privateBoundary();

    stage = 'finite no-auto-action interval and stable canonical failure';
    await task.fill(EDIT);
    await page.waitForTimeout(500);
    await finalTruth(EDIT);
    await quiet();
    await privateBoundary();
    await expect.poll(() => assets.size).toBe(files.size);
    assetEvidence = await page.evaluate(checkEmbeddedAssets, { secrets: privateMarkers,
      files: await Promise.all([...files].map(async ([path, file]) => [path, [...await readFile(new URL(`../${file}`, import.meta.url))]])) });
    expect(assetEvidence).toEqual({ checked: files.size, failures: [] });

    stage = 'Disconnect clears without cancel or retry';
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
    await quiet(); await privateBoundary();
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    expect(await page.evaluate(canaries => !canaries.some(value => document.documentElement.outerHTML.includes(value)),
      [...TASKS, EDIT, ANSWER, titles[0]])).toBe(true);
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-account-mismatch\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Account mismatch failed: ${stage}; kind=${kind} line=${line}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}; display=${JSON.stringify(displayReads)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Account mismatch browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Account mismatch fixture cleanup failed'); }
  }
  console.log(`Account mismatch cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  console.log(`Account mismatch evidence: normal_202=2 execution_failed=history_identity result_recorded=true assets=${assetEvidence.checked} task_posts=2 extra_posts=0 second_model_attempted=0 second_model_admitted=0 second_tools=0 auth_loads=2 auth_prepares=2 provider_connections=2 provider_requests=2 seed_head=1 observation_ms=500 disconnect_cleared=true; replies=${JSON.stringify(observed)} matching_display_sse=true first_history_stable=true`);
});
