import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { validateEventView } from '../dist/api.js';
import { applyEvent, createConversation, selectDisplay } from '../dist/state.js';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { answer, data, labels, localRender, measurement, observe, skillOutput } from '../test-support/presentation.mjs';

async function exact(locator, value) {
  await expect(locator).toHaveCount(1);
  await expect.poll(() => locator.textContent()).toBe(value);
}
async function textOnce(run, value) {
  await expect.poll(() => run.locator('pre').evaluateAll((nodes, value) => nodes.filter(node => node.textContent === value).length, value)).toBe(1);
}
const argumentsFor = task => task === 0 ? '{"a":17,\r\n "b":25}' : '{"a":42,\r\n "b":8}';
async function richSections(response, task, phase) {
  for (const key of ['text', 'refusal', 'summary', 'reasoning']) await textOnce(response, data[key]);
  await textOnce(response, phase === 'deltas' ? data.arguments : argumentsFor(task));
  await textOnce(response, '{"id":"project:presentation"}');
  await textOnce(response, '{"a":9223372036854775807,"b":1}');
  await textOnce(response, 'Unsupported content');
  const provisional = phase !== 'authoritative';
  await expect(response.locator('h5, summary')).toHaveText([
    ...['Reasoning summary', 'Reasoning text', 'Text', 'Refusal', 'Function arguments', 'Function arguments', 'Function arguments', 'Unsupported content']
      .map(label => `${label}${provisional ? ' (provisional)' : ''}`), 'Response metadata',
  ]);
  await expect(response.locator('details').filter({ hasText: 'Call: add-雪' }))
    .toContainText(`Arguments complete: ${phase !== 'deltas'}`);
  await expect(response).not.toContainText('Authoritative text fallback');
  if (phase !== 'deltas') expect((await response.textContent()).includes(data.arguments)).toBe(false);
  if (provisional) {
    await expect(response).not.toContainText('Output provenance:');
    await expect(response).toContainText('Status: started');
  } else {
    await expect(response).toContainText('Output provenance: native_terminal');
    await expect(response).toContainText('Status: completed');
  }
}
async function answerSection(response, task, authoritative) {
  await textOnce(response, answer(task));
  await expect(response.locator('h5, summary')).toHaveText([authoritative ? 'Text' : 'Text (provisional)', 'Response metadata']);
  await expect(response).not.toContainText('Authoritative text fallback');
  if (authoritative) await expect(response).toContainText('Output provenance: native_terminal');
  else await expect(response).not.toContainText('Output provenance:');
}
let focusedControl = 'none';
async function keyboardFocus(page, locator) {
  const name = await locator.evaluate(node => node.labels?.[0]?.firstChild?.textContent ?? node.textContent).catch(() => 'missing');
  const safeNames = ['Owner token', 'Connect', 'Disconnect', 'Title', 'Workspace', 'Create session', 'Open receipt session',
    'Exact new title', 'Rename session', 'Refresh selected catalog entry', 'Refresh list', 'Task', 'Send', 'Cancel current run',
    'New content', 'Reload history', 'Reconnect observation', 'Fixture barrier seed', 'Reasoning summary', 'Reasoning summary (provisional)'];
  focusedControl = safeNames.includes(name) ? name : 'session choice or missing control';
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(locator).toBeFocused();
  expect(await locator.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none')).toBe(true);
}
async function activate(page, locator) {
  await keyboardFocus(page, locator);
  await page.keyboard.press('Enter');
}
async function layout(page, viewport) {
  expect(page.viewportSize()).toEqual(viewport);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('.transcript pre').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
}
async function inert(page) {
  expect(await page.evaluate(() => {
    const content = document.querySelector('.layout');
    return globalThis.wiCanary === undefined
      && content.querySelectorAll('script,img,a,iframe,object,embed,svg,math,link,style,audio,video,source').length === 0
      && Array.from(content.querySelectorAll('*')).every(node => Array.from(node.attributes).every(attribute =>
        !/^on/i.test(attribute.name) && !['src', 'href', 'srcdoc'].includes(attribute.name)))
      && document.querySelectorAll('script').length === 1
      && document.querySelector('script').getAttribute('src') === '/assets/app.js';
  })).toBe(true);
}
async function applied(page, sid, sequence) {
  await expect(page.locator('.metadata').filter({ hasText: /^Applied cursor:/ }))
    .toHaveText(new RegExp(`^Applied cursor: ${sid}:${sequence}\\nSnapshot head: (0|[1-9][0-9]*)$`));
}
async function bottom(transcript) {
  await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
}

// One acceptance case with three distinct finite client fixtures, not a transport matrix.
test('G1-16/25/27/28 real presentation, private boundary and finite measurements', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const executable = await discoverFixture();
  console.log(`Presentation Chromium ${browser.version()}; Node ${process.versions.node}`);
  const measurements = [];
  const screenshots = [];
  for (const label of labels) {
    let fixture;
    let context;
    let page;
    let observed;
    let debuggerSession;
    let failure;
    let stage = 'startup';
    try {
      fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, presentation: true });
      const viewport = label === 'short-selected' ? { width: 360, height: 800 } : { width: 1440, height: 900 };
      context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      observed = await observe(context, fixture);
      page = await context.newPage();
      const button = name => page.getByRole('button', { name, exact: true });
      const taskField = page.getByLabel('Task', { exact: true });
      // The label's raw text includes option text; the accessible combobox name does not.
      const workspace = page.getByRole('combobox', { name: 'Workspace', exact: true });
      const transcript = page.getByRole('region', { name: 'Canonical conversation', exact: true });
      const header = page.getByRole('heading', { name: 'Canonical session title', exact: true });
      const title = `${data.title}\nrenamed`;
      let firstPage;
      let acceptanceMs;
      let visibilityMs;
      let stallMs = 0;
      let liveUpdates = 0;
      const taskCount = label === 'long-selected' ? 2 : 1;

      stage = 'labelled connection and safe input error';
      await page.goto(`${fixture.origin}/`);
      await page.evaluate(async () => { await (await fetch('/index.html', { credentials: 'omit', cache: 'no-store', redirect: 'error' })).text(); });
      const token = page.getByLabel('Owner token', { exact: true });
      await keyboardFocus(page, token);
      await token.fill('private-config-canary');
      await activate(page, button('Connect'));
      await expect(token).toHaveValue('');
      await expect(page.locator('main > .error')).not.toBeEmpty();
      expect(await observed.privateBoundary(page)).toBe(true);
      await token.fill(fixture.owner);
      await activate(page, button('Connect'));
      await expect(token).toHaveValue('');
      await expect(page.locator('.topbar [role="status"]')).toHaveText('connected');
      await expect(button('Create session')).toBeEnabled();
      expect(await observed.privateBoundary(page)).toBe(true);
      expect((await fixture.inspect()).requests).toBe(0);

      stage = 'create title keyboard focus';
      const titleField = page.getByLabel('Title', { exact: true });
      await keyboardFocus(page, titleField);
      await titleField.fill(data.title);
      stage = 'create workspace keyboard focus';
      await keyboardFocus(page, workspace);
      stage = 'create keyboard submission';
      await activate(page, button('Create session'));
      await expect(page.locator('.commands')).toContainText('Accepted receipt (not completion)');
      await observed.beginPage();
      stage = 'open receipt keyboard selection';
      await activate(page, button('Open receipt session'));
      await exact(header, data.title);
      const sid = new URL(page.url()).hash.slice('#session='.length);
      await applied(page, sid, '1');
      await observed.drain();
      firstPage = observed.firstPage();
      await fixture.request({ command: 'select', session_id: sid });
      await expect(transcript.locator('.run')).toHaveCount(0);
      stage = 'rename keyboard controls';
      const renamed = page.getByLabel('Exact new title', { exact: true });
      await keyboardFocus(page, renamed);
      await renamed.fill(title);
      await activate(page, button('Rename session'));
      await exact(header, title);
      stage = 'catalog refresh keyboard controls';
      await activate(page, button('Refresh selected catalog entry'));
      await expect(page.locator('.commands')).toContainText('Catalog refresh:');
      await activate(page, button('Refresh list'));
      const choice = page.locator('.session-list button').filter({ hasText: 'title 雪' });
      await expect(choice).toHaveCount(1);
      stage = 'catalog choice keyboard control';
      await activate(page, choice);
      await exact(header, title);
      await layout(page, viewport);
      await inert(page);

      stage = 'Enter inserts newline';
      await keyboardFocus(page, taskField);
      await taskField.fill('keyboard');
      await taskField.press('End');
      await taskField.press('Enter');
      await expect(taskField).toHaveValue('keyboard\n');
      expect(observed.requests.filter(request => request.method === 'POST' && request.path.endsWith('/runs'))).toHaveLength(0);
      stage = 'Send keyboard focus';
      await keyboardFocus(page, button('Send'));
      stage = 'inactive Cancel control';
      await expect(button('Cancel current run')).toBeVisible();
      await expect(button('Cancel current run')).toBeDisabled();
      stage = 'connected Reconnect control';
      await expect(button('Reconnect observation')).toBeVisible();
      await expect(button('Reconnect observation')).toBeDisabled();

      for (let task = 0; task < taskCount; task++) {
        const gate = task * 6 + 1;
        if (task === 1) {
          stage = 'long selected history first page';
          const proof = await fixture.inspect();
          await observed.beginPage();
          await activate(page, button('Reload history'));
          await applied(page, sid, proof.sequence_count);
          await expect(page.locator('.topbar [role="status"]')).toContainText('observation: streaming');
          await observed.drain();
          firstPage = observed.firstPage();
          expect(firstPage.events).toBe(32);
          expect(observed.pages.length).toBeGreaterThan(1);
          expect(observed.pages.flatMap(page => page.events)).toHaveLength(Number(proof.sequence_count));
          await expect(transcript.locator('.run')).toHaveCount(1);
        }
        stage = `task ${task + 1} explicit submit and duplicate guard`;
        await fixture.request({ command: 'arm_acceptance' });
        await taskField.fill(data.user);
        observed.beginAcceptance();
        if (label === 'long-selected' && task === 0) await activate(page, button('Send'));
        else await taskField.press(task === 1 ? 'Meta+Enter' : 'Control+Enter');
        await fixture.request({ command: 'wait_acceptance' });
        await taskField.press(task === 1 ? 'Meta+Enter' : 'Control+Enter');
        await expect(button('Send')).toBeDisabled();
        expect(observed.requests.filter(request => request.method === 'POST' && request.path.endsWith('/runs'))).toHaveLength(task + 1);
        expect((await fixture.inspect()).accepted).toHaveLength(task);
        await fixture.request({ command: 'release_acceptance' });
        await fixture.wait('model_paused', gate);
        const proof = await fixture.inspect();
        await expect.poll(() => observed.accepted.length).toBe(task + 1);
        expect(observed.accepted[task].value.receipt).toEqual(proof.receipts[task]);
        acceptanceMs = observed.accepted[task].ms;
        const run = transcript.locator('.run').nth(task);
        await exact(run.locator('.user-text'), data.user);
        await keyboardFocus(page, button('Cancel current run'));
        // Inspect the usable active control without sending Cancel into this completed-work fixture.
        expect(observed.requests.some(request => request.path.endsWith('/cancel'))).toBe(false);

        stage = `task ${task + 1} persisted provisional canaries`;
        await fixture.request({ command: 'drive', gate });
        await fixture.wait('model_paused', gate + 1);
        const responses = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Response', exact: true }) });
        const rich = responses.nth(0);
        await richSections(rich, task, 'deltas');
        const provisional = await fixture.inspect();
        await applied(page, sid, provisional.sequence_count);
        expect([provisional.tool_results, provisional.response_finishes.length, provisional.requests])
          .toEqual([task * 3, task * 2, task * 2 + 1]);
        const detail = run.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Reasoning summary/ }) });
        await activate(page, detail.locator('summary'));
        expect(await detail.evaluate(node => node.open)).toBe(true);
        const stableDetail = await detail.elementHandle();
        const draft = '  unsent composer 雪\nkeep focus and value  ';
        await taskField.fill(draft);
        await taskField.focus();
        await transcript.evaluate(node => { node.scrollTop = 0; });
        expect(await transcript.evaluate(node => node.scrollHeight - node.clientHeight > 64)).toBe(true);
        const oldTop = await transcript.evaluate(node => node.scrollTop);
        await inert(page);
        expect(await observed.privateBoundary(page)).toBe(true);

        stage = `task ${task + 1} item.finished replaces deltas before response.finished`;
        await fixture.request({ command: 'drive', gate: gate + 1 });
        await fixture.wait('model_paused', gate + 2);
        // Each of the six native done frames commits one public item.finished record.
        await applied(page, sid, (BigInt(provisional.sequence_count) + 6n).toString());
        await richSections(rich, task, 'items-finished');
        const itemsFinished = await fixture.inspect();
        expect([itemsFinished.tool_results, itemsFinished.response_finishes.length, itemsFinished.requests])
          .toEqual([task * 3, task * 2, task * 2 + 1]);
        await expect(run).toContainText('Execution: running. Final result not recorded.');
        await expect(taskField).toBeFocused();
        await expect(taskField).toHaveValue(draft);
        expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
        expect(await transcript.evaluate(node => node.scrollTop)).toBe(oldTop);
        await inert(page);
        expect(await observed.privateBoundary(page)).toBe(true);

        stage = `task ${task + 1} later committed tools preserve focus details and scroll`;
        await fixture.request({ command: 'drive', gate: gate + 2 });
        await fixture.wait('model_paused', gate + 3);
        await richSections(rich, task, 'authoritative');
        await textOnce(run, task === 0 ? '{"sum":42}' : '{"sum":50}');
        await textOnce(run, skillOutput);
        await textOnce(run, '{"error":{"code":"gateway_error"}}');
        const skill = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Tool: load_skill', exact: true }) });
        await expect(skill).toContainText('finished (success)');
        await expect(skill).toContainText('Result: success');
        const add = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Tool: add_numbers', exact: true }) });
        await expect(add).toHaveCount(2);
        await expect(add.nth(0)).toContainText('Result: success');
        await expect(add.nth(1)).toContainText('Result: error');
        await expect(taskField).toBeFocused();
        await expect(taskField).toHaveValue(draft);
        expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
        expect(await transcript.evaluate(node => node.scrollTop)).toBe(oldTop);
        await expect(button('New content')).toBeVisible();
        await activate(page, button('New content'));
        await bottom(transcript);
        await expect(button('New content')).toBeHidden();
        await taskField.focus();
        await page.evaluate(() => {
          globalThis.presentationLive = 0;
          globalThis.presentationObserver?.disconnect();
          globalThis.presentationObserver = new MutationObserver(records => { globalThis.presentationLive += records.length; });
          for (const node of document.querySelectorAll('[role="status"],[aria-live]')) {
            globalThis.presentationObserver.observe(node, { childList: true, characterData: true, subtree: true });
          }
        });
        expect(await transcript.locator('[aria-live],[role="status"],[role="alert"]').count()).toBe(0);
        expect(await page.locator('[role="alert"],[aria-live="assertive"]').count()).toBe(0);

        stage = `task ${task + 1} finite committed visibility and reader behavior`;
        let committedStart;
        if (label === 'stalled-reader') {
          debuggerSession = await context.newCDPSession(page);
          await debuggerSession.send('Debugger.enable');
          const paused = new Promise(resolve => debuggerSession.once('Debugger.paused', resolve));
          let resumed = false;
          debuggerSession.on('Debugger.resumed', () => { resumed = true; });
          await debuggerSession.send('Debugger.pause');
          await paused;
          const stallStart = performance.now();
          await fixture.request({ command: 'drive', gate: gate + 3 });
          await fixture.wait('model_paused', gate + 4);
          await fixture.request({ command: 'drive', gate: gate + 4 });
          await fixture.wait('model_paused', gate + 5);
          await fixture.request({ command: 'drive', gate: gate + 5 });
          await fixture.wait('task_finished', task + 1);
          committedStart = performance.now();
          const committed = await fixture.inspect();
          expect(committed.results).toBe(task + 1);
          // A separate real authenticated read observes completion while Chromium cannot apply data.
          const response = await fetch(`${fixture.origin}/v1/sessions/${sid}/history?after=${sid}:${committed.terminal_sequences[task]}&limit=32`,
            { headers: { Authorization: `Bearer ${fixture.owner}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
          expect(response.status).toBe(200);
          const observation = await response.json();
          expect(observation.events.some(event => event.kind === 'run.result')).toBe(true);
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(resumed).toBe(false);
          stallMs = performance.now() - stallStart;
          await debuggerSession.send('Debugger.resume');
          await debuggerSession.detach(); debuggerSession = null;
        } else {
          stage = `task ${task + 1} release final deltas`;
          await fixture.request({ command: 'drive', gate: gate + 3 });
          stage = `task ${task + 1} await final delta gate`;
          await fixture.wait('model_paused', gate + 4);
          stage = `task ${task + 1} exact provisional answer`;
          await answerSection(responses.nth(1), task, false);
          const answerDeltas = await fixture.inspect();
          await applied(page, sid, answerDeltas.sequence_count);
          stage = `task ${task + 1} exact finished answer before authority`;
          await fixture.request({ command: 'drive', gate: gate + 4 });
          await fixture.wait('model_paused', gate + 5);
          await applied(page, sid, (BigInt(answerDeltas.sequence_count) + 1n).toString());
          await answerSection(responses.nth(1), task, false);
          expect((await fixture.inspect()).response_finishes.length).toBe(task * 2 + 1);
          stage = `task ${task + 1} near-bottom follow`;
          await bottom(transcript);
          await expect(taskField).toBeFocused();
          await expect(taskField).toHaveValue(draft);
          expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
          stage = `task ${task + 1} release authoritative final`;
          await fixture.request({ command: 'drive', gate: gate + 5 });
          stage = `task ${task + 1} await stored final result`;
          await fixture.wait('task_finished', task + 1);
          committedStart = performance.now();
        }
        stage = `task ${task + 1} applied recorded result`;
        const finished = await fixture.inspect();
        await applied(page, sid, finished.result_sequences[task]);
        // This starts at the fixture's durable-result confirmation, not provider release.
        visibilityMs = performance.now() - committedStart;
        await expect(taskField).toBeFocused();
        await expect(taskField).toHaveValue(draft);
        expect(await stableDetail.evaluate(node => node.isConnected && node.open)).toBe(true);
        await bottom(transcript);
        const updates = await page.evaluate(() => { globalThis.presentationObserver.disconnect(); return globalThis.presentationLive; });
        expect(updates).toBeLessThanOrEqual(2);
        liveUpdates += updates;
        await expect(run).toContainText('Execution: completed. Final result recorded.');
        await textOnce(run, answer(task));
        await richSections(rich, task, 'authoritative');
        await answerSection(responses.nth(1), task, true);
        await expect(responses).toHaveCount(2);
        await expect(run).not.toContainText('(provisional)');
        for (const key of ['text', 'refusal', 'summary', 'reasoning']) await textOnce(run, data[key]);
        expect(finished.tool_results).toBe((task + 1) * 3);
        expect(finished.requests).toBe((task + 1) * 2);
        expect([finished.provider_failed, finished.read_failure]).toEqual([false, null]);
        await expect(button('Cancel current run')).toBeDisabled();
        await layout(page, viewport);
        await inert(page);
        expect(await observed.privateBoundary(page)).toBe(true);
      }

      stage = 'synthetic screenshots with cleared token';
      await observed.drain();
      expect(observed.assets.size).toBe(9);
      expect(Object.values(observed.faults)).toEqual([0, 0, 0, 0, 0, 0]);
      await expect(page.locator('input[type="password"]')).toHaveValue('');
      if (label !== 'stalled-reader') {
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const part of ['overview', 'conversation']) {
          if (part === 'conversation') await transcript.scrollIntoViewIfNeeded();
          expect(await observed.privateBoundary(page)).toBe(true);
          const path = testInfo.outputPath(`${label}-${part}.png`);
          screenshots.push(path);
          await page.screenshot({ path, fullPage: false });
        }
      }

      stage = 'reload cost and local reducer render sample';
      const finished = await fixture.inspect();
      const rebuildStart = performance.now();
      await observed.beginPage();
      await activate(page, button('Reload history'));
      await applied(page, sid, finished.sequence_count);
      await expect(page.locator('.topbar [role="status"]')).toContainText('observation: streaming');
      const rebuildMs = performance.now() - rebuildStart;
      await observed.drain();
      const events = observed.pages.flatMap(page => page.events);
      expect(events.length).toBe(Number(finished.sequence_count));
      expect(events.length).toBeGreaterThan(32);
      expect(observed.pages.length).toBeGreaterThan(1);
      await expect(transcript.locator('.run')).toHaveCount(taskCount);
      await exact(header, title);
      for (let task = 0; task < taskCount; task++) {
        const run = transcript.locator('.run').nth(task);
        await exact(run.locator('.user-text'), data.user);
        await textOnce(run, answer(task));
        await textOnce(run, skillOutput);
        for (const key of ['text', 'refusal', 'summary', 'reasoning']) await textOnce(run, data[key]);
        const responses = run.locator('.entry').filter({ has: page.getByRole('heading', { name: 'Response', exact: true }) });
        await expect(responses).toHaveCount(2);
        await richSections(responses.nth(0), task, 'authoritative');
        await answerSection(responses.nth(1), task, true);
        await expect(run).not.toContainText('(provisional)');
        expect((await run.textContent()).includes(data.arguments)).toBe(false);
      }
      // Inspect the actual public history captured from Chromium's authenticated reload.
      for (const event of events) validateEventView(event);
      expect(observed.secrets.some(secret => JSON.stringify(events).includes(secret))).toBe(false);
      for (let task = 0; task < taskCount; task++) {
        const runId = finished.accepted[task].run_id;
        const runEvents = events.filter(event => event.run_id === runId);
        expect(runEvents.filter(event => event.kind === 'response.finished')).toHaveLength(2);
        for (let turn = 0; turn < 2; turn++) {
          const id = `task-${task}-${turn === 0 ? 'tools' : 'final'}`;
          const response = runEvents.filter(event => event.kind.startsWith('response.') && event.data.response_id === id);
          const started = response.filter(event => event.kind === 'response.item.started');
          const deltas = response.filter(event => event.kind === 'response.delta');
          const done = response.filter(event => event.kind === 'response.item.finished');
          const terminal = response.at(-1);
          expect(response.map(event => event.kind)).toEqual(['response.started',
            ...Array(turn === 0 ? 6 : 1).fill('response.item.started'), ...Array(deltas.length).fill('response.delta'),
            ...Array(turn === 0 ? 6 : 1).fill('response.item.finished'), 'response.finished']);
          const turnFinished = runEvents.filter(event => event.kind === 'turn.finished' && event.data.response_id === id);
          expect(turnFinished).toHaveLength(1);
          expect(BigInt(turnFinished[0].sequence) > BigInt(terminal.sequence)).toBe(true);
          expect(terminal.data.output_provenance).toBe('native_terminal');
          expect(terminal.data.text).toBe(turn === 0 ? data.text + data.refusal : answer(task));
          expect(done.map(event => [event.data.output_index, event.data.item]))
            .toEqual(terminal.data.items.map((item, index) => [String(index), item]));
          expect(started.map(event => [event.data.output_index, event.data.item.item_id, event.data.item.kind]))
            .toEqual(done.map(event => [event.data.output_index, event.data.item.item_id, event.data.item.kind]));
          if (turn === 0) {
            expect(terminal.data.items.map(item => item.kind)).toEqual(['reasoning', 'message', 'function_call', 'function_call', 'function_call', 'reasoning']);
            expect(terminal.data.items[5]).toEqual({ item_id: 'opaque-reason', kind: 'reasoning', function_call: null, content: [], unsupported_content: true });
            expect(terminal.data.items.filter(item => item.unsupported_content)).toHaveLength(1);
            expect(started.slice(0, 3).map(event => event.data.item.content)).toEqual([[], [], []]);
            expect(started[2].data.item.function_call).toEqual({ ...terminal.data.items[2].function_call, arguments: '', complete: false });
            expect(started[5].data.item).toEqual(terminal.data.items[5]);
            const expected = [
              ['reasoning_summary', '0', null, '0', 'reason', data.summary],
              ['reasoning_text', '0', '0', null, 'reason', data.reasoning],
              ['text', '1', '0', null, 'mixed', data.text],
              ['refusal', '1', '1', null, 'mixed', data.refusal],
              ['function_arguments', '2', null, null, 'item-add-雪', data.arguments],
            ].flatMap(([kind, output, content, summary, item, text]) => {
              const tuple = [kind, output, content, summary, item]; const split = text.indexOf('\n') + 1;
              return [[...tuple, text.slice(0, split)], [...tuple, text.slice(split)]];
            });
            expect(deltas.map(({ data: d }) => [d.kind, d.output_index, d.content_index, d.summary_index, d.item_id, d.delta])).toEqual(expected);
          } else {
            expect(started[0].data.item.content).toEqual([]);
            expect(terminal.data.items[0].content).toEqual([{ kind: 'text', text: answer(task) }]);
            const chars = [...answer(task)]; const expected = [];
            for (let offset = 0; offset < chars.length; offset += 32) expected.push(['text', '0', '0', null, 'answer', chars.slice(offset, offset + 32).join('')]);
            expect(deltas.map(({ data: d }) => [d.kind, d.output_index, d.content_index, d.summary_index, d.item_id, d.delta])).toEqual(expected);
          }
        }
        expect(runEvents.filter(event => event.kind === 'tool.result').map(event => [event.data.call_id, event.data.output, event.data.is_error]))
          .toEqual([['add-雪', task === 0 ? '{"sum":42}' : '{"sum":50}', false], ['skill', skillOutput, false], ['overflow', '{"error":{"code":"gateway_error"}}', true]]);
      }
      let replay = createConversation(sid);
      for (const event of events) {
        const before = selectDisplay(replay).map(run => run.entries);
        replay = applyEvent(replay, event);
        if (event.kind === 'run.result') {
          expect(Object.keys(event.data).sort()).toEqual(['events_complete', 'outcome', 'sink_error', 'summary']);
          expect(selectDisplay(replay).map(run => run.entries)).toEqual(before);
          expect(selectDisplay(replay).find(run => run.run.run_id === event.run_id).result_recorded).toBe(true);
        }
      }
      const skillResults = events.filter(event => event.kind === 'tool.result' && event.data.output === skillOutput);
      expect(skillResults).toHaveLength(taskCount);
      expect(skillResults.every(event => event.data.is_error === false)).toBe(true);
      const domNodes = await transcript.locator('*').count();
      const manifest = { session_id: sid, title, workspace: await workspace.inputValue(), head_sequence: finished.sequence_count };
      const local = await localRender(page, events, manifest);
      expect(local.events).toBe(events.length);
      expect(local.nodes).toBe(domNodes);
      await expect(page.locator('.limits')).toContainText('Selected history and DOM can grow; reloading rebuilds the selected history.');
      measurements.push(measurement({ label, first_page_ms: firstPage.ms, first_page_events: firstPage.events,
        durable_acceptance_ms: acceptanceMs, committed_visibility_ms: visibilityMs, reducer_render_ms: local.ms,
        rebuild_ms: rebuildMs, stall_ms: stallMs, history_pages: observed.pages.length, selected_events: events.length,
        selected_dom_nodes: domNodes, local_dom_nodes: local.nodes, live_updates: liveUpdates,
        deltas: events.filter(event => event.kind === 'response.delta').length }));

      stage = 'basic reconnect keyboard control after a real read abort';
      // Abort only the next observation request. No API response is replaced or fabricated.
      const interrupt = '**/events?*';
      await context.route(interrupt, route => {
        observed.expectReadAbort(route.request().url());
        return route.abort();
      }, { times: 1 });
      await activate(page, button('Reload history'));
      await expect(button('Reconnect observation')).toBeEnabled();
      await context.unroute(interrupt);
      await activate(page, button('Reconnect observation'));
      await expect(page.locator('.topbar [role="status"]')).toContainText('observation: streaming');
      await applied(page, sid, finished.sequence_count);
      // The expected browser network error is not script execution or a private diagnostic.
      expect(observed.faults.console).toBe(0);
      expect([observed.faults.external, observed.faults.page, observed.faults.secret, observed.faults.asset, observed.faults.response]).toEqual([0, 0, 0, 0, 0]);

      stage = 'selection and disconnect controls remain read-only';
      await activate(page, button('Fixture barrier seed'));
      await expect(transcript.locator('.run')).toHaveCount(0);
      await activate(page, choice);
      await exact(header, title);
      await applied(page, sid, finished.sequence_count);
      await expect(transcript.locator('.run')).toHaveCount(taskCount);
      await layout(page, viewport);
      await inert(page);
      expect(await observed.privateBoundary(page)).toBe(true);
      await activate(page, button('Disconnect'));
      await expect(token).toBeVisible();
      await expect(taskField).toHaveValue('');
      await expect(page.locator('.run,.command')).toHaveCount(0);
      expect(await observed.privateBoundary(page)).toBe(true);
      const final = await fixture.inspect();
      expect([final.requests, final.tool_results, final.completed]).toEqual([taskCount * 2, taskCount * 3, taskCount]);
      expect([final.connections, final.auth_loads, final.auth_prepares, final.fresh_parents, final.continuations, final.prepared_exact])
        .toEqual([taskCount, taskCount, taskCount, taskCount, taskCount, taskCount * 2]);
      expect([final.fresh_empty, final.restored_history, final.terminals, final.results, final.gate])
        .toEqual([true, taskCount === 2, taskCount, taskCount, null]);
      expect([final.provider_stage, final.provider_failed, final.read_failure]).toEqual([taskCount === 2 ? 'finished' : 'request', false, null]);
      expect(observed.requests.filter(request => request.method === 'POST' && request.path.endsWith('/runs'))).toHaveLength(taskCount);
      expect(observed.requests.some(request => request.path.endsWith('/cancel'))).toBe(false);
      await observed.drain();
      expect(Object.values(observed.faults)).toEqual([0, 0, 0, 0, 0, 0]);
    } catch (error) {
      await debuggerSession?.send('Debugger.resume').catch(() => {});
      const observation = await page?.evaluate(() => {
        const cursor = Array.from(document.querySelectorAll('.metadata')).map(node => node.textContent)
          .find(text => text.startsWith('Applied cursor:'));
        const text = document.querySelector('.transcript')?.textContent ?? '';
        return { applied: cursor?.match(/^Applied cursor: [0-9a-f-]{36}:([0-9]+)\n/)?.[1] ?? null,
          failed: text.includes('Execution: failed'), recorded: text.includes('Final result recorded.'),
          sink_failed: text.includes('event_sink'), slow_consumer: text.includes('slow_consumer'),
          observation_error: Array.from(document.querySelectorAll('.error')).some(node => node.textContent !== '') };
      }).catch(() => null);
      const proof = await fixture?.inspect().catch(() => null);
      const safeErrors = ['fixture child failed', 'fixture control timed out', 'fixture protocol rejected'];
      const category = safeErrors.includes(error?.message) ? error.message : 'assertion or browser action';
      const lines = [...(error?.stack ?? '').matchAll(/presentation\.spec\.mjs:(\d+):\d+/g)].slice(0, 4).map(match => Number(match[1]));
      const pages = observed?.pages.map(page => page?.events.length ?? -1) ?? [];
      console.log(`Presentation boundary: ${JSON.stringify({ label, stage, category, observation, lines, pages, faults: observed?.faults, response_failures: observed?.responseFailures, control: focusedControl, sequence_count: proof?.sequence_count ?? null, requests: proof?.requests ?? null,
        completed: proof?.completed ?? null, provider_stage: proof?.provider_stage ?? null, read_failure: proof?.read_failure ?? null })}`);
      const matchers = ['toBe', 'toEqual', 'toHaveCount', 'toHaveText', 'toContainText', 'toHaveValue', 'toBeVisible', 'toBeEnabled', 'toBeDisabled', 'toBeHidden', 'toBeFocused', 'toBeLessThanOrEqual', 'toBeGreaterThan'];
      const name = error?.matcherResult?.name ?? error?.message?.match(/\.(to[A-Za-z]+)\(/)?.[1];
      const matcher = matchers.includes(name) ? name : 'action or control';
      failure = new Error(`Presentation assertion failed: ${label}; ${stage}; ${matcher}`);
    } finally {
      try { await debuggerSession?.send('Debugger.resume'); await debuggerSession?.detach(); } catch { /* The page may already be closed. */ }
      try { await context?.close(); } catch { failure ??= new Error('Presentation browser cleanup failed'); }
      try { await fixture?.stop(); } catch { failure ??= new Error('Presentation fixture cleanup failed'); }
      if (failure) for (const path of screenshots) await rm(path, { force: true });
    }
    if (failure) throw failure;
  }
  expect(measurements.map(value => value.label)).toEqual(labels);
  for (const value of measurements) console.log(`G1-28 ${JSON.stringify(value)}`);
});
