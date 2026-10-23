import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { decodeJson, validateRenameCommand, validateTaskCommand, validateRenameView, validateUuid } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';

const TITLE = 'Fixed head 65';
const RENAMED = 'Fixed head renamed 雪 <em>inert</em>';
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n';
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const ARGUMENTS = '{"a":17,\r\n "b":25}';
const OUTPUT = '{"sum":42}';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace:'off', screenshot:'off', video:'off' });

// This is supplied display data, not a reconstruction of canonical events.
function expectedBlock(page) {
  const block = page.block;
  const recording = [`Run: ${block.run_id}`, `Accepted sequence: ${block.accepted_sequence}`,
    `Outcome: ${block.outcome?.type ?? 'not recorded'}`, `Events complete: ${block.events_complete ?? 'not recorded'}`,
    `Sink error: ${block.sink_error ?? 'none'}`, block.summary === null ? 'Summary not recorded.'
      : Object.entries(block.summary).map(([key,value]) => `${key}: ${value ?? 'none'}`).join('\n')].join('\n');
  return { run_id:block.run_id, status:`Execution: ${block.state}. Final result ${block.result_recorded ? 'recorded' : 'not recorded'}.`,
    recording, entries:[block.human,...page.entries].map(entry => {
      const state = [`Recorded state: ${entry.recorded_state}`, `Provisional: ${entry.provisional}`];
      for (const key of ['result_recorded','finish_recorded','is_error']) if (entry[key] !== null) state.push(`${key}: ${entry[key]}`);
      return { entry_id:entry.entry_id, kind:entry.kind === 'human' ? 'Human' : entry.kind, state:state.join('; '),
        fields:entry.fields.map(field => ({ field_id:field.field_id, kind:field.kind,
          metadata:`Recorded bytes: ${field.total_bytes}; generation: ${field.generation}`, text:[field.text] })) };
    }) };
}
async function displayedBlock(run) {
  return run.evaluate(node => ({ run_id:node.dataset.run, status:node.querySelector(':scope > .metadata').textContent,
    recording:node.querySelector(':scope > details > pre').textContent,
    entries:Array.from(node.querySelectorAll('.entry'), entry => ({ entry_id:entry.dataset.entry,
      kind:entry.querySelector('h4').textContent, state:entry.querySelector(':scope > .metadata').textContent,
      fields:Array.from(entry.querySelectorAll('[data-field]'), field => ({ field_id:field.dataset.field,
        kind:field.querySelector('h5,summary').textContent, metadata:field.querySelector('.metadata').textContent,
        text:Array.from(field.querySelectorAll('pre'), content => content.textContent) })) })) }));
}
function failureKind(cause) {
  const name = cause && typeof cause === 'object' ? Object.getOwnPropertyDescriptor(cause,'name')?.value : undefined;
  if (['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(name)) return name;
  if (cause instanceof Error) return 'Error';
  return 'other';
}

test('matching H66 display snapshot and held original SSE converge across two real clients', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture; let contextA; let contextB; let release; let failure;
  let stage = 'startup'; let check = 'outside';
  let audit = null; let paused = false; let continued = false;
  const faults = { external:0,request:0,response:0,console:0,page:0,private:0,collector:0 };
  const network = ['A','B'].map(() => ({ settings:0,list:0,manifest:0,latest:0,events:0,rename:0,task:0,other:0 }));
  const observed = { snapshots:0,handshakes:0,receipts:0,display_proofs:0,barriers:0 };
  const cleanup = { a:false,b:false,fixture:false };
  try {
    fixture = await startFixture(executable, { transport:'websocket',recovered:false,mime:true,mutations:true,fixed_head:true });
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    contextA = await browser.newContext({ serviceWorkers:'block' });
    contextB = await browser.newContext({ serviceWorkers:'block' });
    const sid = fixture.sessionId, path = `/v1/sessions/${sid}`;
    const after = `g11l.${Buffer.from(JSON.stringify([1,sid,'66','3','',''])).toString('base64url')}`;
    const markers = ['synthetic-replay-','synthetic-account-','private-operator-','private-project-','private-skill-',
      'private-native','private-data','private-skills','principal_digest','history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(marker => text.includes(marker));
    const files = new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    const assetSets = [new Set(),new Set()], assetReads = [], handshakes = [[],[]];
    const commands = { rename:null,task:null }, receipts = { rename:null,task:null };
    const hold = new Promise(resolve => { release = resolve; });
    const pages = [];
    for (const [index,context] of [contextA,contextB].entries()) {
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixture.origin) { faults.external++; await route.abort(); return; }
        if (url.pathname === `${path}/conversation/events`) {
          try {
            const page = pages[index];
            // The original request boundary sees the already installed empty display, not a raw prefix.
            const installed = await page.evaluate(title => document.querySelector('.conversation > h2')?.textContent === title
              && document.querySelector('.transcript')?.textContent === 'No messages yet.' && document.querySelectorAll('.run').length === 0, TITLE);
            if (!installed || handshakes[index].join(',') !== 'snapshot,stream') faults.request++;
            else observed.handshakes++;
          } catch { faults.collector++; }
          if (index === 0) { paused = true; await hold; continued = true; }
        }
        // Hold and forward this original request only. Never fulfill or substitute a response.
        await route.continue();
      });
      context.on('request', request => {
        try {
          const url = new URL(request.url()), method = request.method(), n = network[index];
          if (url.origin !== fixture.origin) faults.external++;
          if (leaked(request.url())) faults.private++;
          if (!url.pathname.startsWith('/v1/')) {
            if (method !== 'GET' || !files.has(url.pathname) || url.search !== '') faults.request++;
            return;
          }
          const headers = request.headers();
          if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
            || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
          if (method === 'GET') {
            if (url.pathname === '/v1/settings' && url.search === '') n.settings++;
            else if (url.pathname === '/v1/sessions' && url.search === '?limit=32') n.list++;
            else if (url.pathname === path && url.search === '' && index === 1 && commands.rename !== null) n.manifest++;
            else if (url.pathname === `${path}/conversation` && url.search === '') n.latest++;
            else if (url.pathname === `${path}/conversation/events`) {
              n.events++;
              const cursor = parseDisplayCursor(url.searchParams.get('after'),'live',sid);
              if (url.search !== `?after=${encodeURIComponent(after)}` || cursor.sequence !== '66' || cursor.rank !== '3') faults.request++;
              handshakes[index].push('stream');
            } else n.other++;
          } else if (method === 'POST') {
            let kind;
            if (url.pathname === `${path}/rename`) kind = 'rename';
            else if (url.pathname === `${path}/runs`) kind = 'task';
            else { n.other++; return; }
            n[kind]++;
            if (index !== 1 || url.search !== '' || n[kind] !== 1 || !paused || continued
              || headers['content-type'] !== 'application/json') faults.request++;
            const raw = request.postDataBuffer();
            if (raw === null || raw.byteLength > 4096 || leaked(raw.toString('utf8'))) throw new Error();
            const body = JSON.parse(raw.toString('utf8'));
            commands[kind] = kind === 'rename' ? validateRenameCommand(body) : validateTaskCommand(body);
            if (kind === 'rename' ? body.title !== RENAMED : body.text !== TASK) faults.request++;
          } else n.other++;
        } catch { faults.collector++; }
      });
      context.on('response', response => {
        try {
          const url = new URL(response.url());
          if (response.status() >= 300) faults.response++;
          if (url.pathname === `${path}/conversation` && url.search === '') handshakes[index].push('snapshot');
          const file = files.get(url.pathname);
          if (file === undefined) return;
          assetReads.push((async () => {
            const bytes = await response.body(), headers = response.headers();
            let mime = 'text/javascript; charset=utf-8';
            if (url.pathname === '/') mime = 'text/html; charset=utf-8';
            else if (url.pathname.endsWith('.css')) mime = 'text/css; charset=utf-8';
            if (response.status() !== 200 || !bytes.equals(await readFile(new URL(`../${file}`,import.meta.url)))
              || headers['x-content-type-options'] !== 'nosniff' || !headers['cache-control']?.includes('no-store')
              || (url.pathname === '/' && !headers['content-security-policy']) || headers['referrer-policy'] !== 'no-referrer'
              || headers['content-type'] !== mime) faults.response++;
            if (leaked(bytes.toString('utf8'))) faults.private++;
            assetSets[index].add(url.pathname);
          })().catch(() => { faults.collector++; }));
        } catch { faults.collector++; }
      });
      const page = await context.newPage(); pages.push(page);
      page.on('console', message => {
        try { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.private++; }
        catch { faults.collector++; }
      });
      page.on('pageerror', () => { faults.page++; });
    }
    const [a,b] = pages;
    const status = page => page.locator('.topbar [role="status"]');
    const transcript = page => page.getByRole('region',{name:'Canonical conversation',exact:true});
    async function readReply(response, statusCode, validate, limit=512*1024) {
      expect(response.status() === statusCode).toBe(true);
      const bytes = await response.body(); expect(bytes.length <= limit).toBe(true);
      return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),response.headers()['content-type'],validate);
    }
    async function connect(page) {
      await page.goto(`${fixture.origin}/`);
      await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
      await page.getByRole('button',{name:'Connect',exact:true}).click(); await exact(status(page),'connected');
      expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    }
    async function select(page) {
      const [reply] = await Promise.all([
        page.waitForResponse(response => response.url() === `${fixture.origin}${path}/conversation` && response.request().method() === 'GET'),
        page.getByRole('button',{name:TITLE,exact:true}).click(),
      ]);
      const value = await readReply(reply,200,v => validateConversationPage(v,{kind:'latest'},sid));
      expect(value.snapshot_head === '66' && value.session.title === TITLE && value.block === null && value.entries.length === 0
        && value.previous_block === null && value.earlier_activity === null && value.live_after === after).toBe(true);
      observed.snapshots++;
      await exact(transcript(page),'No messages yet.');
      expect(new URL(page.url()).hash === `#session=${sid}`).toBe(true);
    }
    async function boundary(page,context) {
      const safe = await page.evaluate(async ({owner,markers}) => {
        const dom = document.documentElement.cloneNode(true);
        // Only validated public field IDs leave the detached privacy scan.
        for (const field of dom.querySelectorAll('[data-field]')) {
          const id = field.getAttribute('data-field');
          if (!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return false;
          field.removeAttribute('data-field');
        }
        const values = [dom.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '' && (await indexedDB.databases()).length === 0
          && (await caches.keys()).length === 0 && (await navigator.serviceWorker.getRegistrations()).length === 0
          && values.every(value => !value || (!value.includes(owner) && !/[0-9a-f]{64}/i.test(value) && !markers.some(marker => value.includes(marker))));
      },{owner:fixture.owner,markers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run em,.run img,.run svg,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function displayProof(head) {
      // Independent typed HTTP at a stable producer barrier, not original browser-byte capture or a new attach cursor.
      const reply = await fetch(`${fixture.origin}${path}/conversation`, { headers:{Authorization:`Bearer ${fixture.owner}`},redirect:'error' });
      const bytes = new Uint8Array(await reply.arrayBuffer()); expect(reply.status === 200 && bytes.length <= 512*1024).toBe(true);
      const value = decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),reply.headers.get('content-type'),
        v => validateConversationPage(v,{kind:'latest'},sid));
      if (head !== undefined) expect(value.snapshot_head === head).toBe(true);
      expect(value.session.title === RENAMED && value.block.run_id === commands.task.run_id && value.block.accepted_sequence === '68'
        && value.block.human.entry_id === 'e:68:0' && value.earlier_activity === null
        && value.entries.every(entry => entry.content_complete && entry.earlier_content === null)).toBe(true);
      observed.display_proofs++;
      return value;
    }
    async function parity(value) {
      const expected = expectedBlock(value);
      for (const page of pages) {
        await exact(status(page),'connected; observation: streaming');
        await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),RENAMED);
        expect(await transcript(page).locator('.run').count()).toBe(1);
        await expect.poll(async () => isDeepStrictEqual(await displayedBlock(transcript(page).locator('.run')),expected)).toBe(true);
      }
      expect(isDeepStrictEqual(await displayedBlock(transcript(a).locator('.run')),await displayedBlock(transcript(b).locator('.run')))).toBe(true);
      observed.barriers++;
    }
    async function commandTruth() {
      expect(await a.locator('.command').count()).toBe(0); expect(await b.locator('.command').count()).toBe(2);
      for (const kind of ['rename','task']) {
        const article = b.locator('.command').filter({has:b.getByRole('heading',{name:`${kind}: accepted`,exact:true})});
        const receipt = receipts[kind];
        await exact(article.locator('details pre'),kind === 'task' ? TASK : RENAMED);
        await exact(article.locator(':scope > .metadata'),`Operation: ${commands[kind].operation_id}\nSession: ${sid}`);
        let text = `Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${sid}\nRun: ${receipt.run_id ?? 'none'}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}\n\nWarning: none; duplicate: false`;
        if (kind === 'rename') text += '\n\nIndependent catalog refresh: updated';
        await exact(article.locator(':scope > pre'),`${text}\n\nAccepted is not completed.`);
        expect(await article.getByRole('button',{name:'Retry identical command',exact:true}).isVisible()).toBe(false);
      }
    }
    async function quiet() {
      const {id:_id,...current} = await fixture.inspect(); expect(isDeepStrictEqual(current,audit)).toBe(true);
      expect(isDeepStrictEqual(network,[
        {settings:1,list:1,manifest:0,latest:1,events:1,rename:0,task:0,other:0},
        {settings:1,list:1,manifest:1,latest:1,events:1,rename:1,task:1,other:0},
      ])).toBe(true);
    }

    stage = 'initial'; check = 'native';
    const initial = await fixture.inspect(); expect(initial.phase === 'initial' && initial.sequence_count === '66').toBe(true);
    await fixture.request({command:'select',session_id:sid});
    check = 'b-snapshot'; await connect(b); await select(b); await exact(status(b),'connected; observation: streaming');
    check = 'a-snapshot'; await connect(a); await select(a); await expect.poll(() => paused).toBe(true);
    expect(network[0].latest === 1 && network[0].events === 1 && !continued && observed.handshakes === 2).toBe(true);
    stage = 'interleaved'; check = 'rename';
    await b.getByLabel('Exact new title',{exact:true}).fill(RENAMED);
    const [renameReply] = await Promise.all([
      b.waitForResponse(response => response.url() === `${fixture.origin}${path}/rename` && response.request().method() === 'POST'),
      b.getByRole('button',{name:'Rename session',exact:true}).click(),
    ]);
    const renamed = await readReply(renameReply,200,validateRenameView,4096); receipts.rename = renamed.receipt;
    expect(!renamed.duplicate && renamed.warning_code === null
      && renamed.catalog_refresh === 'updated' && renamed.receipt.operation_id === commands.rename.operation_id
      && renamed.receipt.session_id === sid && renamed.receipt.run_id === null && renamed.receipt.first_sequence === '67'
      && renamed.receipt.last_sequence === '67').toBe(true); observed.receipts++;
    await exact(b.getByRole('heading',{name:'Canonical session title',exact:true}),RENAMED);
    check = 'task'; await b.getByLabel('Task',{exact:true}).fill(TASK);
    const [taskReply] = await Promise.all([
      b.waitForResponse(response => response.url() === `${fixture.origin}${path}/runs` && response.request().method() === 'POST'),
      b.getByRole('button',{name:'Send',exact:true}).click(),
    ]);
    const accepted = await readReply(taskReply,202,v => validateDisplayTaskAccepted(v,{...commands.task,session_id:sid}),4096);
    receipts.task = accepted.receipt;
    expect(!accepted.duplicate && accepted.warning_code === null && accepted.notices.length === 0
      && accepted.receipt.first_sequence === '68' && accepted.receipt.last_sequence === '69'
      && new Set([sid,commands.rename.operation_id,commands.task.operation_id,commands.task.run_id]).size === 4).toBe(true); observed.receipts++;
    await fixture.wait('model_paused',1); check = 'native';
    const interleaved = await fixture.inspect(); expect(interleaved.phase === 'interleaved' && interleaved.sequence_count === '72' && interleaved.requests === 1).toBe(true);
    check = 'held'; await exact(a.getByRole('heading',{name:'Canonical session title',exact:true}),TITLE);
    await exact(transcript(a),'No messages yet.'); await exact(status(a),'connected; observation: connecting');
    expect(!continued && network[0].latest === 1).toBe(true);
    const at72 = await displayProof('72'); expect(at72.block.state === 'running' && !at72.block.result_recorded && at72.entries.length === 0).toBe(true);
    await expect.poll(async () => isDeepStrictEqual(await displayedBlock(transcript(b).locator('.run')),expectedBlock(at72))).toBe(true);
    for (const [index,page] of pages.entries()) await boundary(page,[contextA,contextB][index]);
    stage = 'attach'; check = 'parity'; release(); await parity(at72); await commandTruth();
    stage = 'tool'; check = 'producer'; await fixture.request({command:'drive',gate:1}); await fixture.wait('model_paused',2);
    check = 'bytes'; for (const page of pages) await occurrences(transcript(page),OUTPUT,1);
    const tool = await displayProof(); await parity(tool);
    expect(tool.entries.some(entry => entry.kind === 'tool' && entry.result_recorded === true && entry.finish_recorded === true && entry.is_error === false)).toBe(true);
    stage = 'provisional'; check = 'producer'; await fixture.request({command:'drive',gate:2}); await fixture.wait('model_paused',3);
    check = 'bytes'; for (const page of pages) await occurrences(transcript(page),'42 雪',1);
    const provisional = await displayProof(); await parity(provisional);
    expect(provisional.entries.at(-1).kind === 'assistant' && provisional.entries.at(-1).provisional === true).toBe(true);
    stage = 'terminal'; check = 'producer'; await fixture.request({command:'drive',gate:3}); await fixture.wait('task_finished',1);
    check = 'native'; const {id:_finalId,...final} = await fixture.inspect(); audit = final;
    expect(audit.phase === 'completed' && audit.sequence_count === '86' && audit.requests === 2 && audit.connections === 1 && audit.tools === 1).toBe(true);
    const at86 = await displayProof('86'); check = 'final';
    expect(at86.block.state === 'completed' && at86.block.result_recorded && at86.block.outcome.type === 'completed'
      && at86.block.events_complete === true && at86.block.sink_error === null
      && isDeepStrictEqual(at86.entries.map(entry => entry.entry_id),['e:73:0','e:75:0','e:80:0'])).toBe(true);
    const summary = at86.block.summary;
    validateUuid(summary.last_request_id);
    expect(isDeepStrictEqual([summary.turns_started,summary.turns_finished,summary.model_requests_attempted,summary.model_requests_admitted,
      summary.new_tool_dispatches,summary.tool_results_prepared,summary.reused_results,summary.last_upstream_outcome],['2','2','2','2','1','1','0','terminal_received'])).toBe(true);
    await parity(at86); await commandTruth();
    for (const page of pages) {
      for (const value of [TASK,ANSWER,ARGUMENTS,OUTPUT]) await occurrences(transcript(page),value,1);
      expect(isDeepStrictEqual(await transcript(page).locator('.entry > h4').allTextContents(),['Human','assistant','tool','assistant'])).toBe(true);
      const toolResult = transcript(page).locator('details[data-field]').filter({has:page.getByText('tool_result',{exact:true})});
      await toolResult.locator('summary').click(); await expect(toolResult.locator('pre')).toBeVisible(); await exact(toolResult.locator('pre'),OUTPUT);
    }
    stage = 'stable'; check = 'quiet'; await a.waitForTimeout(500); await quiet(); await parity(at86); await commandTruth();
    await Promise.all(assetReads);
    check = 'assets'; for (const set of assetSets) expect(isDeepStrictEqual([...set].sort(),[...files.keys()].sort())).toBe(true);
    expect(handshakes.every(events => events.join(',') === 'snapshot,stream')).toBe(true);
    expect(isDeepStrictEqual(observed,{snapshots:2,handshakes:2,receipts:2,display_proofs:4,barriers:5})).toBe(true);
    for (const [index,page] of pages.entries()) await boundary(page,[contextA,contextB][index]);
    stage = 'disconnect'; check = 'clear';
    for (const page of pages) {
      await page.getByRole('button',{name:'Disconnect',exact:true}).click(); await exact(status(page),'disconnected');
      expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
      expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
    }
    check = 'quiet'; await a.waitForTimeout(500); await quiet();
    for (const [index,page] of pages.entries()) await boundary(page,[contextA,contextB][index]);
    expect(Object.values(faults).every(value => value === 0)).toBe(true);
  } catch (cause) {
    const kind = failureKind(cause);
    failure = new Error(`Fixed head failed: ${stage}; kind=${kind}; check=${check}; capture=${JSON.stringify(observed)}; faults=${JSON.stringify(faults)}; network=${JSON.stringify(network)}`);
    console.log(`Fixed head failure: stage=${stage}; check=${check}; kind=${kind}; snapshots=${observed.snapshots}; barriers=${observed.barriers}`);
  } finally {
    release?.();
    try { await contextA?.close(); cleanup.a = contextA !== undefined; } catch { failure ??= new Error('Fixed head browser cleanup failed'); }
    try { await contextB?.close(); cleanup.b = contextB !== undefined; } catch { failure ??= new Error('Fixed head browser cleanup failed'); }
    // Playwright can still inspect a failed owned close. Restore only after both contexts are gone.
    if (cleanup.a && cleanup.b) {
      if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
    }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; } catch { failure ??= new Error('Fixed head fixture cleanup failed'); }
    if (fixture?.evidence) {
      const facts = fixture.evidence(), stop = facts.stop;
      const strict = facts.failure === null && stop.attempted && stop.clean_acknowledgment && stop.reap_complete && stop.sandbox_removed
        && stop.exit_observed && stop.exit_zero && !stop.sigterm && !stop.sigkill && !stop.error_latched && stop.stderr_empty;
      console.log(`Fixed head owned: pid=${fixture.pid}; clean=${strict}; reaped=${stop.reap_complete}; root_removed=${stop.sandbox_removed}; sigterm=${stop.sigterm}; sigkill=${stop.sigkill}`);
      if (!strict) failure ??= new Error('Fixed head strict fixture cleanup failed');
    }
  }
  console.log(`Fixed head cleanup: a=${cleanup.a} b=${cleanup.b} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  console.log('Fixed head evidence: snapshots=2 after=66 held_streams=1 interleaved_head=72 final_head=86 clients=2 rename_posts=1 task_posts=1 display_proofs=4 barriers=5 provider_connections=1 provider_requests=2 tools=1 stable_ms=500 disconnect_ms=500');
});
