import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { decodeJson, validateErrorView } from '../dist/api.js';
import { validateConversationPage } from '../dist/display-api.js';

const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const TITLE = 'Legacy completed conversation';
const EDIT = '  edited but not sent 雪\n<em>unsent</em>  ';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('completed legacy history stays readable but one explicit Send rejects unbound replay without any new work', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let context;
  let page;
  let failure;
  let stage = 'startup';
  const replyFacts = () => ({ acquired: false, status: null, body_attempted: false, body_returned: false,
    body_bounded: false, decoded: false, validated: false, exact: false });
  const observed = { latest: replyFacts(), task: replyFacts() };
  let latest;
  let workspace;
  let legacyArticle;
  let rejectedArticle;
  let sid;
  let taskPath;
  let assetEvidence = null;
  let durable;
  let sent;
  let resourceErrors = 0;
  const posts = { create: 0, task: 0, rename: 0, cancel: 0, other: 0 };
  const reads = { manifest: 0, history: 0, events: 0, reconcile: 0 };
  const displayReads = [];
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, response: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true, unbound_history: true });
    sid = fixture.sessionId;
    taskPath = `/v1/sessions/${sid}/runs`;
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary', 'principal_digest',
      'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request', 'stored history has no replay provenance'];
    const leaked = text => secrets.some(secret => text.includes(secret));
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
    function completeText(entry, text) {
      return entry.content_complete && entry.earlier_content === null && entry.reference === null
        && entry.result_recorded === null && entry.finish_recorded === null && entry.is_error === null
        && entry.fields.length === 1 && entry.fields[0].kind === 'text' && entry.fields[0].text === text
        && entry.fields[0].from_byte === '0' && entry.fields[0].to_byte === String(Buffer.byteLength(text))
        && entry.fields[0].total_bytes === String(Buffer.byteLength(text))
        && !entry.fields[0].has_earlier && !entry.fields[0].has_later;
    }
    // Keep the installed failure recorder disabled until this owned context actually closes.
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
        if (url.pathname === `/v1/sessions/${sid}`) reads.manifest++;
        if (url.pathname === `/v1/sessions/${sid}/history`) reads.history++;
        if (url.pathname === `/v1/sessions/${sid}/events`) reads.events++;
        if (/\/(operations|runs)\//.test(url.pathname)) reads.reconcile++;
        if (url.pathname.endsWith('/conversation/events')) {
          const after = `g11l.${Buffer.from(JSON.stringify([1, sid, '9', '3', '', ''])).toString('base64url')}`;
          displayReads.push({ kind: 'events', matching_head: observed.latest.acquired && url.pathname === `/v1/sessions/${sid}/conversation/events`
            && url.searchParams.size === 1 && url.searchParams.get('after') === after });
        }
        return;
      }
      if (headers.origin !== fixture.origin || url.search !== '') faults.request++;
      if (url.pathname === '/v1/sessions') { posts.create++; return; }
      if (url.pathname.endsWith('/rename')) { posts.rename++; return; }
      if (url.pathname.endsWith('/cancel')) { posts.cancel++; return; }
      if (url.pathname !== taskPath) { posts.other++; return; }
      posts.task++;
      try {
        const bytes = request.postDataBuffer();
        if (bytes === null || bytes.byteLength > 4096 || sent !== undefined) { faults.request++; return; }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const body = JSON.parse(raw);
        if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || !uuid(body.operation_id) || !uuid(body.run_id)
          || new Set([sid, body.operation_id, body.run_id]).size !== 3
          || raw !== JSON.stringify({ operation_id: body.operation_id, run_id: body.run_id, text: TASKS[1] }) || leaked(raw)) faults.request++;
        sent = body;
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300 && !(path === taskPath && response.request().method() === 'POST' && response.status() === 422)) faults.response++;
      if (files.has(path)) assets.add(path);
      if (path.includes('/conversation') && !path.endsWith('/conversation/events')) displayReads.push({ kind: 'latest', status: response.status(),
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
    const task = page.getByLabel('Task', { exact: true });
    const command = page.locator('.command');
    const run = page.locator('.run');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
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
      expect(evidence.empty && !evidence.values.some(value => value && (leaked(value) || /[0-9a-f]{64}/i.test(value)))).toBe(true);
      expect((await context.cookies()).length).toBe(0);
      expect(await page.locator('.command em,.command img,.command script,.command a,.run em,.run img,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function noWork(tasks) {
      const { id: _id, ...proof } = await fixture.inspect();
      expect(proof.session_id === sid && proof.exact && proof.unchanged && proof.replay_rejected && proof.completed && proof.result_recorded).toBe(true);
      expect([proof.sequence_count, proof.seed_head]).toEqual(['9', '1']);
      expect([proof.acceptances, proof.runtime, proof.results]).toEqual([1, 6, 1]);
      expect([proof.selections, proof.bindings, proof.tools, proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares]).toEqual(Array(7).fill(0));
      if (durable === undefined) durable = proof;
      else expect(JSON.stringify(proof) === JSON.stringify(durable)).toBe(true);
      expect(posts).toEqual({ create: 0, task: tasks, rename: 0, cancel: 0, other: 0 });
      expect(reads).toEqual({ manifest: 0, history: 0, events: 0, reconcile: 0 });
      if (latest !== undefined) expect(displayReads).toEqual([{ kind: 'latest', status: 200, exact: true }, { kind: 'events', matching_head: true }]);
    }
    async function canonicalTruth() {
      await expect(run).toHaveCount(1);
      await expect(run).toHaveAttribute('data-run', latest.block.run_id);
      await expect(run.locator('.entry > h4')).toHaveText(['Human', 'assistant']);
      const human = run.locator('.entry').nth(0), answer = run.locator('.entry').nth(1);
      for (const [node, entry, text] of [[human, latest.block.human, TASKS[0]], [answer, latest.entries[0], ANSWER]]) {
        await expect(node).toHaveAttribute('data-entry', entry.entry_id);
        await expect(node.locator('[data-field]')).toHaveCount(1);
        await expect(node.locator('[data-field]')).toHaveAttribute('data-field', entry.fields[0].field_id);
        await exact(node.locator('[data-field] pre'), text);
        await exact(node.locator(':scope > .metadata').first(), `Recorded state: ${entry.recorded_state}; Provisional: false`);
        await exact(node.locator('[data-field] > .metadata'), `Recorded bytes: ${Buffer.byteLength(text)}; generation: ${entry.fields[0].generation}`);
      }
      await exact(run.locator(':scope > .metadata'), 'Execution: completed. Final result recorded.');
      await exact(run.locator(':scope > details > pre'), `Run: ${latest.block.run_id}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\n${Object.entries(latest.block.summary).map(([key, value]) => `${key}: ${value ?? 'none'}`).join('\n')}`);
      await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
      await exact(page.locator('.conversation > div > .metadata').first(), 'Observation: streaming');
      await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), TITLE);
      await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspace}\nSession: ${sid}`);
      await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeDisabled();
      expect((await transcript.textContent()).includes(TASKS[1])).toBe(false);
      if (legacyArticle !== undefined) expect(await run.evaluate(node => node.outerHTML) === legacyArticle).toBe(true);
    }
    async function rejectedTruth(draft) {
      await canonicalTruth();
      await expect(command).toHaveCount(1);
      await exact(command.locator('h3'), 'task: rejected');
      await exact(command.locator(':scope > pre'), 'HTTP 422\nCode: invalid_request\nStage: history\nCertainty: not_applicable');
      await exact(command.locator('details pre'), TASKS[1]);
      await exact(command.locator('.metadata'), `Operation: ${sent.operation_id}\nSession: ${sid}`);
      expect(await task.inputValue() === draft).toBe(true);
      for (const name of ['Retry identical command', 'Reconcile receipt (read only)']) {
        await expect(command.getByRole('button', { name, exact: true })).toBeVisible();
        await expect(command.getByRole('button', { name, exact: true })).toBeEnabled();
      }
      if (rejectedArticle !== undefined) expect(await command.evaluate(node => node.outerHTML) === rejectedArticle).toBe(true);
    }

    stage = 'real browser opens seeded legacy history';
    await noWork(0);
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    workspace = await page.locator('select').inputValue();
    [latest] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === `/v1/sessions/${sid}/conversation` && response.request().method() === 'GET'),
        observed.latest, validateConversationPage, (value, status, fields) => status === 200
          && fields === JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length - 1
          && value.session_id === sid && value.session.session_id === sid && value.session.title === TITLE && value.session.workspace === workspace
          && value.snapshot_head === '9' && value.session.head_sequence === '9' && value.previous_block === null && value.earlier_activity === null
          && value.live_after === `g11l.${Buffer.from(JSON.stringify([1, sid, '9', '3', '', ''])).toString('base64url')}`
          && value.block?.accepted_sequence === '2' && value.block.revision === '9' && value.block.state === 'completed'
          && value.block.result_recorded === true && value.block.outcome?.type === 'completed' && value.block.events_complete === true && value.block.sink_error === null
          && JSON.stringify(value.block.summary) === JSON.stringify({ turns_started: '1', turns_finished: '1', model_requests_attempted: '1', model_requests_admitted: '1',
            new_tool_dispatches: '0', tool_results_prepared: '0', reused_results: '0', last_request_id: '00000000-0000-4000-8000-000000000001', last_upstream_outcome: 'terminal_received' })
          && value.block.human.entry_id === 'e:2:0' && value.block.human.recorded_state === 'accepted' && !value.block.human.provisional
          && completeText(value.block.human, TASKS[0]) && value.entries.length === 1 && value.entries[0].entry_id === 'e:5:0'
          && value.entries[0].kind === 'assistant' && value.entries[0].recorded_state === 'completed' && !value.entries[0].provisional
          && completeText(value.entries[0], ANSWER)),
      page.locator('.session-list').getByRole('button', { name: TITLE, exact: true }).click(),
    ]);
    await canonicalTruth();
    expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    legacyArticle = await run.evaluate(node => node.outerHTML);
    await noWork(0);
    await privateBoundary();

    stage = 'one explicit Send rejects unbound replay';
    await task.fill('draft before editing');
    await task.fill(TASKS[1]);
    expect(await task.inputValue() === TASKS[1]).toBe(true);
    await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST'),
        observed.task, validateErrorView, (value, status, fields) => status === 422 && fields === 6 && value.code === 'invalid_request'
          && value.stage === 'history' && value.certainty === 'not_applicable' && value.acceptance === null && value.notices.length === 0),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    await exact(command.locator('h3'), 'task: rejected');
    await command.locator('summary').click();
    await rejectedTruth(TASKS[1]);
    rejectedArticle = await command.evaluate(node => node.outerHTML);
    await noWork(1);
    await privateBoundary();

    stage = 'finite no-auto-action interval preserves edited current draft';
    await task.fill(EDIT);
    await page.waitForTimeout(500);
    await rejectedTruth(EDIT);
    await noWork(1);
    await privateBoundary();
    expect(reads).toEqual({ manifest: 0, history: 0, events: 0, reconcile: 0 });

    stage = 'exact assets and Disconnect stability';
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
    }, [...TASKS, EDIT, TITLE, ANSWER])).toBe(true);
    await page.waitForTimeout(500);
    await noWork(1);
    await privateBoundary();
    expect(resourceErrors).toBe(1);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect(Object.values(observed).every(facts => facts.exact)).toBe(true);
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-unbound-history\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Unbound history failed: ${stage}; kind=${kind} line=${line}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}; reads=${JSON.stringify(reads)}; resource_errors=${resourceErrors}; display=${JSON.stringify(displayReads)}`);
  } finally {
    try {
      await context?.close(); cleanup.browser = context !== undefined;
      if (cleanup.browser) {
        if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
      }
    } catch { failure ??= new Error('Unbound history browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Unbound history fixture cleanup failed'); }
  }
  console.log(`Unbound history cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(6).fill(0));
  console.log(`Unbound history evidence: exact_422=${observed.task.exact} assets_checked=${assetEvidence.checked} unchanged=true legacy_readable=true chronological_rows=2 persistent_rejection=true; legacy_accept_run=1 sequences=9 runtime=6 results=1 selections=0 bindings=0 seed_head=1 task_posts=1 other_posts=0 tools=0 connections=0 provider_requests=0 auth=0 retry=0 reconcile=0 expected_console_errors=${resourceErrors} observation_ms=500 disconnect_ms=500 disconnect_stable=true; replies=${JSON.stringify(observed)} matching_display=true`);
});
