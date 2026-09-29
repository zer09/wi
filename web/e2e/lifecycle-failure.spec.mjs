import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { installLifecycleFailureObserver } from '../test-support/lifecycle-failure.mjs';

const data=JSON.parse(await readFile(new URL('../test-support/lifecycle-failure.json',import.meta.url),'utf8'));
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

test('native WS partial failure survives final-result rollback and read-only history reload',async ({browser}) => {
  const previousNoCopyPrompt=process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;let context;let failure;let stage='startup';let observed=null;
  const cleanup={context:false,fixture:false};
  const faults={external:0,request:0,response:0,console:0,page:0,private:0};
  const posts={create:0,task:0,other:0};
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
        else posts.other++;
      }
    });
    context.on('response',response => {if(response.status() >= 300)faults.response++;});
    await context.addInitScript(installLifecycleFailureObserver,{fixture:data,owner:fixture.owner});
    const page=await context.newPage();
    page.on('console',message => {faults.console++;if(leaked(message.text()) || leaked(message.location().url))faults.private++;});
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    async function boundary() {
      const safe=await page.evaluate(async ({owner,markers}) => {
        const values=[document.documentElement.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return globalThis.lifecycleCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0
          && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run img,.run svg,.run em,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function checkpoint(number,audit=null) {
      observed=await page.evaluate(() => globalThis.lifecycleCapture.summary());
      stage+=' observation';
      const execution=number < 3 ? 'running' : 'failed';
      await exact(status,`connected; observation: streaming; run: ${execution}; result not recorded`);
      let head=19;
      if(number === 1)head=13;
      else if(number === 2)head=16;
      await expect.poll(() => page.evaluate(head => globalThis.lifecycleCapture.ready(head),head)).toBe(true);
      stage+=' run read';
      await page.getByRole('button',{name:'Read run status',exact:true}).click();
      stage+=' capture';
      await expect.poll(async () => {
        observed=await page.evaluate(() => globalThis.lifecycleCapture.summary());
        return page.evaluate(({number,audit}) => globalThis.lifecycleCapture.verify(number,audit),{number,audit});
      }).toBe(true);
      const run=page.locator('.run');expect(await run.count()).toBe(1);
      await exact(run.locator('.user-text'),data.task);
      await exact(run.locator(':scope > p:not(.metadata)'),number < 3 ? 'Execution: running. Final result not recorded.' : 'Execution: failed. Final result not recorded.');
      await occurrences(run,data.arguments,1);await occurrences(run,data.output,1);
      await occurrences(run,data.partial,number === 1 ? 0 : 1);
      const responses=run.locator('.entry').filter({has:page.getByRole('heading',{name:'Response',exact:true})});
      expect(await responses.count()).toBe(number === 1 ? 1 : 2);
      const first=await responses.nth(0).textContent();
      expect(first.includes('Status: completed') && first.includes('Output provenance: native_terminal')).toBe(true);
      if(number >= 2) {
        const second=await responses.nth(1).textContent();
        expect(!second.includes('Output provenance:') && second.includes('(provisional)')).toBe(true);
        if(number >= 3)expect(second.includes('Code: unexpected_end') && second.includes('Upstream: unknown')).toBe(true);
      }
      const all=await run.textContent();
      expect(!all.includes('Recording sink error:') && !all.includes('Events complete:') && !all.includes('Stored interruption:') && !all.includes('storage.io')).toBe(true);
      if(number >= 3)expect(all.includes('Terminal outcome: failed') && all.includes('Code: provider_request_failed') && all.includes('Turn 2: stopped')).toBe(true);
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
    await fixture.request({command:'select',session_id:sid});await fixture.request({command:'arm_lifecycle_failure'});
    stage='one explicit submission';
    await page.getByLabel('Task',{exact:true}).fill(data.task);await page.getByRole('button',{name:'Send',exact:true}).click();
    await fixture.wait('model_paused',1);stage='authoritative tool and running checkpoint';await checkpoint(1);
    await fixture.request({command:'drive',gate:1});await fixture.wait('model_paused',2);
    stage='durable provisional SSE checkpoint';await checkpoint(2);
    const identity=await page.evaluate(() => globalThis.lifecycleCapture.identity());
    await fixture.request({command:'drive',gate:2});stage='distinct final append pause';
    const paused=await fixture.request({command:'wait_lifecycle_failure',...identity});
    expect(paused.hits === 1 && paused.exact && paused.final_operation_id !== identity.operation_id).toBe(true);
    await fixture.request({command:'release_lifecycle_failure',final_operation_id:paused.final_operation_id});
    const audit=await fixture.request({command:'inspect_lifecycle_failure'});
    stage='settled failed unrecorded result';await checkpoint(3,audit);
    stage='read-only canonical reload';
    await page.getByRole('button',{name:'Reload history',exact:true}).click();
    await expect.poll(async () => (await page.evaluate(() => globalThis.lifecycleCapture.summary())).streams).toBe(2);
    const reloaded=await fixture.request({command:'inspect_lifecycle_failure'});await checkpoint(4,reloaded);
    observed=await page.evaluate(() => globalThis.lifecycleCapture.summary());
    expect(observed.taskPosts === 1 && observed.receipts === 1 && observed.history === 2 && observed.streams === 2
      && observed.sseEvents === 18 && observed.runReads === 4 && observed.verified === 4 && observed.failures.length === 0).toBe(true);
    expect(posts).toEqual({create:1,task:1,other:0});
    stage='disconnect and privacy';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    await page.evaluate(() => globalThis.lifecycleCapture.drain());expect(await page.evaluate(() => globalThis.lifecycleCapture.cleared())).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    await boundary();expect(posts).toEqual({create:1,task:1,other:0});expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch(cause) {
    const kind=['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure=new Error(`Lifecycle failure failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
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
  console.log('Lifecycle failure evidence: task_posts=1 connections=1 requests=2 dispatches=1 prepared=1 reuse=0 final_pause=1 result_records=0 reloads=1');
});
