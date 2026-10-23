import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { validateTaskAcceptedView } from '../dist/api.js';

const data = JSON.parse(await readFile(new URL('../test-support/tool-fidelity.json',import.meta.url),'utf8'));
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

test('native WS real tool reuse and successful error-shaped output stay exact and run-scoped', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture; let context; let failure; let stage='startup';
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
    const uuid=value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
      && value !== '00000000-0000-0000-0000-000000000000';
    const commands=[]; const receipts=[]; const responseReads=[]; const displayReads=[]; const snapshots=[];
    let createCommand;
    const assets=new Set();
    const files=new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    context.on('request',request => {
      const url=new URL(request.url());
      if(url.origin !== fixture.origin) faults.external++;
      if(leaked(request.url())) faults.private++;
      if(['/assets/client.js','/assets/state.js','/assets/view.js'].includes(url.pathname)
        || url.pathname.endsWith('/history') || url.pathname.includes('/operations/')
        || (request.method() === 'GET' && url.pathname.includes('/runs/'))
        || (url.pathname.endsWith('/events') && !url.pathname.endsWith('/conversation/events'))) faults.request++;
      if(url.pathname.startsWith('/v1/')) {
        const headers=request.headers();
        if(headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
          || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      }
      if(request.method() === 'GET' && url.pathname.endsWith('/conversation/events')) {
        const sid=url.pathname.split('/')[3];
        const after=`g11l.${Buffer.from(JSON.stringify([1,sid,'1','3','',''])).toString('base64url')}`;
        displayReads.push({kind:'events',matching_head:url.searchParams.get('after') === after});
      }
      if(request.method() === 'POST') {
        try {
          const body=request.postDataJSON();
          if(url.pathname === '/v1/sessions') {
            posts.create++;
            if(createCommand !== undefined || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
              || !uuid(body.operation_id) || body.title !== 'Tool fidelity session' || typeof body.workspace !== 'string') faults.request++;
            else createCommand=body;
          } else if(url.pathname.endsWith('/runs')) {
            const task=posts.task++;
            if(task >= 2 || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
              || !uuid(body.operation_id) || !uuid(body.run_id) || body.text !== data.tasks[task]) faults.request++;
            else commands.push(body);
          } else posts.other++;
        } catch {faults.request++;}
      }
    });
    context.on('response',response => {
      const request=response.request(); const url=new URL(response.url());
      if(response.status() >= 300) faults.response++;
      if(request.method() === 'GET' && url.pathname.endsWith('/conversation') && url.search === '')
        displayReads.push({kind:'latest',status:response.status()});
      if(request.method() === 'POST' && url.pathname.endsWith('/runs')) {
        responseReads.push((async () => {
          const command=request.postDataJSON();
          const task=commands.findIndex(value => value.operation_id === command.operation_id);
          const reply=validateTaskAcceptedView(await response.json());
          if(response.status() !== 202 || task < 0 || receipts[task] !== undefined || reply.duplicate
            || reply.warning_code !== null || reply.notices.length !== 0) faults.response++;
          else receipts[task]=reply.receipt;
        })().catch(() => {faults.response++;}));
      }
      const file=files.get(url.pathname);
      if(file === undefined) return;
      responseReads.push((async () => {
        // Read only public assets here; the actual app consumes display HTTP/SSE.
        const bytes=await response.body();
        if(response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file}`,import.meta.url)))) faults.response++;
        if(leaked(bytes.toString('utf8'))) faults.private++;
        assets.add(url.pathname);
      })().catch(() => {faults.response++;}));
    });
    const page=await context.newPage();
    page.on('console',message => {faults.console++;if(leaked(message.text()) || leaked(message.location().url)) faults.private++;});
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    async function boundary() {
      const safe=await page.evaluate(async ({owner,markers}) => {
        const dom=document.documentElement.cloneNode(true);
        // Public field IDs are hashes, not credentials. Keep every other DOM byte in the privacy scan.
        for(const field of dom.querySelectorAll('[data-field]')) {
          const id=field.getAttribute('data-field');
          if(!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return false;
          field.removeAttribute('data-field');
        }
        const values=[dom.outerHTML,location.href,JSON.stringify(history.state),
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
      const command=commands[task], receipt=receipts[task];
      expect(receipt.session_id === sid && receipt.operation_id === command.operation_id && receipt.run_id === command.run_id).toBe(true);
      const run=page.locator(`.run[data-run="${command.run_id}"]`);
      await exact(run.locator(':scope > .metadata'),'Execution: completed. Final result recorded.');
      const human=run.locator('.entry').filter({has:page.getByRole('heading',{name:'Human',exact:true})});
      await exact(human.locator('[data-field] pre'),data.tasks[task]);
      await expect(human).toHaveAttribute('data-entry',`e:${receipt.first_sequence}:0`);
      await exact(human.locator(':scope > .metadata').first(),'Recorded state: accepted; Provisional: false');
      await occurrences(run,data.tasks[task],1);await occurrences(run,data.answers[task],1);
      const names=task === 0 ? ['Human','assistant','tool','tool','assistant','reuse','assistant'] : ['Human','assistant','tool','assistant'];
      await expect(run.locator('.entry > h4')).toHaveText(names);
      expect(await run.locator('.entry').evaluateAll(nodes => {
        const ids=nodes.map(node => node.dataset.entry);
        if(new Set(ids).size !== ids.length || ids.some(id => !/^e:[1-9][0-9]*:(0|[1-9][0-9]*)$/.test(id))) return false;
        const positions=ids.map(id => id.split(':').slice(1).map(BigInt));
        return positions.every(([seq,slot],index) => index === 0 || seq > positions[index-1][0]
          || (seq === positions[index-1][0] && slot > positions[index-1][1]));
      })).toBe(true);
      const assistants=run.locator('.entry').filter({has:page.getByRole('heading',{name:'assistant',exact:true})});
      const responseFields=task === 0 ? [['add_numbers',data.arguments[0],data.name,data.fixture_arguments],['add_numbers',data.arguments[1]],[data.answers[0]]]
        : [['add_numbers',data.arguments[2]],[data.answers[1]]];
      for(let turn=0;turn<responseFields.length;turn++) {
        const assistant=assistants.nth(turn);
        await exact(assistant.locator(':scope > .metadata').first(),'Recorded state: completed; Provisional: false');
        expect(await assistant.locator('[data-field] pre').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual(responseFields[turn]);
      }
      const tools=run.locator('.entry').filter({has:page.getByRole('heading',{name:'tool',exact:true})});
      for(let slot=0;slot<(task === 0 ? 2 : 1);slot++) {
        const tool=tools.nth(slot), name=slot === 0 ? 'add_numbers' : data.name, output=slot === 0 ? data.sums[task] : data.fixture_output;
        await exact(tool.locator(':scope > .metadata').first(),'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false');
        expect(await tool.locator('[data-field] pre').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual([name,output]);
        await occurrences(tool,output,1);await occurrences(run,output,1);
        const result=tool.locator('details[data-field]').filter({has:page.getByText('tool_result',{exact:true})});
        if(!(await result.evaluate(node => node.open))) await result.locator('summary').click();
        await expect(result.locator('pre')).toBeVisible();
      }
      if(task === 0) {
        await occurrences(run,data.arguments[1],1);await occurrences(run,data.fixture_arguments,1);
        const target=await tools.nth(0).getAttribute('data-entry');
        const reuse=run.locator('.entry').filter({has:page.getByRole('heading',{name:'reuse',exact:true})});
        await exact(reuse.locator(':scope > .metadata').first(),`Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false; Recorded reuse reference: ${command.run_id}/${target}. Not another execution.`);
        expect(await reuse.locator('[data-field]').count()).toBe(0);
      }
      await occurrences(run,data.arguments[task === 0 ? 0 : 2],1);
      const recording=run.locator(':scope > details > pre');
      const requestId=(await recording.textContent()).split('\n').find(line => line.startsWith('last_request_id: '))?.slice('last_request_id: '.length);
      expect(uuid(requestId)).toBe(true);
      const turns=task === 0 ? 3 : 2, dispatches=task === 0 ? 2 : 1, reused=task === 0 ? 1 : 0;
      await exact(recording,`Run: ${command.run_id}\nAccepted sequence: ${receipt.first_sequence}\nOutcome: completed\nEvents complete: true\nSink error: none\nturns_started: ${turns}\nturns_finished: ${turns}\nmodel_requests_attempted: ${turns}\nmodel_requests_admitted: ${turns}\nnew_tool_dispatches: ${dispatches}\ntool_results_prepared: ${dispatches+reused}\nreused_results: ${reused}\nlast_request_id: ${requestId}\nlast_upstream_outcome: terminal_received`);
      const article=page.locator('.command').filter({has:page.getByText(`Operation: ${command.operation_id}\nSession: ${sid}`,{exact:true})});
      await exact(article.locator('h3'),'task: accepted');await exact(article.locator('details pre'),command.text);
      await exact(article.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
      return run.evaluate(node => node.outerHTML);
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
    expect(uuid(sid)).toBe(true);
    expect(displayReads).toEqual([{kind:'latest',status:200},{kind:'events',matching_head:true}]);
    const create=page.locator('.command').filter({has:page.getByRole('heading',{name:'create: accepted',exact:true})});
    await exact(create.locator('details pre'),'Tool fidelity session');
    await exact(create.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${createCommand.operation_id}\nSession: ${sid}\nRun: none\nSequences: 1 to 1\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    const createReceiptText=await create.locator(':scope > pre').textContent();
    await fixture.request({command:'select',session_id:sid});
    let lastAudit;
    for(let task=0;task<2;task++) {
      stage=task === 0 ? 'first explicit submission' : 'second explicit submission';
      await page.getByLabel('Task',{exact:true}).fill(data.tasks[task]);
      await page.getByRole('button',{name:'Send',exact:true}).click();
      const gates=task === 0 ? [1,2,3] : [4,5];
      for(const gate of gates) {
        await fixture.wait('model_paused',gate);
        if(gate === 2 || gate === 5) {
          const run=page.locator('.run').nth(task);
          await occurrences(run,data.sums[task],1);
          const tools=run.locator('.entry').filter({has:page.getByRole('heading',{name:'tool',exact:true})});
          await expect(tools).toHaveCount(task === 0 ? 2 : 1);
          if(task === 0) await occurrences(run,data.fixture_output,1);
          for(let slot=0;slot<(task === 0 ? 2 : 1);slot++) {
            const tool=tools.nth(slot);
            await exact(tool.locator(':scope > .metadata').first(),'Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false');
            await tool.getByText('tool_result',{exact:true}).click();
            await expect(tool.locator('details pre')).toBeVisible();
          }
          await occurrences(run,data.answers[task],0);
          await exact(run.locator(':scope > .metadata'),'Execution: running. Final result not recorded.');
          stage=task === 0 ? 'first committed results privacy' : 'second committed result privacy';
          await boundary();
        }
        if(gate === 3) {
          const run=page.locator('.run').nth(0);
          await occurrences(run,data.arguments[1],1);await occurrences(run,data.sums[0],1);
          await occurrences(run,data.fixture_output,1);
          await expect(run.locator('.entry > h4')).toHaveText(['Human','assistant','tool','tool','assistant','reuse']);
          const target=await run.locator('.entry').filter({has:page.getByRole('heading',{name:'tool',exact:true})}).nth(0).getAttribute('data-entry');
          const reuse=run.locator('.entry').filter({has:page.getByRole('heading',{name:'reuse',exact:true})});
          await exact(reuse.locator(':scope > .metadata').first(),`Recorded state: completed; Provisional: false; result_recorded: true; finish_recorded: true; is_error: false; Recorded reuse reference: ${commands[0].run_id}/${target}. Not another execution.`);
          expect(await reuse.locator('[data-field]').count()).toBe(0);
          stage='first reuse privacy';
          await boundary();
        }
        await fixture.request({command:'drive',gate});
      }
      await fixture.wait('task_finished',task+1);
      stage=task === 0 ? 'first closed audit' : 'second closed audit';
      // The ordered native audit runs exactly once after each completed Task, never for stability checks.
      const priorAudit=lastAudit;
      lastAudit=await fixture.inspectToolFidelity();
      await Promise.all(responseReads);
      const command=commands[task];
      expect(lastAudit.protocol === 1 && lastAudit.event === 'tool_fidelity_inspect'
        && Number.isInteger(lastAudit.id) && lastAudit.id > (priorAudit?.id ?? 0) && lastAudit.id <= 0xffffffff
        && lastAudit.session_id === sid && lastAudit.run_id === command.run_id && lastAudit.operation_id === command.operation_id
        && lastAudit.completed === task+1 && lastAudit.exact && lastAudit.prior_unchanged).toBe(true);
      expect([lastAudit.requests,lastAudit.new_dispatches,lastAudit.reused,lastAudit.result_rows,lastAudit.prepared_results,lastAudit.executions])
        .toEqual(task === 0 ? [3,2,1,2,3,1] : [2,1,0,1,1,1]);
      expect(/^[1-9][0-9]*$/.test(lastAudit.sequence_count) && BigInt(lastAudit.sequence_count) > BigInt(priorAudit?.sequence_count ?? '1')
        && BigInt(lastAudit.sequence_count) <= 128n).toBe(true);
      if(task === 1) expect(commands[0].operation_id !== command.operation_id && commands[0].run_id !== command.run_id).toBe(true);
      stage=task === 0 ? 'first supplied display and DOM' : 'second supplied display and DOM';
      await exact(status,'connected; observation: streaming');
      await expect(page.locator('.run')).toHaveCount(task+1);
      for(let index=0;index<=task;index++) {
        const snapshot=await displayed(index);
        if(snapshots[index] === undefined) snapshots[index]=snapshot;
        else expect(snapshot === snapshots[index]).toBe(true);
      }
      await exact(create.locator(':scope > pre'),createReceiptText);
      await expect(page.locator('.command')).toHaveCount(task+2);
      await boundary();
    }
    stage='stable results and public assets';
    await page.waitForTimeout(500);
    expect(await page.locator('.run').evaluateAll(nodes => nodes.map(node => node.outerHTML))).toEqual(snapshots);
    await Promise.all(responseReads);
    expect([...assets].sort()).toEqual([...files.keys()].sort());
    expect(displayReads).toEqual([{kind:'latest',status:200},{kind:'events',matching_head:true}]);
    expect(commands.length === 2 && receipts.filter(Boolean).length === 2 && lastAudit.completed === 2).toBe(true);
    expect(posts).toEqual({create:1,task:2,other:0});
    stage='disconnect and privacy';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    for(const label of ['Owner token','Title','Exact new title','Task']) expect(await page.getByLabel(label,{exact:true}).inputValue()).toBe('');
    expect(await page.getByLabel('Workspace',{exact:true}).locator('option').count()).toBe(0);
    await expect(page.getByRole('button',{name:'Connect',exact:true})).toBeVisible();
    await page.waitForTimeout(500);await Promise.all(responseReads);await boundary();
    expect(displayReads).toEqual([{kind:'latest',status:200},{kind:'events',matching_head:true}]);
    expect(posts).toEqual({create:1,task:2,other:0});expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch(cause) {
    const kind=['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure=new Error(`Tool fidelity failed: ${stage}; kind=${kind}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
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
