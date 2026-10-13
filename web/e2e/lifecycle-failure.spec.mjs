import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted, validateTaskReconciliation } from '../dist/display-api.js';

const data=JSON.parse(await readFile(new URL('../test-support/lifecycle-failure.json',import.meta.url),'utf8'));
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

// Rebase replaces the retired raw-history reload; the native producer and rollback audit stay real.
test('native WS partial failure survives final-result rollback and read-only display rebase',async ({browser}) => {
  const previousNoCopyPrompt=process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;let context;let failure;let stage='startup';
  let check='outside';let entryIndex=null;
  const checkpointChecks=['outside','status','run-count','run-identity','execution','headings','entry-ids-read','entry-ids',
    'entry-metadata','entry-fields','tool-open','tool-click','tool-visible','tool-output','task-occurrences','argument-occurrences',
    'output-occurrences','partial-occurrences','request-id-read','request-id','recording','storage-error-absent','reconcile-action',
    'reconcile-reply','reconcile-acceptance','reconcile-run','run-view','task-state','task-body','task-receipt','privacy','parity-dom'];
  const cleanup={context:false,fixture:false};
  const faults={external:0,request:0,response:0,console:0,page:0,private:0};
  const posts={create:0,task:0,reconcile:0,other:0};
  const observed={latest:0,streams:0,receipts:0,reads:0,verified:0};
  try {
    fixture=await startFixture(executable,{transport:'websocket',recovered:false,mime:true,lifecycle_failure:true});
    process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';
    context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',async route => {
      if(new URL(route.request().url()).origin !== fixture.origin){faults.external++;await route.abort();}
      else await route.continue();
    });
    const markers=['synthetic-replay-','synthetic-account-','private-operator-','private-project-','private-skill-',
      'private-native','private-data','private-skills','principal_digest','history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'];
    const leaked=text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
    const uuid=value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
      && value !== '00000000-0000-0000-0000-000000000000';
    const requests=[];const displayReads=[];const assetReads=[];const assets=new Set();
    const files=new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    let createCommand;let command;let receipt;let sid;let finalOperation;
    context.on('request',request => {
      const url=new URL(request.url()), method=request.method();
      requests.push({method,path:url.pathname,search:url.search});
      if(url.origin !== fixture.origin)faults.external++;
      if(leaked(request.url()))faults.private++;
      if(url.pathname.startsWith('/v1/')) {
        const headers=request.headers();
        if(headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
          || (headers.origin !== undefined && headers.origin !== fixture.origin))faults.request++;
        const allowed=method === 'GET' && (url.pathname === '/v1/settings' || url.pathname === '/v1/sessions'
          || url.pathname === `/v1/sessions/${sid}/conversation` || url.pathname === `/v1/sessions/${sid}/conversation/events`)
          || method === 'POST' && (url.pathname === '/v1/sessions' || url.pathname === `/v1/sessions/${sid}/runs`
            || url.pathname === `/v1/sessions/${sid}/runs/reconcile`);
        if(!allowed)faults.request++;
      } else if(method !== 'GET' || !files.has(url.pathname) || url.search !== '')faults.request++;
      if(method === 'GET' && url.pathname.endsWith('/conversation')) {
        displayReads.push({kind:'latest',head:observed.latest === 0 ? '1' : '19',matching:url.search === ''});
      }
      if(method === 'GET' && url.pathname.endsWith('/conversation/events')) {
        const head=observed.streams++ === 0 ? '1' : '19';
        const after=`g11l.${Buffer.from(JSON.stringify([1,sid,head,'3','',''])).toString('base64url')}`;
        displayReads.push({kind:'events',head,matching: url.search === `?after=${encodeURIComponent(after)}`});
      }
      if(method === 'POST') {
        try {
          const body=request.postDataJSON();
          if(url.pathname === '/v1/sessions') {
            posts.create++;
            if(createCommand !== undefined || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
              || !uuid(body.operation_id) || body.title !== data.title || typeof body.workspace !== 'string')faults.request++;
            else createCommand=body;
          } else if(url.pathname.endsWith('/runs')) {
            posts.task++;
            if(command !== undefined || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
              || !uuid(body.operation_id) || !uuid(body.run_id) || body.text !== data.task)faults.request++;
            else command=body;
          } else if(url.pathname.endsWith('/runs/reconcile')) {
            posts.reconcile++;
            if(command === undefined || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
              || !uuid(body.operation_id) || !uuid(body.run_id) || JSON.stringify(body) !== JSON.stringify(command))faults.request++;
          } else posts.other++;
        } catch {faults.request++;}
      }
    });
    context.on('response',response => {
      if(response.status() >= 300)faults.response++;
      const file=files.get(new URL(response.url()).pathname);
      if(file === undefined)return;
      assetReads.push((async () => {
        const bytes=await response.body();
        if(response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file}`,import.meta.url))))faults.response++;
        if(leaked(bytes.toString('utf8')))faults.private++;
        assets.add(new URL(response.url()).pathname);
      })().catch(() => {faults.response++;}));
    });
    const page=await context.newPage();
    page.on('console',message => {faults.console++;if(leaked(message.text()) || leaked(message.location().url))faults.private++;});
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    const transcript=page.getByRole('region',{name:'Canonical conversation',exact:true});
    const taskArticle=page.locator('.command').filter({has:page.getByRole('heading',{name:/^task:/})});
    async function readReply(response,statusCode,validate,limit=512*1024) {
      expect(response.status() === statusCode).toBe(true);
      const bytes=await response.body();expect(bytes.length <= limit).toBe(true);
      return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),response.headers()['content-type'],validate);
    }
    async function boundary() {
      const safe=await page.evaluate(async ({owner,markers}) => {
        const dom=document.documentElement.cloneNode(true);
        // Only public field IDs are exempt. Scan every other DOM byte for private data.
        for(const field of dom.querySelectorAll('[data-field]')) {
          const id=field.getAttribute('data-field');
          if(!/^(text|[0-9a-f]{64})$/.test(id) || id === owner)return false;
          field.removeAttribute('data-field');
        }
        const values=[dom.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return globalThis.lifecycleCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0
          && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run img,.run svg,.run em,.run script,.run a,img,iframe').count()).toBe(0);
    }
    function audit(proof) {
      expect(proof.exact && proof.retired && proof.prior_unchanged && proof.hits === 1 && proof.sequence_count === '19'
        && proof.connections === 1 && proof.requests === 2 && proof.dispatches === 1 && proof.prepared_results === 1
        && proof.result_rows === 1 && proof.reused === 0 && proof.session_id === sid && proof.run_id === command.run_id
        && proof.operation_id === command.operation_id && proof.final_operation_id === finalOperation).toBe(true);
    }
    async function checkpoint(number) {
      const failed=number >= 3, execution=failed ? 'failed' : 'running';
      stage=`checkpoint ${number} display`;entryIndex=null;
      check='status';await exact(status,'connected; observation: streaming');
      const run=transcript.locator('.run');check='run-count';expect(await run.count()).toBe(1);
      check='run-identity';expect(await run.getAttribute('data-run') === command.run_id).toBe(true);
      check='execution';await exact(run.locator(':scope > .metadata'),`Execution: ${execution}. Final result not recorded.`);
      const headings=number === 1 ? ['Human','assistant','tool'] : ['Human','assistant','tool','assistant'];
      check='headings';await expect.poll(async () => isDeepStrictEqual(await run.locator('.entry > h4').allTextContents(),headings)).toBe(true);
      check='entry-ids-read';const ids=await run.locator('.entry').evaluateAll(nodes => nodes.map(node => node.dataset.entry));
      check='entry-ids';expect(JSON.stringify(ids) === JSON.stringify(number === 1 ? ['e:2:0','e:7:0','e:9:0'] : ['e:2:0','e:7:0','e:9:0','e:14:0'])).toBe(true);
      const entries=run.locator('.entry');
      const states=['Recorded state: accepted; Provisional: false','Recorded state: completed; Provisional: false',
        'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false'];
      const fields=[[data.task],['add_numbers',data.arguments],['add_numbers',data.output]];
      if(number >= 2) {
        states.push(`Recorded state: ${failed ? 'failed' : 'in_progress'}; Provisional: true`);
        fields.push(failed ? ['Request failed',data.partial] : [data.partial]);
      }
      for(let index=0;index<states.length;index++) {
        entryIndex=index;
        check='entry-metadata';await exact(entries.nth(index).locator(':scope > .metadata').first(),states[index]);
        // A response heading can arrive before its fields. Wait for the same exact ordered bytes.
        check='entry-fields';await expect.poll(async () => JSON.stringify(await entries.nth(index).locator('[data-field] pre').allTextContents()) === JSON.stringify(fields[index])).toBe(true);
      }
      entryIndex=null;
      const tool=entries.nth(2).locator('details[data-field]').filter({has:page.getByText('tool_result',{exact:true})});
      check='tool-open';if(!(await tool.evaluate(node => node.open))) {check='tool-click';await tool.locator('summary').click();}
      check='tool-visible';await expect(tool.locator('pre')).toBeVisible();check='tool-output';await exact(tool.locator('pre'),data.output);
      check='task-occurrences';await occurrences(run,data.task,1);check='argument-occurrences';await occurrences(run,data.arguments,1);check='output-occurrences';await occurrences(run,data.output,1);
      check='partial-occurrences';await occurrences(run,data.partial,number === 1 ? 0 : 1);
      const recording=run.locator(':scope > details > pre');
      let details=`Run: ${command.run_id}\nAccepted sequence: ${receipt.first_sequence}\nOutcome: not recorded\nEvents complete: not recorded\nSink error: none\nSummary not recorded.`;
      if(failed) {
        check='request-id-read';const requestId=(await recording.textContent()).split('\n').find(line => line.startsWith('last_request_id: '))?.slice('last_request_id: '.length);
        check='request-id';expect(uuid(requestId)).toBe(true);
        details=`Run: ${command.run_id}\nAccepted sequence: ${receipt.first_sequence}\nOutcome: failed\nCode: provider_request_failed\nEvents complete: not recorded\nSink error: none\nturns_started: 2\nturns_finished: 2\nmodel_requests_attempted: 2\nmodel_requests_admitted: 2\nnew_tool_dispatches: 1\ntool_results_prepared: 1\nreused_results: 0\nlast_request_id: ${requestId}\nlast_upstream_outcome: unknown`;
      }
      check='recording';await exact(recording,details);
      check='storage-error-absent';expect(!(await run.textContent()).includes('storage.io')).toBe(true);
      stage=`checkpoint ${number} read-only reconcile`;
      // This public action supplies RunView through addressed reconciliation, not raw GET or receipt-range reconstruction.
      check='reconcile-action';const [reply]=await Promise.all([
        page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs/reconcile` && response.request().method() === 'POST'),
        taskArticle.getByRole('button',{name:'Reconcile receipt (read only)',exact:true}).click(),
      ]);
      check='reconcile-reply';const value=await readReply(reply,200,v => validateTaskReconciliation(v,{...command,session_id:sid}),4096);
      observed.reads++;
      check='reconcile-acceptance';expect(value.state === 'accepted' && isDeepStrictEqual(value.acceptance,receipt)).toBe(true);
      check='reconcile-run';expect(isDeepStrictEqual(value.run,{api_version:1,run_id:command.run_id,state:execution,user_text:data.task,
        accepted_sequence:'2',terminal_sequence:failed ? '19' : null,result_sequence:null,result_recorded:false,result:null})).toBe(true);
      check='run-view';await exact(page.locator('.conversation > div > pre.metadata'),`Read-only run view: ${command.run_id}\nExecution: ${execution}\nResult recorded: false\nTerminal sequence: ${failed ? '19' : 'none'}\nResult sequence: none`);
      check='task-state';await exact(taskArticle.locator('h3'),'task: accepted');
      check='task-body';await exact(taskArticle.locator('details pre'),data.task);
      check='task-receipt';await exact(taskArticle.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nWarning: none; duplicate: false\n\nReconciliation: accepted\n\nAccepted is not completed.`);
      check='privacy';await boundary();observed.verified++;
      // Disclosure openness is local presentation state, not canonical display content.
      check='parity-dom';return run.evaluate(node => {const clone=node.cloneNode(true);for(const details of clone.querySelectorAll('details'))details.removeAttribute('open');return clone.outerHTML;});
    }
    stage='connect and fresh selection';
    await page.goto(`${fixture.origin}/`);await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.getByRole('button',{name:'Connect',exact:true}).click();await exact(status,'connected');
    expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    await page.getByLabel('Title',{exact:true}).fill(data.title);
    const [createdResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions` && response.request().method() === 'POST'),
      page.getByRole('button',{name:'Create session',exact:true}).click(),
    ]);
    const created=await readReply(createdResponse,201,validateCreateView,4096);sid=created.session_id;
    expect(uuid(sid) && created.receipt.operation_id === createCommand.operation_id && created.receipt.session_id === sid
      && created.receipt.run_id === null && !created.duplicate && created.warning_code === null).toBe(true);
    const [initialResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/conversation` && response.request().method() === 'GET'),
      page.getByRole('button',{name:'Open receipt session',exact:true}).click(),
    ]);
    const initial=await readReply(initialResponse,200,validateConversationPage);observed.latest++;
    expect(initial.session_id === sid && initial.snapshot_head === '1' && initial.block === null && initial.entries.length === 0).toBe(true);
    await exact(transcript,'No messages yet.');await exact(status,'connected; observation: streaming');
    expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    await fixture.request({command:'select',session_id:sid});await fixture.request({command:'arm_lifecycle_failure'});
    stage='one explicit submission';
    await page.getByLabel('Task',{exact:true}).fill(data.task);
    const [acceptedResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'),
      page.getByRole('button',{name:'Send',exact:true}).click(),
    ]);
    const accepted=await readReply(acceptedResponse,202,v => validateDisplayTaskAccepted(v,{...command,session_id:sid}),4096);
    receipt=accepted.receipt;observed.receipts++;
    expect(!accepted.duplicate && accepted.warning_code === null && accepted.notices.length === 0
      && new Set([sid,createCommand.operation_id,command.operation_id,command.run_id]).size === 4).toBe(true);
    await fixture.wait('model_paused',1);await checkpoint(1);check='outside';
    await fixture.request({command:'drive',gate:1});await fixture.wait('model_paused',2);await checkpoint(2);check='outside';
    await fixture.request({command:'drive',gate:2});stage='distinct final append pause';
    const paused=await fixture.request({command:'wait_lifecycle_failure',session_id:sid,run_id:command.run_id,operation_id:command.operation_id});
    finalOperation=paused.final_operation_id;
    expect(paused.hits === 1 && paused.exact && uuid(finalOperation) && finalOperation !== command.operation_id).toBe(true);
    await fixture.request({command:'release_lifecycle_failure',final_operation_id:finalOperation});
    audit(await fixture.request({command:'inspect_lifecycle_failure'}));
    const settled=await checkpoint(3);check='outside';
    stage='read-only latest display rebase';
    const [reloadedResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/conversation` && response.request().method() === 'GET'),
      page.getByRole('button',{name:'Reconnect latest',exact:true}).click(),
    ]);
    const reloaded=await readReply(reloadedResponse,200,validateConversationPage);observed.latest++;
    expect(reloaded.session_id === sid && reloaded.snapshot_head === '19' && reloaded.block.run_id === command.run_id
      && reloaded.block.state === 'failed' && !reloaded.block.result_recorded && reloaded.block.events_complete === null
      && reloaded.block.sink_error === null && reloaded.block.human.entry_id === 'e:2:0').toBe(true);
    const liveAfter=`g11l.${Buffer.from(JSON.stringify([1,sid,'19','3','',''])).toString('base64url')}`;
    expect(reloaded.live_after === liveAfter && initial.live_after === `g11l.${Buffer.from(JSON.stringify([1,sid,'1','3','',''])).toString('base64url')}`).toBe(true);
    const rebased=await checkpoint(4);check='outside';expect(rebased === settled).toBe(true);
    audit(await fixture.request({command:'inspect_lifecycle_failure'}));
    await Promise.all(assetReads);
    expect([...assets].sort()).toEqual([...files.keys()].sort());
    expect(displayReads).toEqual([{kind:'latest',head:'1',matching:true},{kind:'events',head:'1',matching:true},
      {kind:'latest',head:'19',matching:true},{kind:'events',head:'19',matching:true}]);
    const getCounts=requests.filter(request => request.method === 'GET').map(request => request.path);
    expect(getCounts.length === 15 && getCounts.filter(path => path === '/v1/settings').length === 1
      && getCounts.filter(path => path === '/v1/sessions').length === 1
      && getCounts.filter(path => path.endsWith('/conversation')).length === 2
      && getCounts.filter(path => path.endsWith('/conversation/events')).length === 2).toBe(true);
    expect(posts).toEqual({create:1,task:1,reconcile:4,other:0});
    expect(observed).toEqual({latest:2,streams:2,receipts:1,reads:4,verified:4});
    stage='disconnect and privacy';
    const requestCount=requests.length;
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    expect(await page.getByLabel('Task',{exact:true}).inputValue() === '').toBe(true);
    await boundary();expect(requests.length === requestCount).toBe(true);
    expect(posts).toEqual({create:1,task:1,reconcile:4,other:0});expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch(cause) {
    const kind=['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const safeCheck=typeof check === 'string' && checkpointChecks.includes(check) ? check : 'other';
    const safeEntry=entryIndex === null ? 'none' : Number.isInteger(entryIndex) && entryIndex >= 0 && entryIndex < 4
      && ['entry-metadata','entry-fields'].includes(safeCheck) ? entryIndex : 'other';
    failure=new Error(`Lifecycle failure failed: ${stage}; kind=${kind}; check=${safeCheck}; entry=${safeEntry}; capture=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {await context?.close();cleanup.context=context !== undefined;} catch {failure ??= new Error('Lifecycle failure browser cleanup failed');}
    // A failed close can still expose the context to Playwright. Retain its privacy guard.
    if(cleanup.context) {
      if(previousNoCopyPrompt === undefined)delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT=previousNoCopyPrompt;
    }
    try {await fixture?.stop();cleanup.fixture=fixture !== undefined;} catch {failure ??= new Error('Lifecycle failure fixture cleanup failed');}
  }
  console.log(`Lifecycle failure cleanup: context=${cleanup.context} fixture=${cleanup.fixture}`);
  if(failure)throw failure;
  console.log('Lifecycle failure evidence: task_posts=1 connections=1 requests=2 dispatches=1 prepared=1 reuse=0 final_pause=1 result_records=0 rebases=1 reconcile_reads=4');
});
