import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateErrorView } from '../dist/api.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const BLANK = '  \n\t   \n ';
const START = '  雪<em>task-start</em> ';
const END = ' <img src="//invalid.test/x">終  ';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// Own the context and replace failures so no page snapshot or fill argument reaches a report.
test('whitespace-empty and HTTP-body-oversized tasks reject without accepting or starting work', async ({ browser }) => {
  let fixture;
  let context;
  let failure;
  let stage = 'startup';
  let taskPath;
  const observed = [];
  const replyEvidence = { status: null, decoded: false, validated: false };
  const requests = [];
  const captured = [];
  let firstIdentity;
  const identityChanged = { operation_changed: false, run_changed: false };
  const resourceErrors = [];
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, asset: 0, response: 0 };
  const cleanup = { browser: false, fixture: false };
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
        // Keep the raw body local to this callback; only the first IDs survive until the next request.
        const raw = request.postData();
        const body = JSON.parse(raw);
        if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || typeof body.text !== 'string'
          || ![body.operation_id, body.run_id].every(id => typeof id === 'string'
            && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) { faults.request++; return; }
        if (leaked(raw)) faults.secret++;
        const evidence = [raw, body.text].map(text => ({ byteLength: Buffer.byteLength(text, 'utf8'),
          start: text.slice(0, 64), end: text.slice(-64), digest: createHash('sha256').update(text, 'utf8').digest('hex') }));
        // Compare raw IDs only in memory; retain booleans after the second explicit Send.
        if (captured.length === 0) {
          if (body.text !== BLANK) faults.request++;
          firstIdentity = { operation_id: body.operation_id, run_id: body.run_id };
        } else if (captured.length === 1) {
          identityChanged.operation_changed = body.operation_id !== firstIdentity.operation_id;
          identityChanged.run_changed = body.run_id !== firstIdentity.run_id;
          firstIdentity = undefined;
        }
        captured.push({ body: evidence[0], text: evidence[1] });
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    const reads = [];
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300 && !(path === taskPath && [422, 413].includes(response.status()))) faults.response++;
      const file = files.get(path);
      if (file === undefined) return;
      reads.push((async () => {
        const body = await response.body();
        if (leaked(body.toString('utf8'))) faults.secret++;
        if (response.status() !== 200 || !body.equals(await readFile(new URL(`../${file}`, import.meta.url)))) faults.asset++;
        assets.add(path);
      })().catch(() => { faults.asset++; }));
    });
    const page = await context.newPage();
    page.on('console', message => {
      const text = message.text();
      if (leaked(text) || leaked(message.location().url)) faults.secret++;
      if (message.type() === 'error' && message.location().url === `${fixture.origin}${taskPath}`) {
        if (text === 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)') {
          resourceErrors.push(422); return;
        }
        if (text === 'Failed to load resource: the server responded with a status of 413 (Payload Too Large)') {
          resourceErrors.push(413); return;
        }
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
    function postCounts(tasks) {
      expect(requests.filter(request => request.method === 'POST').map(request => request.path))
        .toEqual(['/v1/sessions', ...Array(tasks).fill(taskPath)]);
      expect(captured.length).toBe(tasks);
    }
    async function noWork(tasks) {
      const proof = await fixture.inspect();
      expect([proof.connections, proof.requests, proof.auth_loads, proof.auth_prepares, proof.completed,
        proof.prepared_exact, proof.fresh_parents, proof.continuations, proof.tool_results, proof.terminals, proof.results]).toEqual(Array(11).fill(0));
      expect([proof.accepted, proof.receipts, proof.response_finishes, proof.terminal_sequences, proof.result_sequences]).toEqual([[], [], [], [], []]);
      expect(proof.sequence_count).toBe('1');
      // The fixture labels its wait for the first request before receiving any provider traffic.
      expect(proof.gate === null && proof.provider_stage === 'request' && !proof.provider_failed && proof.read_failure === null).toBe(true);
      // This closed audit checks every session's commands/runs/events, including the unrelated seed.
      const audit = await fixture.inspectMutations();
      expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
      expect(JSON.stringify(audit.creations) === JSON.stringify(creation.creations)).toBe(true);
      expect(audit.max_input_bytes).toBe(creation.max_input_bytes);
      postCounts(tasks);
    }
    const task = page.getByLabel('Task', { exact: true });
    const command = page.locator('.command');
    const outcome = page.locator('.commands > section > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
    async function preserved(locator, expected) {
      const evidence = await locator.evaluate(async node => {
        const text = node instanceof HTMLTextAreaElement ? node.value : node.textContent;
        const bytes = new TextEncoder().encode(text);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        return { byteLength: bytes.byteLength, start: text.slice(0, 64), end: text.slice(-64), digest };
      });
      // Boolean assertions keep fingerprints and large text out of Playwright's diagnostic diffs.
      expect(evidence.byteLength === expected.byteLength && evidence.start === expected.start
        && evidence.end === expected.end && evidence.digest === expected.digest).toBe(true);
    }

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    // Let create's canonical read finish before selection can abort that separate read.
    const creationRead = page.waitForResponse(response => response.request().method() === 'GET'
      && /^\/v1\/sessions\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname)).then(response => response.finished());
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(outcome).toContainText('Accepted receipt (not completion)');
    await creationRead;
    const creation = await fixture.inspectMutations();
    expect([creation.session_count, creation.seed_sessions, creation.creations.length]).toEqual([2, 1, 1]);
    const entry = creation.creations[0];
    expect(entry.exact && entry.catalog_current && entry.sequence_count === '1' && entry.catalog_head_sequence === '1'
      && entry.rename_events === 0 && entry.renames.length === 0 && entry.rename_event_ids.length === 0
      && entry.receipt.first_sequence === '1' && entry.receipt.last_sequence === '1' && entry.receipt.run_id === null).toBe(true);
    const sid = entry.receipt.session_id;
    taskPath = `/v1/sessions/${sid}/runs`;
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await fixture.request({ command: 'select', session_id: sid });
    stage = 'creation SQLite and provider idle checks';
    await noWork(0);
    await privateBoundary();
    const createEvidence = await outcome.textContent();

    const max = creation.max_input_bytes;
    // Text alone reaches the existing limit; operation/run IDs and JSON fields add envelope bytes.
    const oversized = START + 'x'.repeat(max - Buffer.byteLength(START + END, 'utf8')) + END;
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(max);
    const texts = [BLANK, oversized];
    const expected = texts.map(text => ({ byteLength: Buffer.byteLength(text, 'utf8'), start: text.slice(0, 64),
      end: text.slice(-64), digest: createHash('sha256').update(text, 'utf8').digest('hex') }));
    let blankIdentity;
    for (const [index, text] of texts.entries()) {
      stage = index === 0 ? 'whitespace input and real HTTP rejection' : 'oversized input and real HTTP rejection';
      await task.fill(text);
      await preserved(task, expected[index]);
      if (index === 1) {
        // Editing the draft cannot mutate the rejected command. Only the next explicit Send supersedes it.
        await exact(command.locator('details pre'), BLANK);
        await exact(command.locator('.metadata'), blankIdentity);
        postCounts(1);
      }
      const [{ status, error }] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST')
          .then(async response => {
            replyEvidence.status = response.status();
            replyEvidence.decoded = false; replyEvidence.validated = false;
            const value = await response.json();
            replyEvidence.decoded = true;
            const error = validateErrorView(value);
            replyEvidence.validated = true;
            return { status: response.status(), error };
          }),
        page.getByRole('button', { name: 'Send', exact: true }).click(),
      ]);
      observed.push({ status, code: error.code, stage: error.stage, certainty: error.certainty,
        acceptance_null: error.acceptance === null, notices: error.notices.length });
      const requiredStatus = index === 0 ? 422 : 413;
      const requiredCode = index === 0 ? 'context.invalid_request' : 'api.body_too_large';
      expect(status).toBe(requiredStatus);
      expect(error).toEqual({ api_version: 1, code: requiredCode, stage: null, certainty: 'not_applicable', acceptance: null, notices: [] });
      await expect(command).toHaveCount(1);
      await exact(command.locator('h3'), 'task: rejected');
      await exact(command.locator(':scope > pre'), `HTTP ${requiredStatus}\nCode: ${requiredCode}\nStage: none\nCertainty: not_applicable`);
      await command.locator('summary').click();
      await preserved(command.locator('details pre'), expected[index]);
      await preserved(task, expected[index]);
      expect(JSON.stringify(captured[index].text) === JSON.stringify(expected[index])).toBe(true);
      expect(captured[index].body.byteLength > expected[index].byteLength).toBe(true);
      if (index === 0) {
        await exact(command.locator('details pre'), BLANK);
        expect(await task.evaluate((node, blank) => node.value === blank, BLANK)).toBe(true);
        blankIdentity = await command.locator('.metadata').textContent();
      } else {
        expect(captured[index].body.byteLength > max).toBe(true);
        expect(await command.locator('.metadata').textContent() !== blankIdentity).toBe(true);
        expect(identityChanged).toEqual({ operation_changed: true, run_changed: true });
      }
      stage = index === 0 ? 'whitespace rejection stays idle' : 'oversized rejection stays idle';
      // A finite observation window checks for automatic retries without introducing a product timeout.
      await page.waitForTimeout(300);
      await expect(command).toHaveCount(1);
      await exact(command.locator('h3'), 'task: rejected');
      await preserved(command.locator('details pre'), expected[index]);
      await preserved(task, expected[index]);
      await exact(outcome, createEvidence);
      await exact(transcript, 'No messages yet.');
      await expect(page.locator('.run')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeDisabled();
      await noWork(index + 1);
      await privateBoundary();
    }

    stage = 'public assets and disconnect clears local state without mutation';
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(outcome, '');
    // Role locators exclude the hidden conversation after Disconnect; inspect its cleared DOM directly.
    await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(canaries => {
      const values = [document.documentElement.outerHTML,
        ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
      return Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === '')
        && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [START, END, titles[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(2);
    expect(resourceErrors).toEqual([422, 413]);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
    console.log(`Task rejection evidence: ${JSON.stringify(observed)}; max_input_bytes=${max} text_bytes=${expected[1].byteLength} body_bytes=${captured[1].body.byteLength}; identity=${JSON.stringify(identityChanged)}; sessions=2 seed=1 sequences_each=1 create_posts=1 task_posts=2 task_commands=0 runs=0 acceptance=0 checkpoints=0 provider_requests=0 auth_loads=0 auth_prepares=0 tools=0 rename_posts=0 cancel_posts=0 resource_errors=422,413 disconnect_cleared=true`);
  } catch (cause) {
    // Retain only a known error name and this spec's numeric line, never the original message or stack.
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-input-rejection\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Task rejection failed: ${stage}; kind=${kind} line=${line}; reply=${JSON.stringify(replyEvidence)}; observed=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; task_posts=${requests.filter(request => request.method === 'POST' && request.path === taskPath).length}`);
  } finally {
    firstIdentity = undefined;
    try { await context?.close(); cleanup.browser = context !== undefined; }
    catch { failure ??= new Error('Task rejection browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Task rejection fixture cleanup failed'); }
  }
  console.log(`Task rejection cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
});
