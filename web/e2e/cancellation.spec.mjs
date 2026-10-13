import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { decodeJson, validateCancelView, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted, validateTaskReconciliation } from '../dist/display-api.js';

const data=JSON.parse(await readFile(new URL('../test-support/cancellation.json',import.meta.url),'utf8'));
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

test('one explicit Cancel retains running truth until native cancellation commits and survives read-only display rebase',async ({browser}) => {
  const previousNoCopyPrompt=process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;let context;let failure;let stage='startup';let identity;let terminal;
  const cleanup={context:false,fixture:false};
  const faults={external:0,request:0,response:0,console:0,page:0,private:0};
  const posts={create:0,task:0,cancel:0,reconcile:0,other:0};
  const observed={latest:0,streams:0,receipts:0,cancels:0,reads:0,verified:0};
  try {
    fixture=await startFixture(executable,{transport:'websocket',recovered:false,mime:true,cancellation:true});
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
    let createCommand;let command;let receipt;let sid;let runView;
    context.on('request',request => {
      try {
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
              || url.pathname === `/v1/sessions/${sid}/runs/reconcile` || url.pathname === `/v1/sessions/${sid}/runs/${command?.run_id}/cancel`);
          if(!allowed)faults.request++;
        } else if(method !== 'GET' || !files.has(url.pathname) || url.search !== '')faults.request++;
        if(method === 'GET' && url.pathname.endsWith('/conversation')) {
          displayReads.push({kind:'latest',head:observed.latest === 0 ? '1' : '9',matching:url.search === ''});
        }
        if(method === 'GET' && url.pathname.endsWith('/conversation/events')) {
          const head=observed.streams++ === 0 ? '1' : '9';
          const after=`g11l.${Buffer.from(JSON.stringify([1,sid,head,'3','',''])).toString('base64url')}`;
          displayReads.push({kind:'events',head,matching:url.search === `?after=${encodeURIComponent(after)}`});
        }
        if(method === 'POST') {
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
              || JSON.stringify(body) !== JSON.stringify(command) || url.search !== '')faults.request++;
          } else if(url.pathname.endsWith('/cancel')) {
            posts.cancel++;
            if(!identity || url.pathname !== `/v1/sessions/${identity.session_id}/runs/${identity.run_id}/cancel`
              || url.search !== '' || request.postData() !== '{}')faults.request++;
          } else posts.other++;
        }
      } catch {faults.request++;}
    });
    context.on('response',response => {
      try {
        if(response.status() >= 300)faults.response++;
        const file=files.get(new URL(response.url()).pathname);
        if(file === undefined)return;
        assetReads.push((async () => {
          const bytes=await response.body();
          if(response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file}`,import.meta.url))))faults.response++;
          if(leaked(bytes.toString('utf8')))faults.private++;
          assets.add(new URL(response.url()).pathname);
        })().catch(() => {faults.response++;}));
      } catch {faults.response++;}
    });
    const page=await context.newPage();
    page.on('console',message => {try {faults.console++;if(leaked(message.text()) || leaked(message.location().url))faults.private++;} catch {faults.private++;}});
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    const transcript=page.getByRole('region',{name:'Canonical conversation',exact:true});
    const taskArticle=page.locator('.command').filter({has:page.getByRole('heading',{name:/^task:/})});
    const readView=page.locator('.conversation > div > pre.metadata');
    const cancelReply=page.locator('p').filter({hasText:'Cancel disposition:'});
    async function readReply(response,statusCode,validate,limit=512*1024) {
      expect(response.status() === statusCode).toBe(true);
      const bytes=await response.body();expect(bytes.length <= limit).toBe(true);
      return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),response.headers()['content-type'],validate);
    }
    async function boundary() {
      const safe=await page.evaluate(async ({owner,markers}) => {
        const dom=document.documentElement.cloneNode(true);
        // Exempt only validated public field IDs in the detached clone, never other hashes or live DOM.
        for(const field of dom.querySelectorAll('[data-field]')) {
          const id=field.getAttribute('data-field');
          if(!/^(text|[0-9a-f]{64})$/.test(id) || id === owner)return false;
          field.removeAttribute('data-field');
        }
        const values=[dom.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return globalThis.cancellationCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0
          && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run img,.run svg,.run em,.run script,.run a,img,iframe').count()).toBe(0);
    }
    function audit(proof) {
      expect(proof.exact && proof.retired && proof.prefix_unchanged && proof.hits === 1 && proof.sequence_count === '9'
        && proof.connections === 1 && proof.requests === 1 && proof.closed && proof.dispatches === 0
        && proof.prepared_results === 0 && proof.reused === 0 && proof.result_records === 1
        && proof.session_id === identity.session_id && proof.run_id === identity.run_id
        && proof.operation_id === identity.operation_id && proof.terminal_operation_id === terminal).toBe(true);
    }
    async function checkpoint(number) {
      const cancelled=number >= 3, execution=cancelled ? 'cancelled_locally' : 'running';
      stage=`checkpoint ${number} display`;
      await exact(status,'connected; observation: streaming');
      await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),data.title);
      const run=transcript.locator('.run');expect(await run.count()).toBe(1);
      expect(await run.getAttribute('data-run') === command.run_id).toBe(true);
      await exact(run.locator(':scope > .metadata'),`Execution: ${execution}. Final result ${cancelled ? 'recorded' : 'not recorded'}.`);
      expect(isDeepStrictEqual(await run.locator('.entry > h4').allTextContents(),['Human'])).toBe(true);
      expect(isDeepStrictEqual(await run.locator('.entry').evaluateAll(nodes => nodes.map(node => node.dataset.entry)),['e:2:0'])).toBe(true);
      await exact(run.locator('.entry > .metadata').first(),'Recorded state: accepted; Provisional: false');
      expect(isDeepStrictEqual(await run.locator('[data-field] pre').allTextContents(),[data.task])).toBe(true);
      await occurrences(run,data.task,1);
      // H7 holds the session mutex. Keep the H6 public RunView and make no additional read here.
      if(number !== 2) {
        const [reply]=await Promise.all([
          page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs/reconcile` && response.request().method() === 'POST'),
          taskArticle.getByRole('button',{name:'Reconcile receipt (read only)',exact:true}).click(),
        ]);
        const value=await readReply(reply,200,v => validateTaskReconciliation(v,{...command,session_id:sid}),4096);
        observed.reads++;
        expect(value.state === 'accepted' && isDeepStrictEqual(value.acceptance,receipt)).toBe(true);
        runView=value.run;
      }
      let result=null;
      if(cancelled) {
        const requestId=runView.result.summary.last_request_id;
        expect(uuid(requestId)).toBe(true);
        result={outcome:{type:'cancelled_locally'},summary:{turns_started:'1',turns_finished:'1',model_requests_attempted:'1',model_requests_admitted:'1',
          new_tool_dispatches:'0',tool_results_prepared:'0',reused_results:'0',last_request_id:requestId,last_upstream_outcome:'unknown'},events_complete:true,sink_error:null};
        await expect(page.getByRole('button',{name:'Cancel current run',exact:true})).toBeDisabled();
      } else await expect(page.getByRole('button',{name:'Cancel current run',exact:true})).toBeEnabled();
      expect(isDeepStrictEqual(runView,{api_version:1,run_id:command.run_id,state:execution,user_text:data.task,
        accepted_sequence:'2',terminal_sequence:cancelled ? '8' : null,result_sequence:cancelled ? '9' : null,result_recorded:cancelled,result})).toBe(true);
      await exact(readView,`Read-only run view: ${command.run_id}\nExecution: ${execution}\nResult recorded: ${cancelled}\nTerminal sequence: ${cancelled ? '8' : 'none'}\nResult sequence: ${cancelled ? '9' : 'none'}`);
      const details=[`Run: ${command.run_id}`,'Accepted sequence: 2',`Outcome: ${result?.outcome.type ?? 'not recorded'}`,
        `Events complete: ${result?.events_complete ?? 'not recorded'}`,'Sink error: none',
        result === null ? 'Summary not recorded.' : Object.entries(result.summary).map(([key,value]) => `${key}: ${value}`).join('\n')].join('\n');
      await exact(run.locator(':scope > details > pre'),details);
      if(number === 2 || number === 3)await exact(cancelReply,'Cancel disposition: requested. Signal only, not terminal truth.');
      await exact(taskArticle.locator('h3'),'task: accepted');await exact(taskArticle.locator('details pre'),data.task);
      await exact(taskArticle.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nWarning: none; duplicate: false\n\nReconciliation: accepted\n\nAccepted is not completed.`);
      await boundary();observed.verified++;
      // Disclosure openness is the only local presentation state omitted from fixed-H parity.
      return run.evaluate(node => {const clone=node.cloneNode(true);for(const details of clone.querySelectorAll('details'))details.removeAttribute('open');return clone.outerHTML;});
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
    await fixture.request({command:'select',session_id:sid});await fixture.request({command:'arm_cancellation'});
    stage='one explicit task and pre-cancel running RunView';
    await page.getByLabel('Task',{exact:true}).fill(data.task);
    const [acceptedResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'),
      page.getByRole('button',{name:'Send',exact:true}).click(),
    ]);
    const accepted=await readReply(acceptedResponse,202,v => validateDisplayTaskAccepted(v,{...command,session_id:sid}),4096);
    receipt=accepted.receipt;observed.receipts++;
    expect(!accepted.duplicate && accepted.warning_code === null && accepted.notices.length === 0
      && new Set([sid,createCommand.operation_id,command.operation_id,command.run_id]).size === 4).toBe(true);
    identity={session_id:sid,run_id:command.run_id,operation_id:command.operation_id};
    const pending=await fixture.request({command:'wait_cancellation_pending',...identity});
    expect(pending.exact && pending.sequence_count === '6' && pending.connections === 1 && pending.requests === 1 && !pending.closed
      && pending.session_id === sid && pending.run_id === command.run_id && pending.operation_id === command.operation_id).toBe(true);
    await checkpoint(1);
    stage='one explicit Cancel and independent uncommitted terminal snapshot';
    const [cancelResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/runs/${command.run_id}/cancel` && response.request().method() === 'POST'),
      page.getByRole('button',{name:'Cancel current run',exact:true}).click(),
    ]);
    const cancel=await readReply(cancelResponse,202,validateCancelView,4096);observed.cancels++;
    expect(isDeepStrictEqual(cancel,{api_version:1,session_id:sid,run_id:command.run_id,disposition:'requested'})).toBe(true);
    const paused=await fixture.request({command:'wait_cancellation'});terminal=paused.terminal_operation_id;
    expect(paused.exact && paused.sequence_count === '7' && paused.hits === 1 && paused.closed && paused.connections === 1 && paused.requests === 1
      && paused.session_id === sid && paused.run_id === command.run_id && paused.operation_id === command.operation_id
      && uuid(terminal) && terminal !== command.operation_id).toBe(true);
    const beforePaused=requests.length;
    await checkpoint(2);expect(requests.length === beforePaused && posts.reconcile === 1).toBe(true);
    expect(posts).toEqual({create:1,task:1,cancel:1,reconcile:1,other:0});
    stage='release terminal and wait for worker retirement';
    await fixture.request({command:'release_cancellation',terminal_operation_id:terminal});
    audit(await fixture.request({command:'inspect_cancellation'}));
    const settled=await checkpoint(3);
    stage='read-only latest display rebase';
    const [reloadedResponse]=await Promise.all([
      page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${sid}/conversation` && response.request().method() === 'GET'),
      page.getByRole('button',{name:'Reconnect latest',exact:true}).click(),
    ]);
    const reloaded=await readReply(reloadedResponse,200,validateConversationPage);observed.latest++;
    expect(reloaded.session_id === sid && reloaded.snapshot_head === '9' && reloaded.block.run_id === command.run_id
      && reloaded.block.state === 'cancelled_locally' && reloaded.block.result_recorded && reloaded.block.events_complete === true
      && reloaded.block.sink_error === null && reloaded.block.human.entry_id === 'e:2:0' && reloaded.entries.length === 0
      && isDeepStrictEqual(reloaded.block.outcome,runView.result.outcome) && isDeepStrictEqual(reloaded.block.summary,runView.result.summary)).toBe(true);
    expect(reloaded.live_after === `g11l.${Buffer.from(JSON.stringify([1,sid,'9','3','',''])).toString('base64url')}`
      && initial.live_after === `g11l.${Buffer.from(JSON.stringify([1,sid,'1','3','',''])).toString('base64url')}`).toBe(true);
    const rebased=await checkpoint(4);expect(rebased === settled).toBe(true);
    audit(await fixture.request({command:'inspect_cancellation'}));
    await Promise.all(assetReads);
    expect([...assets].sort()).toEqual([...files.keys()].sort());
    expect(displayReads).toEqual([{kind:'latest',head:'1',matching:true},{kind:'events',head:'1',matching:true},
      {kind:'latest',head:'9',matching:true},{kind:'events',head:'9',matching:true}]);
    const getCounts=requests.filter(request => request.method === 'GET').map(request => request.path);
    expect(getCounts.length === 15 && getCounts.filter(path => path === '/v1/settings').length === 1
      && getCounts.filter(path => path === '/v1/sessions').length === 1
      && getCounts.filter(path => path.endsWith('/conversation')).length === 2
      && getCounts.filter(path => path.endsWith('/conversation/events')).length === 2).toBe(true);
    expect(posts).toEqual({create:1,task:1,cancel:1,reconcile:3,other:0});
    expect(observed).toEqual({latest:2,streams:2,receipts:1,cancels:1,reads:3,verified:4});
    stage='disconnect without another cancellation';
    const requestCount=requests.length;
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    expect(await page.getByLabel('Task',{exact:true}).inputValue() === '').toBe(true);
    await boundary();expect(requests.length === requestCount).toBe(true);
    expect(posts).toEqual({create:1,task:1,cancel:1,reconcile:3,other:0});expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch(cause) {
    const kind=['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure=new Error(`Cancellation failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {await context?.close();cleanup.context=context !== undefined;} catch {failure ??= new Error('Cancellation browser cleanup failed');}
    // Keep the guard if close failed: Playwright can still inspect that context.
    if(cleanup.context) {
      if(previousNoCopyPrompt === undefined)delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT=previousNoCopyPrompt;
    }
    if(!failure) {
      try {
        const final=await fixture.request({command:'inspect_cancellation'});
        if(final.session_id !== identity.session_id || final.run_id !== identity.run_id || final.operation_id !== identity.operation_id
          || final.terminal_operation_id !== terminal || !final.exact || !final.retired || !final.prefix_unchanged
          || final.sequence_count !== '9' || final.hits !== 1 || final.connections !== 1 || final.requests !== 1 || !final.closed
          || final.dispatches !== 0 || final.prepared_results !== 0 || final.reused !== 0 || final.result_records !== 1
          || posts.create !== 1 || posts.task !== 1 || posts.cancel !== 1 || posts.reconcile !== 3
          || posts.other !== 0 || Object.values(faults).some(value => value !== 0))throw new Error();
      }catch{failure=new Error('Cancellation post-cleanup audit failed');}
    }
    try {await fixture?.stop();cleanup.fixture=fixture !== undefined;} catch {failure ??= new Error('Cancellation fixture cleanup failed');}
  }
  console.log(`Cancellation cleanup: context=${cleanup.context} fixture=${cleanup.fixture}`);
  if(failure)throw failure;
  console.log('Cancellation evidence: task_posts=1 cancel_posts=1 connections=1 requests=1 pause=1 heads=6/7/9 terminal=cancelled_locally result_records=1 rebases=1 reconcile_reads=3');
});
