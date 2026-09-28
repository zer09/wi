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

for (const [name, scenario] of scenarios) {
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
      const assets = new Set();
      const assetReads = [];
      const assetFiles = new Map([
        ['/', 'index.html'], ['/assets/wi.css', 'style.css'],
        ...['api', 'app', 'client', 'sse', 'state', 'view'].map(name => [`/assets/${name}.js`, `dist/${name}.js`]),
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
      });
      context.on('response', response => {
        const request = response.request();
        const path = new URL(response.url()).pathname;
        if (request.method() === 'POST') replies.push(path);
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
        const clean = await page.evaluate(secrets => {
          const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
            JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie,
            ...Array.from(document.querySelectorAll('input,textarea,select'), node => node.value)];
          return !secrets.some(secret => values.some(value => value?.includes(secret)))
            && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '';
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
      const evidence = page.locator('.commands > section > pre');
      await expect(evidence).toContainText('Accepted receipt (not completion)');
      await expect(evidence).toContainText('Run: none\nSequences: 1 to 1');
      stage = 'open canonical receipt session';
      await page.getByRole('button', { name: 'Open receipt session', exact: true }).click();
      await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), TITLE);
      const sid = new URL(page.url()).hash.slice('#session='.length);
      expect(sid).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(new URL(page.url()).hash).toBe(`#session=${sid}`);
      await exact(page.locator('.conversation > .metadata'), `Workspace: ${workspace}\nSession: ${sid}`);
      await expect(evidence).toContainText(`Session: ${sid}`);
      stage = 'fixture selects browser-created session';
      await fixture.request({ command: 'select', session_id: sid });
      const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
      await expect(transcript.locator('.run')).toHaveCount(0);
      await expect(transcript).toContainText('No messages');
      proof = await fixture.inspect();
      expect(proof.sequence_count).toBe('1');
      expect(proof.requests).toBe(0);

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
        await expect(page.locator('.command h3')).toHaveText('task: sending');
        await expect(transcript.locator('.user-text')).toHaveCount(task);
        proof = await fixture.inspect();
        expect(proof.accepted).toHaveLength(task);
        expect(proof.receipts).toHaveLength(task);
        expect(proof.requests).toBe(task * 2);
        expect(proof.connections).toBe(scenario.transport === 'websocket' ? task : task * 2);
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
        expect(receipt.session_id).toBe(sid);
        expect(proof.accepted[task]).toEqual({ run_id: receipt.run_id, accepted_sequence: receipt.first_sequence });
        await expect(evidence).toContainText(`Operation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}`);
        await expect(evidence).toContainText('Accepted receipt (not completion)');
        await expect(transcript.locator('.user-text')).toHaveCount(task + 1);
        const run = transcript.locator('.run').nth(task);
        await exact(run.locator('.user-text'), TASKS[task]);
        await expect(run).toContainText('Final result not recorded.');
        await expect(page.locator('.command')).toHaveCount(0);
        expect(proof.results).toBe(task);
        expect(proof.terminals).toBe(task);
        expect(proof.fresh_parents).toBe(task + 1);
        expect(proof.fresh_empty).toBe(true);
        expect(proof.restored_history).toBe(task === 1);
        expect(replies.filter(reply => reply === path)).toHaveLength(task + 1);

        stage = `task ${task + 1} real AddNumbers and correlated continuation`;
        await fixture.request({ command: 'drive', gate: task * 2 + 1 });
        await fixture.wait('model_paused', task * 2 + 2);
        await occurrences(run, OUTPUTS[task], 1);
        await occurrences(run, ARGUMENTS[task], 1);
        const tool = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Tool: add_numbers', exact: true }) });
        await expect(tool).toHaveCount(1);
        await expect(tool).toContainText('finished (success)');
        await expect(tool).toContainText('Result: success');
        await occurrences(run, ANSWERS[task], 0);
        proof = await fixture.inspect();
        expect(proof.tool_results).toBe(task + 1);
        expect(proof.continuations).toBe(task + 1);
        expect(proof.results).toBe(task);
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
        expect(response.provenance).toBe(provenance);
        expect(BigInt(response.sequence) < BigInt(terminal) && BigInt(terminal) < BigInt(result)).toBe(true);
        expect(proof.sequence_count).toBe(result);
        // SQLite completion is not browser observation. Require the applied SSE prefix first.
        stage = `task ${task + 1} browser SSE applied through final sequence`;
        await expect(page.locator('.metadata').filter({ hasText: /^Applied cursor:/ }))
          .toHaveText(new RegExp(`^Applied cursor: ${sid}:${result}\\nSnapshot head: (0|[1-9][0-9]*)$`));
        stage = `task ${task + 1} execution and result-recorded view`;
        await expect(run).toContainText('Execution: completed. Final result recorded.');
        stage = `task ${task + 1} exact authoritative answer and tool output`;
        await occurrences(run, ANSWERS[task], 1);
        await occurrences(run, OUTPUTS[task], 1);
        await exact(run.locator('.user-text'), TASKS[task]);
        stage = `task ${task + 1} authoritative provenance`;
        await expect(run).toContainText(`Output provenance: ${provenance}`);
        stage = `task ${task + 1} terminal outcome and result summary`;
        await expect(run).toContainText('Terminal outcome: completed');
        await expect(run).toContainText('Outcome: completed');
        await expect(run).toContainText('new_tool_dispatches: 1');
        await expect(run).toContainText('model_requests_admitted: 2');
        console.log(`Verified task ${task + 1}: response=${response.sequence} provenance=${provenance} terminal=${terminal} result=${result} applied=${result}`);
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
      const transcriptText = await transcript.textContent();
      const posts = requests.filter(request => request.method === 'POST');
      expect(posts.map(request => request.path)).toEqual(['/v1/sessions', `/v1/sessions/${sid}/runs`, `/v1/sessions/${sid}/runs`]);
      await page.getByRole('button', { name: 'Reload history', exact: true }).click();
      await expect.poll(() => transcript.textContent()).toBe(transcriptText);
      await page.goto(`${fixture.origin}/#session=invalid`);
      await page.goto(`${fixture.origin}/#session=${sid}`);
      await page.reload();
      await expect(page.getByLabel('Owner token', { exact: true })).toBeVisible();
      await expect(page.locator('.run')).toHaveCount(0);
      await connect();
      await expect.poll(() => transcript.textContent()).toBe(transcriptText);
      expect(new URL(page.url()).hash).toBe(`#session=${sid}`);
      expect(counters(await fixture.inspect())).toEqual(counters(finished));
      expect(requests.filter(request => request.method === 'POST')).toEqual(posts);
      await privateBoundary();

      stage = 'Disconnect clears DOM without cancellation or model work';
      await taskField.fill('discard this unsent synthetic draft');
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(page.locator('.run,.command')).toHaveCount(0);
      await expect(taskField).toHaveValue('');
      await exact(page.locator('.conversation > h2'), '');
      expect((await page.locator('body').textContent()).includes(TASKS[0])).toBe(false);
      expect((await page.locator('body').textContent()).includes(ANSWERS[0])).toBe(false);
      expect(requests.filter(request => request.method === 'POST')).toEqual(posts);
      expect(requests.some(request => request.path.endsWith('/cancel'))).toBe(false);
      expect(counters(await fixture.inspect())).toEqual(counters(finished));
      await privateBoundary();
      await Promise.all(assetReads);
      expect([external, consoleErrors, pageErrors, secretErrors, assetErrors]).toEqual([0, 0, 0, 0, 0]);
      expect(await page.locator('.error').allTextContents()).toEqual(['', '']);
    } catch (error) {
      // Extract only closed status and decimal cursors, never return raw DOM or exception text.
      const observation = await page?.evaluate(() => {
        const cursor = Array.from(document.querySelectorAll('.metadata')).map(node => node.textContent)
          .find(text => text.startsWith('Applied cursor:'));
        const applied = cursor?.match(/^Applied cursor: [0-9a-f-]{36}:([0-9]+)\n/)?.[1] ?? null;
        const status = document.querySelector('.topbar [role="status"]')?.textContent ?? '';
        const streaming = status.includes('observation: streaming');
        const has_error = Array.from(document.querySelectorAll('.error')).some(node => node.textContent !== '');
        return { applied, streaming, has_error };
      }).catch(() => null);
      const proof = await fixture?.inspect().catch(() => null);
      const control = proof == null ? null : { provider_stage: proof.provider_stage, provider_failed: proof.provider_failed,
        read_failure: proof.read_failure, sequence_count: proof.sequence_count, responses: proof.response_finishes,
        terminals: proof.terminal_sequences, results: proof.result_sequences };
      console.log(`Safe boundary evidence: ${JSON.stringify({ persisted, observation, control })}`);
      // Never forward Playwright call logs, input arguments, DOM excerpts or child output.
      const matchers = ['toBe', 'toEqual', 'toHaveCount', 'toHaveText', 'toContainText', 'toHaveValue', 'toBeVisible', 'toBeEnabled'];
      const matcher = matchers.includes(error?.matcherResult?.name) ? error.matcherResult.name : 'action or control';
      failure = new Error(`Joined browser assertion failed: ${stage}; ${matcher}`);
    } finally {
      try { await context?.close(); } catch { failure ??= new Error('Browser cleanup failed'); }
      try { await fixture?.stop(); } catch {
        console.log('Fixture Stop/shutdown check failed');
        failure ??= new Error(`Fixture cleanup failed: ${stage}`);
      }
    }
    if (failure) throw failure;
  });
}
