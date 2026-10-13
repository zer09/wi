import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { armReplyLoss } from '../test-support/mutations.mjs';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';

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
  let stage = 'startup'; let hold;
  const replyFacts = () => ({acquired:false,status:null,body_attempted:false,body_returned:false,
    body_rejected:false,body_rejection_class:null,body_bounded:false,decoded:false,validated:false,exact:false});
  const observed = {creates:[replyFacts(),replyFacts()],task:replyFacts(),latest:[]};
  const delay = {armed:false,paused:false,released:false};
  const cleanup = {interceptor:false,browser:false,fixture:false};
  const faults = {external:0,request:0,response:0,console:0,page:0,private:0};
  const network = {create:0,task:0,other:0,settings:0,list:0};
  const reads = [];
  const creates = [];
  const created = [];
  const snapshots = [];
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
    async function readReply(promise, facts, validator, check, limit = 4096) {
      const response = await promise;
      facts.acquired = true;
      const status = response.status();
      facts.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      facts.body_attempted = true;
      let bytes;
      try { bytes = await response.body(); }
      catch (cause) {
        facts.body_rejected = true;
        const message = typeof cause?.message === 'string' ? cause.message : '';
        // First matching marker wins; the marker does not establish a historical cause.
        if (/Network\.getResponseBody/.test(message)) facts.body_rejection_class = 'method_get_response_body';
        else if (message.includes('Target page, context or browser has been closed')) facts.body_rejection_class = 'target_closed';
        else if (message.includes('Target crashed')) facts.body_rejection_class = 'target_crashed';
        else if (cause?.name === 'TimeoutError' || /\bTimeout [0-9]+ms exceeded\b/.test(message)) facts.body_rejection_class = 'timeout';
        else facts.body_rejection_class = 'other';
        throw cause;
      }
      facts.body_returned = true;
      expect(bytes.byteLength <= limit).toBe(true);
      facts.body_bounded = true;
      const raw = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      // Display field IDs are public hex. Closed decoding and exact text checks cover that DTO.
      if (raw.includes(fixture.owner) || markers.some(marker => raw.includes(marker))
        || (limit === 4096 && /[0-9a-f]{64}/i.test(raw))) faults.private++;
      const value = decodeJson(raw,response.headers()['content-type'],parsed => {
        facts.decoded = true;
        return validator(parsed);
      });
      facts.validated = true;
      // Separators outside strings also detect duplicate keys hidden by JSON.parse.
      const fields = raw.replace(/"(?:\\.|[^"\\])*"/g,'""').split(':').length-1;
      expect(check(value,status,fields)).toBe(true);
      facts.exact = true;
      return value;
    }
    const files = new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    const assets = new Set();
    await context.route('**/*',async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
      else await route.continue(); // Never replace or inspect an API response.
    });
    context.on('request',request => {
      const url = new URL(request.url());
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.private++;
      if (['/assets/client.js','/assets/state.js','/assets/view.js'].includes(url.pathname)) faults.request++;
      if (!url.pathname.startsWith('/v1/')) return;
      if (/\/(history|events|operations)(\/|$)/.test(url.pathname) && !url.pathname.endsWith('/conversation/events')) faults.request++;
      const headers = request.headers();
      if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
        || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      if (request.method() === 'GET') {
        if (url.pathname === '/v1/settings' && url.search === '') network.settings++;
        else if (url.pathname === '/v1/sessions' && url.search === '?limit=32') network.list++;
        else if (/^\/v1\/sessions\/[0-9a-f-]{36}\/conversation(\/events)?$/.test(url.pathname) && reads.length < 16) {
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
        const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
          && value !== '00000000-0000-0000-0000-000000000000';
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
    page = await context.newPage();
    page.on('console',message => { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.private++; });
    page.on('pageerror',() => {faults.page++;});
    const status = page.locator('.topbar [role="status"]');
    const conversation = page.locator('.conversation');
    const transcript = page.getByRole('region',{name:'Canonical conversation',exact:true});
    const taskField = page.getByLabel('Task',{exact:true});
    const sessionButton = slot => page.locator('.session-list button').filter({hasText:slot === 0 ? 'first title' : 'second title'});
    const createCommands = page.locator('.command').filter({has:page.getByRole('heading',{name:/^create:/})});
    const taskCommand = page.locator('.command').filter({has:page.getByRole('heading',{name:/^task:/})});
    async function privateBoundary() {
      const safe = await page.evaluate(async ({owner,markers}) => {
        const dom = document.documentElement.cloneNode(true);
        // Remove only validated public field IDs from this detached privacy clone.
        for (const field of dom.querySelectorAll('[data-field]')) {
          const id = field.getAttribute('data-field');
          if (!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return false;
          field.removeAttribute('data-field');
        }
        const texts = [dom.outerHTML,location.href,JSON.stringify(history.state),
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
      const sessions = [a,b,...(reopened ? [a] : []),...(bReopened ? [b] : [])];
      expect(snapshots.length).toBe(sessions.length);
      expect(reads.length).toBe(sessions.length*2);
      for (const [index,sid] of sessions.entries()) {
        const latest = reads[index*2], stream = reads[index*2+1];
        expect(latest.path === `/v1/sessions/${sid}/conversation` && latest.query.size === 0).toBe(true);
        expect(stream.path === `/v1/sessions/${sid}/conversation/events` && stream.query.size === 1
          && stream.query.get('after') === snapshots[index].live_after).toBe(true);
      }
    }
    async function openSession(slot,sid,head) {
      const facts = replyFacts(); observed.latest.push(facts);
      const [latest] = await Promise.all([
        readReply(page.waitForResponse(response => new URL(response.url()).pathname === `/v1/sessions/${sid}/conversation`
          && new URL(response.url()).search === '' && response.request().method() === 'GET'),facts,
          value => validateConversationPage(value,{kind:'latest'},sid),(value,status,fields) => status === 200
            && fields === JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g,'""').split(':').length-1
            && value.session_id === sid && value.session.session_id === sid && value.session.title === titles[slot]
            && value.session.workspace === workspaces[slot] && value.snapshot_head === head && value.session.head_sequence === head
            && value.live_after === `g11l.${Buffer.from(JSON.stringify([1,sid,head,'3','',''])).toString('base64url')}`
            && value.earlier_activity === null && (head !== '1' || (value.block === null && value.entries.length === 0 && value.previous_block === null)),524288),
        sessionButton(slot).click(),
      ]);
      snapshots.push(latest);
      await exact(status,'connected; observation: streaming');
      return latest;
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
      const [reply] = await Promise.all([
        readReply(page.waitForResponse(response => new URL(response.url()).pathname === '/v1/sessions'
          && response.request().method() === 'POST'),observed.creates[slot],validateCreateView,(value,status,fields) => status === 201
            && fields === 10 && value.receipt.operation_id === creates[slot]?.operation_id && value.session_id === value.receipt.session_id
            && value.receipt.run_id === null && value.receipt.first_sequence === '1' && value.receipt.last_sequence === '1'
            && value.duplicate === false && value.warning_code === null),
        page.getByRole('button',{name:'Create session',exact:true}).click(),
      ]);
      created.push(reply);
      await expect(createCommands).toHaveCount(slot+1);
      await exact(createCommands.nth(slot).locator('h3'),'create: accepted');
      await exact(createCommands.nth(slot).locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${reply.receipt.operation_id}\nSession: ${reply.session_id}\nRun: none\nSequences: 1 to 1\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    }
    const creation = await fixture.inspectMutations();
    expect(creation.session_count === 3 && creation.seed_sessions === 1 && creation.creations.length === 2).toBe(true);
    for (const [slot,c] of creation.creations.entries()) expect(c.exact && c.catalog_current && c.sequence_count === '1'
      && c.rename_events === 0 && c.receipt.operation_id === creates[slot].operation_id
      && isDeepStrictEqual(c.receipt,created[slot].receipt)).toBe(true);
    const [a,b] = creation.creations.map(c => c.receipt.session_id); expect(a !== b).toBe(true);
    stage = 'refresh list and open A';
    await page.getByRole('button',{name:'Refresh list',exact:true}).click();
    await expect(sessionButton(0)).toHaveCount(1); await expect(sessionButton(1)).toHaveCount(1);
    await fixture.request({command:'select',session_id:a}); await openSession(0,a,'1');
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(status,'connected; observation: streaming'); await exact(transcript,'No messages yet.');
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true);

    stage = 'native accepted response held while A runs at model gate one';
    await taskField.fill('Edited before explicit Send'); await taskField.fill(TASK);
    hold = await armReplyLoss(await context.newCDPSession(page),`${fixture.origin}/v1/sessions/${a}/runs`,202);
    delay.armed = true;
    // Register before Send; this waiter receives the unchanged response only after release.
    const acceptedReply = readReply(page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${a}/runs`
      && response.request().method() === 'POST'),observed.task,
      value => validateDisplayTaskAccepted(value,{session_id:a,...submitted}),
      (value,status,fields) => status === 202 && fields === 10 && value.receipt.first_sequence === '2' && value.receipt.last_sequence === '3'
        && value.duplicate === false && value.warning_code === null && value.notices.length === 0);
    // Keep a failed waiter handled until the owned interceptor is released in finally.
    void acceptedReply.catch(() => {});
    await page.getByRole('button',{name:'Send',exact:true}).click();
    expect(await hold.wait()).toBe(202); delay.paused = true;
    await fixture.wait('model_paused',1);
    const committed = await fixture.inspectTask(); const receipt = committed.receipt;
    expect(committed.exact && committed.run_state === 'running' && committed.sequence_count === '6').toBe(true);
    expect(submitted.path === `/v1/sessions/${a}/runs` && receipt.session_id === a
      && receipt.operation_id === submitted.operation_id && receipt.run_id === submitted.run_id).toBe(true);
    provider(await fixture.inspect(),1,0,0);
    await expect(transcript.locator('.run')).toHaveCount(1);
    await exact(transcript.locator('.entry [data-field] pre'),TASK);
    await exact(transcript.locator('.run > .metadata'),'Execution: running. Final result not recorded.');
    await exact(taskCommand.locator('h3'),'task: sending');
    await exact(taskCommand.locator('.metadata'),`Operation: ${receipt.operation_id}\nSession: ${a}`);
    await exact(taskCommand.locator(':scope > pre'),'');
    expect(!observed.task.acquired && !delay.released).toBe(true);

    stage = 'actual session-list switch retires A display';
    await openSession(1,b,'1');
    async function bTruth(expectedDraft) {
      await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[1]);
      await exact(conversation.locator(':scope > .metadata'),`Workspace: ${workspaces[1]}\nSession: ${b}`);
      await exact(transcript,'No messages yet.'); await exact(status,'connected; observation: streaming');
      expect(new URL(page.url()).hash === `#session=${b}`).toBe(true);
      expect(await conversation.locator('.run,.command').count()).toBe(0);
      expect(await conversation.getByRole('button',{name:/Read run status|Retry identical command|Reconcile receipt/}).count()).toBe(0);
      await expect(page.getByRole('button',{name:'Cancel current run',exact:true})).toBeDisabled();
      expect(await taskField.inputValue() === expectedDraft).toBe(true);
      await privateBoundary();
    }
    await bTruth('');
    // The global command belongs to A, not B's selected conversation.
    await exact(taskCommand.locator('.metadata'),`Operation: ${receipt.operation_id}\nSession: ${a}`);
    await exact(taskCommand.locator('h3'),'task: sending');
    expect(await page.getByRole('button',{name:'Retry identical command',exact:true}).count()).toBe(0);
    await taskField.fill(DRAFT); await bTruth(DRAFT);

    stage = 'release the same real A response after B is fully selected';
    await hold.stop(); delay.released = true; cleanup.interceptor = true;
    const accepted = await acceptedReply;
    expect(isDeepStrictEqual(accepted.receipt,receipt)).toBe(true);
    stage = 'actual A receipt remains global and B stays unchanged';
    await expect(page.locator('.command')).toHaveCount(3);
    await exact(taskCommand.locator('h3'),'task: accepted');
    await exact(taskCommand.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${a}\nRun: ${receipt.run_id}\nSequences: 2 to 3\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    await taskCommand.locator('summary').click(); await exact(taskCommand.locator('details pre'),TASK);
    await expect(taskCommand.getByRole('button',{name:'Retry identical command',exact:true})).toBeHidden();
    await expect(taskCommand.getByRole('button',{name:'Reconcile receipt (read only)',exact:true})).toBeVisible();
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
    readAccounting(a,b,false);

    stage = 'reopen A through UI with completed supplied display';
    const latest = await openSession(0,a,'20');
    expect(latest.block?.run_id === receipt.run_id && latest.block.accepted_sequence === '2'
      && latest.block.state === 'completed' && latest.block.result_recorded && latest.block.outcome?.type === 'completed'
      && latest.block.events_complete && latest.block.sink_error === null && latest.entries.length === 3).toBe(true);
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(status,'connected; observation: streaming');
    const run = transcript.locator('.run'); await expect(run).toHaveCount(1);
    await expect(run).toHaveAttribute('data-run',receipt.run_id);
    await exact(run.locator(':scope > .metadata'),'Execution: completed. Final result recorded.');
    const rows = run.locator('.entry');
    await expect(rows.locator(':scope > h4')).toHaveText(['Human','assistant','tool','assistant']);
    const supplied = [latest.block.human,...latest.entries];
    const fields = [[TASK],['add_numbers',ARGUMENTS],['add_numbers',OUTPUT],[ANSWER]];
    expect(supplied.map(row => row.entry_id)).toEqual(['e:2:0','e:7:0','e:9:0','e:14:0']);
    for (const [index,row] of supplied.entries()) {
      await expect(rows.nth(index)).toHaveAttribute('data-entry',row.entry_id);
      expect(row.content_complete && row.earlier_content === null && row.reference === null && !row.provisional
        && row.recorded_state === (index === 0 ? 'accepted' : 'completed')).toBe(true);
      expect(JSON.stringify(row.fields.map(field => field.text)) === JSON.stringify(fields[index])).toBe(true);
      expect(await rows.nth(index).locator('[data-field] pre').evaluateAll(nodes => nodes.map(node => node.textContent))
        .then(text => JSON.stringify(text) === JSON.stringify(fields[index]))).toBe(true);
      for (const [fieldIndex,field] of row.fields.entries()) {
        await expect(rows.nth(index).locator('[data-field]').nth(fieldIndex)).toHaveAttribute('data-field',field.field_id);
        expect(field.from_byte === '0' && field.to_byte === field.total_bytes && field.total_bytes === String(Buffer.byteLength(field.text))
          && !field.has_earlier && !field.has_later).toBe(true);
      }
      const extra = index === 2 ? '; result_recorded: true; finish_recorded: true; is_error: false' : '';
      await exact(rows.nth(index).locator(':scope > .metadata').first(),`Recorded state: ${row.recorded_state}; Provisional: false${extra}`);
    }
    expect(latest.entries[1].result_recorded && latest.entries[1].finish_recorded && latest.entries[1].is_error === false).toBe(true);
    for (const text of [TASK,ANSWER,ARGUMENTS,OUTPUT]) await occurrences(run,text,1);
    const recording = run.locator(':scope > details > pre');
    expect(latest.block.summary !== null && latest.block.summary.turns_started === '2' && latest.block.summary.turns_finished === '2'
      && latest.block.summary.model_requests_attempted === '2' && latest.block.summary.model_requests_admitted === '2'
      && latest.block.summary.new_tool_dispatches === '1' && latest.block.summary.tool_results_prepared === '1'
      && latest.block.summary.reused_results === '0' && latest.block.summary.last_upstream_outcome === 'terminal_received').toBe(true);
    await exact(recording,`Run: ${receipt.run_id}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\n${Object.entries(latest.block.summary).map(([key,value]) => `${key}: ${value ?? 'none'}`).join('\n')}`);
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true); expect(await taskField.inputValue() === '').toBe(true);
    await page.waitForTimeout(500); provider(await fixture.inspect(),2,1,1); readAccounting(a,b,true); await privateBoundary();
    await expect(page.locator('.command')).toHaveCount(3);
    expect(assets.size).toBe(files.size);
    expect(await page.evaluate(checkEmbeddedAssets,{secrets:markers,
      files:await Promise.all([...files].map(async ([path,file]) => [path,[...await readFile(new URL(`../${file}`,import.meta.url))]]))})).toEqual({checked:9,failures:[]});

    stage = 'B reopened through Latest and display SSE remains head one';
    await openSession(1,b,'1'); await bTruth('');
    await page.waitForTimeout(500); await bTruth('');
    provider(await fixture.inspect(),2,1,1); readAccounting(a,b,true,true);
    await expect(page.locator('.command')).toHaveCount(3);
    await exact(taskCommand.locator('h3'),'task: accepted');

    stage = 'Disconnect clears memory and DOM without cancellation';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click(); await exact(status,'disconnected');
    await exact(page.locator('.transcript'),'');
    expect(await page.evaluate(canaries => !canaries.some(text => document.documentElement.outerHTML.includes(text)),
      [TASK,ANSWER,ARGUMENTS,OUTPUT,DRAFT,...titles])).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
    await privateBoundary(); provider(await fixture.inspect(),2,1,1); readAccounting(a,b,true,true);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
    expect([...observed.creates,observed.task,...observed.latest].every(facts => facts.exact)).toBe(true);
  } catch (cause) {
    // Never forward assertions, DOM, wire identities, input arguments or raw exceptions to Playwright.
    const kind = ['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-selection-epoch\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Selection epoch failed: ${stage}; kind=${kind} line=${line}; capture=${JSON.stringify(observed)}; delay=${JSON.stringify(delay)}; faults=${JSON.stringify(faults)}; network=${JSON.stringify(network)}`);
  } finally {
    // Release the native reply independently before retiring browser and fixture ownership.
    try { await hold?.stop(); cleanup.interceptor = hold !== undefined; } catch { failure ??= new Error('Selection epoch interceptor cleanup failed'); }
    try { await context?.close(); cleanup.browser = context !== undefined; } catch { failure ??= new Error('Selection epoch browser cleanup failed'); }
    // A failed close leaves the context visible to Playwright's failure recorder.
    if (cleanup.browser) {
      if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
    }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; } catch { failure ??= new Error('Selection epoch fixture cleanup failed'); }
  }
  console.log(`Selection epoch cleanup: interceptor=${cleanup.interceptor} browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  console.log(`Selection epoch evidence: contexts=1 creates=2 task_posts=1 held_native_202=${delay.paused} released_same_reply=${delay.released} A_running=6 B_head=1 A_final=20 chronological_activity=3 persistent_commands=3 matching_latest_streams=4 assets=9 provider_connections=1 provider_requests=2 tools=1 results=1 cancel_retry_reconcile_other=0 stable_B_ms=500 stable_A_ms=500 stable_B_reopen_ms=500; replies=${JSON.stringify(observed)}`);
});
