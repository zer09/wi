import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { installCancellationObserver } from '../test-support/cancellation.mjs';

const data=JSON.parse(await readFile(new URL('../test-support/cancellation.json',import.meta.url),'utf8'));
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

test('one explicit Cancel retains running truth until native cancellation commits and survives read-only reload',async ({browser}) => {
  const previousNoCopyPrompt=process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;let context;let failure;let stage='startup';let observed=null;let identity;let terminal;
  const cleanup={context:false,fixture:false};
  const faults={external:0,request:0,response:0,console:0,page:0,private:0};
  const posts={create:0,task:0,cancel:0,other:0};
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
    context.on('request',request => {
      const url=new URL(request.url());if(url.origin !== fixture.origin)faults.external++;
      if(leaked(request.url()))faults.private++;
      if(url.pathname.startsWith('/v1/')) {
        const headers=request.headers();
        if(headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
          || (headers.origin !== undefined && headers.origin !== fixture.origin))faults.request++;
      }
      if(request.method() === 'POST') {
        if(url.pathname === '/v1/sessions')posts.create++;
        else if(url.pathname.endsWith('/runs'))posts.task++;
        else if(url.pathname.endsWith('/cancel')) {
          posts.cancel++;
          if(!identity || url.pathname !== `/v1/sessions/${identity.session_id}/runs/${identity.run_id}/cancel`
            || url.search !== '' || request.postData() !== '{}')faults.request++;
        } else posts.other++;
      }
    });
    context.on('response',response => {if(response.status() >= 300)faults.response++;});
    await context.addInitScript(installCancellationObserver,{fixture:data,owner:fixture.owner});
    const page=await context.newPage();
    page.on('console',message => {faults.console++;if(leaked(message.text()) || leaked(message.location().url))faults.private++;});
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    const readView=page.locator('pre').filter({hasText:'Read-only run view:'});
    const cancelReply=page.locator('p').filter({hasText:'Cancel disposition:'});
    async function boundary() {
      const safe=await page.evaluate(async ({owner,markers}) => {
        const values=[document.documentElement.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return globalThis.cancellationCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0
          && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run img,.run svg,.run em,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function checkpoint(number,audit) {
      await expect.poll(async () => {
        observed=await page.evaluate(() => globalThis.cancellationCapture.summary());
        return page.evaluate(({number,audit}) => globalThis.cancellationCapture.verify(number,audit),{number,audit});
      }).toBe(true);
      const execution=number < 3 ? 'running' : 'cancelled_locally';
      const recording=number < 3 ? 'result not recorded' : 'result recorded';
      await exact(status,`connected; observation: streaming; run: ${execution}; ${recording}`);
      const run=page.locator('.run');expect(await run.count()).toBe(1);
      await exact(run.locator('.user-text'),data.task);
      await exact(run.locator(':scope > p:not(.metadata)'),`Execution: ${execution}. Final ${recording}.`);
      expect(await run.locator('.entry').count()).toBe(0);
      if(number < 3)await exact(readView,`Read-only run view: ${identity.run_id}\nExecution: running\nResult recorded: false\nTerminal sequence: none\nResult sequence: none`);
      else {
        const text=await readView.textContent();
        expect(text.includes(`Read-only run view: ${identity.run_id}\nExecution: cancelled_locally\nResult recorded: true\nTerminal sequence: 8\nResult sequence: 9`)).toBe(true);
        expect((await run.textContent()).includes('Terminal outcome: cancelled_locally')).toBe(true);
        await expect(page.getByRole('button',{name:'Cancel current run',exact:true})).toBeDisabled();
      }
      if(number === 2 || number === 3)await exact(cancelReply,`Cancel disposition: requested\nRun: ${identity.run_id}\nThis is a signal disposition, not terminal truth. Canonical run evidence determines the outcome.`);
      await boundary();
    }
    stage='connect and fresh selection';
    await page.goto(`${fixture.origin}/`);await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.getByRole('button',{name:'Connect',exact:true}).click();await exact(status,'connected');
    expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    await page.getByLabel('Title',{exact:true}).fill(data.title);await page.getByRole('button',{name:'Create session',exact:true}).click();
    await page.getByRole('button',{name:'Open receipt session',exact:true}).click();
    await exact(page.getByRole('region',{name:'Canonical conversation',exact:true}),'No messages yet.');
    await exact(status,'connected; observation: streaming');
    const sid=new URL(page.url()).hash.slice('#session='.length);
    await fixture.request({command:'select',session_id:sid});await fixture.request({command:'arm_cancellation'});
    stage='one explicit task and pre-cancel running RunView';
    await page.getByLabel('Task',{exact:true}).fill(data.task);await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(() => page.evaluate(() => globalThis.cancellationCapture.ready(6))).toBe(true);
    await expect.poll(() => page.evaluate(() => globalThis.cancellationCapture.identity() !== null)).toBe(true);
    identity=await page.evaluate(() => globalThis.cancellationCapture.identity());
    expect(identity.session_id === sid).toBe(true);
    const pending=await fixture.request({command:'wait_cancellation_pending',...identity});
    await page.getByRole('button',{name:'Read run status',exact:true}).click();await checkpoint(1,pending);
    stage='one explicit Cancel and independent uncommitted terminal snapshot';
    await page.getByRole('button',{name:'Cancel current run',exact:true}).click();
    const paused=await fixture.request({command:'wait_cancellation'});terminal=paused.terminal_operation_id;
    // The writer owns the session mutex here. Retain the pre-cancel read; do not issue another read.
    await checkpoint(2,paused);
    expect(posts).toEqual({create:1,task:1,cancel:1,other:0});
    stage='release terminal and wait for worker retirement';
    await fixture.request({command:'release_cancellation',terminal_operation_id:terminal});
    const audit=await fixture.request({command:'inspect_cancellation'});
    await expect.poll(() => page.evaluate(() => globalThis.cancellationCapture.ready(9))).toBe(true);
    await page.getByRole('button',{name:'Read run status',exact:true}).click();await checkpoint(3,audit);
    stage='read-only history reload';
    await page.getByRole('button',{name:'Reload history',exact:true}).click();
    await expect.poll(async () => (await page.evaluate(() => globalThis.cancellationCapture.summary())).streams).toBe(2);
    await expect.poll(() => page.evaluate(() => globalThis.cancellationCapture.ready(9))).toBe(true);
    const reloaded=await fixture.request({command:'inspect_cancellation'});
    await page.getByRole('button',{name:'Read run status',exact:true}).click();await checkpoint(4,reloaded);
    observed=await page.evaluate(() => globalThis.cancellationCapture.summary());
    expect(observed).toEqual({taskPosts:1,receipts:1,cancelPosts:1,cancels:1,history:2,streams:2,sseEvents:8,runReads:3,verified:4,failures:[]});
    stage='disconnect without another cancellation';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    await page.evaluate(() => globalThis.cancellationCapture.drain());expect(await page.evaluate(() => globalThis.cancellationCapture.cleared())).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    await boundary();expect(posts).toEqual({create:1,task:1,cancel:1,other:0});expect(Object.values(faults)).toEqual(Array(6).fill(0));
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
          || final.terminal_operation_id !== terminal || !final.retired || posts.create !== 1 || posts.task !== 1 || posts.cancel !== 1
          || posts.other !== 0 || Object.values(faults).some(value => value !== 0))throw new Error();
      }catch{failure=new Error('Cancellation post-cleanup audit failed');}
    }
    try {await fixture?.stop();cleanup.fixture=fixture !== undefined;} catch {failure ??= new Error('Cancellation fixture cleanup failed');}
  }
  console.log(`Cancellation cleanup: context=${cleanup.context} fixture=${cleanup.fixture}`);
  if(failure)throw failure;
  console.log('Cancellation evidence: task_posts=1 cancel_posts=1 connections=1 requests=1 pause=1 heads=6/7/9 terminal=cancelled_locally result_records=1 reloads=1');
});
