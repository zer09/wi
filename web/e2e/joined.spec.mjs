import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { CHILD_TEST, discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';

const TITLE = '  Browser 雪\n<em>title & inert</em>  ';
const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
const ANSWERS = ['42 雪\r\n<em>answer & inert</em>\n', '50 雪\r\nSecond answer.\n'];
const ARGUMENTS = ['{"a":17,\r\n "b":25}', '{"a":42,\r\n "b":8}'];
const OUTPUTS = ['{"sum":42}', '{"sum":50}'];
const PRIVATE = ['synthetic-replay-token-', 'synthetic-replay-account', 'private-operator-instructions',
  'private-project-browser', 'private-skill-browser', 'private-native', 'private-skills', 'private-data',
  'principal_digest', 'encrypted_content', 'opaque_response', 'provider_session_id', 'prepared_request'];
const scenarios = [
  ['WS native', { transport: 'websocket', recovered: false, mime: true }],
  ['WS recovered', { transport: 'websocket', recovered: true, mime: true }],
  ['provider-SSE labelled native', { transport: 'sse', recovered: false, mime: true }],
  ['provider-SSE labelled recovered', { transport: 'sse', recovered: true, mime: true }],
  ['provider-SSE missing-MIME native', { transport: 'sse', recovered: false, mime: false }],
  ['provider-SSE missing-MIME recovered', { transport: 'sse', recovered: true, mime: false }],
];
let executable;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  executable = await discoverFixture();
  console.log(`Cargo JSON lib-test artifact: ${executable}\nExact child: ${CHILD_TEST}\nNode ${process.versions.node}; Chromium ${browser.version()}`);
});

function counters(proof) {
  return [proof.requests, proof.connections, proof.auth_loads, proof.auth_prepares, proof.sequence_count];
}

// Compare only the newest supplied block. Older viewport loading is independent of rebase.
async function displayedBlock(run) {
  return run.evaluate(node => ({
    run_id: node.dataset.run,
    status: node.querySelector(':scope > .metadata').textContent,
    recording: node.querySelector(':scope > details > pre').textContent,
    entries: Array.from(node.querySelectorAll('.entry'), entry => ({
      entry_id: entry.dataset.entry,
      kind: entry.querySelector('h4').textContent,
      state: entry.querySelector(':scope > .metadata').textContent,
      fields: Array.from(entry.querySelectorAll('[data-field]'), field => ({
        field_id: field.dataset.field,
        kind: field.querySelector('h5,summary').textContent,
        metadata: field.querySelector('.metadata').textContent,
        text: Array.from(field.querySelectorAll('pre'), content => content.textContent),
      })),
    })),
  }));
}

