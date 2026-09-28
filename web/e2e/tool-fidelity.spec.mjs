import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { installToolFidelityObserver } from '../test-support/tool-fidelity.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';

const data = JSON.parse(await readFile(new URL('../test-support/tool-fidelity.json',import.meta.url),'utf8'));
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

test('native WS real tool reuse and successful error-shaped output stay exact and run-scoped', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture; let context; let failure; let stage='startup'; let observed=null;
  const cleanup={context:false,fixture:false};
  const faults={external:0,request:0,response:0,console:0,page:0,private:0};
  const posts={create:0,task:0,other:0};
  try {
    fixture=await startFixture(executable,{transport:'websocket',recovered:false,mime:true,tool_fidelity:true});
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
      const url=new URL(request.url());
      if(url.origin !== fixture.origin) faults.external++;
      if(leaked(request.url())) faults.private++;
      if(url.pathname.startsWith('/v1/')) {
        const headers=request.headers();
        if(headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
          || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      }
      if(request.method() === 'POST') {
        if(url.pathname === '/v1/sessions') posts.create++;
        else if(url.pathname.endsWith('/runs')) posts.task++;
        else posts.other++;
      }
    });
    context.on('response',response => {if(response.status() >= 300) faults.response++;});
    await context.addInitScript(installToolFidelityObserver,{fixture:data,owner:fixture.owner});
    const page=await context.newPage();
    page.on('console',message => {faults.console++;if(leaked(message.text()) || leaked(message.location().url)) faults.private++;});
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    async function boundary() {
      const safe=await page.evaluate(async ({owner,markers}) => {
        const values=[document.documentElement.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return globalThis.toolCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
          && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
          && (await navigator.serviceWorker.getRegistrations()).length === 0
          && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run img,.run svg,.run em,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function displayed(task) {
      const run=page.locator('.run').nth(task);
      await exact(run.locator('.user-text'),data.tasks[task]);
      await exact(run.locator(':scope > p:not(.metadata)'),'Execution: completed. Final result recorded.');
      await occurrences(run,data.answers[task],1);
      const sum=run.locator('.entry').filter({has:page.getByRole('heading',{name:'Tool: add_numbers',exact:true})});
      await occurrences(sum,data.sums[task],1);
      await occurrences(run,data.sums[task],1);
      const text=await sum.textContent();
      expect(text.includes('Result: success') && text.includes('finished (success)')
        && text.includes('Reused recorded result; not another execution or result.') === (task === 0)).toBe(true);
      await occurrences(run,data.arguments[task === 0 ? 0 : 2],1);
      if(task === 0) {
        await occurrences(run,data.arguments[1],1);
        await occurrences(run,data.fixture_arguments,1);
        const inert=run.locator('.entry').filter({has:page.getByRole('heading',{name:`Tool: ${data.name}`,exact:true})});
        await occurrences(inert,data.fixture_output,1);await occurrences(run,data.fixture_output,1);
        expect((await inert.textContent()).includes('Result: success') && (await inert.textContent()).includes('finished (success)')).toBe(true);
        expect(await run.locator('.entry').count()).toBe(5);
      } else expect(await run.locator('.entry').count()).toBe(3);
    }
    stage='connect and create';
    await page.goto(`${fixture.origin}/`);
    await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.getByRole('button',{name:'Connect',exact:true}).click();
    await exact(status,'connected');expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    await page.getByLabel('Title',{exact:true}).fill('Tool fidelity session');
    await page.getByRole('button',{name:'Create session',exact:true}).click();
    await page.getByRole('button',{name:'Open receipt session',exact:true}).click();
    await exact(page.getByRole('region',{name:'Canonical conversation',exact:true}),'No messages yet.');
    await exact(status,'connected; observation: streaming');
    const sid=new URL(page.url()).hash.slice('#session='.length);
    await fixture.request({command:'select',session_id:sid});
    let lastAudit;
    for(let task=0;task<2;task++) {
      stage=task === 0 ? 'first explicit submission' : 'second explicit submission';
      await page.getByLabel('Task',{exact:true}).fill(data.tasks[task]);
      await page.getByRole('button',{name:'Send',exact:true}).click();
      const gates=task === 0 ? [1,2,3] : [4,5];
      for(const gate of gates) {
        await fixture.wait('model_paused',gate);
        if(gate === 2) {
          await occurrences(page.locator('.run').nth(0),data.sums[0],1);
          await occurrences(page.locator('.run').nth(0),data.fixture_output,1);
        }
        if(gate === 3) {
          const run=page.locator('.run').nth(0);
          await occurrences(run,data.arguments[1],1);await occurrences(run,data.sums[0],1);
          await expect.poll(async () => (await run.textContent()).includes('Reused recorded result; not another execution or result.')).toBe(true);
        }
        await fixture.request({command:'drive',gate});
      }
      await fixture.wait('task_finished',task+1);
      stage=task === 0 ? 'first closed audit' : 'second closed audit';
      lastAudit=await fixture.inspectToolFidelity();
      expect(lastAudit.completed === task+1 && lastAudit.exact && lastAudit.prior_unchanged).toBe(true);
      stage=task === 0 ? 'first DTO reducer and DOM' : 'second DTO reducer and DOM';
      await expect.poll(async () => {observed=await page.evaluate(() => globalThis.toolFidelityCapture.summary());
        return page.evaluate(audit => globalThis.toolFidelityCapture.verify(audit),lastAudit);}).toBe(true);
      await expect(page.locator('.run')).toHaveCount(task+1);
      for(let index=0;index<=task;index++) await displayed(index);
      await boundary();
    }
    stage='stable results and public assets';
    await page.waitForTimeout(500);
    expect(await page.evaluate(audit => globalThis.toolFidelityCapture.verify(audit),lastAudit)).toBe(true);
    const files=[['/','index.html'],['/assets/wi.css','style.css'],...['api','app','client','sse','state','view'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])];
    const assets=await page.evaluate(checkEmbeddedAssets,{secrets:[fixture.owner,...markers],
      files:await Promise.all(files.map(async ([path,file]) => [path,[...await readFile(new URL(`../${file}`,import.meta.url))]]))});
    expect(assets).toEqual({checked:8,failures:[]});
    observed=await page.evaluate(() => globalThis.toolFidelityCapture.summary());
    expect(observed.taskPosts === 2 && observed.receipts === 2 && observed.history === 1 && observed.streams === 1
      && observed.verified === 2 && observed.failures.length === 0).toBe(true);
    expect(posts).toEqual({create:1,task:2,other:0});
    stage='disconnect and privacy';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    await page.evaluate(() => globalThis.toolFidelityCapture.drain());
    expect(await page.evaluate(() => globalThis.toolFidelityCapture.cleared())).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    await page.waitForTimeout(500);await boundary();
    expect(posts).toEqual({create:1,task:2,other:0});expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch(cause) {
    const kind=['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure=new Error(`Tool fidelity failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {await context?.close();cleanup.context=context !== undefined;} catch {failure ??= new Error('Tool fidelity browser cleanup failed');}
    // A failed close leaves a context that Playwright can inspect. Keep its guard installed.
    if(cleanup.context) {
      if(previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT=previousNoCopyPrompt;
    }
    try {await fixture?.stop();cleanup.fixture=fixture !== undefined;} catch {failure ??= new Error('Tool fidelity fixture cleanup failed');}
  }
  console.log(`Tool fidelity cleanup: context=${cleanup.context} fixture=${cleanup.fixture}`);
  if(failure) throw failure;
  console.log('Tool fidelity evidence: submissions=2 provider_requests=3,2 dispatches=2,1 reuse=1,0 rows=2,1 prepared=3,1 inert_executions=1');
});
