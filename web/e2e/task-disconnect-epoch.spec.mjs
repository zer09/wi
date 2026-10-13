import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { isDeepStrictEqual } from 'node:util';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json',import.meta.url),'utf8'));
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n'; // Exact browser.rs TASKS[0].
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const ARGUMENTS = '{"a":17,\r\n "b":25}';
const OUTPUT = '{"sum":42}';
const DRAFT = 'Unsent before Disconnect 雪\n<em>inert</em>\n';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({trace:'off',screenshot:'off',video:'off'});

test('Disconnect epoch: accepted native work survives Disconnect; explicit Connect reads completed durable A', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture; let context; let page; let failure;
  function replyFacts() { return {acquired:false,status:null,body_attempted:false,body_returned:false,body_bounded:false,decoded:false,validated:false,exact:false}; }
  let stage = 'startup'; let disconnectedView = null;
  const observed = {create:replyFacts(),task:replyFacts(),latest:[]};
  let connectClickObserved = false; let finalDisconnectClickObserved = false;
  const cleanup = {browser:false,fixture:false};
  const faults = {external:0,request:0,response:0,console:0,page:0,private:0};
  const network = {create:0,task:0,other:0,settings:0,list:0,quiet:0};
  const reads = []; const snapshots = [];
  let creation = null; let submitted = null; let workspace; let quietPeriod = null;
  let originalDocument; let originalRoot;
  const starts = []; const settled = new Set(); const ambiguousStarts = new Set(); const countedStarts = new Set();
  let quietTiming = {pending:0,ambiguous:0,missing:0,tie:0,unknown:0};
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
      const bytes = await response.body();
      facts.body_returned = true;
      expect(bytes.byteLength <= limit).toBe(true);
      facts.body_bounded = true;
      const raw = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      // Display field IDs are public hex; the closed DTO and exact field checks cover them.
      if (raw.includes(fixture.owner) || markers.some(marker => raw.includes(marker))
        || (limit === 4096 && /[0-9a-f]{64}/i.test(raw))) faults.private++;
      const value = decodeJson(raw,response.headers()['content-type'],parsed => {
        facts.decoded = true;
        return validator(parsed);
      });
      facts.validated = true;
      // Count separators outside strings so duplicate JSON keys cannot pass exact decoding.
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
      else await route.continue(); // All joined API replies come from the real Rust service.
    });
    context.on('request',request => {
      const url = new URL(request.url());
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.private++;
      if (url.origin === fixture.origin) {
        const kind = request.isNavigationRequest() ? 'navigation' : 'resource';
        const same = starts.filter(start => start.kind === kind && start.url === request.url());
        const start = Object.freeze({request,kind,url:request.url(),occurrence:same.length,period:quietPeriod});
        // Same-kind duplicate URLs cannot be paired by callback order within one quiet period.
        for (const prior of same) if (!settled.has(prior.request) || (quietPeriod !== null && prior.period === quietPeriod)) {
          ambiguousStarts.add(prior); ambiguousStarts.add(start);
        }
        starts.push(start);
      }
      if (!url.pathname.startsWith('/v1/')) return;
      const headers = request.headers();
      if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
        || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      if (request.method() === 'GET') {
        if (url.pathname === '/v1/settings' && url.search === '') network.settings++;
        else if (url.pathname === '/v1/sessions' && url.search === '?limit=32') network.list++;
        else if (/^\/v1\/sessions\/[0-9a-f-]{36}\/conversation(\/events)?$/.test(url.pathname) && reads.length < 4) {
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
          if (creation !== null || Object.keys(body).sort().join(',') !== 'operation_id,title,workspace'
            || body.title !== titles[0] || body.workspace !== workspace) throw new Error();
          creation = body;
        } else {
          if (submitted !== null || Object.keys(body).sort().join(',') !== 'operation_id,run_id,text'
            || !uuid(body.run_id) || body.run_id === body.operation_id || body.text !== TASK
            || creation.operation_id === body.operation_id || creation.operation_id === body.run_id) throw new Error();
          submitted = {path:url.pathname,...body};
        }
      } catch {faults.request++;}
    });
    context.on('requestfinished',request => { settled.add(request); });
    context.on('requestfailed',request => { settled.add(request); });
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
    const sessionButton = page.locator('.session-list button').filter({hasText:'first title'});
    const createCommand = page.locator('.command').filter({has:page.getByRole('heading',{name:/^create:/})});
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
    async function disconnectedTruth() {
      await exact(status,'disconnected');
      disconnectedView = await page.evaluate(a => ({
        hashRetained:location.hash === `#session=${a}`,
        rowsEmpty:document.querySelectorAll('.run,.command,.session-list li').length === 0,
        fieldsEmpty:Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''),
        settingsEmpty:document.querySelector('.topbar .metadata').textContent === '',
      }),a);
      expect(disconnectedView).toEqual({hashRetained:true,rowsEmpty:true,fieldsEmpty:true,settingsEmpty:true});
      expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
      expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
      expect(await conversation.locator('h2,.metadata,.transcript').evaluateAll(nodes => nodes.every(node => node.textContent === ''))).toBe(true);
      expect(await page.evaluate(canaries => !canaries.some(text => document.documentElement.outerHTML.includes(text)),
        [TASK,ANSWER,ARGUMENTS,OUTPUT,DRAFT,...titles])).toBe(true);
      await expect(page.getByRole('button',{name:'Connect',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toHaveCount(0);
      await privateBoundary();
    }
    function provider(proof,requests,tools,completed) {
      expect([proof.requests,proof.connections,proof.auth_loads,proof.auth_prepares,proof.prepared_exact,
        proof.tool_results,proof.terminals,proof.results,proof.completed]).toEqual([requests,1,1,1,requests,tools,completed,completed,completed]);
      expect(proof.fresh_empty && !proof.restored_history && proof.fresh_parents === 1 && proof.continuations === requests-1
        && !proof.provider_failed && proof.read_failure === null && proof.accepted.length === 1 && proof.receipts.length === 1).toBe(true);
    }
    async function classifyStarts(final = false) {
      const evidence = await page.evaluate(({originalDocument,originalRoot,starts,final}) => {
        const root = document.getElementById('app');
        const click = root?.disconnectQuietClickTime;
        const finalClick = Object.getOwnPropertyDescriptor(originalRoot,'disconnectQuietFinalClickTime');
        const sameDocument = document === originalDocument && root === originalRoot;
        const finalClickObserved = sameDocument && Number.isFinite(click) && Number.isFinite(finalClick?.value)
          && finalClick.value > click && finalClick.value >= 0 && finalClick.writable === false
          && finalClick.enumerable === false && finalClick.configurable === true;
        const navigation = performance.getEntriesByType('navigation');
        const resources = performance.getEntriesByType('resource');
        const navigationStarts = starts.filter(start => start.kind === 'navigation');
        const categories = starts.map(start => {
          // A replacement document cannot supply timing or a click for the original document.
          if (!sameDocument) return 'unknown';
          if (start.kind === 'navigation' && (navigationStarts.length !== 1 || start.period !== null
            || start.occurrence !== 0 || navigation.length > 1)) return 'ambiguous';
          const same = starts.filter(peer => peer.kind === start.kind && peer.url === start.url);
          const population = start.kind === 'navigation' ? navigation : resources;
          const entries = population.filter(entry => entry.entryType === start.kind && entry.name === start.url).sort((a,b) => a.startTime-b.startTime);
          if (same.some(peer => peer.ambiguous) || entries.length > same.length
            || entries.some((entry,index) => index > 0 && entry.startTime === entries[index-1].startTime)) return 'ambiguous';
          // A known outside-quiet entry remains baseline when a later occurrence is incomplete.
          // Quiet starts still require the full population so partial entries cannot authorize them.
          if (entries.length < same.length && (start.period !== null || entries.length <= start.occurrence)) {
            return final || start.kind === 'navigation' ? 'missing' : 'pending';
          }
          const time = entries[start.occurrence]?.startTime;
          if (!Number.isFinite(time) || time < 0) return 'unknown';
          if (start.period === null) return 'baseline';
          if (start.period === 2 || !Number.isFinite(click)) return 'quiet';
          if (time === click) return 'tie';
          // Final-action starts can arrive before the SDK click promise returns.
          if (final || finalClick !== undefined) {
            if (!finalClickObserved) return 'unknown';
            if (time === finalClick.value) return 'tie';
            if (time > finalClick.value) return 'quiet';
          }
          return time > click ? 'post_click' : 'quiet';
        });
        if (final) {
          delete originalRoot.disconnectQuietClickTime;
          delete originalRoot.disconnectQuietFinalClickTime;
        }
        const navigationMatched = sameDocument && navigationStarts.length === 1
          && categories[starts.indexOf(navigationStarts[0])] === 'baseline';
        return {clickObserved:sameDocument && Number.isFinite(click),finalClickObserved,navigationMatched,categories};
      },{originalDocument,originalRoot,starts:starts.map(start => ({kind:start.kind,url:start.url,occurrence:start.occurrence,period:start.period,ambiguous:ambiguousStarts.has(start)})),final});
      connectClickObserved ||= evidence.clickObserved;
      quietTiming = {pending:0,ambiguous:0,missing:0,tie:0,unknown:0};
      for (const [index,category] of evidence.categories.entries()) {
        if (Object.hasOwn(quietTiming,category)) quietTiming[category]++;
        if (category !== 'baseline' && category !== 'post_click' && category !== 'pending' && !countedStarts.has(starts[index])) {
          countedStarts.add(starts[index]); network.quiet++;
        }
      }
      if (final) {
        finalDisconnectClickObserved = evidence.finalClickObserved;
        expect(finalDisconnectClickObserved).toBe(true);
        expect(evidence.navigationMatched).toBe(true);
        expect(Object.values(quietTiming).every(count => count === 0)).toBe(true);
      }
    }
    async function readAccounting(a,reopened,final = false) {
      await classifyStarts(final);
      expect(snapshots.length).toBe(reopened ? 2 : 1);
      expect(reads.length).toBe(snapshots.length*2);
      for (const [index,snapshot] of snapshots.entries()) {
        const latest = reads[index*2], stream = reads[index*2+1];
        expect(latest.path === `/v1/sessions/${a}/conversation` && latest.query.size === 0).toBe(true);
        expect(stream.path === `/v1/sessions/${a}/conversation/events` && stream.query.size === 1
          && stream.query.get('after') === snapshot.live_after).toBe(true);
      }
      expect(network).toEqual({create:1,task:1,other:0,settings:reopened ? 2 : 1,list:reopened ? 3 : 2,quiet:0});
    }

    async function latestReply(a,head) {
      const facts = replyFacts(); observed.latest.push(facts);
      const value = await readReply(page.waitForResponse(response => new URL(response.url()).pathname === `/v1/sessions/${a}/conversation`
        && new URL(response.url()).search === '' && response.request().method() === 'GET'),facts,
        value => validateConversationPage(value,{kind:'latest'},a),(value,status,fields) => status === 200
          && fields === JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g,'""').split(':').length-1
          && value.session_id === a && value.session.session_id === a && value.session.title === titles[0]
          && value.session.workspace === workspace && value.snapshot_head === head && value.session.head_sequence === head
          && value.live_after === `g11l.${Buffer.from(JSON.stringify([1,a,head,'3','',''])).toString('base64url')}`
          && value.earlier_activity === null && value.previous_block === null
          && (head !== '1' || (value.block === null && value.entries.length === 0)),524288);
      snapshots.push(value);
      return value;
    }

    stage = 'UI creation and matching head-one display observation';
    await page.goto(`${fixture.origin}/`);
    // Keep the original document identity without adding a clock or a browser-global hook.
    originalDocument = await page.evaluateHandle(() => document);
    originalRoot = await page.evaluateHandle(() => document.getElementById('app'));
    await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.getByRole('button',{name:'Connect',exact:true}).click(); await exact(status,'connected');
    expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    workspace = await page.getByLabel(/^Workspace/).inputValue();
    await page.getByLabel('Title',{exact:true}).fill(titles[0]);
    const [createdReply] = await Promise.all([
      readReply(page.waitForResponse(response => new URL(response.url()).pathname === '/v1/sessions'
        && response.request().method() === 'POST'),observed.create,validateCreateView,(value,status,fields) => status === 201
          && fields === 10 && value.receipt.operation_id === creation?.operation_id && value.session_id === value.receipt.session_id
          && value.receipt.run_id === null && value.receipt.first_sequence === '1' && value.receipt.last_sequence === '1'
          && value.duplicate === false && value.warning_code === null),
      page.getByRole('button',{name:'Create session',exact:true}).click(),
    ]);
    await expect(createCommand).toHaveCount(1);
    await exact(createCommand.locator('h3'),'create: accepted');
    await exact(createCommand.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${createdReply.receipt.operation_id}\nSession: ${createdReply.session_id}\nRun: none\nSequences: 1 to 1\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    const created = await fixture.inspectMutations();
    expect(created.session_count === 2 && created.seed_sessions === 1 && created.creations.length === 1).toBe(true);
    const c = created.creations[0];
    expect(c.exact && c.catalog_current && c.sequence_count === '1' && c.rename_events === 0 && c.receipt.operation_id === creation.operation_id
      && isDeepStrictEqual(c.receipt,createdReply.receipt)).toBe(true);
    const a = c.receipt.session_id;
    await page.getByRole('button',{name:'Refresh list',exact:true}).click(); await expect(sessionButton).toHaveCount(1);
    await fixture.request({command:'select',session_id:a});
    await Promise.all([latestReply(a,'1'),sessionButton.click()]);
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(status,'connected; observation: streaming'); await exact(transcript,'No messages yet.');
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true);

    stage = 'actual Task202 accepted before Disconnect at provider gate one';
    await taskField.fill('Edited before explicit Send'); await taskField.fill(TASK);
    const [acceptedReply] = await Promise.all([
      readReply(page.waitForResponse(response => response.url() === `${fixture.origin}/v1/sessions/${a}/runs`
        && response.request().method() === 'POST'),observed.task,
        value => validateDisplayTaskAccepted(value,{session_id:a,...submitted}),
        (value,status,fields) => status === 202 && fields === 10 && value.receipt.first_sequence === '2' && value.receipt.last_sequence === '3'
          && value.duplicate === false && value.warning_code === null && value.notices.length === 0),
      page.getByRole('button',{name:'Send',exact:true}).click(),
    ]);
    await fixture.wait('model_paused',1);
    const committed = await fixture.inspectTask(); const receipt = committed.receipt;
    expect(committed.exact && committed.run_state === 'running' && committed.sequence_count === '6').toBe(true);
    expect(submitted.path === `/v1/sessions/${a}/runs` && receipt.session_id === a
      && receipt.operation_id === submitted.operation_id && receipt.run_id === submitted.run_id).toBe(true);
    provider(await fixture.inspect(),1,0,0);
    expect(isDeepStrictEqual(acceptedReply.receipt,receipt)).toBe(true);
    await exact(transcript.locator('.entry [data-field] pre'),TASK);
    await exact(transcript.locator('.run > .metadata'),'Execution: running. Final result not recorded.');
    await exact(status,'connected; observation: streaming');
    await expect(page.locator('.command')).toHaveCount(2);
    await exact(taskCommand.locator('h3'),'task: accepted');
    await exact(taskCommand.locator('.metadata'),`Operation: ${receipt.operation_id}\nSession: ${a}`);
    await exact(taskCommand.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${a}\nRun: ${receipt.run_id}\nSequences: 2 to 3\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    await taskCommand.locator('summary').click(); await exact(taskCommand.locator('details pre'),TASK);
    await expect(taskCommand.getByRole('button',{name:'Retry identical command',exact:true})).toBeHidden();
    await expect(taskCommand.getByRole('button',{name:'Reconcile receipt (read only)',exact:true})).toBeVisible();
    await taskField.fill(DRAFT); expect(await taskField.inputValue() === DRAFT).toBe(true);

    stage = 'actual Disconnect clears accepted commands and DRAFT while native work remains running';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click(); quietPeriod = 1;
    await disconnectedTruth(); await readAccounting(a,false); provider(await fixture.inspect(),1,0,0);
    // Compare finite DOM snapshots only in memory; never save sensitive DOM as evidence.
    const disconnectedDOM = await page.locator('body').evaluate(node => node.outerHTML);

    stage = 'disconnected provider tool and final gates continue independently';
    await fixture.request({command:'drive',gate:1}); await fixture.wait('model_paused',2);
    provider(await fixture.inspect(),2,1,0); await disconnectedTruth();
    await fixture.request({command:'drive',gate:2}); await fixture.wait('model_paused',3); await disconnectedTruth();
    await fixture.request({command:'drive',gate:3}); await fixture.wait('task_finished',1);
    const finished = await fixture.inspect(); provider(finished,2,1,1);
    const final = await fixture.inspectTask();
    expect(final.exact && final.run_state === 'completed' && final.sequence_count === '20'
      && JSON.stringify(final.receipt) === JSON.stringify(receipt) && final.accepted_event_id === committed.accepted_event_id
      && final.checkpoint_event_id === committed.checkpoint_event_id).toBe(true);
    expect([final.task_commands,final.runs,final.acceptance_events,final.selection_events,final.binding_events,
      final.rename_events,final.deltas,final.tool_starts,final.tool_finishes]).toEqual([1,1,1,1,1,0,1,1,1]);
    expect(finished.provider_stage === 'finished' && finished.response_finishes.length === 2
      && finished.response_finishes.every(r => r.provenance === 'native_terminal') && finished.sequence_count === '20').toBe(true);
    expect(finished.terminal_sequences).toEqual(['19']); expect(finished.result_sequences).toEqual(['20']);
    await page.waitForTimeout(500); await disconnectedTruth(); await readAccounting(a,false);
    expect((await page.locator('body').evaluate(node => node.outerHTML)) === disconnectedDOM).toBe(true);

    stage = 'token reentry alone remains disconnected with the retained A hash';
    await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.waitForTimeout(500); await exact(status,'disconnected');
    expect(new URL(page.url()).hash === `#session=${a}` && !connectClickObserved).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    expect(await taskField.inputValue() === '').toBe(true);
    await readAccounting(a,false); provider(await fixture.inspect(),2,1,1);

    stage = 'explicit Connect reopens the retained A hash with reads only';
    // Authorize reads at the actual click, not during token entry or Playwright's action wait.
    const connect = page.getByRole('button',{name:'Connect',exact:true});
    await connect.evaluate(button => {
      const root = button.closest('#app');
      root.addEventListener('click',event => {
        if (event.target === button) root.disconnectQuietClickTime = performance.now();
      },{capture:true,once:true});
    });
    const [latest] = await Promise.all([latestReply(a,'20'),connect.click()]);
    await classifyStarts();
    expect(connectClickObserved && quietPeriod === 1).toBe(true);
    expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    expect(latest.block?.run_id === receipt.run_id && latest.block.accepted_sequence === '2'
      && latest.block.state === 'completed' && latest.block.result_recorded && latest.block.outcome?.type === 'completed'
      && latest.block.events_complete && latest.block.sink_error === null && latest.entries.length === 3).toBe(true);
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(conversation.locator(':scope > .metadata'),`Workspace: ${workspace}\nSession: ${a}`);
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
    expect(latest.block.summary !== null && latest.block.summary.turns_started === '2' && latest.block.summary.turns_finished === '2'
      && latest.block.summary.model_requests_attempted === '2' && latest.block.summary.model_requests_admitted === '2'
      && latest.block.summary.new_tool_dispatches === '1' && latest.block.summary.tool_results_prepared === '1'
      && latest.block.summary.reused_results === '0' && latest.block.summary.last_upstream_outcome === 'terminal_received').toBe(true);
    await exact(run.locator(':scope > details > pre'),`Run: ${receipt.run_id}\nAccepted sequence: 2\nOutcome: completed\nEvents complete: true\nSink error: none\n${Object.entries(latest.block.summary).map(([key,value]) => `${key}: ${value ?? 'none'}`).join('\n')}`);
    expect(new URL(page.url()).hash === `#session=${a}` && await taskField.inputValue() === '').toBe(true);
    await expect(page.locator('.command')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Cancel current run',exact:true})).toBeDisabled();
    await page.waitForTimeout(500); provider(await fixture.inspect(),2,1,1); await readAccounting(a,true); await privateBoundary();
    expect([observed.create,observed.task,...observed.latest].every(facts => facts.exact)).toBe(true);
    expect(assets.size).toBe(files.size);
    expect(await page.evaluate(checkEmbeddedAssets,{secrets:markers,
      files:await Promise.all([...files].map(async ([path,file]) => [path,[...await readFile(new URL(`../${file}`,import.meta.url))]]))})).toEqual({checked:9,failures:[]});

    stage = 'final Disconnect clears fresh display memory without cancellation';
    const disconnect = page.getByRole('button',{name:'Disconnect',exact:true});
    await disconnect.evaluate((button,{originalDocument,originalRoot}) => {
      if (document !== originalDocument || button.closest('#app') !== originalRoot) return;
      originalRoot.addEventListener('click',event => {
        if (event.target === button) Object.defineProperty(originalRoot,'disconnectQuietFinalClickTime',{
          value:performance.now(),configurable:true,
        });
      },{capture:true,once:true});
    },{originalDocument,originalRoot});
    await disconnect.click(); quietPeriod = 2; await disconnectedTruth();
    await readAccounting(a,true,true); provider(await fixture.inspect(),2,1,1);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch (cause) {
    // Never forward DOM, wire identities, inputs or raw exceptions to the Playwright recorder.
    const kind = ['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    const line = /task-disconnect-epoch\.spec\.mjs:(\d+):/.exec(cause?.stack ?? '')?.[1] ?? 'none';
    failure = new Error(`Disconnect epoch failed: ${stage}; kind=${kind} line=${line}; capture=${JSON.stringify(observed)}; disconnectedView=${JSON.stringify(disconnectedView)}; faults=${JSON.stringify(faults)}; network=${JSON.stringify(network)}; final_disconnect_click_observed=${finalDisconnectClickObserved}; quiet_timing=${JSON.stringify(quietTiming)}`);
  } finally {
    try { await originalRoot?.evaluate(root => {
      delete root.disconnectQuietClickTime; delete root.disconnectQuietFinalClickTime;
    }); } catch { failure ??= new Error('Disconnect epoch capture cleanup failed'); }
    try { await context?.close(); cleanup.browser = context !== undefined; } catch { failure ??= new Error('Disconnect epoch browser cleanup failed'); }
    // Keep the guard set if a failed close leaves the context accessible to Playwright.
    if (context === undefined || cleanup.browser) {
      if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
    }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; } catch { failure ??= new Error('Disconnect epoch fixture cleanup failed'); }
  }
  console.log(`Disconnect epoch cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  console.log(`Disconnect epoch evidence: contexts=1 creates=1 task_posts=1 accepted_before_disconnect=true A_running=6 A_final=20 chronological_activity=3 matching_latest_streams=2 assets=9 disconnected_quiet_ms=500 token_entry_inert_ms=500 reopened_stable_ms=500 connect_click_observed=${connectClickObserved} final_disconnect_click_observed=${finalDisconnectClickObserved} quiet_timing=${JSON.stringify(quietTiming)} provider_connections=1 provider_requests=2 tools=1 results=1 cancel_retry_reconcile_other=0 retained_hash=true explicit_reconnect=true; replies=${JSON.stringify(observed)}`);
});