for (const [name, scenario] of scenarios) {
  // SSE opens credentials once, then prepares/loads them again for each of the two requests.
  const authPerTask = scenario.transport === 'websocket' ? 1 : 3;
  test(name, async ({ browser }) => {
    let fixture;
    let context;
    let page;
    let failure;
    let persisted = null;
    let stage = 'startup';
    try {
      fixture = await startFixture(executable, scenario);
      const secrets = [fixture.owner, ...PRIVATE];
      const leaked = text => secrets.some(secret => text.includes(secret));
      // No page/context fixture survives failure to produce a DOM snapshot or credential-bearing diagnostic.
      context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
      let external = 0;
      let consoleErrors = 0;
      let pageErrors = 0;
      let secretErrors = 0;
      let assetErrors = 0;
      const requests = [];
      const replies = [];
      const capturedTasks = [];
      const displayReads = [];
      let capturedCreate = null;
      let expectedHead = '1';
      let requestErrors = 0;
      const assets = new Set();
      const assetReads = [];
      const assetFiles = new Map([
        ['/', 'index.html'], ['/assets/wi.css', 'style.css'],
        ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(name => [`/assets/${name}.js`, `dist/${name}.js`]),
      ]);
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== fixture.origin) {
          external++; await route.abort();
        } else await route.continue();
      });
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== fixture.origin) external++;
        if (requests.length >= 512) { external++; return; }
        // No body, query or Authorization header enters these logs.
        requests.push({ method: request.method(), path: url.pathname });
        if (leaked(request.url())) secretErrors++;
        if (request.method() === 'POST') {
          try {
            const body = request.postDataJSON();
            const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
              && value !== '00000000-0000-0000-0000-000000000000';
            if (url.pathname === '/v1/sessions') {
              if (capturedCreate !== null || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
                || !uuid(body.operation_id) || body.title !== TITLE || typeof body.workspace !== 'string') requestErrors++;
              else capturedCreate = { operation_id: body.operation_id, workspace: body.workspace };
            } else if (url.pathname.endsWith('/runs')) {
              const task = capturedTasks.length;
              if (task >= TASKS.length || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
                || !uuid(body.operation_id) || !uuid(body.run_id) || body.text !== TASKS[task]) requestErrors++;
              else capturedTasks.push({ operation_id: body.operation_id, run_id: body.run_id });
            } else requestErrors++;
          } catch { requestErrors++; }
        }
        if (request.method() === 'GET' && url.pathname.endsWith('/conversation/events')) {
          const sid = url.pathname.split('/')[3];
          const after = `g11l.${Buffer.from(JSON.stringify([1, sid, expectedHead, '3', '', ''])).toString('base64url')}`;
          displayReads.push({ kind: 'events', path: url.pathname, matching_head: url.searchParams.get('after') === after });
        }
      });
      context.on('response', response => {
        const request = response.request();
        const path = new URL(response.url()).pathname;
        if (request.method() === 'POST') replies.push(path);
        if (request.method() === 'GET' && path.endsWith('/conversation') && new URL(response.url()).search === '')
          displayReads.push({ kind: 'latest', path, status: response.status() });
        const file = assetFiles.get(path);
        if (file === undefined) return;
        assetReads.push((async () => {
          // Only public asset responses are read. API responses are consumed by the real UI.
          const body = await response.body();
          const expected = await readFile(new URL(`../${file}`, import.meta.url));
          if (response.status() !== 200 || !body.equals(expected) || leaked(body.toString('utf8'))) assetErrors++;
          assets.add(path);
        })().catch(() => { assetErrors++; }));
      });
      page = await context.newPage();
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors++;
        if (leaked(message.text())) secretErrors++;
      });
      page.on('pageerror', () => { pageErrors++; });
      async function privateBoundary() {
        const clean = await page.evaluate(async secrets => {
          const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
            JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie,
            ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
          return !secrets.some(secret => values.some(value => value?.includes(secret)))
            && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
            && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
            && (await navigator.serviceWorker.getRegistrations()).length === 0;
        }, secrets);
        expect(clean).toBe(true);
        expect(await context.cookies()).toEqual([]);
      }
      async function connect() {
        await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
        await expect(page.locator('.topbar [role="status"]')).toContainText('connected');
        await expect(page.getByRole('button', { name: 'Create session', exact: true })).toBeEnabled();
        await privateBoundary();
      }
      stage = 'public embedded assets and connection';
      await page.goto(`${fixture.origin}/`);
      await connect();
      await expect.poll(() => assets.size).toBe(assetFiles.size);
      await exact(page.locator('.topbar .metadata'), `Provider: openai-codex\nModel: requested-alias\nTransport: ${scenario.transport}`);
      let proof = await fixture.inspect();
      expect(counters(proof)).toEqual([0, 0, 0, 0, '0']);
      expect(requests.some(request => request.path === '/v1/settings' && request.method === 'GET')).toBe(true);
      expect(requests.some(request => request.path === '/v1/sessions' && request.method === 'GET')).toBe(true);
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);

      stage = 'real creation receipt and canonical header';
      await page.getByLabel('Title', { exact: true }).fill(TITLE);
      const workspace = await page.getByLabel(/^Workspace/).inputValue();
      expect(workspace.length > 0).toBe(true);
      stage = 'create session submission';
      await page.getByRole('button', { name: 'Create session', exact: true }).click();
      expect(capturedCreate !== null && capturedCreate.workspace === workspace).toBe(true);
      const createCommand = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^create:/ }) })
        .filter({ has: page.locator('.metadata', { hasText: `Operation: ${capturedCreate.operation_id}\n` }) });
      const createEvidence = createCommand.locator(':scope > pre');
      await exact(createCommand.locator('h3'), 'create: accepted');
      await expect(createEvidence).toContainText('Accepted receipt (not completion)');
      await expect(createEvidence).toContainText('Run: none\nSequences: 1 to 1');
      await createCommand.locator('summary').click();
      await exact(createCommand.locator('details pre'), TITLE);
      stage = 'open canonical receipt session';
      await createCommand.getByRole('button', { name: 'Open receipt session', exact: true }).click();
      await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), TITLE);
      const sid = new URL(page.url()).hash.slice('#session='.length);
      expect(sid).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(new URL(page.url()).hash).toBe(`#session=${sid}`);
      await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspace}\nSession: ${sid}`);
      await expect(createEvidence).toContainText(`Operation: ${capturedCreate.operation_id}\nSession: ${sid}`);
      const createReceiptText = await createEvidence.textContent();
      stage = 'fixture selects browser-created session';
      await fixture.request({ command: 'select', session_id: sid });
      stage = 'initial empty conversation view';
      const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
      await expect(transcript.locator('.run')).toHaveCount(0);
      await expect(transcript).toContainText('No messages');
      stage = 'initial fixture inspection';
      proof = await fixture.inspect();
      expect(proof.sequence_count).toBe('1');
      expect(proof.requests).toBe(0);
      stage = 'initial observation and display read order';
      const observation = page.locator('.conversation [role="status"]');
      await exact(observation, 'Observation: streaming');
      expect(displayReads).toEqual([
        { kind: 'latest', path: `/v1/sessions/${sid}/conversation`, status: 200 },
        { kind: 'events', path: `/v1/sessions/${sid}/conversation/events`, matching_head: true },
      ]);
      const receiptTexts = [];

      stage = 'Enter is a newline, not a task';
      const taskField = page.getByLabel('Task', { exact: true });
      await taskField.fill('keyboard 雪');
      await taskField.press('End');
      await taskField.press('Enter');
      await expect(taskField).toHaveValue('keyboard 雪\n');
      expect(requests.filter(request => request.path.endsWith('/runs') && request.method === 'POST')).toHaveLength(0);

      for (let task = 0; task < 2; task++) {
        const path = `/v1/sessions/${sid}/runs`;
        stage = `task ${task + 1} before-commit acceptance`;
        await fixture.request({ command: 'arm_acceptance' });
        await taskField.fill(TASKS[task]);
        if (task === 0) await page.getByRole('button', { name: 'Send', exact: true }).click();
        else await taskField.press('Control+Enter');
        await fixture.request({ command: 'wait_acceptance' });
        expect(capturedTasks.length).toBe(task + 1);
        const captured = capturedTasks[task];
        const command = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) })
          .filter({ has: page.locator('.metadata', { hasText: `Operation: ${captured.operation_id}\n` }) });
        const evidence = command.locator(':scope > pre');
        await exact(command.locator('h3'), 'task: sending');
        await exact(evidence, '');
        await command.locator('summary').click();
        await exact(command.locator('details pre'), TASKS[task]);
        await expect(page.locator('.command')).toHaveCount(task + 2);
        await expect(transcript.locator(`.run[data-run="${captured.run_id}"]`)).toHaveCount(0);
        await expect(transcript.locator('.entry > h4').filter({ hasText: /^Human$/ })).toHaveCount(task);
        proof = await fixture.inspect();
        expect(proof.accepted).toHaveLength(task);
        expect(proof.receipts).toHaveLength(task);
        expect(proof.requests).toBe(task * 2);
        expect(proof.connections).toBe(scenario.transport === 'websocket' ? task : task * 2);
        expect([proof.auth_loads, proof.auth_prepares, proof.prepared_exact, proof.tool_results,
          proof.terminals, proof.results, proof.completed]).toEqual([task * authPerTask, task * authPerTask, task * 2, task, task, task, task]);
        expect(replies.filter(reply => reply === path)).toHaveLength(task);
        expect(requests.filter(request => request.method === 'POST' && request.path === path)).toHaveLength(task + 1);
        if (task === 0) {
          expect(proof.sequence_count).toBe('1');
          expect(proof.auth_loads).toBe(0);
        }
        await privateBoundary();
        await fixture.request({ command: 'release_acceptance' });
        await fixture.wait('model_paused', task * 2 + 1);
        stage = `task ${task + 1} durable receipt before model reply`;
        proof = await fixture.inspect();
        const receipt = proof.receipts[task];
        expect(receipt.session_id === sid && receipt.operation_id === captured.operation_id && receipt.run_id === captured.run_id).toBe(true);
        expect(BigInt(receipt.last_sequence) === BigInt(receipt.first_sequence) + 1n).toBe(true);
        expect(proof.accepted[task]).toEqual({ run_id: receipt.run_id, accepted_sequence: receipt.first_sequence });
        await expect(evidence).toContainText(`Operation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}`);
        await expect(evidence).toContainText('Accepted receipt (not completion)');
        await exact(command.locator('h3'), 'task: accepted');
        receiptTexts.push(await evidence.textContent());
        await expect(transcript.locator('.entry > h4').filter({ hasText: /^Human$/ })).toHaveCount(task + 1);
        const run = transcript.locator(`.run[data-run="${receipt.run_id}"]`);
        await expect(run).toHaveCount(1);
        const human = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Human', exact: true }) });
        await exact(human.locator('[data-field] pre'), TASKS[task]);
        await expect(human).toHaveAttribute('data-entry', `e:${receipt.first_sequence}:0`);
        await expect(run).toContainText('Execution: running. Final result not recorded.');
        await expect(page.locator('.command')).toHaveCount(task + 2);
        await exact(command.locator('details pre'), TASKS[task]);
        expect(proof.results).toBe(task);
        expect(proof.terminals).toBe(task);
        expect(proof.fresh_parents).toBe(task + 1);
        expect(proof.fresh_empty).toBe(true);
        expect(proof.restored_history).toBe(task === 1);
        const authAtFirstReply = scenario.transport === 'websocket' ? task + 1 : task * 3 + 2;
        expect([proof.requests, proof.connections, proof.auth_loads, proof.auth_prepares, proof.prepared_exact,
          proof.tool_results, proof.completed, proof.continuations]).toEqual([task * 2 + 1,
          scenario.transport === 'websocket' ? task + 1 : task * 2 + 1, authAtFirstReply, authAtFirstReply, task * 2 + 1, task, task, task]);
        expect(proof.provider_failed || proof.read_failure !== null).toBe(false);
        expect(replies.filter(reply => reply === path)).toHaveLength(task + 1);

        stage = `task ${task + 1} real AddNumbers and correlated continuation`;
        await fixture.request({ command: 'drive', gate: task * 2 + 1 });
        await fixture.wait('model_paused', task * 2 + 2);
        await occurrences(run, OUTPUTS[task], 1);
        await occurrences(run, ARGUMENTS[task], 1);
        const tool = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'tool', exact: true }) });
        await expect(tool).toHaveCount(1);
        await occurrences(tool, 'add_numbers', 1);
        await exact(tool.locator(':scope > .metadata').first(), 'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false');
        await tool.getByText('tool_result', { exact: true }).click();
        await expect(tool.locator('details pre')).toBeVisible();
        await occurrences(run, ANSWERS[task], 0);
        proof = await fixture.inspect();
        expect(proof.tool_results).toBe(task + 1);
        expect(proof.continuations).toBe(task + 1);
        expect(proof.results).toBe(task);
        expect([proof.requests, proof.connections, proof.auth_loads, proof.auth_prepares, proof.prepared_exact,
          proof.terminals, proof.completed]).toEqual([(task + 1) * 2,
          scenario.transport === 'websocket' ? task + 1 : (task + 1) * 2,
          (task + 1) * authPerTask, (task + 1) * authPerTask, (task + 1) * 2, task, task]);
        expect(proof.provider_failed || proof.read_failure !== null).toBe(false);
        await expect(run).toContainText('Final result not recorded.');

        stage = `task ${task + 1} release final provider reply`;
        await fixture.request({ command: 'drive', gate: task * 2 + 2 });
        stage = `task ${task + 1} SQLite final data`;
        await fixture.wait('task_finished', task + 1);
        proof = await fixture.inspect();
        expect(proof.response_finishes).toHaveLength((task + 1) * 2);
        expect(proof.terminals).toBe(task + 1);
        expect(proof.results).toBe(task + 1);
        const response = proof.response_finishes.at(-1);
        const terminal = proof.terminal_sequences[task];
        const result = proof.result_sequences[task];
        const provenance = scenario.recovered ? 'validated_output_item_done' : 'native_terminal';
        persisted = { response: response.sequence, provenance: response.provenance, terminal, result };
        expect(proof.response_finishes.slice(task * 2).map(response => response.provenance)).toEqual([provenance, provenance]);
        expect(response.provenance).toBe(provenance);
        expect(BigInt(response.sequence) < BigInt(terminal) && BigInt(terminal) < BigInt(result)).toBe(true);
        expect(proof.sequence_count).toBe(result);
        // SQLite completion alone is not DOM observation; require supplied final block and entry facts.
        stage = `task ${task + 1} final supplied display state`;
        await exact(observation, 'Observation: streaming');
        const assistant = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'assistant', exact: true }) }).last();
        await exact(assistant.locator(':scope > .metadata').first(), 'Recorded state: completed; Provisional: false');
        stage = `task ${task + 1} execution and result-recorded view`;
        await expect(run).toContainText('Execution: completed. Final result recorded.');
        stage = `task ${task + 1} exact authoritative answer and tool output`;
        await occurrences(run, ANSWERS[task], 1);
        await occurrences(run, OUTPUTS[task], 1);
        await occurrences(run, ANSWERS[task].split('\r')[0], 0);
        await exact(human.locator('[data-field] pre'), TASKS[task]);
        await expect(run.locator('.entry > h4')).toHaveText(['Human', 'assistant', 'tool', 'assistant']);
        expect(await run.locator('.entry').evaluateAll(nodes => {
          const positions = nodes.map(node => BigInt(node.dataset.entry.split(':')[1]));
          return positions.every((position, index) => index === 0 || position > positions[index - 1]);
        })).toBe(true);
        stage = `task ${task + 1} actual recorded outcome and result summary`;
        await expect(run).toContainText('Outcome: completed');
        await expect(run).toContainText('Events complete: true');
        await expect(run).toContainText('Sink error: none');
        await expect(run).toContainText('new_tool_dispatches: 1');
        await expect(run).toContainText('model_requests_admitted: 2');
        await exact(evidence, receiptTexts[task]);
        await exact(createEvidence, createReceiptText);
        console.log(`Verified task ${task + 1}: response=${response.sequence} provenance=${provenance} terminal=${terminal} result=${result} final_display=true`);
        expect(await run.locator('em,script,img,a').count()).toBe(0);
        await privateBoundary();
      }

      stage = 'stored-history proof and read-only reload/navigation';
      const finished = await fixture.inspect();
      expect(finished.requests).toBe(4);
      expect(finished.connections).toBe(scenario.transport === 'websocket' ? 2 : 4);
      expect(finished.prepared_exact).toBe(4);
      expect(finished.completed).toBe(2);
      expect(finished.tool_results).toBe(2);
      expect(finished.terminals).toBe(2);
      expect(finished.results).toBe(2);
      expect([finished.provider_stage, finished.provider_failed, finished.read_failure]).toEqual(['finished', false, null]);
      expect([finished.auth_loads, finished.auth_prepares, finished.fresh_parents, finished.continuations]).toEqual([2 * authPerTask, 2 * authPerTask, 2, 2]);
      expect(finished.fresh_empty && finished.restored_history).toBe(true);
      const newest = transcript.locator(`.run[data-run="${capturedTasks[1].run_id}"]`);
      const newestDisplay = await displayedBlock(newest);
      const posts = requests.filter(request => request.method === 'POST');
      expect(posts.map(request => request.path)).toEqual(['/v1/sessions', `/v1/sessions/${sid}/runs`, `/v1/sessions/${sid}/runs`]);
      expectedHead = finished.sequence_count;
      const displayBaseline = displayReads.length;
      await page.getByRole('button', { name: 'Reconnect latest', exact: true }).click();
      await exact(observation, 'Observation: streaming');
      await expect.poll(async () => JSON.stringify(await displayedBlock(newest)) === JSON.stringify(newestDisplay)).toBe(true);
      expect(displayReads.slice(displayBaseline)).toEqual([
        { kind: 'latest', path: `/v1/sessions/${sid}/conversation`, status: 200 },
        { kind: 'events', path: `/v1/sessions/${sid}/conversation/events`, matching_head: true },
      ]);
      await exact(createEvidence, createReceiptText);
      for (const [task, captured] of capturedTasks.entries()) {
        const retained = page.locator('.command').filter({ has: page.getByRole('heading', { name: /^task:/ }) })
          .filter({ has: page.locator('.metadata', { hasText: `Operation: ${captured.operation_id}\n` }) });
        await exact(retained.locator(':scope > pre'), receiptTexts[task]);
      }
      const freshBaseline = displayReads.length;
      await page.goto(`${fixture.origin}/#session=invalid`);
      await page.goto(`${fixture.origin}/#session=${sid}`);
      await page.reload();
      await expect(page.getByLabel('Owner token', { exact: true })).toBeVisible();
      await expect(page.locator('.run,.command')).toHaveCount(0);
      await connect();
      await exact(observation, 'Observation: streaming');
      await expect.poll(async () => JSON.stringify(await displayedBlock(newest)) === JSON.stringify(newestDisplay)).toBe(true);
      expect(displayReads.slice(freshBaseline)).toEqual([
        { kind: 'latest', path: `/v1/sessions/${sid}/conversation`, status: 200 },
        { kind: 'events', path: `/v1/sessions/${sid}/conversation/events`, matching_head: true },
      ]);
      await expect(page.locator('.command')).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe(`#session=${sid}`);
      const reread = await fixture.inspect();
      expect(counters(reread)).toEqual(counters(finished));
      expect(JSON.stringify({ ...reread, id: null }) === JSON.stringify({ ...finished, id: null })).toBe(true);
      expect(requests.filter(request => request.method === 'POST')).toEqual(posts);
      expect(requests.some(request => request.path.endsWith('/history') || request.path === `/v1/sessions/${sid}/events`
        || request.path.includes('/operations/') || ['/assets/client.js', '/assets/state.js', '/assets/view.js'].includes(request.path))).toBe(false);
      await privateBoundary();

      stage = 'Disconnect clears DOM without cancellation or model work';
      await taskField.fill('discard this unsent synthetic draft');
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(page.locator('.run,.command')).toHaveCount(0);
      await expect(taskField).toHaveValue('');
      await exact(page.locator('.conversation > h2'), '');
      const body = await page.locator('body').textContent();
      expect([...TASKS, ...ANSWERS].some(text => body.includes(text))).toBe(false);
      expect(requests.filter(request => request.method === 'POST')).toEqual(posts);
      expect(requests.some(request => request.path.endsWith('/cancel'))).toBe(false);
      expect(counters(await fixture.inspect())).toEqual(counters(finished));
      await privateBoundary();
      await Promise.all(assetReads);
      expect([...assets].sort()).toEqual([...assetFiles.keys()].sort());
      expect([external, consoleErrors, pageErrors, secretErrors, assetErrors, requestErrors]).toEqual([0, 0, 0, 0, 0, 0]);
      expect(await page.locator('.error').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
    } catch (error) {
      // Extract only Boolean status and validated native control facts, never raw DOM or exception text.
      const observation = await page?.evaluate(() => {
        const streaming = document.querySelector('.conversation [role="status"]')?.textContent === 'Observation: streaming';
        const has_error = Array.from(document.querySelectorAll('.error')).some(node => node.textContent !== '');
        return { streaming, has_error };
      }).catch(() => null);
      const proof = await fixture?.inspect().catch(() => null);
      const control = proof == null ? null : { provider_stage: proof.provider_stage, provider_failed: proof.provider_failed,
        read_failure: proof.read_failure, sequence_count: proof.sequence_count, responses: proof.response_finishes,
        terminals: proof.terminal_sequences, results: proof.result_sequences };
      console.log(`Safe boundary evidence: ${JSON.stringify({ persisted, observation, control, fixture: fixture?.evidence() ?? null })}`);
      // Never forward Playwright call logs, input arguments, DOM excerpts or child output.
      const matchers = ['toBe', 'toEqual', 'toHaveCount', 'toHaveText', 'toContainText', 'toHaveValue', 'toBeVisible', 'toBeEnabled'];
      const matcher = matchers.includes(error?.matcherResult?.name) ? error.matcherResult.name : 'action or control';
      const line = error?.stack?.match(/joined\.spec\.mjs:(\d+):\d+/)?.[1] ?? 'unknown';
      failure = new Error(`Joined browser assertion failed: ${stage}; ${matcher}; line=${line}`);
    } finally {
      try { await context?.close(); } catch {
        console.log('Browser cleanup check failed');
        failure ??= new Error('Browser cleanup failed');
      }
      try { await fixture?.stop(); } catch {
        console.log('Fixture Stop/shutdown check failed');
        failure ??= new Error(`Fixture cleanup failed: ${stage}`);
      } finally {
        console.log(`Safe fixture closure evidence: ${JSON.stringify(fixture?.evidence() ?? null)}`);
      }
    }
    if (failure) throw failure;
  });
}
