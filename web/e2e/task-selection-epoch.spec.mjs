import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { installSelectionEpochObserver } from '../test-support/selection-epoch.mjs';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json',import.meta.url),'utf8'));
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n'; // Exact browser.rs TASKS[0].
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const ARGUMENTS = '{"a":17,\r\n "b":25}';
const OUTPUT = '{"sum":42}';
const DRAFT = 'B only unsent draft 雪\n<em>inert</em>\n';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({trace:'off',screenshot:'off',video:'off'});

test('selection epoch: held real A acceptance resolves after B selection without retargeting work or state', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture; let context; let page; let failure;
  let stage = 'startup'; let observed = null;
  const cleanup = {browser:false,fixture:false};
  const faults = {external:0,request:0,response:0,console:0,page:0,private:0};
  const network = {create:0,task:0,other:0,settings:0,list:0};
  const reads = [];
  const creates = [];
  let submitted = null;
  let workspaces;
  try {
    fixture = await startFixture(executable,{transport:'websocket',recovered:false,mime:true,mutations:true});
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    context = await browser.newContext({serviceWorkers:'block'});
    const markers = ['synthetic-replay-','synthetic-account-','private-operator-','private-project-','private-skill-',
      'private-native','private-data','private-skills','principal_digest','history_digest','encrypted_content',
      'opaque_response','provider_session_id','prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
    const files = new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','client','sse','state','view'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    const assets = new Set();
    await context.route('**/*',async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
      else await route.continue(); // Never replace or inspect an API response.
    });
    context.on('request',request => {
      const url = new URL(request.url());
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.private++;
      if (!url.pathname.startsWith('/v1/')) return;
      const headers = request.headers();
      if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
        || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      if (request.method() === 'GET') {
        if (url.pathname === '/v1/settings' && url.search === '') network.settings++;
        else if (url.pathname === '/v1/sessions' && url.search === '?limit=32') network.list++;
        else if (/^\/v1\/sessions\/[0-9a-f-]{36}(\/(history|events))?$/.test(url.pathname) && reads.length < 16) {
          reads.push({path:url.pathname,query:url.searchParams});
        } else network.other++;
        return;
      }
      if (request.method() !== 'POST' || url.search !== '') {network.other++; return;}
      if (url.pathname !== '/v1/sessions' && !/^\/v1\/sessions\/[0-9a-f-]{36}\/runs$/.test(url.pathname)) {network.other++; return;}
      const create = url.pathname === '/v1/sessions'; network[create ? 'create' : 'task']++;
      try {
        const raw = request.postDataBuffer();
        if (raw === null || raw.length > 4096 || headers['content-type'] !== 'application/json') throw new Error();
        const text = raw.toString('utf8'); if (leaked(text)) {faults.private++; throw new Error();}
        const body = JSON.parse(text);
        const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
        if (!uuid(body.operation_id)) throw new Error();
        if (create) {
          const slot = creates.length;
          if (slot >= 2 || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
            || body.title !== titles[slot] || body.workspace !== workspaces[slot]
            || creates.some(known => known.operation_id === body.operation_id)) throw new Error();
          creates.push(body);
        } else {
          if (submitted !== null || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
            || !uuid(body.run_id) || body.run_id === body.operation_id || body.text !== TASK
            || creates.some(c => c.operation_id === body.operation_id || c.operation_id === body.run_id)) throw new Error();
          submitted = {path:url.pathname,...body};
        }
      } catch {faults.request++;}
    });
    context.on('response',response => {
      if (response.status() >= 300) faults.response++;
      const path = new URL(response.url()).pathname; if (files.has(path)) assets.add(path);
    });
    await context.addInitScript(installSelectionEpochObserver,{titles,task:TASK,draft:DRAFT,owner:fixture.owner});
    page = await context.newPage();
    page.on('console',message => { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.private++; });
    page.on('pageerror',() => {faults.page++;});
    const status = page.locator('.topbar [role="status"]');
    const cursor = page.locator('p.metadata').filter({hasText:/^Applied cursor:/});
    const conversation = page.locator('.conversation');
    const transcript = page.getByRole('region',{name:'Canonical conversation',exact:true});
    const taskField = page.getByLabel('Task',{exact:true});
    const sessionButton = slot => page.locator('.session-list button').filter({hasText:slot === 0 ? 'first title' : 'second title'});
    const outcome = page.locator('.commands > section > pre');
    async function summary() { observed = await page.evaluate(() => globalThis.selectionEpochCapture.summary()); return observed; }
    async function privateBoundary() {
      const safe = await page.evaluate(async ({owner,markers}) => {
        const texts = [document.documentElement.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0
          && texts.every(text => !text || (!text.includes(owner) && !/[0-9a-f]{64}/i.test(text) && !markers.some(marker => text.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run em,.run script,.run img,.run a,.command em,.conversation h2 em,img,iframe').count()).toBe(0);
      expect(await page.locator('.error').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
    }
    function provider(proof,requests,tools,completed) {
      expect([proof.requests,proof.connections,proof.auth_loads,proof.auth_prepares,proof.prepared_exact,
        proof.tool_results,proof.terminals,proof.results,proof.completed]).toEqual([requests,1,1,1,requests,tools,completed,completed,completed]);
      expect(proof.fresh_empty && !proof.restored_history && proof.fresh_parents === 1 && proof.continuations === requests-1
        && !proof.provider_failed && proof.read_failure === null && proof.accepted.length === 1 && proof.receipts.length === 1).toBe(true);
      expect(network).toEqual({create:2,task:1,other:0,settings:1,list:2});
    }
    function readAccounting(a,b,reopened,bReopened = false) {
      const expected = new Map([[`/v1/sessions/${a}`,reopened ? 3 : 2],[`/v1/sessions/${b}`,bReopened ? 3 : 2],
        [`/v1/sessions/${a}/history`,reopened ? 2 : 1],[`/v1/sessions/${a}/events`,reopened ? 2 : 1],
        [`/v1/sessions/${b}/history`,bReopened ? 2 : 1],[`/v1/sessions/${b}/events`,bReopened ? 2 : 1]]);
      expect(reads.length).toBe([...expected.values()].reduce((sum,n) => sum+n,0));
      for (const [path,count] of expected) expect(reads.filter(r => r.path === path).length).toBe(count);
      for (const read of reads) {
        const sid = read.path.split('/')[3];
        if (read.path.endsWith('/history')) expect(read.query.size === 2 && read.query.get('after') === `${sid}:0` && read.query.get('limit') === '32').toBe(true);
        else if (read.path.endsWith('/events')) {
          const head = read === reads.filter(r => r.path === `/v1/sessions/${a}/events`)[1] ? '20' : '1';
          expect(read.query.size === 1 && read.query.get('after') === `${sid}:${head}`).toBe(true);
        } else expect(read.query.size).toBe(0);
      }
    }

    stage = 'two UI creations in distinct configured workspaces';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.getByRole('button',{name:'Connect',exact:true}).click(); await exact(status,'connected');
    expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    const workspace = page.getByLabel(/^Workspace/);
    workspaces = await workspace.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    expect(workspaces.length === 2 && workspaces[0] !== workspaces[1]).toBe(true);
    for (let slot=0; slot<2; slot++) {
      await page.getByLabel('Title',{exact:true}).fill(titles[slot]); await workspace.selectOption(workspaces[slot]);
      await page.getByRole('button',{name:'Create session',exact:true}).click();
      await expect.poll(async () => creates.length === slot+1 && (await outcome.textContent()).includes(creates[slot].operation_id)).toBe(true);
    }
    const creation = await fixture.inspectMutations();
    expect(creation.session_count === 3 && creation.seed_sessions === 1 && creation.creations.length === 2).toBe(true);
    for (const [slot,c] of creation.creations.entries()) expect(c.exact && c.catalog_current && c.sequence_count === '1'
      && c.rename_events === 0 && c.receipt.operation_id === creates[slot].operation_id).toBe(true);
    const [a,b] = creation.creations.map(c => c.receipt.session_id); expect(a !== b).toBe(true);
    stage = 'refresh list and open A';
    await page.getByRole('button',{name:'Refresh list',exact:true}).click();
    await expect(sessionButton(0)).toHaveCount(1); await expect(sessionButton(1)).toHaveCount(1);
    await fixture.request({command:'select',session_id:a}); await sessionButton(0).click();
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(cursor,`Applied cursor: ${a}:1\nSnapshot head: 1`);
    await exact(status,'connected; observation: streaming'); await exact(transcript,'No messages yet.');
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true);

    stage = 'native accepted response held while A runs at model gate one';
    await taskField.fill('Edited before explicit Send'); await taskField.fill(TASK);
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await fixture.wait('model_paused',1);
    expect(await page.evaluate(() => globalThis.selectionEpochCapture.wait())).toBe(true);
    const committed = await fixture.inspectTask(); const receipt = committed.receipt;
    expect(committed.exact && committed.run_state === 'running' && committed.sequence_count === '6').toBe(true);
    expect(submitted.path === `/v1/sessions/${a}/runs` && receipt.session_id === a
      && receipt.operation_id === submitted.operation_id && receipt.run_id === submitted.run_id).toBe(true);
    provider(await fixture.inspect(),1,0,0);
    await exact(cursor,`Applied cursor: ${a}:6\nSnapshot head: 1`);
    await exact(transcript.locator('.user-text'),TASK);
    await expect.poll(async () => (await summary()).canonical).toBe(true);
    expect(observed.received && !observed.released && !observed.returned && observed.counts.holds === 1).toBe(true);

    stage = 'actual session-list switch aborts only A observation';
    await sessionButton(1).click();
    async function bTruth(expectedDraft) {
      await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[1]);
      await exact(conversation.locator(':scope > .metadata'),`Workspace: ${workspaces[1]}\nSession: ${b}`);
      await exact(cursor,`Applied cursor: ${b}:1\nSnapshot head: 1`);
      await exact(transcript,'No messages yet.'); await exact(status,'connected; observation: streaming');
      expect(new URL(page.url()).hash === `#session=${b}`).toBe(true);
      expect(await conversation.locator('.run,.command').count()).toBe(0);
      expect(await conversation.getByRole('button',{name:/Read run status|Retry identical command|Reconcile receipt/}).count()).toBe(0);
      await expect(page.getByRole('button',{name:'Cancel current run',exact:true})).toBeDisabled();
      expect(await taskField.inputValue() === expectedDraft).toBe(true);
      await privateBoundary();
    }
    await bTruth(''); await summary(); expect(observed.bReady && observed.aAborted && !observed.taskAborted).toBe(true);
    // The global recovery row belongs to A, not B's selected conversation.
    await exact(page.locator('.command .metadata'),`Operation: ${receipt.operation_id}\nSession: ${a}`);
    expect(await page.getByRole('button',{name:'Retry identical command',exact:true}).count()).toBe(0);
    await taskField.fill(DRAFT); await bTruth(DRAFT);

    stage = 'release the same real A response after B is fully selected';
    expect(await page.evaluate(() => globalThis.selectionEpochCapture.release())).toBe(true);
    expect(await page.evaluate(() => globalThis.selectionEpochCapture.drain())).toBe(true);
    await summary(); stage = 'actual A receipt remains global and B stays unchanged';
    await expect(page.locator('.command')).toHaveCount(0);
    await exact(outcome,`task command\n\nAccepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${a}\nRun: ${receipt.run_id}\nSequences: 2 to 3\n\nDuplicate receipt: false`);
    await bTruth(DRAFT); readAccounting(a,b,false);

    stage = 'A tool gate one';
    await fixture.request({command:'drive',gate:1}); await fixture.wait('model_paused',2); provider(await fixture.inspect(),2,1,0); await bTruth(DRAFT);
    stage = 'A provisional gate two';
    await fixture.request({command:'drive',gate:2}); await fixture.wait('model_paused',3); await bTruth(DRAFT);
    stage = 'A terminal gate three';
    await fixture.request({command:'drive',gate:3}); await fixture.wait('task_finished',1);
    stage = 'A completed provider audit';
    const finished = await fixture.inspect(); provider(finished,2,1,1);
    stage = 'A completed task audit';
    const final = await fixture.inspectTask();
    expect(final.exact && final.run_state === 'completed' && final.sequence_count === '20'
      && JSON.stringify(final.receipt) === JSON.stringify(receipt) && final.accepted_event_id === committed.accepted_event_id
      && final.checkpoint_event_id === committed.checkpoint_event_id).toBe(true);
    expect([final.task_commands,final.runs,final.acceptance_events,final.selection_events,final.binding_events,
      final.rename_events,final.deltas,final.tool_starts,final.tool_finishes]).toEqual([1,1,1,1,1,0,1,1,1]);
    expect(finished.provider_stage === 'finished' && finished.response_finishes.length === 2
      && finished.response_finishes.every(r => r.provenance === 'native_terminal') && finished.sequence_count === '20').toBe(true);
    await bTruth(DRAFT); await page.waitForTimeout(500); await bTruth(DRAFT); provider(await fixture.inspect(),2,1,1);
    readAccounting(a,b,false); await summary(); expect(observed.failures).toEqual([]);

    stage = 'reopen A through UI and replay its real fixed-head history';
    expect(await page.evaluate(() => globalThis.selectionEpochCapture.reopen())).toBe(true); await sessionButton(0).click();
    await exact(cursor,`Applied cursor: ${a}:20\nSnapshot head: 20`);
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(status,'connected; observation: streaming; run: completed; result recorded');
    const run = transcript.locator('.run'); await expect(run).toHaveCount(1); await exact(run.locator('.user-text'),TASK);
    await exact(run.locator(':scope > p:not(.metadata)'),'Execution: completed. Final result recorded.');
    for (const text of [ANSWER,ARGUMENTS,OUTPUT]) await occurrences(run,text,1);
    await expect(run.locator('.entry')).toHaveCount(3);
    const tool = run.locator('.entry').filter({has:page.getByRole('heading',{name:'Tool: add_numbers',exact:true})});
    expect((await tool.textContent()).includes('finished (success)') && (await tool.textContent()).includes('Result: success')).toBe(true);
    expect((await run.textContent()).includes('Terminal outcome: completed') && (await run.textContent()).includes('Outcome: completed')).toBe(true);
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true); expect(await taskField.inputValue() === '').toBe(true);
    await page.waitForTimeout(500); provider(await fixture.inspect(),2,1,1); readAccounting(a,b,true); await privateBoundary();
    await summary(); expect(observed.failures).toEqual([]);
    expect(observed.counts).toEqual({create:2,task:1,other:0,holds:1,aManifest:3,aHistory:2,aEvents:2,bManifest:2,bHistory:1,bEvents:1});
    expect(observed.returned && observed.accepted && observed.drained && observed.bDraft && !observed.taskAborted).toBe(true);
    expect(assets.size).toBe(files.size);
    expect(await page.evaluate(checkEmbeddedAssets,{secrets:markers,
      files:await Promise.all([...files].map(async ([path,file]) => [path,[...await readFile(new URL(`../${file}`,import.meta.url))]]))})).toEqual({checked:8,failures:[]});

    stage = 'B reopened through real manifest history and SSE remains head one';
    await sessionButton(1).click(); await bTruth('');
    await page.waitForTimeout(500); await bTruth('');
    provider(await fixture.inspect(),2,1,1); readAccounting(a,b,true,true);
    await summary(); expect(observed.failures).toEqual([]);
    expect(observed.counts).toEqual({create:2,task:1,other:0,holds:1,aManifest:3,aHistory:2,aEvents:2,bManifest:3,bHistory:2,bEvents:2});

    stage = 'Disconnect clears memory and DOM without cancellation';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click(); await exact(status,'disconnected');
    expect(await page.evaluate(() => globalThis.selectionEpochCapture.cleared())).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
    await privateBoundary(); provider(await fixture.inspect(),2,1,1); readAccounting(a,b,true,true);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch {
    // Never forward assertions, DOM, wire identities, input arguments or raw exceptions to Playwright.
    failure = new Error(`Selection epoch failed: ${stage}; capture=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; network=${JSON.stringify(network)}`);
  } finally {
    try { await page?.evaluate(() => globalThis.selectionEpochCapture?.teardown()); } catch { failure ??= new Error('Selection epoch observer cleanup failed'); }
    try { await context?.close(); cleanup.browser = context !== undefined; } catch { failure ??= new Error('Selection epoch browser cleanup failed'); }
    // A failed close leaves the context visible to Playwright's failure recorder.
    if (cleanup.browser) {
      if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
    }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; } catch { failure ??= new Error('Selection epoch fixture cleanup failed'); }
  }
  console.log(`Selection epoch cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  console.log('Selection epoch evidence: contexts=1 creates=2 task_posts=1 holds=1 A_stream_aborted=true B_head=1 A_final=20 provider_connections=1 provider_requests=2 tools=1 results=1 cancel_retry_reconcile_other=0 stable_B_ms=500 stable_final_ms=500');
});
