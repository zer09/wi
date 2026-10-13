import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { isDeepStrictEqual } from 'node:util';
import { decodeJson, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';

const { titles } = JSON.parse(await readFile(new URL('../test-support/mutations.json',import.meta.url),'utf8'));
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n'; // Exact browser.rs TASKS[0].
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const ARGUMENTS = '{"a":17,\r\n "b":25}';
const OUTPUT = '{"sum":42}';
const DRAFT = 'Unsent before full reload 雪\n<em>inert</em>\n';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({trace:'off',screenshot:'off',video:'off'});

test('full reload epoch: accepted native work survives two documents; explicit Connect reads durable display A', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture; let context; let page; let failure;
  function replyFacts() { return {acquired:false,status:null,body_attempted:false,body_rejected:false,body_rejection_class:null,request_terminal_pre_body:null,request_terminal_post_body:null,h20_progress_pre_body:null,h20_progress_post_body:null,body_returned:false,body_bounded:false,decoded:false,validated:false,exact:false}; }
  let stage = 'startup'; let disconnectedView = null;
  const observed = {create:replyFacts(),task:replyFacts(),latest:[],reconnect:{latest:'not_started',click:'not_started',first_rejection:null}};
  const cleanup = {request_listeners:false,browser:false,fixture:false};
  const finishedRequests = new WeakSet(); const failedRequests = new WeakSet();
  const onRequestFinished = request => { finishedRequests.add(request); };
  const onRequestFailed = request => { failedRequests.add(request); };
  let requestListenersStarted = false;
  const faults = {external:0,request:0,response:0,console:0,page:0,private:0,asset:0};
  const network = {create:0,task:0,task202:0,cancel:0,rename:0,otherMutation:0,reconcile:0,otherRead:0,settings:0,list:0,quietApi:0,public:[0,0]};
  const reads = []; const snapshots = []; const assetChecks = []; const assets = [new Set(),new Set()];
  let creation = null; let submitted = null; let workspace; let load = 0; let quiet = false;
  let expectedH20 = null; let h20Progress = null; let firstFailureH20 = null;
  function h20ProgressSnapshot() { return expectedH20 === null ? null : Object.freeze({stream_request_observed:h20Progress}); }
  try {
    fixture = await startFixture(executable,{transport:'websocket',recovered:false,mime:true,mutations:true});
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    context = await browser.newContext({serviceWorkers:'block'});
    const markers = ['synthetic-replay-','synthetic-account-','private-operator-','private-project-','private-skill-',
      'private-native','private-data','private-skills','principal_digest','history_digest','encrypted_content',
      'opaque_response','provider_session_id','prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
    function bodyRejectionClass(reason) {
      if (reason === null || (typeof reason !== 'object' && typeof reason !== 'function')) return 'other';
      let message, name;
      try {
        message = Object.getOwnPropertyDescriptor(reason,'message');
        name = Object.getOwnPropertyDescriptor(reason,'name');
      } catch { return 'other'; }
      // Inspect data only: accessors and descriptor traps must not replace the original rejection.
      if ((message && (!Object.hasOwn(message,'value') || typeof message.value !== 'string'))
        || (name && (!Object.hasOwn(name,'value') || typeof name.value !== 'string'))) return 'other';
      let text = message?.value ?? '';
      if (text.startsWith('response.body: ')) text = text.slice('response.body: '.length);
      // Only a complete leading marker can match; private suffixes start on a new line.
      const leading = marker => text === marker || text.startsWith(marker+'\n') || text.startsWith(marker+'\r\n');
      const getBody = 'Protocol error (Network.getResponseBody): ';
      if (text.startsWith(getBody)) {
        text = text.slice(getBody.length);
        if (leading('No resource with given identifier found')) return 'get_response_body_no_resource';
        if (leading('No data found for resource with given identifier')) return 'get_response_body_no_data';
        if (leading('Request content was evicted from inspector cache')) return 'get_response_body_evicted';
        return 'method_get_response_body';
      }
      if (text.startsWith('Protocol error (Network.loadNetworkResource): ')) return 'method_load_network_resource';
      if (text.startsWith('Protocol error (IO.read): ')) return 'method_io_read';
      if (text.startsWith('Protocol error (IO.close): ')) return 'method_io_close';
      if (leading('Target page, context or browser has been closed')) return 'target_closed';
      // Playwright appends crash logs after this space, rather than a complete sentence.
      if (text === 'Target crashed' || text.startsWith('Target crashed ')) return 'target_crashed';
      if (/^Timeout [0-9]+(?:\.[0-9]+)?ms exceeded\.(?:$|\n|\r\n)/.test(text) || name?.value === 'TimeoutError') return 'timeout';
      if (leading('The object has been collected to prevent unbounded heap growth.')) return 'collected';
      if (leading('Response body is unavailable for redirect responses')) return 'redirect_body_unavailable';
      return 'other';
    }
    function requestFailureClass(request) {
      try {
        // The SDK method is on the immediate prototype. Never walk the chain or invoke a getter.
        const method = Object.getOwnPropertyDescriptor(request,'failure')
          ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(request),'failure');
        if (!method || !Object.hasOwn(method,'value') || typeof method.value !== 'function') return 'unavailable';
        const failure = Reflect.apply(method.value,request,[]);
        if (failure === null) return 'not_reported';
        if (typeof failure !== 'object' && typeof failure !== 'function') return 'other_failure';
        const descriptor = Object.getOwnPropertyDescriptor(failure,'errorText');
        if (!descriptor || !Object.hasOwn(descriptor,'value') || typeof descriptor.value !== 'string') return 'other_failure';
        // Only a complete leading SDK marker counts, not a category hidden in private suffix text.
        const match = /^net::(ERR_ABORTED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_ABORTED|ERR_CONTENT_LENGTH_MISMATCH|ERR_INCOMPLETE_CHUNKED_ENCODING)(?:$| Canceled(?:$|\n|\r\n)|\n|\r\n)/.exec(descriptor.value);
        if (!match) return 'other_failure';
        switch (match[1]) {
          case 'ERR_ABORTED': return 'aborted';
          case 'ERR_CONNECTION_RESET': return 'connection_reset';
          case 'ERR_CONNECTION_CLOSED': return 'connection_closed';
          case 'ERR_CONNECTION_REFUSED': return 'connection_refused';
          case 'ERR_CONNECTION_ABORTED': return 'connection_aborted';
          case 'ERR_CONTENT_LENGTH_MISMATCH': return 'content_length_mismatch';
          case 'ERR_INCOMPLETE_CHUNKED_ENCODING': return 'incomplete_chunked_encoding';
        }
      } catch { return 'unavailable'; }
    }
    function requestTerminal(request) {
      if (request === null || (typeof request !== 'object' && typeof request !== 'function')) return null;
      // These are SDK callback observations. Missing callbacks or null failure text do not prove success.
      return Object.freeze({requestfinished_observed:finishedRequests.has(request),requestfailed_observed:failedRequests.has(request),failure_class:requestFailureClass(request)});
    }
    function observeH20Progress(request,url,headers) {
      if (expectedH20 === null || h20Progress === null) return;
      try {
        if (url.origin !== fixture.origin || url.username !== '' || url.password !== '' || url.hash !== ''
          || url.pathname !== expectedH20.path || request.method() !== 'GET' || url.searchParams.size !== 1
          || url.searchParams.get('after') !== expectedH20.after || headers.authorization !== `Bearer ${fixture.owner}`
          || headers.cookie !== undefined || (headers.origin !== undefined && headers.origin !== fixture.origin)) return;
        const frame = request.frame();
        // Page/Frame identity only binds this callback. The preserved reload/quiet flow attributes the Document.
        if (frame === page.mainFrame() && frame.page() === page) h20Progress = true;
      } catch { if (h20Progress !== true) h20Progress = null; } // Observation cannot replace the original failure.
    }
    async function readReply(promise, facts, validator, check, limit = 4096, targetH20 = false) {
      const response = await promise;
      facts.acquired = true;
      const status = response.status();
      facts.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      let request;
      try { request = response.request(); } catch {} // Observation must not replace a body rejection.
      facts.request_terminal_pre_body = requestTerminal(request);
      facts.body_attempted = true;
      let bytes;
      facts.h20_progress_pre_body = targetH20 ? h20ProgressSnapshot() : null;
      try { bytes = await response.body(); } catch (reason) { facts.h20_progress_post_body = targetH20 ? h20ProgressSnapshot() : null; facts.body_rejected = true; facts.body_rejection_class = bodyRejectionClass(reason); facts.request_terminal_post_body = requestTerminal(request); throw reason; }
      facts.h20_progress_post_body = targetH20 ? h20ProgressSnapshot() : null;
      facts.request_terminal_post_body = requestTerminal(request);
      facts.body_returned = true;
      expect(bytes.byteLength <= limit).toBe(true);
      facts.body_bounded = true;
      const raw = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      // Public field IDs remain subject to closed display validation and exact field checks.
      if (raw.includes(fixture.owner) || markers.some(marker => raw.includes(marker))
        || (limit === 4096 && /[0-9a-f]{64}/i.test(raw))) faults.private++;
      const value = decodeJson(raw,response.headers()['content-type'],parsed => {
        facts.decoded = true;
        return validator(parsed);
      });
      facts.validated = true;
      // Count separators outside strings so repeated JSON keys cannot pass exact decoding.
      const fields = raw.replace(/"(?:\\.|[^"\\])*"/g,'""').split(':').length-1;
      expect(check(value,status,fields)).toBe(true);
      facts.exact = true;
      return value;
    }
    const files = new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    await context.route('**/*',async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { faults.external++; await route.abort(); }
      else await route.continue(); // The actual Rust service supplies every joined response.
    });
    const bytes = new Map(await Promise.all([...files].map(async ([path,file]) => [path,await readFile(new URL(`../${file}`,import.meta.url))])));
    context.on('request',request => {
      const url = new URL(request.url()); const headers = request.headers();
      observeH20Progress(request,url,headers);
      if (url.origin !== fixture.origin) faults.external++;
      if (leaked(request.url())) faults.private++;
      if (!url.pathname.startsWith('/v1/')) {
        network.public[load]++;
        if (!files.has(url.pathname) || request.method() !== 'GET' || url.search !== ''
          || headers.authorization !== undefined || headers.cookie !== undefined) faults.request++;
        return;
      }
      if (quiet) network.quietApi++;
      if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
        || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
      if (request.method() === 'GET') {
        if (url.pathname === '/v1/settings' && url.search === '') network.settings++;
        else if (url.pathname === '/v1/sessions' && url.search === '?limit=32') network.list++;
        else if (/\/operations\//.test(url.pathname) || /\/runs\//.test(url.pathname)) network.reconcile++;
        else if (/^\/v1\/sessions\/[0-9a-f-]{36}\/conversation(\/events)?$/.test(url.pathname) && reads.length < 4) reads.push({path:url.pathname,query:url.searchParams});
        else network.otherRead++;
        return;
      }
      if (request.method() !== 'POST' || url.search !== '') {network.otherMutation++; return;}
      if (url.pathname.endsWith('/cancel')) {network.cancel++; return;}
      if (url.pathname.endsWith('/rename')) {network.rename++; return;}
      if (url.pathname !== '/v1/sessions' && !/^\/v1\/sessions\/[0-9a-f-]{36}\/runs$/.test(url.pathname)) {network.otherMutation++; return;}
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
    context.on('response',response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 300) faults.response++;
      if (response.request().method() === 'POST' && path.endsWith('/runs') && response.status() === 202) network.task202++;
      if (!files.has(path)) return;
      const documentLoad = load;
      if (assetChecks.length >= 18) {faults.asset++; return;}
      assetChecks.push((async () => {
        const headers = response.headers();
        let mime = 'text/javascript; charset=utf-8';
        if (path === '/') mime = 'text/html; charset=utf-8';
        if (path.endsWith('.css')) mime = 'text/css; charset=utf-8';
        const actual = await response.body();
        if (response.status() !== 200 || !actual.equals(bytes.get(path)) || leaked(actual.toString('utf8'))
          || headers['content-type'] !== mime || headers['cache-control'] !== 'no-store'
          || headers['x-content-type-options'] !== 'nosniff' || headers['referrer-policy'] !== 'no-referrer'
          || (path === '/' && headers['content-security-policy'] !== "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")) faults.asset++;
        if (assets[documentLoad].has(path)) faults.asset++;
        assets[documentLoad].add(path);
      })().catch(() => {faults.asset++;}));
    });
    page = await context.newPage();
    requestListenersStarted = true;
    page.on('requestfinished',onRequestFinished);
    page.on('requestfailed',onRequestFailed);
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
        inert:['.layout','.commands'].every(selector => document.querySelector(selector).hidden),
      }),a);
      expect(disconnectedView).toEqual({hashRetained:true,rowsEmpty:true,fieldsEmpty:true,settingsEmpty:true,inert:true});
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
    function readAccounting(a,reopened) {
      expect(snapshots.length).toBe(reopened ? 2 : 1);
      expect(reads.length).toBe(snapshots.length*2);
      for (const [index,snapshot] of snapshots.entries()) {
        const latest = reads[index*2], stream = reads[index*2+1];
        expect(latest.path === `/v1/sessions/${a}/conversation` && latest.query.size === 0).toBe(true);
        expect(stream.path === `/v1/sessions/${a}/conversation/events` && stream.query.size === 1
          && stream.query.get('after') === snapshot.live_after).toBe(true);
      }
      expect(network).toEqual({create:1,task:1,task202:1,cancel:0,rename:0,otherMutation:0,reconcile:0,otherRead:0,
        settings:reopened ? 2 : 1,list:reopened ? 3 : 2,quietApi:0,public:load === 0 ? [9,0] : [9,9]});
    }
    function observeReconnect(promise,branch) {
      observed.reconnect[branch] = 'pending';
      return promise.then(value => {
        observed.reconnect[branch] = 'fulfilled';
        return value;
      },reason => {
        observed.reconnect[branch] = 'rejected';
        // This is the first local handler, not a claim about the underlying cause or SDK order.
        observed.reconnect.first_rejection ??= branch;
        throw reason;
      });
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
          && (head !== '1' || (value.block === null && value.entries.length === 0)),524288,head === '20');
      snapshots.push(value);
      return value;
    }

    stage = 'UI creation and matching head-one display observation';
    await page.goto(`${fixture.origin}/`); await exact(status,'disconnected');
    expect(network.settings + network.list).toBe(0);
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
    await expect(createCommand).toHaveCount(1); await exact(createCommand.locator('h3'),'create: accepted');
    await exact(createCommand.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${createdReply.receipt.operation_id}\nSession: ${createdReply.session_id}\nRun: none\nSequences: 1 to 1\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    const created = await fixture.inspectMutations();
    expect(created.session_count === 2 && created.seed_sessions === 1 && created.creations.length === 1).toBe(true);
    const c = created.creations[0];
    expect(c.exact && c.catalog_current && c.sequence_count === '1' && c.rename_events === 0 && c.receipt.operation_id === creation.operation_id
      && isDeepStrictEqual(c.receipt,createdReply.receipt) && c.receipt.session_id !== creation.operation_id).toBe(true);
    const a = c.receipt.session_id;
    await page.getByRole('button',{name:'Refresh list',exact:true}).click(); await expect(sessionButton).toHaveCount(1);
    await fixture.request({command:'select',session_id:a});
    await Promise.all([latestReply(a,'1'),sessionButton.click()]);
    await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),titles[0]);
    await exact(status,'connected; observation: streaming'); await exact(transcript,'No messages yet.');
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true);
    await Promise.all(assetChecks); expect(assets[0].size === 9 && faults.asset === 0).toBe(true);

    stage = 'actual Task202 accepted before full reload at provider gate one';
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
      && receipt.operation_id === submitted.operation_id && receipt.run_id === submitted.run_id
      && receipt.first_sequence === '2' && receipt.last_sequence === '3' && a !== submitted.operation_id && a !== submitted.run_id).toBe(true);
    provider(await fixture.inspect(),1,0,0);
    expect(isDeepStrictEqual(acceptedReply.receipt,receipt)).toBe(true);
    await exact(transcript.locator('.entry [data-field] pre'),TASK);
    await exact(transcript.locator('.run > .metadata'),'Execution: running. Final result not recorded.');
    await exact(status,'connected; observation: streaming');
    await expect(page.locator('.command')).toHaveCount(2); await exact(taskCommand.locator('h3'),'task: accepted');
    await exact(taskCommand.locator('.metadata'),`Operation: ${receipt.operation_id}\nSession: ${a}`);
    await exact(taskCommand.locator(':scope > pre'),`Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${a}\nRun: ${receipt.run_id}\nSequences: 2 to 3\n\nWarning: none; duplicate: false\n\nAccepted is not completed.`);
    await taskCommand.locator('summary').click(); await exact(taskCommand.locator('details pre'),TASK);
    await expect(taskCommand.getByRole('button',{name:'Retry identical command',exact:true})).toBeHidden();
    await expect(taskCommand.getByRole('button',{name:'Reconcile receipt (read only)',exact:true})).toBeVisible();
    await taskField.fill(DRAFT); expect(await taskField.inputValue() === DRAFT).toBe(true);
    readAccounting(a,false); await privateBoundary();
    const oldDocument = await page.evaluateHandle(() => document);

    stage = 'actual full reload retires the accepted first document';
    load = 1; quiet = true;
    await page.reload();
    let oldDocumentUnavailable = false;
    try { await oldDocument.evaluate(node => node === document); } catch { oldDocumentUnavailable = true; }
    expect(oldDocumentUnavailable).toBe(true); await oldDocument.dispose();
    await disconnectedTruth(); readAccounting(a,false); provider(await fixture.inspect(),1,0,0);
    await Promise.all(assetChecks); expect(assets[1].size === 9 && faults.asset === 0).toBe(true);
    const disconnectedDOM = await page.locator('body').evaluate(node => node.outerHTML);

    stage = 'disconnected second document stays API-idle through real tools and final durable recording';
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
    await page.waitForTimeout(500); await disconnectedTruth(); readAccounting(a,false);
    expect((await page.locator('body').evaluate(node => node.outerHTML)) === disconnectedDOM).toBe(true);

    stage = 'token entry alone cannot authorize retained-hash reads';
    await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.waitForTimeout(500); await exact(status,'disconnected');
    expect(new URL(page.url()).hash === `#session=${a}`).toBe(true);
    expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
    expect(await taskField.inputValue() === '').toBe(true);
    readAccounting(a,false); provider(await fixture.inspect(),2,1,1);

    stage = 'explicit Connect reads retained A exactly once without command recovery or resubmission';
    quiet = false;
    expectedH20 = Object.freeze({path:`/v1/sessions/${a}/conversation/events`,after:`g11l.${Buffer.from(JSON.stringify([1,a,'20','3','',''])).toString('base64url')}`}); h20Progress = false;
    const [latest] = await Promise.all([observeReconnect(latestReply(a,'20'),'latest'),observeReconnect(page.getByRole('button',{name:'Connect',exact:true}).click(),'click')]);
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
    await page.waitForTimeout(500); provider(await fixture.inspect(),2,1,1); readAccounting(a,true); await privateBoundary();
    stage = 'unchanged durable task audit after explicit Connect';
    const afterConnect = await fixture.inspectTask();
    // The control envelope gets a new request id; every durable audit field must stay identical.
    expect(Object.keys(final).every(key => key === 'id' || JSON.stringify(afterConnect[key]) === JSON.stringify(final[key]))).toBe(true);
    expect([observed.create,observed.task,...observed.latest].every(facts => facts.exact)).toBe(true);
    expect(assets.map(set => set.size)).toEqual([9,9]); expect(Object.values(faults)).toEqual(Array(7).fill(0));
  } catch {
    // Do not forward wire data, DOM, inputs or raw exceptions to Playwright's recorder.
    firstFailureH20 = h20ProgressSnapshot();
    failure = new Error(`Reload epoch failed: ${stage}; capture=${JSON.stringify(observed)}; disconnectedView=${JSON.stringify(disconnectedView)}; faults=${JSON.stringify(faults)}; network=${JSON.stringify(network)}; h20Progress=${JSON.stringify(firstFailureH20)}`);
  } finally {
    cleanup.request_listeners = true;
    if (requestListenersStarted) {
      try { page.off('requestfinished',onRequestFinished); } catch { cleanup.request_listeners = false; failure ??= new Error('Reload epoch request listener cleanup failed'); }
      try { page.off('requestfailed',onRequestFailed); } catch { cleanup.request_listeners = false; failure ??= new Error('Reload epoch request listener cleanup failed'); }
    }
    try { await context?.close(); cleanup.browser = context !== undefined; } catch { failure ??= new Error('Reload epoch browser cleanup failed'); }
    // A failed close can leave the page available to the installed failure recorder.
    if (context === undefined || cleanup.browser) {
      if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
    }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; } catch { failure ??= new Error('Reload epoch fixture cleanup failed'); }
  }
  console.log(`Reload epoch cleanup: browser=${cleanup.browser} fixture=${cleanup.fixture} request_listeners=${cleanup.request_listeners}`);
  const lateH20Progress = Object.freeze({pre:observed.latest[1]?.h20_progress_pre_body ?? null,post:observed.latest[1]?.h20_progress_post_body ?? null,first_failure:firstFailureH20,late:h20ProgressSnapshot()});
  console.log(`Reload epoch H20 progress: ${JSON.stringify(lateH20Progress)}`);
  if (failure) throw failure;
  // Include context shutdown in the totals, not only the last rendered snapshot.
  expect(network).toEqual({create:1,task:1,task202:1,cancel:0,rename:0,otherMutation:0,reconcile:0,otherRead:0,
    settings:2,list:3,quietApi:0,public:[9,9]});
  expect(Object.values(faults)).toEqual(Array(7).fill(0));
  console.log('Reload epoch evidence: documents=2 reloads=1 creates=1 task_posts=1 actual_202_validated_before_reload=true old_document_unavailable=true public_gets=9+9 disconnected_api=0 matching_latest=1+20 display_rows=4 A_final=20 provider_connections=1 provider_requests=2 tools=1 results=1 cancel_retry_reconcile_other=0 retained_hash=true explicit_connect=true' + ` reconnect_latest=${observed.reconnect.latest} reconnect_click=${observed.reconnect.click} first_local_rejection=${observed.reconnect.first_rejection} request_terminal=${JSON.stringify({create:{pre:observed.create.request_terminal_pre_body,post:observed.create.request_terminal_post_body},task:{pre:observed.task.request_terminal_pre_body,post:observed.task.request_terminal_post_body},latest:observed.latest.map(facts => ({pre:facts.request_terminal_pre_body,post:facts.request_terminal_post_body}))})}`);
});
