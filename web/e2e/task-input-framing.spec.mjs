import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { validateErrorView } from '../dist/api.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';

const parts = JSON.parse(await readFile(new URL('../test-support/task-input-framing.json', import.meta.url), 'utf8'));
const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json', import.meta.url), 'utf8'));
const EDIT = '  edited but not sent 雪\n<em>unsent</em>  ';
const ERROR = { api_version: 1, code: 'context.input_too_large', stage: null,
  certainty: 'not_applicable', acceptance: null, notices: [] };
const taskText = bytes => parts.start + 'x'.repeat(bytes - Buffer.byteLength(parts.start + parts.end, 'utf8')) + parts.end;
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('one in-bound task rejects only after real context framing exceeds the provider-input limit', async ({ browser }) => {
  let fixture;
  let context;
  let failure;
  let taskPath;
  let stage = 'startup';
  let sizes;
  let captured;
  let identityChanged = null;
  let resourceErrors = 0;
  const posts = { create: 0, task: 0, other: 0 };
  const reply = { status: null, decoded: false, validated: false, exact: false };
  const faults = { external: 0, console: 0, page: 0, secret: 0, request: 0, asset: 0, response: 0 };
  const cleanup = { browser: false, fixture: false };
  try {
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, mutations: true });
    sizes = await fixture.request({ command: 'seed_input_framing' });
    expect(sizes.event === 'input_framing_seeded').toBe(true);
    const secrets = [fixture.owner, 'synthetic-replay-token-', 'synthetic-replay-account',
      createHash('sha256').update('wi.openai-codex.account.v1\0synthetic-replay-account').digest('hex'),
      'private-operator-instructions', 'private-project-browser', 'private-skill-browser', 'private-support-',
      'private-native', 'private-skills', 'private-data', 'private-config-canary',
      'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
    const leaked = text => secrets.some(secret => text.includes(secret));
    // No recordHar or recordVideo; the manually owned context has no trace or failure snapshot.
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
      else await route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.secret++;
      if (url.pathname.startsWith('/v1/') && request.headers().authorization !== `Bearer ${fixture.owner}`) faults.request++;
      if (request.method() !== 'POST') return;
      if (url.pathname === '/v1/sessions') { posts.create++; return; }
      if (url.pathname !== taskPath) { posts.other++; return; }
      posts.task++;
      try {
        // Raw bytes, text and IDs exist only during comparison, never in retained evidence.
        const raw = request.postDataBuffer();
        const body = JSON.parse(raw.toString('utf8'));
        const idsValid = [body.operation_id, body.run_id].every(id => typeof id === 'string'
          && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
          && id !== '00000000-0000-0000-0000-000000000000');
        if (Object.keys(body).sort().join(',') !== 'operation_id,run_id,text' || !idsValid
          || typeof body.text !== 'string' || captured !== undefined) { faults.request++; return; }
        if (leaked(raw.toString('utf8'))) faults.secret++;
        captured = { body_bytes: raw.length, text_bytes: Buffer.byteLength(body.text, 'utf8'),
          unframed_bytes: Buffer.byteLength(JSON.stringify([{ kind: 'user', text: body.text }]), 'utf8'),
          start: body.text.slice(0, 64), end: body.text.slice(-64), exact: body.text === taskText(sizes.task_bytes) };
      } catch { faults.request++; }
    });
    const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
      ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`])]);
    const assets = new Set();
    const reads = [];
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300 && !(path === taskPath && response.status() === 413)) faults.response++;
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
      if (message.type() === 'error' && message.location().url === `${fixture.origin}${taskPath}`
        && text === 'Failed to load resource: the server responded with a status of 413 (Payload Too Large)') {
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
      // The closed audit rejects every extra command, run or event across both sessions, not just the selected one.
      const audit = await fixture.inspectMutations();
      expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
      expect(audit.max_input_bytes).toBe(sizes.max_input_bytes);
      const entry = audit.creations[0];
      expect(entry.exact && entry.catalog_current && entry.sequence_count === '1' && entry.catalog_head_sequence === '1'
        && entry.rename_events === 0 && entry.renames.length === 0 && entry.rename_event_ids.length === 0
        && entry.receipt.first_sequence === '1' && entry.receipt.last_sequence === '1' && entry.receipt.run_id === null
        && taskPath === `/v1/sessions/${entry.receipt.session_id}/runs`).toBe(true);
      expect(posts).toEqual({ create: 1, task: tasks, other: 0 });
    }
    async function preserved(locator, edited = false) {
      const evidence = await locator.evaluate((node, { parts, bytes, edit }) => {
        const text = node instanceof HTMLTextAreaElement ? node.value : node.textContent;
        const encoder = new TextEncoder();
        const expected = edit ?? parts.start + 'x'.repeat(bytes - encoder.encode(parts.start + parts.end).length) + parts.end;
        return { exact: text === expected, bytes: encoder.encode(text).length, start: text.slice(0, 64), end: text.slice(-64) };
      }, { parts, bytes: sizes.task_bytes, edit: edited ? EDIT : null });
      // Only booleans, lengths and bounded boundaries cross out of the page, even on failure.
      expect(evidence.exact).toBe(true);
      expect(evidence.bytes).toBe(edited ? Buffer.byteLength(EDIT, 'utf8') : sizes.task_bytes);
    }
    const task = page.getByLabel('Task', { exact: true });
    const command = page.locator('.command');
    const outcome = page.locator('.commands > section > pre');
    const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });

    stage = 'real browser creation and selection';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'connected');
    expect(await page.getByLabel('Owner token', { exact: true }).inputValue() === '').toBe(true);
    await page.getByLabel('Title', { exact: true }).fill(titles[0]);
    const creationRead = page.waitForResponse(response => response.request().method() === 'GET'
      && /^\/v1\/sessions\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname)).then(response => response.finished());
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect.poll(async () => (await outcome.textContent()).includes('Accepted receipt (not completion)')).toBe(true);
    await creationRead;
    {
      const audit = await fixture.inspectMutations();
      expect([audit.session_count, audit.seed_sessions, audit.creations.length]).toEqual([2, 1, 1]);
      const sid = audit.creations[0].receipt.session_id;
      taskPath = `/v1/sessions/${sid}/runs`;
      await fixture.request({ command: 'select', session_id: sid });
    }
    await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
    await exact(transcript, 'No messages yet.');
    await exact(page.locator('.topbar [role="status"]'), 'connected; observation: streaming');
    await noWork(0);
    await privateBoundary();

    stage = 'one explicit Send and exact framing rejection';
    await task.fill(taskText(sizes.task_bytes));
    await preserved(task);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === taskPath && response.request().method() === 'POST')
        .then(async response => {
          reply.status = response.status();
          const value = await response.json();
          reply.decoded = true;
          validateErrorView(value);
          reply.validated = true;
          reply.exact = isDeepStrictEqual(value, ERROR);
        }),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    expect(reply).toEqual({ status: 413, decoded: true, validated: true, exact: true });
    expect(captured?.exact === true && captured.text_bytes === sizes.task_bytes
      && captured.unframed_bytes === sizes.unframed_bytes && captured.unframed_bytes <= sizes.max_input_bytes
      && captured.body_bytes <= sizes.max_input_bytes).toBe(true);
    await expect(command).toHaveCount(1);
    await exact(command.locator('h3'), 'task: rejected');
    await exact(command.locator(':scope > pre'), 'HTTP 413\nCode: context.input_too_large\nStage: none\nCertainty: not_applicable');
    await command.locator('summary').click();
    await preserved(command.locator('details pre'));
    await preserved(task);
    await exact(transcript, 'No messages yet.');
    await expect(page.locator('.run')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel current run', exact: true })).toBeDisabled();
    await noWork(1);
    await privateBoundary();

    stage = 'draft edit cannot mutate the rejected command or retry';
    // Watch identity changes without saving UUIDs or fingerprints in the test evidence.
    const identityWatch = await command.locator('.metadata').evaluateHandle(node => {
      let changed = false;
      const observer = new MutationObserver(() => { changed = true; });
      observer.observe(node, { childList: true, characterData: true, subtree: true });
      return { stop() {
        changed ||= observer.takeRecords().length > 0 || !node.isConnected;
        observer.disconnect();
        return changed;
      } };
    });
    await task.fill(EDIT);
    await preserved(task, true);
    await preserved(command.locator('details pre'));
    // A finite observation window detects unwanted retry work; it adds no product timeout.
    await page.waitForTimeout(300);
    await exact(command.locator('h3'), 'task: rejected');
    await preserved(command.locator('details pre'));
    identityChanged = await identityWatch.evaluate(watch => watch.stop());
    await identityWatch.dispose();
    expect(identityChanged).toBe(false);
    await noWork(1);
    await privateBoundary();

    stage = 'embedded assets and Disconnect clearing';
    await expect.poll(() => assets.size).toBe(files.size);
    await Promise.all(reads);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await exact(page.locator('.topbar [role="status"]'), 'disconnected');
    await expect(page.locator('.command,.run,.session-list li')).toHaveCount(0);
    await exact(outcome, '');
    await exact(page.locator('.transcript'), '');
    expect(await page.evaluate(canaries => {
      const nodes = Array.from(document.querySelectorAll('input,textarea,select'));
      const values = [document.documentElement.outerHTML, ...nodes.map(node => node.value)];
      return nodes.every(node => node.value === '') && !canaries.some(canary => values.some(value => value.includes(canary)));
    }, [parts.start, parts.end, EDIT, titles[0]])).toBe(true);
    await page.waitForTimeout(300);
    await privateBoundary();
    await noWork(1);
    expect(resourceErrors).toBe(1);
    expect(Object.values(faults)).toEqual(Array(7).fill(0));
  } catch (cause) {
    const kind = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-input-framing\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Task framing failed: ${stage}; kind=${kind} line=${line}; reply=${JSON.stringify(reply)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try { await context?.close(); cleanup.browser = context !== undefined; }
    catch { failure ??= new Error('Task framing browser cleanup failed'); }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; }
    catch { failure ??= new Error('Task framing fixture cleanup failed'); }
  }
  console.log(`Task framing cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  expect(resourceErrors).toBe(1);
  console.log(`Task framing evidence: HTTP=413 code=context.input_too_large flat_error_exact=${reply.exact}; max_input_bytes=${sizes.max_input_bytes} body_bytes=${captured.body_bytes} text_bytes=${captured.text_bytes} unframed_bytes=${sizes.unframed_bytes} project_bytes=${sizes.project_bytes} skill_bytes=${sizes.skill_bytes} framed_bytes=${sizes.framed_bytes}; wire_exact=${captured.exact} identity_changed=${identityChanged}; sessions=2 seed=1 sequences_each=1 create_posts=${posts.create} task_posts=${posts.task} task_commands=0 task_receipts=0 runs=0 checkpoints=0 provider_requests=0 provider_connections=0 auth_loads=0 auth_prepares=0 tools=0 rename_posts=0 cancel_posts=0 automatic_retry=0 disconnect_cleared=true`);
});
